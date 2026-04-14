// ZTE_HGJ_MEMORY_BEGIN
import { execShellCommand, type ExecShellCommandLogger } from "./execShellCommand.js";

type RerankPair = { index: number; score: number };

function escapeForDoubleQuotedExtraValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeForSingleQuotedShell(value: string): string {
  // POSIX shell: to embed a single quote inside single-quoted string, close-open with '\''.
  return value.replaceAll("'", `'\\''`);
}

function extractJsonArrayText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const dataIdx = text.indexOf("data=");
  const startFrom = dataIdx >= 0 ? dataIdx : 0;
  const bracketStart = text.indexOf("[", startFrom);
  if (bracketStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = bracketStart; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(bracketStart, i + 1);
      }
    }
  }
  return null;
}

function parseRerankPairsFromContentCallOutput(rawOutput: string): RerankPair[] {
  const jsonArrayText = extractJsonArrayText(rawOutput);
  if (!jsonArrayText) return [];

  const maybeEscaped = jsonArrayText.includes('\\"') || jsonArrayText.includes("\\/");
  const normalized = maybeEscaped
    ? jsonArrayText.replaceAll('\\"', '"').replaceAll("\\/", "/").replaceAll("\\\\", "\\")
    : jsonArrayText;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RerankPair[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const idx = Number((item as any).index);
      const score = Number((item as any).score);
      if (Number.isFinite(idx) && Number.isFinite(score)) {
        out.push({ index: idx, score });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function rerankOpenclawCandidatesByAiKnowledge(params: {
  cfg: any;
  query: string;
  texts: string[];
  logger: ExecShellCommandLogger;
}): Promise<{ ok: boolean; scores: number[] }> {
  const query = params.query?.trim() ?? "";
  if (!query || params.texts.length === 0) {
    return { ok: false, scores: new Array(params.texts.length).fill(0) };
  }

  params.logger?.info?.(
    `[aik-rerank-openclaw] start queryLen=${query.length} texts=${params.texts.length}`,
  );

  // Android `content` CLI parses --extra as a single token: "key:type:value" and splits on ':'.
  // If value contains ':' (e.g. time "10:00"), the CLI may print usage and not call the provider.
  // The CLI supports escaping ':' with backslash (it will be unescaped before reaching the provider),
  // so we protect JSON payloads by rewriting ":" -> "\:" at the command-line layer.
  const bindSafeQuery = query.replaceAll(":", "\\:");
  const bindSafeTextsJson = JSON.stringify(params.texts).replaceAll(":", "\\:");

  // Use single-quoted --extra values to avoid argument splitting when values contain spaces.
  const escapedQuery = escapeForSingleQuotedShell(bindSafeQuery);
  const escapedTextsJson = escapeForSingleQuotedShell(bindSafeTextsJson);
  const buildCmd = (method: string) =>
    [
      `content call`,
      `--uri content://com.zte.ai.knowledge.provider`,
      `--method ${method}`,
      `--extra 'query:s:${escapedQuery}'`,
      `--extra 'texts_json:s:${escapedTextsJson}'`,
    ].join(" ");

  let outputText = "";
  let pairs: RerankPair[] = [];
  let ok = false;

  const tryOnce = async (method: string) => {
    const outcome = await execShellCommand(buildCmd(method), params.cfg, params.logger);
    if (!outcome.ok) {
      params.logger?.info?.(
        `[aik-rerank-openclaw] exec_shell failed method=${method} summary=${outcome.summary}`,
      );
      return false;
    }
    outputText = outcome.output ?? "";
    pairs = parseRerankPairsFromContentCallOutput(outputText);
    params.logger?.info?.(
      `[aik-rerank-openclaw] method=${method} parsedPairs=${pairs.length} outputLen=${outputText.length} preview=${JSON.stringify(outputText.slice(0, 160))}`,
    );
    return pairs.length > 0;
  };

  ok = await tryOnce("rerank_openclaw");
  if (!ok) {
    params.logger?.info?.(
      `[aik-rerank-openclaw] retry with method=query_openclaw_rerank (fallback)`,
    );
    ok = await tryOnce("query_openclaw_rerank");
  }

  const scores = new Array(params.texts.length).fill(0);
  for (const p of pairs) {
    if (p.index >= 0 && p.index < scores.length) {
      scores[p.index] = p.score;
    }
  }
  // If model returns all-zeros, treat as failure so caller can fallback to original scores.
  const hasSignal = scores.some((x) => Number.isFinite(x) && x !== 0);
  const finalOk = ok && hasSignal;
  if (!finalOk) {
    params.logger?.info?.(`[aik-rerank-openclaw] no valid rerank signal, fallback`);
  }
  return { ok: finalOk, scores };
}
// ZTE_HGJ_MEMORY_END