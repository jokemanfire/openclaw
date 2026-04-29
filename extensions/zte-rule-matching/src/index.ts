
/* Started by Cursor 10026780.A25624033 20260326250000046 */
import express from "express";
import http from "node:http";

const OPENAI_URL = "https://aimoe-test.ztems.com/aimoe/service/api/openclaw/checkRule";

/**
 * 将 HTTP 响应体解析为规则码：0 / 3 / 4，否则 -1。
 * 支持纯文本 "0"|"3"|"4"，或 JSON 中的 `responseText` 字段。
 */
function parseRuleMatchCodeFromResponseBody(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "0") return 0;
  if (trimmed === "3") return 3;
  if (trimmed === "4") return 4;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "responseText" in parsed) {
      const token = String((parsed as { responseText: unknown }).responseText).trim();
      if (token === "0") return 0;
      if (token === "3") return 3;
      if (token === "4") return 4;
    }
  } catch {
    // 非 JSON，已在上面按纯文本处理
  }
  return -1;
}

// 规则匹配 HTTP 接口（返回码：0 / 3 / 4；其他或失败为 -1）
const createRuleMatcher = (logger: any) => ({
  match: async (prompt: string): Promise<number> => {
    logger.info("ruleMatch=== RuleMatcher.match called with prompt: " + prompt);
    logger.info("ruleMatch=== Request URL: " + OPENAI_URL);
    
    const apiKey = "";
    
    try {
      // 构建请求体
      const requestBody = JSON.stringify({ question: prompt });
      
      // 解析 URL
      const url = new URL(OPENAI_URL);
      const isHttps = url.protocol === "https:";
      const httpModule = isHttps ? require("https") : require("http");
      
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      };
      
      // 创建 HTTP 请求 Promise
      const httpRequestPromise = new Promise<string>((resolve, reject) => {
        const req = httpModule.request(options, (res: any) => {
          let data = "";
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            logger.info("ruleMatch=== HTTP Status ===");
            logger.info(String(res.statusCode));
            logger.info("ruleMatch=== Raw Response ===");
            logger.info(data);
            
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`请求失败，状态码: ${res.statusCode}`));
            } else {
              resolve(data);
            }
          });
        });
        
        req.on("error", (err: Error) => {
          reject(err);
        });
        
        req.write(requestBody);
        req.end();
      });
      
      // 创建超时 Promise（5秒）
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject(new Error("请求超时"));
        }, 10000);
      });
      
      // 使用 Promise.race 竞争，先完成的那个生效
      const responseBody = await Promise.race([httpRequestPromise, timeoutPromise]);
      
       const code = parseRuleMatchCodeFromResponseBody(responseBody);
      logger.info("ruleMatch=== RuleMatcher.match parsed code:" + code);
      return code;
      
    } catch (error) {
      logger.error("请求异常: " + String(error));
      logger.info("❌ RuleMatcher.match: no match due to error.");
      return -1;
    }
  }
});

/** 在 before_model_resolve 中写入，在 before_prompt_build 中读取 */
let ruleMatchResult: { matchCode: number; trueUserQuestion?: string } | null = null;
const ruleMatchCodeBySessionId = new Map<string, number>();

const SIMPLE_ASSISTANT_PROMPT = "You are a personal assistant running inside OpenClaw.";
const SCREEN_ANALYSIS_IMAGE_PATH = "/data/media/0/DCIM/ScreenAnalysis/screen.png";

/**
 * 必须放进 prependContext（与用户 prompt 拼接后的 effectivePrompt），
 * OpenClaw 才会通过 detectAndLoadPromptImages 把该路径加载为多模态图片；仅写在 systemPrompt 里不会加载像素。
 */
//function buildFixedScreenImagePrependContext(): string {
/*function buildFixedScreenAnalysisPrependContext(): string {
  return [
    "【固定分析图片】本回合需要你理解用户当前提供的图片文件，禁止仅凭历史对话、纯文本或猜测回答；禁止用截图覆盖该图片文件。",
    `用户提供的图片路径如下：${SCREEN_ANALYSIS_IMAGE_PATH}`,
  ].join("\n");
}*/
function buildFixedScreenAnalysisPrependContext(): string {
  return [
    "【分析指定的图片】本轮需要你严格按照用户指定图片来源规则回答本轮用户的问题，图片来源规则如下：",
    "（1）本轮存在一并传入的用户图片，则只分析本轮输入的图片；",
    `（2）本轮不存在一并传入的用户图片，则只分析系统的图片，路径如下：${SCREEN_ANALYSIS_IMAGE_PATH}；`,
    `（3）本轮不存在一并传入的用户图片，且系统的图片（路径如下：${SCREEN_ANALYSIS_IMAGE_PATH}）也不存在，则只分析历史输入中最近的图片；`,
  ].join("\n");
}

