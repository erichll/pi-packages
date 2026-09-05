import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPiSubagentsNativeRuntime,
  nativeSubagentCallBlockReason,
  NATIVE_CHILD_TOOLS,
  PI_SANDBOX_ACKNOWLEDGEMENT,
  PI_SUBAGENTS_VERSION,
} from "../packages/pi-sandbox/src/pi-subagents-native.ts";

async function artifactCorpus(root: string): Promise<string> {
  const chunks: string[] = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:json|jsonl|md|txt)$/u.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (
      path.includes(`${join(".pi", "agent", "tmp")}/`) ||
      entry.name === "cliproxyapi-models.json" ||
      entry.name === "models-store.json"
    ) continue;
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.length <= 5_000_000) chunks.push(content);
  }
  return chunks.join("\n");
}

function containsString(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.includes(expected) || value.replaceAll('\\"', '"').includes(expected);
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsString(entry, expected));
}

function collectPropertyStrings(value: unknown, property: string, output: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectPropertyStrings(entry, property, output);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === property && typeof entry === "string") output.push(entry);
      else collectPropertyStrings(entry, property, output);
    }
  }
  return output;
}

async function runModelProbe(options: {
  protectedMode: boolean;
  model: string;
  childModel: string;
  providerExtension?: string;
  modelsCache?: string;
}): Promise<{ output: string; corpus: string }> {
  const root = await mkdtemp(join(tmpdir(), options.protectedMode ? "pi-native-protected-" : "pi-native-baseline-"));
  const agentDir = join(root, ".pi", "agent");
  const sessionDir = join(agentDir, "sessions");
  const workspace = join(root, "workspace");
  let passed = false;
  try {
    await mkdir(join(agentDir, "extensions", "subagent"), { recursive: true });
    await mkdir(join(agentDir, "extensions", "pi-sandbox"), { recursive: true });
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    if (options.providerExtension) {
      const providerPackage = resolve(dirname(options.providerExtension), "..");
      const packageParent = join(agentDir, "npm", "node_modules", "@router-for-me");
      await mkdir(packageParent, { recursive: true });
      await symlink(providerPackage, join(packageParent, "pi-cliproxyapi-provider"), "dir");
      const packages = ["npm:@router-for-me/pi-cliproxyapi-provider"];
      if (options.protectedMode) {
        const sandboxPackageParent = join(agentDir, "npm", "node_modules", "@erichll");
        await mkdir(sandboxPackageParent, { recursive: true });
        await symlink(resolve("packages/pi-sandbox"), join(sandboxPackageParent, "pi-sandbox"), "dir");
        await symlink(resolve("packages/pi-auto-review"), join(sandboxPackageParent, "pi-auto-review"), "dir");
        packages.push("npm:@erichll/pi-sandbox");
      }
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages }));
    }
    await writeFile(join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({
      artifactDir: "session",
      scheduledRuns: { enabled: false },
    }));
    await writeFile(join(agentDir, "agents", "gate-probe.md"), [
      "---",
      "name: gate-probe",
      "description: Read-only native child security boundary probe",
      "tools: bash, read, grep, find, ls",
      "mutationTools:",
      "thinking: low",
      "acceptanceRole: read-only",
      "systemPromptMode: replace",
      "---",
      "Execute exactly the requested read-only probe and report its output.",
    ].join("\n"));
    if (options.protectedMode) {
      await writeFile(join(agentDir, "extensions", "pi-sandbox", "config.json"), JSON.stringify({
        subagents: {
          provider: "pi-subagents",
          protection: "native-background-tools",
          allowedNativeAgents: ["gate-probe"],
        },
      }));
    }
    if (options.modelsCache) {
      await copyFile(options.modelsCache, join(agentDir, "cliproxyapi-models.json"));
      const sourceConfig = join(dirname(options.modelsCache), "cliproxyapi.json");
      const source = JSON.parse(await readFile(sourceConfig, "utf8").catch(() => "{}")) as Record<string, unknown>;
      const safeConfig = Object.fromEntries(
        ["baseUrl", "providerId", "providerName"]
          .filter((key) => typeof source[key] === "string" && String(source[key]).trim())
          .map((key) => [key, source[key]]),
      );
      await writeFile(join(agentDir, "cliproxyapi.json"), JSON.stringify(safeConfig));
    }
    const protectedPath = join(root, "host-readable-probe.txt");
    await writeFile(protectedPath, "gate probe\n");
    const shellCommand = `if test -r ${JSON.stringify(protectedPath)}; then printf '${options.protectedMode ? "PROTECTED_HOST_READABLE" : "BASELINE_HOST_READABLE"}'; else printf '${options.protectedMode ? "PROTECTED_SANDBOX_BLOCKED" : "BASELINE_HOST_BLOCKED"}'; fi`;
    const childMarker = options.protectedMode ? "PROTECTED_CHILD_COMPLETE" : "BASELINE_CHILD_COMPLETE";
    const launchInput = {
      async: true,
      agent: "gate-probe",
      model: options.childModel,
      thinking: "low",
      acceptance: false,
      task: `Make exactly one Bash call. Use exactly the characters inside this code block; do not append punctuation:\n\n\`\`\`bash\n${shellCommand}\n\`\`\`\n\nReturn the command output and ${childMarker}.`,
    };
    const prompt = [
      "Make exactly one subagent tool call with this JSON input:",
      JSON.stringify(launchInput),
      "Then call bg_wait for the returned run id and wait for completion.",
      `Report the exact child output and finish with ${options.protectedMode ? "PROTECTED_PARENT_COMPLETE" : "BASELINE_PARENT_COMPLETE"}.`,
    ].join("\n\n");
    const piSubagentsEntry = fileURLToPath(import.meta.resolve("pi-subagents"));
    const args = [
      "--print", "--mode", "json", "--no-skills",
      "--no-prompt-templates", "--no-context-files", "--session-dir", sessionDir,
      "--extension", piSubagentsEntry,
      "--model", options.model, "--thinking", "low",
      prompt,
    ];
    const binary = process.env.PI_SUBAGENTS_GATE_PI_BINARY?.trim() || resolve("node_modules/.bin/pi");
    const parentMarker = options.protectedMode ? "PROTECTED_PARENT_COMPLETE" : "BASELINE_PARENT_COMPLETE";
    const output = await new Promise<string>((resolveRun, reject) => {
      const child = spawn(binary, args, {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: root,
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
          PI_SUBAGENTS_TEMP_ROOT: join(root, "pi-subagents-runtime"),
          PI_MODEL_EXCLUSIONS_PATH: join(root, "model-exclusions.json"),
          PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let completed = false;
      let failureReason: string | undefined;
      const modelErrors: string[] = [];
      const timeoutMs = Number(process.env.PI_SUBAGENTS_GATE_MODEL_TIMEOUT_MS ?? 900_000);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`model probe timed out after ${timeoutMs}ms; stderr=${JSON.stringify(stderr.slice(-2_000))}`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } };
            if (event.type === "message_end" && event.message?.role === "assistant" && event.message.content?.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(parentMarker))) {
              completed = true;
              setTimeout(() => child.kill("SIGTERM"), 1_000);
            }
            const errorMessage = (event.message as { errorMessage?: unknown } | undefined)?.errorMessage;
            if (event.type === "message_end" && event.message?.role === "assistant" && typeof errorMessage === "string" && errorMessage) {
              modelErrors.push(errorMessage);
              if (modelErrors.length >= 3) {
                failureReason = `model failed after ${modelErrors.length} attempts: ${modelErrors.at(-1)}`;
                child.kill("SIGTERM");
              }
            }
          } catch {
            // Ignore renderer/non-JSON output; the final artifact checks remain authoritative.
          }
        }
      });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (failureReason) {
          reject(new Error(failureReason));
          return;
        }
        if (!completed && code !== 0) {
          reject(new Error(`model probe exited ${code ?? signal}; stderr=${JSON.stringify(stderr.slice(-2_000))}; stdout=${JSON.stringify(stdout.slice(-2_000))}`));
          return;
        }
        if (!completed) {
          reject(new Error(`model probe exited before assistant marker ${parentMarker}; stderr=${JSON.stringify(stderr.slice(-2_000))}; stdout=${JSON.stringify(stdout.slice(-2_000))}`));
          return;
        }
        resolveRun(`${stdout}\n${stderr}`);
      });
    });
    let corpus = await artifactCorpus(agentDir);
    const outputEvents = output.split("\n").flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
    const toolExecutionEvidence = outputEvents
      .filter((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end")
      .map((event) => JSON.stringify(event))
      .join("\n");
    const asyncDirs = [...new Set(collectPropertyStrings(outputEvents, "asyncDir"))]
      .filter((path) => path.startsWith(`${root}/`));
    if (asyncDirs.length === 0) throw new Error("model probe did not expose its async run directory");
    const observedChildOutput: string[] = [];
    for (const asyncDir of asyncDirs) {
      corpus += `\n${await artifactCorpus(asyncDir)}`;
      const status = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as {
        state?: unknown;
        steps?: Array<{ status?: unknown; error?: unknown; recentOutput?: unknown }>;
      };
      if (status.state !== "complete" || status.steps?.some((step) => step.status !== "complete")) {
        throw new Error(`model probe child did not complete successfully: ${String(status.steps?.find((step) => step.error)?.error ?? status.state)}`);
      }
      for (const step of status.steps ?? []) {
        if (Array.isArray(step.recentOutput)) observedChildOutput.push(...step.recentOutput.filter((item): item is string => typeof item === "string"));
      }
    }
    const expectedBoundary = options.protectedMode ? "PROTECTED_SANDBOX_BLOCKED" : "BASELINE_HOST_READABLE";
    if (!observedChildOutput.some((line) => line.includes(childMarker)) || !observedChildOutput.some((line) => line.includes(expectedBoundary))) {
      throw new Error(`model probe completed without verified child tool-result markers (${childMarker}, ${expectedBoundary})`);
    }
    if (!outputEvents.some((event) =>
      (event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
      containsString(event, shellCommand)
    )) {
      const calls = outputEvents
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => ({ toolName: event.toolName, args: event.args }));
      throw new Error(`model probe did not execute the exact Bash boundary command; calls=${JSON.stringify(calls).slice(0, 4_000)}`);
    }
    if (options.protectedMode) {
      if (!corpus.includes(PI_SANDBOX_ACKNOWLEDGEMENT)) throw new Error("protected child acknowledgement proof is missing");
      if (!/"allowedTools"\s*:\s*\[\s*"bash"\s*,\s*"find"\s*,\s*"grep"\s*,\s*"ls"\s*,\s*"read"/u.test(corpus)) {
        throw new Error("protected child capability ceiling proof is missing or changed");
      }
      if (observedChildOutput.some((line) => line.includes("PROTECTED_HOST_READABLE"))) throw new Error("protected Bash retained host read access");
    }
    passed = true;
    return { output, corpus };
  } finally {
    if (!passed && process.env.PI_SUBAGENTS_GATE_KEEP_ARTIFACTS === "1") {
      console.error(`Model gate artifacts retained at ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const packageRoot = resolve("node_modules/pi-subagents");
const entry = fileURLToPath(import.meta.resolve("pi-subagents"));
assert.equal(dirname(entry), packageRoot, "pi-subagents must resolve from the workspace pin");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
  version?: string;
  exports?: Record<string, unknown>;
};
assert.equal(packageJson.version, PI_SUBAGENTS_VERSION);
assert.equal(packageJson.exports?.["./capability-ceiling"], "./src/api/capability-ceiling.ts");

for (const relative of [
  "src/agents/agents.ts",
  "src/extension/config.ts",
  "src/runs/shared/child-tool-plan.ts",
  "src/runs/foreground/subagent-executor.ts",
]) await readFile(join(packageRoot, relative), "utf8");

const childToolPlan = await readFile(join(packageRoot, "src/runs/shared/child-tool-plan.ts"), "utf8");
assert.match(childToolPlan, /capabilityCeiling\?\.denyExtensions/);
assert.match(childToolPlan, /allowedTools/);
const executor = await readFile(join(packageRoot, "src/runs/foreground/subagent-executor.ts"), "utf8");
assert.match(executor, /publicExecutions = new WeakSet/);
assert.match(executor, /publicExecution \? undefined : runHostCommand/);

const tempHome = await mkdtemp(join(tmpdir(), "pi-subagents-065-gate-"));
const agentDir = join(tempHome, ".pi", "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const upstreamConfig = join(agentDir, "extensions", "subagent", "config.json");
  await mkdir(dirname(upstreamConfig), { recursive: true });
  await writeFile(upstreamConfig, JSON.stringify({ scheduledRuns: { enabled: false } }));
  const runtime = await loadPiSubagentsNativeRuntime(["worker", "reviewer", "scout"]);
  const allowed = runtime.validateAllowedAgents(process.cwd());
  assert.deepEqual(allowed, ["worker", "reviewer", "scout"]);
  const handle = runtime.registerCeiling("compat-gate", allowed);
  const registry = (globalThis as unknown as Record<symbol, Map<string, Map<symbol, { ceiling: { allowedAgents: string[]; allowedTools: string[] } }>>>)[Symbol.for("pi-subagents.capability-ceiling.v1")];
  const ceiling = [...registry.get("compat-gate")!.values()][0]!.ceiling;
  assert.deepEqual(ceiling.allowedAgents, allowed.slice().sort());
  assert.deepEqual(ceiling.allowedTools, [...NATIVE_CHILD_TOOLS].sort());
  handle.dispose();

  assert.equal(nativeSubagentCallBlockReason({ agent: "worker", task: "probe", async: true }), undefined);
  assert.match(nativeSubagentCallBlockReason({ workflowScript: "return runs.run('x', {agent:'worker'})", async: true }) ?? "", /disabled because.*ambient extensions/);
  assert.match(nativeSubagentCallBlockReason({ agent: "worker" }) ?? "", /async: true/);
  assert.match(nativeSubagentCallBlockReason({ workflow: "owned", async: true }) ?? "", /named workflows/);
  assert.match(nativeSubagentCallBlockReason({ action: "schedule.run" }) ?? "", /scheduled/);
  assert.match(nativeSubagentCallBlockReason({ action: "update" }) ?? "", /management/);

  console.log(JSON.stringify({
    status: "PASS",
    mode: "deterministic",
    piSubagents: packageJson.version,
    allowedAgents: allowed,
    allowedTools: [...NATIVE_CHILD_TOOLS],
    acknowledgement: PI_SANDBOX_ACKNOWLEDGEMENT,
  }, null, 2));

  const model = process.env.PI_SUBAGENTS_GATE_MODEL?.trim();
  const credentials = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "CLIPROXYAPI_API_KEY"];
  if (!model || !credentials.some((name) => Boolean(process.env[name]?.trim()))) {
    console.log("SKIP pi-subagents model gate: PI_SUBAGENTS_GATE_MODEL and an already-exported matching credential are required");
  } else {
    const providerExtension = process.env.PI_SUBAGENTS_GATE_PROVIDER_EXTENSION?.trim();
    const modelsCache = process.env.PI_SUBAGENTS_GATE_MODELS_CACHE?.trim();
    const childModel = process.env.PI_SUBAGENTS_GATE_CHILD_MODEL?.trim() || "cliproxyapi/gpt-5.6-luna";
    if (model.startsWith("cliproxyapi/") && !providerExtension) {
      throw new Error("PI_SUBAGENTS_GATE_PROVIDER_EXTENSION is required for a cliproxyapi model");
    }
    console.log("gate: model native baseline (pi-subagents without pi-sandbox)");
    await runModelProbe({ protectedMode: false, model, childModel, providerExtension, modelsCache });
    console.log("gate: model protected native-background whitelist path");
    await runModelProbe({ protectedMode: true, model, childModel, providerExtension, modelsCache });
    console.log(JSON.stringify({
      status: "PASS",
      mode: "model",
      parentModel: model,
      childModel,
      baseline: "native-host-readable",
      protected: "sandboxed-bash-blocked-host-read",
      acknowledgement: PI_SANDBOX_ACKNOWLEDGEMENT,
    }, null, 2));
  }
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempHome, { recursive: true, force: true });
}
