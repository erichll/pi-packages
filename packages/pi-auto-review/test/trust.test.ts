import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyProjectConfig,
  assertTrustedInstallation,
  loadConfig,
} from "../src/index.ts";

test("project config can only tighten trusted settings and is frozen", () => {
  const trusted = loadConfig();
  const effective = applyProjectConfig(trusted, {
    timeoutMs: 10_000,
    retries: 0,
    failureMode: "deny",
    autoConfirmBoundedAllows: [],
  });
  assert.equal(effective.timeoutMs, 10_000);
  assert.equal(effective.retries, 0);
  assert.equal(effective.model, trusted.model);
  assert.deepEqual(effective.autoConfirmBoundedAllows, []);
  assert.equal(Object.isFrozen(effective), true);
  assert.equal(Object.isFrozen(effective.autoConfirmBoundedAllows), true);

  assert.throws(() =>
    applyProjectConfig(trusted, { model: "attacker/reviewer" }),
  );
  assert.throws(() =>
    applyProjectConfig(trusted, { grantTtlMs: trusted.grantTtlMs + 1 }),
  );
  assert.throws(() =>
    applyProjectConfig(trusted, { failureMode: "defer" }),
  );
  assert.throws(() =>
    applyProjectConfig(
      { ...trusted, autoConfirmBoundedAllows: [] },
      { autoConfirmBoundedAllows: ["external_directory"] },
    ),
  );
});

test("security package loaded from the workspace is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-review-trust-"));
  const packageRoot = join(root, "packages", "pi-auto-review");
  mkdirSync(packageRoot, { recursive: true });
  try {
    assert.throws(
      () => assertTrustedInstallation(root, packageRoot),
      /agent-writable workspace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
