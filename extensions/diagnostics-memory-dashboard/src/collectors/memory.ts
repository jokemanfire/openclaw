import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";
import type { MemorySample } from "../types.js";

let _prevElu: ReturnType<typeof performance.eventLoopUtilization> | undefined;

export function sampleMemory(): MemorySample {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const cpp = v8.getCppHeapStatistics("detailed") as Record<string, unknown>;
  const code = v8.getHeapCodeStatistics();
  const cpu = process.cpuUsage();
  const spaces = v8.getHeapSpaceStatistics().map((s) => ({
    name: s.space_name,
    size: s.space_size,
    used: s.space_used_size,
    available: s.space_available_size,
    physicallySize: s.physical_space_size,
  }));
  let eluIdle = 0,
    eluActive = 0,
    eluUtil = 0;
  try {
    const elu = _prevElu
      ? performance.eventLoopUtilization(_prevElu)
      : performance.eventLoopUtilization();
    eluIdle = Math.round(elu.idle * 1000);
    eluActive = Math.round(elu.active * 1000);
    eluUtil = elu.utilization;
    _prevElu = performance.eventLoopUtilization();
  } catch {
    // eventLoopUtilization not available
  }
  let activeResources: string[] = [];
  try {
    activeResources = process.getActiveResourcesInfo?.() ?? [];
  } catch {
    // getActiveResourcesInfo not available (Node < 17.9)
  }
  return {
    ts: Date.now(),
    uptime: Math.round(process.uptime() * 1000),
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    heapSizeLimit: heap.heap_size_limit,
    totalHeapSize: heap.total_heap_size,
    usedHeapSize: heap.used_heap_size,
    mallocedMemory: heap.malloced_memory,
    peakMallocedMemory: heap.peak_malloced_memory,
    heapSpaces: spaces,
    code: {
      codeAndMetadataSize: code.code_and_metadata_size,
      bytecodeAndMetadataSize: code.bytecode_and_metadata_size,
      externalScriptSourceSize: code.external_script_source_size,
      cpuUser: cpu.user,
      cpuSystem: cpu.system,
    },
    cppHeap: cpp,
    nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
    globalHandlesSize: heap.total_global_handles_size,
    usedGlobalHandlesSize: heap.used_global_handles_size,
    eventLoopIdle: eluIdle,
    eventLoopActive: eluActive,
    eventLoopUtilization: eluUtil,
    activeResources,
  };
}
