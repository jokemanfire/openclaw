/**
 * End-to-end demo: agentloop → unixsocket → mock-daemon
 *
 * 用法: node --experimental-strip-types extensions/agentloop/test/demo-unixsocket-e2e.ts
 *
 * 流程:
 *  1. 启动 mock-daemon.py (模拟本地 AI 模型守护进程)
 *  2. 通过 unixsocket 扩展的 createUnixSocketStreamFn 建立连接
 *  3. 发送 prompt, 接收流式/非流式/错误响应
 *  4. 展示完整通信过程
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// unixsocket api exports
import { createUnixSocketStreamFn } from "../../unixsocket/api.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DAEMON_PATH = path.resolve(__dirname, "../../unixsocket/test/mock-daemon.py");
const SOCKET_PATH = path.join(os.tmpdir(), `demo-unixsocket-${process.pid}.sock`);

let daemonProcess: ChildProcess | null = null;

// ── 颜色 ──

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function log(tag: string, msg: string) {
  const color: Record<string, string> = {
    daemon: C.yellow,
    agentloop: C.cyan,
    unixsocket: C.green,
    error: C.red,
    system: C.magenta,
  };
  console.log(`${color[tag] ?? ""}[${tag}]${C.reset} ${msg}`);
}

function separator(title: string) {
  console.log(`\n${C.bold}${"═".repeat(60)}${C.reset}`);
  console.log(`${C.bold}  ${title}${C.reset}`);
  console.log(`${C.bold}${"═".repeat(60)}${C.reset}\n`);
}

// ── 启动 mock daemon ──

function startMockDaemon(mode = "streaming"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

    log("daemon", `启动 mock-daemon.py (mode=${mode})`);

    const proc = spawn(
      "python3",
      ["-u", MOCK_DAEMON_PATH, "--socket", SOCKET_PATH, "--mode", mode],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
    );
    daemonProcess = proc;

    let stdoutBuf = "";
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`daemon 启动超时\nstdout: ${stdoutBuf}`));
    }, 10_000);

    proc.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      for (const line of data.toString().split("\n")) {
        if (line.trim()) log("daemon", line);
      }
      if (stdoutBuf.includes("listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`daemon 退出 code=${code}`));
    });
  });
}

function stopMockDaemon() {
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    daemonProcess = null;
  }
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
  }
}

function resetDaemon() {
  if (daemonProcess) {
    daemonProcess.kill("SIGTERM");
    daemonProcess = null;
  }
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
}

// ── 共用 model/context ──

function makeModel() {
  return {
    id: "local-model",
    name: "local-model",
    api: "openai-completions" as const,
    provider: "unixsocket",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  };
}

function makeContext(prompt: string, systemPrompt?: string) {
  return {
    messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
    ...(systemPrompt ? { systemPrompt } : {}),
  };
}

function makeStreamFn() {
  return createUnixSocketStreamFn({
    socketPath: SOCKET_PATH,
    connectTimeoutMs: 5_000,
    readTimeoutMs: 10_000,
    maxRetries: 1,
  });
}

// ── 逐事件读取并打印 ──

async function readStream(label: string, eventStream: AsyncIterable<Record<string, unknown>>) {
  let fullText = "";
  let eventCount = 0;

  for await (const event of eventStream as AsyncIterable<Record<string, unknown>>) {
    eventCount++;
    const type = event.type as string;

    if (type === "start") {
      log("unixsocket", `${C.green}▸ stream 开始${C.reset}`);
    } else if (type === "text_delta") {
      const delta = (event.delta as string) || "";
      fullText += delta;
      process.stdout.write(`${C.green}${delta}${C.reset}`);
    } else if (type === "text_end") {
      process.stdout.write("\n");
    } else if (type === "done") {
      log("unixsocket", `${C.green}✓ stream 完成 (reason: ${event.reason})${C.reset}`);
    } else if (type === "error") {
      const errObj = event.error as Record<string, unknown> | undefined;
      log("error", `stream 错误: ${errObj?.errorMessage || JSON.stringify(event)}`);
    } else {
      log("unixsocket", `事件: ${type}`);
    }
  }

  return { fullText, eventCount };
}

// ── 主流程 ──

async function main() {
  separator("agentloop → unixsocket 端到端通信验证");

  log("system", `PID: ${process.pid}`);
  log("system", `Socket: ${SOCKET_PATH}`);
  log("system", `Daemon: ${MOCK_DAEMON_PATH}`);

  const results: Array<{ name: string; pass: boolean }> = [];

  try {
    // ── 测试 1: streaming ──
    separator("测试 1/4: streaming 模式");
    resetDaemon();
    await startMockDaemon("streaming");
    log("agentloop", `发送 prompt: "今天天气怎么样？"`);
    log("agentloop", `system prompt: "You are a helpful assistant."`);

    const r1 = await readStream(
      "streaming",
      makeStreamFn()(
        makeModel(),
        makeContext("今天天气怎么样？", "You are a helpful assistant."),
        undefined,
      ) as any,
    );
    log("agentloop", `事件总数: ${r1.eventCount}, 文本长度: ${r1.fullText.length}`);
    results.push({
      name: "streaming 模式",
      pass: r1.fullText.length > 0 && r1.fullText.includes("Streaming"),
    });

    // ── 测试 2: non-streaming ──
    separator("测试 2/4: non-streaming 模式");
    resetDaemon();
    await startMockDaemon("non-streaming");
    log("agentloop", `发送 prompt: "介绍一下你自己"`);

    const r2 = await readStream(
      "non-streaming",
      makeStreamFn()(makeModel(), makeContext("介绍一下你自己"), undefined) as any,
    );
    log("agentloop", `事件总数: ${r2.eventCount}, 文本长度: ${r2.fullText.length}`);
    results.push({
      name: "non-streaming 模式",
      pass: r2.fullText.length > 0 && r2.fullText.includes("Non-streaming"),
    });

    // ── 测试 3: error ──
    separator("测试 3/4: error 模式");
    resetDaemon();
    await startMockDaemon("error");
    log("agentloop", `发送 prompt: "触发错误"`);

    let errorCaught = false;
    try {
      const r3 = await readStream(
        "error",
        makeStreamFn()(makeModel(), makeContext("触发错误"), undefined) as any,
      );
      errorCaught = r3.fullText.includes("not loaded") || r3.eventCount > 0;
    } catch (err: any) {
      log("unixsocket", `${C.red}✓ 捕获异常: ${err.message}${C.reset}`);
      errorCaught = true;
    }
    results.push({ name: "error 处理", pass: errorCaught });

    // ── 测试 4: connection failure ──
    separator("测试 4/4: 连接失败处理");
    const failFn = createUnixSocketStreamFn({
      socketPath: `/tmp/nonexistent-${Date.now()}.sock`,
      connectTimeoutMs: 2_000,
      readTimeoutMs: 3_000,
      maxRetries: 0,
    });
    let failHandled = false;
    try {
      const r4 = await readStream(
        "connection-failure",
        failFn(makeModel(), makeContext("test"), undefined) as any,
      );
      failHandled = r4.eventCount > 0;
    } catch (err: any) {
      log("unixsocket", `${C.yellow}✓ 捕获异常: ${err.message}${C.reset}`);
      failHandled = true;
    }
    results.push({ name: "连接失败处理", pass: failHandled });

    // ── 汇总 ──
    separator("验证结果汇总");
    for (const r of results) {
      console.log(`  ${r.pass ? C.green + "✓" : C.red + "✗"}${C.reset} ${r.name}`);
    }
    const allPass = results.every((r) => r.pass);
    console.log(
      `\n  ${allPass ? C.green + C.bold + "全部通过" : C.red + C.bold + "存在失败"}${C.reset}\n`,
    );
  } finally {
    stopMockDaemon();
  }
}

main().catch((err: Error) => {
  log("error", err.message);
  stopMockDaemon();
  process.exit(1);
});
