import fs from "node:fs/promises";
import path from "node:path";
import type { LoopDefinition, LoopMode } from "@zte/agentloop-sdk/sdk";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";

export type AppManifest = {
  appName: string;
  loops: LoopMode[];
  sourcePath: string;
};

type AgentLoopManifest = {
  schemaVersion: 1;
  apps: Record<string, AppManifest>;
};

type AgentIdEntry = {
  appName: string;
  loopConfig: LoopMode;
};

export type LoopRegistry = {
  manifest: AgentLoopManifest;
  getApp(appName: string): AppManifest | undefined;
  getLoop(appName: string, loopId: string): LoopMode | undefined;
  resolveAgentId(agentId: string): AgentIdEntry | undefined;
  listApps(): string[];
  listLoops(appName: string): LoopMode[];
  listAgentIds(): string[];
};

export async function loadAppManifests(pluginRootDir: string): Promise<LoopRegistry> {
  const rootDir = pluginRootDir;
  const appsDir = path.join(rootDir, "src", "apps");
  embeddedAgentLog.info(`[agentloop] loading manifests from ${appsDir}`);
  const { manifest, agentIdMap } = await buildManifest(appsDir);
  return {
    manifest,
    getApp(appName) {
      return manifest.apps[appName];
    },
    getLoop(appName, loopId) {
      return manifest.apps[appName]?.loops.find((l) => l.id === loopId);
    },
    resolveAgentId(agentId) {
      return agentIdMap.get(agentId);
    },
    listApps() {
      return Object.keys(manifest.apps);
    },
    listLoops(appName) {
      return manifest.apps[appName]?.loops ?? [];
    },
    listAgentIds() {
      return [...agentIdMap.keys()];
    },
  };
}

async function buildManifest(
  appsDir: string,
): Promise<{ manifest: AgentLoopManifest; agentIdMap: Map<string, AgentIdEntry> }> {
  const apps: Record<string, AppManifest> = {};
  const agentIdMap = new Map<string, AgentIdEntry>();

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
        const appManifest = await loadAppManifest(entry.name, appDir);
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
    for (const loop of appManifest.loops) {
      agentIdMap.set(loop.id, { appName, loopConfig: loop });
    }
  }

  embeddedAgentLog.info(
    `[agentloop] manifest built apps=${Object.keys(apps).length} agentIds=${agentIdMap.size}`,
  );

  return { manifest: { schemaVersion: 1, apps }, agentIdMap };
}

async function loadAppManifest(appName: string, appDir: string): Promise<AppManifest | null> {
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

  const displayName = parsed.app_name ?? appName;
  const loops: LoopMode[] = (parsed.loop_mode ?? []).map((rawMode) => ({
    id: rawMode.id ?? "default",
    type: rawMode.type ?? "complex",
    systemPrompt: rawMode.systemPrompt,
    schedule_id: rawMode.schedule_id,
    tool_search_id: rawMode.tool_search_id,
    classifier_id: rawMode.classifier_id,
    message_type: rawMode.message_type,
  }));

  return { appName: displayName, loops, sourcePath: appDir };
}

function isNotFound(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
