import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EXTENSION_NAME, PACKAGE_ROOT, PROJECT_CONFIG_PATH } from "./consts.ts";
import { userConfigPath } from "./config.ts";
import { pathSurfaceInfo } from "../path-surfaces.ts";
import type { BoundaryRequest } from "../broker/index.ts";

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function protectedWriteHardDeny(
  request: BoundaryRequest,
): { rule: string; reason: string } | undefined {
  const isWrite =
    request.surface === "filesystem-write" ||
    pathSurfaceInfo(request.surface)?.effect === "write" ||
    /\b(?:write|create|delete|rename|chmod|chown)\b/i.test(
      request.operation,
    );
  if (!isWrite) return;
  const target = request.resolvedPath || request.path;
  if (!target) return;
  const resolvedTarget = resolve(request.cwd, target);
  const agentDir = join(homedir(), ".pi", "agent");
  const protectedDirectories = [
    PACKAGE_ROOT,
    join(agentDir, "logs"),
    join(agentDir, "extensions", "pi-auto-review"),
  ];
  const protectedFiles = [
    join(request.cwd, ".pi", "settings.json"),
    join(request.cwd, ".pi", "sandbox.json"),
    join(request.cwd, PROJECT_CONFIG_PATH),
    join(agentDir, "settings.json"),
    join(agentDir, "permissions.json"),
    join(agentDir, "sandbox.json"),
    userConfigPath(),
  ];
  if (
    protectedDirectories.some((path) => isWithin(path, resolvedTarget)) ||
    protectedFiles.includes(resolvedTarget)
  ) {
    return {
      rule: "security-control-tampering",
      reason:
        "writing security extension code, policy, configuration, or audit data is forbidden",
    };
  }
}

export function assertTrustedInstallation(
  cwd: string,
  packageRoot = PACKAGE_ROOT,
): void {
  const realCwd = realpathSync(cwd);
  const realPackageRoot = realpathSync(packageRoot);
  if (isWithin(realCwd, realPackageRoot)) {
    throw new Error(
      `${EXTENSION_NAME}: refusing security policy loaded from agent-writable workspace ${realPackageRoot}`,
    );
  }
}

