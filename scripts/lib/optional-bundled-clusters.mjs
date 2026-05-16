const optionalBundledClusters = [
  "acpx",
  "diagnostics-otel",
  "diffs",
  "googlechat",
  "memory-lancedb",
  "msteams",
  "nostr",
  "tlon",
  "twitch",
  "ui",
  "whatsapp",
  "zalouser",
];

export const optionalBundledClusterSet = new Set(optionalBundledClusters);

const OPTIONAL_BUNDLED_BUILD_ENV = "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED";

const INCLUDE_BUNDLED_PLUGINS_ENV = "OPENCLAW_BUNDLED_PLUGINS";
const EXCLUDE_BUNDLED_PLUGINS_BUILD_ENV = "OPENCLAW_EXCLUDE_BUNDLED_PLUGINS";

function getIncludedBundledPluginsFromEnv(env) {
  const raw = env[INCLUDE_BUNDLED_PLUGINS_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function getExcludedBundledPluginsFromEnv(env) {
  const raw = env[EXCLUDE_BUNDLED_PLUGINS_BUILD_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isOptionalBundledCluster(cluster) {
  return optionalBundledClusterSet.has(cluster);
}

function shouldIncludeOptionalBundledClusters(env = process.env) {
  // Release artifacts should preserve the last shipped upgrade surface by
  // default. Specific size-sensitive lanes can still opt out explicitly.
  return env[OPTIONAL_BUNDLED_BUILD_ENV] !== "0";
}

function hasReleasedBundledInstall(packageJson) {
  return (
    typeof packageJson?.openclaw?.install?.npmSpec === "string" &&
    packageJson.openclaw.install.npmSpec.trim().length > 0
  );
}

export function shouldBuildBundledCluster(cluster, env = process.env, options = {}) {
  const envIncluded = getIncludedBundledPluginsFromEnv(env);
  if (envIncluded) return envIncluded.has(cluster);
  const envExcluded = getExcludedBundledPluginsFromEnv(env);
  if (envExcluded?.has(cluster)) return false;
  if (hasReleasedBundledInstall(options.packageJson)) {
    return true;
  }
  return shouldIncludeOptionalBundledClusters(env) || !isOptionalBundledCluster(cluster);
}

export { getExcludedBundledPluginsFromEnv, getIncludedBundledPluginsFromEnv };
