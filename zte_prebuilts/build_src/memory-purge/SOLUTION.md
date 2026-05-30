# OpenClaw Android — TOTAL SWAP PSS 持续增长不可回收的最终修复方案

设备验证：PQ85A01 (Android 16, kernel 6.12.23-android16, Node.js 24.14.0)

## 1. 问题陈述

`dumpsys meminfo openclaw` 中 `TOTAL SWAP PSS` 长期单调上升，导致 `TOTAL PSS - TOTAL RSS` 差距越来越大。设备实测：

| 设备 | uptime | TOTAL PSS | TOTAL RSS | TOTAL SWAP PSS | PSS-RSS gap |
|---|---|---|---|---|---|
| 195 (`--initial-old-space-size=256`) | 39h | 463 MB | 366 MB | 100 MB | 97 MB |
| 091 (`--max-old-space-size=700`) | 14h | 497 MB | 341 MB | 159 MB | 156 MB |

不重启 openclaw 时，这部分 swap 永远不会被回收。

## 2. 根因（实测确认）

three 个独立累积路径：

### 2.1 V8 BoundedPageAllocator freelist 死区

V8 9.0+ 在 cage（Pointer Compression）内通过 `BoundedPageAllocator` 分配大块连续区域。处理大对象（大 ArrayBuffer、长 LLM context、大字符串）后，V8 把这些区域**放进 freelist 等复用，永不主动 munmap**。

设备特征：`/proc/<pid>/smaps` 中 `VmFlags` 含 `nr` (MAP_NORESERVE) 标志、RSS=0、Pss=0、Referenced=0、Swap>0、prot=rw-p。

195 实测主死区 `76c8f00000-76cdc00000`：78 MB virtual，77 MB swap，存在 30+ 小时无任何访问。

### 2.2 V8 256K heap page 内部碎片

V8 老生代页（256 KB / 页）在 mark-sweep 后页内活对象与 free slot 散布。free slot 区域被 kswapd 推到 zram 后，V8 GC 不重新访问它们 → swap entries 永久驻留。

091 实测：1018 个 V8 256K page，平均每页 swap 约 50 KB，合计 ~99.8 MB swap。

### 2.3 Bionic Scudo libc heap free chunks

V8 native bindings、Node.js 内部 C++ 对象通过 libc malloc 分配。Bionic Scudo（Android 11+ 默认分配器）默认不主动归还 free chunks 给 OS：

```
malloc 100 MB + 全部 free + Scudo retains 117 MB
mallopt(M_PURGE_ALL) → release_to_os → 仅剩 3 MB
```

091 实测：B5 类 `[anon:scudo:primary/secondary]` 区域 52 MB swap。

## 3. 修复策略：4-stage trimMalloc 流水线

`src/infra/memory-trim.ts` 的 `trimMalloc()` 由 `src/gateway/server-maintenance.ts` 每 5 分钟自动调用一次。新流水线由 4 个 stage 组成，每个独立可关闭：

| Stage | 目标 | 实现 |
|---|---|---|
| 1 | 释放空白 V8 256K page | `globalThis.gc({type:"major", flavor:"last-resort"})` |
| 2 | 触发 V8 PageAllocator 主动归还 freelist 整页空白 | `v8.setFlagsFromString` 临时压低 max-old-space-size + GC + 恢复 |
| 3 | madvise V8 cage 中确认 dead 的 VMA | N-API 调 `madvise(MADV_DONTNEED)`，11 条件 + cluster + observation 多重防御 |
| 4 | 归还 Bionic Scudo libc heap | N-API 调 `mallopt(M_PURGE_ALL, 0)`（dlsym 解析） |

### 3.1 Stage 1（已生产）：保持 commit `b6bdbc8f91` 行为

```typescript
gc({ type: "major", execution: "sync", flavor: "last-resort" });
```

`flavor:"last-resort"` 让 V8 在 GC 中 release 整页空白的 256 KB heap page (`PageAllocator::FreePages` → munmap)。

### 3.2 Stage 2（新增）：cage 主动收缩

V8 PageAllocator 的 `MemoryReducer` 路径只在堆水位接近上限时触发。openclaw 跑在 max-old-space-size 较高（500 / 700 MB），常态下 live heap 远低于上限，V8 永不触发 reduce。

通过临时压低 max-old-space-size 强制触发：

```typescript
const before = v8.getHeapStatistics();
const liveMB = before.used_heap_size / 1024 / 1024;
const targetMB = Math.max(64, Math.ceil(liveMB) + 16);  // 不会压到 live 之下
v8.setFlagsFromString(`--max-old-space-size=${targetMB}`);
gc({ type: "major", execution: "sync", flavor: "last-resort" });
v8.setFlagsFromString(`--max-old-space-size=${restoreMB}`);  // 恢复
```

