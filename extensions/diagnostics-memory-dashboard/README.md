# Diagnostics Memory Dashboard

OpenClaw 插件 — Node.js 进程实时内存与堆诊断仪表盘，提供 WebUI 可视化监控。

## 功能

- **内存采样** — 每 10s 采集 RSS / heap / external / malloced / 堆空间 / CPU / ELU 等指标，最多保留 3600 个样本
- **增长速率** — 计算 RSS 和 Heap Used 的 15s / 1m / 5m 增长率（B/s），快速发现内存泄漏趋势
- **堆空间趋势图** — 按时间堆叠展示 old_space / new_space / code_space 等 V8 堆空间变化
- **GC 事件追踪** — 通过 `PerformanceObserver` 监听 GC 事件（major / minor / incremental / weakcb）及耗时
- **堆快照分析** — 手动触发 `v8.writeHeapSnapshot()`，解析并展示 Top 50 类及 shallow size
- **分配火焰图** — 基于 V8 Inspector `HeapProfiler` 的 allocation sampling，可视化对象分配热点（类似 heapprofd）
- **OS 内存详情** — 解析 `/proc/self/smaps`、`/proc/self/smaps_rollup`、`/proc/self/status`（仅 Linux）
- **内存压力告警** — 订阅插件运行时的 `diagnostic.memory.pressure` 事件
- **主动资源监控** — 展示 `process.getActiveResourcesInfo()` 返回的活跃句柄/请求类型及数量
- **V8 上下文 & 全局句柄** — 显示 native/detached contexts 和 global handles 用量

## 架构

```
src/
├── collectors/
│   ├── memory.ts          # 内存采样：process.memoryUsage() + v8.getHeapStatistics()
│   ├── proc.ts            # OS 层内存：/proc/self/smaps, smaps_rollup, status
│   ├── heap-profiler.ts   # V8 Inspector HeapProfiler 分配采样 (火焰图)
│   ├── heap-snapshot.ts   # 堆快照解析：输出类级别 shallow size 统计
│   └── growth.ts          # 增长率计算
├── dashboard-service.ts   # 核心服务：定时采样、GC 监听、HTTP API
├── html-renderer.ts       # 仪表盘 HTML / CSS / JS 渲染
├── types.ts               # 类型定义
├── constants.ts           # 常量和 GC 类型映射
└── utils.ts               # 字节格式化工具
index.ts                   # 插件入口
api.ts                     # SDK 类型 re-export
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/memory-dashboard` | 仪表盘 HTML 页面 |
| GET | `/api/memory-dashboard/data` | 全部诊断数据 JSON |
| GET | `/api/memory-dashboard/smaps` | `/proc/self/smaps` 解析结果 |
| POST | `/api/memory-dashboard/snapshot` | 触发堆快照并解析 |
| POST | `/api/memory-dashboard/heap-profile/start` | 开始 V8 分配采样 |
| POST | `/api/memory-dashboard/heap-profile/stop` | 停止采样并返回火焰图数据 |
| GET | `/api/memory-dashboard/heap-profile/status` | 采样状态查询 |

## 仪表盘界面

内置单页 WebUI，深色主题，1s 自动轮询刷新：

- 顶部：运行时间、Source Maps 状态、Node 版本
- 卡片网格：RSS / Heap / External / ArrayBuffers / Malloced / Code+Meta 等关键指标
- 进度条：RSS / Heap Used / Heap Total 相对其上限的占比
- 增长率面板：RSS 和 Heap 的即时 / 1 分钟 / 5 分钟增长率
- 图表：内存用量随时间变化（RSS / Heap Used / Heap Total）
- 堆空间趋势：各空间用量堆叠图
- GC 事件列表：类型、耗时、时间戳
- 堆对象统计：类名、实例数、shallow size（支持过滤）
- smaps 内存映射表：路径、RSS / PSS / Private / Shared（支持过滤）
- 分配火焰图：可缩放、可搜索的 SVG 火焰图
- 事件循环利用率面板
- 活跃资源句柄面板
- V8 上下文面板

## 使用前提

- Node.js ≥ 16（GC PerformanceObserver）
- Node.js ≥ 17.9（`getActiveResourcesInfo()`）
- Linux（`/proc/self/smaps` 等 OS 级指标）
- V8 Inspector 可用（火焰图需 `--inspect` 启动参数）

## 火焰图使用

1. 点击 **Start Sampling** 开始 V8 堆分配采样
2. 执行你想分析的内存操作
3. 点击 **Stop & Analyze** 停止采样并生成火焰图
4. 使用搜索框过滤函数名，点击节点可放大查看
5. 支持颜色区分脚本文件、悬停查看自分配量和子节点总量
