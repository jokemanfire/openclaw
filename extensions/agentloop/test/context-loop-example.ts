/**
 *
 * OPENAI接口各角色完整格式

messages: [
  // 1. 系统消息
  { role: 'system', content: '你是一个有帮助的助手' },

  // 2. 用户消息 — 纯文本
  { role: 'user', content: '今天天气怎么样？' },

  // 3. assistant 普通回复
  { role: 'assistant', content: '天气不错，适合出门。' },

  // 4. assistant 带 tool_calls 的回复
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_abc123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"北京"}' },
      },
    ],
  },

  // 5. 工具返回结果（必须紧跟对应的 assistant tool_calls）
  {
    role: 'tool',
    tool_call_id: 'call_abc123',
    content: '{"temperature": 25, "condition": "晴"}',
  },
]
关键规则
带 tool_calls 的 assistant 消息后面，必须紧跟对应 tool_call_id 的 tool 消息，否则 API 会报错
assistant 的 content 在有 tool_calls 时通常为 null（但也可以同时有文本内容）
tool 消息的 content 是字符串，通常是 JSON 序列化后的工具返回值
 */

import {
  defineLoop,
  extractPromptText,
  generateSessionId,
  LoopMessageContext,
  transferSDKToOpenAIMessage,
  buildAssistantMsg,
  buildToolResultMsg,
  buildUserMsg,
  buildExtraParamResultMsg,
  callOpenAILoop,
  buildAssistantMsgForOpenAIToken,
  type Loop,
  type LoopDefinition,
  type LoopExecutor,
  type LoopOptions,
  type LoopResult,
  type LoopPauseResult,
  type PromptInput,
  type SDKMessage,
  type ToolBridgeHandle,
  type OpenAIClientConfig,
  type HistoryMessageFilter,
  type ToolExecutionResult,
} from "@zte/agentloop-sdk/sdk";
// ═══════════════════════════════════════════════════════════════════════════════
// 1. 自定义 LoopExecutor 实现
// ═══════════════════════════════════════════════════════════════════════════════

export class CustomContextLoopExecutor implements LoopExecutor {
  private toolBridge: ToolBridgeHandle | undefined;

  setToolBridge(bridge: ToolBridgeHandle): void {
    this.toolBridge = bridge;
  }

  getToolBridge(): ToolBridgeHandle | undefined {
    return this.toolBridge;
  }

  getActiveSessionCount(): number {
    return 0;
  }

  /**
   * LoopExecutor 的核心执行方法（自定义实现入口）
   *
   * 这是 LoopExecutor 接口中唯一必须实现的方法，负责：
   *  1. 从 loop.config.metadata 读取自定义配置参数
   *  2. 调用模型（非流式/流式）或工具
   *  3. 将结果 yield 为 SDKMessage
   *  4. 组装并返回 LoopResult（AsyncGenerator + 控制方法）
   *
   * 调用时机：当外部调用 loop.run(prompt, options) 时，内部会转发到本方法。
   *
   * @param loop    - 当前 Loop 实例（包含 config、metadata 等）
   * @param prompt  - 用户输入（string | object | ContentBlockParam[]）
   * @param options - 运行时选项（sessionId、model、signal 等）
   * @returns LoopResult - 流式结果对象，调用方通过 for await...of 消费
   */
  execute(loop: Loop, prompt: PromptInput, options: LoopOptions): LoopResult {
    const sessionId = options.sessionId || generateSessionId();
    const textPrompt = extractPromptText(prompt);

    // ── 特性 1：从 LoopDefinition.metadata 读取自定义参数 ──
    // metadata 在 defineLoop(config) 时写入 config，此处通过 loop.config.metadata 取出
    const customMaxTurns = (loop.config.metadata?.customMaxTurns as number) ?? 5;
    const customSystemPrompt = (loop.config.metadata?.customSystemPrompt as string) ?? "";
    const openaiConfig =
      (loop.config.metadata?.openaiConfig as OpenAIClientConfig) ?? DEFAULT_OPENAI_CONFIG;

    const generator = this.runLoop(
      loop,
      textPrompt,
      options,
      sessionId,
      customMaxTurns,
      customSystemPrompt,
      openaiConfig,
    );

    // ── 特性 4：组装 LoopResult（AsyncGenerator + 控制方法）──
    const loopResult = Object.assign(generator, {
      interrupt: async () => {},
      rewindFiles: async () => ({}),
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      initializationResult: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
      accountInfo: async () => ({}),
      reconnectMcpServer: async () => {},
      toggleMcpServer: async () => {},
      setMcpServers: async () => ({}),
      streamInput: async () => {},
      stopTask: async () => {},
      pause: (_taskId: string): LoopPauseResult => {
        const gen = (async function* () {})() as AsyncGenerator<SDKMessage>;
        return Object.assign(gen, { resume: async () => {} }) as LoopPauseResult;
      },
      steer: () => {},
      close: () => {},
    }) as LoopResult;

    return loopResult;
  }

