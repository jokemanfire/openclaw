import path from "node:path";
import { pathToFileURL } from "node:url";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";

declare const __filename: string | undefined;

type AppLoader = {
  loadApp(appDir: string, appName: string): Promise<void>;
};

type JitiInstance = { import(path: string): Promise<unknown> };
let jitiPromise: Promise<JitiInstance> | undefined;

function getJitiBaseUrl(): string {
  if (typeof __filename === "string" && __filename) {
    return pathToFileURL(__filename).href;
  }
  return pathToFileURL(path.join(process.cwd(), "agentloop-app-loader.js")).href;
}

function getJiti(): Promise<JitiInstance> {
  if (!jitiPromise) {
    jitiPromise = (async () => {
      const { createJiti } = await import("jiti");
      return createJiti(getJitiBaseUrl()) as JitiInstance;
    })();
  }
  return jitiPromise;
}

export function createAppLoader(): AppLoader {
  return {
    async loadApp(appDir: string, appName: string): Promise<void> {
      const modulePath = path.join(appDir, "index.ts");
      try {
        const jiti = await getJiti();
        const mod = (await jiti.import(modulePath)) as Record<string, unknown>;
        const exportKeys = Object.keys(mod ?? {});
        embeddedAgentLog.info(`[agentloop] app module loaded ${appName}, exports=[${exportKeys.join(", ")}]`);
        const { classifierRegister } = await import("@zte/agentloop-sdk/sdk");
        const registered = classifierRegister.listClassifierIds?.() ?? [];
        embeddedAgentLog.info(`[agentloop] classifier loaded: ${JSON.stringify(registered)}`);
        embeddedAgentLog.info(`[agentloop] app loaded ${appName}`);
      } catch (error) {
        embeddedAgentLog.warn(
          `[agentloop] failed to load app ${appName}, ${appDir}, error: ${error}`,
        );
      }
    },
  };
}
