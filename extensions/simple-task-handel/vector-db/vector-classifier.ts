/**
 * 向量场景分类器 — 多策略融合算法
 *
 * ## 算法思路
 *
 *   不只看 Top-1，而是综合 Top-10 里每个场景的「整体表现」，
 *   用三个独立信号打分后融合。这样单条碰巧高分不会主导结果。
 *
 * ## 三个信号
 *
 *   信号 1 — 加权投票（45%）
 *     前 10 条按位置倒数平方根衰减权重，按场景聚合。
 *     所有场景共用同一分母做归一化，不作为样本量大小区别对待。
 *
 *   信号 2 — 质心相似度（30%）
 *     查询向量与每个场景所有问题向量的归一化质心做余弦相似度。
 *     衡量「跟这个场景的典型语义有多像」。
 *
 *   信号 3 — 覆盖率（25%）
 *     某场景在 Top-10 中出现了几条 / 按比例期望出现几条。
 *     小场景（如 inner_cast 仅 2 条）只要命中 1 条就远超期望，
 *     覆盖率得满分；大场景需要命中多条才能拿到同等分数。
 *
 * ## 分类决策
 *
 *   - 任意一条相似度 ≥ 95% → 精确命中，直接锁定场景，不走融合
 *   - 否则走三信号融合，取综合得分最高的场景
 *   - 置信度 = (top1 - top2) / top1 × 3，差距越大越可信
 */

import { DatabaseSync } from "node:sqlite";
import type { SkillCategory, ClassifyResult } from "../keyword-classifier.ts";

// ========== 类型 ==========

export interface QuestionRow {
  id: string;
  scenario: string;
  question: string;
  embedding: string;
}

export interface QuestionVec {
  id: string;
  scenario: string;
  question: string;
  vector: number[];
}

export interface ScoredMatch {
  id: string;
  scenario: string;
  question: string;
  similarity: number;
}

export interface ScenarioResult {
  scenario: string;
  score: number;
  weightedVote: number;
  centroidSim: number;
  coverage: number;
  topMatches: ScoredMatch[];
}

export interface VectorClassifyResult {
  topScenario: ScenarioResult;
  confidence: number;
  allResults: ScenarioResult[];
  exactMatch: boolean;
  exactMatchId?: string;
}

// ========== 向量运算 ==========

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

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

// ========== 位置权重 ==========

/** 倒数平方根衰减: rank1→1.0, rank5→0.45, rank10→0.32 */
function positionWeight(rank: number): number {
  return 1 / Math.sqrt(rank);
}

// ========== 分类器 ==========

const DEFAULT_OPTIONS = {
  topK: 10,
  weights: { vote: 0.45, centroid: 0.3, coverage: 0.25 },
} as const;

export class VectorClassifier {
  private questions: QuestionVec[];
  private centroids: Map<string, number[]>;
  private scenarioSizes: Map<string, number>;
  private totalCount: number;
  private topK: number;
  private weights: { vote: number; centroid: number; coverage: number };

  /** 各场景的加权投票归一化分母：该场景最多能在 Top-K 中占据前 N 位 */
  private scenarioMaxWeight: Map<string, number>;

  /** 各场景在 Top-K 中的期望命中数（向上取整），用于覆盖率计算 */
  private expectedHits: Map<string, number>;

