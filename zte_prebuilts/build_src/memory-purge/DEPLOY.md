# 部署与验证指南 — memory-purge v0.3.0

完整流程：dev 机器构建 → 设备部署 → 灰度验证 → 成功判定 → 失败回滚。

适用版本：`memory_purge.node` 0.3.0（4-stage trimMalloc 流水线 + 4 层防御过滤）。

---

## 0. 前置条件

### 0.1 dev 机器（Linux x86_64）

| 工具 | 版本 | 用途 |
|---|---|---|
| Android NDK | r27c 已验证 / r28+ 兼容 | 交叉编译 .node |
| Node.js headers | 与设备 node-core 同版本（当前 24.14.0） | 编译 N-API |
| pnpm | 同 openclaw 仓库要求 | 构建 TS |

### 0.2 目标设备（Android arm64）

| 项 | 要求 |
|---|---|
| Android 版本 | 11+ (API 30+)，已验证 16 (API 36) |
| 架构 | arm64 |
| openclaw 启动脚本 | 已含 `--expose-gc`（stage 1+2 必须） |
| 写入权限 | `/system_ext/` overlay rw 或 `/data/` |

---

## 1. 一次性构建 native .node（dev 机器）

```bash
# 装 NDK r27c（也可 r28+，参数同步调整）
cd /opt
sudo wget https://dl.google.com/android/repository/android-ndk-r27c-linux.zip
sudo unzip -q android-ndk-r27c-linux.zip
export ANDROID_NDK_HOME=/opt/android-ndk-r27c

# 构建并部署到 zte_prebuilts/libs/
cd <repo>/zte_prebuilts/build_src/memory-purge
export NODE_VERSION=24.14.0    # 必须与设备 node-core 版本一致
export ANDROID_API=24
bash build-and-deploy.sh
```

预期产物：

```
zte_prebuilts/libs/memory-purge-android/0.3.0/arm64/memory_purge.node  (~36 KB)
```

验证：

```bash
file zte_prebuilts/libs/memory-purge-android/0.3.0/arm64/memory_purge.node
# 期望: ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV), for Android 24+
```

> **重要**：`NATIVE_VERSION` 在三个地方必须一致：
> - `memory_purge.cc:774` (C++ getInfo).version
> - `memoryPurgeAdapter.ts:103` 的 `NATIVE_VERSION` 常量
> - `zte_prebuilts/libs/memory-purge-android/<NATIVE_VERSION>/arm64/...` 目录路径
> wrapper 在 dlopen 后会做版本 handshake，三者不一致就静默 noop。

---

## 2. 部署到设备

部署生效**必然触发 openclaw 重启**（init 自动重启，约 5 秒业务中断）。这是物理事实——新代码必须由 openclaw 进程加载。

### 2.1 标准路径：通过 build_phone.sh

```bash
# dev 机：保证仓库已 commit / staged
cd <repo>
git status

# 把仓库（含新 .node 和 TS 改动）打成 tarball 传到设备
# 具体方法依现有 ZTE 部署流程

# 设备：跑 build_phone.sh 重打 openclaw_run.tar.gz
adb -s <DEVICE> shell "cd /data/openclaw && bash /data/openclaw/build_phone.sh"

# 触发 init 重启
adb -s <DEVICE> shell "stop openclaw_gateway"
adb -s <DEVICE> shell "start openclaw_gateway"
```

### 2.2 启用调试日志（灰度阶段强烈建议）

灰度期间必须开启日志：

```bash
# 编辑 /system_ext/bin/openclaw_gateway.sh，在 node-core 启动行之前加：
export OPENCLAW_MALLOC_TRIM_DEBUG=1
```

或临时性 append（重启 openclaw 即生效）：

```bash
adb -s <DEVICE> shell '
echo "export OPENCLAW_MALLOC_TRIM_DEBUG=1" >> /system_ext/bin/openclaw_gateway.sh
stop openclaw_gateway
start openclaw_gateway
'
```

---

