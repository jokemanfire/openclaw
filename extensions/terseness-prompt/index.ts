import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";

const TersenessLevelSchema = z.enum(["normal", "lite", "full", "ultra"]);
const TersenessConfigSchema = z.object({
  mode: z.enum(["off", "on"]).optional(),
  level: TersenessLevelSchema.optional(),
});

const PluginConfigSchema = z.object({
  terseness: TersenessConfigSchema.optional(),
});

type PluginConfig = z.infer<typeof PluginConfigSchema>;

function buildTersenessSection(level: string): string {
  if (level === "normal") return "";

  const levelGuide: Record<string, string> = {
    lite: "No filler/hedging/pleasantries. Keep full sentences. Professional but tight.",
    full: "Drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (fix not 'implement a solution for'). Technical terms exact. Errors quoted exact. Code blocks unchanged.",
    ultra:
      "Abbreviate prose words (config/cert/req/res). Strip conjunctions. Use arrows for causality (X → Y). One word when one word enough. Code/symbols/function/API/error strings: never abbreviate.",
  };

  const levelName = level === "lite" ? "lite" : level === "ultra" ? "ultra" : "full";
  const guide = levelGuide[level] ?? levelGuide.full;

  return [
    "## Output Style",
    "Respond terse like smart caveman. All technical substance stay. Only fluff die.",
    "",
    "### Persistence",
    "Active every response. No revert after many turns. No filler drift. Off only via config change.",
    "",
    `### Level: ${levelName}`,
    guide,
    "",
    "Pattern: `[thing] [action] [reason]. [next step].`",
    `Not: "Sure! I'd be happy to help with that. The issue is likely caused by..."`,
    `Yes: "Bug in auth middleware. Token expiry check uses '<' not '<='. Fix: ..."`,
    "",
    "### Boundaries",
    "Code/commits/PRs: write normal (clear variable names, comments, commit messages). Level persist until changed.",
    "",
    "### Auto-Clarity",
    "Drop terse mode for: security warnings, irreversible action confirmations, multi-step sequences where ambiguity risks misread, user confused or repeats question. Resume after.",
    "",
  ].join("\n");
}

function buildShortReinforcement(level: string): string {
  if (level === "normal") return "";

  const guide: Record<string, string> = {
    lite: "No filler/hedging/pleasantries. Keep full sentences.",
    full: "Drop articles/filler/pleasantries/hedging. Fragments OK. Technical terms exact.",
    ultra:
      "Abbreviate prose. Strip conjunctions. Use arrows (X→Y). Code/API/errors: never abbreviate.",
  };

  return `[terse: ${level}] ${guide[level] ?? guide.full} Code/commits/PRs: write normal.`;
}

export default definePluginEntry({
  id: "terseness-prompt",
  name: "Terseness Prompt",
  description: "Injects terseness output style guidance into system prompt and user context",
  configSchema: buildPluginConfigSchema(PluginConfigSchema),
  register(api: OpenClawPluginApi) {
    api.logger.info("[terseness-prompt] registering hook");

    api.on("before_prompt_build", () => {
      api.logger.info("[terseness-prompt] before_prompt_build hook fired");

      const config = api.runtime?.config?.current();
      if (!config) {
        api.logger.warn("[terseness-prompt] no runtime config available, skipping");
        return undefined;
      }

      const rawEntry = config.plugins?.entries?.["terseness-prompt"];
      api.logger.info(`[terseness-prompt] raw entry: ${JSON.stringify(rawEntry)}`);
      api.logger.info(
        `[terseness-prompt] plugins.entries keys: ${JSON.stringify(Object.keys(config.plugins?.entries ?? {}))}`,
      );

      const entry = rawEntry as
        | { config?: { terseness?: { mode?: string; level?: string } } }
        | undefined;

      const terseness = entry?.config?.terseness;
      api.logger.info(`[terseness-prompt] entry.config: ${JSON.stringify(entry?.config)}`);
      api.logger.info(`[terseness-prompt] terseness resolved: ${JSON.stringify(terseness)}`);

      if (!terseness?.mode || terseness.mode !== "on") {
        api.logger.info(
          `[terseness-prompt] skipping: terseness.mode = ${JSON.stringify(terseness?.mode)}`,
        );
        return undefined;
      }

      const level = terseness.level ?? "full";

      api.logger.info(
        `[terseness-prompt] injecting, level=${level}, systemContext=${buildTersenessSection(level).length}chars, context=${buildShortReinforcement(level).length}chars`,
      );

      return {
        appendSystemContext: buildTersenessSection(level),
        appendContext: buildShortReinforcement(level),
      };
    });
  },
});
