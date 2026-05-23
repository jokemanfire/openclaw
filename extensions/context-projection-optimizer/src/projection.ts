import { createHash } from "node:crypto";

export type ProjectionConfig = {
  maxToolResultChars: number;
  previewChars: number;
  tailChars: number;
  keepRecentMessages: number;
};

export type ProjectionProfile = "simple" | "complex";

export type ProjectionConfigProfiles = Record<ProjectionProfile, ProjectionConfig>;

export type ResolvedProjectionConfigSet = {
  defaultProfile: ProjectionProfile;
  profiles: ProjectionConfigProfiles;
};

export type ProjectionStats = {
  projectedCount: number;
  originalChars: number;
  projectedChars: number;
};

type TextBlock = {
  type?: unknown;
  text?: unknown;
};

type UnknownMessage = {
  role?: unknown;
  type?: unknown;
  content?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  toolUseId?: unknown;
  tool_use_id?: unknown;
  call_id?: unknown;
  id?: unknown;
  [key: string]: unknown;
};

const SIMPLE_DEFAULT_CONFIG: ProjectionConfig = {
  maxToolResultChars: 1_000,
  previewChars: 100,
  tailChars: 0,
  keepRecentMessages: 0,
};

const COMPLEX_DEFAULT_CONFIG: ProjectionConfig = {
  maxToolResultChars: 12_000,
  previewChars: 2_000,
  tailChars: 800,
  keepRecentMessages: 12,
};

const DEFAULT_PROFILE: ProjectionProfile = "complex";
const PROFILE_HINT_BEGIN = "<<<BEGIN_OPENCLAW_CONTEXT_PROJECTION_PROFILE>>>";
const PROFILE_HINT_END = "<<<END_OPENCLAW_CONTEXT_PROJECTION_PROFILE>>>";

export function resolveProjectionConfig(input: unknown): ProjectionConfig {
  return resolveProjectionConfigForProfile(input);
}

export function resolveProjectionConfigForProfile(
  input: unknown,
  profile?: ProjectionProfile,
): ProjectionConfig {
  const configSet = resolveProjectionConfigSet(input);
  const selectedProfile = profile ?? configSet.defaultProfile;
  return configSet.profiles[selectedProfile];
}

export function resolveProjectionConfigSet(input: unknown): ResolvedProjectionConfigSet {
  const raw = asRecord(input);
  const rawProfiles = asRecord(raw.profiles);
  const defaultProfile = parseProjectionProfile(raw.defaultProfile) ?? DEFAULT_PROFILE;
  return {
    defaultProfile,
    profiles: {
      simple: resolveLayeredProjectionConfig(
        SIMPLE_DEFAULT_CONFIG,
        raw,
        asRecord(rawProfiles.simple),
      ),
      complex: resolveLayeredProjectionConfig(
        COMPLEX_DEFAULT_CONFIG,
        raw,
        asRecord(rawProfiles.complex),
      ),
    },
  };
}

export function resolveProjectionProfileHintFromPrompt(
  prompt: unknown,
): ProjectionProfile | undefined {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return undefined;
  }
  const blockMatch = prompt.match(
    /<<<BEGIN_OPENCLAW_CONTEXT_PROJECTION_PROFILE>>>\s*(simple|complex)\s*<<<END_OPENCLAW_CONTEXT_PROJECTION_PROFILE>>>/s,
  );
  if (blockMatch?.[1]) {
    return parseProjectionProfile(blockMatch[1]);
  }
  const xmlMatch = prompt.match(
    /<context-projection-profile>\s*(simple|complex)\s*<\/context-projection-profile>/i,
  );
  if (xmlMatch?.[1]) {
    return parseProjectionProfile(xmlMatch[1].toLowerCase());
  }
  return undefined;
}

export function resolveProjectionProfileSelection(params: {
  pluginConfig: unknown;
  prompt?: unknown;
}): {
  defaultProfile: ProjectionProfile;
  hintedProfile?: ProjectionProfile;
  effectiveProfile: ProjectionProfile;
  config: ProjectionConfig;
} {
  const configSet = resolveProjectionConfigSet(params.pluginConfig);
  const hintedProfile = resolveProjectionProfileHintFromPrompt(params.prompt);
  const effectiveProfile = hintedProfile ?? configSet.defaultProfile;
  return {
    defaultProfile: configSet.defaultProfile,
    hintedProfile,
    effectiveProfile,
    config: configSet.profiles[effectiveProfile],
  };
}

export function projectMessagesForContext<T>(
  messages: T[],
  config: ProjectionConfig,
): {
  messages: T[];
  stats: ProjectionStats;
} {
  const firstRecentIndex = Math.max(0, messages.length - config.keepRecentMessages);
  const stats: ProjectionStats = {
    projectedCount: 0,
    originalChars: 0,
    projectedChars: 0,
  };
  let changed = false;

  const projected = messages.map((message, index) => {
    if (index >= firstRecentIndex) {
      return message;
    }
    if (!isToolResultMessage(message)) {
      return message;
    }

    const text = extractTextContent((message as UnknownMessage).content);
    if (text.length <= config.maxToolResultChars) {
      return message;
    }

    const replacement = buildProjectedToolResult({
      text,
      message: message as UnknownMessage,
      config,
    });
    if (replacement.length >= text.length) {
      return message;
    }
    const next = replaceMessageTextContent(message, replacement);
    changed = true;
    stats.projectedCount += 1;
    stats.originalChars += text.length;
    stats.projectedChars += replacement.length;
    return next;
  });

  return {
    messages: changed ? projected : messages,
    stats,
  };
}

