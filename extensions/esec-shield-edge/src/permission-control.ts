import type { GatewayRequestHandlerOptions, PluginLogger } from "openclaw/plugin-sdk/core";

export type Permission = {
  permissionId: string;
  state: string;
  updatedAtMs: number;
};

export type PermissionsGetParams = {
  agentId: string;
  permissionIds: string[];
  getAll: boolean;
};

export type PermissionsUpdateParams = {
  agentId: string;
  updates: Array<{ permissionId: string; state: string }>;
};

export type PermissionsResult = {
  agentId: string;
  permissions: Permission[];
};

export function createPermissionsGetHandler(logger: PluginLogger) {
  return (opts: GatewayRequestHandlerOptions) => {
    try {
      const params = opts.params as PermissionsGetParams;
      logger.info?.(`[esec-shield-edge] permissions.get received: ${JSON.stringify(params)}`);
      opts.respond(true, { agentId: params.agentId, permissions: [] });
    } catch (err) {
      logger.error?.(`[esec-shield-edge] permissions.get error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function createPermissionsUpdateHandler(logger: PluginLogger) {
  return (opts: GatewayRequestHandlerOptions) => {
    try {
      const params = opts.params as PermissionsUpdateParams;
      logger.info?.(`[esec-shield-edge] permissions.update received: ${JSON.stringify(params)}`);
      const result: PermissionsResult = {
        agentId: params.agentId,
        permissions: params.updates.map((u) => ({
          permissionId: u.permissionId,
          state: u.state,
          updatedAtMs: Date.now(),
        })),
      };
      opts.respond(true, result);
    } catch (err) {
      logger.error?.(`[esec-shield-edge] permissions.update error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
