import { type IncomingMessage, type ServerResponse } from "node:http";
import { PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
import type { OpenClawPluginHttpRouteHandler, OpenClawPluginService } from "../api.js";
import { calcGrowthRates } from "./collectors/growth.js";
import { parseHeapSnapshotSummary } from "./collectors/heap-snapshot.js";
import { sampleMemory } from "./collectors/memory.js";
import { parseSmaps, parseProcStatus, parseSmapsRollup } from "./collectors/proc.js";

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    if (typeof val === "bigint") return `[BigInt:${val}]`;
    return val;
  });
}

let _sourceMapsEnabled: boolean | null = null;

function sourceMapsEnabled(): boolean {
  if (_sourceMapsEnabled !== null) return _sourceMapsEnabled;
  const trace = new Error().stack ?? "";
  _sourceMapsEnabled =
    trace.includes(".ts:") ||
    process.execArgv.some(
      (a) => a === "--enable-source-maps" || a.startsWith("--enable-source-maps="),
    ) ||
    (process.env.NODE_OPTIONS ?? "").includes("--enable-source-maps");
  return _sourceMapsEnabled;
}
import {
  startProfiling,
  stopProfiling,
  isProfiling,
  isInspectorAvailable,
  getLatestProfile,
} from "./collectors/heap-profiler.js";
import { MAX_SAMPLES, SAMPLE_INTERVAL_MS, SMAPS_INTERVAL_MS, GC_KIND_NAMES } from "./constants.js";
import { renderHtml } from "./html-renderer.js";
import type {
  MemorySample,
  PressureAlert,
  GcEvent,
  SpaceHistoryEntry,
  MappedRegion,
  SmapsRollup,
  ProcStatus,
  HeapClassSummary,
} from "./types.js";

