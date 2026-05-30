/**
 * CustomContextLoopExecutor.execute() 端到端单元测试
 *
 * 大模型输出通过 mock.module 替换 callOpenAILoop 进行模拟，
 * 其余 SDK 函数使用真实实现。
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// ── 静态 import 捕获真实 SDK 实现（这些引用会在 mock factory 中被使用）──
import {
  LoopMessageContext,
  buildUserMsg,
  buildAssistantMsgForOpenAIToken,
  buildAssistantMsg,
  buildToolResultMsg,
  buildExtraParamResultMsg,
  transferSDKToOpenAIMessage,
  generateSessionId,
  extractPromptText,
  defineLoop,
} from "@zte/agentloop-sdk/sdk";
import type {
  Loop,
  LoopOptions,
  LoopResult,
  PromptInput,
  SDKMessage,
} from "@zte/agentloop-sdk/sdk";

// ── 注册 mock：仅替换 callOpenAILoop，其余函数透传真实实现 ──
const mockCallOpenAILoop = mock();

mock.module("@zte/agentloop-sdk/sdk", () => ({
  LoopMessageContext,
  buildUserMsg,
  buildAssistantMsgForOpenAIToken,
  buildAssistantMsg,
  buildToolResultMsg,
  buildExtraParamResultMsg,
  transferSDKToOpenAIMessage,
  generateSessionId,
  extractPromptText,
  defineLoop,
  callOpenAILoop: mockCallOpenAILoop,
}));

import { CustomContextLoopExecutor } from "./context-loop-example.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** 构造 OpenAI 文本回复响应对象 */
function buildTextResponse(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** 构造带 tool_calls 的 OpenAI 回复响应对象 */
function buildToolCallResponse(
  toolCalls: Array<{ id: string; name: string; args: string }>,
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.args },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** 构造同时包含文本和 tool_calls 的混合响应对象 */
function buildMixedResponse(
  content: string,
  toolCalls: Array<{ id: string; name: string; args: string }>,
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.args },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function createMockLoop(): Loop {
  return {
    id: "custom-context-loop",
    loopType: "custom",
    config: {
      app_name: "TestApp",
      loop_mode: [{ id: "custom-context-loop", type: "custom" }],
      metadata: {
        executor: new CustomContextLoopExecutor(),
        customMaxTurns: 3,
        customSystemPrompt: "You are a test assistant.",
        openaiConfig: {
          baseURL: "https://test-api.example.com/v1",
          apiKey: "test-api-key",
          model: "test-model",
          timeout: 10000,
          maxRetries: 1,
        },
      },
    },
    run: () => {
      throw new Error("not implemented");
    },
    query: () => {
      throw new Error("not implemented");
    },
    steer: () => {},
    setToolBridge: () => {},
    getToolBridge: () => undefined,
  };
}

function createMockLoopOptions(overrides: Partial<LoopOptions> = {}): LoopOptions {
  return {
    sessionId: "test-session-001",
    history: [],
    tools: [],
    model: "test-model",
    ...overrides,
  } as LoopOptions;
}

async function collectMessages(result: LoopResult): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const msg of result) {
    messages.push(msg);
  }
  return messages;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("CustomContextLoopExecutor", () => {
  beforeEach(() => {
    mockCallOpenAILoop.mockReset();
  });

  // ── 场景 1：基本文本回复（无工具调用）────────────────────────────────────
  describe("execute() — 基本文本回复", () => {
    it("应该返回 LoopResult 并 yield 日志、assistant 回复和结束消息", async () => {
      mockCallOpenAILoop.mockResolvedValueOnce(buildTextResponse("你好，有什么可以帮助你的？"));

      const executor = new CustomContextLoopExecutor();
      const loop = createMockLoop();
      const options = createMockLoopOptions();
      const prompt: PromptInput = "你好";

      const result = executor.execute(loop, prompt, options);

      expect(result).toBeDefined();
      expect(typeof result[Symbol.asyncIterator]).toBe("function");

      const messages = await collectMessages(result);

      // assistant 类型消息：tools 日志 + 第 1 轮日志 + 模型回复
      const assistantMsgs = messages.filter((m) => m.type === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);

      // extraparam_result 消息：最终结束消息
      const extraMsgs = messages.filter((m) => m.type === "extraparam_result");
      const lastExtra = extraMsgs[extraMsgs.length - 1] as any;
      expect(lastExtra.result).toContain("自定义 Context Loop 执行完毕");

      // 无 tool_calls 时 callOpenAILoop 只调用一次
      expect(mockCallOpenAILoop).toHaveBeenCalledTimes(1);
    });
  });

  // ── 场景 2：工具调用处理 ────────────────────────────────────────────────
  describe("execute() — 工具调用处理", () => {
    it("应该在模型返回 tool_calls 时执行工具并继续循环", async () => {
      // 第一轮：模型返回 tool_calls
      mockCallOpenAILoop.mockResolvedValueOnce(
        buildToolCallResponse([{ id: "call_001", name: "get_current_time", args: "{}" }]),
      );
      // 第二轮：模型返回纯文本
      mockCallOpenAILoop.mockResolvedValueOnce(
        buildTextResponse("当前时间是 2024-01-01T00:00:00.000Z"),
      );

      const executor = new CustomContextLoopExecutor();
      const loop = createMockLoop();
      const options = createMockLoopOptions();
      const prompt: PromptInput = "现在几点了？";

      const messages = await collectMessages(executor.execute(loop, prompt, options));

      // callOpenAILoop 被调用两次
      expect(mockCallOpenAILoop).toHaveBeenCalledTimes(2);

      // user 类型消息中应有 tool_result
      const userMsgs = messages.filter((m) => m.type === "user");
      const toolResultMsg = userMsgs.find((m) => {
        const content = (m as any).message?.content;
        return Array.isArray(content) && content.some((c: any) => c.type === "tool_result");
      });
      expect(toolResultMsg).toBeDefined();

      // 应有 2 轮请求日志
      const roundLogs = messages.filter(
        (m) =>
          m.type === "assistant" &&
          (m as any).message?.content?.[0]?.text?.includes("第") &&
          (m as any).message?.content?.[0]?.text?.includes("轮请求"),
      );
      expect(roundLogs.length).toBe(2);
    });

    it("应该为 get_current_time 工具返回 ISO 时间字符串", async () => {
      const beforeTime = Date.now();

      mockCallOpenAILoop.mockResolvedValueOnce(
        buildToolCallResponse([{ id: "call_time", name: "get_current_time", args: "{}" }]),
      );
      mockCallOpenAILoop.mockResolvedValueOnce(buildTextResponse("时间已获取"));

      const executor = new CustomContextLoopExecutor();
      const loop = createMockLoop();
      const options = createMockLoopOptions();

      const messages = await collectMessages(executor.execute(loop, "当前时间", options));

      const afterTime = Date.now();

      // 提取 tool_result 中的时间戳
      const userMsgs = messages.filter((m) => m.type === "user");
      const toolResultMsg = userMsgs.find((m) => {
        const content = (m as any).message?.content;
        if (Array.isArray(content)) {
          const tr = content.find((c: any) => c.type === "tool_result");
          if (tr) {
            try {
              const parsed = JSON.parse(tr.content);
              return Array.isArray(parsed) && parsed.some((item: any) => item.type === "text");
            } catch {
              return false;
            }
          }
        }
        return false;
      });
      expect(toolResultMsg).toBeDefined();

      const content = (toolResultMsg as any).message.content;
      const tr = content.find((c: any) => c.type === "tool_result");
      const parsed = JSON.parse(tr.content);
      const textItem = parsed.find((item: any) => item.type === "text");
      const isoTimestamp = textItem.text;

      expect(isoTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const timestamp = new Date(isoTimestamp).getTime();
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime - 1000);
      expect(timestamp).toBeLessThanOrEqual(afterTime + 1000);
    });
  });

  // ── 场景 3：混合响应（同时有文本和 tool_calls）─────────────────────────
  describe("execute() — 混合响应（文本 + tool_calls）", () => {
    it("应该正确处理同时包含 content 和 tool_calls 的 assistant 消息", async () => {
      mockCallOpenAILoop.mockResolvedValueOnce(
        buildMixedResponse("让我帮你查一下时间", [
          { id: "call_mixed_1", name: "get_current_time", args: "{}" },
        ]),
      );
      mockCallOpenAILoop.mockResolvedValueOnce(buildTextResponse("查询完毕"));

      const executor = new CustomContextLoopExecutor();
      const loop = createMockLoop();
      const options = createMockLoopOptions();

      const messages = await collectMessages(executor.execute(loop, "混合测试", options));

      expect(mockCallOpenAILoop).toHaveBeenCalledTimes(2);

      // assistant 消息中应同时包含文本和 tool_use
      const assistantMsgs = messages.filter((m) => m.type === "assistant");
      const textAssistantMsg = assistantMsgs.find((m) => {
        const content = (m as any).message?.content;
        return (
          Array.isArray(content) &&
          content.some((c: any) => c.type === "text" && c.text === "让我帮你查一下时间")
        );
      });
      expect(textAssistantMsg).toBeDefined();

      // user 消息中应有 tool_result
      const userMsgs = messages.filter((m) => m.type === "user");
      const toolResultMsg = userMsgs.find((m) => {
        const content = (m as any).message?.content;
        return Array.isArray(content) && content.some((c: any) => c.type === "tool_result");
      });
      expect(toolResultMsg).toBeDefined();
    });
  });

  // ── 场景 4：历史消息 ─────────────────────────────────────────────────────
  describe("execute() — 历史消息", () => {
    it("应该支持传入历史消息并通过 HistoryMessageFilter 过滤", async () => {
      mockCallOpenAILoop.mockResolvedValueOnce(buildTextResponse("考虑了历史"));

      const executor = new CustomContextLoopExecutor();
      const loop = createMockLoop();
      const historyMessages: SDKMessage[] = [
        {
          type: "user",
          message: { role: "user", content: "之前的问题" },
        } as SDKMessage,
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "之前的回答" }],
          },
        } as SDKMessage,
        // tool_use 类型的消息应被 filter 过滤掉
        {
          type: "tool_use",
          message: { role: "tool", content: "不应被过滤保留" },
        } as SDKMessage,
      ];
      const options = createMockLoopOptions({ history: historyMessages });

      const messages = await collectMessages(executor.execute(loop, "新问题", options));

      const extraMsgs = messages.filter((m) => m.type === "extraparam_result");
      const finalMsg = extraMsgs.find((m) =>
        (m as any).result?.includes("自定义 Context Loop 执行完毕"),
      );
      expect(finalMsg).toBeDefined();
      expect(mockCallOpenAILoop).toHaveBeenCalledTimes(1);
    });

    it("应该支持空历史消息列表", async () => {
      mockCallOpenAILoop.mockResolvedValueOnce(buildTextResponse("无历史"));

      const executor = new CustomContextLoopExecutor();
      const loop = createMockLoop();
      const options = createMockLoopOptions({ history: [] });

      const messages = await collectMessages(executor.execute(loop, "新对话", options));

      expect(mockCallOpenAILoop).toHaveBeenCalledTimes(1);
      const extraMsgs = messages.filter((m) => m.type === "extraparam_result");
      expect(extraMsgs.length).toBeGreaterThan(0);
    });
  });
});
