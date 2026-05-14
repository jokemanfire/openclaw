// Test: structuredClone vs cloneJsonValue memory retention under Node.js vs Bun.
// Run: node --expose-gc scripts/bench-clone-runtime.mjs
// Run: bun run scripts/bench-clone-runtime.mjs   (Bun supports global gc())
//
// Simulates session-store-cache / secrets-runtime snapshot clone workload.
// Each iteration clones a large config + session-store object (8467 "facts"
// mimicking the #45438 OOM scenario), then forces GC. Tracks RSS + C++ heap
// deltas at checkpoints.

import v8 from "node:v8";

const HAS_V8 = typeof v8?.getCppHeapStatistics === "function";
const ITERATIONS = 500;
const CHECKPOINT_EVERY = 20;
const FACT_COUNT = 500; // matches #45438 OOM scenario

let runtimeLabel = "node";
if (typeof Bun !== "undefined") runtimeLabel = "bun";
else if (typeof Deno !== "undefined") runtimeLabel = "deno";
console.log("Runtime: %s", runtimeLabel);
console.log("Iterations: %d | Facts: %d | Checkpoint every: %d\n", ITERATIONS, FACT_COUNT, CHECKPOINT_EVERY);

function buildLargeStore() {
  const store = {
    version: 1,
    meta: { lastCompacted: Date.now(), factCount: FACT_COUNT },
    entries: {},
    index: {},
  };
  for (let i = 0; i < FACT_COUNT; i++) {
    store.entries[String(i)] = {
      id: `fact-${i}`,
      content: `Memory fact #${i}: `.repeat(10) + `payload ${String(i).padStart(6, "0")}`,
      embedding: new Array(256).fill(i % 1000 / 1000),
      timestamp: Date.now(),
      tags: ["memory", `batch-${i % 20}`, i % 5 === 0 ? "pinned" : "volatile"],
      strength: i % 20 === 0 ? 0.9 : 0.3,
    };
    store.index[String(i)] = { hash: `h${i}`, size: 256, offset: i * 128 };
  }
  // Add config payload similar to secrets runtime snapshot
  store.config = {
    agents: {
      defaults: {
        sandbox: { mode: "all", backend: "docker" },
        maxContextTokens: 200000,
        compaction: { strategy: "auto", reserveTokens: 4000 },
      },
    },
  };
  for (let i = 0; i < 200; i++) {
    store.config.agents[String(i)] = {
      sandbox: { mode: "off" },
      systemPrompt: `Agent ${i}: `.repeat(30),
      model: { primary: "gpt-5.5" },
    };
  }
  store.messageHistory = [];
  for (let i = 0; i < 50; i++) {
    store.messageHistory.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: `.repeat(100),
      timestamp: Date.now() - i * 60000,
    });
  }
  store.summary = null;
  store.compactionLog = [];
  return store;
}

function jsonClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function gc() {
  global.gc?.();
  if (typeof Bun !== "undefined") Bun.gc(true);
}

function fmt(b) {
  const abs = Math.abs(b);
  if (abs >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (abs >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (abs >= 1024) return (b / 1024).toFixed(1) + " KB";
  return b + " B";
}

function cppString(stats) {
  if (!stats || !stats.committed_size_bytes) return "";
  return (
    ` | cpp-committed: ${fmt(stats.committed_size_bytes)}` +
    ` resident: ${fmt(stats.resident_size_bytes)}`
  );
}

function measure(strategy, cloneFn) {
  console.log("=== %s ===\n", strategy);
  gc();
  let store = buildLargeStore();
  gc();

  const baselineRss = process.memoryUsage().rss;
  const baselineCpp = HAS_V8 ? v8.getCppHeapStatistics() : null;
  console.log(
    "[baseline] RSS: %s%s",
    fmt(baselineRss),
    cppString(baselineCpp),
  );

  const checkpoints = [];
  let lastRss = baselineRss;

  for (let i = 1; i <= ITERATIONS; i++) {
    store = cloneFn(store);
    if (i % CHECKPOINT_EVERY === 0) {
      gc();
      const currentRss = process.memoryUsage().rss;
      const currentCpp = HAS_V8 ? v8.getCppHeapStatistics() : null;
      const iterLabel = String(i).padStart(5);
      console.log(
        "[iter%s] RSS: %s (Δ %s)%s",
        iterLabel,
        fmt(currentRss),
        fmt(currentRss - baselineRss),
        cppString(currentCpp),
      );
      checkpoints.push({ iter: i, rss: currentRss, cpp: currentCpp });
      lastRss = currentRss;
    }
  }

  gc();
  const finalRss = process.memoryUsage().rss;
  const finalCpp = HAS_V8 ? v8.getCppHeapStatistics() : null;
  const peaks = checkpoints.length > 0
    ? {
        maxRss: Math.max(...checkpoints.map((c) => c.rss)),
        minRss: Math.min(...checkpoints.map((c) => c.rss)),
      }
    : null;

  console.log("\n  Summary:");
  console.log("    RSS range: %s - %s", fmt(peaks?.minRss ?? 0), fmt(peaks?.maxRss ?? 0));
  console.log("    RSS final: %s (Δ from baseline: %s)", fmt(finalRss), fmt(finalRss - baselineRss));
  if (HAS_V8) {
    console.log("    C++ committed final: %s", fmt(finalCpp?.committed_size_bytes ?? 0));
  }

  return { baselineRss, finalRss, checkpoints };
}

// --- Main ---
gc();

const jsonResult = measure("JSON clone (JSON.parse/stringify)", jsonClone);
gc();
gc();

const scResult = measure("structuredClone", (v) => structuredClone(v));

// Comparison
const jsonGrowth = jsonResult.finalRss - jsonResult.baselineRss;
const scGrowth = scResult.finalRss - scResult.baselineRss;
console.log("========================================\n");
console.log("RSS growth after %d iterations:", ITERATIONS);
console.log("  JSON clone:      %s", fmt(jsonGrowth));
console.log("  structuredClone: %s", fmt(scGrowth));
if (jsonGrowth > 0 && scGrowth > 0) {
  console.log("  Ratio (sc/json): %.1fx", scGrowth / jsonGrowth);
}

if (scGrowth > jsonGrowth * 2) {
  console.log("\nstructuredClone retains significantly more native memory after GC.");
} else if (scGrowth <= jsonGrowth) {
  console.log("\nstructuredClone does NOT exhibit excess native memory retention.");
  if (runtimeLabel === "bun") {
    console.log("Bun's structuredClone (JSC) may avoid V8's native allocation pattern.");
  }
}
