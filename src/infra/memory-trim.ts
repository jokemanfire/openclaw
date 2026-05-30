/**
 * Multi-stage heap trim pipeline for openclaw on Android.
 *
 * Long-form rationale: `zte_prebuilts/build_src/memory-purge/SOLUTION.md`.
 *
 * Stages (each independently kill-switchable):
 *   1. V8 mark-compact GC with last-resort flavor.
 *   2. Aggressive cage shrink: temporarily lower `max-old-space-size`, GC,
 *      restore. Forces V8 BoundedPageAllocator to munmap freelist whole pages
 *      that the regular `flavor:"last-resort"` path leaves alone.
 *   3. Native madvise on dead VMAs (V8 cage subregions with RSS=0 + nr flag).
 *      Targets zram-occupying pages that no V8 GC path will ever reach.
 *   4. Bionic mallopt(M_PURGE_ALL): Scudo Primary + Secondary release_to_os.
 *      Targets [anon:libc_malloc] regions that V8 GC and stage 3 skip.
 *
 * Stages 2-4 require Android arm64 + the zte-native-memory-purge prebuilt.
 * On other platforms or when the prebuilt is missing, those stages no-op.
 *
 * Requires `--expose-gc` at gateway startup for stage 1/2.
 *
 * Concurrency: trimMalloc takes a process-wide non-reentrant lock. Concurrent
 * callers no-op. This is critical because stage 2 mutates the global V8 flag
 * `--max-old-space-size` and would race otherwise.
 *
 * Env kill switches:
 *   OPENCLAW_LAST_RESORT_GC=0       Disable stage 1.
 *   OPENCLAW_CAGE_SHRINK=0          Disable stage 2.
 *   OPENCLAW_PURGE_DEAD_VMAS=0      Disable stage 3.
 *   OPENCLAW_PURGE_DRY_RUN=1        Stage 3 scans only, no madvise.
 *   OPENCLAW_PURGE_ALLOCATOR=0      Disable stage 4.
 *   OPENCLAW_PURGE_FORCE=1          Override auto-disable (re-enable stages 3+4).
 *   OPENCLAW_MALLOC_TRIM_DEBUG=1    Verbose [memory-trim] logs.
 *
 * Stage 3 hardening tunables (see memory_purge.cc for full details):
 *   OPENCLAW_PURGE_MIN_OBSERVATIONS=N  Require N consecutive scans before
 *                                      purge (default 3, ~15 min dwell).
 *   OPENCLAW_PURGE_MAX_VMAS=N          Cap madvise calls per cycle (default 16).
 *   OPENCLAW_PURGE_MAX_KB=N            Cap bytes purged per cycle (default 200MB).
 */

import * as fs from "node:fs";
import * as v8 from "node:v8";
import { getMemoryPurgeBinding } from "../zte_wrappers/memory-purge-wrapper/memoryPurgeAdapter.js";

// ─── Cached env getters ────────────────────────────────────────────────

let _trimLogEnabled: boolean | null = null;
let _stage1Enabled: boolean | null = null;
let _purgeEnabled: boolean | null = null;
let _dryRunMode: boolean | null = null;
let _cageShrinkEnabled: boolean | null = null;
let _purgeAllocatorEnabled: boolean | null = null;
let _purgeForce: boolean | null = null;

// Per-stage regression counters (auto-disable scoped to the stage that
// regressed, not the whole pipeline). Reset on a clean cycle.
let _stage3RegressionCount = 0;
let _stage4RegressionCount = 0;

// Process-wide reentrancy guard. trimMalloc mutates V8 global flags; concurrent
// invocations would race.
let _trimInFlight = false;

const SELF_DISABLE_THRESHOLD = 3;
const SWAP_REGRESSION_THRESHOLD_MB = 5;
const CAGE_SHRINK_TARGET_MB = 64;

function isTrimLogEnabled(): boolean {
  if (_trimLogEnabled !== null) return _trimLogEnabled;
  _trimLogEnabled = process.env.OPENCLAW_MALLOC_TRIM_DEBUG === "1";
  return _trimLogEnabled;
}

function isStage1Enabled(): boolean {
  if (_stage1Enabled !== null) return _stage1Enabled;
  _stage1Enabled = process.env.OPENCLAW_LAST_RESORT_GC !== "0";
  return _stage1Enabled;
}

function isPurgeEnabled(): boolean {
  if (_purgeEnabled !== null) return _purgeEnabled;
  _purgeEnabled = process.env.OPENCLAW_PURGE_DEAD_VMAS !== "0";
  return _purgeEnabled;
}

function isDryRunMode(): boolean {
  if (_dryRunMode !== null) return _dryRunMode;
  _dryRunMode = process.env.OPENCLAW_PURGE_DRY_RUN === "1";
  return _dryRunMode;
}

