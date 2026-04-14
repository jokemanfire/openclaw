// ZTE_HGJ_MEMORY_BEGIN
import type { OpenClawConfig } from "../../config/config.js";
import { execShellCommand, type ExecShellCommandLogger } from "./execShellCommand.js";
import type { AiKnowledgeKeywordResult } from "./aiKnowledgeOpenclawRag.js";

export type AiKnowledgeMeetingQuery = {
  time?: string;
  persons?: string;
  title?: string;
  location?: string;
  isAbstract?: boolean;
  isFutureMeeting?: boolean;
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s.length > 0 ? s : null;
}

function extractJsonArrayText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const dataIdx = text.indexOf("data=");
  if (dataIdx >= 0) {
    const bracketStart = text.indexOf("[", dataIdx);
    if (bracketStart >= 0) {
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
    }
  }

  const start = text.indexOf("[");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
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
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

function normalizeKeywordResultsFromJsonArrayText(jsonArrayText: string): AiKnowledgeKeywordResult[] {
  let parsed: unknown;
  try {
    const maybeEscaped = jsonArrayText.includes('\\"') || jsonArrayText.includes("\\/");
    const normalized = maybeEscaped
      ? jsonArrayText
          .replaceAll('\\"', '"')
          .replaceAll("\\/", "/")
          .replaceAll("\\\\", "\\")
      : jsonArrayText;
    parsed = JSON.parse(normalized);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const results: AiKnowledgeKeywordResult[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const pathStr =
      toStringNonEmpty(obj.path ?? obj.uri ?? obj.url) ?? `aiknowledge://meeting/${String(i)}`;
    const startLine = Math.max(1, Math.floor(toNumber(obj.startLine ?? obj.start) ?? 1));
    const endLine = Math.max(startLine, Math.floor(toNumber(obj.endLine ?? obj.end) ?? startLine));
    const snippet =
      toStringNonEmpty(obj.snippet ?? obj.text ?? obj.content ?? obj.answer ?? obj.data) ??
      JSON.stringify(obj);
    const rawScore = toNumber(obj.textScore ?? obj.score ?? obj.relevance ?? obj.similarity);
    const textScore =
      rawScore == null
        ? clamp01(1 / (1 + i))
        : rawScore <= 1
          ? clamp01(rawScore)
          : clamp01(rawScore / (1 + rawScore));
    const id = toStringNonEmpty(obj.id) ?? `aik:${pathStr}:${String(startLine)}:${String(endLine)}`;
    results.push({
      id,
      path: pathStr,
      startLine,
      endLine,
      snippet,
      source: "memory",
      score: textScore,
      textScore,
      citation: undefined,
    });
  }
  return results;
}

function escapeExtraValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll('"', '\\"');
}

function buildDefaultCommand(params: {
  query: string;
  limit: number;
  meeting?: AiKnowledgeMeetingQuery;
}): string {
  const escapedQuery = escapeExtraValue(params.query);
  const parts: string[] = [
    `content call`,
    `--uri content://com.zte.ai.knowledge.provider`,
    `--method query_openclaw_meeting`,
    `--extra "query:s:${escapedQuery}"`,
    `--extra "limit:i:${String(Math.floor(params.limit))}"`,
  ];
  const m = params.meeting ?? {};
  if (typeof m.time === "string" && m.time.trim().length > 0) {
    parts.push(`--extra "meeting_time:s:${escapeExtraValue(m.time.trim())}"`);
  }
  if (typeof m.persons === "string" && m.persons.trim().length > 0) {
    parts.push(`--extra "meeting_persons:s:${escapeExtraValue(m.persons.trim())}"`);
  }
  if (typeof m.title === "string" && m.title.trim().length > 0) {
    parts.push(`--extra "meeting_title:s:${escapeExtraValue(m.title.trim())}"`);
  }
  if (typeof m.location === "string" && m.location.trim().length > 0) {
    parts.push(`--extra "meeting_location:s:${escapeExtraValue(m.location.trim())}"`);
  }
  if (typeof m.isAbstract === "boolean") {
    parts.push(`--extra "meeting_is_abstract:i:${m.isAbstract ? "1" : "0"}"`);
  }
  if (typeof m.isFutureMeeting === "boolean") {
    parts.push(`--extra "meeting_is_future:i:${m.isFutureMeeting ? "1" : "0"}"`);
  }
  return parts.join(" ");
}

export async function queryAiKnowledgeOpenClawMeetingAsKeywordResults(params: {
  cfg: OpenClawConfig;
  query: string;
  limit: number;
  meeting?: AiKnowledgeMeetingQuery;
  logger?: ExecShellCommandLogger;
}): Promise<AiKnowledgeKeywordResult[]> {
  const cleaned = params.query.trim();
  if (!cleaned) return [];

  const limit = Math.max(1, Math.floor(params.limit));
  const commandLine = buildDefaultCommand({ query: cleaned, limit, meeting: params.meeting });
  const outcome = await execShellCommand(commandLine, params.cfg, params.logger);
  params.logger?.info?.(
    `[aik-openclaw-meeting] exec_shell ok=${String(outcome.ok)} exit=${String(outcome.exitCode ?? "")} summary=${outcome.summary}`,
  );
  const outputPreview = (outcome.output ?? "").trim();
  params.logger?.info?.(
    `[aik-openclaw-meeting] outputLen=${String(outputPreview.length)} preview=${JSON.stringify(outputPreview.slice(0, 200))}`,
  );
  if (!outcome.ok) return [];
  const output = (outcome.output ?? "").trim();
  if (!output) return [];
  const jsonArrayText = extractJsonArrayText(output);
  if (!jsonArrayText) {
    params.logger?.info?.("[aik-openclaw-meeting] parse: no json array found in output");
    return [];
  }
  const results = normalizeKeywordResultsFromJsonArrayText(jsonArrayText);
  params.logger?.info?.(`[aik-openclaw-meeting] parsedResults=${String(results.length)}`);
  return results;
}
// ZTE_HGJ_MEMORY_END