  constructor(
    dbPath: string,
    options?: { topK?: number; weights?: { vote: number; centroid: number; coverage: number } },
  ) {
    this.topK = options?.topK ?? DEFAULT_OPTIONS.topK;
    this.weights = options?.weights ?? { ...DEFAULT_OPTIONS.weights };

    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare("SELECT id, scenario, question, embedding FROM evaluation_questions")
      .all() as QuestionRow[];
    db.close();

    this.questions = rows.map((r) => ({
      id: r.id,
      scenario: r.scenario,
      question: r.question,
      vector: JSON.parse(r.embedding) as number[],
    }));

    this.totalCount = this.questions.length;
    this.scenarioSizes = new Map<string, number>();
    for (const q of this.questions) {
      this.scenarioSizes.set(q.scenario, (this.scenarioSizes.get(q.scenario) ?? 0) + 1);
    }

    this.centroids = this.buildCentroids();

    // 预计算每个场景的加权投票归一化分母
    // 小场景（如仅 2 条）分母小 → 同样排名的得分更高，自然平衡样本不均衡
    this.scenarioMaxWeight = new Map<string, number>();
    for (const [scenario, size] of this.scenarioSizes) {
      let total = 0;
      const n = Math.min(size, this.topK);
      for (let i = 0; i < n; i++) total += positionWeight(i + 1);
      this.scenarioMaxWeight.set(scenario, total);
    }

    // 预计算各场景期望命中数: ceil(size * K / total)
    // 小场景期望低 → 实际命中容易超过期望 → 覆盖率得分高
    this.expectedHits = new Map<string, number>();
    for (const [scenario, size] of this.scenarioSizes) {
      this.expectedHits.set(scenario, Math.max(1, Math.ceil((size * this.topK) / this.totalCount)));
    }
  }

  // ── 预计算场景质心 ──
  private buildCentroids(): Map<string, number[]> {
    const byScenario = new Map<string, QuestionVec[]>();
    for (const q of this.questions) {
      const list = byScenario.get(q.scenario) ?? [];
      list.push(q);
      byScenario.set(q.scenario, list);
    }

    const centroids = new Map<string, number[]>();
    for (const [scenario, qs] of byScenario) {
      const dim = qs[0]!.vector.length;
      let sum = new Array(dim).fill(0) as number[];
      for (const q of qs) sum = sum.map((v, i) => v + q.vector[i]!);
      centroids.set(scenario, normalize(sum.map((v) => v / qs.length)));
    }
    return centroids;
  }

  // ── 精确匹配阈值 ──
  private static readonly EXACT_MATCH_THRESHOLD = 0.95;

  // ── 主分类入口 ──
  classify(queryVec: number[], debug?: (msg: string) => void): VectorClassifyResult {
    // 1. 全量相似度计算 + 排序
    debug?.("[vector-classifier] classify: computing similarity against all questions");
    const allMatches: ScoredMatch[] = this.questions.map((q) => ({
      id: q.id,
      scenario: q.scenario,
      question: q.question,
      similarity: cosineSimilarity(queryVec, q.vector),
    }));
    allMatches.sort((a, b) => b.similarity - a.similarity);

    // ── 快速通道: 任意一条相似度 ≥ 95%，直接锁定 ──
    const topMatch = allMatches[0]!;
    const top3 = allMatches
      .slice(0, 3)
      .map((m) => `${m.scenario}(${(m.similarity * 100).toFixed(1)}%)`)
      .join(", ");
    debug?.(`[vector-classifier] classify: top3 similarity → ${top3}`);

    if (topMatch.similarity >= VectorClassifier.EXACT_MATCH_THRESHOLD) {
      debug?.(
        `[vector-classifier] classify: exact match! id=${topMatch.id} scenario=${topMatch.scenario} similarity=${(topMatch.similarity * 100).toFixed(1)}%`,
      );
      return this.buildExactMatchResult(topMatch, allMatches, debug);
    }

    // ── 非精确匹配: 走三信号融合 ──
    debug?.("[vector-classifier] classify: no exact match, running fusion algorithm");
    return this.buildFusionResult(queryVec, allMatches, debug);
  }

