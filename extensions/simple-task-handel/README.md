## 插件功能开发背景

这个插件开发背景，终端项目（手机）有很多简单场景，比如问天气，定饭店，定闹钟
定日程。原先采用一些固定编排来做

后来使用了 openclaw 做，但因为使用了 skill 技能，比如查天气技能，订饭店技能
由于技能的渐进式披露机制和大模型的速度，openclaw 的系统提示词又很大，导致这些简单场景，openclaw 返回的时间比较长。成为了痛点，但如果只用以前的机制，对于一般场景的泛化效果有差，所以如果还是使用 openclaw

## 解决方案

终端有种机制会对用户发的 message 进行分类，可以默认进来的消息，都是简单任务场景。
在简单任务下，我们需要满足快速响应，需要做以下事情：

- 裁剪上下文，目前采用自定义的 systemPrompt
- 配置文件关闭大量工具
- 对于用户的简单任务场景，
- 使用小参数的模型，限制 maxTokens，关闭思考/推理
- 不需要保留太长轮次的历史消息，简单任务应该都是各自比较独立的对话

## todo

- 确认有没有 hook 可以得到该 agent 可以访问的 skills 列表，和说明书路径，对应 skill 的 frontmatter 信息
- 获取用户当前轮次的 message，通过 rag 或 nlu 对用户 message 场景分类，以匹配对应的 skill 或 tool，需要确认分类效果
- 基于对用户 message 进行 rag 或 nlu 分类的结果把命中的 skill 和 tool 的 schema 添加在 message 的前缀，通过可数的文本结构区分开；然后 LLM 可以直接产生 tool use，避免渐进式披露的多一轮交
- 对于公司 maas 平台提供的小模型，千问的，要兼容其思考开关的参数
- 当前轮次的工具，已经出现在历史消息中，可以不用再重复添加工具/技能说明，需要有关键的分界符和结构化语言（特殊标记）

## 生效配置

- 仅对 agent id 为 simple_task_agent 的 agent 生效，simple_task_agent

```json
{
  "id": "simple_task_agent",
  "workspace": "/home/0668000452/.openclaw/workspace-simpletask",
  "thinkingDefault": "off",
  "fastModeDefault": true,
  "verboseDefault": "off",
  "contextTokens": 16000,
  "identity": {
    "name": "快捷助手",
    "theme": "efficient assistant",
    "emoji": "⚡"
  },
  "tools": {
    "allow": ["read", "write", "edit", "exec", "process"],
    "deny": [
      "web_search",
      "web_fetch",
      "agents_list",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_yield",
      "sessions_spawn",
      "subagents",
      "message",
      "cron",
      "nodes",
      "canvas",
      "web_fetch_coclaw",
      "web_search_coclaw",
      "tenant_manage",
      "update_plan",
      "plan_create",
      "plan_exec",
      "plan_framework_select",
      "session_status",
      "enter-plan-mode",
      "exit-plan-mode",
      "image_generate",
      "music_generate",
      "video_generate",
      "pdf",
      "tts",
      "discord",
      "whatsapp_login",
      "todo",
      "ask",
      "memory_search",
      "memory_set",
      "memory_delete"
    ]
  }
}
```

- 配置文件要开启该插件 plugins.entries 设置

```json
"simple-task-handel": {
    "enabled": true
}
```

## 调试日志

插件内置了诊断日志，通过环境变量 `SIMPLE_TASK_DEBUG` 控制是否输出：

```bash
# 开启调试日志
SIMPLE_TASK_DEBUG=1 node openclaw.mjs gateway

# 或 export 后启动
export SIMPLE_TASK_DEBUG=1
pnpm openclaw gateway
```

开启后会打印每次请求的 agent 匹配、systemPrompt 覆盖、skills 缓存等诊断信息。

- 模型使用小模型，关闭思考，例如

```bash
curl --location --request POST 'https://maas-apigateway.dt.zte.com.cn/model/qwen36-27b-fp8/v1/chat/completions' \
--header 'Authorization: Bearer 找李夏隆要' \
--header 'Content-Type: application/json' \
--data-raw '{
    "model": "Qwen3.6-27B-FP8",
    "messages": [
        {
            "role": "user",
            "content": "你是谁"
        }
    ],
    "chat_template_kwargs": {
        "enable_thinking": true
    },
    "max_tokens": 2048
}'
```
