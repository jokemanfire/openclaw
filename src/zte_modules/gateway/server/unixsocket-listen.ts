// ZTE_ZP_10352809_UnixSocket_BEGIN
import { chmodSync, unlinkSync } from "node:fs";
import type { Server as HttpServer } from "node:http";

import { GatewayLockError } from "../../../infra/gateway-lock.js";

export async function listenGatewayUnixSocket(params: {
  httpServer: HttpServer;
  unixSocketPath: string;
}) {
  const { httpServer, unixSocketPath } = params;

  // Clean up existing socket file if present
  try {
    unlinkSync(unixSocketPath);
  } catch {
    // File doesn't exist or cannot be removed, ignore
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(unixSocketPath);
    });
    chmodSync(unixSocketPath, 0o777);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new GatewayLockError(
        `another gateway instance is already listening on unix:${unixSocketPath}`,
        err,
      );
    }
    throw new GatewayLockError(
      `failed to bind gateway socket on unix:${unixSocketPath}: ${String(err)}`,
      err,
    );
  }
}
// ZTE_ZP_10352809_UnixSocket_END