  // ── 精确命中 ──
  private buildExactMatchResult(
    topMatch: ScoredMatch,
    allMatches: ScoredMatch[],
    debug?: (msg: string) => void,
  ): VectorClassifyResult {
    const exactResult: ScenarioResult = {
      scenario: topMatch.scenario,
      score: 1.0,
      weightedVote: 1.0,
      centroidSim: 1.0,
      coverage: 1.0,
      topMatches: [topMatch],
    };

    const otherScenarios = [...this.centroids.keys()].filter((s) => s !== topMatch.scenario);
    const allResults: ScenarioResult[] = [
      exactResult,
      ...otherScenarios.map((scenario) => ({
        scenario,
        score: 0,
        weightedVote: 0,
        centroidSim: 0,
        coverage: 0,
        topMatches: allMatches.filter((m) => m.scenario === scenario).slice(0, 3),
      })),
    ];

    debug?.("[vector-classifier] buildExactMatchResult: confidence=1.0 exactMatch=true");
    return {
      topScenario: exactResult,
      confidence: 1.0,
      allResults,
      exactMatch: true,
      exactMatchId: topMatch.id,
    };
  }

  // ── 融合算法 ──
  private buildFusionResult(
    queryVec: number[],
    allMatches: ScoredMatch[],
    debug?: (msg: string) => void,
  ): VectorClassifyResult {
    const topKMatches = allMatches.slice(0, this.topK);

    // 对每个场景计算三个信号
    const scenarios = [...this.centroids.keys()];
    const results: ScenarioResult[] = scenarios.map((scenario) => {
      // 信号1: Top-K 加权投票（统一分母归一化）
      let weightedVote = 0;
      const scenarioTopMatches: ScoredMatch[] = [];
      for (let i = 0; i < topKMatches.length; i++) {
        const m = topKMatches[i]!;
        if (m.scenario === scenario) {
          weightedVote += m.similarity * positionWeight(i + 1);
          scenarioTopMatches.push(m);
        }
      }
      const maxWeight = this.scenarioMaxWeight.get(scenario) ?? 1;
      const normalizedVote = maxWeight > 0 ? weightedVote / maxWeight : 0;

      // 信号2: 质心相似度
      const centroid = this.centroids.get(scenario)!;
      const centroidSim = Math.max(0, cosineSimilarity(queryVec, centroid));

      // 信号3: 覆盖率 = min(1, 实际命中 / 期望命中)
      // 小场景期望低 → 少量命中就能拿高分
      const expected = this.expectedHits.get(scenario) ?? 1;
      const coverage = Math.min(1, scenarioTopMatches.length / expected);

      // 融合
      const score =
        this.weights.vote * normalizedVote +
        this.weights.centroid * centroidSim +
        this.weights.coverage * coverage;

      return {
        scenario,
        score: Math.min(1, score),
        weightedVote: normalizedVote,
        centroidSim,
        coverage,
        topMatches: scenarioTopMatches,
      };
    });

    results.sort((a, b) => b.score - a.score);

    // 置信度
    const topScore = results[0]!.score;
    const secondScore = results[1]?.score ?? 0;
    const margin = topScore - secondScore;
    const relativeMargin = topScore > 0 ? margin / topScore : 0;
    const confidence = Math.min(1, relativeMargin * 3);

    const topSimilarities = results[0]!.topMatches
      .map((m) => `${(m.similarity * 100).toFixed(1)}%`)
      .join(", ");
    debug?.(
      `[vector-classifier] buildFusionResult: top=${results[0]!.scenario} score=${(topScore * 100).toFixed(1)}% ` +
        `vote=${(results[0]!.weightedVote * 100).toFixed(1)}% centroid=${(results[0]!.centroidSim * 100).toFixed(1)}% coverage=${(results[0]!.coverage * 100).toFixed(1)}% ` +
        `similarities=[${topSimilarities}]`,
    );
    debug?.(
      `[vector-classifier] buildFusionResult: runner-up=${results[1]?.scenario ?? "none"} score=${(secondScore * 100).toFixed(1)}% margin=${(margin * 100).toFixed(1)}% confidence=${(confidence * 100).toFixed(1)}%`,
    );

    return {
      topScenario: results[0]!,
      confidence,
      allResults: results,
      exactMatch: false,
    };
  }

  /** 获取场景列表 */
  getScenarios(): string[] {
    return [...this.centroids.keys()];
  }

