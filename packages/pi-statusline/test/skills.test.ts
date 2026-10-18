import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { sessionSkills } from "../src/skills.ts";
import { assistant, messageEntry } from "./helpers.ts";

const skill = (name: string, path: string): SlashCommandInfo => ({ name: `skill:${name}`, source: "skill", sourceInfo: { path, source: "local", scope: "user", origin: "top-level" } });
const commands = (): SlashCommandInfo[] => [
  { name: "statusline", source: "extension", sourceInfo: { path: "/ext/index.ts", source: "local", scope: "user", origin: "top-level" } },
  skill("pdf-tools", join(homedir(), ".pi/agent/skills/pdf-tools/SKILL.md")),
  skill("docx", "/repo/.agents/skills/docx/SKILL.md"),
  skill("notes", "/repo/.pi/skills/notes.md"),
];
let id = 0;
const read = (...paths: string[]): SessionEntry => messageEntry(String(++id), {
  ...assistant(id), content: paths.map((path, index) => ({ type: "toolCall", id: `call-${id}-${index}`, name: "read", arguments: { path } })),
});
const user = (content: string | { type: "text"; text: string }[]): SessionEntry => ({ ...messageEntry(String(++id)), message: { role: "user", content, timestamp: id } } as SessionEntry);

test("model reads of loaded skill files count once each, in first-use order", () => {
  const entries = [
    read("/repo/src/index.ts", ".agents/skills/docx/SKILL.md"),
    read("~/.pi/agent/skills/pdf-tools/SKILL.md", "/repo/.agents/skills/docx/SKILL.md"),
    read("@/repo/.pi/skills/notes.md"),
  ];
  assert.deepEqual(sessionSkills(entries, "/repo", commands), ["docx", "pdf-tools", "notes"]);
});

test("skill files Pi did not load, other tools and malformed calls are ignored", () => {
  const entries = [
    read("/repo/packages/draft/skills/bar/SKILL.md"),
    messageEntry("x", { ...assistant(1), content: [
      { type: "toolCall", id: "w", name: "write", arguments: { path: "/repo/.agents/skills/docx/SKILL.md" } },
      { type: "toolCall", id: "r", name: "read", arguments: { path: 42 } },
      { type: "text", text: "read /repo/.agents/skills/docx/SKILL.md" },
    ] } as never),
  ];
  assert.deepEqual(sessionSkills(entries, "/repo", commands), []);
});

test("/skill:name invocations count, and commands are only listed when the session has reads", () => {
  let lookups = 0;
  const counted = () => { lookups++; return commands(); };
  const block = '<skill name="docx" location="/repo/.agents/skills/docx/SKILL.md">\nReferences are relative to /repo.\n\nBody\n</skill>';
  const entries = [user(`${block}\n\nconvert report.md`), user([{ type: "text", text: block }]), user("<skill> is just text")];
  assert.deepEqual(sessionSkills(entries, "/repo", counted), ["docx"]);
  assert.equal(lookups, 0);
  assert.deepEqual(sessionSkills([...entries, read("/a.ts", "/b.ts")], "/repo", counted), ["docx"]);
  assert.equal(lookups, 1);
});