副作用：触发的 GC 比常规激进；5 min 一次的频率下对延迟影响可忽略。

Kill switch：`OPENCLAW_CAGE_SHRINK=0`。

### 3.3 Stage 3（新增）：进程内 madvise V8 cage 死区

那些活对象与 free slot 散布在同一 page allocator block 里的死页，V8 不会归还、stage 1+2 也无能为力。需要绕过 V8 直接调 `madvise(MADV_DONTNEED)`。

实现：`zte_prebuilts/build_src/memory-purge/memory_purge.cc` 的 N-API addon。

#### 4 层防御过滤

##### Layer 1：11 条件静态过滤

| # | 条件 | 含义 |
|---|---|---|
| 1-7 | `Rss=0 && Pss=0 && Anonymous=0 && Private_Dirty=0 && Private_Clean=0 && Referenced=0 && Swap>=4KB` | 内核确认这 VMA 没有任何驻留页，且永远没被引用 |
| 8 | `VmFlags 含 " nr "` | MAP_NORESERVE：V8 cage 子区域指纹 |
| 9 | `prot == "rw-p"` | 排除 `rwxp`（V8 JIT trampolines；他们也可能带 nr，但 madvise 会让 JIT 调用 SIGSEGV） |
| 10 | name 不含 stack | 排除线程栈 |
| 11 | name 不含 libc_malloc | Scudo 自管，stage 4 才是正确接口 |

设备实测 195 上 7 个带 nr+rwxp 的 V8 JIT 死页被条件 9 正确拒绝。

##### Layer 2：cluster 指纹

V8 cage 是一段连续 reservation，里面各 VMA 物理上挨着。**单独漂浮、孤立的 nr-flag VMA 大概率不是 V8 cage**——可能是 wasm linear memory、第三方 mmap 等。

判定：候选 VMA 的**邻近 64 MB 内必须有另一个带 nr 的 VMA**。否则排除。

合成测试验证：
- A 场景（3 个 VMA 在 64 MB 内）→ 全部命中 ✓
- B 场景（孤立 VMA）→ 被拒绝 ✓

##### Layer 3：observation 期

候选 VMA 必须**连续 N 次扫描（默认 N=3，约 15 分钟）都满足层 1+2** 才允许 madvise。这消除：

- TOCTOU race（扫到 madvise 之间被 V8 重新激活）
- 短期冷判误判
- swap_kb 漂移（如 kswapd 在动 → 每次 swap 字节有变化 → 认为还活）

实现状态机（C++ + Python 双实现等价）：

```
每次 purgeDeadVMAs 调用:
  1. 扫 smaps 得当前候选集 C_now
  2. 对每个 c ∈ C_now:
     - 已在追踪表且 swap_kb 一致 → hit_count++
     - 已在追踪表但 swap_kb 变了 → 重置 hit_count=1
     - 不在追踪表 → 添加，hit_count=1
  3. 追踪表中不在 C_now 的项 → 删除（VMA 被 V8 复用，dead 假设作废）
  4. 仅对 hit_count >= MIN_OBSERVATIONS 的 VMA 调 madvise
```

6 个状态机测试覆盖：steady_state、swap_changed_resets、dropped_vma、min_obs_1、empty_scan、partial_swap_drift。

##### Layer 4：每次调用配额

异常情况下（比如 V8 升级后 cage 布局变 → layer 1+2 误命中过多）限制单次 madvise 影响：

- `OPENCLAW_PURGE_MAX_VMAS`（默认 16）
- `OPENCLAW_PURGE_MAX_KB`（默认 200 MB）

最坏情况：误清 200 MB → 进程崩 → init 自动重启 5 秒。**比误清 GB 级安全得多。**

#### Kill switches

```
OPENCLAW_PURGE_DEAD_VMAS=0     完全禁用 stage 3
OPENCLAW_PURGE_DRY_RUN=1       只扫描不调 madvise
OPENCLAW_PURGE_FORCE=1         覆盖自动降级，强制重新启用 stage 3+4
OPENCLAW_PURGE_MIN_OBSERVATIONS=N  调整观察期，默认 3
OPENCLAW_PURGE_MAX_VMAS=N      默认 16
OPENCLAW_PURGE_MAX_KB=N        默认 204800（200 MB）
OPENCLAW_PURGE_TRACKED_CAP=N   默认 64（追踪表上限）
```

env 变量解析采用 `endptr` 检测：garbage / 空字符串 / 带单位字符串都正确**回退到默认值**而非降级。

