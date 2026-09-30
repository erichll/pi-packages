import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse } from "node:path";

export type RuntimeProcess = {
  execPath: string;
  argv: readonly string[];
  versions: Readonly<Record<string, string | undefined>>;
  features?: { sea?: boolean; inspector?: boolean };
};

/** The extension's own import.meta.url is on disk even inside compiled Pi. */
export function isStandaloneExecutable(host: RuntimeProcess = process): boolean {
  return host.features?.sea === true || (
    !!host.versions.bun &&
    /(?:\$bunfs|~BUN|%7EBUN)/i.test(host.argv[1] ?? "")
  );
}

/** fork() must execute a JS runtime, never a compiled Pi application image. */
export function resolveBrokerExecPath(
  env: NodeJS.ProcessEnv = process.env,
  host: RuntimeProcess = process,
): string {
  if (!isStandaloneExecutable(host)) return host.execPath;

  for (const directory of (env.PATH ?? "").split(delimiter)) {
    // Do not discover executable code in the command's working directory.
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(join(directory, "node"));
      accessSync(candidate, constants.X_OK);
      const candidateStat = statSync(candidate);
      const hostStat = statSync(host.execPath);
      if (!candidateStat.isFile()) continue;
      // Also reject symlinks/hard links from `node` back to the Pi binary.
      if (candidateStat.dev === hostStat.dev && candidateStat.ino === hostStat.ino) continue;
      return candidate;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new Error(
    "pi-sandbox: standalone Pi requires Node.js >=22.19.0 on PATH to run the Sandbox Runtime broker; no usable node executable was found",
  );
}

function runtimeReadPath(execPath: string): string {
  const bin = dirname(execPath);
  const root = dirname(bin);
  // Node installations under nvm/Nix need their libraries as well as bin/node.
  // Arbitrarily placed executables must not grant a whole home directory or /.
  return basename(bin) === "bin" && root !== parse(root).root && root !== homedir()
    ? root
    : execPath;
}

function runtimeWritePath(execPath: string): string {
  const directory = dirname(execPath);
  return basename(directory) === "bin" ? directory : execPath;
}

export function runtimeFilesystemPaths(
  env: NodeJS.ProcessEnv = process.env,
  host: RuntimeProcess = process,
): { allowRead: string[]; denyWrite: string[] } {
  const brokerExecPath = resolveBrokerExecPath(env, host);
  const standalone = isStandaloneExecutable(host);
  return {
    allowRead: [...new Set([
      standalone ? host.execPath : runtimeReadPath(host.execPath),
      runtimeReadPath(brokerExecPath),
    ])],
    denyWrite: [...new Set([
      standalone ? host.execPath : runtimeWritePath(host.execPath),
      runtimeWritePath(brokerExecPath),
    ])],
  };
}
