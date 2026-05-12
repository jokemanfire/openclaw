/**
 * 将 用户query场景与skill映射.md 中的测评问题通过 embedding 存入 SQLite 数据库
 *
 * 参考 openclaw 的 embedding 方式:
 *   - 模型: text-embedding-3-small (OpenAI, 1536 维)
 *   - 存储: SQLite (node:sqlite)
 *   - 向量格式: JSON 字符串数组 (与 openclaw chunks 表一致)
 *
 * 使用方式:
 *   OPENAI_API_KEY=sk-xxx pnpm exec tsx embed-questions.ts
 *
 * 可选环境变量:
 *   OPENAI_BASE_URL  - 自定义 API 地址 (默认 https://api.openai.com/v1)
 *   EMBEDDING_MODEL   - 自定义模型 (默认 text-embedding-3-small)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== 配置 ==========
const MARKDOWN_FILE = path.join(__dirname, "..", "用户query场景与skill映射.md");
const DB_FILE = path.join(__dirname, "evaluation_questions.db");
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || "Qwen3-Embedding-8B";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const EMBEDDING_API_KEY = process.env.OPENAI_API_KEY?.trim() || "eh4a5b25hsjjxredmp55oic664ulyvv6";
const BATCH_SIZE = 50; // Qwen3-Embedding-8B 单次不要太大

// ========== 类型 ==========
interface Question {
  id: string;
  scenario: string;
  question: string;
}

// ========== 解析 Markdown 表格 ==========
function parseMarkdownTable(filePath: string): Question[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const questions: Question[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 匹配表格行: | 编号 | 场景 | 测评问题 |
    const match = trimmed.match(/^\|\s*(\S+)\s*\|\s*(\S+)\s*\|(.+?)\|\s*$/);
    if (!match) continue;

    const id = match[1]!.trim();
    const scenario = match[2]!.trim();
    const question = match[3]!.trim();

    // 跳过表头行和分隔行
    if (id === "编号" || id.startsWith("-")) continue;

    if (id && scenario && question) {
      questions.push({ id, scenario, question });
    }
  }

  return questions;
}

// ========== 调用 OpenAI Embedding API ==========
async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  const url = `${OPENAI_BASE_URL}/embeddings`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Embedding API 请求失败 (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return (payload.data ?? []).map((entry) => entry.embedding ?? []);
}

// ========== 初始化 SQLite 数据库 ==========
function initDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_questions (
      id TEXT PRIMARY KEY,
      scenario TEXT NOT NULL,
      question TEXT NOT NULL,
      embedding TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_evaluation_questions_scenario
    ON evaluation_questions(scenario);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ========== 获取 API Key ==========
function resolveApiKey(): string {
  // 优先使用环境变量，否则使用脚本内置的配置
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  return EMBEDDING_API_KEY;
}

// ========== 主流程 ==========
async function main(): Promise<void> {
  console.log("=== 测评问题 Embedding 入库脚本 ===\n");

  // 1. 解析 Markdown
  console.log(`[1/4] 解析 Markdown: ${path.basename(MARKDOWN_FILE)}`);
  const questions = parseMarkdownTable(MARKDOWN_FILE);
  console.log(`  解析到 ${questions.length} 条测评问题\n`);

  if (questions.length === 0) {
    console.error("错误: 未解析到任何测评问题，请检查 Markdown 文件格式。");
    process.exit(1);
  }

  // 打印各场景分布
  const scenarioCounts = new Map<string, number>();
  for (const q of questions) {
    scenarioCounts.set(q.scenario, (scenarioCounts.get(q.scenario) ?? 0) + 1);
  }
  console.log("  场景分布:");
  for (const [scenario, count] of [...scenarioCounts.entries()].sort()) {
    console.log(`    ${scenario}: ${count} 条`);
  }
  console.log();

  // 2. 获取 API Key
  console.log("[2/4] 获取 API Key...");
  const apiKey = resolveApiKey();
  console.log("  OK\n");

  // 3. 生成 Embedding
  console.log(`[3/4] 调用 ${EMBEDDING_MODEL} 生成 Embedding...`);
  const texts = questions.map((q) => q.question);

  const allEmbeddings: number[][] = [];
  const totalBatches = Math.ceil(texts.length / BATCH_SIZE);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`  批次 ${batchNum}/${totalBatches} (${batch.length} 条)...`);

    const embeddings = await embedBatch(batch, apiKey);
    allEmbeddings.push(...embeddings);

    console.log(`  完成，向量维度: ${embeddings[0]?.length ?? 0}`);
  }

  const dims = allEmbeddings[0]?.length ?? 0;
  console.log(`  共 ${allEmbeddings.length} 个向量，维度 ${dims}\n`);

  // 4. 存入 SQLite
  console.log(`[4/4] 写入 SQLite: ${path.basename(DB_FILE)}`);

  // 删除旧数据库
  if (fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
    console.log("  已删除旧数据库");
  }

  const db = new DatabaseSync(DB_FILE);
  initDatabase(db);

  const insertStmt = db.prepare(
    `INSERT INTO evaluation_questions (id, scenario, question, embedding, embedding_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();

  db.exec("BEGIN");
  try {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const emb = allEmbeddings[i];
      if (!emb || emb.length === 0) {
        console.warn(`  警告: ${q.id} embedding 为空，跳过`);
        continue;
      }
      insertStmt.run(q.id, q.scenario, q.question, JSON.stringify(emb), EMBEDDING_MODEL, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // 写入元数据
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run(
    "total_questions",
    String(questions.length),
  );
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run("embedding_model", EMBEDDING_MODEL);
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run(
    "embedding_dimensions",
    String(dims),
  );
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run(
    "created_at",
    new Date(now).toISOString(),
  );

  db.close();

  // 验证
  const verifyDb = new DatabaseSync(DB_FILE);
  const row = verifyDb.prepare("SELECT COUNT(*) as count FROM evaluation_questions").get() as {
    count: number;
  };
  verifyDb.close();

  const fileSizeKB = (fs.statSync(DB_FILE).size / 1024).toFixed(1);

  console.log(`\n=== 完成 ===`);
  console.log(`数据库: ${DB_FILE}`);
  console.log(`记录数: ${row.count} / ${questions.length}`);
  console.log(`模型:   ${EMBEDDING_MODEL}`);
  console.log(`维度:   ${dims}`);
  console.log(`大小:   ${fileSizeKB} KB`);
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});
