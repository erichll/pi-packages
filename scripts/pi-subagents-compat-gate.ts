import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const model = process.env.PI_SUBAGENTS_GATE_MODEL?.trim();
const externalIsolationGate = process.env.PI_SUBAGENTS_GATE_EXTERNAL_ISOLATION === "1";
const execFileAsync = promisify(execFile);
const directTimeoutMs = gateTimeout("PI_SUBAGENTS_GATE_DIRECT_TIMEOUT_MS", 10 * 60_000);
const workflowTimeoutMs = gateTimeout("PI_SUBAGENTS_GATE_WORKFLOW_TIMEOUT_MS", 15 * 60_000);
const asyncTimeoutMs = gateTimeout("PI_SUBAGENTS_GATE_ASYNC_TIMEOUT_MS", 15 * 60_000);
const credentialNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLIPROXYAPI_API_KEY",
];
const hasCredentials = credentialNames.some((name) => Boolean(process.env[name]?.trim()));

function gateTimeout(name: string, fallback: number): number {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function exactWorkflowToolInput(
  async: boolean,
  workflowScript: string,
): string {
  return [
    "Call the subagent tool with exactly this top-level JSON input:",
    "",
    JSON.stringify({ async, workflowScript }),
    "",
    "The top-level input must contain exactly the two keys `async` and `workflowScript`.",
    "Do not add top-level `agent`, `task`, or `action` fields. The `agent` and `task` fields inside the workflowScript string belong only to runs.run/runs.all and must not be copied to the tool input.",
  ].join("\n");
}

function printSkip(reason: string): never {
  console.log(`SKIP pi-subagents compatibility gate: ${reason}`);
  process.exit(0);
}

async function auditEvidence(logDir: string): Promise<string> {
  try {
    const entries = await readdir(logDir, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
    return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  } catch {
    return "";
  }
}

async function assistantReportedMarker(sessionDir: string, marker: string): Promise<boolean> {
  try {
    const entries = await readdir(sessionDir, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name));
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {
            type?: unknown;
            message?: { role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
          };
          if (
            event.type === "message" &&
            event.message?.role === "assistant" &&
            event.message.content?.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(marker))
          ) return true;
        } catch {
          // The active session may end with a partial JSONL record while it is being written.
        }
      }
    }
  } catch {
    // Session artifacts are created lazily after Pi accepts the prompt.
  }
  return false;
}

async function forwardedApprovalCount(forwardingLog: string): Promise<number> {
  const log = await readFile(forwardingLog, "utf8").catch(() => "");
  return (log.match(/"event":"forwarded_permission\.approved"/g) ?? []).length;
}

type ChildBashEvidence = {
  calls: number;
  successful: number;
  failed: number;
  exactPwdCalls: number;
};

async function childBashEvidence(sessionDir: string): Promise<ChildBashEvidence> {
  const evidence: ChildBashEvidence = { calls: 0, successful: 0, failed: 0, exactPwdCalls: 0 };
  const artifactDir = join(sessionDir, "subagent-artifacts");
  try {
    const entries = await readdir(artifactDir, { withFileTypes: true });
    const transcripts = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith("_transcript.jsonl"))
      .map((entry) => join(artifactDir, entry.name));
    for (const transcript of transcripts) {
      for (const line of (await readFile(transcript, "utf8")).split("\n")) {
        try {
          const event = JSON.parse(line) as {
            recordType?: unknown;
            toolName?: unknown;
            isError?: unknown;
            argsPreview?: unknown;
          };
          if (event.toolName !== "bash") continue;
          if (event.recordType === "tool_start" && event.argsPreview === "pwd") {
            evidence.exactPwdCalls++;
          }
          if (event.recordType !== "tool_end") continue;
          evidence.calls++;
          if (event.isError === false) evidence.successful++;
          else evidence.failed++;
        } catch {
          // A transcript may end with a partial record while its child exits.
        }
      }
    }
  } catch {
    // Artifacts are created lazily after the first child starts.
  }
  return evidence;
}

async function childTranscriptCount(sessionDir: string): Promise<number> {
  try {
    const entries = await readdir(join(sessionDir, "subagent-artifacts"), {
      withFileTypes: true,
    });
    return entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith("_transcript.jsonl"),
    ).length;
  } catch {
    return 0;
  }
}

