// Test fixture: reports the runtime config and temp-dir env the runner sent to
// the broker, then exits. Lets runner tests assert the private-temp behavior
// without a real (bwrap-backed) Sandbox Runtime.
process.on("message", (message) => {
  if (message?.type !== "init") return;
  const { allowRead, allowWrite } = message.runtimeConfig.filesystem;
  process.stdout.write(
    JSON.stringify({
      allowWrite,
      allowRead,
      network: message.runtimeConfig.network,
      tmpdirEnv: process.env.PI_SANDBOX_TMPDIR ?? "",
      sandboxRuntimeTmpdirEnv: process.env.CLAUDE_CODE_TMPDIR ?? "",
    }),
  );
  setTimeout(() => process.exit(0), 10);
});
