---
summary: "Create shareable Gateway diagnostics bundles for bug reports"
title: "Diagnostics export"
read_when:
  - Preparing a bug report or support request
  - Debugging Gateway crashes, restarts, memory pressure, or oversized payloads
  - Reviewing what diagnostics data is recorded or redacted
---

OpenClaw can create a local diagnostics zip for bug reports. It combines
sanitized Gateway status, health, logs, config shape, and recent payload-free
stability events.

Treat diagnostics bundles like secrets until you have reviewed them. They are
designed to omit or redact payloads and credentials, but they still summarize
local Gateway logs and host-level runtime state.

## Quick start

```bash
openclaw gateway diagnostics export
```

The command prints the written zip path. To choose a path:

```bash
openclaw gateway diagnostics export --output openclaw-diagnostics.zip
```

For automation:

```bash
openclaw gateway diagnostics export --json
```

## Chat command

Owners can use `/diagnostics [note]` in chat to request a local Gateway export.
Use this when the bug happened in a real conversation and you want one
copy-pasteable report for support:

1. Send `/diagnostics` in the conversation where you noticed the problem. Add a
   short note if it helps, for example `/diagnostics bad tool choice`.
2. OpenClaw sends the diagnostics preamble and asks for one explicit exec
   approval. The approval runs `openclaw gateway diagnostics export --json`.
   Do not approve diagnostics through an allow-all rule.
3. After approval, OpenClaw replies with a pasteable report containing the local
   bundle path, manifest summary, privacy notes, and relevant session ids.

In group chats, an owner can still run `/diagnostics`, but OpenClaw does not
post the diagnostic details back into the shared chat. It sends the preamble,
approval prompts, Gateway export result, and Codex session/thread breakdown to
the owner through the private approval route. The group only gets a short notice
that the diagnostics flow was sent privately. If OpenClaw cannot find a private
owner route, the command fails closed and asks the owner to run it from a DM.

When the active OpenClaw session is using the native OpenAI Codex harness,
the same exec approval also covers an OpenAI feedback upload for the Codex
runtime threads OpenClaw knows about. That upload is separate from the local
Gateway zip and appears only for Codex harness sessions. Before approval, the
prompt explains that approving diagnostics will also send Codex feedback, but it
does not list Codex session or thread ids. After approval, the chat reply lists
the channels, OpenClaw session ids, Codex thread ids, and local resume commands
for the threads that were sent to OpenAI servers. If you deny or ignore the
approval, OpenClaw does not run the export, does not send Codex feedback, and
does not print the Codex ids.

