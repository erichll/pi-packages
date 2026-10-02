/**
 * Shell-text helpers for the deterministic hard-deny scan.
 *
 * `@gotgenes/pi-permission-system` decides one *command unit* at a time, so a
 * wrapper such as `bash -c "…"`, `sudo …`, or `python3 - <<'PY'` reports only
 * the wrapper as the gated command while the payload carries the program that
 * actually runs. The reviewer and the deterministic rules need a bounded view
 * of that real execution text.
 *
 * `structuralScanText` builds the "skeleton" used by structural rules
 * (destructive deletion, transport weakening): quoted literals that merely
 * *mention* a dangerous command are inert data and are masked, while shell
 * expansions (`$HOME`, `$(…)`, backticks) and target-significant characters
 * (`/`, `*`, `~`) are preserved because a quoted value can still be the target
 * of a real command. Literal placeholders keep named paths from collapsing
 * into root/home targets. Nested shell payloads are scanned the same way;
 * other interpreter payloads stay raw because shell quoting rules cannot
 * establish which of their strings execute.
 * Nested payloads are generated lazily and share count and byte budgets. If
 * either budget is exhausted, retain the original text for hard denies and
 * require human review instead of treating the partial expansion as safe.
 *
 * Fail direction: an unterminated quote, an unparsable payload, or a heredoc
 * we cannot delimit all fall back to scanning the original text, which can
 * only add denials.
 */

/** Reviewer-visible bound for one command string. */
export const MAX_REVIEWER_COMMAND_BYTES = 10_240;

/** Shared by all nested payloads of one command, across both recursion levels. */
export const MAX_NESTED_PAYLOAD_COUNT = 32;
export const MAX_NESTED_PAYLOAD_BYTES = 32_768;

const TARGET_CHARACTERS = "/*~";

/** Truncate to a UTF-8 byte budget without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

type QuotedBody = { body: string; end: number };

function readPlainQuote(
  text: string,
  start: number,
  quote: "'" | '"',
): QuotedBody | undefined {
  let index = start + 1;
  let body = "";
  while (index < text.length) {
    const character = text[index]!;
    if (quote === '"' && character === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      body += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === quote) return { body, end: index + 1 };
    body += character;
    index++;
  }
  return undefined;
}

function readAnsiCQuote(text: string, start: number): QuotedBody | undefined {
  // `start` points at the `$` of `$'…'`.
  let index = start + 2;
  let body = "";
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      body += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === "'") return { body, end: index + 1 };
    body += character;
    index++;
  }
  return undefined;
}

function readExpansion(text: string, start: number): string | undefined {
  const next = text[start + 1];
  if (next === undefined) return undefined;
  if (next === "{") {
    const close = text.indexOf("}", start + 2);
    return close < 0 ? undefined : text.slice(start, close + 1);
  }
  if (next === "(") {
    let depth = 1;
    let index = start + 2;
    while (index < text.length) {
      const character = text[index]!;
      if (character === "(") depth++;
      else if (character === ")") {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
      index++;
    }
    return undefined;
  }
  if (/[A-Za-z_]/.test(next)) {
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start));
    return match?.[0];
  }
  if (/[0-9@*#?$!\-]/.test(next)) return text.slice(start, start + 2);
  return undefined;
}

/** Mask literal text without erasing components of a path or shell word. */
function dynamicQuotedBody(body: string): string {
  let result = "";
  let index = 0;
  while (index < body.length) {
    const character = body[index]!;
    if (character === "\\") {
      // An escaped expansion/quote is literal text, but still part of the word.
      result += "x";
      index += 2;
      continue;
    }
    if (character === "`") {
      const close = body.indexOf("`", index + 1);
      if (close < 0) {
        result += body.slice(index);
        break;
      }
      result += body.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    if (character === "$") {
      const expansion = readExpansion(body, index);
      if (expansion) {
        result += expansion;
        index += expansion.length;
        continue;
      }
      result += "x";
      index++;
      continue;
    }
    result += TARGET_CHARACTERS.includes(character) ? character : "x";
    index++;
  }
  return result;
}

function literalQuotedBody(body: string): string {
  let result = "";
  for (const character of body) {
    result += TARGET_CHARACTERS.includes(character) ? character : "x";
  }
  return result;
}

function readHeredoc(
  text: string,
  start: number,
): { end: number } | undefined {
  if (text.startsWith("<<<", start)) return undefined;
  const match = /^<<(-?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(
    text.slice(start),
  );
  if (!match) return undefined;
  const stripTabs = match[1] === "-";
  const delimiter = match[3]!;
  const headerEnd = start + match[0].length;
  let lineEnd = text.indexOf("\n", headerEnd);
  if (lineEnd < 0) return { end: text.length };
  let position = lineEnd + 1;
  while (position <= text.length) {
    const next = text.indexOf("\n", position);
    const line = text.slice(
      position,
      next < 0 ? text.length : next,
    );
    const compare = stripTabs ? line.replace(/^\t+/, "") : line;
    if (compare === delimiter) {
      return { end: next < 0 ? text.length : next };
    }
    if (next < 0) return { end: text.length };
    position = next + 1;
  }
  return { end: text.length };
}

/**
 * Replace quoted literal text with its structural skeleton.
 *
 * Quoted literals are inert data for structural rules, so their text is
 * masked — except shell expansions and path/glob/tilde characters, which can
 * still be the target of a real command. Masking must not erase named path
 * components: `"./dist"` must never become `"/"`. Heredoc bodies and command
 * substitutions are preserved verbatim. An unterminated quote returns the
 * original text unchanged (fail-closed).
 */
export function stripQuotedLiterals(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "'" || character === '"') {
      const quoted = readPlainQuote(text, index, character);
      if (!quoted) return text;
      result +=
        character +
        (character === "'"
          ? literalQuotedBody(quoted.body)
          : dynamicQuotedBody(quoted.body)) +
        character;
      index = quoted.end;
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      const quoted = readAnsiCQuote(text, index);
      if (!quoted) return text;
      result += `$'${literalQuotedBody(quoted.body)}'`;
      index = quoted.end;
      continue;
    }
    if (character === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) return text;
      result += text.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    if (character === "<" && text[index + 1] === "<") {
      const heredoc = readHeredoc(text, index);
      if (heredoc) {
        result += text.slice(index, heredoc.end);
        index = heredoc.end;
        continue;
      }
    }
    result += character;
    index++;
  }
  return result;
}

