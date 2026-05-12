import * as fs from "node:fs";
import { appendSessionTranscriptMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  loadWorkspaceSkillEntries,
  registerSkillsChangeListener,
} from "openclaw/plugin-sdk/skills-runtime";
import type { SkillEntry } from "openclaw/plugin-sdk/skills-runtime";
import { buildRuntimeInfo } from "./runtime_info.ts";
import { classifySkill, matchDirectResponse } from "./skill-classifier.ts";
import { formatSkillsForPrompt } from "./skill.ts";
import { filterSkillEntries } from "./skill.ts";
import { SYSTEM_PROMPT } from "./systemPrompt.ts";
import { isDebugEnabled, createDebugLogger } from "./util.ts";

const DEFAULT_TARGET_AGENT_ID = "simple_task_agent";

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

/**
 * 从 prompt 中提取用户原始输入，剥离 gateway 注入的元信息。
 *
 * prompt 格式示例:
 *   Sender (untrusted metadata):
 *   ```json
 *   { "label": "openclaw-control-ui", ... }
 *   ```
 *
 *   [Mon 2026-05-11 10:25 GMT+8] 用户实际输入
 */
function extractUserQuery(prompt: string): string {
  let cleaned = prompt;

  // 1. 剥离 "Sender (untrusted metadata):" + fenced JSON 块
  cleaned = cleaned.replace(/^Sender\s*\(untrusted metadata\):\s*```[\s\S]*?```\s*/i, "");

  // 2. 剥离时间戳行 "[Mon 2026-05-11 10:25 GMT+8]"
  cleaned = cleaned.replace(/^\[[^\]]+\]\s*/, "");

  return cleaned.trim();
}

type MinimalMessage = { role: string; content: string | unknown; timestamp?: number };

/** 从插件配置中读取 targetAgentId，未配置时使用默认值 */
function resolveTargetAgentId(api: OpenClawPluginApi): string {
  const raw = (
    api.config?.plugins?.entries?.["simple-task-handel"]?.config as
      | Record<string, unknown>
      | undefined
  )?.targetAgentId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return DEFAULT_TARGET_AGENT_ID;
}

/** 从插件配置中读取 skillClassify，仅接受 "vector" 或 "keyword"，默认 "vector" */
function resolveSkillClassifyMethod(api: OpenClawPluginApi): "vector" | "keyword" {
  const raw = (
    api.config?.plugins?.entries?.["simple-task-handel"]?.config as
      | Record<string, unknown>
      | undefined
  )?.skillClassify;
  if (raw === "keyword") return "keyword";
  return "vector";
}

let cachedSkillsPrompt: string | null | undefined;
let cachedSkillEntries: SkillEntry[] | null | undefined;

export default definePluginEntry({
  id: "simple-task-handel",
  name: "Simple Task Handler",
  description: "Overrides system prompt for specific agents to act as a mobile task assistant.",
  register(api) {
    const debug = createDebugLogger(api);
    const targetAgentId = resolveTargetAgentId(api);
    debug(`[${api.id}] plugin registered, target agentId="${targetAgentId}"`);

    // 监听技能变更，热更新缓存
    void registerSkillsChangeListener((event) => {
      debug(
        `[${api.id}] skills changed (reason=${event.reason}, workspace=${event.workspaceDir ?? "global"}), clearing cache`,
      );
      cachedSkillsPrompt = undefined;
      cachedSkillEntries = undefined;
    });

    // 直接响应拦截：命中映射表后跳过所有后续逻辑（包括 LLM 调用）
    api.on("before_agent_reply", async (event, ctx) => {
      const agentId = ctx.agentId ?? "";
      debug(
        `[${api.id}] before_agent_reply: entered, agentId="${agentId}" target="${targetAgentId}"`,
      );
      if (agentId !== targetAgentId) {
        debug(`[${api.id}] before_agent_reply: agentId mismatch, skipping`);
        return;
      }

      const cleanedBody = event.cleanedBody ?? "";
      debug(`[${api.id}] before_agent_reply: cleanedBody="${cleanedBody}"`);

      const directReply = matchDirectResponse(cleanedBody);
      debug(
        `[${api.id}] before_agent_reply: directReply=${directReply === null ? "null (no match)" : `"${directReply}"`}`,
      );

      if (directReply === null) return;

      await appendUserMessageToTranscript(api, cleanedBody, ctx);
      await new Promise((resolve) => setTimeout(resolve, 150));
      api.logger.info(`[${api.id}] before_agent_reply: short-circuiting with reply`);
      return { handled: true, reply: { text: directReply }, reason: "direct_response_map" };
    });

    api.on("before_prompt_build", async (event, ctx) => {
      const agentId = ctx.agentId ?? "";
      const sessionKey = ctx.sessionKey ?? "";
      const messageCount = Array.isArray(event.messages) ? event.messages.length : 0;
      const matched = agentId === targetAgentId;

      debug(
        `[${api.id}] before_prompt_build: agentId="${agentId}" matched=${matched} sessionKey="${sessionKey}" messages=${messageCount} promptLen=${event.prompt.length}`,
      );

      if (!matched) {
        debug(`[${api.id}] skipping — agentId "${agentId}" !== "${targetAgentId}"`);
        return undefined;
      }

      const userQuery = extractUserQuery(event.prompt);
      debug(
        `[${api.id}] before_prompt_build: promptLen=${event.prompt.length} extractedLen=${userQuery.length} extracted="${userQuery}"`,
      );

      const classification = await classifySkill(userQuery, {
        method: resolveSkillClassifyMethod(api),
        debug,
      });

      let prefix: string | null;
      let skillsPrompt: string | null;

      if (classification.matched) {
        // 命中 skill 场景：添加精准 skill 提示前缀+SKILL.md 内容，跳过全量 skill 介绍
        prefix = await buildSkillPrefix(
          api,
          targetAgentId,
          classification.label,
          classification.skillName,
          classification.category ?? "",
        );
        if (prefix !== null) {
          skillsPrompt = null;
          debug(
            `[${api.id}] skill classified: category=${classification.category} label="${classification.label}" skillName="${classification.skillName}" score=${classification.score.toFixed(3)}`,
          );
        } else {
          // skill 文件读取失败，回退到未命中路径
          prefix = "";
          skillsPrompt = resolveSkillsPrompt(api, targetAgentId);
          debug(
            `[${api.id}] skill classified but failed to load skill file, falling back to full skills prompt`,
          );
        }
      } else {
        // 未命中：使用原有的工具提示 + 全量 skill 兜底
        // prefix = buildUserPromptPrefix(event.prompt, historyUserMessages, sessionKey);
        prefix = "";
        skillsPrompt = resolveSkillsPrompt(api, targetAgentId);
        debug(
          `[${api.id}] skill not classified (maxScore=${classification.score.toFixed(3)}), falling back to full skills prompt`,
        );
      }

      const runtimeLine = buildRuntimeInfo(api, ctx, targetAgentId);
      const appendParts = [skillsPrompt, runtimeLine].filter(Boolean);
      const appendSystemContext = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

      debug(
        `[${api.id}] overriding systemPrompt (len=${SYSTEM_PROMPT.length}) prependContext prefix hints=${!!prefix} skillsPrompt=${skillsPrompt ? `${skillsPrompt.length} chars` : "none"} runtime=${runtimeLine ? "yes" : "no"}`,
      );

      return {
        systemPrompt: SYSTEM_PROMPT,
        skipBootstrapLoading: true,
        prependContext: prefix || undefined,
        appendSystemContext,
      };
    });
  },
});

