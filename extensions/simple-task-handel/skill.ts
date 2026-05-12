import type { SkillEntry } from "openclaw/plugin-sdk/skills-runtime";

type SkillConfig = {
  enabled?: boolean;
};

type SkillsFilterConfig = {
  skills?: {
    entries?: Record<string, SkillConfig>;
  };
};

/**
 * Filter skill entries based on config `skills.entries`.
 * Only checks the `enabled` flag: if an entry's config has `enabled: false`, it is excluded.
 */
export function filterSkillEntries(
  entries: SkillEntry[],
  config?: SkillsFilterConfig,
): SkillEntry[] {
  const skillsEntries = config?.skills?.entries;
  if (!skillsEntries) {
    return entries;
  }

  return entries.filter((entry) => {
    const skillKey = entry.metadata?.skillKey ?? entry.skill.name;
    const entryConfig = skillsEntries[skillKey];
    return entryConfig?.enabled !== false;
  });
}

interface SkillLike {
  name: string;
  description: string;
  filePath: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 将技能列表格式化为中文技能提示词，用于注入 system prompt。
 * 与内置 formatSkillsForPrompt 保持相同的 XML 结构，但指令文本为中文。
 */
export function formatSkillsForPrompt(skills: SkillLike[]): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "\n\n## 技能（强制）",
    "回复前：扫描 <available_skills> 中的 <description> 条目。",
    "- 如果恰好有一个技能明确适用：用 `read` 读取该技能在 <location> 的 SKILL.md，然后遵循执行。必须使用 <available_skills> 中的确切 <location> 值；切勿猜测、捏造或硬编码技能文件路径。",
    "- 如果有多个可能适用：选择最具体的一个，用 `read` 读取其在 <location> 的 SKILL.md，然后遵循执行。必须使用 <available_skills> 中的确切 <location> 值；切勿猜测、捏造或硬编码技能文件路径。",
    "- 如果没有明确适用的技能：不要读取任何 SKILL.md。",
    "可用技能清单如下：",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
