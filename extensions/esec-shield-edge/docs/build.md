# 编译打包指南

## 1. 构建 Daemon（Go 二进制）

在扩展目录下执行：

```bash
cd extensions/esec-shield-edge
```

- **本地编译（Linux amd64/arm64）**
  ```bash
  npm run build:daemon:local
  ```

- **Docker 编译（默认 Linux）**
  ```bash
  npm run build:daemon
  ```

- **指定目标平台**
  ```bash
  npm run build:daemon:linux
  npm run build:daemon:darwin
  npm run build:daemon:windows
  ```

产物输出到 [`bin/`](extensions/esec-shield-edge/bin:1) 目录，包含：
- `esec-shield-daemon-edge-v{version}-{os}-{arch}[.exe]`
- `checksums.txt`

> **参数说明**：`build.sh` 支持 `--version`、`--os`、`--arch`、`--docker`、`--docker-registry` 等参数，详见 `./daemon/build.sh --help`。

---

## 2. 构建 JS 扩展

返回仓库根目录，编译 TypeScript 入口文件：

```bash
cd ../..
npm run build:extensions -- esec-shield-edge
```

- 使用 esbuild 将 [`index.ts`](extensions/esec-shield-edge/index.ts:1) 打包为 `dist/index.js`
- 产物：[`dist/`](extensions/esec-shield-edge/dist) 目录

---

## 3. 打包分发

```bash
npm run pack:extension -- esec-shield-edge
```

产物输出到 [`.artifacts/packs/openclaw-esec-shield-edge-{version}.tgz`](.artifacts/packs:1)，内容包含：
- `bin/` — Daemon 可执行文件
- `dist/` — JS 打包产物
- `src/` — 源码
- `daemon/` — Go 源码
- `index.ts`、`package.json`、`openclaw.plugin.json`、`tsconfig.json` 等

---

## 快速构建（完整流程）

```bash
cd extensions/esec-shield-edge
npm run build:daemon:local

cd ../..
npm run build:extensions -- esec-shield-edge
npm run pack:extension -- esec-shield-edge