type ShellToken = {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
};

const WORD_SEPARATORS = /[\s;&|()<>`]/;

function tokenizeShell(text: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "#") {
      const newline = text.indexOf("\n", index);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    if (character === "'" || character === '"') {
      const quoted = readPlainQuote(text, index, character);
      if (!quoted) {
        tokens.push({
          value: text.slice(index + 1),
          start: index,
          end: text.length,
          quoted: true,
        });
        break;
      }
      tokens.push({
        value: quoted.body,
        start: index,
        end: quoted.end,
        quoted: true,
      });
      index = quoted.end;
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      const quoted = readAnsiCQuote(text, index);
      if (!quoted) break;
      tokens.push({
        value: quoted.body,
        start: index,
        end: quoted.end,
        quoted: true,
      });
      index = quoted.end;
      continue;
    }
    let end = index;
    while (end < text.length && !WORD_SEPARATORS.test(text[end]!)) end++;
    if (end === index) {
      index++;
      continue;
    }
    tokens.push({
      value: text.slice(index, end),
      start: index,
      end,
      quoted: false,
    });
    index = end;
  }
  return tokens;
}

function commandEnd(text: string, start: number): number {
  const match = /[;&|\n]/.exec(text.slice(start));
  return match ? start + (match.index ?? 0) : text.length;
}

function baseName(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash < 0 ? value : value.slice(slash + 1);
}

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SHORT_COMMAND_OPTION = /^-[A-Za-z]*c[A-Za-z]*$/;

type InterpreterPayload = { text: string; kind: "shell" | "opaque" };

// Shell options that consume a separate operand before a later -c option.
const SHELL_VALUE_OPTIONS = new Set([
  "-o", "+o", "-O", "+O", "--rcfile", "--init-file",
]);

function nextCommandToken(
  text: string,
  tokens: ShellToken[],
  index: number,
): ShellToken | undefined {
  const current = tokens[index];
  const next = tokens[index + 1];
  if (!current || !next) return undefined;
  // The tokenizer skips operators. Never treat a token in a subsequent
  // command as this interpreter's option or payload.
  return /[;&|\n()<>`]/.test(text.slice(current.end, next.start))
    ? undefined
    : next;
}

function shellPayloadToken(
  text: string,
  tokens: ShellToken[],
  interpreterIndex: number,
): ShellToken | undefined {
  for (let index = interpreterIndex; index < tokens.length; index++) {
    const option = nextCommandToken(text, tokens, index);
    if (!option) return undefined;
    if (
      SHORT_COMMAND_OPTION.test(option.value) || option.value === "--command"
    ) {
      return nextCommandToken(text, tokens, index + 1);
    }
    // Stop at a script operand or the end-of-options marker.
    if (option.value === "--" || !/^[-+][A-Za-z-]/.test(option.value)) {
      return undefined;
    }
    if (SHELL_VALUE_OPTIONS.has(option.value)) {
      if (!nextCommandToken(text, tokens, index + 1)) return undefined;
      index++;
    }
  }
  return undefined;
}

