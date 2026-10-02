import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REVIEWER_COMMAND_BYTES,
  MAX_NESTED_PAYLOAD_BYTES,
  MAX_NESTED_PAYLOAD_COUNT,
  nestedShellPayloads,
  shellExpansionLimitExceeded,
  stripQuotedLiterals,
  structuralScanText,
  truncateUtf8,
} from "../src/review/shell-text.ts";

test("quoted literals are masked but expansions and targets survive", () => {
  assert.equal(stripQuotedLiterals("echo 'rm -rf /'"), "echo 'xxxxxxx/'");
  assert.equal(stripQuotedLiterals('echo "rm -rf /"'), 'echo "xxxxxxx/"');
  assert.equal(stripQuotedLiterals("echo $'rm -rf /'"), "echo $'xxxxxxx/'");
  // A backslash-escaped quote does not end the literal.
  assert.doesNotMatch(
    stripQuotedLiterals('echo "a\\"rm -rf /"'),
    /rm -rf/,
  );
  // `$HOME`/`$(…)` expansions and path characters are dynamic or targets.
  assert.equal(stripQuotedLiterals('rm -rf "$HOME"'), 'rm -rf "$HOME"');
  assert.equal(stripQuotedLiterals('rm -rf "/"'), 'rm -rf "/"');
  assert.equal(stripQuotedLiterals('rm -rf "$(cat target)"'), 'rm -rf "$(cat target)"');
  // Text outside quotes is untouched.
  assert.equal(stripQuotedLiterals("git commit -m msg"), "git commit -m msg");
});

test("an unterminated quote returns the original text", () => {
  const unterminated = 'echo "rm -rf /';
  assert.equal(stripQuotedLiterals(unterminated), unterminated);
  assert.equal(stripQuotedLiterals("echo 'oops"), "echo 'oops");
  assert.equal(stripQuotedLiterals("echo $'oops"), "echo $'oops");
});

