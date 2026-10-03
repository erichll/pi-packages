import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { emptyGit, GitPoller, parseGitStatus, readGit } from "../src/git.ts";
import type { GitState } from "../src/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-git-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Statusline test");
  git(dir, "config", "user.email", "statusline@example.invalid");
  return dir;
}
async function status(cwd: string) { return readGit(cwd, new AbortController().signal); }

test("real repository: unborn, clean, staged, modified and newline filenames", async () => {
  const dir = await repo();
  try {
    const initial = await status(dir);
    assert.equal(initial.branch, "main");
    assert.equal(initial.kind, "repository");
    await writeFile(join(dir, "tracked.txt"), "original\n");
    git(dir, "add", "."); git(dir, "commit", "-m", "initial");
    assert.deepEqual(await status(dir), { ...emptyGit("repository"), branch: "main" });
    await writeFile(join(dir, "tracked.txt"), "changed\n");
    await writeFile(join(dir, "? unusual\nname.txt"), "untracked\n");
    const dirty = await status(dir);
    assert.equal(dirty.unstaged, 1); assert.equal(dirty.untracked, 1);
    git(dir, "add", "tracked.txt");
    const staged = await status(dir);
    assert.equal(staged.staged, 1); assert.equal(staged.unstaged, 0);
    git(dir, "commit", "-m", "changed content");
    git(dir, "mv", "tracked.txt", "renamed.txt");
    assert.equal((await status(dir)).staged, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real repository: tracking divergence, worktrees and detached HEAD", async () => {
  const dir = await repo();
  const worktree = `${dir}-worktree`;
  try {
    await writeFile(join(dir, "base"), "base"); git(dir, "add", "."); git(dir, "commit", "-m", "base");
    git(dir, "branch", "upstream"); git(dir, "branch", "--set-upstream-to=upstream", "main");
    await writeFile(join(dir, "main-file"), "main"); git(dir, "add", "."); git(dir, "commit", "-m", "main");
    assert.equal((await status(dir)).ahead, 1);
    git(dir, "worktree", "add", worktree, "upstream");
    await writeFile(join(worktree, "upstream-file"), "upstream"); git(worktree, "add", "."); git(worktree, "commit", "-m", "upstream");
    const divergence = await status(dir);
    assert.equal(divergence.ahead, 1); assert.equal(divergence.behind, 1);
    assert.equal((await status(worktree)).branch, "upstream");
    git(dir, "checkout", "--detach");
    const detached = await status(dir);
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, git(dir, "rev-parse", "--short=7", "HEAD"));
  } finally { await rm(worktree, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("real repository: unresolved conflicts and non-repository directories", async () => {
  const dir = await repo();
  const plain = await mkdtemp(join(tmpdir(), "pi-statusline-no-git-"));
  try {
    assert.equal((await status(plain)).kind, "none");
    await writeFile(join(dir, "file"), "base\n"); git(dir, "add", "."); git(dir, "commit", "-m", "base");
    git(dir, "checkout", "-b", "other");
    await writeFile(join(dir, "file"), "other\n"); git(dir, "commit", "-am", "other");
    git(dir, "checkout", "main");
    await writeFile(join(dir, "file"), "main\n"); git(dir, "commit", "-am", "main");
    assert.throws(() => git(dir, "merge", "other"));
    assert.equal((await status(dir)).conflicts, 1);
    const controller = new AbortController(); controller.abort();
    assert.equal((await readGit(dir, controller.signal)).kind, "unknown");
  } finally { await rm(dir, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true }); }
});

test("porcelain rename records cannot turn an unusual source filename into an extra status", () => {
  const parsed = parseGitStatus("# branch.head main\0# branch.oid abcdef0123\x002 R. N... 100644 100644 100644 abc abc R100 renamed\0? source\0? untracked\0");
  assert.equal(parsed.staged, 1); assert.equal(parsed.untracked, 1);
  assert.equal(parseGitStatus("# branch.head main\x001 .M S.M. 160000 160000 160000 a a sub\0").unstaged, 1);
});

test("the real process reader enforces its timeout and abort signal", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-git-timeout-"));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, "git"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    process.env.PATH = dir;
    const started = Date.now();
    assert.equal((await status(dir)).kind, "unknown");
    assert.ok(Date.now() - started < 4000);
    const controller = new AbortController();
    const pending = readGit(dir, controller.signal);
    controller.abort();
    assert.equal((await pending).kind, "unknown");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("poller serializes queries, publishes changes only, and discards late results on disposal", async () => {
  let calls = 0, finish: ((value: GitState) => void) | undefined;
  let signal: AbortSignal | undefined;
  const changes: GitState[] = [];
  const poller = new GitPoller("/example", (value) => changes.push(value), async (_cwd, abort) => {
    calls++; signal = abort; return new Promise<GitState>((resolve) => { finish = resolve; });
  });
  const pending = poller.refresh();
  void poller.refresh(); void poller.refresh();
  assert.equal(calls, 1);
  finish!({ ...emptyGit("repository"), branch: "main" }); await pending;
  assert.equal(changes.length, 1);
  await delay(270);
  assert.equal(calls, 2);
  poller.dispose(); assert.equal(signal?.aborted, true);
  finish!({ ...emptyGit("repository"), branch: "old-session" });
  await delay(0);
  assert.equal(changes.length, 1);

  const steadyChanges: GitState[] = [];
  const steady = new GitPoller("/example", (value) => steadyChanges.push(value), async () => ({ ...emptyGit("repository"), branch: "main" }));
  await steady.refresh(); await delay(260); await steady.refresh(); steady.dispose();
  assert.equal(steadyChanges.length, 1);
});
