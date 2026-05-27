import fs from "node:fs";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentLoopHarness } from "./harness.js";
import type { AgentLoopPluginConfig } from "./src/app-server/config.js";

function resolveSourcePluginRoot(distRootDir: string): string {
  const distMarkers = [`${path.sep}dist${path.sep}`, `${path.sep}dist-runtime${path.sep}`];
  for (const distMarker of distMarkers) {
    const distIdx = distRootDir.indexOf(distMarker);
    if (distIdx === -1) continue;
    const sourceRoot =
      distRootDir.slice(0, distIdx) + path.sep + distRootDir.slice(distIdx + distMarker.length);
    if (fs.existsSync(path.join(sourceRoot, "src", "apps"))) {
      return sourceRoot;
    }
  }
  if (fs.existsSync(path.join(distRootDir, "src", "apps"))) {
    return distRootDir;
  }
  return distRootDir;
}

export default definePluginEntry({
  id: "agentloop",
  name: "agentloop",
  description:
    "AgentLoop harness - multi-mode loop engine with Supervisor, Complex, Gui, and Simple modes.",
  register(api) {
    const pluginRootDir = resolveSourcePluginRoot(api.rootDir ?? "");
    embeddedAgentLog.info(`[agentloop] resolved pluginRootDir: ${pluginRootDir}`);
    const appsDir = path.join(pluginRootDir, "src", "apps");

    if (fs.existsSync(appsDir)) {
      embeddedAgentLog.info(`[agentloop] apps directory: ${appsDir}`);
    } else {
      embeddedAgentLog.warn(`[agentloop] apps directory not found: ${appsDir}`);
    }

    const harness = createAgentLoopHarness({
      pluginConfig: api.pluginConfig as AgentLoopPluginConfig | undefined,
      pluginRootDir,
    });

    harness.init().catch((err) => {
      embeddedAgentLog.error(`[agentloop] init failed: ${err}`);
    });

    api.registerAgentHarness(harness);
  },
});
