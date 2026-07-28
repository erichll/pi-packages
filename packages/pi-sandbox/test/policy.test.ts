import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDefaultPolicy,
  toSandboxRuntimeConfig,
} from "../src/policy.ts";

test("the default policy limits writes and protects sandbox configuration", () => {
  const policy = createDefaultPolicy("/workspace/project");
  assert.deepEqual(policy.filesystem.allowWrite, [
    "/workspace/project",
    "/dev/null",
  ]);
  assert.ok(
    policy.filesystem.denyWrite.includes(
      "/workspace/project/.pi/sandbox.json",
    ),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(
      join(homedir(), ".pi", "agent", "settings.json"),
    ),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(
      join(homedir(), ".pi", "agent", "permissions.json"),
    ),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(
      join(homedir(), ".pi", "agent", "pi-sandbox.json"),
    ),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(
      "/workspace/project/.pi/pi-auto-review.json",
    ),
  );
  assert.deepEqual(policy.network.allowedDomains, []);
  assert.deepEqual(policy.network.deniedDomains, []);
  const runtime = toSandboxRuntimeConfig(policy);
  assert.equal(runtime.filesystem.allowGitConfig, true);
  assert.deepEqual(runtime.network.allowedDomains, []);
});
