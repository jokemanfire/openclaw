import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMemoryDashboard } from "./src/dashboard.js";

const dashboard = createMemoryDashboard();

export default definePluginEntry({
  id: "diagnostics-memory-dashboard",
  name: "Diagnostics Memory Dashboard",
  description: "Real-time memory and heap monitoring dashboard with WebUI",
  register(api) {
    api.registerService(dashboard.service);
    api.registerHttpRoute({
      path: "/api/memory-dashboard",
      auth: "plugin",
      match: "prefix",
      handler: dashboard.handler,
    });
  },
});
