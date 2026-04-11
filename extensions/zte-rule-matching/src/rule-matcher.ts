
/* Started by Cursor 10026780.A25624033 20260324150000005 */
import type { RuleDefinition, RuleMatchResult, RuleMatchingConfig } from "./types.js";

export class RuleMatcher {
  private config: RuleMatchingConfig;

  constructor(config: RuleMatchingConfig) {
    this.config = config;
  }

  match(message: string): RuleMatchResult {
    if (!this.config.enabled) {
      return { matched: false };
    }

    for (const rule of this.config.rules) {
      const result = this.matchRule(rule, message);
      if (result.matched) {
        return result;
      }
    }

    return { matched: false };
  }

  private matchRule(rule: RuleDefinition, message: string): RuleMatchResult {
    let match: RegExpMatchArray | null = null;
    //const params: Record&lt;string, string&gt; = {};
    const params: Record<string, string> = {};

    if (typeof rule.pattern === "string") {
      if (message.includes(rule.pattern)) {
        match = [message];
      }
    } else {
      match = message.match(rule.pattern);
      if (match && match.groups) {
        Object.assign(params, match.groups);
      }
    }

    if (match) {
      return rule.handler(message, params);
    }

    return { matched: false };
  }

  //updateConfig(config: Partial&lt;RuleMatchingConfig&gt;) {
  updateConfig(config: Partial<RuleMatchingConfig>) {
    this.config = { ...this.config, ...config };
  }
}

// 预定义规则工厂
export function createDefaultRules(): RuleDefinition[] {
  return [
    {
      id: "open-bluetooth",
      pattern: "打开蓝牙",
      //handler: () =&gt; ({
      handler: () => ({
        matched: true,
        toolName: "open_bluetooth",
        toolParams: { enabled: "true" },
        responseText: "已为您打开蓝牙设备。",
      }),
    },
    {
      id: "close-bluetooth",
      pattern: "关闭蓝牙",
      //handler: () =&gt; ({
      handler: () => ({
        matched: true,
        toolName: "close_bluetooth",
        toolParams: { enabled: "false" },
        responseText: "已为您关闭蓝牙设备。",
      }),
    },
  ];
}
/* Ended by Cursor 10026780.A25624033 20260324150000005 */
