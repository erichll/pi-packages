import { readdirSync } from "node:fs";
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
import type { NetworkConfig } from "./config.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_INSTALL_ROOT = dirname(dirname(process.execPath));
const SANDBOX_RUNTIME_ROOT = dirname(
  dirname(
    fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")),
  ),
);

/** Common secret basenames always denied at the workspace root (even if missing). */
export const WORKSPACE_SECRET_DENY_WRITE_BASENAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
  ".env.production",
  ".env.production.local",
  ".env.staging",
  ".env.staging.local",
  ".env.ci",
] as const;

/** Secret-like directories denied at the workspace root (even if missing). */
export const WORKSPACE_SECRET_DENY_WRITE_DIRECTORIES = [
  "secrets",
  ".secrets",
] as const;

/** Private-key / certificate extensions denied when discovered under the workspace. */
export const WORKSPACE_SECRET_DENY_WRITE_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
] as const;

/**
 * Template / sample env files that agents may legitimately create or edit.
 * These are excluded from secret write denials.
 */
export const WORKSPACE_SECRET_TEMPLATE_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
]);

const WALK_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

/** Bounded workspace walk used to discover nested secrets on every platform. */
const WORKSPACE_SECRET_SCAN_MAX_DEPTH = 4;

/**
 * macOS Seatbelt supports git-style globs; Linux bubblewrap silently drops them.
 * Keep these as an extra nested-create defense on Darwin only.
 */
const DARWIN_SECRET_DENY_WRITE_GLOBS = [
  "**/.env",
  "**/.env.local",
  "**/.env.development",
  "**/.env.development.local",
  "**/.env.test",
  "**/.env.test.local",
  "**/.env.production",
  "**/.env.production.local",
  "**/.env.staging",
  "**/.env.staging.local",
  "**/.env.ci",
  "**/secrets",
  "**/secrets/**",
  "**/.secrets",
  "**/.secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
] as const;

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
  network?: NetworkConfig;
};

export function isSecretDenyWriteBasename(name: string): boolean {
  if (WORKSPACE_SECRET_TEMPLATE_BASENAMES.has(name)) {
    return false;
  }
  if (
    (WORKSPACE_SECRET_DENY_WRITE_BASENAMES as readonly string[]).includes(name)
  ) {
    return true;
  }
  // Catch less common variants such as `.env.preview` while sparing templates.
  if (name.startsWith(".env.")) {
    return true;
  }
  const lower = name.toLowerCase();
  return WORKSPACE_SECRET_DENY_WRITE_EXTENSIONS.some((extension) =>
    lower.endsWith(extension),
  );
}

function collectNestedSecretDenyWritePaths(
  workspace: string,
  maxDepth = WORKSPACE_SECRET_SCAN_MAX_DEPTH,
): string[] {
  const discovered: string[] = [];

  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        if (
          (WORKSPACE_SECRET_DENY_WRITE_DIRECTORIES as readonly string[]).includes(
            entry.name,
          )
        ) {
          discovered.push(fullPath);
          continue;
        }
        visit(fullPath, depth + 1);
        continue;
      }
      if (entry.isFile() && isSecretDenyWriteBasename(entry.name)) {
        discovered.push(fullPath);
      }
    }
  };

  visit(workspace, 0);
  return discovered;
}

/**
 * Build workspace secret write denials.
 *
 * - Always includes root-level secret basenames/directories as absolute paths so
 *   Linux can block both existing files and first-time creation.
 * - Scans a shallow workspace tree for nested secrets that already exist.
 * - Adds Darwin-only globs so nested creates are also blocked on macOS.
 */
export function createWorkspaceSecretDenyWritePaths(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const root = resolve(workspace);
  const paths = new Set<string>();

  for (const name of WORKSPACE_SECRET_DENY_WRITE_BASENAMES) {
    paths.add(join(root, name));
  }
  for (const name of WORKSPACE_SECRET_DENY_WRITE_DIRECTORIES) {
    paths.add(join(root, name));
  }
  for (const discovered of collectNestedSecretDenyWritePaths(root)) {
    paths.add(discovered);
  }
  if (platform === "darwin") {
    for (const pattern of DARWIN_SECRET_DENY_WRITE_GLOBS) {
      paths.add(pattern);
    }
  }

  return [...paths];
}

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
        join(home, ".pi", "agent", "sandbox.json"),
        // Legacy config path kept write-protected during migration.
        join(home, ".pi", "agent", "pi-sandbox.json"),
        join(home, ".pi", "agent", "logs"),
        // Prevent the sandbox from installing or rewriting trusted extensions
        // (includes ~/.pi/agent/extensions/pi-sandbox/config.json).
        join(home, ".pi", "agent", "extensions"),
        join(
          home,
          ".pi",
          "agent",
          "extensions",
          "pi-sandbox",
          "config.json",
        ),
        ...(packageIsInWorkspace ? [] : [PACKAGE_ROOT]),
        dirname(process.execPath),
        ...createWorkspaceSecretDenyWritePaths(workspace),
      ],
    },
    network: {
      allowedDomains: [...(options.network?.allowedDomains ?? [])],
      deniedDomains: [...(options.network?.deniedDomains ?? [])],
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
