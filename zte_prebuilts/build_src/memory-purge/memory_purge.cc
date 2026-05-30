// memory_purge.cc
//
// Native Node.js addon for openclaw: release Android-specific memory that
// V8 GC alone cannot reclaim.
//
// Two complementary mechanisms:
//
//   purgeDeadVMAs()  - Scan /proc/self/smaps, identify V8 BoundedPageAllocator
//                      dead subregions (RSS=0 + nr flag + 11-condition safe),
//                      call madvise(MADV_DONTNEED) -> kernel frees zram entries.
//                      Targets V8 cage freelist holes that survived V8 GC.
//
//   purgeAllocator() - Call Bionic mallopt(M_PURGE_ALL, 0) -> Scudo Primary +
//                      Secondary release_to_os, frees both RAM-resident free
//                      chunks and zram-resident swap entries owned by libc.
//                      Targets [anon:libc_malloc] regions that V8 GC never
//                      touches and purgeDeadVMAs intentionally skips.
//
// Together these handle:
//   - V8 cage dead subregions (purgeDeadVMAs)
//   - libc_malloc Scudo TransferBatch holes (purgeAllocator)
//   - V8 256KB heap page internal fragments (V8 GC, not us)
//
// Safety — purgeDeadVMAs uses a defense-in-depth design:
//   Layer 1: 11-condition static filter (RSS=0, Pss=0, Anon=0, PD=0, PC=0,
//            Referenced=0, Swap>=4KB, has nr flag, prot=rw-p, not stack,
//            not libc_malloc) — kernel-verified state
//   Layer 2: cluster fingerprint — must have ANOTHER nr-flag VMA within
//            64 MB (excludes isolated nr-flag wasm/third-party mmaps that
//            happen to coincidentally pass layer 1)
//   Layer 3: observation period — must pass layers 1+2 on N consecutive
//            scans (default 3, ~15 min) AND swap_kb must be unchanged
//            (eliminates TOCTOU race + transient cold pages)
//   Layer 4: per-call quota — at most MAX_VMAS_PER_CALL (default 16) and
//            MAX_BYTES_PER_CALL (default 200 MB) per invocation, capping
//            blast radius if all earlier layers fail
//
// Tunables (all opt-in via env):
//   OPENCLAW_PURGE_MIN_OBSERVATIONS   default 3 (uint, 1-100)
//   OPENCLAW_PURGE_MAX_VMAS           default 16 (uint, 1-1024)
//   OPENCLAW_PURGE_MAX_KB             default 204800 (uint, min 1024)
//
// purgeAllocator only touches Scudo-internal free chunks, never live ones
// (Bionic ABI guarantee).
//
// Out of scope:
//   - V8 256KB heap pages (V8 GC + munmap is the correct path; trimMalloc
//     stage 1+2 handles those)
//   - Thread stacks, file mappings (never safe to madvise)
//
// Build: see binding.gyp; targets Android 24+ ARM64.
//
// ABI note: NDK r27+ removed mallopt() from public headers although libc.so
// still exports it. We resolve via dlsym() at runtime so the addon stays
// loadable even on future NDKs that drop the export.

#define _GNU_SOURCE
#include <node_api.h>
#include <sys/mman.h>
#include <unistd.h>
#include <dlfcn.h>
#include <fstream>
#include <unordered_map>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cerrno>
#include <cctype>
#include <algorithm>
#include <utility>