## 3. 验证流程（三阶段灰度）

### 阶段 A：dryRun 验证 24 小时

`stage 3` 的 madvise 不真跑，仅扫候选并打日志。`stage 1+2+4` 正常工作。

```bash
# 启动脚本加：
export OPENCLAW_PURGE_DRY_RUN=1
export OPENCLAW_MALLOC_TRIM_DEBUG=1
```

观察日志（每 5 分钟一行）：

```bash
adb -s <DEVICE> shell 'logcat -d | grep memory-trim | tail -20'
```

预期格式：

```
[memory-trim] [periodic] rss=290->285MB swap=120->120MB \
  gc:ok[dRss=-5,dSwap=0] \
  shrink:released=2MB[dRss=0,dSwap=0] \
  purge:dryRun=2vmas(100KB)[dRss=0,dSwap=0] \
  mallopt:mallopt-ok rss-=8704KB swap-=512KB[dRss=-9,dSwap=-1]
```

**阶段 A 通过条件：**

| 项 | 标准 |
|---|---|
| 加载日志 | `[memory-purge] loaded native addon from .../0.3.0/arm64/memory_purge.node (v0.3.0)` |
| stage 1 | `gc:ok` 或 `gc:disabled`（如显式关）；不应 `no-gc`（说明 `--expose-gc` 没传） |
| stage 2 | `shrink:released=NMB`，N 通常 0-5 MB |
| stage 3 dryRun candidates | 数量稳定，不随 uptime 持续增长 |
| stage 3 dryRun candidates 内容 | 全部是 nr-flag、rw-p、name=`[anon]` |
| stage 4 | `mallopt-ok rss-=NKB`；不应 `no-mallopt`（dlsym 失败） |
| 进程稳定 | `pidof openclaw` 始终一致；无 segfault；业务端口持续监听 |
| `dmesg` | 无 openclaw 相关 OOM/segv |

### 阶段 B：去掉 dryRun，5 台设备 7 天

```bash
# 删除 OPENCLAW_PURGE_DRY_RUN 行
adb -s <DEVICE> shell 'sed -i "/OPENCLAW_PURGE_DRY_RUN/d" /system_ext/bin/openclaw_gateway.sh'
adb -s <DEVICE> shell 'stop openclaw_gateway && start openclaw_gateway'
```

预期日志：

```
[memory-trim] [periodic] rss=290->220MB swap=120->45MB \
  gc:ok[...] \
  shrink:released=2MB[...] \
  purge:purged=2/2stable/2cand reclaimed=100KB skip=obs:0+lim:0[dRss=0,dSwap=-100] \
  mallopt:mallopt-ok rss-=15MB swap-=8MB[dRss=-15,dSwap=-8]
```

**阶段 B 通过条件：**

| 项 | 标准 |
|---|---|
| `purged == stable <= candidates` | 算式恒成立 |
| `failed=0` | 无 madvise EFAULT |
| 24h 后 SwapPss | < 50 MB（vs 旧版 > 100 MB 持续增长） |
| 无 auto-disable 日志 | `AUTO-DISABLED` 不出现 |
| 无崩溃 | `dmesg` / tombstones 无新增 |
| 业务延迟 P99 | 无可测量增加（trim 总耗时 < 200ms，5 min 一次） |

### 阶段 C：客户灰度 20%（约 200 台）14 天 → 全量

部署同阶段 B，监控同上 + 客户侧业务指标。

---

## 4. 监控指标（生产）

每小时一次，写入告警系统：

```bash
adb -s <DEVICE> shell '
PID=$(pidof openclaw)
SP=$(awk "/^SwapPss:/ {print \$2}" /proc/$PID/smaps_rollup)
echo "$(date +%s) $PID $SP"
'
```

告警阈值：

