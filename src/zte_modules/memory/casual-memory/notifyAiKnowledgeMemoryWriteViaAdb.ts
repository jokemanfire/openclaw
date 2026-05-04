import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../../../config/config.js";
import { execShellCommand } from "../execShellCommand.js";

const execFileAsync = promisify(execFile);

const AIKNOWLEDGE_PROVIDER_URI = "content://com.zte.ai.knowledge.provider";
const METHOD_MEMORY_WRITE = "memory_write";
const MEMORY_WRITE_TYPE_OPENCLAW = "openclaw_memory";
const MEMORY_WRITE_CONTENT_MAX_UTF16 = Math.min(
  80_000,
  Number.parseInt(process.env.OPENCLAW_AIK_MEMORY_WRITE_MAX_CHARS ?? "80000", 10) || 80_000,
);

export type CasualMemoryNotifyLogger = {
  warn: (msg: string) => void;
};

export type NotifyAiKnowledgeMemoryWriteViaAdbParams = {
  filePath: string;
  toolName: string;
  log: CasualMemoryNotifyLogger;
  memoryWriteUserBodyPlain?: string;
  config?: OpenClawConfig;
};

function normalizeFsPathForMatch(filePath: string): string {
  return filePath.replaceAll("\\", "/").trim();
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

function buildDefaultMemoryWriteCommandLine(sourceField: string, text: string): string {
  const typeEx = escapeContentCallExtraValue(MEMORY_WRITE_TYPE_OPENCLAW);
  const sourceEx = escapeContentCallExtraValue(sourceField);
  const contentEx = escapeContentCallExtraValue(text);
  const emptyEx = escapeContentCallExtraValue("");
  const parts = [
    "content call",
    `--uri ${AIKNOWLEDGE_PROVIDER_URI}`,
    `--method ${METHOD_MEMORY_WRITE}`,
    `--extra "type:s:${typeEx}"`,
    `--extra "source:s:${sourceEx}"`,
    `--extra "content:s:${contentEx}"`,
    `--extra "img_uri:s:${emptyEx}"`,
    `--extra "img_source:s:${emptyEx}"`,
  ];
  return parts.join(" ");
}

function buildMemoryWriteCommandLine(params: {
  cfg: OpenClawConfig;
  sourceField: string;
  text: string;
}): string {
  const template = resolveMemoryWriteCommandTemplate(params.cfg);
  if (!template) {
    return buildDefaultMemoryWriteCommandLine(params.sourceField, params.text);
  }
  const typeEx = escapeContentCallExtraValue(MEMORY_WRITE_TYPE_OPENCLAW);
  const sourceEx = escapeContentCallExtraValue(params.sourceField);
  const contentEx = escapeContentCallExtraValue(params.text);
  const emptyEx = escapeContentCallExtraValue("");
  return template
    .replaceAll("{type}", typeEx)
    .replaceAll("{source}", sourceEx)
    .replaceAll("{content}", contentEx)
    .replaceAll("{img_uri}", emptyEx)
    .replaceAll("{img_source}", emptyEx);
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
  const sourceField = `${params.toolName}|${normalized}`;
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
      sourceField,
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
    return;
  }
  const adbBinRaw = process.env.ADB_PATH?.trim();
  const adbBin = adbBinRaw && adbBinRaw.length > 0 ? adbBinRaw : "adb";
  const argv = [
    "shell",
    "content",
    "call",
    "--uri",
    AIKNOWLEDGE_PROVIDER_URI,
    "--method",
    METHOD_MEMORY_WRITE,
    "--extra",
    `type:s:${escapeContentCallExtraValue(MEMORY_WRITE_TYPE_OPENCLAW)}`,
    "--extra",
    `source:s:${escapeContentCallExtraValue(sourceField)}`,
    "--extra",
    `content:s:${escapeContentCallExtraValue(text)}`,
    "--extra",
    `img_uri:s:${escapeContentCallExtraValue("")}`,
    "--extra",
    `img_source:s:${escapeContentCallExtraValue("")}`,
  ];
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
}
