import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (Record<string, unknown> & { corpus: "memory"; score: number; path: string })
  | MemoryCorpusSearchResult;

function sortMemorySearchToolResults<T extends { score: number; path: string }>(results: T[]): T[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = sortMemorySearchToolResults(params.memoryResults);
  const supplementResults = sortMemorySearchToolResults(params.supplementResults);
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return sortMemorySearchToolResults([...memoryResults, ...supplementResults]).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selectedSupplements = supplementResults.slice(0, perCorpusCap);
  const selected = [...selectedMemory, ...selectedSupplements];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortMemorySearchToolResults([
        ...memoryResults.slice(selectedMemory.length),
        ...supplementResults.slice(selectedSupplements.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortMemorySearchToolResults(selected).slice(0, params.maxResults);
}

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

// ZTE_HGJ_MEMORY_BEGIN
type MemorySearchMeetingNormalized = {
  time?: string;
  persons?: string;
  title?: string;
  location?: string;
  isAbstract?: boolean;
  isFutureMeeting?: boolean;
};

function normalizeMemorySearchMeeting(raw: unknown): MemorySearchMeetingNormalized | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const time = typeof obj.time === "string" ? obj.time.trim() : undefined;
  const persons = typeof obj.persons === "string" ? obj.persons.trim() : undefined;
  const title = typeof obj.title === "string" ? obj.title.trim() : undefined;
  const location = typeof obj.location === "string" ? obj.location.trim() : undefined;
  const isAbstract =
    typeof obj.isAbstract === "boolean"
      ? obj.isAbstract
      : typeof obj.isAbstract === "string"
        ? obj.isAbstract.trim().toLowerCase() === "true"
        : undefined;
  const isFutureMeeting =
    typeof obj.isFutureMeeting === "boolean"
      ? obj.isFutureMeeting
      : typeof obj.isFutureMeeting === "string"
        ? obj.isFutureMeeting.trim().toLowerCase() === "true"
        : undefined;
  const hasAny =
    typeof time === "string" ||
    typeof persons === "string" ||
    typeof title === "string" ||
    typeof location === "string" ||
    typeof isAbstract === "boolean" ||
    typeof isFutureMeeting === "boolean";
  if (!hasAny) {
    return undefined;
  }
  return { time, persons, title, location, isAbstract, isFutureMeeting };
}

function isProvidedMeetingObjectWithNoEffectiveFields(
  raw: unknown,
  normalized: MemorySearchMeetingNormalized | undefined,
): boolean {
  if (raw === undefined || raw === null) {
    return false;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return false;
  }
  return normalized === undefined;
}

type EmptyMeetingHandlingPhase = "none" | "rejected_once" | "exhausted";

const emptyMeetingHandlingBySession = new Map<string, EmptyMeetingHandlingPhase>();
// ZTE_HGJ_MEMORY_END

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {
    // Recall tracking is best-effort and must never block memory recall.
  });
}

function normalizeActiveMemoryQmdSearchMode(
  value: unknown,
): "inherit" | "search" | "vsearch" | "query" {
  return value === "inherit" || value === "search" || value === "vsearch" || value === "query"
    ? value
    : "search";
}

function isActiveMemorySessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":active-memory:");
}

function resolveActiveMemoryQmdSearchModeOverride(
  cfg: OpenClawConfig,
  sessionKey?: string,
): "search" | "vsearch" | "query" | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const entry = cfg.plugins?.entries?.["active-memory"];
  const entryRecord =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { config?: unknown })
      : undefined;
  const pluginConfig =
    entryRecord?.config &&
    typeof entryRecord.config === "object" &&
    !Array.isArray(entryRecord.config)
      ? (entryRecord.config as { qmd?: { searchMode?: unknown } })
      : undefined;
  const searchMode = normalizeActiveMemoryQmdSearchMode(pluginConfig?.qmd?.searchMode);
  return searchMode === "inherit" ? undefined : searchMode;
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentSessionKey: params.agentSessionKey,
    corpus: params.corpus,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