  /** 获取各场景的问题数量 */
  getScenarioSizes(): Map<string, number> {
    return new Map(this.scenarioSizes);
  }
}

// ========== 格式化输出 ==========

export function printClassifyResult(
  query: string,
  result: VectorClassifyResult,
  showTopN = 5,
): void {
  console.log(`\n查询: "${query}"\n`);

  if (result.exactMatch) {
    console.log(`🎯 精确命中! ID: ${result.exactMatchId}`);
    console.log(`最佳场景: ${result.topScenario.scenario}  (置信度: 100.0%)`);
  } else {
    const r = result.topScenario;
    console.log(`最佳场景: ${r.scenario}  (置信度: ${(result.confidence * 100).toFixed(1)}%)`);
    console.log(
      `综合: ${(r.score * 100).toFixed(1)}%  |  加权投票: ${(r.weightedVote * 100).toFixed(1)}%  |  质心相似: ${(r.centroidSim * 100).toFixed(1)}%  |  覆盖率: ${(r.coverage * 100).toFixed(1)}%`,
    );
  }

  console.log(`\nTop-${showTopN} 场景排名:\n`);
  console.log(
    "┌──────┬────────────────────────┬──────────┬──────────┬──────────────┬─────────────┬──────────┐",
  );
  console.log(
    "│ 排名 │ 场景                   │ 综合得分 │ 置信度   │ 加权投票     │ 质心相似度  │ 覆盖率   │",
  );
  console.log(
    "├──────┼────────────────────────┼──────────┼──────────┼──────────────┼─────────────┼──────────┤",
  );

  const topN = result.allResults.slice(0, showTopN);
  for (let i = 0; i < topN.length; i++) {
    const r = topN[i]!;
    const marker = i === 0 ? " ★" : "  ";
    console.log(
      `│  ${i + 1}${marker} │ ${r.scenario.padEnd(22)} │ ${(r.score * 100).toFixed(1).padStart(5)}%  │ ${(result.confidence * 100).toFixed(1).padStart(5)}%   │ ${(r.weightedVote * 100).toFixed(1).padStart(7)}%   │ ${(r.centroidSim * 100).toFixed(1).padStart(7)}%   │ ${(r.coverage * 100).toFixed(1).padStart(5)}%  │`,
    );
  }
  console.log(
    "└──────┴────────────────────────┴──────────┴──────────┴──────────────┴─────────────┴──────────┘",
  );

  // 最佳场景的 Top 匹配
  console.log(
    `\n"${result.topScenario.scenario}" 场景在 Top-${Math.min(10, result.topScenario.topMatches.length)} 中的匹配:`,
  );
  for (let i = 0; i < Math.min(result.topScenario.topMatches.length, 5); i++) {
    const m = result.topScenario.topMatches[i]!;
    const q = m.question.length > 55 ? m.question.slice(0, 53) + "…" : m.question;
    console.log(`  ${i + 1}. [${(m.similarity * 100).toFixed(1)}%] ${q}`);
  }
}

// ========== Embedding 客户端 & 文本分类 ==========

const SCENARIO_SKILL_MAP: Record<string, { label: string; skillName: string }> = {
  inner_weather: { label: "天气查询", skillName: "inner-weather" },
  inner_transportation: { label: "交通出行", skillName: "inner-transportation-linux" },
  inner_system_settings: { label: "系统设置", skillName: "inner-system-settings" },
  inner_recorder: { label: "录音", skillName: "inner-recorder" },
  inner_message: { label: "短信消息", skillName: "inner-message" },
  inner_entertainment: { label: "影音娱乐", skillName: "inner-entertainment" },
  inner_cast: { label: "投屏", skillName: "inner-cast" },
  inner_call: { label: "通话电话", skillName: "inner-call" },
  inner_agenda: { label: "日程提醒", skillName: "inner-calendar" },
  inner_alarm: { label: "闹钟时钟", skillName: "inner-alarm" },
  inner_ztescreenshot: { label: "截屏", skillName: "inner-screenshot" },
  artifact_image_gen: { label: "图片生成", skillName: "artifact-image-gen" },
  inner_ask_user: { label: "通用助手", skillName: "inner-ask-user" },
};

