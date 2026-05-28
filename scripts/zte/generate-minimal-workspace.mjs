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

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const extensionsRoot = path.join(repoRoot, "extensions");
const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
const backupPath = path.join(repoRoot, "pnpm-workspace.yaml.full.bak");

// ── Vendor tgz sync from openclaw-recipes ───────────────────────────

const RECIPES_BRANCH = "refs/heads/dev-enhance";
const VENDOR_DIR = path.join(repoRoot, "packages", "zte-vendor");

const VENDOR_FILES = ["zte-agentloop-sdk-6.26.20-b4.tgz", "esec-shield-daemon-2026.5.18.tgz"];

const INCLUDE_ENV = "OPENCLAW_BUNDLED_PLUGINS";
const EXCLUDE_ENV = "OPENCLAW_EXCLUDE_BUNDLED_PLUGINS";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function resolveRecipesRepoUrl() {
  // 1. Full URL env var: OPENCLAW_RECIPES_REPO
  const repoEnv = process.env.OPENCLAW_RECIPES_REPO?.trim();
  if (repoEnv) return repoEnv;

  // 2. Gerrit username from env vars
  let gerritUser =
    process.env.OPENCLAW_RECIPES_GERRIT_USER?.trim() || process.env.GERRIT_USER?.trim();

  // 3. Auto-detect from git config url.* lines (e.g. url.ssh://USER@gerrit.zte.com.cn.*)
  if (!gerritUser) {
    try {
      const raw = execSync("git config -l", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      const m = raw.match(/url\.\S+?\/\/([^@]+)@gerrit\.zte\.com\.cn/);
      if (m) gerritUser = m[1];
    } catch {
      // git config -l not available
    }
  }

  // 4. Fallback: git config gerrit.username
  if (!gerritUser) {
    try {
      const cfg = execSync("git config --get gerrit.username", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3000,
      }).trim();
      if (cfg) gerritUser = cfg;
    } catch {
      // gerrit.username not configured
    }
  }

  if (gerritUser) {
    const host = process.env.OPENCLAW_RECIPES_GERRIT_HOST?.trim() || "gerrit.zte.com.cn";
    return `ssh://${gerritUser}@${host}:29418/AIOS/openclaw-recipes`;
  }

  return null;
}

function syncRecipesVendor() {
  const recipesUrl = resolveRecipesRepoUrl();
  if (!recipesUrl) {
    console.warn("[vendor] Could not determine openclaw-recipes repo URL.");
    console.warn("[vendor] Set OPENCLAW_RECIPES_REPO or OPENCLAW_RECIPES_GERRIT_USER env var.");
    console.warn("[vendor] Skipping vendor sync. Existing vendor files will be used if present.");
    return;
  }

  console.log(`[vendor] Syncing from ${recipesUrl} (branch: ${RECIPES_BRANCH})`);

  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of VENDOR_FILES) {
    const dstPath = path.join(VENDOR_DIR, file);

    try {
      const remoteBytes = execSync(
        `git archive --remote="${recipesUrl}" ${RECIPES_BRANCH} "${file}" | tar -xO`,
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60000,
          maxBuffer: 100 * 1024 * 1024,
        },
      );

      const remoteHash = crypto.createHash("sha256").update(remoteBytes).digest("hex");

      if (fs.existsSync(dstPath)) {
        if (remoteHash === sha256File(dstPath)) {
          skipped++;
          continue;
        }
      }

      fs.writeFileSync(dstPath, remoteBytes);
      updated++;
      console.log(`[vendor] Updated: ${file} (sha256: ${remoteHash.substring(0, 16)}…)`);
    } catch (err) {
      failed++;
      const detail = err.stderr
        ? String(err.stderr).trim().slice(0, 300)
        : String(err.message).slice(0, 300);
      console.warn(`[vendor] Failed to fetch ${file}: ${detail}`);
    }
  }

  if (updated === 0 && skipped === VENDOR_FILES.length) {
    console.log(`[vendor] All ${skipped} vendor files up to date (sha256 matched).`);
  } else if (failed > 0) {
    console.warn(`[vendor] ${updated} updated, ${skipped} skipped, ${failed} failed.`);
    console.warn("[vendor] Existing vendor files will be used if present.");
  }
}

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
  // Step 0: Sync vendor tgz files from openclaw-recipes (non-fatal)
  syncRecipesVendor();

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