namespace {

struct VmaInfo {
  uintptr_t start = 0;
  uintptr_t end = 0;
  size_t size_kb = 0;
  size_t rss_kb = 0;
  size_t pss_kb = 0;
  size_t anon_kb = 0;
  size_t pd_kb = 0;
  size_t pc_kb = 0;
  size_t ref_kb = 0;
  size_t swap_kb = 0;
  std::string prot;
  std::string name;
  std::string flags;  // VmFlags content with surrounding spaces for substring search
};

// ─── Hardening: candidate observation tracking ──────────────────────────
//
// Defense against TOCTOU race + transient-cold false positives. A VMA must
// pass the 11-condition filter on N consecutive scans before madvise.
//
// Default N=3 means a VMA must be "dead" across 3 successive trimMalloc
// invocations (5min each = ~15 min dwell time). Tunable via
// OPENCLAW_PURGE_MIN_OBSERVATIONS.

struct CandidateTrack {
  uintptr_t end = 0;       // (start, end) jointly identify a VMA
  size_t hit_count = 0;    // consecutive scans where this VMA passed filter
  size_t consistent_swap = 0;  // swap_kb that has held stable across all hits
};

// Process-wide tracking table keyed by VMA start address.
// VMA start addresses are unique by definition (no two VMAs overlap), so
// `start` uniquely identifies a candidate without needing a composite key.
// Switching from std::vector<O(N²) lookups> to unordered_map<O(1) lookups>
// drops cost from ~N² to ~N per scan.
//
// Reset on openclaw restart, which is desired: fresh observation window
// after each restart.
static std::unordered_map<uintptr_t, CandidateTrack> g_tracked_candidates;

// Bound the tracking table to defend against pathological growth (S10).
// Soft cap: if we exceed this, evict the lowest-hit_count entries first.
// Default 4× MAX_VMAS_PER_CALL = 64. Tunable via env.
static constexpr size_t TRACKED_CAPACITY_DEFAULT = 64;
static constexpr size_t TRACKED_CAPACITY_HARD_MAX = 4096;

// ─── Env-var parsing helpers (W8 fix) ─────────────────────────────────
//
// Distinguish "env var unset/empty/garbage" from "env var explicitly set
// to a small value". Garbage falls back to the default; small explicit
// values get clamped to the floor.

// Parse env var as a positive integer. On unset/empty/unparseable, return
// `default_value`. On parsed value, clamp to [min_value, max_value].
static size_t getenv_size_or_default(const char* name,
                                       size_t default_value,
                                       size_t min_value,
                                       size_t max_value) {
  const char* env = std::getenv(name);
  if (!env || !*env) return default_value;
  char* endptr = nullptr;
  errno = 0;
  long n = std::strtol(env, &endptr, 10);
  // Reject parse failure (no digits consumed), trailing garbage, or non-positive
  if (endptr == env || errno == ERANGE || n <= 0) {
    return default_value;
  }
  if (static_cast<size_t>(n) < min_value) return min_value;
  if (static_cast<size_t>(n) > max_value) return max_value;
  return static_cast<size_t>(n);
}

static size_t get_min_observations() {
  return getenv_size_or_default("OPENCLAW_PURGE_MIN_OBSERVATIONS", 3, 1, 100);
}

static size_t get_max_vmas_per_call() {
  return getenv_size_or_default("OPENCLAW_PURGE_MAX_VMAS", 16, 1, 1024);
}

static size_t get_max_bytes_per_call() {
  // Default 200 MB. Floor at 1 MB to avoid pointless tiny purges; cap at 4 GB.
  return getenv_size_or_default("OPENCLAW_PURGE_MAX_KB",
                                 200UL * 1024,    // default 200 MB
                                 1UL * 1024,      // min 1 MB
                                 4UL * 1024 * 1024); // max 4 GB
}

static size_t get_tracked_capacity() {
  return getenv_size_or_default("OPENCLAW_PURGE_TRACKED_CAP",
                                 TRACKED_CAPACITY_DEFAULT,
                                 16,
                                 TRACKED_CAPACITY_HARD_MAX);
}

// Strict 11-condition filter for safely-purgeable VMA — layer 1 of 4.
//
// A region passing all 11 conditions is provably (at this instant):
//   1. Currently 0 resident pages (kernel verified)
//   2. Never referenced (kernel verified)
//   3. Has V8 BoundedPageAllocator nr-flag fingerprint
//   4. Not a stack, not libc malloc heap, not JIT code space
//
// Note: this is a *static* snapshot test. Three additional hardening layers
// guard against races and false positives:
//   Layer 2: cluster fingerprint (must have nr-neighbor within 64 MB)
//   Layer 3: observation period (N consecutive scans before purge)
//   Layer 4: per-call quota (max VMAs and bytes per madvise batch)
static bool is_safely_dead(const VmaInfo& v) {
  // Conditions 1-7: Kernel-verified dead state
  if (v.rss_kb != 0) return false;
  if (v.pss_kb != 0) return false;
  if (v.anon_kb != 0) return false;
  if (v.pd_kb != 0) return false;
  if (v.pc_kb != 0) return false;
  if (v.ref_kb != 0) return false;
  if (v.swap_kb < 4) return false;

  // Condition 8: Must have nr flag (V8 cage subregion fingerprint)
  if (v.flags.find(" nr ") == std::string::npos) return false;

  // Condition 9: Standard rw-p (NOT rwxp).
  //
  // CRITICAL: rwxp regions with nr-flag are V8 JIT code arenas. They may
  // currently show RSS=0 + Swap>0 (JIT trampolines paged out), but V8
  // expects the bytes (especially trampoline targets) to be intact when
  // the region is touched again. madvise(MADV_DONTNEED) here would zero
  // the swap-backed bytes -> next JIT call -> SIGSEGV.
  //
  // Verified on PQ85A01 PID 12576: 7 such rwxp/nr regions exist in the
  // 9e7xxxxxxx range, holding ~280KB swap collectively. Filter rejects
  // all of them.
  if (v.prot != "rw-p") return false;

  // Condition 10: Not a thread stack
  if (v.name.find("stack_and_tls") != std::string::npos) return false;
  if (v.name.find("[stack") != std::string::npos) return false;

  // Condition 11: Not libc_malloc (Scudo manages those - mallopt is the right API)
  //
  // Android 16+ Bionic Scudo names its VMA regions `[anon:scudo:primary]`
  // and `[anon:scudo:secondary]` (prctl PR_SET_VMA_ANON_NAME). These are
  // managed by the same Scudo allocator whose freelist we intentionally
  // skip here; stage 4 (mallopt M_PURGE_ALL) is the correct API for Scudo
  // regions. On older Bionic the legacy name `[anon:libc_malloc]` is used.
  //
  // scudo:* regions currently never pass conditions 1-6 (they always have
  // RSS>0 because they contain Scudo metadata + live chunks), but we
  // exclude them explicitly to defend against a future kernel/Bionic
  // combination where they could become fully swapped.
  if (v.name.find("libc_malloc") != std::string::npos) return false;
  if (v.name.find("scudo:") != std::string::npos) return false;

  return true;
}

// Parse "Field:    NN kB" line. Returns true if this line matched and out is set.
static bool parse_size_kb(const std::string& line, const char* prefix, size_t& out) {
  size_t prefix_len = std::strlen(prefix);
  if (line.compare(0, prefix_len, prefix) != 0) return false;
  const char* p = line.c_str() + prefix_len;
  while (*p == ' ' || *p == '\t') ++p;
  out = static_cast<size_t>(std::strtoul(p, nullptr, 10));
  return true;
}

// ─── Cluster fingerprint check (hardening 3) ──────────────────────────
//
// Real V8 cage subregions sit inside a multi-GB reservation alongside other
// V8-managed VMAs (rwxp JIT, rw-p active 256K pages, etc.). An isolated
// nr-flag VMA with no neighbors of similar provenance is more likely a
// wasm linear memory or third-party mmap.
//
// We require: candidate's address range has at least one OTHER nr-flag VMA
// within ADJACENT_WINDOW bytes on either side. ADJACENT_WINDOW=64 MB
// captures the typical V8 cage internal page allocator clustering without
// being so wide that any large process passes.
static constexpr size_t ADJACENT_WINDOW = 64UL * 1024 * 1024;

struct AddrRange {
  uintptr_t start;
  uintptr_t end;
};

static bool has_nearby_nr_neighbor(const AddrRange& target,
                                    const std::vector<AddrRange>& all_nr_ranges) {
  // Linear scan; nr_ranges typically <= ~100 entries even on busy processes.
  for (const auto& r : all_nr_ranges) {
    if (r.start == target.start && r.end == target.end) continue;  // self
    // Within ADJACENT_WINDOW on either side?
    uintptr_t left = target.start > ADJACENT_WINDOW ? target.start - ADJACENT_WINDOW : 0;
    uintptr_t right = target.end + ADJACENT_WINDOW;
    if (r.end >= left && r.start <= right) return true;
  }
  return false;
}

// Fast hex digit check without std::regex's locale machinery.
static inline bool is_hex_digit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// Parse a VMA header line ("ADDR-ADDR PROT OFFSET DEV INODE [PATH]") manually
// without std::regex. Returns true on success and fills *out fields.
//
// std::regex is ~10-50× slower than hand parsing on this workload because
// /proc/<pid>/smaps has 30k+ lines, only ~7% of which are headers; we want
// to bail out cheaply on the other 93%.
static bool parse_smaps_header(const std::string& line, VmaInfo* out) {
  // Cheap prefix check: header lines start with hex digit + '-' nearby.
  if (line.empty() || !is_hex_digit(line[0])) return false;

  const char* s = line.c_str();
  const char* end = s + line.size();
  char* parse_end = nullptr;

  // start address
  errno = 0;
  unsigned long long start = std::strtoull(s, &parse_end, 16);
  if (parse_end == s || *parse_end != '-' || errno == ERANGE) return false;
  s = parse_end + 1;  // skip '-'

  // end address
  errno = 0;
  unsigned long long endaddr = std::strtoull(s, &parse_end, 16);
  if (parse_end == s || *parse_end != ' ' || errno == ERANGE) return false;
  // Sanity: end must strictly exceed start. Defends against malformed smaps
  // (or future kernel format change) producing zero-length or wrap-around
  // ranges that would later mislead the layer-4 quota check or madvise.
  if (endaddr <= start) return false;
  s = parse_end;

  // skip whitespace
  while (s < end && *s == ' ') ++s;

  // prot field (e.g. "rw-p", "rwxp")
  const char* prot_start = s;
  while (s < end && *s != ' ') ++s;
  if (s == prot_start) return false;
  std::string prot(prot_start, s);

  // skip 3 fields: offset, dev, inode
  for (int i = 0; i < 3; ++i) {
    while (s < end && *s == ' ') ++s;
    while (s < end && *s != ' ') ++s;
  }

  // optional path follows; skip leading spaces
  while (s < end && *s == ' ') ++s;
  std::string name;
  if (s < end) {
    name.assign(s, end);
    // Trim trailing whitespace
    while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) {
      name.pop_back();
    }
  }

