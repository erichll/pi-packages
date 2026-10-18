import { basename, dirname } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanText } from "./text.ts";

function arg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
/** Plain-text truncation: targets are styled later, so no escape codes here. */
function fit(text: string | undefined, width: number): string | undefined {
  if (!text || visibleWidth(text) <= width) return text || undefined;
  let result = "";
  for (const character of text) {
    if (visibleWidth(result + character) > width - 1) break;
    result += character;
  }
  return `${result}…`;
}
function fileName(path: string | undefined): string | undefined {
  const name = path ? basename(cleanText(path).replace(/[\\/]+$/, "")) : "";
  return name && name !== "." ? name : undefined;
}
/** `skills/pdf-tools/SKILL.md` → `pdf-tools/SKILL.md`: every skill file has the same name. */
function readTarget(path: string | undefined): string | undefined {
  const name = fileName(path);
  if (name !== "SKILL.md") return fit(name, 24);
  const skill = fileName(dirname(cleanText(path!).replace(/[\\/]+$/, "")));
  return skill ? `${fit(skill, 24 - "/SKILL.md".length)}/SKILL.md` : name;
}
/** `cd dir && FOO=1 npm test` → `npm test`: the part that says what is running. */
function commandSummary(command: string): string | undefined {
  let text = cleanText(command.split(/\r?\n/).find((line) => line.trim()) ?? "");
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "");
  }
  return text || undefined;
}

/** A short, sanitized description of what a built-in tool call is working on. */
export function toolTarget(name: string, args: unknown): string | undefined {
  switch (name) {
    case "bash": case "powershell": { const command = arg(args, "command"); return fit(command && commandSummary(command), 24); }
    case "read": return readTarget(arg(args, "path"));
    case "edit": case "write": return fit(fileName(arg(args, "path")), 24);
    case "grep": case "find": { const pattern = arg(args, "pattern"); const text = pattern && cleanText(pattern); return text ? `"${fit(text, 16)}"` : undefined; }
    case "ls": { const dir = fileName(arg(args, "path")); return dir ? `${fit(dir, 23)}/` : undefined; }
    default: return undefined;
  }
}
