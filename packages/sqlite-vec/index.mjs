/* Started by Cursor 10131309.A25680412 20260414091022176 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveAdapterImportUrl() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "dist", "lib", "sqliteVecAdapter.js");
    if (fs.existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        "[sqlite-vec bridge] dist/lib/sqliteVecAdapter.js not found; run `pnpm build` from project root.",
      );
    }
    dir = parent;
  }
}

const adapter = await import(resolveAdapterImportUrl());

export function getLoadablePath() {
  return adapter.getLoadablePath();
}

export function load(db) {
  return adapter.loadIntoDb(db);
}
/* Ended by Cursor 10131309.A25680412 20260414091022176 */
