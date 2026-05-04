import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../../../config/config.js";
import { execShellCommand } from "../execShellCommand.js";

const execFileAsync = promisify(execFile);

const AIKNOWLEDGE_PROVIDER_URI = "content://com.zte.ai.knowledge.provider";
const METHOD_MEMORY_WRITE = "memory_write";
const METHOD_PORTRAIT_WRITE = "portrait_write";
const MEMORY_WRITE_SOURCE_OPENCLAW = "openclaw";
const MEMORY_WRITE_CONTENT_MAX_UTF16 = Math.min(
  80_000,
  Number.parseInt(process.env.OPENCLAW_AIK_MEMORY_WRITE_MAX_CHARS ?? "80000", 10) || 80_000,
);

export type CasualMemoryNotifyLogger = {
  warn: (msg: string) => void;
};

export type NotifyAiKnowledgeMemoryWriteViaAdbParams = {
  filePath: string;
  log: CasualMemoryNotifyLogger;
  memoryWriteUserBodyPlain?: string;
  config?: OpenClawConfig;
};

function normalizeFsPathForMatch(filePath: string): string {
  return filePath.replaceAll("\\", "/").trim();
}

function isWorkspaceUserMdPath(normalizedFilePath: string): boolean {
  const lower = normalizedFilePath.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : "";
  return !segments.includes("memory") && base === "user.md";
}

function buildProviderCallArgv(method: string, text: string): string[] {
  return [
    "shell",
    "content",
    "call",
    "--uri",
    AIKNOWLEDGE_PROVIDER_URI,
    "--method",
    method,
    "--extra",
    `content:s:${escapeContentCallExtraValue(text)}`,
    "--extra",
    `source:s:${escapeContentCallExtraValue(MEMORY_WRITE_SOURCE_OPENCLAW)}`,
    "--extra",
    `type:s:${escapeContentCallExtraValue("")}`,
    "--extra",
    `img:s:${escapeContentCallExtraValue("")}`,
    "--extra",
    `img_source:s:${escapeContentCallExtraValue("")}`,
    "--extra",
    `img_link:s:${escapeContentCallExtraValue("")}`,
    "--extra",
    `img_content:s:${escapeContentCallExtraValue("")}`,
  ];
}

function buildPortraitWriteArgv(text: string): string[] {
  return [
    "shell",
    "content",
    "call",
    "--uri",
    AIKNOWLEDGE_PROVIDER_URI,
    "--method",
    METHOD_PORTRAIT_WRITE,
    "--extra",
    `content:s:${escapeContentCallExtraValue(text)}`,
  ];
}

function stripLeadingBracketEnvelopePrefix(text: string): string {
  return text
    .trim()
    .replace(/^\[[^\]]+\]\s*/u, "")
    .trim();
}

function escapeContentCallExtraValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll('"', '\\"');
}

function resolveMemoryWriteCommandTemplate(cfg: OpenClawConfig): string | null {
  const envVars = cfg.env?.vars ?? {};
  const fromCfg =
    typeof envVars.AIKNOWLEDGE_OPENCLAW_MEMORY_WRITE_CMD === "string" &&
    envVars.AIKNOWLEDGE_OPENCLAW_MEMORY_WRITE_CMD.trim().length > 0
      ? envVars.AIKNOWLEDGE_OPENCLAW_MEMORY_WRITE_CMD.trim()
      : null;
  const fromProc =
    typeof process.env.AIKNOWLEDGE_OPENCLAW_MEMORY_WRITE_CMD === "string" &&
    process.env.AIKNOWLEDGE_OPENCLAW_MEMORY_WRITE_CMD.trim().length > 0
      ? process.env.AIKNOWLEDGE_OPENCLAW_MEMORY_WRITE_CMD.trim()
      : null;
  return fromCfg ?? fromProc;
}

function buildDefaultMemoryWriteCommandLine(text: string): string {
  const emptyEx = escapeContentCallExtraValue("");
  const typeEx = emptyEx;
  const sourceEx = escapeContentCallExtraValue(MEMORY_WRITE_SOURCE_OPENCLAW);
  const contentEx = escapeContentCallExtraValue(text);
  const parts = [
    "content call",
    `--uri ${AIKNOWLEDGE_PROVIDER_URI}`,
    `--method ${METHOD_MEMORY_WRITE}`,
    `--extra "content:s:${contentEx}"`,
    `--extra "source:s:${sourceEx}"`,
    `--extra "type:s:${typeEx}"`,
    `--extra "img:s:${emptyEx}"`,
    `--extra "img_source:s:${emptyEx}"`,
    `--extra "img_link:s:${emptyEx}"`,
    `--extra "img_content:s:${emptyEx}"`,
  ];
  return parts.join(" ");
}

