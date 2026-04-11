
/* Started by Cursor 10026780.A25624033 20260324170000001 */
export interface RuleMatchResult {
  matched: boolean;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  responseText?: string;
}

export interface RuleDefinition {
  id: string;
  pattern: string | RegExp;
  //handler: (message: string, params: Record&lt;string, string&gt;) =&gt; RuleMatchResult;
  handler: (message: string, params: Record<string, string>) => RuleMatchResult;
}

export interface RuleMatchingConfig {
  enabled: boolean;
  rules: RuleDefinition[];
  providerId: string;
  modelId: string;
}
/* Ended by Cursor 10026780.A25624033 20260324170000001 */