/*function buildFixedScreenOperatePrependContext(): string {
  return [
    "【根据固定图片中内容完成某些任务】本回合需要你根据用户当前提供的图片文件，然后根据用户的指令操作图片中的某些对象",
    `用户提供的图片路径如下：${SCREEN_ANALYSIS_IMAGE_PATH}`,
  ].join("\n");
}*/

function buildFixedScreenOperatePrependContext(): string {
  return [
    "【操作指定的图片】本轮需要你严格按照用户指定图片来源规则并根据本轮用户的指令进行操作，图片来源规则如下：",
    "（1）本轮存在一并传入的用户图片，则只操作本轮输入的图片；",
    `（2）本轮不存在一并传入的用户图片，则只操作系统的图片，路径如下：${SCREEN_ANALYSIS_IMAGE_PATH}；`,
    `（3）本轮不存在一并传入的用户图片，且系统的图片（路径如下：${SCREEN_ANALYSIS_IMAGE_PATH}）也不存在，则只操作历史输入中最近的图片；`,
  ].join("\n");
}

function buildScreenAnalysisAnalyzePrompt(userQuestion: string): string {
  return [
    "你是运行在 OpenClaw 内分析用户提供的图片的助手。"
  ].join("\n");
}

function buildScreenAnalysisOperatePrompt(userInstructions: string): string {
  return [
    "你是运行在 OpenClaw 内的根据用户提供的图片执行某些功能的助手。"
  ].join("\n");
}

/**
 * 在 3/4 场景下，清理会话消息里的历史图片块，避免模型继续参考历史图片。
 * 注意：before_prompt_build 的 event.messages 与运行态会话消息共用引用，可就地修改。
 */
function pruneImagesFromSessionMessages(messages: unknown[]): number {
  let pruned = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const record = msg as { content?: unknown };
    if (!Array.isArray(record.content)) {
      continue;
    }
    for (let i = 0; i < record.content.length; i++) {
      const block = record.content[i];
      if (!block || typeof block !== "object") {
        continue;
      }
      const typedBlock = block as { type?: unknown };
      if (typedBlock.type === "image") {
        record.content[i] = {
          type: "text",
          text: "[历史图片已忽略，请仅按固定图片路径进行分析/操作]",
        } as (typeof record.content)[number];
        pruned++;
      }
    }
  }
  return pruned;
}

function shouldBlockScreenImageOverwrite(command: string): boolean {
  const cmd = command.toLowerCase();
  const path = SCREEN_ANALYSIS_IMAGE_PATH.toLowerCase();
  if (!cmd.includes(path)) {
    return false;
  }
  // 阻止常见覆盖/改写固定图片的命令（特别是 screencap）
  return (
    /\bscreencap\b/.test(cmd) ||
    /\bscreenrecord\b/.test(cmd) ||
    /\brm\b/.test(cmd) ||
    /\bmv\b/.test(cmd) ||
    /\bcp\b/.test(cmd) ||
    />\s*\/data\/media\/0\/dcim\/screenanalysis\/screen\.png/.test(cmd)
  );
}

/**
 * 检查“当前这轮用户输入”是否自带图片。
 * 规则：从后往前找最近一条 user 消息，若 content 数组中有 type=image 则视为携带图片。
 */
