/** 诊断：检查相同文本两次调用 API 得到的向量是否完全一致 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const KEY = "Bearer eh4a5b25hsjjxredmp55oic664ulyvv6";

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(texts: string[]) {
  const r = await fetch(BASE + "/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY },
    body: JSON.stringify({ model: "Qwen3-Embedding-8B", input: texts }),
  });
  const p = (await r.json()) as { data: Array<{ embedding: number[] }> };
  return p.data.map((d) => d.embedding);
}

async function main() {
  const text = "我想去外面跑步，现在的空气适合晨练吗？";

  // 两次独立调用
  console.log("测试: 相同文本两次独立 API 调用的向量一致性\n");
  console.log(`文本: "${text}"\n`);

  const [v1] = await embed([text]);
  console.log(
    `第1次调用 — 前5维: [${v1!
      .slice(0, 5)
      .map((x) => x.toFixed(6))
      .join(", ")}]`,
  );

  await new Promise((r) => setTimeout(r, 3000));

  const [v2] = await embed([text]);
  console.log(
    `第2次调用 — 前5维: [${v2!
      .slice(0, 5)
      .map((x) => x.toFixed(6))
      .join(", ")}]`,
  );

  const sim = cosineSim(v1!, v2!);
  console.log(`\n两次调用向量的余弦相似度: ${sim.toFixed(10)}`);
  console.log(`是否完全一致: ${sim >= 0.99999999 ? "是" : "否 (存在浮点差异)"}`);

  // 检查逐元素差异
  let maxDiff = 0;
  for (let i = 0; i < v1!.length; i++) {
    const diff = Math.abs(v1![i]! - v2![i]!);
    if (diff > maxDiff) maxDiff = diff;
  }
  console.log(`最大逐元素差异: ${maxDiff.toFixed(10)}`);

  // 对比: 读DB中存储的向量
  console.log("\n---");
  console.log("对比: 数据库存储的向量 vs API 返回的向量\n");

  import("node:sqlite").then(async (sqlite) => {
    const db = new sqlite.DatabaseSync(path.join(__dirname, "evaluation_questions.db"));
    const row = db
      .prepare("SELECT id, scenario, embedding FROM evaluation_questions WHERE question = ?")
      .get(text) as { id: string; scenario: string; embedding: string } | undefined;
    db.close();

    if (row) {
      const dbVec: number[] = JSON.parse(row.embedding);
      const dbSim = cosineSim(v1!, dbVec);
      console.log(`DB向量 vs 第1次API向量: ${dbSim.toFixed(10)}`);
      console.log(`DB向量 vs 第2次API向量: ${dbSim.toFixed(10)}`);

      let dbMaxDiff = 0;
      for (let i = 0; i < v1!.length; i++) {
        const diff = Math.abs(v1![i]! - dbVec[i]!);
        if (diff > dbMaxDiff) dbMaxDiff = diff;
      }
      console.log(`DB vs API 最大逐元素差异: ${dbMaxDiff.toFixed(10)}`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