function isCageShrinkEnabled(): boolean {
  if (_cageShrinkEnabled !== null) return _cageShrinkEnabled;
  _cageShrinkEnabled = process.env.OPENCLAW_CAGE_SHRINK !== "0";
  return _cageShrinkEnabled;
}

function isPurgeAllocatorEnabled(): boolean {
  if (_purgeAllocatorEnabled !== null) return _purgeAllocatorEnabled;
  _purgeAllocatorEnabled = process.env.OPENCLAW_PURGE_ALLOCATOR !== "0";
  return _purgeAllocatorEnabled;
}

function isPurgeForceEnabled(): boolean {
  if (_purgeForce !== null) return _purgeForce;
  _purgeForce = process.env.OPENCLAW_PURGE_FORCE === "1";
  return _purgeForce;
}

function logTrim(msg: string): void {
  if (isTrimLogEnabled()) {
    process.stderr.write(`[memory-trim] ${msg}\n`);
  }
}

// ─── Boot heap cap detection (W4 + C1 fix) ───────────────────────────

/**
 * Resolve boot --max-old-space-size in MB. Source priority:
 *   1. process.execArgv (most reliable, zero overhead skew)
 *   2. NODE_OPTIONS env (--require/--max-old-space-size combined)
 *   3. v8.getHeapStatistics().heap_size_limit, ROUNDED UP to 64 MB
 *      (V8 reports slightly above the configured cap due to internal overhead;
 *      rounding down would silently lower the cap permanently after the first
 *      stage 2 run)
 *   4. Fallback 700 MB (largest known config; safer to over-restore than under)
 */
function readBootMaxOldSpaceMB(): number {
  const fromArg = (s: string): number | null => {
    const m = s.match(/--max-old-space-size=(\d+)/);
    if (!m) return null;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 64 && n <= 65536) return n;
    return null;
  };

  for (const arg of process.execArgv) {
    const n = fromArg(arg);
    if (n !== null) return n;
  }

  const nodeOpts = process.env.NODE_OPTIONS;
  if (nodeOpts) {
    const n = fromArg(nodeOpts);
    if (n !== null) return n;
  }

  try {
    const limitMB = v8.getHeapStatistics().heap_size_limit / 1024 / 1024;
    if (limitMB >= 64 && limitMB <= 65536) {
      // Round UP. heap_size_limit ~= cap + few percent overhead; rounding
      // down would set restore < boot cap.
      return Math.ceil(limitMB / 64) * 64;
    }
  } catch {
    // ignore
  }

  return 700;
}

const CAGE_SHRINK_RESTORE_MB = readBootMaxOldSpaceMB();

// ─── /proc/self/status batched reader (W7 fix) ────────────────────────
//
// Reads VmRSS and VmSwap in a single syscall + single regex pass. Replaces
// the per-field readVmFieldMB which was called 8 times per cycle.

const VM_STATUS_RE = /^(VmRSS|VmSwap):\s*(\d+)\s*kB$/gm;

interface VmStatus {
  rss: number;  // MB; -1 on read failure
  swap: number; // MB; -1 on read failure
}

function readVmStatusMB(): VmStatus {
  try {
    const data = fs.readFileSync("/proc/self/status", "utf8");
    let rss = -1;
    let swap = -1;
    VM_STATUS_RE.lastIndex = 0;
    for (const m of data.matchAll(VM_STATUS_RE)) {
      const v = Number(m[2]) / 1024;
      if (m[1] === "VmRSS") rss = v;
      else if (m[1] === "VmSwap") swap = v;
      if (rss >= 0 && swap >= 0) break;
    }
    return { rss, swap };
  } catch {
    return { rss: -1, swap: -1 };
  }
}

// ─── V8 GC helper ────────────────────────────────────────────────────

type GcFn = (opts?: { type?: string; execution?: string; flavor?: string }) => void;

function getGcFn(): GcFn | null {
  const fn = (globalThis as Record<string, unknown>).gc;
  return typeof fn === "function" ? (fn as GcFn) : null;
}

/**
 * Stage 2: aggressively shrink V8 heap so BoundedPageAllocator releases
 * freelist whole-page chunks back to the OS via munmap.
 *
 * Sequence:
 *   1. Read current heap state.
 *   2. v8.setFlagsFromString(`--max-old-space-size=${LOW}`).
 *   3. Call gc() with reduce-memory flavor; V8 sees current heap > new limit
 *      and invokes its memory-reducer compaction path.
 *   4. Restore the boot max-old-space-size.
 *
 * Caveat: caller must hold _trimInFlight to prevent concurrent invocations.
 * v8.setFlagsFromString is process-global; concurrent runs would race the
 * flag and could leave it permanently lowered or trigger OOM.
 */
