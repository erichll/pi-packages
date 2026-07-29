import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_INSTALL_ROOT = dirname(dirname(process.execPath));
const SANDBOX_RUNTIME_ROOT = dirname(
  dirname(
    fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")),
  ),
);

export type SandboxPolicy = {
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    allowAllUnixSockets: boolean;
    allowUnixSockets: string[];
    httpProxyPort?: number;
  };
};

export type CreateDefaultPolicyOptions = {
  additionalAllowRead?: readonly string[];
};

export function createDefaultPolicy(
  cwd: string,
  options: CreateDefaultPolicyOptions = {},
): SandboxPolicy {
  const workspace = resolve(cwd);
  const home = resolve(homedir());
  const denyRead = home === parse(home).root ? [] : [home];
  const packageRelative = relative(workspace, PACKAGE_ROOT);
  const packageIsInWorkspace =
    packageRelative === "" ||
    (!packageRelative.startsWith("..") && !isAbsolute(packageRelative));
  return {
    filesystem: {
      denyRead,
      allowRead: [
        workspace,
        NODE_INSTALL_ROOT,
        SANDBOX_RUNTIME_ROOT,
        join(home, ".gitconfig"),
        join(home, ".config", "git", "config"),
        "/dev/null",
        ...(options.additionalAllowRead ?? []),
      ],
      allowWrite: [workspace, "/dev/null"],
      denyWrite: [
        join(workspace, ".pi", "settings.json"),
        join(workspace, ".pi", "sandbox.json"),
        join(workspace, ".pi", "pi-auto-review.json"),
        join(home, ".pi", "agent", "settings.json"),
        join(home, ".pi", "agent", "permissions.json"),
        join(home, ".pi", "agent", "pi-sandbox.json"),
        join(home, ".pi", "agent", "sandbox.json"),
        join(home, ".pi", "agent", "logs"),
        ...(packageIsInWorkspace ? [] : [PACKAGE_ROOT]),
        dirname(process.execPath),
      ],
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
      allowAllUnixSockets: false,
      allowUnixSockets: [],
    },
  };
}

export function toSandboxRuntimeConfig(
  policy: SandboxPolicy,
): SandboxRuntimeConfig {
  return {
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowRead: [...policy.filesystem.allowRead],
      allowWrite: [...policy.filesystem.allowWrite],
      denyWrite: [...policy.filesystem.denyWrite],
      // pi-sandbox historically allowed commands such as `git remote set-url`.
      // Sandbox Runtime continues to protect hooks independently.
      allowGitConfig: true,
    },
    network: {
      allowedDomains: [...policy.network.allowedDomains],
      deniedDomains: [...policy.network.deniedDomains],
      allowLocalBinding: policy.network.allowLocalBinding,
      allowAllUnixSockets: policy.network.allowAllUnixSockets,
      allowUnixSockets: [...policy.network.allowUnixSockets],
    },
  };
}