export function estimateTextTokens(messages: unknown[]): number {
  const chars = messages.reduce<number>((sum, message) => sum + JSON.stringify(message).length, 0);
  return Math.ceil(chars / 4);
}

function clampInt(value: unknown, fallback: number, min: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.floor(normalized));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseProjectionProfile(value: unknown): ProjectionProfile | undefined {
  return value === "simple" || value === "complex" ? value : undefined;
}

function resolveLayeredProjectionConfig(
  defaults: ProjectionConfig,
  sharedOverrides: Record<string, unknown>,
  profileOverrides: Record<string, unknown>,
): ProjectionConfig {
  return {
    maxToolResultChars: resolveLayeredInt(
      "maxToolResultChars",
      defaults.maxToolResultChars,
      1_000,
      sharedOverrides,
      profileOverrides,
    ),
    previewChars: resolveLayeredInt(
      "previewChars",
      defaults.previewChars,
      100,
      sharedOverrides,
      profileOverrides,
    ),
    tailChars: resolveLayeredInt(
      "tailChars",
      defaults.tailChars,
      0,
      sharedOverrides,
      profileOverrides,
    ),
    keepRecentMessages: resolveLayeredInt(
      "keepRecentMessages",
      defaults.keepRecentMessages,
      0,
      sharedOverrides,
      profileOverrides,
    ),
  };
}

function resolveLayeredInt(
  key: keyof ProjectionConfig,
  fallback: number,
  min: number,
  ...layers: Record<string, unknown>[]
): number {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const value = layers[index]?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(min, Math.floor(value));
    }
  }
  return clampInt(fallback, fallback, min);
}

export function buildProjectionProfileHintBlock(profile: ProjectionProfile): string {
  return `${PROFILE_HINT_BEGIN}\n${profile}\n${PROFILE_HINT_END}`;
}

function isToolResultMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as UnknownMessage;
  return message.role === "toolResult" || message.role === "tool" || message.type === "toolResult";
}

function isTextContentBlock(block: unknown): boolean {
  if (typeof block === "string") {
    return true;
  }
  return Boolean(
    block &&
    typeof block === "object" &&
    ((block as TextBlock).type === "text" || typeof (block as TextBlock).text === "string"),
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (
        block &&
        typeof block === "object" &&
        ((block as TextBlock).type === "text" || typeof (block as TextBlock).text === "string")
      ) {
        const text = (block as TextBlock).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function replaceMessageTextContent<T>(message: T, text: string): T {
  const source = message as UnknownMessage;
  const content = source.content;
  if (Array.isArray(content)) {
    let inserted = false;
    const blocks: unknown[] = [];
    for (const block of content) {
      if (isTextContentBlock(block)) {
        if (!inserted) {
          blocks.push({ type: "text", text });
          inserted = true;
        }
        continue;
      }
      blocks.push(block);
    }
    return { ...source, content: inserted ? blocks : [{ type: "text", text }] } as T;
  }
  return { ...source, content: text } as T;
}

function buildProjectedToolResult(params: {
  text: string;
  message: UnknownMessage;
  config: ProjectionConfig;
}): string {
  const toolName =
    normalizeLabel(params.message.toolName) ??
    normalizeLabel(params.message.tool_name) ??
    normalizeLabel(params.message.name) ??
    "unknown";
  const toolCallId =
    normalizeLabel(params.message.toolCallId) ??
    normalizeLabel(params.message.tool_call_id) ??
    normalizeLabel(params.message.toolUseId) ??
    normalizeLabel(params.message.tool_use_id) ??
    normalizeLabel(params.message.call_id) ??
    normalizeLabel(params.message.id) ??
    "unknown";
  const preview = takeChars(params.text, params.config.previewChars);
  const tail = selectTail(params.text, params.config.tailChars, preview.length);
  const sha256 = createHash("sha256").update(params.text).digest("hex");
  const omitted = Math.max(0, params.text.length - preview.length - tail.length);

  const lines = [
    "<context-projection>",
    "Old oversized tool result projected by context-projection-optimizer.",
    `Tool: ${toolName}`,
    `Tool call id: ${toolCallId}`,
    `Original characters: ${params.text.length}`,
    `Original sha256: ${sha256}`,
    `Omitted characters: ${omitted}`,
    "The full original result remains in the OpenClaw transcript; rerun or reread the source if exact hidden lines are needed.",
    "",
    `<preview firstChars="${preview.length}">`,
    preview,
    "</preview>",
  ];
  if (tail) {
    lines.push("", `<tail lastChars="${tail.length}">`, tail, "</tail>");
  }
  lines.push("</context-projection>");
  return lines.join("\n");
}

function normalizeLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function takeChars(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function selectTail(value: string, maxChars: number, previewChars: number): string {
  const availableAfterPreview = Math.max(0, value.length - previewChars);
  const tailChars = Math.min(maxChars, availableAfterPreview);
  if (tailChars <= 0) {
    return "";
  }
  return value.slice(value.length - tailChars);
}