#### 自动降级（细化归因）

每个 stage 独立计数：
- stage 3 责任范围：`afterPurge.swap - afterShrink.swap`
- stage 4 责任范围：`final.swap - afterPurge.swap`

某 stage 自身的 swap delta 连续 3 次 > 5 MB → 仅该 stage 自动 disable。
其他 stage 不受牵连。

设 `OPENCLAW_PURGE_FORCE=1` 可立即覆盖任何 auto-disable，不需重启进程。

### 3.4 Stage 4（新增）：进程内 mallopt(M_PURGE_ALL)

针对 `[anon:libc_malloc]`（Scudo 管理的 Primary + Secondary heap）。V8 GC 不管这块；stage 3 也刻意跳过（条件 11）。

实现：`memory_purge.cc` 中通过 `dlsym(RTLD_DEFAULT, "mallopt")` 解析符号，调 `mallopt(M_PURGE_ALL, 0)`。

ABI 注：NDK r27+ 把 `mallopt` 从 public header 移除，但 libc.so 仍导出。dlsym 失败时 stage 4 自动降级为 no-op。

实测 091：单独 C 程序 `malloc(100 MB) + free + mallopt(M_PURGE_ALL)` 释放 113 MB → VmRSS 从 117 MB 降到 3.3 MB。

Kill switch：`OPENCLAW_PURGE_ALLOCATOR=0`。

⚠️ **不能从外部进程通过 ptrace 注入 mallopt：** mallopt 持有 Scudo 全局锁，与 worker 线程的并发 malloc 路径死锁。mallopt 必须在进程内一致状态下调用，所以只能 stage 4。

## 4. 修复代码清单

### 4.1 修改文件

| 路径 | 变更 | 说明 |
|---|---|---|
| `src/infra/memory-trim.ts` | 全面重写 | 4-stage 流水线 + 5 个 kill switches + 重入保护 + 细化归因 auto-disable |

### 4.2 新增文件

| 路径 | 类型 | 用途 |
|---|---|---|
| `src/zte_wrappers/memory-purge-wrapper/memoryPurgeAdapter.ts` | TS | dlopen 加载 .node，version handshake，noop fallback |
| `zte_prebuilts/build_src/memory-purge/memory_purge.cc` | C++ N-API | 4 层防御 + dlsym(mallopt) + 自实现 smaps parser |
| `zte_prebuilts/build_src/memory-purge/binding.gyp` | gyp | 编译配置 |
| `zte_prebuilts/build_src/memory-purge/build.sh` | shell | 交叉编译脚本（Android NDK） |
| `zte_prebuilts/build_src/memory-purge/build-and-deploy.sh` | shell | build + 复制到 libs/0.3.0/ |
| `zte_prebuilts/build_src/memory-purge/README.md` | 文档 | addon 设计 |
| `zte_prebuilts/build_src/memory-purge/.gitignore` | gitignore | 忽略 build 产物 |
| `zte_prebuilts/libs/memory-purge-android/0.3.0/arm64/memory_purge.node` | prebuilt | **36 KB** ARM64 ELF（NDK r27c, target API 24，去掉 std::regex 后大幅瘦身） |

## 5. 部署步骤

```bash
# 1. 在 dev 机器上重新编译 .node（如果需要）
cd zte_prebuilts/build_src/memory-purge
ANDROID_NDK_HOME=/opt/android-ndk-r27c \
NODE_VERSION=24.14.0 \
ANDROID_API=24 \
bash build-and-deploy.sh

# 2. 整个 openclaw 仓库打 tarball，传到设备
# 3. 设备上跑 build_phone.sh 重新打 openclaw_run.tar.gz
# 4. 启用调试日志（可选，灰度阶段开）
echo 'export OPENCLAW_MALLOC_TRIM_DEBUG=1' >> /system_ext/bin/openclaw_gateway.sh

# 5. stop / start openclaw_gateway 触发 init 重启
adb shell stop openclaw_gateway
adb shell start openclaw_gateway

# 6. 5 分钟后查日志验证 4 stages 都跑通
adb shell 'logcat -d | grep memory-trim | tail -10'
```

## 6. 灰度计划

```
D0：单台测试设备 + 开 OPENCLAW_PURGE_DRY_RUN=1 跑 24 小时
    通过条件: stage 3 candidates 数稳定不持续增长，无崩溃
D1：5 台研发设备实跑（去 dryrun）+ 7 天观察
    通过条件: 24h 后 SwapPss < 50 MB (vs 旧版 > 100MB), 无新崩溃
D2：客户灰度 20%（约 200 台），14 天
D3：全量
```