async function runPi(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd: string,
  forwardingLog: string,
  expectedNewForwardedApprovals: number,
  sessionDir: string,
  completionMarker: string,
): Promise<{ stdout: string; stderr: string; forwardedApprovals: number }> {
  // The review log is shared by all three probes. Snapshot it per probe so a
  // later phase cannot satisfy its completion condition with earlier approvals.
  const initialForwardedApprovals = await forwardedApprovalCount(forwardingLog);
  const initialChildBash = await childBashEvidence(sessionDir);
  return new Promise((resolveRun, reject) => {
    const prompt = args.at(-1);
    if (!prompt) {
      reject(new Error("Pi gate prompt is missing"));
      return;
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
    // Print mode intentionally has no UI, so it cannot serve forwarded asks.
    // A unique tmux session provides a real private PTY. Unlike `script`, its
    // send-keys channel cannot lose input before the TUI enters raw mode.
    const command = [process.env.PI_SUBAGENTS_GATE_PI_BINARY || "pi", ...args.slice(0, -1)]
      .map(quote)
      .join(" ");
    const tmuxSession = `pi-subagents-gate-${process.pid}-${Date.now()}`;
    const tmuxSocket = `${tmuxSession}-socket`;
    const child = spawn("tmux", [
      "-L", tmuxSocket,
      "new-session", "-d", "-x", "120", "-y", "40", "-s", tmuxSession, command,
    ], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const tmux = (tmuxArgs: string[]) => new Promise<boolean>((resolveTmux) => {
      const process = spawn("tmux", ["-L", tmuxSocket, ...tmuxArgs], { stdio: "ignore" });
      process.once("error", () => resolveTmux(false));
      process.once("exit", (code) => resolveTmux(code === 0));
    });
    const capturePane = () => new Promise<string>((resolvePane) => {
      const capture = spawn("tmux", ["-L", tmuxSocket, "capture-pane", "-p", "-t", tmuxSession, "-S", "-40"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let pane = "";
      capture.stdout.on("data", (chunk) => { pane += String(chunk); });
      capture.once("error", () => resolvePane(pane));
      capture.once("exit", () => resolvePane(pane));
    });
    const sendKeys = (text: string) => void tmux(["send-keys", "-t", tmuxSession, "-l", text])
      // C-m is the terminal carriage-return sequence. It works even when a
      // tmux server does not negotiate the newer extended Enter key protocol.
      .then(() => tmux(["send-keys", "-t", tmuxSession, "C-m"]));
    let exitQueued = false;
    let finalPane = "";
    const queueExit = () => {
      if (exitQueued) return;
      exitQueued = true;
      setTimeout(() => void tmux(["kill-session", "-t", tmuxSession]), 1_500);
    };
    // Wait for the fully-rendered Pi extension status instead of guessing a
    // cold-start duration. Before that point stdin is handled by the shell or
    // startup renderer, so a prompt would be visible but never submitted.
    const promptTimer = setInterval(() => {
      void capturePane().then((pane) => {
        if (!pane.includes("pi-sandbox enabled:")) return;
        clearInterval(promptTimer);
        sendKeys(prompt);
      });
    }, 250);
    let completionCheckRunning = false;
    const completionEvidencePoll = setInterval(() => {
      if (completionCheckRunning) return;
      completionCheckRunning = true;
      void forwardedApprovalCount(forwardingLog).then(async (approvals) => {
        if (
          approvals - initialForwardedApprovals >= expectedNewForwardedApprovals &&
          await assistantReportedMarker(sessionDir, completionMarker)
        ) {
          finalPane = await capturePane();
          queueExit();
        }
      }).catch(() => undefined).finally(() => { completionCheckRunning = false; });
    }, 250);
    let terminalPromptCheckRunning = false;
    const terminalPromptPoll = setInterval(() => {
      if (terminalPromptCheckRunning || exitQueued) return;
      terminalPromptCheckRunning = true;
      void capturePane().then((pane) => {
        if (!pane.includes("Permission Required")) return;
        finalPane = pane;
        void tmux(["kill-session", "-t", tmuxSession]);
        reject(new Error(
          `Headless gate reached an unresolved permission prompt before ${completionMarker}: ${JSON.stringify(pane.slice(-2_000))}`,
        ));
      }).catch(() => undefined).finally(() => { terminalPromptCheckRunning = false; });
    }, 500);
    const timer = setTimeout(() => {
      void capturePane().then((pane) => {
        void tmux(["kill-session", "-t", tmuxSession]);
        reject(new Error(
          `Pi timed out after ${timeoutMs}ms (tmux pane=${JSON.stringify(pane.slice(-2_000))}, stdout=${JSON.stringify(stdout.slice(-1_000))}, stderr=${JSON.stringify(stderr.slice(-1_000))})`,
        ));
      });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearInterval(promptTimer);
      clearInterval(completionEvidencePoll);
      clearInterval(terminalPromptPoll);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        clearTimeout(timer);
        clearInterval(promptTimer);
        clearInterval(completionEvidencePoll);
        clearInterval(terminalPromptPoll);
        reject(new Error(`tmux could not start Pi (${code ?? "null"}${signal ? ` (${signal})` : ""}): ${stderr.slice(-800)}`));
      }
    });
    const completionPoll = setInterval(() => {
      void tmux(["has-session", "-t", tmuxSession]).then((running) => {
        if (running) return;
        clearTimeout(timer);
        clearInterval(promptTimer);
        clearInterval(completionEvidencePoll);
        clearInterval(terminalPromptPoll);
        clearInterval(completionPoll);
        if (!exitQueued) {
          reject(new Error("Pi exited before reporting the gate completion marker"));
          return;
        }
        void Promise.all([
          forwardedApprovalCount(forwardingLog),
          childBashEvidence(sessionDir),
        ]).then(([approvals, childBash]) => {
          const forwardedApprovals = approvals - initialForwardedApprovals;
          if (forwardedApprovals !== expectedNewForwardedApprovals) {
            reject(new Error(
              `Expected exactly ${expectedNewForwardedApprovals} new forwarded approvals before ${completionMarker}, observed ${forwardedApprovals}`,
            ));
            return;
          }
          const bashDelta = {
            calls: childBash.calls - initialChildBash.calls,
            successful: childBash.successful - initialChildBash.successful,
            failed: childBash.failed - initialChildBash.failed,
            exactPwdCalls: childBash.exactPwdCalls - initialChildBash.exactPwdCalls,
          };
          if (
            bashDelta.calls !== expectedNewForwardedApprovals ||
            bashDelta.successful !== expectedNewForwardedApprovals ||
            bashDelta.failed !== 0 ||
            bashDelta.exactPwdCalls !== expectedNewForwardedApprovals
          ) {
            reject(new Error(
              `Expected ${expectedNewForwardedApprovals} successful exact child Bash pwd calls before ${completionMarker}, observed ${JSON.stringify(bashDelta)}`,
            ));
            return;
          }
          resolveRun({ stdout: finalPane, stderr, forwardedApprovals });
        }).catch(reject);
      });
    }, 250);
  });
}

async function childToolSummary(root: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name));
    for (const file of jsonlFiles) {
      const lines = (await readFile(file, "utf8")).split("\n");
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { toolName?: unknown; name?: unknown; type?: unknown };
          const tool = typeof event.toolName === "string"
            ? event.toolName
            : event.type === "tool_call" && typeof event.name === "string" ? event.name : undefined;
          if (tool) result[tool] = (result[tool] ?? 0) + 1;
        } catch {
          // Artifact records are diagnostic-only and may be partial while a process exits.
        }
      }
    }
  } catch {
    // Missing artifacts are reported as an empty summary.
  }
  return result;
}

