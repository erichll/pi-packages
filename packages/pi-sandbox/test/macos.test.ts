import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runSandboxedCommand } from "../src/runner.ts";

const fakeBroker = {
  modulePath: join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "srt-broker.mjs",
  ),
  execArgv: [],
};

test("macOS uses the same Sandbox Runtime broker contract", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-sandbox-macos-contract-"));
  let output = "";
  try {
    const result = await runSandboxedCommand({
      command: "printf macos-contract",
      cwd: workspace,
      platform: "darwin",
      broker: fakeBroker,
      onData(data) {
        output += data.toString("utf8");
      },
      async review() {
        return "deny";
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(output, "macos-contract");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("unsupported platforms fail before launching a broker", async () => {
  await assert.rejects(
    runSandboxedCommand({
      command: "true",
      cwd: "/tmp",
      platform: "win32",
      broker: fakeBroker,
      onData() {},
      async review() {
        return "deny";
      },
    }),
    /does not support win32/,
  );
});
