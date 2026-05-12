/**
 * 向量分类器测试 — 对比多策略融合 vs 单纯 Top-1 相似度
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VectorClassifier,
  printClassifyResult,
  type VectorClassifyResult,
} from "./vector-classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Embedding API 客户端 ──
const BASE_URL = "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const API_KEY = "Bearer eh4a5b25hsjjxredmp55oic664ulyvv6";
const MODEL = "Qwen3-Embedding-8B";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getEmbedding(text: string): Promise<number[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: API_KEY },
        body: JSON.stringify({ model: MODEL, input: [text] }),
      });
      const text_ = await resp.text();
      if (resp.status === 429 || text_.includes("Too many requests")) {
        const wait = (attempt + 1) * 5000;
        console.log(`  限流，等待 ${wait / 1000}s...`);
        await delay(wait);
        continue;
      }
      const payload = JSON.parse(text_) as { data: Array<{ embedding: number[] }> };
      return payload.data?.[0]?.embedding ?? [];
    } catch (err) {
      lastError = err;
      if (attempt < 4) await delay(3000);
    }
  }
  throw lastError;
}

// ── 对比：单纯 Top-1 相似度 ──
function naiveTop1(
  queryVec: number[],
  classifier: VectorClassifier,
): { scenario: string; score: number } {
  // 直接用 classify 的 topMatches 中的第一条
  const result = classifier.classify(queryVec);
  // 找到全局最高单条相似度
  let bestScore = 0;
  let bestScenario = "";
  for (const r of result.allResults) {
    const top = r.topMatches[0];
    if (top && top.similarity > bestScore) {
      bestScore = top.similarity;
      bestScenario = top.scenario;
    }
  }
  return { scenario: bestScenario, score: bestScore };
}

// ── 测试用例 ──
interface TestCase {
  query: string;
  expected: string; // 期望的场景
}

const TEST_CASES: TestCase[] = [
  { query: "明天会下雨吗", expected: "inner_weather" },
  { query: "帮我打个车去火车站", expected: "inner_transportation" },
  { query: "把手机调成静音模式", expected: "inner_system_settings" },
  { query: "帮我录个音保存下来", expected: "inner_recorder" },
  { query: "给李明打个电话", expected: "inner_call" },
  { query: "发条短信通知大家开会", expected: "inner_message" },
  { query: "明天早上8点叫我起床", expected: "inner_alarm" },
  { query: "帮我查一下下周的日程", expected: "inner_agenda" },
  { query: "把这个投屏到电视上", expected: "inner_cast" },
  { query: "帮我生成一张海报图", expected: "artifact_image_gen" },
  { query: "播一首周杰伦的歌", expected: "inner_entertainment" },
  { query: "截一下当前屏幕", expected: "inner_ztescreenshot" },
  // 边界情况 — 模糊/跨场景查询
  { query: "今天适合出去玩吗", expected: "inner_weather" },
  { query: "我找不到手机了", expected: "inner_system_settings" },
  { query: "帮我订个酒店", expected: "inner_transportation" },
];

// ── 主流程 ──
async function main(): Promise<void> {
  const dbPath = path.join(__dirname, "evaluation_questions.db");

  console.log("初始化向量分类器...");
  const classifier = new VectorClassifier(dbPath, { topK: 15 });
  console.log(
    `已加载 ${classifier.getScenarios().length} 个场景，共 ${[...classifier.getScenarioSizes().values()].reduce((a, b) => a + b, 0)} 条问题\n`,
  );

  console.log("=".repeat(80));
  console.log("测试: 多策略融合 vs 单纯 Top-1");
  console.log("=".repeat(80));

  let fusionCorrect = 0;
  let naiveCorrect = 0;
  const total = TEST_CASES.length;

  for (let t = 10; t < TEST_CASES.length; t++) {
    const tc = TEST_CASES[t]!;
    console.log(`\n${"─".repeat(60)}`);
    console.log(`[${t + 1}/${total}] 查询: "${tc.query}"`);
    console.log(`期望场景: ${tc.expected}`);

    const queryVec = await getEmbedding(tc.query);
    const result = classifier.classify(queryVec);
    const naive = naiveTop1(queryVec, classifier);

    // 避免 API 限流
    if (t < TEST_CASES.length - 1) await delay(5000);

    const fusionOk = result.topScenario.scenario === tc.expected;
    const naiveOk = naive.scenario === tc.expected;

    if (fusionOk) fusionCorrect++;
    if (naiveOk) naiveCorrect++;

    const fusionMark = fusionOk ? "✓" : "✗";
    const naiveMark = naiveOk ? "✓" : "✗";
    const fusionConf = (result.confidence * 100).toFixed(0);

    console.log(
      `融合算法: ${fusionMark} ${result.topScenario.scenario} (${(result.topScenario.score * 100).toFixed(1)}%) 置信度:${fusionConf}%`,
    );
    console.log(`单纯Top1: ${naiveMark} ${naive.scenario} (${(naive.score * 100).toFixed(1)}%)`);

    if (!fusionOk || !naiveOk) {
      console.log("  其他候选:");
      for (const r of result.allResults.slice(1, 4)) {
        console.log(`    ${r.scenario}: ${(r.score * 100).toFixed(1)}%`);
      }
    }
  }

  // 汇总
  console.log(`\n${"=".repeat(60)}`);
  console.log("汇总对比");
  console.log("=".repeat(60));
  console.log(
    `多策略融合: ${fusionCorrect}/${total} = ${((fusionCorrect / total) * 100).toFixed(1)}%`,
  );
  console.log(
    `单纯 Top-1: ${naiveCorrect}/${total} = ${((naiveCorrect / total) * 100).toFixed(1)}%`,
  );
  console.log();

  // 详细结果示例
  console.log(`${"=".repeat(60)}`);
  console.log("详细分类示例（最后一个查询）");
  printClassifyResult(
    TEST_CASES[TEST_CASES.length - 1]!.query,
    classifier.classify(await getEmbedding(TEST_CASES[TEST_CASES.length - 1]!.query)),
  );
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
