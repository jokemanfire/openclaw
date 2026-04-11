
# Rule Matching Plugin 开发说明

## 重要：插件不需要预先编译！

OpenClaw 使用 **jiti (Just-In-Time TypeScript Loader)** 来直接加载 `.ts` 插件文件，**不需要预先编译**。

### 为什么 `pnpm build` 不会报错？

1. `pnpm build` 只编译 OpenClaw 核心代码（`src/` 目录）
2. `extensions/` 目录不在核心的 `tsconfig.json` 编译范围内
3. 插件的 TypeScript 错误只会在**运行时加载插件**时才会报错

### 如何验证插件是否有错误？

**不要**在 `extensions/rule-matching/` 下运行 `npm run build`，而是：

#### 方法 1：运行 OpenClaw 并查看日志

```bash
pnpm dev
# 或
pnpm gateway:dev
```

查看日志中是否有插件加载错误。

#### 方法 2：使用 OpenClaw 的 TypeScript 检查

在项目根目录运行：

```bash
pnpm tsgo
```

这会检查整个项目（包括 `extensions/`）的 TypeScript 类型错误。

---

## 插件文件结构

```
extensions/rule-matching/
├── package.json          # 插件包定义（可选，主要用于依赖管理）
├── HOOK.md               # 插件元数据（必须）
├── README.md             # 项目说明
├── 使用说明.md            # 本文档
└── src/
    ├── index.ts          # 插件入口（必须，直接写 TypeScript）
    ├── types.ts          # 类型定义
    ├── rule-matcher.ts   # 规则匹配逻辑
    └── provider.ts       # 工具函数
```

### 关键点

1. **`src/index.ts` 直接写 TypeScript**：不需要编译成 `.js`
2. **`HOOK.md` 必须存在**：定义插件元数据和事件
3. **不需要 `dist/` 目录**：jiti 直接加载 `.ts`

---

## HOOK.md 格式

```markdown
---
always: true
hookKey: rule-matching
emoji: 🎯
events: ["before_model_resolve", "before_prompt_build", "agent_end"]
---
# Rule Matching Plugin

插件描述...
```

**重要字段**：
- `events`: 声明插件处理哪些 Hook 事件

---

## package.json（可选）

如果你需要给插件添加依赖，可以创建 `package.json`，但这不是必须的。插件主要通过 jiti 加载，不依赖 npm 包结构。

---

## 快速测试插件

1. 确保插件在 `extensions/rule-matching/` 目录下
2. 在 `~/.openclaw/openclaw.json` 中启用插件：
   ```json
   {
     "plugins": {
       "rule-matching": {
         "enabled": true
       }
     }
   }
   ```
3. 运行 OpenClaw：
   ```bash
   pnpm gateway:dev
   ```
4. 查看日志，搜索 "Rule matching" 相关输出

---

## 调试技巧

### 查看插件是否被加载

在日志中搜索：
- "Rule matching plugin initializing..." - 插件初始化成功
- "Rule matched" - 规则匹配成功
- "No rule matched" - 规则未匹配，走正常流程

### 常见错误

1. **插件未加载**：
   - 检查 `HOOK.md` 是否存在
   - 检查配置中是否启用了插件

2. **TypeScript 运行时错误**：
   - 检查 `src/index.ts` 等文件的语法
   - 运行 `pnpm tsgo` 检查类型错误

3. **Hook 未触发**：
   - 检查 `HOOK.md` 中的 `events` 数组是否包含正确的事件名
   - 检查代码中 `api.on()` 的事件名是否正确

---

## 下一步

1. 移除我们之前添加的错误代码 `&amp;&amp;&amp;`
2. 运行 `pnpm tsgo` 检查类型错误
3. 启动 OpenClaw 测试插件功能
