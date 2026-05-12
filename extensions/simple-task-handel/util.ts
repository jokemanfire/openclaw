import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const DEBUG_ENV = "SIMPLE_TASK_DEBUG";

export function isDebugEnabled(): boolean {
  return process.env[DEBUG_ENV] === "1";
}

export function createDebugLogger(api: OpenClawPluginApi) {
  return (message: string) => {
    if (isDebugEnabled()) {
      api.logger.info(message);
    }
  };
}