function runCageShrink(gc: GcFn): { releasedHeapMB: number } {
  const beforeStats = v8.getHeapStatistics();
  const liveHeapMB = beforeStats.used_heap_size / 1024 / 1024;
  const targetMB = Math.max(CAGE_SHRINK_TARGET_MB, Math.ceil(liveHeapMB) + 16);

  try {
    v8.setFlagsFromString(`--max-old-space-size=${targetMB}`);
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
  } finally {
    v8.setFlagsFromString(`--max-old-space-size=${CAGE_SHRINK_RESTORE_MB}`);
  }

  const afterStats = v8.getHeapStatistics();
  const releasedMB = (beforeStats.total_heap_size - afterStats.total_heap_size) / 1024 / 1024;
  return { releasedHeapMB: releasedMB };
}

// ─── Stage runners ───────────────────────────────────────────────────

interface StageDeltas {
  rssBefore: number;
  rssAfter: number;
  swapBefore: number;
  swapAfter: number;
}

function fmtMB(n: number): string {
  return n >= 0 ? n.toFixed(0) : "?";
}

/**
 * trimMalloc: 4-stage memory reclamation pipeline.
 *
 * Concurrent invocations are serialized: if a trim is already in flight, the
 * new call returns immediately. Logging notes the skip when verbose.
 */
export function trimMalloc(label?: string): void {
  if (_trimInFlight) {
    logTrim(`${label ? `[${label}] ` : ""}skipped (trim already in flight)`);
    return;
  }
  _trimInFlight = true;
  try {
    runTrimPipeline(label);
  } finally {
    _trimInFlight = false;
  }
}

