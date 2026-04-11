
/* Started by Cursor 10026780.A25624033 20260326250000046 */
import express from "express";
import http from "node:http";

// 响应映射（临时保留，方便测试）
const RESPONSE_MAP: Record<string, string> = {
  "打开蓝牙": "已为您打开蓝牙设备。",
  "关闭蓝牙": "已为您关闭蓝牙设备。",
};

// 创建 Express 服务器（临时保留，用于验证服务启动）
/*let server: http.Server | null = null;

function createServer() {
  const app = express();
  
  app.use((req, res, next) => {
    console.log("=== SERVICE RECEIVED REQUEST ===");
    console.log(req.method, req.url);
    console.log("Headers:", req.headers);
    next();
  });
  
  app.use(express.json());
  
  // 添加 /v1 前缀的路由（临时保留）
  app.get("/v1/models", (req, res) => {
    console.log("=== /v1/models called ===");
    res.json({
      object: "list",
      data: [
        {
          id: "rule-matching-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "openclaw",
        },
      ],
    });
  });
  
  app.post("/v1/chat/completions", (req, res) => {
    console.log("=== /v1/chat/completions called ===");
    console.log("Body:", req.body);
    console.log("Accept header:", req.headers.accept);
    
    // 找到最后一条用户消息
    let userMessage = "";
    if (req.body.messages &amp;&amp; Array.isArray(req.body.messages)) {
      const last = req.body.messages.filter((m: any) => m.role === "user").pop();
      if (last &amp;&amp; typeof last.content === "string") {
        userMessage = last.content;
      } else if (last &amp;&amp; Array.isArray(last.content)) {
        for (const block of last.content) {
          if (block.type === "text" &amp;&amp; typeof block.text === "string") {
            userMessage = block.text;
          }
        }
      }
    }
    
    console.log("User message:", userMessage);
    
    // 规则匹配
    let responseText = "规则匹配成功";
    for (const [key, value] of Object.entries(RESPONSE_MAP)) {
      if (userMessage.includes(key)) {
        responseText = value;
        break;
      }
    }
    
    console.log("Response text:", responseText);
    
    // 检查是否是 SSE 请求
    const isSSE = req.headers.accept?.includes("text/event-stream");
    console.log("Is SSE request?", isSSE);
    
    if (isSSE) {
      console.log("Returning SSE response...");
      // 返回 SSE 格式
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      
      // 发送 chunk
      const chunk1 = `data: ${JSON.stringify({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.body.model || "rule-matching-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: responseText },
          finish_reason: null,
        }],
      })}\n\n`;
      res.write(chunk1);
      
      const chunk2 = `data: ${JSON.stringify({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.body.model || "rule-matching-model",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop",
        }],
      })}\n\n`;
      res.write(chunk2);
      
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      console.log("Returning non-SSE response...");
      // 返回普通 JSON 响应
      res.json({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.body.model || "rule-matching-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  });
  
  return app;
}
*/

/* Started by Cursor 10331645 20260326173245827 */
const OPENAI_URL = "https://aimoe-test.ztems.com/aimoe/service/api/openclaw/checkRule";

// 模拟规则匹配接口
/* Started by Cursor 10331645 20260327123456789 */
/* Started by Cursor 10331645 20260330123456789 */
/* Started by Cursor 10331645 20260330123456791 */
const createRuleMatcher = (logger: any) => ({
  match: async (prompt: string): Promise<{ matched: boolean }> => {
    logger.info("=== RuleMatcher.match called with prompt: " + prompt);
    logger.info("=== Request URL: " + OPENAI_URL);
    
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
            logger.info("=== HTTP Status ===");
            logger.info(String(res.statusCode));
            logger.info("=== Raw Response ===");
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
      const responseText = await Promise.race([httpRequestPromise, timeoutPromise]);
/* Ended by Cursor 10331645 20260327123456789 */
      
      // 根据响应判断是否匹配
      if (responseText.trim() === "0") {
        logger.info("✅ RuleMatcher.match: matched!");
        return { matched: true };
      } else {
        logger.info("❌ RuleMatcher.match: no match.");
        return { matched: false };
      }
      
    } catch (error) {
      logger.error("请求异常: " + String(error));
      logger.info("❌ RuleMatcher.match: no match due to error.");
      return { matched: false };
    }
  }
});
/* Ended by Cursor 10331645 20260330123456789 */
/* Ended by Cursor 10331645 20260326173245827 */