  out->start = static_cast<uintptr_t>(start);
  out->end = static_cast<uintptr_t>(endaddr);
  out->size_kb = (out->end - out->start) / 1024;
  out->prot = std::move(prot);
  out->name = std::move(name);
  return true;
}

// Parse a smaps file and return list of safely-dead VMAs.
// Default path is /proc/self/smaps. Other paths may be passed for testing
// the equivalence between this implementation and other parsers (e.g. the
// Python reference in tests/dryrun_purge.py).
// Sets *total_scanned to total VMA count for diagnostics.
static std::vector<VmaInfo> find_dead_vmas(size_t* total_scanned,
                                            const char* smaps_path = "/proc/self/smaps") {
  std::vector<VmaInfo> result;
  std::ifstream smaps(smaps_path);
  if (!smaps.is_open()) {
    if (total_scanned) *total_scanned = 0;
    return result;
  }

  std::string line;
  VmaInfo cur;
  bool in_vma = false;
  size_t total = 0;
  std::vector<AddrRange> nr_ranges;          // all VMAs with nr flag, for cluster check
  std::vector<VmaInfo> raw_candidates;       // pass-11-conditions but pre-cluster
  // Pre-reserve to avoid repeated reallocs. nr_ranges is bounded by total VMA
  // count (typically a few hundred); 256 covers most processes.
  nr_ranges.reserve(256);

  auto finalize = [&]() {
    if (in_vma) {
      ++total;
      // Track every nr-flag VMA so cluster check has full set
      if (cur.flags.find(" nr ") != std::string::npos) {
        nr_ranges.push_back({cur.start, cur.end});
      }
      if (is_safely_dead(cur)) raw_candidates.push_back(cur);
    }
  };

  while (std::getline(smaps, line)) {
    VmaInfo parsed;
    if (parse_smaps_header(line, &parsed)) {
      finalize();
      cur = std::move(parsed);
      in_vma = true;
      continue;
    }
    if (!in_vma) continue;

    parse_size_kb(line, "Rss:", cur.rss_kb);
    parse_size_kb(line, "Pss:", cur.pss_kb);
    parse_size_kb(line, "Anonymous:", cur.anon_kb);
    parse_size_kb(line, "Private_Dirty:", cur.pd_kb);
    parse_size_kb(line, "Private_Clean:", cur.pc_kb);
    parse_size_kb(line, "Referenced:", cur.ref_kb);
    parse_size_kb(line, "Swap:", cur.swap_kb);

    if (line.compare(0, 8, "VmFlags:") == 0) {
      // surround with spaces for safe substring search
      cur.flags = " " + line.substr(8) + " ";
    }
  }
  finalize();

  // Hardening 3: only keep candidates with at least one nr-flag neighbor
  // within ADJACENT_WINDOW. Isolated nr-flag VMAs (likely wasm linear
  // memory or third-party direct mmap) are excluded.
  for (const auto& c : raw_candidates) {
    if (has_nearby_nr_neighbor({c.start, c.end}, nr_ranges)) {
      result.push_back(c);
    }
  }

  if (total_scanned) *total_scanned = total;
  return result;
}

