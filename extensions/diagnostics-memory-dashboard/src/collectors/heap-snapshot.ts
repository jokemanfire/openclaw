import { readFileSync } from "node:fs";
import type { HeapClassSummary } from "../types.js";

export function parseHeapSnapshotSummary(filepath: string): HeapClassSummary[] {
  const data = JSON.parse(readFileSync(filepath, "utf-8")) as {
    snapshot: { meta: { node_fields: string[]; node_types: string[][] }; node_count: number };
    nodes: number[];
    strings: string[];
  };
  const fields = data.snapshot.meta.node_fields;
  const types = data.snapshot.meta.node_types;
  const nodes = data.nodes;
  const strings = data.strings;
  const fieldCount = fields.length;
  const nameIdx = fields.indexOf("name");
  const typeIdx = fields.indexOf("type");
  const sizeIdx = fields.indexOf("self_size");

  if (nameIdx < 0 || typeIdx < 0 || sizeIdx < 0) return [];

  const classMap = new Map<string, { count: number; shallowSize: number }>();
  for (let i = 0; i < nodes.length; i += fieldCount) {
    const nodeTypeIdx = nodes[i + typeIdx];
    const typeName = (types[nodeTypeIdx]?.[0] ?? "unknown") as string;
    if (typeName === "hidden" || typeName === "code" || typeName === "synthetic") continue;
    const name = strings[nodes[i + nameIdx] ?? 0] ?? "(unknown)";
    const size = nodes[i + sizeIdx] ?? 0;
    const existing = classMap.get(name);
    if (existing) {
      existing.count++;
      existing.shallowSize += size;
    } else {
      classMap.set(name, { count: 1, shallowSize: size });
    }
  }

  return [...classMap.entries()]
    .sort((a, b) => b[1].shallowSize - a[1].shallowSize)
    .slice(0, 50)
    .map(([name, { count, shallowSize }]) => ({ name, count, shallowSize }));
}