function toolCounts(output: string): Record<string, number> {
  const count = (pattern: RegExp) => (output.match(pattern) ?? []).length;
  return {
    subagent: count(/"(?:toolName|name)"\s*:\s*"subagent"/g),
    bash: count(/"(?:toolName|name)"\s*:\s*"bash"/g),
    pwd: count(/\bpwd\b/g),
  };
}

/** Rough semver floor check (e.g. 0.45.1 is at least 0.45). Tolerant of unparsable versions. */
function piSubagentsAtLeast(version: unknown, major: number, minor: number): boolean {
  if (typeof version !== "string") return false;
  const [maj, min] = version.split(".").map((part) => Number.parseInt(part, 10));
  return Number.isInteger(maj) && Number.isInteger(min) &&
    (maj > major || (maj === major && min >= minor));
}

type CompletionEvidence = {
  childRunIds: string[];
  artifactPathsPresent: boolean;
  runId?: string;
  success?: boolean;
};

/**
 * Recursively collect every object whose `completions` key holds the
 * `WaitCompletion[]` payload surfaced on the selected wait tool's result
 * details. Scanning is shape-agnostic so it stays
 * stable across the parent-session records and any transient async result
 * artifacts, without depending on the exact serialized session shape.
 */
function collectCompletions(value: unknown, out: CompletionEvidence[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectCompletions(entry, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const completions = record.completions;
  if (Array.isArray(completions)) {
    for (const completion of completions) {
      if (!completion || typeof completion !== "object" || Array.isArray(completion)) continue;
      const item = completion as Record<string, unknown>;
      const childRunIds: string[] = [];
      let artifactPathsPresent = false;
      if (Array.isArray(item.results)) {
        for (const child of item.results) {
          if (!child || typeof child !== "object" || Array.isArray(child)) continue;
          const childRecord = child as Record<string, unknown>;
          if (typeof childRecord.runId === "string" && childRecord.runId) childRunIds.push(childRecord.runId);
          if (childRecord.artifactPaths !== undefined && childRecord.artifactPaths !== null) artifactPathsPresent = true;
        }
      }
      out.push({
        ...(typeof item.runId === "string" && item.runId ? { runId: item.runId } : {}),
        ...(typeof item.success === "boolean" ? { success: item.success } : {}),
        childRunIds,
        artifactPathsPresent,
      });
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "completions") continue;
    collectCompletions(record[key], out);
  }
}

/**
 * Scan the parent/child session artifacts for (a) the version-selected wait
 * tool call, (b) any structured `details.completions` completion payload that
 * pi-subagents delivered for the async wait, and (c) literal child
 * output markers that prove the async children actually produced and delivered
 * their results. Scanning is shape-agnostic so it stays stable across the
 * parent-session records and any transient async result artifacts.
 */
async function waitCompletionEvidence(
  sessionDir: string,
  markers: string[],
  waitToolName: "bg_wait" | "subagent_wait",
): Promise<{
  waitToolCalls: number;
  completions: CompletionEvidence[];
  markersSeen: string[];
}> {
  const completions: CompletionEvidence[] = [];
  const markersSeen = new Set<string>();
  let waitToolCalls = 0;
  const considerToolCall = (name: unknown): void => {
    if (typeof name === "string" && name === waitToolName) waitToolCalls++;
  };
  const considerText = (text: unknown): void => {
    if (typeof text !== "string") return;
    for (const marker of markers) if (text.includes(marker)) markersSeen.add(marker);
  };
  try {
    const entries = await readdir(sessionDir, { recursive: true, withFileTypes: true });
    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath, entry.name));
    for (const file of jsonlFiles) {
      const lines = (await readFile(file, "utf8")).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: unknown;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object") continue;
        const record = event as Record<string, unknown>;
        const tool = typeof record.toolName === "string"
          ? record.toolName
          : record.type === "tool_call" && typeof record.name === "string" ? record.name : undefined;
        considerToolCall(tool);
        // Tool calls inside an assistant message content (toolCall/tool_use parts).
        const message = record.message;
        if (message && typeof message === "object" && !Array.isArray(message)) {
          const content = (message as Record<string, unknown>).content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === "object" && !Array.isArray(part)) {
                const partRecord = part as Record<string, unknown>;
                if (partRecord.type === "toolCall" || partRecord.type === "tool_use") considerToolCall(partRecord.name);
                considerText(partRecord.text);
              }
            }
          }
        }
        considerText(line);
        collectCompletions(event, completions);
      }
    }
  } catch {
    // Missing artifacts are reported as empty evidence.
  }
  return { waitToolCalls, completions, markersSeen: [...markersSeen] };
}

