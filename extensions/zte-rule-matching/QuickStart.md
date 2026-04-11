
# Rule Matching Plugin - 快速开始（方案A：自定义 Provider + 本地服务）

## ✅ 已完成

插件文件已全部创建完成！使用方案A（自定义 Provider + 本地服务）。

## 📁 文件结构

```
extensions/rule-matching/
├── package.json              # 插件包定义（包含 express 依赖）
├── tsconfig.json             # TypeScript 配置（仅用于 IDE 提示）
├── HOOK.md                   # 插件元数据（必须）
├── README.md                 # 项目说明
├── 快速开始.md               # 本文档
├── 使用说明.md               # 详细使用说明
├── 插件开发说明.md           # 开发注意事项
└── src/
    ├── index.ts              # 插件入口（核心逻辑，方案A）
    ├── types.ts              # 类型定义
    ├── rule-matcher.ts       # 规则匹配核心逻辑
    ├── provider.ts           # 结果存储工具
    └── service.ts            # 本地 Express 服务（OpenAI 兼容 API）
```

## 🎯 重要：插件不需要编译！

OpenClaw 使用 **jiti (Just-In-Time TypeScript Loader)** 直接加载 `.ts` 文件，**不需要预先编译**。

- ❌ 不要在 `extensions/rule-matching/` 下运行 `npm run build`
- ❌ 不需要 `dist/` 目录
- ✅ 直接写 `.ts` 文件即可

## 🚀 使用步骤（方案A：自定义 Provider + 本地服务）

### 1. 安装插件依赖

在插件目录下运行：

```bash
cd extensions/rule-matching
npm install
```

这会安装 `express` 等依赖。

### 2. 更新 openclaw.json 配置

在 `~/.openclaw/openclaw.json` 中添加（参考 `../../openclaw-with-rule-matching-plugin.md`）：

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "rule-matching": {
        "enabled": true
      }
    }
  },
  "models": {
    "providers": {
      "rule-matching": {
        "baseUrl": "http://localhost:18790",
        "apiKey": "dummy-key",
        "api": "openai-completions",
        "models": [...]
      }
    }
  }
}
```

**重要**：方案A需要添加 `rule-matching` provider 配置，指向本地服务 `http://localhost:18790`！

### 3. 运行 TypeScript 类型检查（可选但推荐）

在项目根目录运行：

```bash
pnpm tsgo
```

这会检查整个项目（包括插件）的类型错误。

### 4. 启动 OpenClaw

```bash
pnpm gateway:dev
```

### 5. 查看日志

在日志中搜索以下关键词验证插件是否正常工作：

- ✅ "Rule matching plugin initializing..." - 插件初始化成功
- ✅ "Starting rule matching service..." - 正在启动本地服务
- ✅ "Rule matching service started on port 18790" - 本地服务启动成功
- ✅ "Rule matched, switching to rule-matching provider" - 规则匹配成功，切换 provider
- ✅ "No rule matched" - 规则未匹配，走正常流程

### 6. 验证本地服务

可以在浏览器或 curl 中访问：

```bash
curl http://localhost:18790/health
```

应该返回：`{"status":"ok","service":"rule-matching"}`

### 7. 测试

- 输入 "打开蓝牙" → 应该返回 "已为您打开蓝牙设备。"
- 输入 "关闭蓝牙" → 应该返回 "已为您关闭蓝牙设备。"
- 输入 "你好" → 应该走正常 LLM 流程

## ⚙️ 自定义规则

编辑 `src/rule-matcher.ts` 中的 `createDefaultRules()` 函数：

```typescript
export function createDefaultRules(): RuleDefinition[] {
  return [
    {
      id: "open-bluetooth",
      pattern: "打开蓝牙",
      handler: () =&gt; ({
        matched: true,
        toolName: "open_bluetooth",
        toolParams: { enabled: "true" },
        responseText: "已为您打开蓝牙设备。",
      }),
    },
    // 添加你的自定义规则...
    {
      id: "your-rule",
      pattern: /你的正则表达式/, // 或字符串 "精确匹配"
      handler: (message, params) =&gt; ({
        matched: true,
        responseText: "你的响应",
      }),
    },
  ];
}
```

## 🐛 故障排除

### 插件没有加载？

1. 检查 `extensions/rule-matching/HOOK.md` 是否存在
2. 检查 `~/.openclaw/openclaw.json` 中是否启用了插件
3. 查看日志中是否有 "Rule matching plugin initializing..."

### 本地服务没有启动？

1. 检查日志中是否有 "Starting rule matching service..."
2. 检查日志中是否有 "Rule matching service started on port 18790"
3. 检查 18790 端口是否被其他程序占用：
   ```bash
   netstat -ano | findstr :18790  # Windows
   lsof -i :18790                    # Mac/Linux
   ```
4. 如果端口被占用，可以在 `src/index.ts` 中修改 `RULE_MATCHING_PORT` 常量

### 规则匹配没有生效？

1. 检查日志中是否有 "Rule matched, switching to rule-matching provider"
2. 检查 `HOOK.md` 中的 `events` 数组是否包含 `"before_model_resolve"`
3. 检查配置中是否添加了 `rule-matching` provider
4. 运行 `pnpm tsgo` 检查类型错误

### 本地服务连接错误？

1. 确保本地服务已启动（检查日志）
2. 测试 `http://localhost:18790/health` 是否可访问
3. 检查 `baseUrl` 是否配置正确（`http://localhost:18790`）
4. 检查防火墙设置

### TypeScript 错误？

1. 插件的 TypeScript 错误只在运行时加载时才会报错
2. 运行 `pnpm tsgo` 可以提前发现类型错误
3. 确保已运行 `npm install` 安装依赖

## 📝 方案说明（方案A：自定义 Provider + 本地服务）

### 完整流程

```
1. Gateway 启动
   ↓
2. 插件注册 Service，启动本地服务 http://localhost:18790
   ↓
3. 用户输入消息
   ↓
4. before_model_resolve Hook 触发
   ├─ 匹配成功
   │   ↓
   │   返回 providerOverride: "rule-matching"
   │   返回 modelOverride: "rule-matching-model"
   │   ↓
   │   切换到 rule-matching provider
   │   ↓
   │   调用 http://localhost:18790/v1/chat/completions
   │   ↓
   │   本地服务执行规则匹配，返回 OpenAI 兼容格式响应
   │
   └─ 匹配失败
       ↓
       使用原始 provider（ark）调用 LLM
```

### 本地服务 API

插件启动时会自动启动一个 Express 服务在 `http://localhost:18790`，提供：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI 兼容的聊天补全接口 |
| `/v1/models` | GET | 模型列表接口 |
| `/health` | GET | 健康检查接口 |

### 说明

- ✅ **完全零源码修改**：不修改 OpenClaw 核心代码
- ✅ **独立本地服务**：Express 服务处理规则匹配
- ✅ **OpenAI API 兼容**：完全兼容 OpenAI API 格式
- ✅ **会话历史自动同步**：利用 OpenClaw 原生机制
- ⚠️ **需要安装依赖**：需要在插件目录运行 `npm install`
- ⚠️ **端口占用**：确保 18790 端口未被占用

---

## 📚 相关文档

- `使用说明.md` - 详细使用说明
- `插件开发说明.md` - 开发注意事项
- `../../openclaw-with-rule-matching-plugin.md` - 配置文件示例（方案A）
