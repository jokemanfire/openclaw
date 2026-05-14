import fs from "node:fs";
import path from "node:path";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";

const DEFAULT_TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;

// Resolve a positive-integer byte budget from an env var, falling back to the
// hard-coded default. Values <= 0, non-numeric, or non-finite fall back to the
// default. Negative / zero is treated as invalid so an operator cannot
// accidentally disable trajectory capture by writing `0`; explicit disable
// still uses `OPENCLAW_TRAJECTORY=0` (handled elsewhere in the runtime).
function resolveTrajectoryByteBudget(envValue: string | undefined, defaultBytes: number): number {
  if (typeof envValue !== "string") {
    return defaultBytes;
  }
  const trimmed = envValue.trim();
  if (!trimmed) {
    return defaultBytes;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultBytes;
  }
  return Math.floor(parsed);
}

// Trajectory byte budgets are resolved at module-load time from env so a
// resource-constrained operator can dial them down via
// `OPENCLAW_TRAJECTORY_CAPTURE_MAX_BYTES` / `OPENCLAW_TRAJECTORY_FILE_MAX_BYTES`
// / `OPENCLAW_TRAJECTORY_EVENT_MAX_BYTES`. Defaults match the historical
// hard-coded values so existing deployments are not affected by this change.
export const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES = resolveTrajectoryByteBudget(
  process.env.OPENCLAW_TRAJECTORY_CAPTURE_MAX_BYTES,
  DEFAULT_TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES,
);
export const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = resolveTrajectoryByteBudget(
  process.env.OPENCLAW_TRAJECTORY_FILE_MAX_BYTES,
  DEFAULT_TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
);
export const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = resolveTrajectoryByteBudget(
  process.env.OPENCLAW_TRAJECTORY_EVENT_MAX_BYTES,
  DEFAULT_TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
);

type TrajectoryPointerOpenFlagConstants = Pick<
  typeof fs.constants,
  "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof fs.constants, "O_NOFOLLOW">>;

export function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}

export function resolveTrajectoryPointerOpenFlags(
  constants: TrajectoryPointerOpenFlagConstants = fs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_TRUNC |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

function resolveContainedPath(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, fileName);
  if (resolvedFile === resolvedBase || !isPathInside(resolvedBase, resolvedFile)) {
    throw new Error("Trajectory file path escaped its configured directory");
  }
  return resolvedFile;
}

export function resolveTrajectoryFilePath(params: {
  env?: NodeJS.ProcessEnv;
  sessionFile?: string;
  sessionId: string;
}): string {
  const env = params.env ?? process.env;
  const dirOverride = env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return resolveContainedPath(
      resolveHomeRelativePath(dirOverride),
      `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`,
    );
  }
  if (!params.sessionFile) {
    return path.join(
      process.cwd(),
      `${safeTrajectorySessionFileName(params.sessionId)}.trajectory.jsonl`,
    );
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

export function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}
