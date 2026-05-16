import { z } from "zod";

export type AgentLoopLoopType = "supervisor" | "simple" | "complex" | "gui" | "custom";

export type AgentLoopPluginConfig = {
  maxConcurrentTasks?: number;
  maxConcurrentTools?: number;
  defaultLoopType?: AgentLoopLoopType;
  toolTimeoutMs?: number;
  steer?: {
    enabled?: boolean;
  };
  loop?: {
    maxTurns?: number;
  };
  compact?: {
    waitTimeoutMs?: number;
  };
  manifest?: {
    writeToDisk?: boolean;
  };
};

export type ResolvedAgentLoopConfig = {
  maxConcurrentTasks: number;
  maxConcurrentTools: number;
  defaultLoopType: AgentLoopLoopType;
  toolTimeoutMs: number;
  steer: {
    enabled: boolean;
  };
  loop: {
    maxTurns: number;
  };
  compact: {
    waitTimeoutMs: number;
  };
  manifest: {
    writeToDisk: boolean;
  };
};

const agentLoopTypeSchema = z.enum([
  "supervisor",
  "simple",
  "complex",
  "gui",
  "custom"
]);

const agentLoopPluginConfigSchema = z
  .object({
    maxConcurrentTasks: z.number().positive().optional(),
    maxConcurrentTools: z.number().positive().optional(),
    defaultLoopType: agentLoopTypeSchema.optional(),
    toolTimeoutMs: z.number().min(1000).optional(),
    steer: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    loop: z
      .object({
        maxTurns: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    compact: z
      .object({
        waitTimeoutMs: z.number().min(1000).optional(),
      })
      .strict()
      .optional(),
    manifest: z
      .object({
        writeToDisk: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function readAgentLoopPluginConfig(value: unknown): AgentLoopPluginConfig {
  const parsed = agentLoopPluginConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function resolveAgentLoopConfig(
  params: {
    pluginConfig?: unknown;
    env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedAgentLoopConfig {
  const env = params.env ?? process.env;
  const config = readAgentLoopPluginConfig(params.pluginConfig);

  return {
    maxConcurrentTasks:
      config.maxConcurrentTasks ??
      normalizePositiveInt(env.AGENTLOOP_MAX_CONCURRENT_TASKS, 3),
    maxConcurrentTools:
      config.maxConcurrentTools ??
      normalizePositiveInt(env.AGENTLOOP_MAX_CONCURRENT_TOOLS, 5),
    defaultLoopType:
      config.defaultLoopType ??
      resolveLoopType(env.AGENTLOOP_DEFAULT_LOOP_TYPE) ??
      "complex",
    toolTimeoutMs:
      config.toolTimeoutMs ??
      normalizePositiveInt(env.AGENTLOOP_TOOL_TIMEOUT_MS, 30_000),
    steer: {
      enabled:
        config.steer?.enabled ??
        readBooleanEnv(env.AGENTLOOP_STEER_ENABLED) ??
        true,
    },
    loop: {
      maxTurns:
        config.loop?.maxTurns ??
        normalizePositiveInt(env.AGENTLOOP_LOOP_MAX_TURNS, 50),
    },
    compact: {
      waitTimeoutMs:
        config.compact?.waitTimeoutMs ??
        normalizePositiveInt(env.AGENTLOOP_COMPACT_WAIT_TIMEOUT_MS, 300_000),
    },
    manifest: {
      writeToDisk:
        config.manifest?.writeToDisk ??
        readBooleanEnv(env.AGENTLOOP_MANIFEST_WRITE_TO_DISK) ??
        true,
    },
  };
}

function resolveLoopType(value: unknown): AgentLoopLoopType | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = agentLoopTypeSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}
