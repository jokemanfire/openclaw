
# 故障诊断指南

## 问题：Connection error

如果你看到 `Connection error`，请按以下步骤诊断：

---

## 步骤 1：验证本地服务是否真的在运行

### 方法 A：使用 curl 测试

在新的终端窗口运行：

```bash
curl http://localhost:18790/health
```

**预期结果**：
```json
{"status":"ok","service":"rule-matching"}
```

**如果连接被拒绝**：
- 检查日志中是否有 "Rule matching service started on port 18790"
- 检查 18790 端口是否被占用：
  ```bash
  netstat -ano | findstr :18790  # Windows
  lsof -i :18790                    # Mac/Linux
  ```

### 方法 B：使用浏览器测试

在浏览器访问：
```
http://localhost:18790/health
```

---

## 步骤 2：测试聊天补全接口

### 使用 curl 模拟 OpenClaw 的请求

```bash
curl -X POST http://localhost:18790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy-key" \
  -d '{
    "model": "rule-matching-model",
    "messages": [
      {"role": "user", "content": "关闭蓝牙"}
    ]
  }'
```

**预期结果**：
```json
{
  "id": "rule-match-...",
  "object": "chat.completion",
  "created": ...,
  "model": "rule-matching-model",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "已为您关闭蓝牙设备。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

---

## 步骤 3：检查 OpenClaw 日志

在 OpenClaw 日志中搜索以下内容：

### ✅ 正常工作的日志

```
Rule matching plugin initializing...
Starting rule matching service...
Rule matching service started on port 18790
Rule matching plugin initialized
```

### 用户输入时的日志

```
Rule matching hook triggered
Rule matched, switching to rule-matching provider
```

---

## 步骤 4：可能的问题和解决方案

### 问题 1：服务只绑定到 localhost，OpenClaw 无法连接

**解决方案**：
我们已经更新了 `service.ts`，现在服务绑定到 `0.0.0.0`（所有网络接口），而不只是 `localhost`。

### 问题 2：Authorization header 验证

OpenClaw 发送请求时会带上 `Authorization: Bearer dummy-key` header。

我们的服务现在已经忽略 Authorization header，任何值都可以。

### 问题 3：CORS 问题

我们的服务已经添加了 CORS 头，允许跨域请求。

---

## 步骤 5：临时测试方案

如果本地服务方案一直有问题，可以临时切换回**方案B（系统提示注入）**：

1. 恢复 `src/index.ts` 到方案B版本
2. 从配置中移除 `rule-matching` provider
3. 重启 OpenClaw

---

## 收集更多诊断信息

如果以上步骤都无法解决问题，请收集以下信息：

1. OpenClaw 完整日志
2. `curl http://localhost:18790/health` 的输出
3. `curl -X POST http://localhost:18790/v1/chat/completions ...` 的输出
4. 端口占用情况（`netstat -ano | findstr :18790`）