function latestUserMessageHasImage(messages: unknown[], currentQuestion: string): boolean {
  const normalizedCurrentQuestion = currentQuestion.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    console.log("ruleMatch=== latestUserMessageHasImage i: ", i);
    console.log("ruleMatch=== latestUserMessageHasImage msg: ", msg);
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const typedMsg = msg as { role?: unknown; content?: unknown };
    if (typedMsg.role !== "user") {
      continue;
    }
    if (!Array.isArray(typedMsg.content)) {
      return false;
    }

    const textParts: string[] = [];
    for (const block of typedMsg.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const typedBlock = block as { type?: unknown; text?: unknown };
      if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
        textParts.push(typedBlock.text);
      }
    }
    const messageText = textParts.join("\n");
    console.log("ruleMatch=== messageText: ", messageText);

    // 只判断“当前这轮问题”对应的用户消息，避免把上一轮带图消息误判为本轮。
    if (
      normalizedCurrentQuestion &&
      messageText &&
      !messageText.includes(normalizedCurrentQuestion)
    ) {
      continue;
    }

    return typedMsg.content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const typedBlock = block as {
        type?: unknown;
        image_url?: unknown;
        input_image?: unknown;
      };
      const blockType = typedBlock.type;
      // 兼容多种上游图片块格式：
      // - pi/openclaw 内部常见：type === "image"
      // - OpenAI 兼容输入：type === "image_url"
      // - Responses 风格输入：type === "input_image"
      if (blockType === "image" || blockType === "image_url" || blockType === "input_image") {
        console.log("ruleMatch=== blockType === image_url return true");  
        return true;
      }
      // 部分实现可能未显式 type，但携带了图片字段
      return !!typedBlock.image_url || !!typedBlock.input_image;
    });
  }
  return false;
}