// ─── napi helpers ──────────────────────────────────────────────────────

static napi_value make_int(napi_env env, int64_t v) {
  napi_value out;
  napi_create_int64(env, v, &out);
  return out;
}

static napi_value make_string(napi_env env, const std::string& s) {
  napi_value out;
  napi_create_string_utf8(env, s.c_str(), s.size(), &out);
  return out;
}

// ─── Bionic mallopt() resolution ─────────────────────────────────────────
//
// Bionic exports mallopt() from libc.so but NDK r27+ removed it from public
// headers. We resolve via dlsym() to stay loadable on current and future NDKs.
//
// Cached after first lookup; subsequent calls are zero-cost.

typedef int (*mallopt_fn_t)(int param, int value);

// Bionic mallopt extension constants (from AOSP bionic/libc/include/malloc.h
// before they were hidden). These are stable Bionic ABI:
//   M_DECAY_TIME = -100
//   M_PURGE      = -101
//   M_PURGE_ALL  = -104  (preferred: also drains secondary cache)
//
// Verified on Android 16 (API 36) PQ85A01: mallopt(M_PURGE_ALL, 0) returns 1
// on success, releases ~95% of pending free chunks via madvise(MADV_DONTNEED).
#define MEMPURGE_M_PURGE      (-101)
#define MEMPURGE_M_PURGE_ALL  (-104)

