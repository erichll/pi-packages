import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createDefaultPolicy,
  createWorkspaceSecretDenyWritePaths,
  isSecretDenyWriteBasename,
  toSandboxRuntimeConfig,
} from "../src/policy.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function makeTempRoot(prefix: string): string {
  const parent = join(packageRoot, ".tmp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

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
      join(homedir(), ".pi", "agent", "extensions"),
    ),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(
      join(
        homedir(),
        ".pi",
        "agent",
        "extensions",
        "pi-sandbox",
        "config.json",
      ),
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

test("the default policy denies writes to common workspace secrets", () => {
  const workspace = "/workspace/project";
  const policy = createDefaultPolicy(workspace);

  assert.ok(policy.filesystem.denyWrite.includes(join(workspace, ".env")));
  assert.ok(
    policy.filesystem.denyWrite.includes(join(workspace, ".env.local")),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(
      join(workspace, ".env.production"),
    ),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(join(workspace, "secrets")),
  );
  assert.ok(
    policy.filesystem.denyWrite.includes(join(workspace, ".secrets")),
  );
  assert.ok(
    !policy.filesystem.denyWrite.includes(join(workspace, ".env.example")),
  );
});

test("secret basename classification spares templates and matches key material", () => {
  assert.equal(isSecretDenyWriteBasename(".env"), true);
  assert.equal(isSecretDenyWriteBasename(".env.preview"), true);
  assert.equal(isSecretDenyWriteBasename("server.pem"), true);
  assert.equal(isSecretDenyWriteBasename("tls.KEY"), true);
  assert.equal(isSecretDenyWriteBasename(".env.example"), false);
  assert.equal(isSecretDenyWriteBasename(".env.sample"), false);
  assert.equal(isSecretDenyWriteBasename("README.md"), false);
});

test("workspace secret deny paths discover nested existing secrets", () => {
  const root = makeTempRoot("pi-sandbox-policy-");
  try {
    const nested = join(root, "apps", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".env"), "SECRET=1\n", "utf8");
    writeFileSync(join(nested, "server.pem"), "cert\n", "utf8");
    writeFileSync(join(nested, ".env.example"), "SECRET=\n", "utf8");
    mkdirSync(join(root, "packages", "web", "secrets"), { recursive: true });

    const denyWrite = createWorkspaceSecretDenyWritePaths(root, "linux");
    assert.ok(denyWrite.includes(join(root, ".env")));
    assert.ok(denyWrite.includes(join(nested, ".env")));
    assert.ok(denyWrite.includes(join(nested, "server.pem")));
    assert.ok(denyWrite.includes(join(root, "packages", "web", "secrets")));
    assert.ok(!denyWrite.includes(join(nested, ".env.example")));
    assert.ok(!denyWrite.some((path) => path.includes("*")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("darwin secret deny paths include nested create globs", () => {
  const denyWrite = createWorkspaceSecretDenyWritePaths(
    "/workspace/project",
    "darwin",
  );
  assert.ok(denyWrite.includes("**/.env"));
  assert.ok(denyWrite.includes("**/*.pem"));
  assert.ok(denyWrite.includes("**/secrets/**"));
  assert.ok(denyWrite.includes("/workspace/project/.env"));
});

test("additional read paths extend rather than replace the default allowlist", () => {
  const policy = createDefaultPolicy("/workspace/project", {
    additionalAllowRead: [
      "/home/user/.local/bin/rtk",
      "/opt/tools/helper",
    ],
  });

  assert.ok(policy.filesystem.allowRead.includes("/workspace/project"));
  assert.ok(policy.filesystem.allowRead.includes("/dev/null"));
  assert.ok(
    policy.filesystem.allowRead.includes("/home/user/.local/bin/rtk"),
  );
  assert.ok(policy.filesystem.allowRead.includes("/opt/tools/helper"));
});
