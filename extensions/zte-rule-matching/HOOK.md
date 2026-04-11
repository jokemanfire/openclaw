
<!-- Started by Cursor 10026780.A25624033 2026032420000004 -->
---
always: true
hookKey: rule-matching
emoji: 🎯
events: ["before_model_resolve", "agent_end"]
---
# Rule Matching Plugin

在 before_model_resolve 阶段进行规则匹配，匹配成功则切换到 rule-matching provider，调用本地规则匹配服务返回结果。

## 功能特性

- 启动本地 OpenAI 兼容 API 服务 (http://localhost:18790)
- 支持字符串精确匹配
- 支持正则表达式匹配
- 自动同步会话历史
- 零源码修改，纯插件实现

## 预定义规则

- "打开蓝牙" → 返回 "已为您打开蓝牙设备。"
- "关闭蓝牙" → 返回 "已为您关闭蓝牙设备。"
<!-- Ended by Cursor 10026780.A25624033 2026032420000004 -->