function buildPortraitWriteCommandLine(text: string): string {
  const contentEx = escapeContentCallExtraValue(text);
  const parts = [
    "content call",
    `--uri ${AIKNOWLEDGE_PROVIDER_URI}`,
    `--method ${METHOD_PORTRAIT_WRITE}`,
    `--extra "content:s:${contentEx}"`,
  ];
  return parts.join(" ");
}

function buildMemoryWriteCommandLine(params: { cfg: OpenClawConfig; text: string }): string {
  const template = resolveMemoryWriteCommandTemplate(params.cfg);
  if (!template) {
    return buildDefaultMemoryWriteCommandLine(params.text);
  }
  const emptyEx = escapeContentCallExtraValue("");
  const typeEx = emptyEx;
  const sourceEx = escapeContentCallExtraValue(MEMORY_WRITE_SOURCE_OPENCLAW);
  const contentEx = escapeContentCallExtraValue(params.text);
  return template
    .replaceAll("{type}", typeEx)
    .replaceAll("{source}", sourceEx)
    .replaceAll("{content}", contentEx)
    .replaceAll("{img}", emptyEx)
    .replaceAll("{img_uri}", emptyEx)
    .replaceAll("{img_source}", emptyEx)
    .replaceAll("{img_link}", emptyEx)
    .replaceAll("{img_content}", emptyEx);
}

export async function notifyAiKnowledgeMemoryWriteViaAdb(
  params: NotifyAiKnowledgeMemoryWriteViaAdbParams,
): Promise<void> {
  const normalized = normalizeFsPathForMatch(params.filePath);
  if (!normalized) {
    params.log.warn(
      `[after_tool_call] memory_write AIK invalid path=${JSON.stringify(params.filePath)}`,
    );
    return;
  }
  const plain = params.memoryWriteUserBodyPlain;
  if (plain === undefined) {
    params.log.warn(
      `[after_tool_call] memory_write AIK skipped: memoryWriteUserBodyPlain unset path=${JSON.stringify(normalized)}`,
    );
    return;
  }
  let text = stripLeadingBracketEnvelopePrefix(plain);
  if (!text) {
    params.log.warn(
      `[after_tool_call] memory_write AIK skipped: empty user plain path=${JSON.stringify(normalized)}`,
    );
    return;
  }
  const utf16Units = text.length;
  if (utf16Units > MEMORY_WRITE_CONTENT_MAX_UTF16) {
    params.log.warn(
      `[after_tool_call] memory_write AIK truncating user plain utf16=${utf16Units} max=${MEMORY_WRITE_CONTENT_MAX_UTF16} path=${JSON.stringify(normalized)}`,
    );
    text = `${text.slice(0, MEMORY_WRITE_CONTENT_MAX_UTF16)}\n\n[openclaw: truncated for AIK payload cap]\n`;
  }
  if (params.config) {
    const commandLine = buildMemoryWriteCommandLine({
      cfg: params.config,
      text,
    });
    const outcome = await execShellCommand(commandLine, params.config, {
      info: (message) => {
        params.log.warn(message);
      },
    });
    if (!outcome.ok) {
      params.log.warn(
        `[after_tool_call] memory_write AIK exec_shell failed path=${JSON.stringify(normalized)} summary=${JSON.stringify(outcome.summary)} error=${JSON.stringify(outcome.error ?? "")}`,
      );
    }

    if (isWorkspaceUserMdPath(normalized)) {
      const portraitCommandLine = buildPortraitWriteCommandLine(text);
      const portraitOutcome = await execShellCommand(portraitCommandLine, params.config, {
        info: (message) => {
          params.log.warn(message);
        },
      });
      if (!portraitOutcome.ok) {
        params.log.warn(
          `[after_tool_call] portrait_write AIK exec_shell failed path=${JSON.stringify(normalized)} summary=${JSON.stringify(portraitOutcome.summary)} error=${JSON.stringify(portraitOutcome.error ?? "")}`,
        );
      }
    }

    return;
  }
  const adbBinRaw = process.env.ADB_PATH?.trim();
  const adbBin = adbBinRaw && adbBinRaw.length > 0 ? adbBinRaw : "adb";

  const argv = buildProviderCallArgv(METHOD_MEMORY_WRITE, text);

  try {
    await execFileAsync(adbBin, argv, {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    params.log.warn(
      `[after_tool_call] memory_write AIK adb/content call failed path=${JSON.stringify(normalized)} err=${String(err)}`,
    );
  }

  if (isWorkspaceUserMdPath(normalized)) {
    const portraitArgv = buildPortraitWriteArgv(text);
    try {
      await execFileAsync(adbBin, portraitArgv, {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      params.log.warn(
        `[after_tool_call] portrait_write AIK adb/content call failed path=${JSON.stringify(normalized)} err=${String(err)}`,
      );
    }
  }
}