static mallopt_fn_t resolve_mallopt(void) {
  static mallopt_fn_t cached = nullptr;
  static bool resolved = false;
  if (!resolved) {
    cached = reinterpret_cast<mallopt_fn_t>(dlsym(RTLD_DEFAULT, "mallopt"));
    resolved = true;
  }
  return cached;
}

// JS API: purgeAllocator() -> { ok, returnCode, swapReclaimedKB, rssReclaimedMB }
//
// Calls Bionic mallopt(M_PURGE_ALL, 0). On Scudo (Android default malloc)
// this triggers full release_to_os over both Primary (size-class chunks)
// and Secondary (large mmap'd) caches. madvise(MADV_DONTNEED) is invoked
// internally on contiguous free pages, which:
//   - releases RAM pages back to the OS
//   - clears zram entries for swapped-out free pages
//
// ok=true means mallopt was reachable and returned success (Bionic returns
// 1 on success, not 0). ok=false means dlsym(mallopt) failed (very old or
// future-stripped libc) or mallopt returned 0; stage skipped silently.
//
// Reads VmRSS/VmSwap before+after to compute reclamation deltas.
static void read_vm_kb(size_t* rss_kb, size_t* swap_kb) {
  *rss_kb = 0;
  *swap_kb = 0;
  std::ifstream status("/proc/self/status");
  if (!status.is_open()) return;
  std::string line;
  while (std::getline(status, line)) {
    if (line.compare(0, 6, "VmRSS:") == 0) {
      *rss_kb = static_cast<size_t>(std::strtoul(line.c_str() + 6, nullptr, 10));
    } else if (line.compare(0, 7, "VmSwap:") == 0) {
      *swap_kb = static_cast<size_t>(std::strtoul(line.c_str() + 7, nullptr, 10));
    }
  }
}

static napi_value PurgeAllocator(napi_env env, napi_callback_info /*info*/) {
  napi_value result;
  napi_create_object(env, &result);

  mallopt_fn_t mallopt_fn = resolve_mallopt();

  napi_value ok_v;
  napi_get_boolean(env, mallopt_fn != nullptr, &ok_v);
  napi_set_named_property(env, result, "available", ok_v);

  if (mallopt_fn == nullptr) {
    napi_set_named_property(env, result, "ok", ok_v);
    napi_set_named_property(env, result, "returnCode", make_int(env, 0));
    napi_set_named_property(env, result, "swapReclaimedKB", make_int(env, 0));
    napi_set_named_property(env, result, "rssReclaimedKB", make_int(env, 0));
    return result;
  }

  size_t rss_before = 0, swap_before = 0;
  size_t rss_after = 0, swap_after = 0;
  read_vm_kb(&rss_before, &swap_before);

  errno = 0;
  int rc = mallopt_fn(MEMPURGE_M_PURGE_ALL, 0);

  read_vm_kb(&rss_after, &swap_after);

  napi_value ok_final;
  napi_get_boolean(env, rc == 1, &ok_final);
  napi_set_named_property(env, result, "ok", ok_final);
  napi_set_named_property(env, result, "returnCode", make_int(env, rc));

  // signed delta -> reclaimed; clamp negatives to 0 (Scudo could be allocating
  // concurrently from another thread between our two reads)
  int64_t swap_delta = (int64_t)swap_before - (int64_t)swap_after;
  int64_t rss_delta = (int64_t)rss_before - (int64_t)rss_after;
  napi_set_named_property(env, result, "swapReclaimedKB",
                          make_int(env, swap_delta > 0 ? swap_delta : 0));
  napi_set_named_property(env, result, "rssReclaimedKB",
                          make_int(env, rss_delta > 0 ? rss_delta : 0));
  return result;
}