async function initializeWorkspaceRepository(workspaceDir: string): Promise<void> {
  // workflowScript's worktree option requires a committed Git repository. Set
  // it up before any isolated worker starts, because the isolated policy
  // intentionally presents protected dotfiles as non-regular files to Git.
  await writeFile(join(workspaceDir, "README.md"), "pi-subagents compatibility gate\n");
  // Pi and the outer wrapper may create these state paths while the parent
  // session starts. They must not make the fixture repository dirty before
  // workflowScript creates its isolated worktree.
  await writeFile(
    join(workspaceDir, ".gitignore"),
    [".pi/", ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".vscode/", ".idea/", ".claude/"].join("\n") + "\n",
  );
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspaceDir });
  await execFileAsync("git", ["add", "README.md", ".gitignore"], { cwd: workspaceDir });
  await execFileAsync(
    "git",
    ["-c", "user.name=pi-subagents gate", "-c", "user.email=gate@local", "commit", "--quiet", "-m", "initial gate workspace"],
    { cwd: workspaceDir },
  );
}

async function main(): Promise<void> {
  // Entry-resolution assertion runs even without a model credential: the
  // pi-subagents gate entry must resolve to a file inside the installed
  // workspace package root. This guards against accidentally loading a
  // freshly downloaded copy instead of the pinned/installed version.
  const piSubagents = fileURLToPath(import.meta.resolve("pi-subagents"));
  const piSubagentsRoot = dirname(piSubagents);
  const installedPiSubagentsRoot = resolve("node_modules/pi-subagents");
  if (piSubagentsRoot !== installedPiSubagentsRoot) {
    throw new Error(
      `pi-subagents gate entry resolved outside the installed package root: ` +
        `entry=${piSubagentsRoot}, installed=${installedPiSubagentsRoot}`,
    );
  }
  if (!existsSync(piSubagents)) {
    throw new Error(`pi-subagents gate entry does not exist: ${piSubagents}`);
  }
  console.log(`pi-subagents gate entry resolved (exports["."]): ${piSubagents}`);

  if (!model) printSkip("set PI_SUBAGENTS_GATE_MODEL to a dedicated test model");
  if (!hasCredentials) printSkip("no supported Pi model credential is configured");

  const agentDir = await mkdtemp(join(tmpdir(), "pi-subagents-compat-agent-"));
  const sessionDir = join(agentDir, "sessions");
  const workspaceDir = join(agentDir, "workspace");
  const autoReviewAuditFile = join(agentDir, "pi-auto-review-audit.jsonl");
  const permissions = resolve("node_modules/@gotgenes/pi-permission-system/src/index.ts");
  const childPermissionWrapper = resolve("scripts/pi-subagents-gate-permission-wrapper.ts");
  const parentForwardingAdapter = resolve("scripts/pi-subagents-parent-forwarding-adapter.ts");
  const autoReview = resolve("packages/pi-auto-review/src/index.ts");
  const sandbox = resolve("packages/pi-sandbox/src/index.ts");
  const providerExtension = process.env.PI_SUBAGENTS_GATE_PROVIDER_EXTENSION?.trim();
  const modelsCache = process.env.PI_SUBAGENTS_GATE_MODELS_CACHE?.trim();
  let providerNetworkEndpoint: string | undefined;
  if (model.startsWith("cliproxyapi/") && !providerExtension) {
    printSkip("set PI_SUBAGENTS_GATE_PROVIDER_EXTENSION to the cliproxyapi provider extension path");
  }
  const env = {
    ...process.env,
    HOME: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV: "1",
    PI_AUTO_REVIEW_AUDIT_FILE: autoReviewAuditFile,
  };
  const piSubagentsVersion = await readFile(
    resolve("node_modules/pi-subagents/package.json"),
    "utf8",
  ).then((raw) => (JSON.parse(raw) as { version?: unknown }).version).catch(() => "unknown");
  const waitToolName = piSubagentsAtLeast(piSubagentsVersion, 0, 61)
    ? "bg_wait"
    : "subagent_wait";
  let passed = false;

  try {
    // Every extension reads only this disposable HOME/agent directory.
    await mkdir(join(agentDir, ".pi", "agent", "extensions", "pi-auto-review"), { recursive: true });
    await mkdir(join(agentDir, ".pi", "agent", "extensions", "pi-sandbox"), { recursive: true });
    await mkdir(join(agentDir, "extensions", "pi-permission-system"), { recursive: true });
    await mkdir(join(agentDir, "extensions", "subagent"), { recursive: true });
    await mkdir(join(agentDir, "npm", "node_modules", "@gotgenes"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await initializeWorkspaceRepository(workspaceDir);
    // pi-subagents resolves this exact package location to auto-inject the
    // permission system into child workers. The gate-only package points to a
    // narrow wrapper around the real installed extension: outer PID namespaces
    // hide the serving parent's PID, so the wrapper trusts only this gate's
    // fresh parent-heartbeat PID while leaving heartbeat expiry intact.
    const childPermissionPackage = join(
      agentDir,
      "npm",
      "node_modules",
      "@gotgenes",
      "pi-permission-system",
    );
    await mkdir(childPermissionPackage, { recursive: true });
    await writeFile(
      join(childPermissionPackage, "package.json"),
      JSON.stringify({
        name: "@gotgenes/pi-permission-system",
        private: true,
        type: "module",
        pi: { extensions: [childPermissionWrapper] },
      }),
    );
    if (providerExtension) {
      const providerPackage = resolve(dirname(providerExtension), "..");
      await mkdir(join(agentDir, "npm", "node_modules", "@router-for-me"), { recursive: true });
      await symlink(
        providerPackage,
        join(agentDir, "npm", "node_modules", "@router-for-me", "pi-cliproxyapi-provider"),
        "dir",
      );
    }
    // Keep the launch-block fixture in the disposable user settings. A project
    // .pi/settings.json would intentionally trigger Pi's project-trust prompt
    // before this headless gate can submit its first instruction.
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        ...(providerExtension
          ? { packages: ["npm:@router-for-me/pi-cliproxyapi-provider"] }
          : {}),
        subagents: {
          watchdog: {
            rules: {
              action: "block",
              roleModels: { delegate: { deny: ["*"] } },
            },
          },
        },
      }),
    );
    // The isolated config explicitly enables P0's permission forwarding path.
    await writeFile(
      join(agentDir, "extensions", "pi-permission-system", "config.json"),
      JSON.stringify({
        permission: {
          // The parent orchestration calls are fixed by this gate and are not
          // the decision under test. Allow them deterministically so a long
          // workflowScript is not deferred merely because the generic tool
          // preview is truncated; child Bash remains an explicit forwarded ask.
          subagent: "allow",
          bg_wait: "allow",
          subagent_wait: "allow",
          bash: "ask",
          bash_escalated: "ask",
          path: "ask",
          external_directory: "ask",
        },
        // Registration alone deliberately grants no authority. The release
        // gate explicitly enables the isolated reviewer before headless runs.
        authorizerChain: ["pi-auto-review"],
        permissionReviewLog: true,
      }),
    );
    // pi-subagents reads a separate config path. Session artifacts make the
    // real child tool calls observable without parsing model prose.
    //
    // Since pi-subagents 0.54.0, its external permission-system bridge loads
    // only when a child has at least one explicit native permission rule. This
    // mutation deny is both a safety boundary for these read-only probes and
    // the opt-in that loads the bridge. The children call only Bash, which is
    // outside pi-subagents' native rule surface and remains governed by the
    // permission-system `bash: "ask"` policy above.
    await writeFile(
      join(agentDir, "extensions", "subagent", "config.json"),
      JSON.stringify({
        artifactDir: "session",
        permissions: { rules: { write: "deny" } },
      }),
    );
    if (modelsCache) {
      await copyFile(modelsCache, join(agentDir, "cliproxyapi-models.json"));
      // The provider needs its endpoint metadata, but never its persisted key.
      // Authentication stays in the inherited CLIPROXYAPI_API_KEY environment.
      try {
        const source = JSON.parse(
          await readFile(join(dirname(modelsCache), "cliproxyapi.json"), "utf8"),
        ) as Record<string, unknown>;
        const safeConfig = Object.fromEntries(
          ["baseUrl", "providerId", "providerName"]
            .filter((key) => typeof source[key] === "string" && source[key].trim())
            .map((key) => [key, source[key]]),
        );
        await writeFile(
          join(agentDir, "cliproxyapi.json"),
          JSON.stringify(safeConfig),
        );
        if (typeof safeConfig.baseUrl === "string") {
          try {
            const endpoint = new URL(safeConfig.baseUrl);
            providerNetworkEndpoint = `${endpoint.hostname}:${endpoint.port || (endpoint.protocol === "https:" ? "443" : "80")}`;
          } catch {
            // The provider will report an invalid endpoint configuration.
          }
        }
      } catch {
        // The provider will emit its own fail-closed configuration error.
      }
    }
    await writeFile(
      join(agentDir, ".pi", "agent", "extensions", "pi-auto-review", "config.json"),
      JSON.stringify({
        model,
        // Forwarded reviews must see the complete gate authorization. The
        // package default can truncate the longer parallel workflow prompt,
        // making an otherwise exact `pwd` request nondeterministically defer.
        maxUserTranscriptTokens: 4_000,
      }),
    );
    await writeFile(
      join(agentDir, ".pi", "agent", "extensions", "pi-sandbox", "config.json"),
      JSON.stringify({
        subagents: {
          provider: "pi-subagents",
          externalWorkerIsolation: externalIsolationGate ? "enforce" : "off",
        },
        // In enforce mode the model-provider endpoint is gate infrastructure,
        // not a decision under test: children must reach it to run at all.
        // Routing those connections through the reviewer made headless runs
        // hang whenever transcript evidence exceeded the reviewer's per-item
        // budget (reproducible on pi-subagents 0.59.0 too), so the resolved
        // provider endpoint is policy-allowed instead; every other
        // destination still requires reviewer or human approval.
        ...(externalIsolationGate && providerNetworkEndpoint
          ? { network: { allowedDomains: [providerNetworkEndpoint] } }
          : {}),
      }),
    );
    const common = [
      "--no-extensions",
      "--extension", piSubagents,
      // pi-subagents writes the root session id into its own parent-session
      // environment variable. Load this narrow adapter immediately afterward
      // so permission-system does not misclassify the interactive root as a
      // child; child launches still receive the id through pi-subagents'
      // explicit parentSessionId launch field.
      "--extension", parentForwardingAdapter,
      ...(providerExtension ? ["--extension", providerExtension] : []),
      "--extension", autoReview,
      "--extension", permissions,
      "--extension", sandbox,
      "--model", model,
    ];
    const forwardingLog = join(
      agentDir,
      "extensions",
      "pi-permission-system",
      "logs",
      "pi-permission-system-permission-review.jsonl",
    );
    console.log("gate: watchdog launch rule blocks before worker spawn");
    const blockedTranscriptBaseline = await childTranscriptCount(sessionDir);
    const blockedCompletionMarker = `PI_SUBAGENTS_GATE_BLOCKED_COMPLETE_${process.pid}`;
    const blockedScript = [
      "return runs.run(\"blocked\", {",
      "  agent: \"delegate\",",
      '  task: "This child must never start.",',
      "});",
    ].join("\n");
    const blocked = await runPi([
      ...common,
      `Make exactly one subagent tool call for the blocked delegate launch; do not list agents, retry, or create a replacement run.\n\n${exactWorkflowToolInput(false, blockedScript)}\n\nConfirm that the tool reports a subagents.watchdog.rules launch block, then end the response with exactly ${blockedCompletionMarker}.`,
    ], env, directTimeoutMs, workspaceDir, forwardingLog, 0, sessionDir, blockedCompletionMarker);
    const blockedTranscriptDelta =
      (await childTranscriptCount(sessionDir)) - blockedTranscriptBaseline;
    if (blockedTranscriptDelta !== 0) {
      throw new Error(
        `watchdog launch-rule probe started ${blockedTranscriptDelta} child transcript(s) despite action=block`,
      );
    }
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify(providerExtension
        ? { packages: ["npm:@router-for-me/pi-cliproxyapi-provider"] }
        : {}),
    );

    console.log(externalIsolationGate ? "gate: outer-isolated single-run workflowScript child" : "gate: single-run workflowScript child");
    const providerNetworkAuthorization = externalIsolationGate
      ? providerNetworkEndpoint
        ? ` This compatibility gate explicitly authorizes every child connection to the configured model-provider endpoint ${providerNetworkEndpoint}, only for this gate run; do not access any other network destination.`
        : " This compatibility gate explicitly authorizes every TLS connection that each child needs to its already-configured model provider, only for this gate run; do not access any other network destination."
      : "";
    const directCompletionMarker = `PI_SUBAGENTS_GATE_DIRECT_COMPLETE_${process.pid}`;
    // Public direct execution (top-level agent + async:false) was removed in
    // pi-subagents 0.43.0: workflowScript is now the only public execution
    // surface, including single-child runs. The "direct" probe therefore runs
    // the minimal single-run workflowScript form.
    // Each child makes exactly one Bash `pwd` call, hence exactly one forwarded
    // ask. permission-system's pure-reader classification for `pwd` narrows
    // path-effect handling; it does not override the explicit `bash: "ask"`
    // command rule exercised here.
    const directScript = [
      "return runs.run(\"single\", {",
      "  agent: \"delegate\",",
      `  task: ${JSON.stringify(`Make exactly one Bash tool call with the exact command \`pwd\`, then return its output.${providerNetworkAuthorization}`)},`,
      "});",
    ].join("\n");
    const direct = await runPi([
      ...common,
      `Make exactly one subagent tool call that runs a single child; do not list agents, launch a background workflow, call status, retry, or create replacement runs.${providerNetworkAuthorization}\n\n${exactWorkflowToolInput(false, directScript)}\n\nWait for that foreground tool call to return. Report the run id and output, then end the response with exactly ${directCompletionMarker}.`,
    ], env, directTimeoutMs, workspaceDir, forwardingLog, 1, sessionDir, directCompletionMarker);
    console.log("gate: workflowScript");
    const workflowCompletionMarker = `PI_SUBAGENTS_GATE_WORKFLOW_COMPLETE_${process.pid}`;
    const workflowScript = [
      "const [alpha, bravo] = await runs.all([",
      `  { key: "alpha", agent: "delegate", task: ${JSON.stringify(`Make exactly one Bash tool call with the exact command \`pwd\`, then return its output and the marker CHILD-ALPHA.${providerNetworkAuthorization}`)} },`,
      `  { key: "bravo", agent: "delegate", task: ${JSON.stringify(`Make exactly one Bash tool call with the exact command \`pwd\`, then return its output and the marker CHILD-BRAVO.${providerNetworkAuthorization}`)}, worktree: true },`,
      "] );",
      "const charlie = await runs.run(\"charlie\", {",
      "  agent: \"delegate\",",
      `  task: ${JSON.stringify(`Make exactly one Bash tool call with the exact command \`pwd\`, then summarize these completed children.${providerNetworkAuthorization} ALPHA: `)} + alpha.output + ${JSON.stringify(" BRAVO: ")} + bravo.output`,
      "});",
      "return { alpha, bravo, charlie };",
    ].join("\n");
    // alpha, bravo, and charlie each contribute one new forwarded approval.
    const workflow = await runPi([
      ...common,
      `Make exactly one subagent tool call; do not list agents, launch a background workflow, call status, retry, or create replacement runs.\n\n${exactWorkflowToolInput(false, workflowScript)}\n\nWait for that foreground tool call to return. Report every run id and output, then end the response with exactly ${workflowCompletionMarker}.`,
    ], env, workflowTimeoutMs, workspaceDir, forwardingLog, 3, sessionDir, workflowCompletionMarker);
    console.log("gate: async workflow completion payloads");
    const asyncCompletionMarker = `PI_SUBAGENTS_GATE_ASYNC_COMPLETE_${process.pid}`;
    const asyncScript = [
      "const [left, right] = await runs.all([",
      `  { key: "left", agent: "delegate", task: ${JSON.stringify(`Make exactly one Bash tool call with the exact command \`pwd\`, then return your output and the marker ASYNC-LEFT.${providerNetworkAuthorization}`)} },`,
      `  { key: "right", agent: "delegate", task: ${JSON.stringify(`Make exactly one Bash tool call with the exact command \`pwd\`, then return your output and the marker ASYNC-RIGHT.${providerNetworkAuthorization}`)} },`,
      "] );",
      "return { left, right };",
    ].join("\n");
    // left and right each contribute one new forwarded approval; the per-run
    // baseline prevents the four foreground approvals from satisfying this.
    const asyncWorkflow = await runPi([
      ...common,
      `Make exactly one subagent tool call that launches a background workflow; do not call status, list agents, retry, or create replacement runs.${providerNetworkAuthorization}\n\n${exactWorkflowToolInput(true, asyncScript)}\n\nFrom the returned control record, read the run id. Then call ${waitToolName}({ id: <that run id>, nonBlocking: false }) and wait for it to return the completed result. Report each child's run id, the markers ASYNC-LEFT and ASYNC-RIGHT, and note whether the ${waitToolName} result carried structured completion details. Then end your response with exactly ${asyncCompletionMarker}.`,
    ], env, asyncTimeoutMs, workspaceDir, forwardingLog, 2, sessionDir, asyncCompletionMarker);
    const asyncMarkers = ["ASYNC-LEFT", "ASYNC-RIGHT"];
    const completionEvidence = await waitCompletionEvidence(sessionDir, asyncMarkers, waitToolName);
    // Hard gate: pi-subagents >= 0.45.0 must surface the structured completion
    // surface (#915) through the wait tool selected for the installed version
    // and its details.completions payload. This is
    // mandatory; the check is version-gated so an unexpected downgrade fails
    // loudly rather than silently skipping the new contract.
    const requiresCompletionContract = piSubagentsAtLeast(piSubagentsVersion, 0, 45);
    if (requiresCompletionContract) {
      if (completionEvidence.waitToolCalls < 1) {
        throw new Error(
          `async probe: pi-subagents ${String(piSubagentsVersion)} >= 0.45.0 must surface ${waitToolName}, but no ${waitToolName} tool call was recorded (sessionDir=${sessionDir})`,
        );
      }
      if (completionEvidence.completions.length < 1) {
        throw new Error(
          `async probe: pi-subagents ${String(piSubagentsVersion)} >= 0.45.0 must surface details.completions for the async wait, but no completion payload was observed (waitToolCalls=${completionEvidence.waitToolCalls})`,
        );
      }
    }
    // When a completion payload is present, validate its shape so a regression
    // that drops run identity / per-child run ids is caught regardless of the
    // version gate above.
    if (completionEvidence.completions.length > 0) {
      const malformed = completionEvidence.completions.filter(
        (completion) => !completion.runId || completion.childRunIds.length === 0,
      );
      if (malformed.length > 0) {
        throw new Error(
          `async probe: detail completion payload present but missing run identity or per-child run ids: ${JSON.stringify(malformed)}`,
        );
      }
    }
    if (completionEvidence.waitToolCalls === 0 || completionEvidence.markersSeen.length < asyncMarkers.length) {
      console.log(
        `gate: async probe completed (evidence: waitToolCalls=${completionEvidence.waitToolCalls}, completionPayloads=${completionEvidence.completions.length}, childMarkers=${JSON.stringify(completionEvidence.markersSeen)}); structured completion surface not fully exercised this run`,
      );
    }
    console.log("gate: forwarded permission audit");
    const audit = await auditEvidence(join(agentDir, "extensions", "pi-permission-system", "logs"));
    const expectedForwardedApprovalTotal =
      direct.forwardedApprovals + workflow.forwardedApprovals + asyncWorkflow.forwardedApprovals;
    const forwardedApprovalTotal = (audit.match(/"event":"forwarded_permission\.approved"/g) ?? []).length;
    if (forwardedApprovalTotal !== expectedForwardedApprovalTotal) {
      throw new Error(
        `forwarded permission audit total changed after phase completion: expected ${expectedForwardedApprovalTotal}, observed ${forwardedApprovalTotal}`,
      );
    }
    const autoReviewAudit = await readFile(autoReviewAuditFile, "utf8").catch(() => "");
    if (!/"command"\s*:/.test(autoReviewAudit)) {
      const events = autoReviewAudit
        .split("\n")
        .flatMap((line) => {
          try { return [JSON.parse(line) as { surface?: unknown; type?: unknown }]; } catch { return []; }
        });
      const surfaces = [...new Set(events.map((event) => event.surface).filter((surface): surface is string => typeof surface === "string"))];
      const eventTypes = [...new Set(events.map((event) => event.type).filter((type): type is string => typeof type === "string"))];
      const directTools = toolCounts(direct.stdout);
      const workflowTools = toolCounts(workflow.stdout);
      const childTools = await childToolSummary(sessionDir);
      throw new Error(
        `forwarded permission audit did not contain normalized command evidence (events=${events.length}, types=${eventTypes.join(",") || "none"}, surfaces=${surfaces.join(",") || "none"}, directTools=${JSON.stringify(directTools)}, workflowTools=${JSON.stringify(workflowTools)}, childArtifactTools=${JSON.stringify(childTools)})`,
      );
    }
    passed = true;
    console.log(JSON.stringify({
      status: "PASS",
      piSubagents: String(piSubagentsVersion),
      blockedOutputBytes: blocked.stdout.length,
      blockedChildTranscripts: blockedTranscriptDelta,
      directOutputBytes: direct.stdout.length,
      workflowOutputBytes: workflow.stdout.length,
      asyncOutputBytes: asyncWorkflow.stdout.length,
      forwardedApprovals: {
        direct: direct.forwardedApprovals,
        workflow: workflow.forwardedApprovals,
        async: asyncWorkflow.forwardedApprovals,
      },
      asyncWaitToolCalls: completionEvidence.waitToolCalls,
      asyncCompletionPayloads: completionEvidence.completions.length,
      asyncMarkersSeen: completionEvidence.markersSeen,
      asyncCompletionEnforced: requiresCompletionContract,
      externalWorkerIsolation: externalIsolationGate ? "enforce" : "off",
      agentDir: "[temporary, removed]",
    }));
  } finally {
    if (!passed && process.env.PI_SUBAGENTS_GATE_KEEP_ARTIFACTS === "1") {
      console.error(`pi-subagents compatibility gate artifacts retained at ${agentDir}`);
    } else {
      await rm(agentDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`FAIL pi-subagents compatibility gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
