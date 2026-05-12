import * as path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * 新算法对照测试：优化后融合 vs 单纯 Top-1
 */
import { VectorClassifier } from "./vector-classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "evaluation_questions.db");

const BASE = "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const KEY = "Bearer eh4a5b25hsjjxredmp55oic664ulyvv6";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embed(text: string): Promise<number[]> {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(BASE + "/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: KEY },
        body: JSON.stringify({ model: "Qwen3-Embedding-8B", input: [text] }),
      });
      const raw = await r.text();
      if (r.status === 429 || raw.includes("Too many requests")) {
        await delay((a + 1) * 5000);
        continue;
      }
      return (JSON.parse(raw) as { data: Array<{ embedding: number[] }> }).data[0]!.embedding!;
    } catch {
      if (a < 4) await delay(3000);
    }
  }
  throw new Error("API fail");
}

const TESTS = [
  { q: "帮我录个音保存下来", expected: "inner_recorder" },
  { q: "今天适合出去玩吗", expected: "inner_weather" },
  { q: "我找不到手机了", expected: "inner_system_settings" },
  { q: "帮我生成一张海报图", expected: "artifact_image_gen" },
  { q: "播一首周杰伦的歌", expected: "inner_entertainment" },
  { q: "帮我把屏幕截图发给小王", expected: "inner_ztescreenshot" },
  { q: "打个滴滴去钟楼", expected: "inner_transportation" },
  { q: "手机声音太小了听不见", expected: "inner_system_settings" },
  { q: "今天适合穿什么衣服出门", expected: "inner_weather" },
  { q: "帮我记一下明天下午开会", expected: "inner_agenda" },
];

async function main() {
  const clf = new VectorClassifier(DB, { topK: 10 });
  console.log(`Top-K: 10 | 场景: ${clf.getScenarios().length} | 问题: 188\n`);

  // 打印期望命中数
  const sizes = clf.getScenarioSizes();
  for (const [s, sz] of [...sizes.entries()].sort((a, b) => a[1] - b[1])) {
    const exp = Math.max(1, Math.ceil((sz * 10) / 188));
    console.log(`  ${s}: ${sz}条 → 期望命中≥${exp}条`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("对照测试: 优化后融合算法 vs 单纯 Top-1");
  console.log("=".repeat(70));

  let fusionOk = 0,
    naiveOk = 0;

  for (let t = 0; t < TESTS.length; t++) {
    const tc = TESTS[t]!;
    const vec = await embed(tc.q);
    const result = clf.classify(vec);

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

    const fM = fOk ? "✓" : "✗",
      nM = nOk ? "✓" : "✗";
    console.log(`\n${t + 1}. "${tc.q}"`);
    console.log(`   期望: ${tc.expected}`);
    console.log(
      `   融合: ${fM} ${result.topScenario.scenario} (${(result.topScenario.score * 100).toFixed(1)}%, 置信度:${(result.confidence * 100).toFixed(0)}%)`,
    );
    console.log(`   Top1: ${nM} ${bestScene} (${(bestSim * 100).toFixed(1)}%)`);

    // 展示小场景的覆盖率
    if (result.topScenario.coverage > 0) {
      const sz = sizes.get(result.topScenario.scenario) ?? 0;
      console.log(
        `   明细: 加权${(result.topScenario.weightedVote * 100).toFixed(0)}% | 质心${(result.topScenario.centroidSim * 100).toFixed(0)}% | 覆盖${(result.topScenario.coverage * 100).toFixed(0)}% | 场景规模${sz}条`,
      );
    }

    if (t < TESTS.length - 1) await delay(4000);
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`融合: ${fusionOk}/${TESTS.length} | Top-1: ${naiveOk}/${TESTS.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
