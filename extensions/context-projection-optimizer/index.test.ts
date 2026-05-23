import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildProjectionProfileHintBlock } from "./src/projection.js";

vi.mock("openclaw/plugin-sdk/core", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/core")>();
  return {
    ...actual,
    delegateCompactionToRuntime: vi.fn(),
  };
});

describe("context projection optimizer plugin", () => {
  it("registers a context engine that delegates durable compaction", async () => {
    const registerContextEngine = vi.fn();
    const delegateResult = {
      ok: true,
      compacted: true,
      result: {
        summary: "runtime summary",
        firstKeptEntryId: "entry_1",
        tokensBefore: 100,
        tokensAfter: 40,
      },
    };
    vi.mocked(delegateCompactionToRuntime).mockResolvedValueOnce(delegateResult);

    plugin.register(
      createTestPluginApi({
        id: "context-projection-optimizer",
        name: "Context Projection Optimizer",
        source: "test",
        pluginConfig: { maxToolResultChars: 1000 },
        registerContextEngine,
      }),
    );

    expect(registerContextEngine).toHaveBeenCalledWith(
      "context-projection-optimizer",
      expect.any(Function),
    );
    const factory = registerContextEngine.mock.calls[0]?.[1] as () => unknown;
    const engine = await factory();
    expect((engine as { info?: { ownsCompaction?: boolean } }).info?.ownsCompaction).toBe(false);
    expect(typeof (engine as { assemble?: unknown }).assemble).toBe("function");
    expect(typeof (engine as { compact?: unknown }).compact).toBe("function");

    const compactParams = {
      sessionId: "session_1",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 1000,
      force: true,
    };
    await expect(
      (engine as { compact: (params: typeof compactParams) => Promise<unknown> }).compact(
        compactParams,
      ),
    ).resolves.toEqual(delegateResult);
    expect(delegateCompactionToRuntime).toHaveBeenCalledWith(compactParams);
  });

  it("switches projection profiles from prompt hints", async () => {
    const registerContextEngine = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "context-projection-optimizer",
        name: "Context Projection Optimizer",
        source: "test",
        pluginConfig: {},
        registerContextEngine,
      }),
    );

    const factory = registerContextEngine.mock.calls[0]?.[1] as () => Promise<{
      assemble: (params: {
        messages: Array<Record<string, unknown>>;
        prompt?: string;
      }) => Promise<{ messages: Array<Record<string, unknown>> }>;
    }>;
    const engine = await factory();
    const messages = [
      { role: "user", content: "inspect file" },
      {
        role: "toolResult",
        toolName: "read_file",
        toolCallId: "toolu_123",
        content: "head\n" + "x".repeat(3000),
      },
    ];

    const complexAssembled = await engine.assemble({ messages });
    expect(String(complexAssembled.messages[1]?.content)).not.toContain("<context-projection>");

    const simpleAssembled = await engine.assemble({
      messages,
      prompt: buildProjectionProfileHintBlock("simple"),
    });
    expect(String(simpleAssembled.messages[1]?.content)).toContain("<context-projection>");
  });
});