export function createMemoryDashboard(): {
  handler: OpenClawPluginHttpRouteHandler;
  service: OpenClawPluginService;
} {
  const samples: MemorySample[] = [];
  const pressureAlerts: PressureAlert[] = [];
  const gcEvents: GcEvent[] = [];
  const spaceHistory: SpaceHistoryEntry[] = [];
  let cachedSmaps: MappedRegion[] = [];
  let cachedSmapsRollup: SmapsRollup | null = null;
  let cachedProcStatus: ProcStatus | null = null;
  let cachedHeapObjs: HeapClassSummary[] = [];
  let lastSnapshotPath: string | null = null;
  let unsubscribe: (() => void) | undefined;
  let gcObserver: PerformanceObserver | undefined;
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  let smapsTimer: ReturnType<typeof setInterval> | undefined;
  let procStatusTimer: ReturnType<typeof setInterval> | undefined;

  const service = {
    id: "diagnostics-memory-dashboard",
    start(ctx) {
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (subscribe) {
        unsubscribe = subscribe((event) => {
          if (event.type === "diagnostic.memory.pressure") {
            pressureAlerts.push({ ts: event.ts, level: event.level, reason: event.reason });
            if (pressureAlerts.length > 100) {
              pressureAlerts.splice(0, pressureAlerts.length - 100);
            }
          }
        });
      }

      memoryTimer = setInterval(() => {
        try {
          const s = sampleMemory();
          samples.push(s);
          if (samples.length > MAX_SAMPLES) {
            samples.splice(0, samples.length - MAX_SAMPLES);
          }
          if (samples.length % 5 === 0) {
            spaceHistory.push({
              ts: s.ts,
              spaces: s.heapSpaces.map((sp) => ({ name: sp.name, used: sp.used, size: sp.size })),
            });
            if (spaceHistory.length > 120) {
              spaceHistory.splice(0, spaceHistory.length - 120);
            }
          }
        } catch (err) {
          ctx.logger.error(
            `memory-dashboard: sample failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, SAMPLE_INTERVAL_MS);

      smapsTimer = setInterval(() => {
        try {
          cachedSmaps = parseSmaps();
          cachedSmapsRollup = parseSmapsRollup();
        } catch {
          // not Linux
        }
      }, SMAPS_INTERVAL_MS);

      procStatusTimer = setInterval(() => {
        try {
          cachedProcStatus = parseProcStatus();
        } catch {
          // not Linux
        }
      }, SMAPS_INTERVAL_MS);

      try {
        gcObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ge = entry as PerformanceEntry & { kind?: number };
            const kind = GC_KIND_NAMES[ge.kind ?? 0] ?? `kind_${ge.kind ?? 0}`;
            gcEvents.push({ ts: Date.now(), kind, duration: Math.round(entry.duration * 1000) });
            if (gcEvents.length > 200) {
              gcEvents.splice(0, gcEvents.length - 200);
            }
          }
        });
        gcObserver.observe({ type: "gc", buffered: false });
      } catch {
        // GC performance observer not supported
      }

      cachedSmaps = parseSmaps();
      cachedSmapsRollup = parseSmapsRollup();
      cachedProcStatus = parseProcStatus();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (memoryTimer !== undefined) {
        clearInterval(memoryTimer);
        memoryTimer = undefined;
      }
      if (smapsTimer !== undefined) {
        clearInterval(smapsTimer);
        smapsTimer = undefined;
      }
      if (procStatusTimer !== undefined) {
        clearInterval(procStatusTimer);
        procStatusTimer = undefined;
      }
      gcObserver?.disconnect();
      gcObserver = undefined;
    },
  } satisfies OpenClawPluginService;

  const handler: OpenClawPluginHttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    let path: string;
    try {
      path = new URL(rawUrl, "http://localhost").pathname;
    } catch {
      path = rawUrl.split("?")[0] ?? "/";
    }

    // smaps endpoint
    if (method === "GET" && path === "/api/memory-dashboard/smaps") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(cachedSmaps));
      return true;
    }

    // heap snapshot trigger + parse
    if (method === "POST" && path === "/api/memory-dashboard/snapshot") {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const filepath = `/tmp/openclaw-heap-${ts}.heapsnapshot`;
        v8.writeHeapSnapshot(filepath);
        lastSnapshotPath = filepath;
        cachedHeapObjs = parseHeapSnapshotSummary(filepath);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, path: filepath, objs: cachedHeapObjs }));
      } catch (err) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return true;
    }

    // main data endpoint
    if (method === "GET" && path === "/api/memory-dashboard/data") {
      const latest = samples.length > 0 ? samples[samples.length - 1] : sampleMemory();
      const body = safeJsonStringify({
        current: latest
          ? {
              ts: latest.ts,
              uptime: latest.uptime,
              rss: latest.rss,
              heapTotal: latest.heapTotal,
              heapUsed: latest.heapUsed,
              external: latest.external,
              arrayBuffers: latest.arrayBuffers,
              heapSizeLimit: latest.heapSizeLimit,
              totalHeapSize: latest.totalHeapSize,
              usedHeapSize: latest.usedHeapSize,
              mallocedMemory: latest.mallocedMemory,
              peakMallocedMemory: latest.peakMallocedMemory,
              code: latest.code,
              cppHeap: latest.cppHeap,
              nativeContexts: latest.nativeContexts,
              detachedContexts: latest.detachedContexts,
              globalHandlesSize: latest.globalHandlesSize,
              usedGlobalHandlesSize: latest.usedGlobalHandlesSize,
              eventLoopIdle: latest.eventLoopIdle,
              eventLoopActive: latest.eventLoopActive,
              eventLoopUtilization: latest.eventLoopUtilization,
              activeResources: latest.activeResources,
            }
          : null,
        hist: samples.map((s) => ({
          ts: s.ts,
          rss: s.rss,
          heapTotal: s.heapTotal,
          heapUsed: s.heapUsed,
        })),
        alerts: pressureAlerts,
        heapSpaces: latest?.heapSpaces ?? [],
        heapObjs: cachedHeapObjs,
        sourceMaps: sourceMapsEnabled(),
        nodeVersion: process.version,
        snapshotPath: lastSnapshotPath,
        gcEvents: gcEvents.slice(-100),
        procStatus: cachedProcStatus,
        smapsRollup: cachedSmapsRollup,
        spaceHistory,
        growthRates: calcGrowthRates(samples),
        heapProfiling: isProfiling(),
        heapInspectorAvailable: isInspectorAvailable(),
        heapProfile: getLatestProfile(),
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
      return true;
    }

    // heap allocation profile start
    if (method === "POST" && path === "/api/memory-dashboard/heap-profile/start") {
      const ok = startProfiling();
      res.statusCode = ok ? 200 : 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok, profiling: isProfiling() }));
      return true;
    }

    // heap allocation profile stop
    if (method === "POST" && path === "/api/memory-dashboard/heap-profile/stop") {
      stopProfiling()
        .then((profile) => {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, profile }));
        })
        .catch(() => {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false }));
        });
      return true;
    }

    // heap allocation profile status
    if (method === "GET" && path === "/api/memory-dashboard/heap-profile/status") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          profiling: isProfiling(),
          inspectorAvailable: isInspectorAvailable(),
          hasProfile: getLatestProfile() !== null,
        }),
      );
      return true;
    }

    // HTML page (default)
    if (method === "GET") {
      const html = renderHtml();
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(html);
      return true;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  };

  return { handler, service };
}