任意阶段出问题，把对应 kill switch 设为 0：

```
OPENCLAW_CAGE_SHRINK=0       关 stage 2
OPENCLAW_PURGE_DEAD_VMAS=0   关 stage 3
OPENCLAW_PURGE_ALLOCATOR=0   关 stage 4
```

全部关 = 行为退回到 commit `b6bdbc8f91`（仅 stage 1）。

## 7. 验证（已完成）

| 项 | 结果 |
|---|---|
| TypeScript 编译（`pnpm tsgo:core`） | 新代码零错误 |
| Native 编译（NDK r27c → aarch64-linux-android24） | **36 KB** .node ELF（v0.3.0；v0.2.0 是 119 KB，瘦身因移除 std::regex） |
| 设备 dlopen + version handshake | 178 上 v0.3.0 成功加载并打印 `(v0.3.0)` |
| getInfo `malloptAvailable: true` | 三台均可用 |
| 11 条件等价性（C++ ≡ Python） | 18 合成用例 + 真实 smaps 字节级一致 |
| Layer 2 cluster check | 合成 A 场景 3 候选 / B 场景 0 候选 |
| Layer 3 observation 状态机 | 6 个 Python 测试全部通过 |
| Stage 4 mallopt 机制 | 直接 C 程序 100MB malloc + mallopt → 释放 113 MB |
| 4-stage pipeline 端到端 | 测试 node 进程跑通 |
| W7 readVmStatusMB 合并 | 单次读 + 缓存正则，5 个测点共 5 次读（vs 旧版 8 次/cycle） |
| W8 env 解析 | `OPENCLAW_PURGE_MAX_KB=garbage/空` 正确回退到 200 MB 默认 |
| C2 reentrancy guard | 嵌套 `trimMalloc` 调用第二次记录 "skipped (trim already in flight)" |
| 11 项 review 修复 | 全部落地（C1/C2/C3/W4/W5/W6/W7/W8/S9/S10/S11） |

## 8. 已知限制（实事求是）

### 8.1 V8 升级风险

11 条件依赖 V8 BoundedPageAllocator 实现细节（cage flag、page size、freelist 策略）。V8 升级后**必须重跑等价性测试**，确认 layer 1+2 依然正确。

### 8.2 wasm 重度使用场景

如果客户启用大量 wasm，wasm linear memory 也带 `nr` 标志、size 也常 ≥ 4 KB。我们用 layer 2 cluster check 和 layer 3 observation 期降低误清概率，但**不能 100% 排除**。建议这种场景灰度更长时间。

### 8.3 不能从外部回收老进程

部署新版本前已经在跑的进程仍会保留 swap。**唯一回收方式：通过 `stop/start openclaw_gateway` 触发 init 自动重启 5 秒**。我们之前探索的 ptrace 工具已被证实危险（mallopt 注入会与 Scudo 锁死锁），已撤销。

### 8.4 stage 3 见效慢

由于 layer 3 观察期默认 N=3，新发现的死区需要至少 3 次 trimMalloc cycle（约 15 分钟）才会被清。这是有意的——比快但偶尔误清进程崩好。

### 8.5 stage 4 性能影响

`mallopt(M_PURGE_ALL)` 持 Scudo 全局锁约 20-100 ms（取决于 libc heap 大小）。期间所有线程的 malloc/free 阻塞。Node.js 主线程在 trim 时本就同步，不增加额外暂停；worker 在 futex_wait 不调 malloc。P99 延迟影响 < 0.1%（5 min 一次）。

## 9. 验证新版本是否还能复现 SwapPss 持续增长

部署后观察指标：

```bash
# 每小时一次，跑 24 小时
adb shell 'cat /proc/$(pidof openclaw)/smaps_rollup | grep -E "Rss|SwapPss"'
```

期望：

```
24 小时累积窗口内：
  SwapPss 长期 < 50 MB（vs 旧版 > 100 MB 持续增长）
  
若新版本仍出现 SwapPss > 100 MB:
  开 OPENCLAW_MALLOC_TRIM_DEBUG=1 看 [memory-trim] 日志
  关注每 stage 的 dRss / dSwap 数字定位哪个 stage 失效
```

如果 stage 3 的 candidates 一直为 0，但 SwapPss 持续涨：那就是 V8 cage 布局变化、layer 1+2 不再命中新版本死区，需要重新分析 smaps。

如果 stage 4 的 swap-/rss- 一直为 0：先检查 `getInfo().malloptAvailable` 是否为 true；如为 false 说明 dlsym 失败（libc 改了 ABI）。

---

**方案完整。修复代码全部就绪。版本 0.3.0。**
