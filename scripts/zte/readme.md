# ZTE Mobile Minimal Build

移动端最小化编译方案，通过白名单（include-list）控制只编译和安装需要的插件。

## 文件说明

| 文件                             | 用途                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `mobile-minimal-plugins.txt`     | 插件白名单，每行一个插件目录名，`#` 开头为注释                   |
| `mobile-minimal.env`             | 可 source 的环境脚本，从 txt 文件生成 `OPENCLAW_BUNDLED_PLUGINS` |
| `generate-minimal-workspace.mjs` | 生成最小化的 `pnpm-workspace.yaml`，仅包含白名单内的插件         |

## 环境变量

- `OPENCLAW_BUNDLED_PLUGINS` — **白名单**（优先）。逗号分隔的插件列表，**仅**这些插件会被编译和安装。
- `OPENCLAW_EXCLUDE_BUNDLED_PLUGINS` — 黑名单（兼容旧方案）。当白名单未设置时生效，排除列表中插件。

白名单优先级高于黑名单。两者都未设置时，编译全部插件。

## 使用流程

### 首次/更新插件列表后

```bash
# 安装依赖（仅白名单插件）
pnpm run install:minimal
```

这等价于：

```bash
source scripts/zte/mobile-minimal.env
node scripts/zte/generate-minimal-workspace.mjs   # 生成最小 workspace
pnpm install                                       # 只安装白名单插件依赖
```

### 编译

```bash
# PC 端最小化编译
pnpm run build:minimal

# 手机端编译（build.sh 自动 source mobile-minimal.env）
./build.sh
```

### 恢复

```bash
# 恢复完整 workspace（所有插件）
pnpm run workspace:restore

# 安装完整依赖
pnpm install
```

## 添加/删除插件

编辑 `mobile-minimal-plugins.txt`，然后重新执行 `install:minimal`：

```
# 添加新插件
telegram
openai

# 删除：注释掉或直接删除该行
# anthropic
```

## 编译原理

1. `optional-bundled-clusters.mjs` 的 `shouldBuildBundledCluster` 读取 `OPENCLAW_BUNDLED_PLUGINS`，白名单外的插件返回 `false`
2. `bundled-plugin-build-entries.mjs` 和 `copy-bundled-plugin-metadata.mjs` 调用上述函数，跳过白名单外插件
3. `pnpm-workspace.yaml` 由 `generate-minimal-workspace.mjs` 生成，pnpm 仅安装 workspace 中列出的插件依赖
