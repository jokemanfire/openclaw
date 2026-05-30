/**
 * Wrapper for the memory-purge native addon.
 *
 * Loads zte_prebuilts/libs/memory-purge-android/<version>/arm64/memory_purge.node
 * on Android arm64, returning a no-op binding on other platforms or when the
 * prebuilt is missing.
 *
 * Usage:
 *   import { getMemoryPurgeBinding } from "src/zte_wrappers/memory-purge-wrapper/memoryPurgeAdapter";
 *   const binding = getMemoryPurgeBinding();
 *   const result = binding.purgeDeadVMAs();
 *
 * Safety:
 *   - Returns no-op binding on non-Android platforms (no crash on dev/CI)
 *   - Returns no-op binding when prebuilt .node is missing
 *   - dlopen errors are caught and logged, never thrown
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MemoryPurgeResult {
  /** Total VMAs in /proc/self/smaps. */
  scanned: number;
  /** VMAs passing layer 1 (11-condition) + layer 2 (cluster fingerprint). */
  candidates: number;
  /**
   * Subset of `candidates` that survived layer 3 observation period
   * (>= minObservations consecutive scans with stable swap).
   */
  stable: number;
  /** madvise calls that returned 0. */
  purged: number;
  /** madvise calls that failed. */
  failed: number;
  /** Sum of swap_kb of successfully-purged VMAs. */
  swapReclaimedKB: number;
  /**
   * Layer 3 skip count: candidates still being watched (hit_count <
   * minObservations). They will graduate to `stable` after enough scans.
   */
  skippedByObservation: number;
  /** Layer 4 skip count: stable VMAs not purged due to per-call quota. */
  skippedByLimit: number;
  /** Current minObservations setting (echoes env or default). */
  minObservations: number;
  errors: string[];
}

export interface MemoryPurgeDryRunEntry {
  addr: string;
  sizeKB: number;
  swapKB: number;
  name: string;
}

export interface MemoryPurgeAllocatorResult {
  /** True iff Bionic libc exports mallopt and is callable on this kernel. */
  available: boolean;
  /** True iff mallopt(M_PURGE_ALL) returned success (Bionic returns 1 on ok). */
  ok: boolean;
  /** Raw mallopt return code. */
  returnCode: number;
  /** VmSwap delta in KB (clamped to >=0). */
  swapReclaimedKB: number;
  /** VmRSS delta in KB (clamped to >=0). */
  rssReclaimedKB: number;
}

export interface MemoryPurgeBinding {
  purgeDeadVMAs(): MemoryPurgeResult;
  dryRunDeadVMAs(): MemoryPurgeDryRunEntry[];
  /**
   * Bionic-only. Calls mallopt(M_PURGE_ALL) to release Scudo libc free
   * chunks back to the OS via madvise(MADV_DONTNEED). Clears zram entries
   * for swapped-out free chunks. Returns `available:false` on platforms
   * without Bionic mallopt (any non-Android, or NDK builds where dlsym
   * fails); caller should treat as no-op.
   */
  purgeAllocator?(): MemoryPurgeAllocatorResult;
  getInfo(): {
    version: string;
    abiTarget: string;
    conditions: number;
    malloptAvailable?: boolean;
    minObservations?: number;
    maxVmasPerCall?: number;
    maxKbPerCall?: number;
  };
  isNoop?: boolean;
}

/**
 * Expected version of the native addon. Must match the value returned by
 * `memory_purge.cc`'s `getInfo().version`. dlopen will refuse to expose the
 * binding when versions disagree (silent noop fallback) — this prevents
 * loading an addon whose ABI surface differs from what this wrapper expects.
 *
 * The prebuilt directory layout `zte_prebuilts/libs/memory-purge-android/<NATIVE_VERSION>/arm64/`
 * uses the same constant so deploy artifact path and runtime version stay in lockstep.
 */
const NATIVE_VERSION = "0.3.0";

let cached: MemoryPurgeBinding | null = null;

type AndroidArchTag = "arm64";

