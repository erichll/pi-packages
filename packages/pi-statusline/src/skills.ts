import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseSkillBlock, type SessionEntry, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { cleanText } from "./text.ts";

/** Pi's read path handling: an `@` prefix is stripped, `~` is the home directory, the rest is relative to cwd. */
function readPath(path: string, cwd: string): string {
  const text = path.startsWith("@") ? path.slice(1) : path;
  if (text === "~") return homedir();
  return resolve(cwd, text.startsWith("~/") ? `${homedir()}${text.slice(1)}` : text);
}
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").join("");
}

/**
 * Loaded skills used in the session, in first-use order: `/skill:name` invocations and model
 * reads of a loaded skill's file. Reads of skill files Pi did not load are not skills in use.
 */
export function sessionSkills(entries: readonly SessionEntry[], cwd: string, commands: () => readonly SlashCommandInfo[]): string[] {
  const used = new Set<string>();
  let paths: Map<string, string> | undefined;
  const add = (name: string | undefined) => { const text = name && cleanText(name).trim(); if (text) used.add(text); };
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") add(parseSkillBlock(userText(message.content))?.name);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || block.name !== "read" || typeof block.arguments?.path !== "string") continue;
      // Looked up once per scan, only when the session has reads.
      paths ??= new Map(commands().filter((command) => command.source === "skill" && command.sourceInfo?.path)
        .map((command) => [resolve(command.sourceInfo.path), command.name.replace(/^skill:/, "")]));
      add(paths.get(readPath(block.arguments.path, cwd)));
    }
  }
  return [...used];
}
