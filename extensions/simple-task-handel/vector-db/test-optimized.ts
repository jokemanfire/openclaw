/**
 * 优化后分类器测试 — 精确匹配 vs 非精确匹配
 *
 * 测试两类场景:
 *   A) 188 条已知问题中随机抽取 → 必须 100% 精确命中
 *   B) 用户自由输入的新问题 → 走融合算法，准确率应高于单纯 Top-1
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VectorClassifier, printClassifyResult } from "./vector-classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "evaluation_questions.db");

const BASE_URL = "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const API_KEY = "Bearer eh4a5b25hsjjxredmp55oic664ulyvv6";
const MODEL = "Qwen3-Embedding-8B";
const DELAY_MS = 4000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getEmbedding(text: string): Promise<number[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: API_KEY },
        body: JSON.stringify({ model: MODEL, input: [text] }),
      });
      const raw = await resp.text();
      if (resp.status === 429 || raw.includes("Too many requests")) {
        const wait = (attempt + 1) * 5000;
        console.log(`  限流，等待${wait / 1000}s...`);
        await delay(wait);
        continue;
      }
      const payload = JSON.parse(raw) as { data: Array<{ embedding: number[] }> };
      return payload.data?.[0]?.embedding ?? [];
    } catch {
      if (attempt < 4) await delay(3000);
    }
  }
  throw new Error("API 调用失败");
}

// ========== 测试 A: 精确匹配 ==========
async function testExactMatch(classifier: VectorClassifier): Promise<void> {
  console.log("=".repeat(60));
  console.log("测试 A: 188 条已知问题的精确匹配");
  console.log("=".repeat(60));

  // 从数据库随机选 8 条不同场景的原始问题
  const testQuestions = [
    { id: "openclaw_skills_inner_weather_0003", scenario: "inner_weather", text: "明天会下雨吗" },
    {
      id: "openclaw_skills_inner_transportation_0015",
      scenario: "inner_transportation",
      text: "帮我打车去西安北站",
    },
    {
      id: "openclaw_skills_inner_call_0005",
      scenario: "inner_call",
      text: "查一下和韩梅梅的通话记录",
    },
    {
      id: "openclaw_skills_inner_alarm_0010",
      scenario: "inner_alarm",
      text: "设置一个30分钟的倒计时",
    },
    {
      id: "openclaw_skills_inner_agenda_0018",
      scenario: "inner_agenda",
      text: "提醒我下午3点有个会议",
    },
    {
      id: "openclaw_skills_inner_cast_0001",
      scenario: "inner_cast",
      text: "帮我把这个页面投射到电视上去。",
    },
    {
      id: "openclaw_skills_inner_ztescreenshot_0002",
      scenario: "inner_ztescreenshot",
      text: "这个页面上的内容挺关键的，帮我把现在的屏幕画面拍下来。",
    },
    {
      id: "openclaw_skills_inner_system_settings_0008",
      scenario: "inner_system_settings",
      text: "我马上要开会了，不希望手机待会发出任何响动，等开完会再恢复声音。",
    },
  ];

  let passed = 0;
  for (let i = 0; i < testQuestions.length; i++) {
    const tq = testQuestions[i]!;
    console.log(`\n[${i + 1}/${testQuestions.length}] "${tq.text.slice(0, 40)}..."`);

    const vec = await getEmbedding(tq.text);
    const result = classifier.classify(vec);

    const ok = result.exactMatch && result.topScenario.scenario === tq.scenario;
    const mark = ok ? "✓" : "✗";

    console.log(`  精确匹配: ${result.exactMatch ? "是" : "否"} | ID: ${result.exactMatchId}`);
    console.log(`  ${mark} 场景: ${result.topScenario.scenario} (期望: ${tq.scenario})`);

    if (ok) passed++;
    if (i < testQuestions.length - 1) await delay(DELAY_MS);
  }

  console.log(
    `\n精确匹配准确率: ${passed}/${testQuestions.length} = ${((passed / testQuestions.length) * 100).toFixed(0)}%`,
  );
}

// ========== 测试 B: 新问题（非精确匹配） ==========
async function testNewQueries(classifier: VectorClassifier): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("测试 B: 新问题（不在 188 条内）— 融合算法 vs 单纯 Top-1");
  console.log("=".repeat(60));

  const testCases = [
    { query: "帮我录个音保存下来", expected: "inner_recorder" },
    { query: "今天适合出去玩吗", expected: "inner_weather" },
    { query: "我找不到手机了", expected: "inner_system_settings" },
    { query: "帮我生成一张海报图", expected: "artifact_image_gen" },
    { query: "播一首周杰伦的歌", expected: "inner_entertainment" },
    { query: "帮我把屏幕截图发给小王", expected: "inner_ztescreenshot" },
    { query: "打个滴滴去钟楼", expected: "inner_transportation" },
    { query: "手机声音太小了听不见", expected: "inner_system_settings" },
  ];

  let fusionOk = 0,
    naiveOk = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i]!;
    console.log(`\n[${i + 1}/${testCases.length}] "${tc.query}" (期望: ${tc.expected})`);

    const vec = await getEmbedding(tc.query);
    const result = classifier.classify(vec);

    // 单纯 Top-1
    let bestSim = 0,
      bestScene = "";
    for (const r of result.allResults) {
      const top = r.topMatches[0];
      if (top && top.similarity > bestSim) {
        bestSim = top.similarity;
        bestScene = top.scenario;
      }
    }

    const fOk = result.topScenario.scenario === tc.expected;
    const nOk = bestScene === tc.expected;
    if (fOk) fusionOk++;
    if (nOk) naiveOk++;

    const fMark = fOk ? "✓" : "✗";
    const nMark = nOk ? "✓" : "✗";
    console.log(
      `  融合: ${fMark} ${result.topScenario.scenario} (${(result.topScenario.score * 100).toFixed(1)}%, 置信度:${(result.confidence * 100).toFixed(0)}%) | 精确匹配: ${result.exactMatch ? "是" : "否"}`,
    );
    console.log(`  Top1: ${nMark} ${bestScene} (${(bestSim * 100).toFixed(1)}%)`);

    if (i < testCases.length - 1) await delay(DELAY_MS);
  }

  console.log(
    `\n融合算法: ${fusionOk}/${testCases.length} | 单纯Top1: ${naiveOk}/${testCases.length}`,
  );
}

// ========== 主入口 ==========
async function main(): Promise<void> {
  console.log("初始化分类器...");
  const classifier = new VectorClassifier(DB_PATH, { topK: 15 });
  console.log(`已加载 ${classifier.getScenarios().length} 个场景\n`);

  await testExactMatch(classifier);
  await testNewQueries(classifier);

  console.log("\n全部测试完成。");
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
