
/* Started by Cursor 10026780.A25624033 20260326250000046 */
import express from "express";
import http from "node:http";

const OPENAI_URL = "https://aimoe-test.ztems.com/aimoe/service/api/openclaw/checkRule";

// 模拟规则匹配接口
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

const plugin = (api: any) => {
  const logger = api.logger;
  logger.info("=== Rule matching plugin starting ===");
  
  // 创建带 logger 的 ruleMatcher
  const ruleMatcher = createRuleMatcher(logger);

  // 注册 before_model_resolve hook（方案A）- 优先级最高！
  api.on(
    "before_model_resolve",
    async (event: any, ctx: any) => {
      logger.info("=== before_model_resolve TRIGGERED ===");
      logger.info("Event: " + JSON.stringify(event));
      
      if (!event.prompt) return undefined;

      // === 截取 prompt，只取最后一个 ] 之后的内容 ===
      let trueUserQuestion = event.prompt;
      const bracketIndex = event.prompt.lastIndexOf("]");
      if (!event.prompt.startsWith("Sender")) {
        return undefined;
      } else if (bracketIndex !== -1) {
        trueUserQuestion = event.prompt.substring(bracketIndex + 1).trim();
      }
      logger.info("=== Original prompt: " + event.prompt);
      logger.info("=== Processed prompt: " + trueUserQuestion);
      
      // === 调用规则匹配模块接口 ===
      logger.info("=== Calling ruleMatcher.match... ===");
      const matchResult = await ruleMatcher.match(trueUserQuestion);
      logger.info("=== ruleMatcher.match result: " + JSON.stringify(matchResult));
      
      if (matchResult.matched) {
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
