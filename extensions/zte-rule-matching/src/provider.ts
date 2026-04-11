
/* Started by Cursor 10026780.A25624033 20260324150000006 */
// 规则匹配结果的临时存储（在同一会话中传递）
//const ruleMatchResultStore = new Map&lt;string, any&gt;();
const ruleMatchResultStore = new Map<string, any>();

export function setRuleMatchResult(sessionKey: string, result: any) {
  ruleMatchResultStore.set(sessionKey, result);
}

export function getRuleMatchResult(sessionKey: string) {
  return ruleMatchResultStore.get(sessionKey);
}

export function clearRuleMatchResult(sessionKey: string) {
  ruleMatchResultStore.delete(sessionKey);
}
/* Ended by Cursor 10026780.A25624033 20260324150000006 */