function resolveAndroidArchTag(): AndroidArchTag | null {
  if (process.platform !== "android") {
    return null;
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  return null;
}

function findRepoRoot(startFilePath: string): string {
  let cursor = path.dirname(startFilePath);
  for (let i = 0; i < 24; i += 1) {
    if (existsSync(path.join(cursor, "zte_prebuilts", "libs"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return process.cwd();
}

function resolveAndroidLoadablePath(): string | null {
  const archTag = resolveAndroidArchTag();
  if (!archTag) return null;

  const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
  const base = path.join(repoRoot, "zte_prebuilts", "libs");
  const candidate = path.join(base, "memory-purge-android", NATIVE_VERSION, archTag, "memory_purge.node");

  if (existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function createNoopBinding(reason: string): MemoryPurgeBinding {
  let warned = false;
  const warn = () => {
    if (!warned) {
      process.stderr.write(`[memory-purge] noop binding: ${reason}\n`);
      warned = true;
    }
  };
  return {
    purgeDeadVMAs: () => {
      warn();
      return {
        scanned: 0,
        candidates: 0,
        stable: 0,
        purged: 0,
        failed: 0,
        swapReclaimedKB: 0,
        skippedByObservation: 0,
        skippedByLimit: 0,
        minObservations: 0,
        errors: [],
      };
    },
    dryRunDeadVMAs: () => {
      warn();
      return [];
    },
    purgeAllocator: () => {
      warn();
      return { available: false, ok: false, returnCode: 0, swapReclaimedKB: 0, rssReclaimedKB: 0 };
    },
    getInfo: () => ({
      version: "noop",
      abiTarget: "none",
      conditions: 0,
      malloptAvailable: false,
      minObservations: 0,
      maxVmasPerCall: 0,
      maxKbPerCall: 0,
    }),
    isNoop: true,
  };
}

function tryLoadAndroidBinding(): MemoryPurgeBinding | null {
  const loadablePath = resolveAndroidLoadablePath();
  if (!loadablePath) {
    return null;
  }

  // Use process.dlopen rather than require() because the .node is outside
  // node_modules; openclaw's patch-native-modules.js handles redirection
  // for /data/openclaw/openclaw_run paths but we use the prebuilt path
  // directly here.
  try {
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    (process as unknown as { dlopen(m: typeof mod, p: string): void }).dlopen(mod, loadablePath);
    const exports = mod.exports as unknown as MemoryPurgeBinding;
    if (
      typeof exports.purgeDeadVMAs !== "function" ||
      typeof exports.dryRunDeadVMAs !== "function" ||
      typeof exports.getInfo !== "function"
    ) {
      process.stderr.write(
        `[memory-purge] loaded ${loadablePath} but missing expected exports\n`,
      );
      return null;
    }

    // Version handshake: refuse to expose the binding if .node reports a
    // version different from what this wrapper expects. Prevents loading
    // an addon whose ABI surface (return shape, env defaults, behavior)
    // may have drifted.
    const info = exports.getInfo();
    if (info.version !== NATIVE_VERSION) {
      process.stderr.write(
        `[memory-purge] version mismatch: wrapper expects ${NATIVE_VERSION}, ` +
          `binary at ${loadablePath} reports ${info.version}; falling back to noop\n`,
      );
      return null;
    }

    process.stderr.write(`[memory-purge] loaded native addon from ${loadablePath} (v${info.version})\n`);
    return exports;
  } catch (error) {
    process.stderr.write(
      `[memory-purge] dlopen failed for ${loadablePath}: ${String(error)}\n`,
    );
    return null;
  }
}

/**
 * Get the memory-purge binding. Returns a no-op binding on non-Android
 * platforms or when the prebuilt .node is missing/unloadable. Result is
 * cached for the lifetime of the process.
 */
export function getMemoryPurgeBinding(): MemoryPurgeBinding {
  if (cached) return cached;

  const archTag = resolveAndroidArchTag();
  if (!archTag) {
    cached = createNoopBinding(`unsupported platform=${process.platform} arch=${process.arch}`);
    return cached;
  }

  const native = tryLoadAndroidBinding();
  if (native) {
    cached = native;
    return cached;
  }

  cached = createNoopBinding("prebuilt .node not found or failed to load");
  return cached;
}


