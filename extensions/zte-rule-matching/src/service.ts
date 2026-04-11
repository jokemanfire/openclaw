
/* Started by Cursor 10026780.A25624033 20260324250000009 */
import express from "express";

// 全局日志对象
let logger: any = null;

// 存储最近的匹配结果（基于 sessionKey）
const matchResultCache = new Map();

export function setMatchResultCache(sessionKey: string, result: any) {
  matchResultCache.set(sessionKey, result);
}

export function getMatchResultCache(sessionKey: string) {
  return matchResultCache.get(sessionKey);
}

export function clearMatchResultCache(sessionKey: string) {
  matchResultCache.delete(sessionKey);
}

// 直接定义响应映射，最简单的方式
const RESPONSE_MAP: Record<string, string> = {
  "打开蓝牙": "已为您打开蓝牙设备。",
  "关闭蓝牙": "已为您关闭蓝牙设备。",
};

// 创建 Express 应用
function createRuleMatchingServer() {
  const app = express();
  
  console.log("caogang createRuleMatchingServer");

  // 先记录所有请求（不管路径和方法）
  app.use((req, res, next) => {
    console.log("=== Rule matching service received ANY request ===");
    console.log(`req.method: ${req.method}`);
    console.log(`req.url: ${req.url}`);
    console.log("req.headers:", req.headers);
    next();
  });

  // 添加 CORS 头
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // 先解析 JSON（正常流程）
  app.use(express.json());

  // 然后记录请求体用于调试
  app.use((req, res, next) => {
    if (req.body) {
      console.log("=== Rule matching service request body ===");
      console.log("req.body:", JSON.stringify(req.body, null, 2));
    }
    next();
  });

  // OpenAI 兼容的聊天补全接口
  app.post("/v1/chat/completions", (req, res) => {
    try {
      // 尝试多种方式获取用户消息
      let userMessage = "";

      // 方式 1: 标准 OpenAI 格式
      if (req.body.messages && Array.isArray(req.body.messages)) {
        console.log("Found messages array, length:", req.body.messages.length);
        const lastUserMessage = req.body.messages
          .filter((m: any) => m && m.role === "user")
          .pop();
        if (lastUserMessage) {
          console.log("Last user message object:", lastUserMessage);
          if (typeof lastUserMessage.content === "string") {
            userMessage = lastUserMessage.content;
          } else if (Array.isArray(lastUserMessage.content)) {
            // 处理多模态内容
            const textPart = lastUserMessage.content.find((p: any) => p && p.type === "text");
            if (textPart && textPart.text) {
              userMessage = textPart.text;
            }
          }
        }
      }

      // 方式 2: 直接从 prompt 字段
      if (!userMessage && req.body.prompt) {
        userMessage = req.body.prompt;
        console.log("Got message from prompt field:", userMessage);
      }

      console.log("Final userMessage extracted:", JSON.stringify(userMessage));
      console.log("userMessage type:", typeof userMessage);
      console.log("userMessage length:", userMessage?.length);

      // 最简单的匹配方式：直接查 map
      let responseText = "规则匹配成功";

      if (userMessage && typeof userMessage === "string") {
        // 先输出所有可能的 key 进行调试
        console.log("Checking RESPONSE_MAP keys:", Object.keys(RESPONSE_MAP));
        console.log("Checking against userMessage:", JSON.stringify(userMessage));
        
        for (const [key, value] of Object.entries(RESPONSE_MAP)) {
          console.log(`Checking if userMessage includes "${key}":`, userMessage.includes(key));
          if (userMessage.includes(key)) {
            responseText = value;
            console.log("✅ Matched rule:", key, "->", value);
            break;
          }
        }
      } else {
        console.log("❌ userMessage is empty or not a string");
      }

      console.log("Final response text:", JSON.stringify(responseText));

      // 构建 OpenAI 兼容的响应
      const response = {
        id: `rule-match-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.body.model || "rule-matching-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: responseText,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };

      console.log("Returning response:", JSON.stringify(response, null, 2));

      res.json(response);
    } catch (error) {
      console.log("❌ Rule matching service error:", error);
      res.status(500).json({
        error: {
          message: "Rule matching service error",
          type: "internal_server_error",
        },
      });
    }
  });

  // OpenAI 兼容的模型列表接口
  app.get("/v1/models", (req, res) => {
    res.json({
      object: "list",
      data: [
        {
          id: "rule-matching-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "openclaw-rule-matching",
        },
      ],
    });
  });

  // 健康检查接口
  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "rule-matching" });
  });

  // 简单测试接口（用浏览器访问 http://localhost:18790/test）
  app.get("/test", (req, res) => {
    console.log("=== Rule matching service /test endpoint called ===");
    res.send(`
      <html>
        <body>
          <h1>Rule Matching Service is Working!</h1>
          <p>If you can see this, the service is running correctly.</p>
          <p>Time: ${new Date().toISOString()}</p>
        </body>
      </html>
    `);
  });

  return app;
}

// 启动服务
let server: any = null;

export async function startRuleMatchingService(params: {
  port: number;
  matcher: any;
  log: any;
}): Promise<void> {
  logger = params.log;

  console.log("=== Starting rule matching service ===");
  console.log("Response map:", RESPONSE_MAP);
  console.log("Response map keys:", Object.keys(RESPONSE_MAP));

  if (server) {
    console.log("Rule matching service already running");
    return;
  }

  const app = createRuleMatchingServer();

  return new Promise((resolve, reject) => {
    // 监听所有网络接口 (0.0.0.0) 而不只是 localhost
    server = app.listen(params.port, "0.0.0.0", () => {
      console.log(`Rule matching service started on http://0.0.0.0:${params.port}`);
      console.log(`Also accessible at http://localhost:${params.port}`);
      resolve();
    });

    server.on("error", (error: any) => {
      console.log("Rule matching service failed to start", { error: String(error) });
      reject(error);
    });
  });
}

export async function stopRuleMatchingService(): Promise<void> {
  if (!server) {
    console.log("Rule matching service not running");
    return;
  }

  return new Promise((resolve) => {
    server.close(() => {
      console.log("Rule matching service stopped");
      server = null;
      resolve();
    });
  });
}
/* Ended by Cursor 10026780.A25624033 20260324250000009 */