  steer(_loop: Loop, _prompt: PromptInput, _options: LoopOptions): void {
    // 教程示例中暂不实现 steer 逻辑
  }

  /**
   * 核心执行逻辑：异步生成器
   *
   * 每一步 yield SDKMessage，调用方通过 for await...of 流式消费
   */
  private async *runLoop(
    loop: Loop,
    textPrompt: string,
    _options: LoopOptions,
    sessionId: string,
    maxTurns: number,
    systemPrompt: string,
    openaiConfig: OpenAIClientConfig,
  ): AsyncGenerator<SDKMessage> {
    // 1. 创建消息上下文：最多保留 20 条消息，过期时间 30 分钟
    const ctx = new LoopMessageContext(20, 30 * 60);

    // 2. 初始化历史消息（可选过滤）
    const messageFilter: HistoryMessageFilter = (msg: SDKMessage) => {
      return msg.type === "user" || msg.type === "assistant";
    };

    const loopOptions = _options; // LoopOptions 包含运行时配置（model、url、tools 等）

    ctx.init(loopOptions.history as SDKMessage[], messageFilter);

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // 模块 3：OpenAI 工具调用（非流式 + 流式）
      //    通过 LoopOptions 传入 tools，让模型在合适对话中自动调用工具
      // ═══════════════════════════════════════════════════════════════════════

      // 构造示例工具（实际场景中通常由外部通过 LoopOptions.tools 传入）
      const demoTools = [
        {
          name: "get_current_time",
          description: "获取当前系统时间，返回 ISO 8601 格式字符串",
          inputSchema: { type: "object", properties: {} },
        },
      ];

      const toolLoopOptions: LoopOptions = {
        ...loopOptions,
        tools: loopOptions.tools ?? demoTools,
      };

      yield buildAssistantMsg(
        `[发送日志] tools: ${(toolLoopOptions.tools ?? []).map((t: any) => t.name).join(", ")}`,
      );

      buildUserMsg(textPrompt, ctx);

      let turnCount = 0;
      const maxToolTurns = maxTurns ?? 10;

      while (turnCount < maxToolTurns) {
        turnCount++;
        yield buildAssistantMsg(`[发送日志] 第 ${turnCount} 轮请求`);

        const res = await callOpenAILoop(toolLoopOptions, systemPrompt, openaiConfig, {
          messages: [...transferSDKToOpenAIMessage(ctx.get())],
          temperature: 0.7,
        });

        yield buildAssistantMsgForOpenAIToken(res, ctx);

        const assistantMessage = res.choices?.[0]?.message;
        if (!assistantMessage?.tool_calls || assistantMessage.tool_calls.length === 0) {
          break;
        }

        const toolResults: ToolExecutionResult[] = assistantMessage.tool_calls.map(
          (toolCall: any) => {
            const toolName = toolCall.function.name;
            let toolResult = "";

            if (toolName === "get_current_time") {
              toolResult = new Date().toISOString();
            } else if (this.toolBridge) {
              toolResult = `工具 ${toolName} 已通过 toolBridge 执行`;
            } else {
              toolResult = `工具 ${toolName} 未找到`;
            }

            return {
              toolName,
              callId: toolCall.id,
              contentItems: [{ type: "text", text: toolResult }],
              success: true,
            };
          },
        );
        for (const toolResult of toolResults.map((toolResult: ToolExecutionResult) =>
          buildToolResultMsg(toolResult, ctx),
        )) {
          yield toolResult;
        }
      }

      if (turnCount >= maxToolTurns) {
        yield buildExtraParamResultMsg("[发送日志]达到最大工具调用轮数", ctx);
      }

      // 最终结束消息
      const result = "[发送日志]自定义 Context Loop 执行完毕";
      yield buildExtraParamResultMsg(result, ctx);
    } catch (error) {
      // 异常兜底：用 assistant 标准格式 yield 错误信息，确保用户能看到
      const errorText = error instanceof Error ? error.message : String(error);
      const result = `执行出错：${errorText}`;
      yield buildExtraParamResultMsg(result, ctx);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. 默认 OpenAI 兼容配置（MiniMax 示例）
// ═══════════════════════════════════════════════════════════════════════════════

// ⚠️ 生产环境请替换为真实 API Key，切勿将敏感凭证硬编码到源码中
const DEFAULT_OPENAI_CONFIG: OpenAIClientConfig = {
  baseURL: "https://api.minimaxi.com/v1",
  apiKey: "sk-cp-xxxxx", // <-- 请替换为真实密钥
  model: "MiniMax-M2.7",
  timeout: 30000,
  maxRetries: 2,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Loop 定义工厂（客户可直接复制使用）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 创建自定义教程 Loop 实例
 *
 * ⚠️ 重要：如果本 Loop 需要被 Supervisor 路由到，必须在 App 的 index.ts 中
 * 调用 loopRegister.register() 预注册，否则 supervisor 调用 createLoopById 时
 * 会缓存未命中，fallback 到默认 ComplexLoopExecutor。
 *
 * 注册示例（在 fake-app/index.ts 中）：
 * ```ts
 * import { loopRegister } from "@zte/agentloop-sdk/sdk";
 * import { createCustomTutorialLoop } from "./executor/custom-loop-tutorial.js";
 *
 * const customLoop = createCustomTutorialLoop();
 * loopRegister.register("FakeApp", customLoop, "custom");
 * ```
 *
 * 独立使用方式（不经 supervisor 路由）：
 * ```ts
 * const loop = createCustomTutorialLoop();
 * loop.setToolBridge(myToolBridge); // 如需使用工具，先设置工具桥
 *
 * const result = loop.run("你好，请帮我搜索一下 OpenClaw", { sessionId: "s-001" });
 *
 * for await (const msg of result) {
 *   console.log(msg.type, msg.content);
 * }
 * ```
 */
export function createCustomContextLoop(): Loop {
  const config: LoopDefinition = {
    app_name: "CustomContextApp",
    loop_mode: [
      {
        id: "custom-context-loop",
        type: "custom" as any,
      },
    ],
    // ── 特性 1：通过 metadata 传入自定义参数 ──
    // 以下参数均通过 loop.config.metadata 在 LoopExecutor.execute() 中读取：
    //
    //  ✅ executor（必传）
    //     自定义 LoopExecutor 实例，负责实现 execute() / steer() / setToolBridge() 等核心逻辑。
    //     如果不传，defineLoop 会 fallback 到默认的 ComplexLoopExecutor。
    //
    //  ⚪ 以下参数均为可选，由用户在 CustomTutorialLoopExecutor 中自行读取和使用：
    //     customMaxTurns      - 自定义最大轮数（本示例中使用）
    //     customSystemPrompt  - 自定义系统提示词（本示例中使用）
    //     openaiConfig        - OpenAI 兼容 API 配置（本示例中使用，有默认值兜底）
    //     myCustomField       - 演示：用户可扩展任意自定义字段
    //     原则上 metadata 支持任意 Record<string, unknown> 字段，完全由业务自定义。
    metadata: {
      executor: new CustomContextLoopExecutor(),
      customMaxTurns: 3,
      customSystemPrompt: "你是一个专业的自定义上下文 Loop 演示助手。",
      openaiConfig: DEFAULT_OPENAI_CONFIG,
      myCustomField: "任意自定义值",
    },
  };

  return defineLoop(config, "custom-context-loop");
}

export default createCustomContextLoop;
