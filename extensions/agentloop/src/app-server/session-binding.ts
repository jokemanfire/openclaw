import fs from "node:fs/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentLoopLoopType } from "./config.js";

export type AgentLoopBinding = {
  schemaVersion: 1;
  appName: string;
  loopId: string;
  loopType: AgentLoopLoopType;
  sessionFile: string;
  scheduleId?: string;
  toolSearchId?: string;
  model?: string;
  modelProvider?: string;
  createdAt: string;
  updatedAt: string;
};

function resolveAgentLoopBindingPath(sessionFile: string): string {
  return `${sessionFile}.agentloop-binding.json`;
}

export async function readAgentLoopBinding(sessionFile: string): Promise<AgentLoopBinding | undefined> {
  const path = resolveAgentLoopBindingPath(sessionFile);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    embeddedAgentLog.warn(`[agentloop] failed to read binding path=${path} error=${String(error)}`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentLoopBinding>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.appName !== "string" ||
      typeof parsed.loopId !== "string" ||
      typeof parsed.loopType !== "string"
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      appName: parsed.appName,
      loopId: parsed.loopId,
      loopType: parsed.loopType as AgentLoopLoopType,
      sessionFile,
      scheduleId: typeof parsed.scheduleId === "string" ? parsed.scheduleId : undefined,
      toolSearchId: typeof parsed.toolSearchId === "string" ? parsed.toolSearchId : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] failed to parse binding path=${path} error=${String(error)}`);
    return undefined;
  }
}

export async function writeAgentLoopBinding(
  sessionFile: string,
  binding: Omit<AgentLoopBinding, "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"> & {
    createdAt?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const payload: AgentLoopBinding = {
    schemaVersion: 1,
    sessionFile,
    appName: binding.appName,
    loopId: binding.loopId,
    loopType: binding.loopType,
    scheduleId: binding.scheduleId,
    toolSearchId: binding.toolSearchId,
    model: binding.model,
    modelProvider: binding.modelProvider,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(
    resolveAgentLoopBindingPath(sessionFile),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

export async function clearAgentLoopBinding(sessionFile: string): Promise<void> {
  try {
    await fs.unlink(resolveAgentLoopBindingPath(sessionFile));
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn(
        `[agentloop] failed to clear binding sessionFile=${sessionFile} error=${String(error)}`,
      );
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