| 指标 | 阈值 | 处置 |
|---|---|---|
| SwapPss | > 100 MB 持续 2h | 立即查 `[memory-trim]` 日志 |
| `AUTO-DISABLED` 出现 | 任一次 | 调查 swap 上升原因；可设 `OPENCLAW_PURGE_FORCE=1` 临时覆盖 |
| openclaw PID 变化 | 任意一次 | 进程被重启；查 `dmesg` 找原因 |
| `mallopt:no-mallopt` | 持续 | dlsym 失败；libc 升级了；Stage 4 失效 |

---

## 5. 失败判定与回滚

### 5.1 灰度阶段任一失败标志

立即停止扩量，把对应 stage 关掉：

```bash
# 关单个 stage（按怀疑对象）
echo "export OPENCLAW_PURGE_DEAD_VMAS=0" >> /system_ext/bin/openclaw_gateway.sh   # 关 stage 3
echo "export OPENCLAW_PURGE_ALLOCATOR=0" >> /system_ext/bin/openclaw_gateway.sh   # 关 stage 4
echo "export OPENCLAW_CAGE_SHRINK=0" >> /system_ext/bin/openclaw_gateway.sh        # 关 stage 2
echo "export OPENCLAW_LAST_RESORT_GC=0" >> /system_ext/bin/openclaw_gateway.sh     # 关 stage 1（不推荐，与原版差距大）

# 重启生效
stop openclaw_gateway && start openclaw_gateway
```

全部 stage 关 = 行为退回 commit `b6bdbc8f91`（仅 V8 last-resort GC 的旧实现）。

### 5.2 自动 disable 后的恢复

如果 stage 3 或 stage 4 因连续 3 次 swap regression 自动 disable，日志会出现：

```
[memory-trim] AUTO-DISABLED stage 3: own swap delta > 5MB for 3 cycles. Set OPENCLAW_PURGE_FORCE=1 to override.
```

恢复方法（不重启进程）：

```bash
# 临时覆盖（重启前生效）
adb -s <DEVICE> shell '
echo "export OPENCLAW_PURGE_FORCE=1" >> /system_ext/bin/openclaw_gateway.sh
stop openclaw_gateway && start openclaw_gateway
'
```

> 注意：`OPENCLAW_PURGE_FORCE=1` 是**应急覆盖**。先排查为什么 swap 在 stage 3/4 后还涨：可能是其他业务负载在并发增长 swap。

### 5.3 完全回退 .node

```bash
# 删除 .node，wrapper 自动 noop（stage 3+4 失效，stage 1+2 仍工作）
adb -s <DEVICE> shell 'rm /data/openclaw/openclaw_run/zte_prebuilts/libs/memory-purge-android/0.3.0/arm64/memory_purge.node'
stop openclaw_gateway && start openclaw_gateway
```

或代码层 revert 提交后重新部署。

---

## 6. 所有 env 变量速查

| 变量 | 默认 | 取值 | 作用 |
|---|---|---|---|
| `OPENCLAW_MALLOC_TRIM_DEBUG` | 不设 | `1` | 启用详细 `[memory-trim]` 日志 |
| `OPENCLAW_LAST_RESORT_GC` | 启用 | `0` | 关 stage 1 |
| `OPENCLAW_CAGE_SHRINK` | 启用 | `0` | 关 stage 2 |
| `OPENCLAW_PURGE_DEAD_VMAS` | 启用 | `0` | 关 stage 3 |
| `OPENCLAW_PURGE_DRY_RUN` | 不设 | `1` | stage 3 只扫不清 |
| `OPENCLAW_PURGE_ALLOCATOR` | 启用 | `0` | 关 stage 4 |
| `OPENCLAW_PURGE_FORCE` | 不设 | `1` | 覆盖 stage 3/4 自动 disable |
| `OPENCLAW_PURGE_MIN_OBSERVATIONS` | 3 | 1-100 | stage 3 观察期 cycle 数 |
| `OPENCLAW_PURGE_MAX_VMAS` | 16 | 1-1024 | stage 3 单次最多 madvise VMA 数 |
| `OPENCLAW_PURGE_MAX_KB` | 204800 (200MB) | ≥ 1024 | stage 3 单次最多 madvise 字节 |
| `OPENCLAW_PURGE_TRACKED_CAP` | 64 | 16-4096 | stage 3 追踪表上限（淘汰最低 hit_count） |

