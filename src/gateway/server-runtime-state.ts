import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resolveActivePluginHttpRouteRegistry,
} from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { listenGatewayUnixSocket } from "../zte_modules/gateway/server/unixsocket-listen.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import type { HookClientIpConfig, HooksRequestHandler } from "./server/hooks-request-handler.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import type { PluginRoutePathContext } from "./server/plugins-http/path-context.js";
import { shouldEnforceGatewayAuthForPluginPath } from "./server/plugins-http/route-auth.js";
import {
  createPreauthConnectionBudget,
  type PreauthConnectionBudget,
} from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type GatewayPluginRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathContext?: PluginRoutePathContext,
  dispatchContext?: {
    gatewayAuthSatisfied?: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  },
) => Promise<boolean>;

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  /** Present when the gateway listens on a Unix domain socket. */
  unixSocketPath?: string;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  getHookClientIpConfig: () => HookClientIpConfig;
  pluginRegistry: PluginRegistry;
  pinChannelRegistry?: boolean;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  getReadiness?: ReadinessChecker;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  releasePluginRouteRegistry: () => void;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  startListening: () => Promise<void>;
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  pinActivePluginHttpRouteRegistry(params.pluginRegistry);
  if (params.pinChannelRegistry !== false) {
    pinActivePluginChannelRegistry(params.pluginRegistry);
  } else {
    releasePinnedPluginChannelRegistry();
  }
  try {
    let canvasHost: CanvasHostHandler | null = null;
    if (params.canvasHostEnabled) {
      try {
        const { createCanvasHostHandler } = await import("../canvas-host/server.js");
        const handler = await createCanvasHostHandler({
          runtime: params.canvasRuntime,
          rootDir: params.cfg.canvasHost?.root,
          basePath: CANVAS_HOST_PATH,
          allowInTests: params.allowCanvasHostInTests,
          liveReload: params.cfg.canvasHost?.liveReload,
        });
        if (handler.rootDir) {
          canvasHost = handler;
          const listenLabel =
            params.bindHost === "unix" && params.unixSocketPath
              ? `unix:${params.unixSocketPath}`
              : `http://${params.bindHost}:${params.port}`;
          params.logCanvas.info(
            `canvas host mounted at ${listenLabel}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
          );
        }
      } catch (err) {
        params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
      }
    }

    const clients = new Set<GatewayWsClient>();
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    let loadedHooksRequestHandler: HooksRequestHandler | null = null;
    const handleHooksRequest: HooksRequestHandler = async (req, res) => {
      const hooksConfig = params.hooksConfig();
      if (!hooksConfig) {
        return false;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const basePath = hooksConfig.basePath;
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
        return false;
      }
      if (!loadedHooksRequestHandler) {
        const { createGatewayHooksRequestHandler } = await import("./server/hooks.js");
        loadedHooksRequestHandler = createGatewayHooksRequestHandler({
          deps: params.deps,
          getHooksConfig: params.hooksConfig,
          getClientIpConfig: params.getHookClientIpConfig,
          bindHost: params.bindHost,
          port: params.port,
          logHooks: params.logHooks,
        });
      }
      return await loadedHooksRequestHandler(req, res);
    };

    let loadedPluginRequestHandler: GatewayPluginRequestHandler | null = null;
    const handlePluginRequest: GatewayPluginRequestHandler = async (
      req,
      res,
      pathContext,
      dispatchContext,
    ) => {
      const registry = resolveActivePluginHttpRouteRegistry(params.pluginRegistry);
      if ((registry.httpRoutes ?? []).length === 0) {
        return false;
      }
      if (!loadedPluginRequestHandler) {
        const { createGatewayPluginRequestHandler } = await import("./server/plugins-http.js");
        loadedPluginRequestHandler = createGatewayPluginRequestHandler({
          registry: params.pluginRegistry,
          log: params.logPlugins,
        });
      }
      return await loadedPluginRequestHandler(req, res, pathContext, dispatchContext);
    };
    const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => {
      return shouldEnforceGatewayAuthForPluginPath(
        resolveActivePluginHttpRouteRegistry(params.pluginRegistry),
        pathContext,
      );
    };

    const httpServers: HttpServer[] = [];
    const httpBindHosts: string[] = [];
    const unixSocketRequired = params.bindHost === "unix";

    // Unix socket listener
    if (params.unixSocketPath) {
      const httpServer = createGatewayHttpServer({
        canvasHost,
        clients,
        controlUiEnabled: params.controlUiEnabled,
        controlUiBasePath: params.controlUiBasePath,
        controlUiRoot: params.controlUiRoot,
        openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
        openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
        openResponsesEnabled: params.openResponsesEnabled,
        openResponsesConfig: params.openResponsesConfig,
        strictTransportSecurityHeader: params.strictTransportSecurityHeader,
        handleHooksRequest,
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth,
        resolvedAuth: params.resolvedAuth,
        getResolvedAuth: params.getResolvedAuth,
        rateLimiter: params.rateLimiter,
        getReadiness: params.getReadiness,
        tlsOptions: undefined,
      });
      try {
        await listenGatewayUnixSocket({ httpServer, unixSocketPath: params.unixSocketPath });
        httpServers.push(httpServer);
        httpBindHosts.push(`unix:${params.unixSocketPath}`);
        params.log.info(`gateway listening on unix:${params.unixSocketPath}`);
      } catch (err) {
        if (unixSocketRequired) {
          throw err;
        }
        params.log.warn(
          `gateway: failed to bind unix socket ${params.unixSocketPath} (${String(err)}); continuing with TCP only`,
        );
        try {
          httpServer.close();
        } catch {
          /* ignore */
        }
      }
    }

    // TCP listeners (when not Unix-only)
    if (params.bindHost !== "unix") {
      const bindHosts = await resolveGatewayListenHosts(params.bindHost);
      if (!isLoopbackHost(params.bindHost)) {
        params.log.warn(
          "⚠️  Gateway is binding to a non-loopback address. " +
            "Ensure authentication is configured before exposing to public networks.",
        );
      }
      if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
        params.log.warn(
          "⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. " +
            "Host-header origin fallback weakens origin checks and should only be used as break-glass.",
        );
      }
      for (const host of bindHosts) {
        const httpServer = createGatewayHttpServer({
          canvasHost,
          clients,
          controlUiEnabled: params.controlUiEnabled,
          controlUiBasePath: params.controlUiBasePath,
          controlUiRoot: params.controlUiRoot,
          openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
          openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
          openResponsesEnabled: params.openResponsesEnabled,
          openResponsesConfig: params.openResponsesConfig,
          strictTransportSecurityHeader: params.strictTransportSecurityHeader,
          handleHooksRequest,
          handlePluginRequest,
          shouldEnforcePluginGatewayAuth,
          resolvedAuth: params.resolvedAuth,
          rateLimiter: params.rateLimiter,
          getReadiness: params.getReadiness,
          tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
        });
        try {
          await listenGatewayHttpServer({
            httpServer,
            bindHost: host,
            port: params.port,
          });
          httpServers.push(httpServer);
          httpBindHosts.push(host);
        } catch (err) {
          if (host === bindHosts[0]) {
            if (httpServers.length > 0) {
              params.log.warn(
                `gateway: failed to bind TCP ${host}:${params.port} (${String(err)}); other listeners still active`,
              );
              try {
                httpServer.close();
              } catch {
                /* ignore */
              }
            } else {
              throw err;
            }
          } else {
            params.log.warn(
              `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
            );
          }
        }
      }
    }

    const httpServer = httpServers[0];
    if (!httpServer) {
      throw new Error("Gateway HTTP server failed to start");
    }
    if (httpBindHosts.length > 0) {
      params.log.info(
        `gateway listen transports: ${httpBindHosts
          .map((h) =>
            h.startsWith("unix:")
              ? `unix_socket=${h.slice("unix:".length)}`
              : `tcp=${h}:${params.port}`,
          )
          .join(" | ")}`,
      );
    }

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
    });
    const preauthConnectionBudget = createPreauthConnectionBudget();
    for (let i = 0; i < httpServers.length; i++) {
      const hostLabel = httpBindHosts[i] ?? "";
      const listenTransport = hostLabel.startsWith("unix:") ? "unix" : "tcp";
      attachGatewayUpgradeHandler({
        httpServer: httpServers[i]!,
        wss,
        gatewayWebSocketEnabled: true,
        listenTransport,
        canvasHost,
        clients,
        preauthConnectionBudget,
        resolvedAuth: params.resolvedAuth,
        getResolvedAuth: params.getResolvedAuth,
        rateLimiter: params.rateLimiter,
        log: params.log,
      });
    }
    // Servers are already bound during creation; startListening is a no-op.
    const startListening = async (): Promise<void> => {};
    const agentRunSeq = new Map<string, number>();
    const dedupe = new Map<string, DedupeEntry>();
    const chatRunState = createChatRunState();
    const chatRunRegistry = chatRunState.registry;
    const chatRunBuffers = chatRunState.buffers;
    const chatDeltaSentAt = chatRunState.deltaSentAt;
    const chatDeltaLastBroadcastLen = chatRunState.deltaLastBroadcastLen;
    const addChatRun = chatRunRegistry.add;
    const removeChatRun = chatRunRegistry.remove;
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const toolEventRecipients = createToolEventRecipientRegistry();

    return {
      canvasHost,
      releasePluginRouteRegistry: () => {
        // Releases both pinned HTTP-route and channel registries set at startup.
        // Release unconditionally: plugin startup/reload can re-pin these
        // surfaces to a registry that differs from the original runtime-state
        // bootstrap registry.
        releasePinnedPluginHttpRouteRegistry();
        // Release unconditionally (no registry arg): the channel pin may have
        // been re-pinned to a deferred-reload registry that differs from the
        // original params.pluginRegistry, so an identity-guarded release would
        // be a no-op and leak the pin across in-process restarts.
        releasePinnedPluginChannelRegistry();
      },
      httpServer,
      httpServers,
      httpBindHosts,
      startListening,
      wss,
      preauthConnectionBudget,
      clients,
      broadcast,
      broadcastToConnIds,
      agentRunSeq,
      dedupe,
      chatRunState,
      chatRunBuffers,
      chatDeltaSentAt,
      chatDeltaLastBroadcastLen,
      addChatRun,
      removeChatRun,
      chatAbortControllers,
      toolEventRecipients,
    };
  } catch (err) {
    releasePinnedPluginHttpRouteRegistry();
    releasePinnedPluginChannelRegistry();
    throw err;
  }
}
