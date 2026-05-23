import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("context projection optimizer manifest", () => {
  it("declares context-engine ownership and startup activation", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { kind?: string; activation?: { onStartup?: boolean }; id?: string };

    expect(manifest.id).toBe("context-projection-optimizer");
    expect(manifest.kind).toBe("context-engine");
    expect(manifest.activation?.onStartup).toBe(true);
  });

  it("declares complex as the default profile without top-level shared overrides", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema?: {
        properties?: Record<
          string,
          {
            default?: unknown;
            properties?: Record<
              string,
              { default?: unknown; properties?: Record<string, { default?: unknown }> }
            >;
          }
        >;
      };
    };

    expect(manifest.configSchema?.properties?.defaultProfile?.default).toBe("complex");
    expect(manifest.configSchema?.properties?.maxToolResultChars?.default).toBeUndefined();
    expect(manifest.configSchema?.properties?.previewChars?.default).toBeUndefined();
    expect(manifest.configSchema?.properties?.tailChars?.default).toBeUndefined();
    expect(manifest.configSchema?.properties?.keepRecentMessages?.default).toBeUndefined();
    expect(
      manifest.configSchema?.properties?.profiles?.properties?.simple?.properties
        ?.maxToolResultChars?.default,
    ).toBe(1000);
    expect(
      manifest.configSchema?.properties?.profiles?.properties?.complex?.properties
        ?.maxToolResultChars?.default,
    ).toBe(12000);
    expect(
      manifest.configSchema?.properties?.profiles?.properties?.complex?.properties?.previewChars
        ?.default,
    ).toBe(2000);
  });
});
