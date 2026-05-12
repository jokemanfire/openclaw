/**
 * 输入任意文本，在向量数据库中按余弦相似度查找 Top-5 最相似的测评问题
 *
 * 使用方式:
 *   echo "明天天气怎么样" | pnpm exec tsx search-similar.ts
 *   pnpm exec tsx search-similar.ts "帮我打个车"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_FILE = path.join(__dirname, "evaluation_questions.db");
const EMBEDDING_MODEL = "Qwen3-Embedding-8B";
const OPENAI_BASE_URL = "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const API_KEY = "eh4a5b25hsjjxredmp55oic664ulyvv6";

// ========== 获取查询文本 ==========
function getQueryText(): string {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.join(" ");

  // 从 stdin 读取（支持管道输入）
  try {
    const stdin = fs.readFileSync(0, "utf-8").trim();
    if (stdin) return stdin;
  } catch {
    // 忽略
  }

  console.error(
    '请提供查询文本:\n  pnpm exec tsx search-similar.ts "帮我打个车"\n  或\necho "明天天气" | pnpm exec tsx search-similar.ts',
  );
  process.exit(1);
}

// ========== 调用 Embedding API ==========
async function getEmbedding(text: string): Promise<number[]> {
  const url = `${OPENAI_BASE_URL}/embeddings`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_KEY.startsWith("Bearer ") ? API_KEY : `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: [text] }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${err}`);
  }

  const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return payload.data?.[0]?.embedding ?? [];
}

// ========== 余弦相似度 ==========
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ========== 主流程 ==========
async function main(): Promise<void> {
  const query = getQueryText();
  console.log(`查询: "${query}"\n`);

  // 1. 生成查询向量
  console.log("生成查询向量...");
  const queryVec = await getEmbedding(query);
  console.log(`维度: ${queryVec.length}\n`);

  // 2. 加载数据库中的所有向量
  const db = new DatabaseSync(DB_FILE);
  const rows = db
    .prepare("SELECT id, scenario, question, embedding FROM evaluation_questions")
    .all() as Array<{ id: string; scenario: string; question: string; embedding: string }>;
  db.close();

  // 3. 计算相似度
  const scored = rows.map((row) => {
    const emb: number[] = JSON.parse(row.embedding);
    const score = cosineSimilarity(queryVec, emb);
    return { id: row.id, scenario: row.scenario, question: row.question, score };
  });

  // 4. 排序取 Top-5
  scored.sort((a, b) => b.score - a.score);
  const top5 = scored.slice(0, 5);

  // 5. 输出
  console.log("Top-5 最相似的测评问题:\n");
  console.log(
    "┌──────┬────────────────────────────────────────────────────────────────────────────┬────────────────────────┬──────────┐",
  );
  console.log(
    "│ 排名 │ 测评问题                                                                   │ 场景                   │ 相似度   │",
  );
  console.log(
    "├──────┼────────────────────────────────────────────────────────────────────────────┼────────────────────────┼──────────┤",
  );
  for (let i = 0; i < top5.length; i++) {
    const r = top5[i]!;
    const q = r.question.length > 72 ? r.question.slice(0, 70) + "…" : r.question.padEnd(72);
    const s = r.scenario.padEnd(22);
    console.log(`│  ${i + 1}   │ ${q} │ ${s} │ ${(r.score * 100).toFixed(1).padStart(5)}% │`);
  }
  console.log(
    "└──────┴────────────────────────────────────────────────────────────────────────────┴────────────────────────┴──────────┘",
  );

  // 低于预期的提示
  if (top5[0]!.score < 0.3) {
    console.log(
      `\n⚠ 最高相似度仅 ${(top5[0]!.score * 100).toFixed(1)}%，数据库中可能没有与查询高度匹配的问题。`,
    );
  }
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});
