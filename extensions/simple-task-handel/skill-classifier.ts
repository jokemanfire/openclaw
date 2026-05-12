/**
 * Skill 场景分类器 — 统一上层接口
 *
 * 支持两种分类方式：
 *   - keyword: 基于关键词权重匹配（默认）
 *   - vector:  基于向量相似度匹配（多策略融合算法）
 *
 * 切换方式（优先级从高到低）：
 *   1. classifySkill(query, { method: "vector" })  函数参数
 *   2. SKILL_CLASSIFY_METHOD=vector 环境变量
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifySkill as classifyByKeyword,
  batchClassify,
  DIRECT_RESPONSE_MAP,
  extractMessageBody,
  normalizeInput,
  matchDirectResponse,
} from "./keyword-classifier.ts";
import type { SkillCategory, ClassifyResult } from "./keyword-classifier.ts";
import { VectorClassifier, classifyByText } from "./vector-db/vector-classifier.ts";

export type ClassifyMethod = "keyword" | "vector";

// ── 向量分类器懒初始化 ──

let _vectorClassifier: VectorClassifier | null = null;

function resolveVectorDbPath(): string {
  const envPath = process.env.VECTOR_DB_PATH?.trim();
  if (envPath) return envPath;

  const candidates = [
    path.join(import.meta.dirname, "vector-db", "evaluation_questions.db"),
    path.join(
      process.cwd(),
      "extensions",
      "simple-task-handel",
      "vector-db",
      "evaluation_questions.db",
    ),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return candidates[0]!;
}

function getVectorClassifier(debug?: (msg: string) => void): VectorClassifier {
  if (!_vectorClassifier) {
    const dbPath = resolveVectorDbPath();
    debug?.(`[skill-classifier] initializing VectorClassifier, dbPath="${dbPath}"`);
    if (!fs.existsSync(dbPath)) {
      const msg = `Vector DB not found at "${dbPath}". Set VECTOR_DB_PATH env or ensure evaluation_questions.db exists.`;
      debug?.(`[skill-classifier] ${msg}`);
      throw new Error(msg);
    }
    _vectorClassifier = new VectorClassifier(dbPath);
  }
  return _vectorClassifier;
}

// ── 主分类入口 ──

function resolveMethod(options?: { method?: ClassifyMethod }): ClassifyMethod {
  if (options?.method) return options.method;
  if (process.env.SKILL_CLASSIFY_METHOD === "keyword") return "keyword";
  return "vector";
}

export async function classifySkill(
  query: string,
  options?: { method?: ClassifyMethod; threshold?: number; debug?: (msg: string) => void },
): Promise<ClassifyResult> {
  const method = resolveMethod(options);
  const debug = options?.debug;

  if (method === "vector") {
    debug?.("[skill-classifier] using vector method");
    try {
      const result = await classifyByText(query, getVectorClassifier(debug), { debug });
      debug?.(
        `[skill-classifier] vector result: category=${result.category} label="${result.label}" skillName="${result.skillName}" score=${result.score.toFixed(3)} matched=${result.matched}`,
      );
      return result;
    } catch (err) {
      debug?.(`[skill-classifier] vector classify failed, falling back to keyword: ${String(err)}`);
    }
  }

  debug?.("[skill-classifier] using keyword method");
  const kwResult = classifyByKeyword(query, options?.threshold);
  debug?.(
    `[skill-classifier] keyword result: category=${kwResult.category} label="${kwResult.label}" score=${kwResult.score.toFixed(3)} matched=${kwResult.matched}`,
  );
  return kwResult;
}

// ── 重新导出 ──

export {
  classifyByKeyword,
  batchClassify,
  DIRECT_RESPONSE_MAP,
  extractMessageBody,
  normalizeInput,
  matchDirectResponse,
};
export type { SkillCategory, ClassifyResult };