env 变量解析采用 `endptr` 检测：garbage / 空字符串 / 带单位都正确**回退默认**而非降级到 floor。

---

## 7. 不同设备形态的预期效果

基于实测分析（参见 `SOLUTION.md` 第 5 节）。同一方案在不同设备命中的 stage 不同，**这正是 4-stage 设计的目的**：

| 设备形态 | 主要故障源 | 主要受益 stage | 预期 SwapPss 改善 |
|---|---|---|---|
| **长 uptime + 大 max-old-space**（如 091） | V8 内部碎片（B2/B5）多 | Stage 1+2 控速 | ~30-50%（gap 不再增长） |
| **中等 uptime + 频繁 native call**（如 178） | Scudo libc/secondary 多 | Stage 4 主清 | ~50-70% |
| **遇到大 V8 cage 死区**（如 195 早期） | nr-flag 死区集中 | Stage 3 主清 | ~60-70% |
| **冷启动后短期内** | 几乎无积累 | trim 多为 no-op | 无显著变化（正常） |

部署后**至少需要 24 小时观察**才能判定收益（让 swap 累积或释放达到稳态）。

---

## 8. 故障诊断速查表

| 现象 | 可能原因 | 排查 |
|---|---|---|
| 日志没 `[memory-trim]` | `OPENCLAW_MALLOC_TRIM_DEBUG` 未启用 | 加 env 重启 |
| 日志没 `[memory-purge] loaded` | .node 没找到或版本不匹配 | 检查路径 `0.3.0/arm64/`、运行 `adb shell file` 确认 ELF 有效 |
| `mallopt:no-mallopt` | dlsym(mallopt) 失败 | 该设备 libc 不导出 mallopt（非常规）；stage 4 自动降级，可接受 |
| `purge:noop` | wrapper 命中 noop binding | 看 `[memory-purge]` 加载日志找原因（路径/version） |
| `purge:purged=0/0stable/Ncand`，N 持续增长 | candidates 在涨但 stable=0 | min_observations 设太大；或 swap 在变化导致 hit_count 重置 |
| `failed > 0` | madvise EFAULT 等内核错误 | 检查 `errors[]` 数组里具体 errno；可能 V8 重映射了候选 VMA |
| `AUTO-DISABLED stage N` | 该 stage 后 swap 反涨 5MB+ × 3 次 | 业务侧 swap 在涨；调查或设 `OPENCLAW_PURGE_FORCE=1` |
| trim 间隔 > 5 分钟 | trimMalloc 重入被跳过 | 找日志中 `skipped (trim already in flight)`；正常情况罕见 |
| openclaw 重启 | madvise 误清活区 | 必查 dmesg + tombstones；立即关 stage 3：`OPENCLAW_PURGE_DEAD_VMAS=0` |

---

## 9. 验收 checklist（部署后第 7 天）

```
[ ] 灰度 5+ 台设备运行 7 天，进程稳定（PID 不变）
[ ] 24h 累积 SwapPss 中位数 < 50 MB（vs 旧版 > 100 MB 单调增长）
[ ] dmesg / tombstones 无 openclaw 相关 segfault 或 abort
[ ] 业务接口 P99 延迟相比旧版无回归
[ ] [memory-trim] 日志中 stage 1/2/3/4 都有非 disabled/noop 输出
[ ] 无 AUTO-DISABLED 日志，或出现后能定位到合理原因
[ ] mallopt 在所有设备上 available=true
[ ] dryRun 阶段的 candidates 数稳定（不随 uptime 单调增长）
```

全部勾选 → 进入下一阶段灰度（20% / 全量）。

---

## 文档相关

- 方案设计与根因分析：`SOLUTION.md`
- N-API addon 设计与 4 层防御：`README.md`
- 部署与验证（本文）：`DEPLOY.md`
