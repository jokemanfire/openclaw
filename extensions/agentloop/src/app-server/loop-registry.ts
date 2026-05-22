import fs from "node:fs/promises";
import path from "node:path";
import type { LoopDefinition, LoopMode } from "@zte/agentloop-sdk/sdk";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

export type ExtendLoopMode = LoopMode & { workspaceDir: string | undefined };

export type ExtendLoopDefinition = Omit<LoopDefinition, "loop_mode"> & {
  loop_mode: ExtendLoopMode[];
};

export type AppManifest = ExtendLoopDefinition & { sourcePath: string };

type AgentLoopManifest = {
  schemaVersion: 1;
  apps: Record<string, AppManifest>;
};

export type LoopRegistry = {
  manifest: AgentLoopManifest;
  getApp(appName: string): AppManifest | undefined;
  getLoop(appName: string, loopId: string): ExtendLoopMode | undefined;
  resolveAgentId(agentId: string): AppManifest | undefined;
  listApps(): string[];
  listLoops(appName: string): ExtendLoopMode[];
  listAgentIds(): string[];
};

export async function loadAppManifests(
  pluginRootDir: string,
  params?: AgentHarnessAttemptParams,
): Promise<LoopRegistry> {
  const rootDir = pluginRootDir;
  const appsDir = path.join(rootDir, "src", "apps");
  embeddedAgentLog.info(`[agentloop] loading manifests from ${appsDir}`);
  const { manifest, agentIdMap } = await buildManifest(appsDir, params);
  function resolveApp(appName: string): AppManifest | undefined {
    return (
      manifest.apps[appName] ?? Object.values(manifest.apps).find((a) => a.app_name === appName)
    );
  }
  return {
    manifest,
    getApp(appName) {
      return resolveApp(appName);
    },
    getLoop(appName, loopId) {
      return resolveApp(appName)?.loop_mode.find((l) => l.id === loopId);
    },
    resolveAgentId(agentId) {
      return agentIdMap.get(agentId);
    },
    listApps() {
      return Object.keys(manifest.apps);
    },
    listLoops(appName) {
      return resolveApp(appName)?.loop_mode ?? [];
    },
    listAgentIds() {
      return [...agentIdMap.keys()];
    },
  };
}

async function buildManifest(
  appsDir: string,
  params?: AgentHarnessAttemptParams,
): Promise<{ manifest: AgentLoopManifest; agentIdMap: Map<string, AppManifest> }> {
  const apps: Record<string, AppManifest> = {};
  const agentIdMap = new Map<string, AppManifest>();

  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn(
        `[agentloop] failed to read apps directory appsDir=${appsDir} error=${String(error)}`,
      );
    }
    return { manifest: { schemaVersion: 1, apps: {} }, agentIdMap };
  }

  const dirs = entries.filter((e) => e.isDirectory());

  const results = await Promise.all(
    dirs.map(async (entry) => {
      const appDir = path.join(appsDir, entry.name);
      embeddedAgentLog.info(`[agentloop] appDir ${appDir}`);
      try {
        const appManifest = await loadAppManifest(appDir, params);
        return { appName: entry.name, appManifest };
      } catch (error) {
        embeddedAgentLog.warn(
          `failed to load app manifest appName=${entry.name} appDir=${appDir} error=${String(error)}`,
        );
        return { appName: entry.name, appManifest: null };
      }
    }),
  );

  for (const { appName, appManifest } of results) {
    if (!appManifest) continue;
    apps[appName] = appManifest;
    for (const loop of appManifest.loop_mode) {
      agentIdMap.set(loop.id, appManifest);
    }
  }

  embeddedAgentLog.info(
    `[agentloop] manifest built apps=${Object.keys(apps).length} agentIds=${agentIdMap.size}`,
  );

  return { manifest: { schemaVersion: 1, apps }, agentIdMap };
}

async function loadAppManifest(
  appDir: string,
  params?: AgentHarnessAttemptParams,
): Promise<AppManifest | null> {
  const configPath = path.join(appDir, "agent.app.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  let parsed: LoopDefinition;
  try {
    parsed = JSON.parse(raw) as LoopDefinition;
  } catch (error) {
    embeddedAgentLog.warn(
      `failed to parse agent.app.json path=${configPath} error=${String(error)}`,
    );
    return null;
  }

  const extendedLoopModes: ExtendLoopMode[] = (parsed.loop_mode ?? []).map((loop) =>
    transferLoopMode(loop, params),
  );

  return { ...parsed, loop_mode: extendedLoopModes ?? [], sourcePath: appDir };
}

function transferLoopMode(loop: LoopMode, params?: AgentHarnessAttemptParams): ExtendLoopMode {
  const workspaceDir = params
    ? getAgentWorkspace(loop.id, params.config as Record<string, unknown>)
    : undefined;
  return { ...loop, workspaceDir };
}

function getAgentWorkspace(agentId: string, config?: Record<string, unknown>): string | undefined {
  const agents = (config as any)?.agents?.list as
    | Array<{ id: string; workspace?: string }>
    | undefined;
  const agent = agents?.find((a) => a.id === agentId);
  return agent?.workspace;
}

function isNotFound(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
