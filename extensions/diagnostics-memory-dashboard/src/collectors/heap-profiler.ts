import { Session } from "node:inspector";

type AllocationProfileNode = {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  selfSize: number;
  children: AllocationProfileNode[];
};

type AllocationProfile = {
  head: AllocationProfileNode;
};

let session: Session | null = null;
let profiling = false;
let inspectorAvailable: boolean | null = null;
let cachedProfile: AllocationProfile | null = null;

export function isInspectorAvailable(): boolean {
  if (inspectorAvailable !== null) return inspectorAvailable;
  try {
    const s = new Session();
    s.connect();
    s.disconnect();
    inspectorAvailable = true;
  } catch {
    inspectorAvailable = false;
  }
  return inspectorAvailable;
}

export function startProfiling(samplingIntervalBytes = 32768): boolean {
  if (profiling) return true;
  if (!isInspectorAvailable()) return false;
  try {
    session = new Session();
    session.connect();
    session.post("HeapProfiler.enable", () => {
      session!.post("HeapProfiler.startSampling", {
        samplingInterval: samplingIntervalBytes,
      });
    });
    profiling = true;
    cachedProfile = null;
    return true;
  } catch {
    session = null;
    return false;
  }
}

export async function stopProfiling(): Promise<AllocationProfile | null> {
  if (!profiling || !session) return null;
  return new Promise((resolve) => {
    const s = session!;
    s.post("HeapProfiler.stopSampling", (err, result) => {
      profiling = false;
      try {
        s.disconnect();
      } catch {
        // ignore
      }
      session = null;
      if (err || !result?.profile) {
        resolve(null);
        return;
      }
      cachedProfile = result.profile as AllocationProfile;
      resolve(cachedProfile);
    });
  });
}

export function isProfiling(): boolean {
  return profiling;
}

export function getLatestProfile(): AllocationProfile | null {
  return cachedProfile;
}
