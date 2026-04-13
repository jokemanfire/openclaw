/* Started by Cursor 10131309.A25680412 20260415180633001 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireFn = createRequire(import.meta.url);

export interface SQLiteExtensionHost {
  loadExtension(file: string, entrypoint?: string): void;
}

export interface SqliteVecBinding {
  getLoadablePath(): string;
  load(db: unknown): void;
}

let cached: SqliteVecBinding | null = null;

type AndroidArchTag = "arm64" | "armv7a";

function resolveAndroidArchTag(): AndroidArchTag | null {
  if (process.platform !== "android") {
    return null;
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  if (process.arch === "arm" || process.arch === "armv7l") {
    return "armv7a";
  }
  return null;
}

function getSqliteVecNativeVersion(): string {
  /* Started by Cursor 10131309.A25680412 20260415183045001 */
  const entryPath = requireFn.resolve("sqlite-vec-native");
  const pkgPath = path.join(path.dirname(entryPath), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
  const version = pkg.version?.trim();
  if (!version) {
    throw new Error("sqlite-vec-native/package.json missing version");
  }
  return version;
  /* Ended by Cursor 10131309.A25680412 20260415183045001 */
}

function findRepoRoot(startFilePath: string): string {
  let cursor = path.dirname(startFilePath);
  for (let i = 0; i < 24; i += 1) {
    if (existsSync(path.join(cursor, "zte_prebuilts", "libs"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return process.cwd();
}

/* Started by Cursor 10131309.A25680412 20260415181512001 */
function resolveAndroidLoadablePath(): string | null {
  const archTag = resolveAndroidArchTag();
  if (!archTag) {
    console.error(`[sqlite-vec-adapter] unsupported android arch=${process.arch}`);
    return null;
  }
  const version = getSqliteVecNativeVersion();
  const repoRoot = findRepoRoot(fileURLToPath(import.meta.url));
  const base = path.join(repoRoot, "zte_prebuilts", "libs");
  const candidates = [path.join(base, "sqlite-vec-android", version, archTag, "vec0.so")];

  console.log(
    `[sqlite-vec-adapter] platform=${process.platform} arch=${process.arch} archTag=${archTag}`,
  );
  console.log(`[sqlite-vec-adapter] sqlite-vec-native version=${version}`);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      console.error(`[sqlite-vec-adapter] loadablePath=${candidate}`);
      return candidate;
    }
  }

  console.error(
    `[sqlite-vec-adapter] prebuilt missing version=${version} archTag=${archTag}. Tried:\n${candidates.join("\n")}`,
  );
  return null;
}
/* Ended by Cursor 10131309.A25680412 20260415181512001 */

/* Started by Cursor 10131309.A25680412 20260415181512002 */
function createNoopBinding(reason: string): SqliteVecBinding {
  return {
    getLoadablePath: () => {
      console.error(`[sqlite-vec-adapter] noop getLoadablePath: ${reason}`);
      return "";
    },
    load: () => {
      console.error(`[sqlite-vec-adapter] noop load: ${reason}`);
    },
  };
}

function tryLoadNativeBinding(): SqliteVecBinding | null {
  try {
    const native = requireFn("sqlite-vec-native") as SqliteVecBinding;
    console.error("[sqlite-vec-adapter] fallback to sqlite-vec-native");
    return native;
  } catch (error) {
    console.error(`[sqlite-vec-adapter] fallback sqlite-vec-native failed: ${String(error)}`);
    return null;
  }
}

function createAndroidBinding(): SqliteVecBinding {
  const loadablePath = resolveAndroidLoadablePath();
  if (!loadablePath) {
    const nativeFallback = tryLoadNativeBinding();
    if (nativeFallback) {
      return nativeFallback;
    }
    return createNoopBinding("android prebuilt and native fallback unavailable");
  }
  return {
    getLoadablePath: () => loadablePath,
    load: (db: unknown) => {
      (db as SQLiteExtensionHost).loadExtension(loadablePath);
    },
  };
}
/* Ended by Cursor 10131309.A25680412 20260415181512002 */

function impl(): SqliteVecBinding {
  if (!cached) {
    cached = resolveAndroidArchTag()
      ? createAndroidBinding()
      : (requireFn("sqlite-vec-native") as SqliteVecBinding);
  }
  return cached;
}

export function getModule(): SqliteVecBinding {
  return impl();
}

export function getLoadablePath(): string {
  return impl().getLoadablePath();
}

export function loadIntoDb(db: SQLiteExtensionHost): void {
  impl().load(db);
}
/* Ended by Cursor 10131309.A25680412 20260415180633001 */
