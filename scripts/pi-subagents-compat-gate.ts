import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const model = process.env.PI_SUBAGENTS_GATE_MODEL?.trim();
const externalIsolationGate = process.env.PI_SUBAGENTS_GATE_EXTERNAL_ISOLATION === "1";
const execFileAsync = promisify(execFile);
const directTimeoutMs = gateTimeout("PI_SUBAGENTS_GATE_DIRECT_TIMEOUT_MS", 10 * 60_000);
const workflowTimeoutMs = gateTimeout("PI_SUBAGENTS_GATE_WORKFLOW_TIMEOUT_MS", 15 * 60_000);
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

function runPi(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd: string,
  forwardingLog: string,
  expectedForwardedApprovals: number,
  sessionDir: string,
  completionMarker: string,
): Promise<{ stdout: string; stderr: string }> {
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
      void readFile(forwardingLog, "utf8").then(async (log) => {
        const approvals = (log.match(/"event":"forwarded_permission\.approved"/g) ?? []).length;
        if (
          approvals >= expectedForwardedApprovals &&
          await assistantReportedMarker(sessionDir, completionMarker)
        ) {
          finalPane = await capturePane();
          queueExit();
        }
      }).catch(() => undefined).finally(() => { completionCheckRunning = false; });
    }, 250);
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
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        clearTimeout(timer);
        clearInterval(promptTimer);
        clearInterval(completionEvidencePoll);
        reject(new Error(`tmux could not start Pi (${code ?? "null"}${signal ? ` (${signal})` : ""}): ${stderr.slice(-800)}`));
      }
    });
    const completionPoll = setInterval(() => {
      void tmux(["has-session", "-t", tmuxSession]).then((running) => {
        if (running) return;
        clearTimeout(timer);
        clearInterval(promptTimer);
        clearInterval(completionEvidencePoll);
        clearInterval(completionPoll);
        if (!exitQueued) {
          reject(new Error("Pi exited before reporting the gate completion marker"));
          return;
        }
        resolveRun({ stdout: finalPane, stderr });
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
  if (!model) printSkip("set PI_SUBAGENTS_GATE_MODEL to a dedicated test model");
  if (!hasCredentials) printSkip("no supported Pi model credential is configured");

  const agentDir = await mkdtemp(join(tmpdir(), "pi-subagents-compat-agent-"));
  const sessionDir = join(agentDir, "sessions");
  const workspaceDir = join(agentDir, "workspace");
  const autoReviewAuditFile = join(agentDir, "pi-auto-review-audit.jsonl");
  const piSubagents = resolve("node_modules/pi-subagents/index.ts");
  const permissions = resolve("node_modules/@gotgenes/pi-permission-system/src/index.ts");
  const permissionPackage = resolve("node_modules/@gotgenes/pi-permission-system");
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
    // permission system into child workers. The symlink is read-only source,
    // not a copied installation or credential-bearing configuration.
    await symlink(
      permissionPackage,
      join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"),
      "dir",
    );
    if (providerExtension) {
      const providerPackage = resolve(dirname(providerExtension), "..");
      const providerName = "@router-for-me/pi-cliproxyapi-provider";
      await mkdir(join(agentDir, "npm", "node_modules", "@router-for-me"), { recursive: true });
      await symlink(
        providerPackage,
        join(agentDir, "npm", "node_modules", "@router-for-me", "pi-cliproxyapi-provider"),
        "dir",
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ packages: [`npm:${providerName}`] }),
      );
    }
    // The isolated config explicitly enables P0's permission forwarding path.
    await writeFile(
      join(agentDir, "extensions", "pi-permission-system", "config.json"),
      JSON.stringify({
        permission: {
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
    await writeFile(
      join(agentDir, "extensions", "subagent", "config.json"),
      JSON.stringify({ artifactDir: "session" }),
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
      JSON.stringify({ model }),
    );
    await writeFile(
      join(agentDir, ".pi", "agent", "extensions", "pi-sandbox", "config.json"),
      JSON.stringify({
        subagents: {
          provider: "pi-subagents",
          externalWorkerIsolation: externalIsolationGate ? "enforce" : "off",
        },
      }),
    );
    const common = [
      "--no-extensions",
      "--extension", piSubagents,
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
    console.log(externalIsolationGate ? "gate: outer-isolated direct child" : "gate: direct child");
    const providerNetworkAuthorization = externalIsolationGate
      ? providerNetworkEndpoint
        ? ` This compatibility gate explicitly authorizes every child connection to the configured model-provider endpoint ${providerNetworkEndpoint}, only for this gate run; do not access any other network destination.`
        : " This compatibility gate explicitly authorizes every TLS connection that each child needs to its already-configured model provider, only for this gate run; do not access any other network destination."
      : "";
    const directCompletionMarker = `PI_SUBAGENTS_GATE_DIRECT_COMPLETE_${process.pid}`;
    const direct = await runPi([
      ...common,
      `Without listing agents first, call the subagent tool now with agent exactly "delegate", async:false, and a task that requires its Bash tool to run exactly \`pwd\` before replying.${providerNetworkAuthorization} Do not answer until that child result is returned. Report its run id and output, then end the response with exactly ${directCompletionMarker}.`,
    ], env, directTimeoutMs, workspaceDir, forwardingLog, 1, sessionDir, directCompletionMarker);
    console.log("gate: workflowScript");
    const workflowCompletionMarker = `PI_SUBAGENTS_GATE_WORKFLOW_COMPLETE_${process.pid}`;
    const workflowScript = [
      "const [alpha, bravo] = await runs.all([",
      `  { key: "alpha", agent: "delegate", task: ${JSON.stringify(`Run Bash \`pwd\` first, then return its output and the marker CHILD-ALPHA.${providerNetworkAuthorization}`)} },`,
      `  { key: "bravo", agent: "delegate", task: ${JSON.stringify(`Run Bash \`pwd\` first, then return its output and the marker CHILD-BRAVO.${providerNetworkAuthorization}`)}, worktree: true },`,
      "] );",
      "const charlie = await runs.run(\"charlie\", {",
      "  agent: \"delegate\",",
      `  task: ${JSON.stringify(`Run Bash \`pwd\` first, then summarize these completed children.${providerNetworkAuthorization} ALPHA: `)} + alpha.output + ${JSON.stringify(" BRAVO: ")} + bravo.output`,
      "});",
      "return { alpha, bravo, charlie };",
    ].join("\n");
    const workflow = await runPi([
      ...common,
      `Make exactly one subagent tool call. Set async:false and workflowScript to the exact JavaScript below; do not list agents, launch a background workflow, call status, or create replacement runs.\n\n${workflowScript}\n\nWait for that foreground tool call to return. Report every run id and output, then end the response with exactly ${workflowCompletionMarker}.`,
    ], env, workflowTimeoutMs, workspaceDir, forwardingLog, 4, sessionDir, workflowCompletionMarker);
    console.log("gate: forwarded permission audit");
    const audit = await auditEvidence(join(agentDir, "extensions", "pi-permission-system", "logs"));
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
      piSubagents: "0.42.1",
      directOutputBytes: direct.stdout.length,
      workflowOutputBytes: workflow.stdout.length,
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