async function resolveMemoryReadFailureResult(params: {
  error: unknown;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  if (params.requestedCorpus === "all") {
    const supplement = await getSupplementMemoryReadResult({
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
      corpus: params.requestedCorpus,
    });
    if (supplement) {
      return jsonResult(supplement);
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ path: params.relPath, text: "", disabled: true, error: message });
}

async function executeMemoryReadResult<T>(params: {
  read: () => Promise<T>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  try {
    return jsonResult(await params.read());
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      error,
      requestedCorpus: params.requestedCorpus,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      // ZTE_HGJ_MEMORY_BEGIN
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md + extra_path/*.md (and optional session transcripts) before answering anything questions related to the user self, prior work, decisions, dates, people, preferences, express delivery or todos; returns top snippets with path + lines. Optional param fetchType: when the query clearly targets a specific personal-info domain, set a single best-matching AIK fetch type (IAiKnowledge.FETCH_TYPE_*): voice_assistant=1, dialog=2, notepad=3, calendar=4, schedule=5, specific_schedule=6. If unclear, omit fetchType. Optional param providerQuery: the original user input (unprocessed). Use query for local search; use providerQuery for AIK provider retrieval + rerank when present. Optional param meeting: when the user is asking about meeting/call contents, pass meeting fields (time/persons/title/location; optional isAbstract/isFutureMeeting booleans). ILLEGAL: passing meeting as an empty object {} (no keys / all-empty strings for time, persons, title, location) — the tool errors on the first such call in a session; omit the meeting key entirely if you have no structured fields yet. At least one of meeting.time, meeting.persons, meeting.title, meeting.location must be a non-empty string when meeting is used. When meeting is provided with valid fields, AIK meeting retrieval will be used (not fetchType). Optional param documents: when the user is asking to list/find documents by name, pass documents.fileName (supports regex anchors ^ and $). When documents is provided, AIK documents retrieval will be used (not fetchType). If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
      // ZTE_HGJ_MEMORY_END
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      // ZTE_HGJ_MEMORY_BEGIN
      async (_toolCallId: string, params: Record<string, unknown>) => {
      // ZTE_HGJ_MEMORY_END
        const query = readStringParam(params, "query", { required: true });
        // ZTE_HGJ_MEMORY_BEGIN
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const fetchType = readNumberParam(params, "fetchType", { integer: true });
        const providerQuery = readStringParam(params, "providerQuery");
        const rawMeeting = (params as Record<string, unknown>).meeting;
        let meeting = normalizeMemorySearchMeeting(rawMeeting);
        const meetingSessionKey = options.agentSessionKey ?? "__default__";
        let meetingOmittedAfterEmptyRetry = false;
        if (isProvidedMeetingObjectWithNoEffectiveFields(rawMeeting, meeting)) {
          const emptyMeetingPhase = emptyMeetingHandlingBySession.get(meetingSessionKey) ?? "none";
          if (emptyMeetingPhase === "none") {
            emptyMeetingHandlingBySession.set(meetingSessionKey, "rejected_once");
            return jsonResult({
              status: "error",
              tool: "memory_search",
              code: "empty_meeting_object",
              error:
                "memory_search: `meeting` was provided but has no usable fields (e.g. `{}` or only empty strings). " +
                "AIK meeting retrieval was not run. Re-call memory_search with at least one of: meeting.time, meeting.persons, meeting.title, meeting.location " +
                "(and optional meeting.isAbstract as boolean). Do not send an empty meeting object.",
            });
          }
          emptyMeetingHandlingBySession.set(meetingSessionKey, "exhausted");
          meeting = undefined;
          meetingOmittedAfterEmptyRetry = true;
        } else {
          if (meeting !== undefined || rawMeeting === undefined) {
            emptyMeetingHandlingBySession.delete(meetingSessionKey);
          }
        }
        const normalizeDocuments = (raw: unknown) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return undefined;
          }
          const obj = raw as Record<string, unknown>;
          const fileName = typeof obj.fileName === "string" ? obj.fileName.trim() : "";
          if (!fileName) return undefined;
          return { fileName };
        };
        const documents = normalizeDocuments((params as Record<string, unknown>).documents);
        // ZTE_HGJ_MEMORY_END
        const requestedCorpus = readStringParam(params, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | "sessions"
          | undefined;
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const shouldQueryMemory = requestedCorpus !== "wiki";
        const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
        const memory = shouldQueryMemory ? await getMemoryManagerContext({ cfg, agentId }) : null;
        if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const searchStartedAt = Date.now();
          let rawResults: MemorySearchResult[] = [];
          let surfacedMemoryResults: Array<
            Record<string, unknown> & { corpus: "memory"; score: number; path: string }
          > = [];
          let provider: string | undefined;
          let model: string | undefined;
          let fallback: unknown;
          let searchMode: string | undefined;
          let searchDebug:
            | {
                backend: string;
                configuredMode?: string;
                effectiveMode?: string;
                fallback?: string;
                searchMs: number;
                hits: number;
              }
            | undefined;
          if (shouldQueryMemory && memory && !("error" in memory)) {
            // ZTE_HGJ_MEMORY_BEGIN
            const searchOpts: Record<string, unknown> = {
              minScore,
              sessionKey: options.agentSessionKey,
            };
            if (typeof maxResults === "number" && Number.isFinite(maxResults)) {
              searchOpts.maxResults = maxResults;
            }
            if (typeof fetchType === "number" && Number.isFinite(fetchType)) {
              searchOpts.fetchType = fetchType;
            }
            if (meeting) {
              searchOpts.meeting = meeting;
            }
            if (documents) {
              searchOpts.documents = documents;
            }
            if (typeof providerQuery === "string" && providerQuery.trim().length > 0) {
              searchOpts.providerQuery = providerQuery;
            }
            rawResults = await memory.manager.search(query, searchOpts as any);
            // ZTE_HGJ_MEMORY_END
            const status = memory.manager.status();
            const decorated = decorateCitations(rawResults, includeCitations);
            const resolved = resolveMemoryBackendConfig({ cfg, agentId });
            const memoryResults =
              status.backend === "qmd"
                ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
                : decorated;
            surfacedMemoryResults = memoryResults.map((result) => ({
              ...result,
              corpus: "memory" as const,
            }));
            const sleepTimezone = resolveMemoryDeepDreamingConfig({
              pluginConfig: resolveMemoryCorePluginConfig(cfg),
              cfg,
            }).timezone;
            queueShortTermRecallTracking({
              workspaceDir: status.workspaceDir,
              query,
              rawResults,
              surfacedResults: memoryResults,
              timezone: sleepTimezone,
            });
            provider = status.provider;
            model = status.model;
            fallback = status.fallback;
            const latestDebug = runtimeDebug.at(-1);
            searchMode = latestDebug?.effectiveMode;
            searchDebug = {
              backend: status.backend,
              configuredMode: latestDebug?.configuredMode,
              effectiveMode:
                status.backend === "qmd"
                  ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
                  : "n/a",
              fallback: latestDebug?.fallback,
              searchMs: Math.max(0, Date.now() - searchStartedAt),
              hits: rawResults.length,
            };
          }
          const supplementResults = shouldQuerySupplements
            ? await searchMemoryCorpusSupplements({
                query,
                maxResults,
                agentSessionKey: options.agentSessionKey,
                corpus: requestedCorpus,
              })
            : [];
          // Wiki and memory scores use incomparable scales, so corpus=all first
          // balances candidate selection and then backfills any unused slots.
          const effectiveMax = Math.max(1, maxResults ?? 10);
          const results = mergeMemorySearchCorpusResults({
            memoryResults: surfacedMemoryResults,
            supplementResults,
            maxResults: effectiveMax,
            balanceCorpora: requestedCorpus === "all",
          });
          return jsonResult({
            results,
            provider,
            model,
            fallback,
            citations: citationsMode,
            mode: searchMode,
            debug: searchDebug,
            // ZTE_HGJ_MEMORY_BEGIN
            ...(meetingOmittedAfterEmptyRetry
              ? {
                  meetingOmittedAfterEmptyRetry: true,
                  meetingOmittedNotice:
                    "Empty `meeting` object again after a prior rejection for this session: meeting was omitted for this search (no AIK meeting channel). Further empty `meeting` in the same session will keep being omitted without another error.",
                }
              : {}),
          });
          // ZTE_HGJ_MEMORY_END
        } catch (err) {
          const message = formatErrorMessage(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      // ZTE_HGJ_MEMORY_BEGIN
      async (_toolCallId: string, params: Record<string, unknown>) => {
      // ZTE_HGJ_MEMORY_END
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const requestedCorpus = readStringParam(params, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          const supplement = await getSupplementMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
            corpus: requestedCorpus,
          });
          return jsonResult(
            supplement ?? {
              path: relPath,
              text: "",
              disabled: true,
              error: "wiki corpus result not found",
            },
          );
        }
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          return await executeMemoryReadResult({
            read: async () =>
              await readAgentMemoryFile({
                cfg,
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            requestedCorpus,
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        return await executeMemoryReadResult({
          read: async () =>
            await memory.manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          requestedCorpus,
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
          agentSessionKey: options.agentSessionKey,
        });
      },
  });
}