// Update the persistent observation tracking table from this scan's
// candidates. VMAs that disappeared since last scan are dropped (they were
// reused by V8). Returns the subset of `current` that has been observed
// `min_observations` times consecutively AND whose swap_kb has been stable
// (changed swap = recently active = exclude).
//
// Algorithm: O(N) using unordered_map<start, CandidateTrack>. Old impl was
// O(N²) over std::vector.
//
// State machine:
//   - VMA in current ∩ tracked, swap unchanged  → hit_count++
//   - VMA in current ∩ tracked, swap changed    → hit_count = 1, swap = new
//   - VMA in current only (new)                  → insert hit_count=1
//   - VMA in tracked only (gone from /proc)      → drop
//
// Capacity: if next_tracked would exceed the configured cap, evict entries
// with the lowest hit_count (least confident) until under cap.
static std::vector<VmaInfo> apply_observation_filter(
    const std::vector<VmaInfo>& current,
    size_t min_observations) {

  // Mark phase: walk current, update or insert in tracking. We rebuild a
  // fresh map so VMAs that were tracked but no longer in current are
  // implicitly dropped.
  std::unordered_map<uintptr_t, CandidateTrack> next_tracked;
  next_tracked.reserve(current.size());

  for (const auto& v : current) {
    auto it = g_tracked_candidates.find(v.start);
    if (it != g_tracked_candidates.end() && it->second.end == v.end) {
      // Same VMA still here. Bump if swap stable; reset if swap changed.
      const CandidateTrack& prev = it->second;
      CandidateTrack nt;
      nt.end = v.end;
      nt.consistent_swap = v.swap_kb;
      nt.hit_count = (prev.consistent_swap == v.swap_kb) ? (prev.hit_count + 1) : 1;
      next_tracked.emplace(v.start, nt);
    } else {
      // New (or replaced — same start address but different end means V8
      // remapped). Treat as fresh.
      CandidateTrack nt;
      nt.end = v.end;
      nt.consistent_swap = v.swap_kb;
      nt.hit_count = 1;
      next_tracked.emplace(v.start, nt);
    }
  }

  // Capacity enforcement (S10): if oversized, evict lowest-hit_count entries.
  size_t cap = get_tracked_capacity();
  if (next_tracked.size() > cap) {
    std::vector<std::pair<uintptr_t, size_t>> by_hit;
    by_hit.reserve(next_tracked.size());
    for (const auto& kv : next_tracked) {
      by_hit.emplace_back(kv.first, kv.second.hit_count);
    }
    // Partial sort: keep cap entries with highest hit_count
    std::partial_sort(by_hit.begin(), by_hit.begin() + cap, by_hit.end(),
                       [](const auto& a, const auto& b) { return a.second > b.second; });
    std::unordered_map<uintptr_t, CandidateTrack> trimmed;
    trimmed.reserve(cap);
    for (size_t i = 0; i < cap; ++i) {
      auto it = next_tracked.find(by_hit[i].first);
      if (it != next_tracked.end()) {
        trimmed.emplace(it->first, it->second);
      }
    }
    next_tracked = std::move(trimmed);
  }

  g_tracked_candidates = std::move(next_tracked);

  // Return current entries whose hit_count >= min_observations.
  std::vector<VmaInfo> stable;
  stable.reserve(current.size());
  for (const auto& v : current) {
    auto it = g_tracked_candidates.find(v.start);
    if (it != g_tracked_candidates.end() &&
        it->second.end == v.end &&
        it->second.hit_count >= min_observations) {
      stable.push_back(v);
    }
  }
  return stable;
}