/**
 * before_agent_reply 短路 LLM 后，手动将用户消息写入 transcript，
 * 否则 gateway 的非 agent 分支只会写 assistant 回复而丢失用户消息，
 * 导致对话链断裂。
 */
async function appendUserMessageToTranscript(
  api: OpenClawPluginApi,
  text: string,
  ctx: { agentId?: string; sessionId?: string },
) {
  const { sessionId, agentId } = ctx;
  if (!sessionId || !agentId) return;
  try {
    const transcriptPath = api.runtime.agent.session.resolveSessionFilePath(sessionId, undefined, {
      agentId,
    });
    await appendSessionTranscriptMessage({
      transcriptPath,
      message: { role: "user", content: text, timestamp: Date.now() },
    });
  } catch (err) {
    api.logger.warn(`[${api.id}] appendUserMessageToTranscript failed: ${String(err)}`);
  }
}

/**
 * 命中 skill 场景时，生成精准的 skill 指示前缀，并附带对应 SKILL.md 内容。
 * 无法读取 skill 文件时返回 null，由调用方回退到未命中路径。
 */
async function buildSkillPrefix(
  api: OpenClawPluginApi,
  targetAgentId: string,
  label: string,
  skillName: string,
  category: string,
): Promise<string | null> {
  const hint = `[工具提示] 该任务已识别为「${label}」场景，请直接使用 ${skillName} 技能处理该请求，无需加载其他技能。`;
  let skillBody = "";
  let skillDir = "";
  try {
    const entries = loadCachedSkillEntries(api, targetAgentId);
    const categoryHyphen = category.replace(/_/g, "-");
    const entry = entries.find((e) => {
      const name = e.skill.name.toLowerCase();
      return (
        name === categoryHyphen ||
        name === skillName.toLowerCase() ||
        name.includes(skillName.toLowerCase()) ||
        skillName.toLowerCase().includes(name)
      );
    });
    if (entry) {
      skillBody = fs.readFileSync(entry.skill.filePath, "utf-8");
      skillDir = entry.skill.baseDir;
    }
  } catch {
    return null;
  }
  if (skillBody) {
    return `${hint}\n\n技能包路径：${skillDir}\n\n以下是该技能的说明文档：\n\n${skillBody}\n\n`;
  }
  return null;
}

function loadCachedSkillEntries(api: OpenClawPluginApi, targetAgentId: string): SkillEntry[] {
  if (cachedSkillEntries !== undefined) {
    return cachedSkillEntries ?? [];
  }
  try {
    const workspaceDir = resolveAgentWorkspaceDir(api.config, targetAgentId);
    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: api.config,
      agentId: targetAgentId,
    });
    const filteredEntries = filterSkillEntries(entries, api.config);
    cachedSkillEntries = filteredEntries;
    const skills = filteredEntries.map((e) => e.skill);
    const prompt = formatSkillsForPrompt(skills);
    cachedSkillsPrompt = prompt || null;
    if (isDebugEnabled()) {
      api.logger.info(
        `[${api.id}] cached skills prompt (${skills.length} skills after filtering ${filteredEntries.length} filteredEntries, ${prompt.length} chars)`,
      );
    }
    return filteredEntries;
  } catch (err) {
    api.logger.warn(
      `[${api.id}] failed to load skill entries: ${err instanceof Error ? err.stack : String(err)}`,
    );
    cachedSkillEntries = null;
    return [];
  }
}

function resolveSkillsPrompt(api: OpenClawPluginApi, targetAgentId: string): string | null {
  if (cachedSkillsPrompt !== undefined) {
    return cachedSkillsPrompt;
  }
  loadCachedSkillEntries(api, targetAgentId);
  return cachedSkillsPrompt ?? null;
}
