import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about related to the user self, prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + extra_path/*.md indexed session transcripts; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about related to the user self, prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + extra_path/*.md indexed session transcripts and answer from the matching results. If low confidence after search, say you checked.";
  } else {
    toolGuidance =
      "Before answering anything about related to the user self, prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
  }

  const lines = ["## Memory Recall", toolGuidance];
  // ZTE_HGJ_MEMORY_BEGIN
  if (hasMemorySearch) {
    lines.push(
      "AIKnowledge: When memory_search uses AIK (fetchType 2-6, or meeting, or documents), set providerQuery to the user's latest message verbatim (same wording and language). Use query as short keywords for local indexed search. If providerQuery is omitted, AIK and rerank use query only.",
    );
  }
  // ZTE_HGJ_MEMORY_END
  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
