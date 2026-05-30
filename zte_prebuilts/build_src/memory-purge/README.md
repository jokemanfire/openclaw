# memory-purge native addon

Native Node.js addon to release V8 BoundedPageAllocator freelist dead VMAs that
the kernel has swapped to zram on Android.

## Why

On Android, openclaw exhibits PSS > RSS due to ~120 MB of SwapPss accumulating
over time. Of this:

- ~62% (77 MB) is V8 BoundedPageAllocator dead regions in the V8 cage
  (identified by `nr` flag in `/proc/<pid>/smaps`)
- These regions: RSS=0, never referenced, but swap entries persist in zram
- V8 PageAllocator never `munmap`s them (keeps in freelist for reuse)
- Result: zram slots permanently occupied until process exit

This addon scans `/proc/self/smaps` and calls `madvise(MADV_DONTNEED)` on
verified-safe dead regions. The kernel then frees the swap entries.

## Strict 11-condition safety filter

A region is purged only if **all 11** conditions are met:

| # | Condition | Why |
|---|-----------|-----|
| 1 | Rss == 0 | No resident pages |
| 2 | Pss == 0 | No proportional set |
| 3 | Anonymous == 0 | Confirmed anonymous |
| 4 | Private_Dirty == 0 | No dirty pages |
| 5 | Private_Clean == 0 | No clean pages |
| 6 | Referenced == 0 | Never accessed |
| 7 | Swap >= 4 KB | At least one 4KB swap slot to reclaim |
| 8 | VmFlags contains "nr" | V8 cage subregion fingerprint (MAP_NORESERVE) |
| 9 | Permission == "rw-p" | **Standard anon ONLY**. Excludes `rwxp` which is V8 JIT code arenas. JIT regions can show RSS=0 + Swap>0 (cold trampolines paged out) but V8 will `bl <swapped-trampoline-addr>` next time it dispatches → if we madvised it, the bytes become 0 → SIGSEGV. |
| 10 | Not stack_and_tls / [stack | Not a thread stack |
| 11 | Not libc_malloc | Scudo manages those (mallopt is the right API) |

### DryRun verification on PQ85A01 (PID 12576, 2026-05-30)

Ran the same 11-condition filter (Python port `dryrun_purge.py`) against a
live `/proc/12576/smaps`:

```
Total VMAs scanned:        1125
Process total swap:        113.9 MB
Candidates passing filter:    1
Reclaimable swap:           75.2 MB  (67.6% of total swap)

Rejection breakdown:
  rss_kb!=0           967  (active, in use)
  swap_kb<4           130  (no swap to reclaim)
  no_nr_flag           20  (not V8 cage)
  wrong_prot            7  (rwxp = JIT, MUST NOT madvise) <-- safety net
  is_stack              0
  is_libc_malloc        0
```

The 7 rwxp regions (V8 JIT trampolines at addresses 9e7xxxxxxx) are
correctly **rejected by condition 9**. Without this safety net, madvising
them would zero the trampoline bytes and crash the process on next JIT
dispatch.

## Why this is safe

V8 BoundedPageAllocator (used since V8 9.0) treats freelist regions as
"uninitialized memory":

```cpp
// V8 PageAllocator::AllocatePages()
//   1. take region from freelist
//   2. mprotect(PROT_READ|PROT_WRITE)
//   3. caller writes new content
//      (V8 does NOT read freelist content before write)
```

After `madvise(MADV_DONTNEED)`:
- Swap entries cleared (zram slots freed immediately)
- Next access returns zero pages
- V8 reuse: writes new content, no read of stale data

## Build

Requires Android NDK r29 and matching Node.js headers.

```bash
export ANDROID_NDK_HOME=/opt/android-ndk-r29
export NODE_VERSION=24.14.0      # match device node-core
export ANDROID_API=24
./build.sh
```

Output: `build/Release/memory_purge.node`

## Deployment

Place the `.node` file at the standard ZTE prebuilt path:

```
zte_prebuilts/libs/memory-purge-android/<version>/arm64/memory_purge.node
```

Then reference from `src/zte_wrappers/memory-purge-wrapper/`.

## API

### `purgeDeadVMAs()`
Scans smaps, applies 11-condition filter, calls madvise on each match.
Returns:
```typescript
{
  scanned: number;       // total VMAs scanned
  candidates: number;    // VMAs passing the filter
  purged: number;        // madvise calls returning 0
  failed: number;        // madvise calls failing
  swapReclaimedKB: number; // sum of swap_kb purged
  errors: string[];      // up to 5 error strings
}
```

### `dryRunDeadVMAs()`
Same scan, but does NOT call madvise. Use for canary validation.
Returns: array of `{ addr, sizeKB, swapKB, name }`.

### `getInfo()`
Returns `{ version, abiTarget, conditions }` for runtime verification.

## Out of scope (intentionally)

- libc_malloc Scudo regions: requires `mallopt(M_PURGE_ALL, 0)` instead
- V8 256K heap pages: V8 GC + munmap (already in `memory-trim.ts` step 1)
- Thread stacks, file mappings: never safe to madvise externally

## Effect on PSS-RSS gap (195 measured baseline)

| Component | Swap | Action by this addon |
|-----------|------|----------------------|
| A1 - V8 cage dead (nr+RSS=0) | **77.3 MB** | ✅ purge |
| A2 - libc dead | 0.6 MB | ❌ skip (Scudo) |
| B1 - libc partial | 18.3 MB | ❌ skip (Scudo) |
| B2 - V8 256K page | 13.4 MB | ❌ skip (V8 GC handles) |
| B5 - other partial | 13 MB | ❌ skip (unsafe) |
| Other | 1.3 MB | ❌ skip |

Expected reduction: **~77 MB** of SwapPss per cycle.
