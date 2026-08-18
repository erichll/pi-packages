import assert from "node:assert/strict";
import test from "node:test";
import { decodeExternalNetworkPolicy } from "../src/external-network-policy.mjs";

test("external policy decoder copies a valid trusted payload", () => {
  const payload = {
    allowedDomains: ["github.com", "*.github.com:443"],
    deniedDomains: ["uploads.github.com", "*:22"],
  };
  const decoded = decodeExternalNetworkPolicy(payload);
  payload.allowedDomains.push("later.example.com");
  payload.deniedDomains.length = 0;
  assert.deepEqual(decoded, {
    allowedDomains: ["github.com", "*.github.com:443"],
    deniedDomains: ["uploads.github.com", "*:22"],
  });
});

test("external policy decoder hard-denies missing or malformed payloads", () => {
  for (const payload of [
    undefined,
    null,
    [],
    {},
    { allowedDomains: ["github.com"], deniedDomains: "example.com" },
    { allowedDomains: ["*"] , deniedDomains: [] },
    { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
  ]) {
    assert.deepEqual(decodeExternalNetworkPolicy(payload), {
      allowedDomains: [],
      deniedDomains: ["*"],
    });
  }
});