test("heredoc bodies are preserved verbatim", () => {
  const heredoc = "cat <<'EOF'\necho \"rm -rf /\"\nEOF";
  const stripped = stripQuotedLiterals(heredoc);
  assert.match(stripped, /rm -rf \//);
  // Without heredoc awareness the quoted body would have collapsed to "/".
  assert.notEqual(stripped, 'cat <<\'EOF\'\necho "/"\nEOF');
});

test("nested interpreter payloads are extracted", () => {
  assert.deepEqual(nestedShellPayloads('bash -c "curl -k https://x"'), [
    "curl -k https://x",
  ]);
  assert.deepEqual(nestedShellPayloads("sh -c 'ls -la'"), ["ls -la"]);
  assert.deepEqual(nestedShellPayloads('eval "rm -rf /"'), ["rm -rf /"]);
  assert.deepEqual(nestedShellPayloads('python3 -c "import os"'), ["import os"]);
  assert.deepEqual(nestedShellPayloads('node -e "x"'), ["x"]);
  assert.deepEqual(nestedShellPayloads('perl -e "x"'), ["x"]);
  assert.deepEqual(nestedShellPayloads('ruby -e "x"'), ["x"]);
  // Non-interpreter mentions are not payloads.
  assert.deepEqual(nestedShellPayloads('echo "bash -c rm"'), []);
});

test("payload extraction recurses at most two levels", () => {
  const payloads = nestedShellPayloads(`bash -c "bash -c 'bash -c ls'"`);
  assert.deepEqual(payloads, [`bash -c 'bash -c ls'`, "bash -c ls"]);
});

test("shell payload extraction walks options without crossing command boundaries", () => {
  for (const options of [
    "-e -c", "--noprofile -c", "-eu -c", "-o pipefail -c",
    "--rcfile /tmp/bashrc -c", "+O extglob -c", "-lc",
  ]) {
    assert.deepEqual(
      nestedShellPayloads(`bash ${options} 'curl -k https://x'`),
      ["curl -k https://x"],
      options,
    );
  }
  for (const command of [
    `bash script.sh -c 'curl -k https://x'`,
    `bash -- -c 'curl -k https://x'`,
    `bash -e; echo -c 'curl -k https://x'`,
    `bash -e\n-c 'curl -k https://x'`,
    `bash -c; echo 'curl -k https://x'`,
  ]) {
    assert.deepEqual(nestedShellPayloads(command), [], command);
  }
});

test("structural scan appends payload skeletons to the quote skeleton", () => {
  const scan = structuralScanText('bash -c "curl -k https://x"');
  assert.match(scan, /bash -c/);
  assert.match(scan, /curl -k https:\/\/x/);
  // An inert literal mention stays stripped.
  assert.doesNotMatch(structuralScanText('echo "rm -rf /"'), /rm -rf/);
});

test("truncateUtf8 respects the byte budget without splitting code points", () => {
  assert.equal(truncateUtf8("abcdef", 3), "abc");
  assert.equal(Buffer.byteLength(truncateUtf8("中文中文", 5), "utf8"), 3);
  assert.equal(truncateUtf8("日本語", 0), "");
  assert.equal(MAX_REVIEWER_COMMAND_BYTES, 10_240);
});

test("repeated eval expansion has a shared bound across recursion levels", () => {
  for (const count of [100, 300]) {
    const command = "eval ".repeat(count) + "true";
    const payloads = nestedShellPayloads(command);
    assert.equal(shellExpansionLimitExceeded(command), true);
    assert.ok(payloads.length <= MAX_NESTED_PAYLOAD_COUNT);
    assert.ok(
      payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload, "utf8"), 0)
        <= MAX_NESTED_PAYLOAD_BYTES,
    );
    // A deterministic resource bound, independent of machine speed. The old
    // 300-eval expansion produced over 22 MB from a 1.5 KB command.
    assert.ok(
      Buffer.byteLength(structuralScanText(command), "utf8") <=
        Buffer.byteLength(command, "utf8") + MAX_NESTED_PAYLOAD_BYTES + MAX_NESTED_PAYLOAD_COUNT,
    );
  }
});

test("payload count exhaustion is reported only when a payload is omitted", () => {
  const atLimit = "eval 'true'; ".repeat(MAX_NESTED_PAYLOAD_COUNT);
  assert.equal(nestedShellPayloads(atLimit).length, MAX_NESTED_PAYLOAD_COUNT);
  assert.equal(shellExpansionLimitExceeded(atLimit), false);
  const overLimit = atLimit + "eval 'true'";
  assert.equal(nestedShellPayloads(overLimit).length, MAX_NESTED_PAYLOAD_COUNT);
  assert.equal(shellExpansionLimitExceeded(overLimit), true);
});

test("the payload byte budget counts UTF-8 bytes and is not reset per payload", () => {
  const payload = "é".repeat(MAX_NESTED_PAYLOAD_BYTES / 2);
  const atLimit = `python3 -c '${payload}'`;
  assert.equal(shellExpansionLimitExceeded(atLimit), false);
  assert.deepEqual(nestedShellPayloads(atLimit), [payload]);
  const oversized = `python3 -c '${payload}é'`;
  assert.equal(shellExpansionLimitExceeded(oversized), true);
  assert.deepEqual(nestedShellPayloads(oversized), []);
  // A second payload shares the bytes consumed by the first.
  assert.equal(shellExpansionLimitExceeded(`${atLimit}; eval 'true'`), true);
  assert.deepEqual(nestedShellPayloads(`${atLimit}; eval 'true'`), [payload]);
});

test("an exhausted expansion retains the whole original command for hard denies", () => {
  const command = "eval 'true'; ".repeat(MAX_NESTED_PAYLOAD_COUNT + 1) +
    'bash -c "curl -k https://x"';
  assert.equal(shellExpansionLimitExceeded(command), true);
  assert.ok(structuralScanText(command).startsWith(command));
});
