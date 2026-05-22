import type { Readable, Writable } from "node:stream";
import type { PluginLogger } from "openclaw/plugin-sdk/core";

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

export class TimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`[esec-shield-edge] timeout (${method}) after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

const MAX_LINE_LENGTH = 64 * 1024;

export class RpcMux {
  private readonly handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  dispatch(method: string, params: unknown): Promise<unknown> | unknown {
    const handler = this.handlers.get(method);
    return handler?.(params);
  }
}

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class JsonRpc {
  private readonly reader: Readable;
  private readonly writer: Writable;
  private readonly logger: PluginLogger;
  public mux?: RpcMux;
  private readonly pendingCalls = new Map<number, PendingCall>();
  private nextId = 1;
  private closed = false;
  private started = false;

  constructor(reader: Readable, writer: Writable, logger: PluginLogger) {
    this.reader = reader;
    this.writer = writer;
    this.logger = logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Capture async stream errors (e.g., EPIPE when peer closes)
    this.writer.on("error", (err) => {
      this.close(err instanceof Error ? err : new Error(String(err)));
    });
    this.startReadLoop();
  }

  call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) {
      throw new Error("rpc connection closed (already closed)");
    }

    // Fast-fail if stream already closed
    if (!this.writer.writable) {
      throw new Error("rpc connection closed (stream not writable)");
    }

    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const line = `${JSON.stringify(payload)}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new TimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pendingCalls.set(id, { resolve, reject, timer });
      // Catch sync errors (e.g., ERR_STREAM_DESTROYED from TOCTOU race)
      try {
        this.writer.write(line);
      } catch (err) {
        this.pendingCalls.delete(id);
        clearTimeout(timer);
        reject(
          err instanceof Error
            ? err
            : new Error(`rpc connection closed (write failed): ${String(err)}`)
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    const payload = { jsonrpc: "2.0", method, params };
    try {
      this.writer.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      this.logger.warn?.(`[esec-shield-edge] notify write error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;

    // this.reader.removeAllListeners();
    // this.writer.removeAllListeners();

    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("rpc connection closed"));
    }
    this.pendingCalls.clear();
  }

  private startReadLoop(): void {
    let buffer = "";

    this.reader.on("data", (chunk: Buffer) => {
      if (this.closed) return;

      buffer += chunk.toString();

      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) break;

        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line || line.length > MAX_LINE_LENGTH) continue;

        this.handleLine(line);
      }

      if (buffer.length > MAX_LINE_LENGTH * 2) {
        buffer = "";
        this.logger.warn?.(`[esec-shield-edge] buffer overflow, discarded`);
      }
    });

    this.reader.on("end", () => {
      this.close(new Error("reader ended"));
    });

    this.reader.on("error", (err) => {
      this.close(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage | null = null;

    try {
      const parsed = JSON.parse(line);
      if (parsed.jsonrpc !== "2.0") return;

      if (typeof parsed.id === "number") {
        if (typeof parsed.method === "string") {
          msg = {
            jsonrpc: "2.0",
            id: parsed.id,
            method: parsed.method,
            params: parsed.params,
          } as JsonRpcRequest;
        } else if ("result" in parsed || "error" in parsed) {
          msg = {
            jsonrpc: "2.0",
            id: parsed.id,
            result: parsed.result,
            error: parsed.error,
          } as JsonRpcResponse;
        }
      } else if (typeof parsed.method === "string" && !("id" in parsed)) {
        msg = {
          jsonrpc: "2.0",
          method: parsed.method,
          params: parsed.params,
        } as JsonRpcNotification;
      }
    } catch {
      return;
    }

    if (!msg) return;

    if ("id" in msg && ("result" in msg || "error" in msg)) {
      this.handleResponse(msg as JsonRpcResponse);
      return;
    }

    if ("method" in msg) {
      this.handleRequest(msg as JsonRpcRequest);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingCalls.get(msg.id);
    if (!pending) return;

    this.pendingCalls.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      const errMsg = msg.error.message ?? "unknown error";
      const errData = msg.error.data;
      const detail =
        errData !== undefined
          ? `: ${typeof errData === "string" ? errData : JSON.stringify(errData)}`
          : "";
      pending.reject(new Error(`${errMsg}${detail}`));
    } else {
      pending.resolve(msg.result ?? {});
    }
  }

  private handleRequest(msg: JsonRpcRequest): void {
    if (this.closed) return;

    if (!this.mux || !this.mux.has(msg.method)) {
      this.sendError(msg.id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${msg.method}`);
      return;
    }

    const result = this.mux.dispatch(msg.method, msg.params);

    Promise.resolve(result)
      .then((r) => {
        this.sendResult(msg.id, r);
      })
      .catch((err) => {
        this.sendError(msg.id, JSONRPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
      });
  }

  private sendResult(id: number, result: unknown): void {
    if (this.closed) return;
    const payload = { jsonrpc: "2.0", id, result };
    try {
      this.writer.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      this.logger.warn?.(`[esec-shield-edge] sendResult write error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendError(id: number, code: number, message: string): void {
    if (this.closed) return;
    const payload = { jsonrpc: "2.0", id, error: { code, message } };
    try {
      this.writer.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      this.logger.warn?.(`[esec-shield-edge] sendError write error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
