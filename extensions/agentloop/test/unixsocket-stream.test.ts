/**
 * Tests for unixsocket-stream.ts adapter.
 *
 * Strategy:
 * - Unit tests: mock createUnixSocketStreamFn, test event conversion
 * - Integration tests: spawn mock-daemon.py, test full Unix Socket round-trip
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

const mockPushAgentEvent = vi.fn<(stream: string, data: Record<string, unknown>) => void>();

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@zte/agentloop-sdk/sdk", () => ({}));

// ── Import after mocks ──

import { isUnixSocketProvider, sendUnixSocketStream } from "../src/app-server/unixsocket-stream.js";

// ── Helpers ──

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    provider: "unixsocket",
    modelId: "local-model",
    config: {
      models: {
        providers: {
          unixsocket: {
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "unixsocket-local",
            params: {
              socketPath: "/tmp/test-unixsocket-provider.sock",
              connectTimeoutMs: 5000,
              readTimeoutMs: 10000,
              maxRetries: 1,
            },
          },
        },
      },
    },
    prompt: "Hello",
    ...overrides,
  } as any;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("isUnixSocketProvider", () => {
  it("returns true when provider is 'unixsocket'", () => {
    expect(isUnixSocketProvider(makeParams())).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(isUnixSocketProvider(makeParams({ provider: "openai" }))).toBe(false);
    expect(isUnixSocketProvider(makeParams({ provider: "anthropic" }))).toBe(false);
    expect(isUnixSocketProvider(makeParams({ provider: "ai-ide" }))).toBe(false);
  });

  it("returns false for undefined provider", () => {
    expect(isUnixSocketProvider(makeParams({ provider: undefined }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Tests with mock-daemon.py (real Unix Socket)
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_DAEMON_SOCKET = path.join(os.tmpdir(), `test-unixsocket-provider-${process.pid}.sock`);

// Resolve mock-daemon.py path relative to this test file
const MOCK_DAEMON_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)),
  "../../unixsocket/test/mock-daemon.py",
);

let daemonProcess: ChildProcess | null = null;

function startMockDaemon(
  mode: "streaming" | "non-streaming" | "error" = "streaming",
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Clean up old socket
    if (fs.existsSync(MOCK_DAEMON_SOCKET)) {
      fs.unlinkSync(MOCK_DAEMON_SOCKET);
    }

    // Resolve python3: prefer conda example env (local dev), fallback to system python3 (CI/server)
    const condaPython = path.join(os.homedir(), "miniconda3", "envs", "example", "bin", "python3");
    const pythonBin = fs.existsSync(condaPython) ? condaPython : "python3";

    const proc = spawn(
      pythonBin,
      ["-u", MOCK_DAEMON_PATH, "--socket", MOCK_DAEMON_SOCKET, "--mode", mode],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
    );
    daemonProcess = proc;

    let stdoutBuf = "";
    let stderrBuf = "";

    const timeout = setTimeout(() => {
      const msg = `mock-daemon startup timeout.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`;
      proc.kill();
      reject(new Error(msg));
    }, 10000);

    proc.stdout!.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      if (stdoutBuf.includes("listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`mock-daemon spawn error: ${err.message}`));
    });

    proc.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `mock-daemon exited early with code ${code}\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`,
        ),
      );
    });
  });
}

function stopMockDaemon(): void {
  if (daemonProcess) {
    try {
      daemonProcess.kill("SIGTERM");
    } catch {
      // already dead
    }
    daemonProcess = null;
  }
  if (fs.existsSync(MOCK_DAEMON_SOCKET)) {
    try {
      fs.unlinkSync(MOCK_DAEMON_SOCKET);
    } catch {
      // already cleaned up
    }
  }
}

describe("sendUnixSocketStream - integration with mock daemon", () => {
  beforeEach(() => {
    mockPushAgentEvent.mockClear();
  });

  afterEach(() => {
    stopMockDaemon();
  });

  it("streams text response from mock daemon", async () => {
    await startMockDaemon("streaming");

    const params = makeParams({
      config: {
        models: {
          providers: {
            unixsocket: {
              params: {
                socketPath: MOCK_DAEMON_SOCKET,
                connectTimeoutMs: 5000,
                readTimeoutMs: 10000,
                maxRetries: 1,
              },
            },
          },
        },
      },
    });

    const result = await sendUnixSocketStream(
      params,
      "今天天气怎么样？",
      "You are a helpful assistant.",
      { pushAgentEvent: mockPushAgentEvent },
    );

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.assistantTexts.length).toBeGreaterThan(0);

    const fullText = result.assistantTexts.join("");
    expect(fullText).toContain("Streaming response");

    // Verify pushAgentEvent was called for assistant stream
    expect(mockPushAgentEvent).toHaveBeenCalled();
    const assistantCalls = mockPushAgentEvent.mock.calls.filter(
      (call: [string, Record<string, unknown>]) => call[0] === "assistant",
    );
    expect(assistantCalls.length).toBeGreaterThan(0);
  }, 20000);

  it("handles non-streaming response from mock daemon", async () => {
    await startMockDaemon("non-streaming");

    const params = makeParams({
      config: {
        models: {
          providers: {
            unixsocket: {
              params: {
                socketPath: MOCK_DAEMON_SOCKET,
                connectTimeoutMs: 5000,
                readTimeoutMs: 10000,
                maxRetries: 1,
              },
            },
          },
        },
      },
    });

    const result = await sendUnixSocketStream(params, "Hello", undefined, {
      pushAgentEvent: mockPushAgentEvent,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.assistantTexts.length).toBeGreaterThan(0);

    const fullText = result.assistantTexts.join("");
    expect(fullText).toContain("Non-streaming response");
  }, 20000);

  it("handles error response from mock daemon", async () => {
    await startMockDaemon("error");

    const params = makeParams({
      config: {
        models: {
          providers: {
            unixsocket: {
              params: {
                socketPath: MOCK_DAEMON_SOCKET,
                connectTimeoutMs: 5000,
                readTimeoutMs: 10000,
                maxRetries: 1,
              },
            },
          },
        },
      },
    });

    const result = await sendUnixSocketStream(params, "Hello", undefined, {
      pushAgentEvent: mockPushAgentEvent,
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
  }, 20000);

  it("handles connection failure gracefully", async () => {
    const params = makeParams({
      config: {
        models: {
          providers: {
            unixsocket: {
              params: {
                socketPath: `/tmp/nonexistent-daemon-${Date.now()}.sock`,
                connectTimeoutMs: 2000,
                readTimeoutMs: 3000,
                maxRetries: 0,
              },
            },
          },
        },
      },
    });

    const result = await sendUnixSocketStream(params, "Hello", undefined, {
      pushAgentEvent: mockPushAgentEvent,
    });

    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
  }, 30000);
});
