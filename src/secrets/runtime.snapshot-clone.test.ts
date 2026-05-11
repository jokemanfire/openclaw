import { describe, expect, it } from "vitest";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot JSON clone isolation", () => {
  it("isolates sourceConfig/config from the caller's config payload", async () => {
    const callerConfig = asConfig({
      agents: {
        defaults: {
          sandbox: { mode: "all", backend: "docker" },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: callerConfig,
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.sourceConfig).not.toBe(callerConfig);
    expect(snapshot.config).not.toBe(callerConfig);
    expect(snapshot.sourceConfig).not.toBe(snapshot.config);

    const callerDefaults = (callerConfig as { agents?: { defaults?: unknown } }).agents?.defaults;
    expect(snapshot.sourceConfig.agents?.defaults).not.toBe(callerDefaults);
    expect(snapshot.config.agents?.defaults).not.toBe(callerDefaults);
    expect(snapshot.sourceConfig.agents?.defaults).not.toBe(snapshot.config.agents?.defaults);

    // Mutating the snapshot must not leak back into the caller's config.
    (snapshot.config.agents!.defaults!.sandbox as { mode?: string }).mode = "off";
    expect(
      (callerConfig as { agents?: { defaults?: { sandbox?: { mode?: string } } } }).agents?.defaults
        ?.sandbox?.mode,
    ).toBe("all");
  });

  it("isolates auth store entries from the loader's returned object", async () => {
    const sharedStore = loadAuthStoreWithProfiles({
      "openai-prod": { type: "api_key", provider: "openai", key: "sk-test-1" },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: { HOME: "/tmp/openclaw-runtime-snapshot-clone-test" },
      includeAuthStoreRefs: true,
      loadAuthStore: () => sharedStore,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect(snapshot.authStores.length).toBeGreaterThan(0);
    for (const entry of snapshot.authStores) {
      expect(entry.store).not.toBe(sharedStore);
      expect(entry.store.profiles).not.toBe(sharedStore.profiles);
      expect(entry.store.profiles["openai-prod"]).not.toBe(sharedStore.profiles["openai-prod"]);
    }

    // Mutating the snapshot's auth store must not leak back into the source.
    const firstEntry = snapshot.authStores[0];
    if (!firstEntry) {
      throw new Error("expected at least one auth store entry in the snapshot");
    }
    const firstProfile = firstEntry.store.profiles["openai-prod"];
    if (firstProfile && "key" in firstProfile) {
      firstProfile.key = "sk-mutated";
    }
    const sourceProfile = sharedStore.profiles["openai-prod"];
    if (sourceProfile && "key" in sourceProfile) {
      expect(sourceProfile.key).toBe("sk-test-1");
    } else {
      throw new Error("expected api_key profile to retain `key` field on source store");
    }
  });
});