const plugin = (api: any) => {
  /* Started by Cursor 10331645 20260330123456790 */
  const logger = api.logger;
  logger.info("=== Rule matching plugin starting ===");
  
  // 创建带 logger 的 ruleMatcher
  const ruleMatcher = createRuleMatcher(logger);
  /* Ended by Cursor 10331645 20260330123456790 */

  // 1. 启动本地服务（临时保留，用于验证服务启动）
  /*api.registerService({
    id: "rule-matching-service",
    start: async (ctx: any) => {
      console.log("Starting rule matching service on port 18790...");
      const app = createServer();
      server = app.listen(18790, "0.0.0.0", () => {
        console.log("Rule matching service started on http://0.0.0.0:18790");
        console.log("Base URL for provider: http://localhost:18790 (NO /v1 at the end!)");
        
        // === 立即用 http 模块手动测试！（临时保留） ===
        console.log("\n=== Testing service with direct http.request ===");
        const testReq = http.request(
          {
            hostname: "localhost",
            port: 18790,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer dummy-key",
            },
          },
          (testRes) => {
            console.log("Test response status code:", testRes.statusCode);
            let data = "";
            testRes.on("data", (chunk) => (data += chunk));
            testRes.on("end", () => {
              console.log("Test response body:", data);
              if (testRes.statusCode === 200) {
                console.log("=== Direct http test SUCCESSFUL ===");
              } else {
                console.error("=== Direct http test FAILED ===");
              }
            });
          }
        );
        testReq.on("error", (err) => {
          console.error("Test request error:", err);
        });
        testReq.write(
          JSON.stringify({
            model: "rule-matching-model",
            messages: [{ role: "user", content: "关闭蓝牙" }],
          })
        );
        testReq.end();
      });
    },
    stop: async () => {
      if (server) {
        server.close();
        server = null;
      }
    },
  });

  // 2. 注册 provider（临时保留，用于验证）
  api.registerProvider({
    id: "rule-matching",
    label: "Rule Matching",
    models: {
      baseUrl: "http://localhost:18790",
      apiKey: "dummy-key",
      api: "openai-completions",
      models: [
        {
          id: "rule-matching-model",
          name: "Rule Matching Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 2048,
        },
      ],
    },
    auth: [
      {
        id: "rule-matching-auth",
        label: "Rule Matching Auth",
        kind: "api_key",
        run: async () => ({
          profiles: [{ profileId: "default", credential: { apiKey: "dummy-key" } }],
        }),
      },
    ],
  });
   */
   
  // 3. 注册 before_model_resolve hook（方案A）- 优先级最高！
  api.on(
    "before_model_resolve",
    async (event: any, ctx: any) => {
      logger.info("=== before_model_resolve TRIGGERED ===");
      logger.info("Event: " + JSON.stringify(event));
      
      if (!event.prompt) return undefined;
      
      /* Started by Cursor 10331645 20260326173245827 */
      // === 截取 prompt，只取最后一个 ] 之后的内容 ===
      let trueUserQuestion = event.prompt;
      const bracketIndex = event.prompt.lastIndexOf("]");
      if (bracketIndex !== -1) {
        trueUserQuestion = event.prompt.substring(bracketIndex + 1).trim();
      }
      logger.info("=== Original prompt: " + event.prompt);
      logger.info("=== Processed prompt: " + trueUserQuestion);
      /* Ended by Cursor 10331645 20260326173245827 */
      
      // === 调用规则匹配模块接口 ===
      logger.info("=== Calling ruleMatcher.match... ===");
      const matchResult = await ruleMatcher.match(trueUserQuestion);
      logger.info("=== ruleMatcher.match result: " + JSON.stringify(matchResult));
      
      if (matchResult.matched) {
        //logger.info("✅ Rule matched! Switching provider to rule-matching (baseUrl=http://localhost:18790)");
        logger.info("✅ Rule matched! ");
        return {
          providerOverride: "rule-matching",
          modelOverride: "rule-matching-model",
        };
      }
      
      logger.info("❌ No rule matched.");
      return undefined;
    },
    { priority: 9999 } // 优先级最高！
  );

  logger.info("=== Rule matching plugin started ===");
};

export default plugin;
/* Ended by Cursor 10026780.A25624033 20260326250000046 */