// JS API: purgeDeadVMAs() -> {
//   scanned, candidates, stable, purged, failed, swapReclaimedKB,
//   skippedByObservation, skippedByLimit, errors[]
// }
//
// scanned              : total VMAs in /proc/self/smaps
// candidates           : VMAs passing 11-condition filter (raw)
// stable               : subset that survived observation filter (>= MIN_OBSERVATIONS)
// purged               : madvise calls that returned 0
// failed               : madvise calls that failed
// swapReclaimedKB      : sum of swap_kb of successfully-purged VMAs
// skippedByObservation : candidates - stable (still being watched)
// skippedByLimit       : stable VMAs not purged this call due to size cap
// errors               : up to 5 error strings
static napi_value PurgeDeadVMAs(napi_env env, napi_callback_info /*info*/) {
  size_t total_scanned = 0;
  auto dead = find_dead_vmas(&total_scanned);

  // Hardening 1: observation period — only purge VMAs seen N times in a row
  size_t min_obs = get_min_observations();
  auto stable = apply_observation_filter(dead, min_obs);
  size_t skipped_obs = dead.size() - stable.size();

  // Hardening 4: per-call quotas (defense against runaway false positives)
  size_t max_vmas = get_max_vmas_per_call();
  size_t max_kb = get_max_bytes_per_call();
  size_t purged_count = 0;
  size_t failed_count = 0;
  size_t total_swap_kb = 0;
  size_t skipped_limit = 0;
  size_t cumulative_kb = 0;
  std::vector<std::string> errors;

  for (size_t i = 0; i < stable.size(); ++i) {
    const auto& v = stable[i];
    if (purged_count >= max_vmas) {
      skipped_limit = stable.size() - i;
      break;
    }
    size_t vma_kb = (v.end - v.start) / 1024;
    if (cumulative_kb + vma_kb > max_kb) {
      skipped_limit = stable.size() - i;
      break;
    }

    size_t len = v.end - v.start;
    int rc = madvise(reinterpret_cast<void*>(v.start), len, MADV_DONTNEED);
    if (rc == 0) {
      ++purged_count;
      total_swap_kb += v.swap_kb;
      cumulative_kb += vma_kb;
    } else {
      ++failed_count;
      char buf[256];
      std::snprintf(buf, sizeof(buf),
        "madvise(0x%lx, %zu) failed: errno=%d (%s)",
        static_cast<unsigned long>(v.start), len, errno, std::strerror(errno));
      errors.emplace_back(buf);
    }
  }

  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "scanned", make_int(env, static_cast<int64_t>(total_scanned)));
  napi_set_named_property(env, result, "candidates", make_int(env, static_cast<int64_t>(dead.size())));
  napi_set_named_property(env, result, "stable", make_int(env, static_cast<int64_t>(stable.size())));
  napi_set_named_property(env, result, "purged", make_int(env, static_cast<int64_t>(purged_count)));
  napi_set_named_property(env, result, "failed", make_int(env, static_cast<int64_t>(failed_count)));
  napi_set_named_property(env, result, "swapReclaimedKB", make_int(env, static_cast<int64_t>(total_swap_kb)));
  napi_set_named_property(env, result, "skippedByObservation", make_int(env, static_cast<int64_t>(skipped_obs)));
  napi_set_named_property(env, result, "skippedByLimit", make_int(env, static_cast<int64_t>(skipped_limit)));
  napi_set_named_property(env, result, "minObservations", make_int(env, static_cast<int64_t>(min_obs)));

  napi_value errors_arr;
  napi_create_array(env, &errors_arr);
  size_t err_count = std::min(errors.size(), size_t(5));
  for (size_t i = 0; i < err_count; ++i) {
    napi_set_element(env, errors_arr, static_cast<uint32_t>(i), make_string(env, errors[i]));
  }
  napi_set_named_property(env, result, "errors", errors_arr);

  return result;
}

// JS API: dryRunDeadVMAs() -> [{ addr, sizeKB, swapKB, name }]
//
// Same scanning as purgeDeadVMAs, but does NOT call madvise.
// Use during canary/validation to verify what would be purged.
static napi_value DryRunDeadVMAs(napi_env env, napi_callback_info /*info*/) {
  size_t total_scanned = 0;
  auto dead = find_dead_vmas(&total_scanned);

  napi_value result;
  napi_create_array(env, &result);

  for (size_t i = 0; i < dead.size(); ++i) {
    const auto& v = dead[i];
    napi_value entry;
    napi_create_object(env, &entry);

    char addr_buf[64];
    std::snprintf(addr_buf, sizeof(addr_buf), "%lx-%lx",
                  static_cast<unsigned long>(v.start),
                  static_cast<unsigned long>(v.end));

    napi_set_named_property(env, entry, "addr", make_string(env, addr_buf));
    napi_set_named_property(env, entry, "sizeKB", make_int(env, static_cast<int64_t>(v.size_kb)));
    napi_set_named_property(env, entry, "swapKB", make_int(env, static_cast<int64_t>(v.swap_kb)));
    napi_set_named_property(env, entry, "name", make_string(env, v.name));

    napi_set_element(env, result, static_cast<uint32_t>(i), entry);
  }

  return result;
}

