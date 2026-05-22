import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PluginLogger } from "openclaw/plugin-sdk/core";
import type { HookName } from "./rpc-protocol.js";
import { RpcMux, JsonRpc } from "./daemon-rpc.js";
class DaemonError extends Error {
  constructor(message: string, opts?: { cause?: Error }) {
    super(message, opts);
    this.name = "DaemonError";
  }
}
import { DaemonLogger } from "./daemon-logger.js";
import { ExponentialBackoff as RestartScheduler } from "./retry-policy.js";

const DEFAULT_DAEMON_VERSION = "2026.5.18";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 3;

const PLATFORM_MAP: Record<string, string> = { linux: "linux", darwin: "darwin", win32: "windows" };
const ARCH_MAP: Record<string, string> = { x64: "x64", arm64: "arm64" };

function resolveDaemonPath(pluginRoot: string): string {
  const platform = PLATFORM_MAP[os.platform()] ?? "linux";
  const arch = ARCH_MAP[os.arch()] ?? "x64";
  const ext = os.platform() === "win32" ? ".exe" : "";
  const version = detectLatestVersion(pluginRoot) ?? DEFAULT_DAEMON_VERSION;
  return path.join(pluginRoot, "bin", `esec-shield-daemon-edge-v${version}-${platform}-${arch}${ext}`);
}

function detectLatestVersion(pluginRoot: string): string | undefined {
  const binDir = path.join(pluginRoot, "bin");
  if (!fs.existsSync(binDir)) return undefined;
  const versions = fs.readdirSync(binDir)
    .map((f) => f.match(/daemon-edge-v(\d+\.\d+\.\d+)/)?.[1])
    .filter(Boolean) as string[];
  if (versions.length === 0) return undefined;
  return versions.sort((a, b) => {
    const [pa, pb] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  })[0];
}

type ProcessState = "spawning" | "ready";

type ProcessCallbacks = {
  onTimeout: () => void;
  onError: (err: Error) => void;
  onExit: (code: number | null, signal: string | null) => void;
};

class DaemonProcess {
  private child: ChildProcessWithoutNullStreams;
  private rpc: JsonRpc;
  private daemonLogger: DaemonLogger;
  private destroyed = false;
  private exitResolve: (() => void) | null = null;
  private readonly exitPromise: Promise<void>;

  state: ProcessState = "spawning";
  handshakeTimer: NodeJS.Timeout | null = null;
  pid: number;
  subscribedHooks: HookName[] = [];

  constructor(
    daemonPath: string,
    cwd: string,
    logger: PluginLogger,
    mux: RpcMux,
    handshakeTimeoutMs: number,
    callbacks: ProcessCallbacks
  ) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });

    this.child = spawn(daemonPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, GODEBUG: "disablethp=1" },
    });
    this.pid = this.child.pid!;
    this.daemonLogger = new DaemonLogger(logger, this.child.stderr);

    this.rpc = new JsonRpc(this.child.stdout, this.child.stdin, logger);
    this.rpc.mux = mux;
    this.rpc.start();

    this.handshakeTimer = setTimeout(() => {
      if (!this.destroyed) callbacks.onTimeout();
    }, handshakeTimeoutMs);

    this.child.on("error", (err) => {
      if (this.destroyed) return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    });

    this.child.on("exit", (code, signal) => {
      if (!this.destroyed) {
        callbacks.onExit(code, signal);
      }
      this.exitResolve?.();
    });
  }

  rpcCall(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.destroyed) throw new DaemonError("process destroyed");
    return this.rpc.call(method, params, timeoutMs);
  }

  rpcNotify(method: string, params: unknown): void {
    if (this.destroyed) return;
    this.rpc.notify(method, params);
  }

  isAlive(): boolean {
    return !this.destroyed && !this.child.killed;
  }

  async kill(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }

    this.daemonLogger.close();
    this.rpc.close();

    if (!this.child.killed) {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) {
          this.child.kill("SIGKILL");
        }
        resolve();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.child.removeAllListeners();
  }
}

export type DaemonManagerOptions = {
  pluginRoot: string;
  logger: PluginLogger;
  pluginConfig?: unknown;
  handshakeTimeoutMs?: number;
  hookTimeoutMs?: number;
};

export class DaemonManager {
  private readonly daemonPath: string;
  private readonly pluginRoot: string;
  private readonly logger: PluginLogger;
  private readonly pluginConfig?: unknown;
  private readonly handshakeTimeoutMs: number;
  private readonly hookTimeoutMs: number;

  private process: DaemonProcess | null = null;
  private readonly restartScheduler: RestartScheduler;
  private shuttingDown = false;

