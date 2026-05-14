/**
 * JSON-based deep clone for plain JSON-compatible values.
 *
 * Prefer this over `structuredClone` when the value is known to be pure JSON
 * (no Date, Map, Set, RegExp, etc.). Repeated `structuredClone` on long-lived
 * JSON payloads accumulates V8 native memory the same way #45438 / ae57eb635c
 * addressed for the session-store cache.
 */
export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