// JS API (test only): testParseSmaps(filePath: string) -> [{ addr, sizeKB, swapKB, name }]
//
// Same as dryRunDeadVMAs() but reads a custom file path instead of
// /proc/self/smaps. Used by tests to verify equivalence with the Python
// reference parser. NEVER use in production paths - production code should
// always read /proc/self/smaps.
static napi_value TestParseSmaps(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 1) {
    napi_value err;
    napi_create_string_utf8(env, "missing filePath argument", NAPI_AUTO_LENGTH, &err);
    napi_throw_error(env, nullptr, "missing filePath argument");
    return nullptr;
  }

  char path_buf[1024];
  size_t path_len = 0;
  napi_get_value_string_utf8(env, argv[0], path_buf, sizeof(path_buf), &path_len);
  path_buf[path_len < sizeof(path_buf) ? path_len : sizeof(path_buf) - 1] = '\0';

  size_t total_scanned = 0;
  auto dead = find_dead_vmas(&total_scanned, path_buf);

  napi_value result;
  napi_create_array(env, &result);

  for (size_t i = 0; i < dead.size(); ++i) {
    const auto& v = dead[i];
    napi_value entry;
    napi_create_object(env, &entry);

    char addr_buf[64];
    std::snprintf(addr_buf, sizeof(addr_buf), "%lx-%lx",
                  static_cast<unsigned long>(v.start),
                  static_cast<unsigned long>(v.end));

    napi_set_named_property(env, entry, "addr", make_string(env, addr_buf));
    napi_set_named_property(env, entry, "sizeKB", make_int(env, static_cast<int64_t>(v.size_kb)));
    napi_set_named_property(env, entry, "swapKB", make_int(env, static_cast<int64_t>(v.swap_kb)));
    napi_set_named_property(env, entry, "name", make_string(env, v.name));

    napi_set_element(env, result, static_cast<uint32_t>(i), entry);
  }

  return result;
}

// JS API: getInfo() -> { version, abiTarget, conditions }
// Helps verify the loaded .node version at runtime.
static napi_value GetInfo(napi_env env, napi_callback_info /*info*/) {
  napi_value result;
  napi_create_object(env, &result);

  napi_set_named_property(env, result, "version", make_string(env, "0.3.0"));
  napi_set_named_property(env, result, "abiTarget", make_string(env, "android-arm64-api24"));
  napi_set_named_property(env, result, "conditions", make_int(env, 11));
  napi_set_named_property(env, result, "minObservations", make_int(env, static_cast<int64_t>(get_min_observations())));
  napi_set_named_property(env, result, "maxVmasPerCall", make_int(env, static_cast<int64_t>(get_max_vmas_per_call())));
  napi_set_named_property(env, result, "maxKbPerCall", make_int(env, static_cast<int64_t>(get_max_bytes_per_call())));
  napi_value mallopt_avail;
  napi_get_boolean(env, resolve_mallopt() != nullptr, &mallopt_avail);
  napi_set_named_property(env, result, "malloptAvailable", mallopt_avail);

  return result;
}

}  // anonymous namespace

NAPI_MODULE_INIT() {
  napi_value purge_fn, dryrun_fn, info_fn, test_parse_fn, alloc_fn;
  napi_create_function(env, "purgeDeadVMAs", NAPI_AUTO_LENGTH, PurgeDeadVMAs, nullptr, &purge_fn);
  napi_create_function(env, "dryRunDeadVMAs", NAPI_AUTO_LENGTH, DryRunDeadVMAs, nullptr, &dryrun_fn);
  napi_create_function(env, "getInfo", NAPI_AUTO_LENGTH, GetInfo, nullptr, &info_fn);
  napi_create_function(env, "testParseSmaps", NAPI_AUTO_LENGTH, TestParseSmaps, nullptr, &test_parse_fn);
  napi_create_function(env, "purgeAllocator", NAPI_AUTO_LENGTH, PurgeAllocator, nullptr, &alloc_fn);
  napi_set_named_property(env, exports, "purgeDeadVMAs", purge_fn);
  napi_set_named_property(env, exports, "dryRunDeadVMAs", dryrun_fn);
  napi_set_named_property(env, exports, "getInfo", info_fn);
  napi_set_named_property(env, exports, "testParseSmaps", test_parse_fn);
  napi_set_named_property(env, exports, "purgeAllocator", alloc_fn);
  return exports;
}
