import type { GrowthRates, MemorySample } from "../types.js";

export function calcGrowthRate(
  samples: MemorySample[],
  getValue: (s: MemorySample) => number,
  windowMs: number,
): number {
  if (samples.length < 2) return 0;
  const now = samples[samples.length - 1]!.ts;
  const cutoff = now - windowMs;
  let oldest = samples[0]!;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.ts <= cutoff) {
      oldest = s;
      break;
    }
  }
  const latest = samples[samples.length - 1]!;
  const dt = (latest.ts - oldest.ts) / 1000;
  if (dt <= 0) return 0;
  return (getValue(latest) - getValue(oldest)) / dt;
}

export function calcGrowthRates(samples: MemorySample[]): GrowthRates {
  return {
    rssInstant: calcGrowthRate(samples, (s) => s.rss, 15_000),
    rss1m: calcGrowthRate(samples, (s) => s.rss, 60_000),
    rss5m: calcGrowthRate(samples, (s) => s.rss, 300_000),
    heapInstant: calcGrowthRate(samples, (s) => s.heapUsed, 15_000),
    heap1m: calcGrowthRate(samples, (s) => s.heapUsed, 60_000),
    heap5m: calcGrowthRate(samples, (s) => s.heapUsed, 300_000),
  };
}
