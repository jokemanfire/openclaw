#!/usr/bin/env node
// Generate a minimal pnpm-workspace.yaml that only includes extensions
// specified by OPENCLAW_BUNDLED_PLUGINS (include-list) or excludes those
// specified by OPENCLAW_EXCLUDE_BUNDLED_PLUGINS (exclude-list).
//
// Usage:
//   source scripts/zte/mobile-minimal.env
//   node scripts/zte/generate-minimal-workspace.mjs
//   pnpm install
//
// To restore the full workspace:
//   git checkout pnpm-workspace.yaml

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const extensionsRoot = path.join(repoRoot, "extensions");
const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
const backupPath = path.join(repoRoot, "pnpm-workspace.yaml.full.bak");

const INCLUDE_ENV = "OPENCLAW_BUNDLED_PLUGINS";
const EXCLUDE_ENV = "OPENCLAW_EXCLUDE_BUNDLED_PLUGINS";

function parseEnvList(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function getAllExtensions() {
  const dirs = [];
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    }
  }
  return dirs.toSorted();
}

function resolveIncludedPlugins() {
  const includeRaw = process.env[INCLUDE_ENV];
  const excludeRaw = process.env[EXCLUDE_ENV];

  const includeSet = parseEnvList(includeRaw);
  if (includeSet) {
    const allDirs = new Set(getAllExtensions());
    return [...includeSet].filter((p) => allDirs.has(p)).toSorted();
  }

  const excludeSet = parseEnvList(excludeRaw);
  if (excludeSet) {
    return getAllExtensions().filter((p) => !excludeSet.has(p));
  }

  return getAllExtensions();
}

function generateWorkspaceYaml(includedPlugins) {
  const pluginEntries = includedPlugins.map((p) => `  - extensions/${p}`).join("\n");

  return [
    "packages:",
    "  - .",
    "  - ui",
    "  - packages/*",
    pluginEntries,
    "",
    "minimumReleaseAge: 2880",
    "",
    "minimumReleaseAgeExclude:",
    '  - "acpx"',
    '  - "tokenjuice"',
    '  - "@agentclientprotocol/sdk"',
    '  - "axios"',
    '  - "basic-ftp"',
    '  - "hono"',
    '  - "openclaw"',
    '  - "protobufjs"',
    '  - "vite"',
    '  - "@cloudflare/workers-types"',
    '  - "@hono/node-server"',
    '  - "@mariozechner/*"',
    '  - "@openai/codex"',
    '  - "@openai/codex-*"',
    '  - "@typescript/native-preview*"',
    '  - "@types/node"',
    '  - "@rolldown/*"',
    '  - "@oxlint/*"',
    '  - "@oxfmt/*"',
    '  - "axios@1.15.0"',
    '  - "discord-api-types"',
    '  - "rolldown"',
    '  - "sqlite-vec"',
    '  - "sqlite-vec-*"',
    "",
    "onlyBuiltDependencies:",
    '  - "@discordjs/opus"',
    '  - "@google/genai"',
    '  - "@lydell/node-pty"',
    '  - "@matrix-org/matrix-sdk-crypto-nodejs"',
    '  - "@napi-rs/canvas"',
    '  - "@tloncorp/api"',
    '  - "@whiskeysockets/baileys"',
    '  - "@whiskeysockets/libsignal-node"',
    "  - authenticate-pam",
    "  - esbuild",
    "  - node-llama-cpp",
    "  - protobufjs",
    "  - sharp",
    "",
    "ignoredBuiltDependencies:",
    "  - koffi",
    "  - tree-sitter-bash",
    "",
  ].join("\n");
}

function main() {
  const includedPlugins = resolveIncludedPlugins();

  if (includedPlugins.length === 0) {
    console.error("Error: No plugins resolved to include. Check your env variables.");
    process.exit(1);
  }

  const allPluginCount = getAllExtensions().length;
  console.log(`Resolved: ${includedPlugins.length} plugins (from ${allPluginCount} total)`);

  // Backup original if not already backed up
  if (fs.existsSync(workspacePath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(workspacePath, backupPath);
    console.log(`Backed up original to ${backupPath}`);
  }

  // Write workspace
  const content = generateWorkspaceYaml(includedPlugins);
  fs.writeFileSync(workspacePath, content, "utf-8");
  console.log(`Wrote ${workspacePath}`);
}

main();
