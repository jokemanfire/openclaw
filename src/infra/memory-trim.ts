/**
 * Platform-aware heap trimming.
 *
 * Triggers a last-resort V8 GC (mark-compact + heap shrink) that releases
 * committed heap pages back to the OS via madvise(MADV_DONTNEED).
 *
 * Requires `--expose-gc` to be set (gateway startup).
 * Works on glibc Linux, Android/scudo, and macOS.
 */

let _trimLogEnabled: boolean | null = null;

function isTrimLogEnabled(): boolean {
  if (_trimLogEnabled !== null) return _trimLogEnabled;
  _trimLogEnabled = process.env.OPENCLAW_MALLOC_TRIM_DEBUG === "1";
  return _trimLogEnabled;
}

function logTrim(msg: string): void {
  if (isTrimLogEnabled()) {
    process.stderr.write(`[memory-trim] ${msg}\n`);
  }
}

export function trimMalloc(label?: string): void {
  const gc = (globalThis as Record<string, unknown>).gc as
    | ((opts?: { type?: string; execution?: string; flavor?: string }) => void)
    | undefined;
  if (typeof gc !== "function") return;

  const rssBefore = process.memoryUsage().rss;
  gc({ type: "major", execution: "sync", flavor: "last-resort" });
  const rssAfter = process.memoryUsage().rss;

  if (isTrimLogEnabled()) {
    logTrim(
      `${label ?? ""} rss_before=${(rssBefore / 1024 / 1024).toFixed(1)}MB ` +
        `rss_after=${(rssAfter / 1024 / 1024).toFixed(1)}MB ` +
        `delta=${((rssAfter - rssBefore) / 1024 / 1024).toFixed(1)}MB`,
    );
  }
}
