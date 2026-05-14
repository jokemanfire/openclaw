// Materialize a possibly-sliced V8 string into a fresh standalone allocation.
//
// V8 implements string slicing (`.slice(...)`, `.substring(...)`, regex
// captures, `.split(...)` results, JSON.parse output drawn from a large input)
// as a "sliced string" or "cons string" that keeps a reference to the original
// backing buffer. That is great for short-lived locals — no copy required —
// but it bites long-lived caches: keeping a 40-character preview can pin the
// full multi-MB transcript / response buffer in memory until the cache entry
// expires.
//
// Concatenating with an empty literal forces V8 to flatten the result into a
// fresh "sequential string" with its own backing storage, dropping the
// reference to the original buffer. Empty / undefined strings pass through
// unchanged. This is a hot path; the function deliberately does no validation
// or normalization beyond the materialization step.
// `String.prototype.repeat(1)` forces V8 to materialize a fresh sequential
// string with its own backing storage, dropping any reference to the original
// buffer. The `flatstr` package and similar V8-aware libraries traditionally
// used `+ ""`, but oxlint flags that as an unnecessary template expression;
// `.repeat(1)` is the equivalent flattening hint without the lint friction.
// `String.prototype.normalize` would also materialize but is noticeably
// slower and applies Unicode NFC normalization, which we do not want here.
export function materializeString(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value.repeat(1);
}

// Type-preserving variant for `string | null | undefined` fields commonly
// found on cache entries; `null` and `undefined` pass through unchanged.
export function materializeStringOrNullish<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  return value.repeat(1) as T;
}