  constructor(opts: DaemonManagerOptions) {
    this.pluginRoot = opts.pluginRoot;
    this.daemonPath = resolveDaemonPath(opts.pluginRoot);
    this.logger = opts.logger;
    this.pluginConfig = opts.pluginConfig;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.hookTimeoutMs = opts.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.restartScheduler = new RestartScheduler(
      RESTART_WINDOW_MS,
      MAX_RESTARTS_IN_WINDOW
    );
  }

  start(): void {
    if (this.process) return;
    this.spawn();
  }

  private spawn(): void {
    if (this.process) {
      this.logger.warn?.(`[esec-shield-edge] killing old process pid=${this.process.pid}`);
      this.process.kill().catch((err) => {
        this.logger.error?.(`[esec-shield-edge] kill failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    this.logger.info?.(`[esec-shield-edge] spawning: ${this.daemonPath}`);

    const mux = new RpcMux();
    mux.register("init", () => this.handleInit());
    mux.register("register", (params) => this.handleRegister(params));

    this.process = new DaemonProcess(
      this.daemonPath,
      this.pluginRoot,
      this.logger,
      mux,
      this.handshakeTimeoutMs,
      {
        onTimeout: () => {
          this.logger.warn?.(`[esec-shield-edge] handshake timeout pid=${this.process?.pid} after ${this.handshakeTimeoutMs}ms`);
          this.scheduleRestart();
        },
        onError: (err) => {
          this.logger.warn?.(`[esec-shield-edge] process error pid=${this.process?.pid}: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleRestart();
        },
        onExit: (code, signal) => {
          this.logger.warn?.(`[esec-shield-edge] crashed pid=${this.process?.pid} (${signal ?? `code ${code}`})`);
          this.scheduleRestart();
        },
      }
    );

    this.logger.info?.(`[esec-shield-edge] spawned pid=${this.process.pid}`);
  }

  private onReady(): void {
    this.restartScheduler.reset();
    this.logger.info?.(`[esec-shield-edge] daemon ready pid=${this.process?.pid}`);
  }

  private scheduleRestart(): void {
    const pid = this.process?.pid;
    if (this.process) {
      this.logger.info?.(`[esec-shield-edge] killing process pid=${pid}`);
      this.process.kill().catch((err) => {
        this.logger.error?.(`[esec-shield-edge] kill failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.process = null;

    if (this.shuttingDown) return;

    const result = this.restartScheduler.schedule(() => {
      if (!this.process) {
        try {
          this.spawn();
        } catch (err) {
          this.logger.error?.(`[esec-shield-edge] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleRestart();
        }
      }
    });

    if (result.scheduled) {
      this.logger.warn?.(
        `[esec-shield-edge] restart attempt ${result.count}/${MAX_RESTARTS_IN_WINDOW} in ${result.delayMs}ms (prev pid=${pid})`
      );
    } else {
      this.logger.error?.(`[esec-shield-edge] ${result.reason}`);
    }
  }

  private async handleInit(): Promise<unknown> {
    this.logger.info?.(`[esec-shield-edge] handleInit()`);
    return {
      runtime: "openclaw",
      pluginConfig: this.pluginConfig,
    };
  }

  private handleRegister(params: unknown): unknown {
    this.logger.info?.(`[esec-shield-edge] handleRegister()`);

    const p = params as { hooks?: HookName[]; version?: string };
    if (!p?.hooks || !Array.isArray(p.hooks)) {
      throw new Error("invalid params");
    }

    if (this.process) {
      this.process.subscribedHooks = p.hooks;
      if (this.process.handshakeTimer) {
        clearTimeout(this.process.handshakeTimer);
      }
      this.process.handshakeTimer = null;
      this.process.state = "ready";
    }

    this.logger.info?.(`[esec-shield-edge] hooks: ${p.hooks.join(",")}`);
    this.onReady();

    return { accepted: true, version: p.version ?? DEFAULT_DAEMON_VERSION };
  }

  async request(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<unknown> {
    const process = this.process;
    if (!process || process.state !== "ready") {
      throw new DaemonError("not ready");
    }
    return process.rpcCall(method, params, opts?.timeoutMs ?? this.hookTimeoutMs);
  }

  notify(method: string, params: unknown): void {
    const process = this.process;
    if (!process || process.state !== "ready") return;
    process.rpcNotify(method, params);
  }

  isHookSubscribed(hook: HookName): boolean {
    const hooks = this.process?.subscribedHooks ?? [];
    return hooks.includes(hook);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.logger.info?.(`[esec-shield-edge] shutting down pid=${this.process?.pid}`);

    this.restartScheduler.cancel();

    const process = this.process;
    this.process = null;

    if (process) {
      await process.kill();
    }
  }
}
