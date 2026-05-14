import { constants as perfConstants } from "node:perf_hooks";

export const MAX_SAMPLES = 3600;
export const SAMPLE_INTERVAL_MS = 10000;
export const SMAPS_INTERVAL_MS = 10000;

export const GC_KIND_NAMES: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};
