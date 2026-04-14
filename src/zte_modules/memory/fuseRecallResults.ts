// ZTE_HGJ_MEMORY_BEGIN
import type { ExecShellCommandLogger } from "./execShellCommand.js";
import { rerankOpenclawCandidatesByAiKnowledge } from "./aiKnowledgeRerankOpenclaw.js";
export type FuseableResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
};

function normalizeSnippetKey(snippet: string): string {
  // Normalize formatting differences across sources (e.g. "08:00–09:00去医院" vs "08:00-09:00 去医院")
  // so semantically identical events dedupe deterministically.
  let s = snippet.trim();
  s = s.replaceAll("：", ":");
  s = s.replace(/[\u2010-\u2015\u2212]/g, "-");
  s = s.replace(/\s+/g, "");
  return s;
}

export async function fuseRecallResults(params: {
  primary: FuseableResult[];
  secondary: FuseableResult[];
  maxResults: number;
  cfg?: any;
  query?: string;
  logger?: ExecShellCommandLogger;
}): Promise<FuseableResult[]> {
  const maxResults = Math.max(1, Math.floor(params.maxResults));

  // Keep insertion order as a stable tie-breaker.
  const combined: Array<{ item: FuseableResult; rank: number; isPrimary: boolean }> = [];
  let rank = 0;
  for (const item of params.primary) {
    combined.push({ item, rank, isPrimary: true });
    rank += 1;
  }
  for (const item of params.secondary) {
    combined.push({ item, rank, isPrimary: false });
    rank += 1;
  }

  const byKey = new Map<
    string,
    { item: FuseableResult; rank: number; isPrimary: boolean }
  >();

  for (const entry of combined) {
    const snippetKey = entry.item.snippet ? normalizeSnippetKey(entry.item.snippet) : "";
    const key =
      snippetKey.length > 0
        ? `snippet:${snippetKey}`
        : `loc:${entry.item.source}:${entry.item.path}:${entry.item.startLine}:${entry.item.endLine}`;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }

    // Conflict policy:
    // - Always prefer primary over secondary (scores may be on different scales).
    // - Otherwise, prefer higher score; then earlier insertion order.
    if (existing.isPrimary !== entry.isPrimary) {
      if (entry.isPrimary) {
        byKey.set(key, entry);
      }
      continue;
    }

    // Same side: prefer higher score; if tie, keep earlier.
    const scoreA = existing.item.score;
    const scoreB = entry.item.score;
    if (scoreB > scoreA) {
      byKey.set(key, entry);
    } else if (scoreB === scoreA) {
      if (entry.rank < existing.rank) {
        byKey.set(key, entry);
      }
    }
  }

  const deduped = Array.from(byKey.values());
  params.logger?.info?.(
    `[aik-fuse] primary=${params.primary.length} secondary=${params.secondary.length} combined=${combined.length} deduped=${deduped.length} max=${maxResults}`,
  );

  const canRerank =
    params.cfg &&
    typeof params.query === "string" &&
    params.query.trim().length > 0 &&
    params.logger;

  if (canRerank) {
    params.logger?.info?.(
      `[aik-fuse] rerank_openclaw enabled queryLen=${params.query!.trim().length} candidates=${deduped.length}`,
    );
    const texts = deduped.map((x) =>
      x.item.snippet && x.item.snippet.trim().length > 0
        ? x.item.snippet
        : `${x.item.path}:${x.item.startLine}-${x.item.endLine}`,
    );
    const clippedTexts = texts.map((t) => (t.length > 800 ? t.slice(0, 800) : t));
    const rerankOutcome = await rerankOpenclawCandidatesByAiKnowledge({
      cfg: params.cfg!,
      query: params.query!,
      texts: clippedTexts,
      logger: params.logger!,
    });
    const topPreview = rerankOutcome.scores
      .slice()
      .sort((a, b) => b - a)
      .slice(0, 3)
      .map((x) => Number(x).toFixed(6))
      .join(",");
    params.logger?.info?.(
      `[aik-fuse] rerank_openclaw done ok=${String(rerankOutcome.ok)} top3=[${topPreview}]`,
    );

    if (!rerankOutcome.ok) {
      params.logger?.info?.(`[aik-fuse] rerank_openclaw no-signal -> fallback to original score sort`);
    } else {
      const reranked = deduped.map((x, i) => ({
        ...x,
        rerankScore: rerankOutcome.scores[i] ?? 0,
      }));
      reranked.sort((a, b) => {
        if (b.rerankScore !== a.rerankScore) {
          return b.rerankScore - a.rerankScore;
        }
        if (a.isPrimary !== b.isPrimary) {
          return a.isPrimary ? -1 : 1;
        }
        return a.rank - b.rank;
      });

      return reranked.slice(0, maxResults).map((x) => ({
        ...x.item,
        score: x.rerankScore,
      }));
    }

  }

  deduped.sort((a, b) => {
    if (b.item.score !== a.item.score) {
      return b.item.score - a.item.score;
    }
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary ? -1 : 1;
    }
    return a.rank - b.rank;
  });

  return deduped.slice(0, maxResults).map((x) => x.item);
}
// ZTE_HGJ_MEMORY_END