const plugin = (api: any) => {
  const logger = api.logger;
  logger.info("ruleMatch=== Rule matching plugin starting ===");
  
  // 创建带 logger 的 ruleMatcher
  const ruleMatcher = createRuleMatcher(logger);

  // 注册 before_model_resolve hook- 优先级最高！
  api.on(
    "before_model_resolve",
    async (event: any, ctx: any) => {
      logger.info("ruleMatch=== before_model_resolve TRIGGERED ===");
      logger.info("ruleMatch=== Event: " + JSON.stringify(event));
      
      // 先清除之前的匹配结果
      ruleMatchResult = null;
      if (!event.prompt) return undefined;

      // === 截取 prompt，只取最后一个 ] 之后的内容 ===
      let trueUserQuestion = event.prompt;
      const bracketIndex = event.prompt.lastIndexOf("]");
      if (!event.prompt.startsWith("Sender")) {
        return undefined;
      } else if (bracketIndex !== -1) {
        trueUserQuestion = event.prompt.substring(bracketIndex + 1).trim();
      }
      logger.info("ruleMatch=== Original prompt: " + event.prompt);
      logger.info("ruleMatch=== Processed prompt: " + trueUserQuestion);
      
      // === 调用规则匹配模块接口 ===
      logger.info("ruleMatch=== Calling ruleMatcher.match... ===");
      const matchCode = await ruleMatcher.match(trueUserQuestion);
      logger.info("ruleMatch=== ruleMatcher.match code: " + matchCode);
      
      ruleMatchResult = {
        matchCode,
        trueUserQuestion,
      };
      if (ctx?.sessionId) {
        ruleMatchCodeBySessionId.set(String(ctx.sessionId), matchCode);
      }
      if (matchCode === 0) {
        //logger.info("✅ Rule matched! Switching provider to rule-matching (baseUrl=http://localhost:18790)");
        logger.info("ruleMatch=== ✅ Rule matched!ok!!!ok ");
        return {
          providerOverride: "rule-matching",
          modelOverride: "rule-matching-model",
        };
      }
      
      logger.info("ruleMatch=== ❌ No rule matched.");
      return undefined;
    },
    { priority: 9999 } // 优先级最高！
  );
  // 4. 注册 before_prompt_build hook - 用于重构提示词
  api.on(
    "before_prompt_build",
    async (event: any, ctx: any) => {
      logger.info("ruleMatch==== before_prompt_build TRIGGERED ===");
      logger.info("ruleMatch===g before_prompt_build Original prompt: = " + event.prompt);
      
      const code = ruleMatchResult?.matchCode;
      
      if (code !== 0 && code !== 3 && code !== 4) {
        return undefined;
      }
      const q = ruleMatchResult?.trueUserQuestion ?? "";
      
      logger.info("ruleMatch=== before_prompt_build matchCode = " + code);
      logger.info("ruleMatch=== before_prompt_build trueUserQuestion = " + q);
      
      /*const hasUserInputImage = Array.isArray(event?.messages)
        ? latestUserMessageHasImage(event.messages, q)
        : false;
      const sessionId = ctx?.sessionId ? String(ctx.sessionId) : undefined;

      // 新需求：如果本轮用户输入本身携带图片，则即使规则为 3/4 也按 -1 处理（不改提示词）
      if (hasUserInputImage && (code === 3 || code === 4)) {
        logger.info("ruleMatch=== Current user input has image; force treating rule code as -1 and skip prompt override");
        ruleMatchResult = {
          matchCode: -1,
          trueUserQuestion: q,
        };
        if (sessionId) {
          ruleMatchCodeBySessionId.set(sessionId, -1);
        }
        return undefined;
      }*/


      //在 before_model_resolve 中已判定 matchCode；此处改 system + prependContext（后者用于触发本回合固定图的多模态加载）
      if (code === 0) {
        logger.info("ruleMatch=== *** Rule code 0: simple system prompt ===");
        return { systemPrompt: SIMPLE_ASSISTANT_PROMPT };
      }
      if (code === 4) {
        /* const pruned = Array.isArray(event?.messages)
          ? pruneImagesFromSessionMessages(event.messages)
          : 0;
        logger.info("ruleMatch=== === Rule code 4: pruned history images:" + pruned); */
        logger.info("ruleMatch=== ***  Rule code 4: screen-analysis analyze prompt ===");
        return {
          // systemPrompt: buildScreenAnalysisAnalyzePrompt(q),
          prependContext: buildFixedScreenAnalysisPrependContext()
        };
      }
      if (code === 3) {
         /*const pruned = Array.isArray(event?.messages)
          ? pruneImagesFromSessionMessages(event.messages)
          : 0;
         logger.info("ruleMatch=== Rule code 3: pruned history images:" + pruned);*/
        logger.info("ruleMatch=== ***  Rule code 3: screen-analysis operate prompt ===");
        return {
          //systemPrompt: buildScreenAnalysisOperatePrompt(q),
          prependContext: buildFixedScreenOperatePrependContext()
        };
      }

     logger.info("ruleMatch=== No prompt override (code not 0/3/4 or no result) ===");
      return undefined;
    },
    { priority: 9999 } // 优先级最高！
  );
  
  //注册 before_tool_call hook - 在 3/4 场景硬拦截对固定图片的覆盖
  api.on(
    "before_tool_call",
    async (event: any, ctx: any) => {
      const sessionId = ctx?.sessionId ? String(ctx.sessionId) : undefined;
      const code =
        (sessionId ? ruleMatchCodeBySessionId.get(sessionId) : undefined) ??
        ruleMatchResult?.matchCode;
        
      logger.info("ruleMatch==== before_tool_call TRIGGERED === code = " + code);    
        
      if (code !== 3 && code !== 4) {
        return undefined;
      }
      
      logger.info("ruleMatch==== before_tool_call TRIGGERED === event?.toolName = " + event?.toolName);    

      if (event?.toolName !== "exec") {
        return undefined;
      }
      const command =
        typeof event?.params?.command === "string" ? String(event.params.command) : "";
      if (!command) {
        return undefined;
      }

      logger.info("ruleMatch==== before_tool_call TRIGGERED === command = " + command);    
      
      if (shouldBlockScreenImageOverwrite(command)) {
        logger.info("ruleMatch=== Blocked exec overwrite for fixed screen image path. command =" + command);
        return {
          block: true,
          blockReason:
            "禁止用 screencap 等命令覆盖设备上的固定图片 /data/media/0/DCIM/ScreenAnalysis/screen.png。若需给网关加载像素，请使用 cp 将该文件复制到工作区 ./screen_analysis.png（不要把其它内容覆盖进 DCIM 原路径）。",
        };
      }
      return undefined;
    },
    { priority: 9999 },
  );

  //清理会话级匹配状态，避免跨会话串扰
  api.on("agent_end", async (_event: any, ctx: any) => {
      
    logger.info("ruleMatch==== agent_end TRIGGERED === ");      
    if (ctx?.sessionId) {
      ruleMatchCodeBySessionId.delete(String(ctx.sessionId));
    }
  });

  logger.info("ruleMatch=== Rule matching plugin started ===");
};

export default plugin;
/* Ended by Cursor 10026780.A25624033 20260326250000046 */
