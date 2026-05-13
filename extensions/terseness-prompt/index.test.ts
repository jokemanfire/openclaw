import { describe, it, expect, vi, beforeEach } from "vitest";
import plugin from "./index.ts";

describe("terseness-prompt plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have correct plugin metadata", () => {
    expect(plugin.id).toBe("terseness-prompt");
    expect(plugin.name).toBe("Terseness Prompt");
    expect(plugin.description).toContain("terseness");
  });

  it("should have valid config schema", () => {
    const schema = plugin.configSchema;
    expect(schema).toBeDefined();

    // Test valid configs
    const validConfigs = [
      { terseness: { mode: "on", level: "full" } },
      { terseness: { mode: "on", level: "lite" } },
      { terseness: { mode: "on", level: "ultra" } },
      { terseness: { mode: "off" } },
      { terseness: { level: "full" } },
      {},
    ];

    for (const config of validConfigs) {
      const result = plugin.configSchema.safeParse(config);
      expect(result.success).toBe(true);
    }

    // Test invalid configs
    const invalidConfigs = [
      { terseness: { mode: "invalid" } },
      { terseness: { level: "invalid" } },
      { terseness: { mode: "on", level: "invalid" } },
    ];

    for (const config of invalidConfigs) {
      const result = plugin.configSchema.safeParse(config);
      expect(result.success).toBe(false);
    }
  });

  it("should register before_prompt_build hook", () => {
    const mockApi = {
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      },
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "terseness-prompt": {
                  config: {
                    terseness: { mode: "on", level: "full" },
                  },
                },
              },
            },
          }),
        },
      },
      on: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
    };

    plugin.register(mockApi as any);

    // Check that on was called with before_prompt_build
    const hookCall = mockApi.on.mock.calls.find(([event]) => event === "before_prompt_build");
    expect(hookCall).toBeDefined();
    expect(hookCall![1]).toBeDefined(); // callback function

    // Execute the hook
    const callback = hookCall![1] as () =>
      | { appendSystemContext?: string; appendContext?: string }
      | undefined;
    const result = callback();

    // Verify result structure
    expect(result).toHaveProperty("appendSystemContext");
    expect(result).toHaveProperty("appendContext");

    // Verify content
    expect(result.appendSystemContext).toContain("## Output Style");
    expect(result.appendSystemContext).toContain("Respond terse");
    expect(result.appendContext).toContain("[terse: full]");
  });

  it("should not inject when mode is off", () => {
    const mockApi = {
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "terseness-prompt": {
                  config: {
                    terseness: { mode: "off" },
                  },
                },
              },
            },
          }),
        },
      },
      on: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
    };

    plugin.register(mockApi as any);

    const hookCall = mockApi.on.mock.calls.find(([event]) => event === "before_prompt_build");
    const callback = hookCall![1] as () => any;
    const result = callback();

    expect(result).toBeUndefined();
  });

  it("should handle missing config gracefully", () => {
    const mockApi = {
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      runtime: { config: undefined },
      on: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
    };

    plugin.register(mockApi as any);

    const hookCall = mockApi.on.mock.calls.find(([event]) => event === "before_prompt_build");
    const callback = hookCall![1] as () => any;
    const result = callback();

    expect(result).toBeUndefined();
    expect(mockApi.logger.warn).toHaveBeenCalledWith(
      "[terseness-prompt] no runtime config available, skipping",
    );
  });

  it("should generate correct terseness section for each level", () => {
    const levels = ["lite", "full", "ultra"] as const;

    for (const level of levels) {
      const mockApi = {
        logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
        runtime: {
          config: {
            current: () => ({
              plugins: {
                entries: {
                  "terseness-prompt": {
                    config: {
                      terseness: { mode: "on", level },
                    },
                  },
                },
              },
            }),
          },
        },
        on: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(),
      };

      plugin.register(mockApi as any);
      const hookCall = mockApi.on.mock.calls.find(([event]) => event === "before_prompt_build");
      const callback = hookCall![1] as () => any;
      const result = callback();

      expect(result.appendSystemContext).toContain(`### Level: ${level}`);
      expect(result.appendContext).toContain(`[terse: ${level}]`);
    }
  });

  it("should include specific guidance for each level", () => {
    const levelGuides: Record<string, string[]> = {
      lite: ["No filler/hedging/pleasantries", "Keep full sentences"],
      full: ["Drop articles", "Fragments OK", "Technical terms exact"],
      ultra: ["Abbreviate prose", "never abbreviate", "X → Y"],
    };

    for (const [level, phrases] of Object.entries(levelGuides)) {
      const mockApi = {
        logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
        runtime: {
          config: {
            current: () => ({
              plugins: {
                entries: {
                  "terseness-prompt": {
                    config: {
                      terseness: { mode: "on", level },
                    },
                  },
                },
              },
            }),
          },
        },
        on: vi.fn(),
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(),
      };

      plugin.register(mockApi as any);
      const hookCall = mockApi.on.mock.calls.find(([event]) => event === "before_prompt_build");
      const callback = hookCall![1] as () => any;
      const result = callback();

      for (const phrase of phrases) {
        expect(result.appendSystemContext).toContain(phrase);
      }
    }
  });

  it("should default to full level when mode is on but level missing", () => {
    const mockApi = {
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "terseness-prompt": {
                  config: {
                    terseness: { mode: "on" },
                  },
                },
              },
            },
          }),
        },
      },
      on: vi.fn(),
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
    };

    plugin.register(mockApi as any);
    const hookCall = mockApi.on.mock.calls.find(([event]) => event === "before_prompt_build");
    const callback = hookCall![1] as () => any;
    const result = callback();

    expect(result.appendContext).toContain("[terse: full]");
    expect(result.appendSystemContext).toContain("### Level: full");
  });
});
