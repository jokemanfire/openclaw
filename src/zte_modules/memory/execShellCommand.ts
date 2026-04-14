// ZTE_HGJ_MEMORY_BEGIN
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { createExecTool } from "../../agents/bash-tools.js";
import type { OpenClawConfig } from "../../config/config.js";

export type ExecShellCommandLogger = { info?: (message: string) => void };

export type ExecShellCommandOutcome = {
  ok: boolean;
  summary: string;
  exitCode?: number;
  output?: string;
  details?: unknown;
  raw?: unknown;
  error?: string;
};

function extractTextContent(content: Array<{ type: string; text?: string }>) {
  return content
    .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
    .join("\n")
    .trim();
}

function createExecShellCommandTool(cfg: OpenClawConfig) {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceRoot = resolveAgentWorkspaceDir(cfg, agentId);
  const globalExec = cfg.tools?.exec ?? {};
  const { applyPatch: _applyPatch, ...execForTool } = globalExec as Record<string, unknown>;
  void _applyPatch;
  const execTool = createExecTool({
    ...execForTool,
    cwd: workspaceRoot,
    agentId,
    allowBackground: false,
    scopeKey: "ram-debug:exec_shell",
  });
  return { execTool, agentId, cwd: workspaceRoot };
}

export async function execShellCommand(
  commandLine: string,
  cfg: OpenClawConfig,
  logger?: ExecShellCommandLogger,
): Promise<ExecShellCommandOutcome> {
  const command = commandLine.trim();
  if (!command) {
    return {
      ok: false,
      summary: "exec_shell missing command",
      error:
        "Usage: exec_shell <command and args>\n" +
        "Runs via OpenClaw agent `exec` tool (tools.exec + default agent workspace).",
    };
  }

  const { execTool, cwd } = createExecShellCommandTool(cfg);
  logger?.info?.(
    `[ram-debug] exec_shell exec tool command=${JSON.stringify(command)} cwd=${cwd}`,
  );

  try {
    const result = await execTool.execute("ram-debug-exec-shell", { command });
    const details = result.details;

    if (
      details?.status === "approval-pending" ||
      details?.status === "approval-unavailable"
    ) {
      const msg =
        details.status === "approval-pending"
          ? `approval pending (id=${details.approvalId}); approve or relax tools.exec / exec-approvals.`
          : `approval unavailable: ${details.reason}`;
      return {
        ok: false,
        summary: `exec_shell ${details.status}`,
        error: `[ram-debug] exec_shell: ${msg}`,
        details,
        raw: result,
      };
    }

    if (details?.status === "running") {
      return {
        ok: false,
        summary: "exec_shell running",
        error: `[ram-debug] exec_shell: unexpected background session ${details.sessionId}`,
        details,
        raw: result,
      };
    }

    if (details?.status === "completed") {
      const out =
        details.aggregated?.trim() ||
        extractTextContent(result.content) ||
        "(no output)";
      const code = details.exitCode ?? 0;
      return {
        ok: code === 0,
        summary: `exec_shell exit=${String(code)}`,
        exitCode: code,
        output: out,
        details,
        raw: result,
      };
    }

    const fallback = extractTextContent(result.content);
    return {
      ok: true,
      summary: "exec_shell completed",
      output: fallback || "(no output)",
      details,
      raw: result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: "exec_shell error",
      error: `[ram-debug] exec_shell failed: ${message}`,
    };
  }
}
// ZTE_HGJ_MEMORY_BEGIN