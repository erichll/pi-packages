import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_NAME = "pi-auto-review";
// This module sits at <package root>/src/review/ — three levels up.
export const PACKAGE_ROOT = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
export const PROJECT_CONFIG_PATH = join(".pi", "pi-auto-review.json");
export const USER_CONFIG_RELATIVE_PATH = join(
  ".pi",
  "agent",
  "extensions",
  "pi-auto-review",
  "config.json",
);
export const BOUNDED_SURFACES = new Set(["path", "external_directory"]);
export const REVIEWER_FRAMING_RESERVE_TOKENS = 64;
export const REVIEWER_RETRY_DELAY_MS = 250;
export const REVIEWER_MAX_RETRY_AFTER_MS = 5_000;
export const FORMAT_RETRY_INSTRUCTION =
  "Format correction only: return exactly one JSON object matching the required schema; do not change the authorization scope or evidence interpretation.";
