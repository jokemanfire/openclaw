import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VectorClassifier } from "./vector-classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "evaluation_questions.db");
const clf = new VectorClassifier(DB);

const BASE = "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const KEY = "Bearer eh4a5b25hsjjxredmp55oic664ulyvv6";

async function embed(text: string) {
  const r = await fetch(BASE + "/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY },
    body: JSON.stringify({ model: "Qwen3-Embedding-8B", input: [text] }),
  });
  const p = (await r.json()) as { data: Array<{ embedding: number[] }> };
  return p.data[0]!.embedding!;
}

// 数据库真实文本
const tests = [
  { scenario: "inner_weather", text: "今天天气怎么样" },
  { scenario: "inner_call", text: "用卡一拨打10086" },
  { scenario: "inner_cast", text: "帮我投屏" },
  { scenario: "inner_ztescreenshot", text: "截图" },
  { scenario: "inner_transportation", text: "帮我打车去西安北站" },
  { scenario: "inner_recorder", text: "开始录音" },
  { scenario: "inner_alarm", text: "添加一个明天早上8点的闹钟，起床" },
  { scenario: "artifact_image_gen", text: "帮我画一只在草地上玩耍的可爱小狗" },
];

async function main() {
  console.log("精确匹配测试 — 使用数据库真实文本\n");

  let ok = 0;
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i]!;
    const vec = await embed(t.text);
    const result = clf.classify(vec);
    const pass = result.exactMatch && result.topScenario.scenario === t.scenario;
    const mark = pass ? "✓" : "✗";
    console.log(
      `${i + 1}. ${mark} "${t.text}" → ${result.topScenario.scenario} | 精确命中: ${result.exactMatch ? "是" : "否"} | 置信度: ${(result.confidence * 100).toFixed(0)}%`,
    );
    if (pass) ok++;
    if (i < tests.length - 1) await new Promise((r) => setTimeout(r, 4000));
  }

  console.log(
    `\n精确匹配准确率: ${ok}/${tests.length} = ${((ok / tests.length) * 100).toFixed(0)}%`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
