import { spawn } from "node:child_process";
import { matchesDomainPatternWithPort } from "../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";

let target;

process.once("disconnect", () => target?.kill("SIGKILL"));
process.on("message", (message) => {
  if (message?.type === "network-response") {
    if (message.action !== "allow") {
      process.stderr.write("fake broker: network denied\n");
      process.exitCode = 1;
      process.stdin.pause();
      process.disconnect();
      return;
    }
    start(globalThis.init);
    return;
  }
  if (message?.type !== "init") return;
  globalThis.init = message;
  if (process.env.FAKE_SRT_NETWORK_HOST) {
    const hostname = process.env.FAKE_SRT_NETWORK_HOST
      .trim()
      .replace(/\.$/, "")
      .toLowerCase();
    const port = Number(process.env.FAKE_SRT_NETWORK_PORT || "443");
    const { allowedDomains = [], deniedDomains = [] } =
      message.runtimeConfig.network;
    if (deniedDomains.some((pattern) =>
      matchesDomainPatternWithPort(hostname, port, pattern))) {
      process.stderr.write("fake broker: network statically denied\n");
      process.exitCode = 1;
      process.stdin.pause();
      process.disconnect();
      return;
    }
    if (allowedDomains.some((pattern) =>
      matchesDomainPatternWithPort(hostname, port, pattern))) {
      start(message);
      return;
    }
    process.send({
      type: "network-request",
      id: "fake-network-request",
      hostname,
      port,
    });
    return;
  }
  start(message);
});

function start(message) {
  if (!message || target) return;
  target = spawn(message.invocation[0], message.invocation.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(target.stdin);
  target.stdout.pipe(process.stdout);
  target.stderr.pipe(process.stderr);
  target.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  target.once("exit", (code) => {
    process.exitCode = code ?? 1;
    process.stdin.unpipe();
    process.stdin.pause();
    process.disconnect();
  });
}
