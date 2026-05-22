import type { PluginLogger } from "openclaw/plugin-sdk/core";

const FLUSH_INTERVAL_MS = 200;
const MAX_LINE_LENGTH = 64 * 1024;

type LogLine = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
};

export class DaemonLogger {
  private readonly logger: PluginLogger;
  private readonly stream: NodeJS.ReadableStream;
  private buffer: LogLine[] = [];
  private flushTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(logger: PluginLogger, stream: NodeJS.ReadableStream) {
    this.logger = logger;
    this.stream = stream;

    stream.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      this.processChunk(chunk.toString());
    });

    stream.on("end", () => {
      this.close();
    });

    stream.on("error", () => {
      this.close();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
    this.stream.removeAllListeners();
  }

  private processChunk(text: string): void {
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.length > MAX_LINE_LENGTH) {
        this.buffer.push({
          level: "warn",
          message: `[daemon] oversized stderr line ignored`,
        });
        continue;
      }

      const level = this.detectLogLevel(trimmed);
      this.buffer.push({ level, message: `[daemon] ${trimmed}` });
    }

    if (this.buffer.length > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  private detectLogLevel(line: string): LogLine["level"] {
    // {"level":"debug"
    // {"level":"info"
    // {"level":"warn"
    const levelStart = "{\"level\":\"".length
    const levelSlice = line.slice(levelStart, levelStart + 5);
    if (levelSlice === "error") return "error";
    if (levelSlice.startsWith("warn")) return "warn";
    if (levelSlice.startsWith("info")) return "info";
    if (levelSlice.startsWith("debug")) return "debug";

    return "info"
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    for (const { level, message } of this.buffer) {
      switch (level) {
        case "error":
          this.logger.error?.(message);
          break;
        case "warn":
          this.logger.warn?.(message);
          break;
        case "debug":
          this.logger.debug?.(message);
          break;
        default:
          this.logger.info?.(message);
          break;
      }
    }

    this.buffer = [];
  }
}
