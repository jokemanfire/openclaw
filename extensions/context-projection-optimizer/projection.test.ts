import { describe, expect, it } from "vitest";
import {
  buildProjectionProfileHintBlock,
  projectMessagesForContext,
  resolveProjectionConfig,
  resolveProjectionConfigForProfile,
  resolveProjectionProfileHintFromPrompt,
  resolveProjectionProfileSelection,
} from "./src/projection.js";

describe("context projection optimizer", () => {
  it("uses the conservative complex profile by default", () => {
    expect(resolveProjectionConfig({})).toEqual({
      maxToolResultChars: 12000,
      previewChars: 2000,
      tailChars: 800,
      keepRecentMessages: 12,
    });
  });

  it("keeps the aggressive simple profile available when selected", () => {
    expect(resolveProjectionConfigForProfile({}, "simple")).toEqual({
      maxToolResultChars: 1000,
      previewChars: 100,
      tailChars: 0,
      keepRecentMessages: 0,
    });
  });

  it("reads profile hints from prompt markers", () => {
    expect(resolveProjectionProfileHintFromPrompt(buildProjectionProfileHintBlock("complex"))).toBe(
      "complex",
    );
    expect(
      resolveProjectionProfileHintFromPrompt(
        "<context-projection-profile>simple</context-projection-profile>",
      ),
    ).toBe("simple");
  });

  it("selects the hinted profile over the configured default profile", () => {
    const selection = resolveProjectionProfileSelection({
      pluginConfig: {
        defaultProfile: "complex",
      },
      prompt: buildProjectionProfileHintBlock("simple"),
    });

    expect(selection.defaultProfile).toBe("complex");
    expect(selection.hintedProfile).toBe("simple");
    expect(selection.effectiveProfile).toBe("simple");
    expect(selection.config).toEqual({
      maxToolResultChars: 1000,
      previewChars: 100,
      tailChars: 0,
      keepRecentMessages: 0,
    });
  });

  it("projects old oversized tool results while preserving recent messages", () => {
    const oldLargeResult = "first line\n" + "x".repeat(3000) + "\nERROR: failed at final step";
    const recentLargeResult = "recent\n" + "y".repeat(3000);
    const messages = [
      { role: "user", content: "Inspect src/agents/compaction.ts" },
      {
        role: "toolResult",
        toolName: "read_file",
        toolCallId: "toolu_123",
        content: oldLargeResult,
      },
      { role: "assistant", content: "Continuing" },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "toolu_recent",
        content: recentLargeResult,
      },
    ];

    const result = projectMessagesForContext(messages, {
      ...resolveProjectionConfig({}),
      maxToolResultChars: 1000,
      previewChars: 120,
      tailChars: 80,
      keepRecentMessages: 2,
    });

    expect(result.stats.projectedCount).toBe(1);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[3]).toBe(messages[3]);
    expect(String(result.messages[1]?.content)).toContain("<context-projection>");
    expect(String(result.messages[1]?.content)).toContain("Tool call id: toolu_123");
    expect(String(result.messages[1]?.content)).toContain("ERROR: failed at final step");
  });

  it("keeps the configured tail even when it has no special marker", () => {
    const tail = "plain final lines without marker";
    const messages = [
      {
        role: "toolResult",
        toolName: "read_file",
        toolCallId: "toolu_plain_tail",
        content: "start\n" + "x".repeat(3000) + tail,
      },
    ];

    const result = projectMessagesForContext(messages, {
      ...resolveProjectionConfig({}),
      maxToolResultChars: 1000,
      previewChars: 100,
      tailChars: tail.length,
      keepRecentMessages: 0,
    });

    expect(String(result.messages[0]?.content)).toContain(`<tail lastChars="${tail.length}">`);
    expect(String(result.messages[0]?.content)).toContain(tail);
  });

  it("removes all original text blocks from structured oversized tool results", () => {
    const firstChunk = "first chunk\n" + "a".repeat(1500);
    const secondChunk = "second chunk\n" + "b".repeat(1500);
    const messages = [
      {
        role: "toolResult",
        toolName: "read_file",
        toolCallId: "toolu_multi_text",
        content: [
          { type: "text", text: firstChunk },
          { type: "image", data: "base64-image", mimeType: "image/png" },
          { type: "text", text: secondChunk },
        ],
      },
    ];

    const result = projectMessagesForContext(messages, {
      ...resolveProjectionConfig({}),
      maxToolResultChars: 1000,
      previewChars: 120,
      tailChars: 80,
      keepRecentMessages: 0,
    });
    const content = result.messages[0]?.content as unknown[];

    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "text" });
    expect(String((content[0] as { text?: string }).text)).toContain("<context-projection>");
    expect(String((content[0] as { text?: string }).text)).not.toContain("second chunk");
    expect(content[1]).toEqual({ type: "image", data: "base64-image", mimeType: "image/png" });
  });

  it("projects legacy tool-role messages and keeps snake-case identifiers", () => {
    const messages = [
      {
        role: "tool",
        tool_name: "read",
        tool_call_id: "call_legacy",
        content: "legacy output\n" + "x".repeat(3000),
      },
    ];

    const result = projectMessagesForContext(messages, {
      ...resolveProjectionConfig({}),
      maxToolResultChars: 1000,
      previewChars: 100,
      tailChars: 0,
      keepRecentMessages: 0,
    });

    expect(String(result.messages[0]?.content)).toContain("<context-projection>");
    expect(String(result.messages[0]?.content)).toContain("Tool: read");
    expect(String(result.messages[0]?.content)).toContain("Tool call id: call_legacy");
  });

  it("keeps the original message when projection would not reduce content", () => {
    const messages = [
      {
        role: "toolResult",
        content: "abcdef",
      },
    ];

    const result = projectMessagesForContext(messages, {
      maxToolResultChars: 5,
      previewChars: 4,
      tailChars: 4,
      keepRecentMessages: 0,
    });

    expect(result.messages).toBe(messages);
    expect(result.stats.projectedCount).toBe(0);
  });

  it("keeps small tool results unchanged", () => {
    const messages = [
      { role: "toolResult", toolName: "grep", toolCallId: "small", content: "short result" },
    ];
    const result = projectMessagesForContext(messages, {
      ...resolveProjectionConfig({}),
      maxToolResultChars: 1000,
      keepRecentMessages: 0,
    });

    expect(result.messages).toBe(messages);
    expect(result.stats.projectedCount).toBe(0);
  });
});
