import { spawnSync } from "node:child_process";

/**
 * True only when a real Anthropic Sandbox Runtime broker can run the
 * persistent-direct-invocation / external-worker RPC path in this environment.
 *
 * Binary presence is not an adequate signal: GitHub-hosted runner containers
 * allow the sandbox-runtime binaries to be installed but deny bubblewrap's
 * network-namespace loopback setup, which that RPC path exercises. The broker
 * then fails with "bwrap: loopback: Failed RTM_NEWADDR: Operation not
 * permitted". We reproduce that exact system call synchronously with bwrap and
 * skip the affected integration tests when it is denied, while keeping one-shot
 * (filesystem-only) sandbox coverage active wherever the binaries exist.
 */
export function sandboxRuntimeNetworkCapable(): boolean {
  if (process.platform !== "linux") return false;
  if (spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  if (spawnSync("socat", ["-V"], { stdio: "ignore" }).status !== 0) return false;
  if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  // --unshare-net makes bwrap bring up the loopback interface. This returns 0
  // on capable hosts and non-zero inside restricted runner containers.
  const probe = spawnSync(
    "bwrap",
    ["--unshare-net", "--ro-bind", "/", "/", "--", "true"],
    { stdio: "ignore", timeout: 15_000 },
  );
  return probe.status === 0;
}