That makes the common Codex debugging loop short: notice the bad behavior in
Telegram, Discord, or another channel, run `/diagnostics`, approve once, share
the report with support, then run the printed `codex resume <thread-id>` command
locally if you want to inspect the native Codex thread yourself. See
[Codex harness](/plugins/codex-harness#inspect-codex-threads-locally) for
that inspection workflow.

## What the export contains

The zip includes:

- `summary.md`: human-readable overview for support.
- `diagnostics.json`: machine-readable summary of config, logs, status, health,
  and stability data.
- `manifest.json`: export metadata and file list.
- Sanitized config shape and non-secret config details.
- Sanitized log summaries and recent redacted log lines.
- Best-effort Gateway status and health snapshots.
- `stability/latest.json`: newest persisted stability bundle, when available.

The export is useful even when the Gateway is unhealthy. If the Gateway cannot
answer status or health requests, the local logs, config shape, and latest
stability bundle are still collected when available.

## Privacy model

Diagnostics are designed to be shareable. The export keeps operational data
that helps debugging, such as:

- subsystem names, plugin ids, provider ids, channel ids, and configured modes
- status codes, durations, byte counts, queue state, and memory readings
- sanitized log metadata and redacted operational messages
- config shape and non-secret feature settings

The export omits or redacts:

- chat text, prompts, instructions, webhook bodies, and tool outputs
- credentials, API keys, tokens, cookies, and secret values
- raw request or response bodies
- account ids, message ids, raw session ids, hostnames, and local usernames

When a log message looks like user, chat, prompt, or tool payload text, the
export keeps only that a message was omitted and the byte count.

## Stability recorder

The Gateway records a bounded, payload-free stability stream by default when
diagnostics are enabled. It is for operational facts, not content.

The same diagnostic heartbeat records liveness samples when the Gateway keeps
running but the Node.js event loop or CPU looks saturated. These
`diagnostic.liveness.warning` events include event-loop delay, event-loop
utilization, CPU-core ratio, active/waiting/queued session counts, the current
startup/runtime phase when known, recent phase spans, and bounded active/queued
work labels. Idle samples stay in telemetry at `info` level. Liveness samples
become Gateway warnings only when work is waiting or queued, or when active work
overlaps with sustained event-loop delay. Transient max-delay spikes during
otherwise healthy background work stay in debug logs. They do not restart the
Gateway by themselves.

Startup phases also emit `diagnostic.phase.completed` events with wall-clock and
CPU timing. Stalled embedded-run diagnostics mark `terminalProgressStale=true`
when the last bridge progress looked terminal, such as a raw response item or
response completion event, but the Gateway still considers the embedded run
active.

Inspect the live recorder:

```bash
openclaw gateway stability
openclaw gateway stability --type payload.large
openclaw gateway stability --json
```

Inspect the newest persisted stability bundle after a fatal exit, shutdown
timeout, or restart startup failure:

```bash
openclaw gateway stability --bundle latest
```

Create a diagnostics zip from the newest persisted bundle:

```bash
openclaw gateway stability --bundle latest --export
```

Persisted bundles live under `~/.openclaw/logs/stability/` when events exist.

## Useful options

```bash
openclaw gateway diagnostics export \
  --output openclaw-diagnostics.zip \
  --log-lines 5000 \
  --log-bytes 1000000
```

- `--output <path>`: write to a specific zip path.
- `--log-lines <count>`: maximum sanitized log lines to include.
- `--log-bytes <bytes>`: maximum log bytes to inspect.
- `--url <url>`: Gateway WebSocket URL for status and health snapshots.
- `--token <token>`: Gateway token for status and health snapshots.
- `--password <password>`: Gateway password for status and health snapshots.
- `--timeout <ms>`: status and health snapshot timeout.
- `--no-stability-bundle`: skip persisted stability bundle lookup.
- `--json`: print machine-readable export metadata.

## Disable diagnostics

Diagnostics are enabled by default. To disable the stability recorder and
diagnostic event collection:

```json5
{
  diagnostics: {
    enabled: false,
  },
}
```

Disabling diagnostics reduces bug-report detail. It does not affect normal
Gateway logging.

## Tune memory limits

OpenClaw runs on Node.js. The Gateway picks up standard Node memory flags via
`NODE_OPTIONS`, plus a handful of OpenClaw-specific env knobs for trajectory
capture and heap-snapshot collection. These are useful when:

- you run the Gateway on a small VM (Fly micro, Mac mini self-host, Docker
  with a tight memory limit) and the Node defaults overshoot the available RAM,
- you observe `diagnostic.memory.pressure` events in stability data or logs
  and want to investigate what is using the heap, or
- you want to bound trajectory disk usage on a host that already has limited
  storage.

### Node.js heap and new-space limits

```bash
NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=2"
```

- `--max-old-space-size=<MB>` caps V8 old-space (long-lived objects). Set this
  below the host memory limit (for example `512` on a 1 GiB VM, `1024` on a
  2 GiB VM) so V8 starts compacting before the OS OOM killer fires. The
  default on 64-bit Linux is roughly 4 GiB.
- `--max-semi-space-size=<MB>` caps V8 new-space (short-lived allocations).
  Setting this to `2` (down from the default 16 on 64-bit Linux) reduces RSS
  on workloads that produce many short-lived objects (channel listeners,
  request handlers). Going below `2` slows scavenges noticeably; do not set
  to `1` unless you have measured the trade-off.

Set the env on the Gateway service before restart:

```bash
NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=2" openclaw gateway restart
```

For systemd-managed Gateways, add the env to the service unit and run
`openclaw gateway install --force` so the next restart picks it up.

### Trajectory disk and memory budgets

Trajectory capture is on by default. The hard byte ceilings can be tightened
in resource-constrained deployments:

- `OPENCLAW_TRAJECTORY_CAPTURE_MAX_BYTES` (default `10485760`, 10 MiB) — per
  recorder in-memory + accepted byte ceiling.
- `OPENCLAW_TRAJECTORY_FILE_MAX_BYTES` (default `52428800`, 50 MiB) — per
  trajectory file size ceiling.
- `OPENCLAW_TRAJECTORY_EVENT_MAX_BYTES` (default `262144`, 256 KiB) — per
  event JSON line ceiling.
- `OPENCLAW_TRAJECTORY_MAX_WRITERS` (default `100`) — concurrent writer cache
  ceiling.

A typical tightening for a 1 GiB VM:

```bash
OPENCLAW_TRAJECTORY_CAPTURE_MAX_BYTES=2097152 OPENCLAW_TRAJECTORY_MAX_WRITERS=20 openclaw gateway restart
```

Disable trajectory capture entirely with `OPENCLAW_TRAJECTORY=0`. Values
outside the valid range (negative, zero, non-numeric) fall back to the
default; `OPENCLAW_TRAJECTORY_MAX_WRITERS=0` does not disable capture.

### Heap snapshot on critical memory pressure

Gateway emits `diagnostic.memory.pressure` events at warning and critical
levels (RSS / heap / growth thresholds, see [Stability recorder](#stability-recorder)).
Operators can opt into automatic heap snapshots on critical pressure so the
process state is preserved for post-mortem inspection:

```bash
OPENCLAW_MEMORY_HEAP_SNAPSHOT=1 openclaw gateway restart
```

Snapshots land in `~/.openclaw/diagnostics/heap/` with `0o700` directory
permissions. Each successful snapshot writes a `diagnostic.memory.heap-snapshot`
event with the resolved file path, byte size, and write duration. Snapshots
are rate-limited to once per hour by default; tune the cooldown with:

```bash
OPENCLAW_MEMORY_HEAP_SNAPSHOT_COOLDOWN_MS=1800000   # 30 minutes
```

Heap snapshots are expensive (multi-second pause + tens to hundreds of MiB on
disk). Leave the feature off in steady-state production; enable it when you
are actively investigating an RSS-growth incident.

Inspect snapshots with [Chrome DevTools](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots/)
(Memory tab → Load → pick the `.heapsnapshot` file).

## Related

- [Health checks](/gateway/health)
- [Gateway CLI](/cli/gateway#gateway-diagnostics-export)
- [Gateway protocol](/gateway/protocol#system-and-identity)
- [Logging](/logging)
- [OpenTelemetry export](/gateway/opentelemetry) — separate flow for streaming diagnostics to a collector
