// Observe the real Runtime ask callback before pi-sandbox's hostname checks.
// Loopback/invalid names would otherwise be rejected before reviewer IPC even
// without strict mode, making zero reviewer calls alone an insufficient test.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const initialize = SandboxManager.initialize;
SandboxManager.initialize = (config, ask, ...args) => initialize(config, (...request) => {
  process.stderr.write("TEST_RUNTIME_ASK_CALLED\n");
  // RPC sessions retain stdout events in rawOutput, including unknown types.
  process.stdout.write('{"type":"TEST_RUNTIME_ASK_CALLED"}\n');
  return ask?.(...request) ?? false;
}, ...args);
