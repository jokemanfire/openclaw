#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;

const tmpDir = fs.mkdtempSync("/tmp/esec-daemon-pkg-");
const pkgDir = path.join(tmpDir, "package");

fs.mkdirSync(pkgDir, { recursive: true });
fs.cpSync(path.join(pluginRoot, "bin"), path.join(pkgDir, "bin"), { recursive: true });

const pkgJson = {
  name: "@zte/esec-shield-daemon",
  version,
  files: ["bin/"],
};
fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

const tgzName = `esec-shield-daemon-${version}.tgz`;
const tgzPath = path.join(tmpDir, tgzName);

// 在 tmpDir 外打包，避免 tar 读取到正在写入的 .tgz
execSync(`tar czf "${tgzPath}" -C "${pkgDir}" .`);

const dest = path.join(pluginRoot, tgzName);
fs.copyFileSync(tgzPath, dest);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`Packed: ${dest}`);
