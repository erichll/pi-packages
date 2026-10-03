import { spawn } from "node:child_process";
import type { GitState } from "./types.ts";

export function emptyGit(kind: GitState["kind"] = "unknown"): GitState {
  return { kind, branch: null, detached: false, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0 };
}
export function parseGitStatus(output: string): GitState {
  const state = emptyGit("repository");
  let oid = "";
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const line = records[i]!;
    if (line.startsWith("# branch.head ")) {
      const name = line.slice(14);
      state.detached = name === "(detached)";
      if (!state.detached) state.branch = name;
    } else if (line.startsWith("# branch.oid ")) oid = line.slice(13);
    else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) { state.ahead = Number(match[1]); state.behind = Number(match[2]); }
    } else if (line.startsWith("? ")) state.untracked++;
    else if (line.startsWith("u ")) state.conflicts++;
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const fields = line.split(" ", 4);
      const xy = fields[1] ?? "..";
      const sub = fields[2] ?? "N...";
      if (xy[0] !== ".") state.staged++;
      if (xy[1] !== "." || (sub.startsWith("S") && sub.slice(1) !== "...")) state.unstaged++;
      if (line.startsWith("2 ")) i++; // Rename source is a separate NUL record, not another status.
    }
  }
  if (state.detached) state.branch = oid && oid !== "(initial)" ? oid.slice(0, 7) : "HEAD";
  return state;
}
export type GitReader = (cwd: string, signal: AbortSignal) => Promise<GitState>;
export const readGit: GitReader = (cwd, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve(emptyGit()); return; }
  const child = spawn("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let bytes = 0, stderr = "", stopped = false;
  const stop = () => { stopped = true; child.kill("SIGKILL"); };
  const timer = setTimeout(stop, 1000);
  timer.unref();
  signal.addEventListener("abort", stop, { once: true });
  const finish = (state: GitState) => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(state); };
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop(); else chunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString(); });
  child.on("error", () => finish(emptyGit()));
  child.on("close", (code) => {
    if (stopped || signal.aborted) finish(emptyGit());
    else if (code === 0) finish(parseGitStatus(Buffer.concat(chunks).toString("utf8")));
    else finish(emptyGit(stderr.includes("not a git repository") ? "none" : "unknown"));
  });
});

/** One query at a time. Disposal cancels work and prevents stale completion callbacks. */
export class GitPoller {
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private state = emptyGit();
  private disposed = false;
  private pending = false;
  private lastStart = 0;
  private deferred: ReturnType<typeof setTimeout> | undefined;
  private readonly cwd: string;
  private readonly changed: (state: GitState) => void;
  private readonly reader: GitReader;
  constructor(cwd: string, changed: (state: GitState) => void, reader: GitReader = readGit) {
    this.cwd = cwd; this.changed = changed; this.reader = reader;
  }
  start(): void {
    if (this.timer || this.disposed) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2000);
    this.timer.unref();
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.controller) { this.pending = true; return; }
    const delay = 250 - (Date.now() - this.lastStart);
    if (delay > 0) {
      this.deferred ??= setTimeout(() => { this.deferred = undefined; void this.refresh(); }, delay);
      this.deferred.unref();
      return;
    }
    this.lastStart = Date.now();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const state = await this.reader(this.cwd, controller.signal);
      if (!this.disposed && JSON.stringify(state) !== JSON.stringify(this.state)) { this.state = state; this.changed(state); }
    } catch {
      if (!this.disposed && this.state.kind !== "unknown") { this.state = emptyGit(); this.changed(this.state); }
    } finally {
      this.controller = undefined;
      if (this.pending && !this.disposed) { this.pending = false; void this.refresh(); }
    }
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer); clearTimeout(this.deferred); this.controller?.abort();
  }
}