function* directPayloads(text: string): Generator<InterpreterPayload> {
  const tokens = tokenizeShell(text);
  const payloadValue = (token: ShellToken | undefined): string | undefined => {
    if (!token) return undefined;
    return token.quoted
      ? token.value
      : text.slice(token.start, commandEnd(text, token.start));
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const name = baseName(token.value);
    let payload: string | undefined;
    let kind: InterpreterPayload["kind"] = "opaque";
    if (SHELL_INTERPRETERS.has(name)) {
      payload = payloadValue(shellPayloadToken(text, tokens, index));
      kind = "shell";
    } else if (name === "eval") {
      payload = payloadValue(tokens[index + 1]);
      kind = "shell";
    } else if (/^python[0-9.]*$/.test(name)) {
      if (tokens[index + 1]?.value === "-c") {
        payload = payloadValue(tokens[index + 2]);
      }
    } else if (name === "perl" || name === "ruby") {
      if (tokens[index + 1]?.value === "-e") {
        payload = payloadValue(tokens[index + 2]);
      }
    } else if (name === "node") {
      const option = tokens[index + 1]?.value;
      if (option === "-e" || option === "--eval") {
        payload = payloadValue(tokens[index + 2]);
      }
    }
    // Yield lazily: eagerly collecting all suffixes of `eval eval ...` would
    // already allocate quadratic data before the caller can enforce a budget.
    if (payload && payload.trim()) yield { text: payload, kind };
  }
}

/**
 * Nested interpreter payloads within the shared count/byte budget, to a depth
 * of two. Extraction understands `bash|sh|zsh|dash|ksh -c`, `eval`, `python* -c`,
 * `perl -e`, `node -e`, and `ruby -e`. Safety callers must also check
 * `shellExpansionLimitExceeded`; a bounded prefix is not a complete program.
 */
export function nestedShellPayloads(text: string): string[] {
  return nestedInterpreterPayloads(text).payloads.map((payload) => payload.text);
}

function nestedInterpreterPayloads(text: string): {
  payloads: InterpreterPayload[];
  limitExceeded: boolean;
} {
  const payloads: InterpreterPayload[] = [];
  let payloadBytes = 0;
  let limitExceeded = false;
  const visit = (value: string, depth: number): void => {
    if (depth <= 0 || limitExceeded) return;
    for (const payload of directPayloads(value)) {
      const remainingBytes = MAX_NESTED_PAYLOAD_BYTES - payloadBytes;
      // UTF-8 is at least as long as UTF-16 in code units. Reject an obviously
      // oversized suffix before measuring/flattening its entire string.
      if (
        payloads.length >= MAX_NESTED_PAYLOAD_COUNT ||
        payload.text.length > remainingBytes
      ) {
        limitExceeded = true;
        return;
      }
      const bytes = Buffer.byteLength(payload.text, "utf8");
      if (bytes > remainingBytes) {
        limitExceeded = true;
        return;
      }
      payloadBytes += bytes;
      payloads.push(payload);
      if (payload.kind === "shell") visit(payload.text, depth - 1);
      if (limitExceeded) return;
    }
  };
  visit(text, 2);
  return { payloads, limitExceeded };
}

/** Whether nested execution could not be fully expanded within its budget. */
export function shellExpansionLimitExceeded(text: string): boolean {
  return nestedInterpreterPayloads(text).limitExceeded;
}

/**
 * Structural scan text: the literal-masked skeleton of `text` plus the
 * skeleton of nested shell payloads. Other languages remain raw: a string
 * passed to subprocess.run/execSync/system is not an inert shell literal.
 * On budget exhaustion retain the complete original text for hard denies;
 * callers must defer if that scan finds no deny, rather than trusting the
 * partially expanded program. Extra payload text never exceeds the budget.
 */
export function structuralScanText(text: string): string {
  const { payloads, limitExceeded } = nestedInterpreterPayloads(text);
  const parts = [limitExceeded ? text : stripQuotedLiterals(text)];
  for (const payload of payloads) {
    parts.push(
      payload.kind === "shell" ? stripQuotedLiterals(payload.text) : payload.text,
    );
  }
  return parts.join("\n");
}