function runTrimPipeline(label?: string): void {
  const labelStr = label ? `[${label}] ` : "";

  const start = readVmStatusMB();
  const swapBefore = start.swap;
  const rssBefore = start.rss;

  // ─── Stage 1: V8 last-resort GC (existing behavior) ───
  const gc = getGcFn();
  let stage1Summary: string;
  if (!isStage1Enabled()) {
    stage1Summary = "disabled";
  } else if (!gc) {
    stage1Summary = "no-gc";
  } else {
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
    stage1Summary = "ok";
  }
  const afterGc = readVmStatusMB();

  // ─── Stage 2: cage shrink (only if --expose-gc and not disabled) ───
  let stage2Summary: string;
  if (!gc) {
    stage2Summary = "no-gc";
  } else if (!isCageShrinkEnabled()) {
    stage2Summary = "disabled";
  } else {
    try {
      const { releasedHeapMB } = runCageShrink(gc);
      stage2Summary = `released=${releasedHeapMB.toFixed(0)}MB`;
    } catch (e) {
      stage2Summary = `error:${(e as Error).message}`;
    }
  }
  const afterShrink = readVmStatusMB();

  // ─── Stage 3: native madvise on dead VMAs ───
  // Force-override allows recovery from auto-disable without process restart.
  const stage3Active = isPurgeEnabled() || isPurgeForceEnabled();
  let stage3Summary: string;
  if (!stage3Active) {
    stage3Summary = "disabled";
  } else {
    const binding = getMemoryPurgeBinding();
    if (binding.isNoop) {
      stage3Summary = "noop";
    } else if (isDryRunMode()) {
      try {
        const candidates = binding.dryRunDeadVMAs();
        const totalKB = candidates.reduce((s, c) => s + c.swapKB, 0);
        stage3Summary = `dryRun=${candidates.length}vmas(${totalKB}KB)`;
        if (isTrimLogEnabled() && candidates.length > 0) {
          for (const c of candidates.slice(0, 10)) {
            logTrim(
              `${labelStr}  candidate addr=${c.addr} size=${c.sizeKB}KB swap=${c.swapKB}KB name=${c.name || "[anon]"}`,
            );
          }
        }
      } catch (e) {
        stage3Summary = `dryRunError:${(e as Error).message}`;
      }
    } else {
      try {
        const result = binding.purgeDeadVMAs();
        stage3Summary =
          `purged=${result.purged}/${result.stable}stable/${result.candidates}cand` +
          ` reclaimed=${result.swapReclaimedKB}KB` +
          ` skip=obs:${result.skippedByObservation}+lim:${result.skippedByLimit}` +
          (result.failed > 0 ? ` failed=${result.failed}` : "");
        if (result.failed > 0 && isTrimLogEnabled()) {
          for (const err of result.errors.slice(0, 3)) {
            logTrim(`${labelStr}  stage3 error: ${err}`);
          }
        }
      } catch (e) {
        stage3Summary = `purgeError:${(e as Error).message}`;
      }
    }
  }
  const afterPurge = readVmStatusMB();

  // ─── Stage 4: Bionic mallopt(M_PURGE_ALL) ───
  const stage4Active = isPurgeAllocatorEnabled() || isPurgeForceEnabled();
  let stage4Summary: string;
  if (!stage4Active) {
    stage4Summary = "disabled";
  } else if (isDryRunMode()) {
    stage4Summary = "dryRun-skip";
  } else {
    const binding = getMemoryPurgeBinding();
    if (binding.isNoop || typeof binding.purgeAllocator !== "function") {
      stage4Summary = "noop";
    } else {
      try {
        const result = binding.purgeAllocator();
        if (!result.available) {
          stage4Summary = "no-mallopt";
        } else if (result.ok) {
          stage4Summary =
            `mallopt-ok rss-=${result.rssReclaimedKB}KB swap-=${result.swapReclaimedKB}KB`;
        } else {
          stage4Summary = `mallopt-rc=${result.returnCode}`;
        }
      } catch (e) {
        stage4Summary = `malloptError:${(e as Error).message}`;
      }
    }
  }

  const final = readVmStatusMB();
  const swapAfter = final.swap;
  const rssAfter = final.rss;

  // ─── Self-disable: per-stage attribution (C3 fix) ───
  // Force-mode bypasses auto-disable entirely (escape hatch for ops).
  if (!isPurgeForceEnabled() && !isDryRunMode()) {
    // Stage 3 is responsible for swap delta between afterShrink and afterPurge.
    if (isPurgeEnabled() && afterShrink.swap >= 0 && afterPurge.swap >= 0) {
      const stage3Delta = afterPurge.swap - afterShrink.swap;
      if (stage3Delta > SWAP_REGRESSION_THRESHOLD_MB) {
        _stage3RegressionCount += 1;
        if (_stage3RegressionCount >= SELF_DISABLE_THRESHOLD) {
          _purgeEnabled = false;
          logTrim(
            `${labelStr}AUTO-DISABLED stage 3: own swap delta > ${SWAP_REGRESSION_THRESHOLD_MB}MB ` +
              `for ${SELF_DISABLE_THRESHOLD} cycles. Set OPENCLAW_PURGE_FORCE=1 to override.`,
          );
        }
      } else {
        _stage3RegressionCount = 0;
      }
    }
    // Stage 4 is responsible for swap delta between afterPurge and final.
    if (isPurgeAllocatorEnabled() && afterPurge.swap >= 0 && swapAfter >= 0) {
      const stage4Delta = swapAfter - afterPurge.swap;
      if (stage4Delta > SWAP_REGRESSION_THRESHOLD_MB) {
        _stage4RegressionCount += 1;
        if (_stage4RegressionCount >= SELF_DISABLE_THRESHOLD) {
          _purgeAllocatorEnabled = false;
          logTrim(
            `${labelStr}AUTO-DISABLED stage 4: own swap delta > ${SWAP_REGRESSION_THRESHOLD_MB}MB ` +
              `for ${SELF_DISABLE_THRESHOLD} cycles. Set OPENCLAW_PURGE_FORCE=1 to override.`,
          );
        }
      } else {
        _stage4RegressionCount = 0;
      }
    }
  }

  // ─── Logging ───
  if (isTrimLogEnabled()) {
    logTrim(
      `${labelStr}` +
        `rss=${fmtMB(rssBefore)}->${fmtMB(rssAfter)}MB ` +
        `swap=${fmtMB(swapBefore)}->${fmtMB(swapAfter)}MB ` +
        `gc:${stage1Summary}[dRss=${fmtMB(afterGc.rss - rssBefore)},dSwap=${fmtMB(afterGc.swap - swapBefore)}] ` +
        `shrink:${stage2Summary}[dRss=${fmtMB(afterShrink.rss - afterGc.rss)},dSwap=${fmtMB(afterShrink.swap - afterGc.swap)}] ` +
        `purge:${stage3Summary}[dRss=${fmtMB(afterPurge.rss - afterShrink.rss)},dSwap=${fmtMB(afterPurge.swap - afterShrink.swap)}] ` +
        `mallopt:${stage4Summary}[dRss=${fmtMB(rssAfter - afterPurge.rss)},dSwap=${fmtMB(swapAfter - afterPurge.swap)}]`,
    );
  }
}

// Exported for test introspection only. Internal API; not part of stable contract.
export const __testing = {
  resetCachedFlags(): void {
    _trimLogEnabled = null;
    _stage1Enabled = null;
    _purgeEnabled = null;
    _dryRunMode = null;
    _cageShrinkEnabled = null;
    _purgeAllocatorEnabled = null;
    _purgeForce = null;
    _stage3RegressionCount = 0;
    _stage4RegressionCount = 0;
    _trimInFlight = false;
  },
  readBootMaxOldSpaceMB,
};
