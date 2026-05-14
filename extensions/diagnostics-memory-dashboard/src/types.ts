export type HeapSpaceSample = {
  name: string;
  size: number;
  used: number;
  available: number;
  physicallySize: number;
};

export type CodeStats = {
  codeAndMetadataSize: number;
  bytecodeAndMetadataSize: number;
  externalScriptSourceSize: number;
  cpuUser: number;
  cpuSystem: number;
};

export type CppHeapStats = Record<string, unknown>;

export type MemorySample = {
  ts: number;
  uptime: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimit: number;
  totalHeapSize: number;
  usedHeapSize: number;
  mallocedMemory: number;
  peakMallocedMemory: number;
  heapSpaces: HeapSpaceSample[];
  code: CodeStats;
  cppHeap: CppHeapStats;
  nativeContexts: number;
  detachedContexts: number;
  globalHandlesSize: number;
  usedGlobalHandlesSize: number;
  eventLoopIdle: number;
  eventLoopActive: number;
  eventLoopUtilization: number;
  activeResources: string[];
};

export type MappedRegion = {
  path: string;
  rss: number;
  pss: number;
  sharedClean: number;
  sharedDirty: number;
  privateClean: number;
  privateDirty: number;
  vss: number;
  regionCount: number;
};

export type HeapClassSummary = {
  name: string;
  count: number;
  shallowSize: number;
};

export type PressureAlert = {
  ts: number;
  level: string;
  reason: string;
};

export type GcEvent = {
  ts: number;
  kind: string;
  duration: number;
};

export type ProcStatus = {
  vmPeak: number;
  vmSize: number;
  vmRSS: number;
  vmHWM: number;
  vmData: number;
  vmStk: number;
  rssAnon: number;
  rssFile: number;
  rssShmem: number;
  threads: number;
};

export type SpaceHistoryEntry = {
  ts: number;
  spaces: { name: string; used: number; size: number }[];
};

export type GrowthRates = {
  rssInstant: number;
  rss1m: number;
  rss5m: number;
  heapInstant: number;
  heap1m: number;
  heap5m: number;
};

export type SmapsRollup = {
  rss: number;
  pss: number;
  anonymous: number;
  fileBacked: number;
  sharedClean: number;
  sharedDirty: number;
  privateClean: number;
  privateDirty: number;
};
