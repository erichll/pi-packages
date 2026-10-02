import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

SandboxManager.initialize = async () => {
  throw new Error("TEST_RUNTIME_INITIALIZATION_FAILED: socket Operation not permitted");
};
