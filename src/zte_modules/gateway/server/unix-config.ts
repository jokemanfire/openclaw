// ZTE_ZP_10352809_UnixSocket_BEGIN
import { execFileSync } from "node:child_process";

/** Android system property / `getprop` key for the gateway Unix socket path. */
export const GATEWAY_UNIX_LISTEN_PROP_US_PATH = "usPath";
/** Android system property / `getprop` key for parallel TCP when Unix is enabled. */
export const GATEWAY_UNIX_LISTEN_PROP_TCP_ENABLED = "tcpEnabled";

/** When env/getprop do not set a path, use this Unix socket path (unless opted out). */
export const DEFAULT_GATEWAY_UNIX_SOCKET_PATH = "/data/misc/openclaw/gateway.sock";

const ENV_US_PATH = "OPENCLAW_GATEWAY_US_PATH";
const ENV_TCP_ENABLED = "OPENCLAW_GATEWAY_TCP_ENABLED";
/** Set to `1` to skip {@link DEFAULT_GATEWAY_UNIX_SOCKET_PATH} (TCP-only unless getprop sets a path). */
const ENV_NO_DEFAULT_UNIX = "OPENCLAW_GATEWAY_NO_DEFAULT_UNIX";

function parseTcpEnabledString(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "(null)") {
    return undefined;
  }
  if (v === "true" || v === "1" || v === "yes") {
    return true;
  }
  if (v === "false" || v === "0" || v === "no") {
    return false;
  }
  return undefined;
}

function getpropValue(name: string): string | undefined {
  try {
    const buf = execFileSync("getprop", [name], {
      encoding: "utf8",
      timeout: 400,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const s = String(buf).trim();
    if (s === "" || s === "(null)") {
      return undefined;
    }
    return s;
  } catch {
    return undefined;
  }
}

/**
 * Reads gateway Unix listen settings from the environment and from Android `getprop`.
 *
 * Precedence per field: `OPENCLAW_*` env vars override `getprop` values.
 *
 * Android: set e.g. `setprop usPath /data/misc/openclaw/gateway.sock` and
 * `setprop tcpEnabled true` (property names are project-defined; some devices require
 * `persist.vendor.*` — use whatever your image allows, or inject via env from init).
 *
 * If nothing sets a path or `tcpEnabled`, defaults are
 * {@link DEFAULT_GATEWAY_UNIX_SOCKET_PATH} and `tcpEnabled: true` (parallel TCP).
 * Set `OPENCLAW_GATEWAY_US_PATH=` (empty) or `OPENCLAW_GATEWAY_NO_DEFAULT_UNIX=1` to avoid the default path.
 */
export function readGatewayUnixListenFromSystem(): {
  usPath?: string;
  tcpEnabled?: boolean;
} {
  const out: { usPath?: string; tcpEnabled?: boolean } = {};
  let explicitEmptyUsPathFromEnv = false;

  if (Object.hasOwn(process.env, ENV_US_PATH)) {
    const t = String(process.env[ENV_US_PATH] ?? "").trim();
    if (t.length === 0) {
      explicitEmptyUsPathFromEnv = true;
    } else {
      out.usPath = t;
    }
  }

  const envTcp = parseTcpEnabledString(process.env[ENV_TCP_ENABLED]);
  if (envTcp !== undefined) {
    out.tcpEnabled = envTcp;
  }

  if (!out.usPath && !explicitEmptyUsPathFromEnv) {
    const gp = getpropValue(GATEWAY_UNIX_LISTEN_PROP_US_PATH)?.trim();
    if (gp) {
      out.usPath = gp;
    }
  }
  if (out.tcpEnabled === undefined) {
    const gpTcp = parseTcpEnabledString(getpropValue(GATEWAY_UNIX_LISTEN_PROP_TCP_ENABLED));
    if (gpTcp !== undefined) {
      out.tcpEnabled = gpTcp;
    }
  }

  const skipDefaultPath = explicitEmptyUsPathFromEnv || process.env[ENV_NO_DEFAULT_UNIX] === "1";

  if (!skipDefaultPath && !out.usPath) {
    out.usPath = DEFAULT_GATEWAY_UNIX_SOCKET_PATH;
  }
  if (out.tcpEnabled === undefined) {
    out.tcpEnabled = true;
  }

  return out;
}
// ZTE_ZP_10352809_UnixSocket_END