const EMBEDDING_BASE_URL =
  process.env.EMBEDDING_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://maas-apigateway.dt.zte.com.cn/model/qwen3-embedding-8b/v1";
const EMBEDDING_API_KEY =
  process.env.EMBEDDING_API_KEY?.trim() || "eh4a5b25hsjjxredmp55oic664ulyvv6";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || "Qwen3-Embedding-8B";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function getEmbedding(text: string, debug?: (msg: string) => void): Promise<number[]> {
  const url = `${EMBEDDING_BASE_URL}/embeddings`;
  let lastError: unknown;

  debug?.(`[vector-classifier] getEmbedding: text="${text.slice(0, 80)}" model=${EMBEDDING_MODEL}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: EMBEDDING_API_KEY.startsWith("Bearer ")
            ? EMBEDDING_API_KEY
            : `Bearer ${EMBEDDING_API_KEY}`,
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: [text] }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        if (resp.status === 429 || errText.includes("Too many requests")) {
          debug?.(
            `[vector-classifier] getEmbedding rate limited, retrying in ${(attempt + 1) * 3}s`,
          );
          await delay((attempt + 1) * 3000);
          continue;
        }
        throw new Error(`Embedding API error (${resp.status}): ${errText}`);
      }

      const payload = (await resp.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const vec = payload.data?.[0]?.embedding ?? [];
      debug?.(`[vector-classifier] getEmbedding success, dims=${vec.length}`);
      return vec;
    } catch (err) {
      lastError = err;
      debug?.(`[vector-classifier] getEmbedding attempt ${attempt + 1} failed: ${String(err)}`);
      if (attempt < 2) await delay(2000);
    }
  }
  throw lastError;
}

const VECTOR_CONFIDENCE_THRESHOLD = 0.3;

export async function classifyByText(
  query: string,
  classifier: VectorClassifier,
  options?: { debug?: (msg: string) => void },
): Promise<ClassifyResult> {
  const debug = options?.debug;
  const empty: ClassifyResult = {
    category: null,
    label: "",
    skillName: "",
    score: 0,
    scores: {},
    matched: false,
  };

  const trimmed = query.trim();
  if (!trimmed) return empty;

  debug?.(`[vector-classifier] classifyByText: query="${trimmed.slice(0, 80)}"`);
  const queryVec = await getEmbedding(trimmed, debug);
  const result = classifier.classify(queryVec, debug);

  debug?.(
    `[vector-classifier] classifyByText: topScenario=${result.topScenario.scenario} confidence=${(result.confidence * 100).toFixed(1)}% exactMatch=${result.exactMatch}`,
  );

  const scores: Record<string, number> = {};
  for (const r of result.allResults) {
    scores[r.scenario] = r.score;
  }

  const topScenario = result.topScenario.scenario;
  const mapping = SCENARIO_SKILL_MAP[topScenario];

  if (!mapping || result.confidence < VECTOR_CONFIDENCE_THRESHOLD) {
    debug?.(
      `[vector-classifier] classifyByText: unmatched (mapping=${!!mapping} confidence=${(result.confidence * 100).toFixed(1)}% < ${(VECTOR_CONFIDENCE_THRESHOLD * 100).toFixed(0)}%)`,
    );
    return { ...empty, scores };
  }

  debug?.(
    `[vector-classifier] classifyByText: matched category=${topScenario} label="${mapping.label}" skillName="${mapping.skillName}" score=${result.topScenario.score.toFixed(3)}`,
  );
  return {
    category: topScenario as SkillCategory,
    label: mapping.label,
    skillName: mapping.skillName,
    score: result.topScenario.score,
    scores,
    matched: true,
  };
}
