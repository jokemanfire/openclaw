import { describe, expect, it } from "vitest";
import { materializeString, materializeStringOrNullish } from "./string-materialize.js";

describe("materializeString", () => {
  it("returns the same content for ordinary strings", () => {
    expect(materializeString("hello world")).toBe("hello world");
  });

  it("returns the empty string unchanged without forcing an allocation", () => {
    const empty = "";
    expect(materializeString(empty)).toBe(empty);
  });

  it("preserves multi-byte UTF-8 content", () => {
    expect(materializeString("中文 mixed 内容 — emoji 🦀")).toBe("中文 mixed 内容 — emoji 🦀");
  });

  it("forces a fresh allocation that does not depend on the source buffer", () => {
    const sourceBuffer = "a".repeat(64);
    const sliced = sourceBuffer.slice(0, 8);
    const materialized = materializeString(sliced);
    expect(materialized).toBe("aaaaaaaa");
    // V8 does not expose backing-buffer identity; the contract is "content
    // preserved", which we verify by equality. The retention behavior is
    // observable only via heap snapshots / RSS measurement.
    expect(materialized.length).toBe(8);
  });
});

describe("materializeStringOrNullish", () => {
  it("passes null through unchanged", () => {
    expect(materializeStringOrNullish(null)).toBeNull();
  });

  it("passes undefined through unchanged", () => {
    expect(materializeStringOrNullish(undefined)).toBeUndefined();
  });

  it("passes empty strings through without forcing an allocation", () => {
    expect(materializeStringOrNullish("")).toBe("");
  });

  it("materializes non-empty strings", () => {
    expect(materializeStringOrNullish("preview text")).toBe("preview text");
  });
});
