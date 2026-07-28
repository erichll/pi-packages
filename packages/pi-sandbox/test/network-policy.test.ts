import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicAddress,
  normalizePublicHostname,
  validatePublicHostname,
} from "../src/network-policy.mjs";

test("network review accepts only normalized domain names", () => {
  assert.equal(normalizePublicHostname("API.Example.COM."), "api.example.com");
  assert.equal(normalizePublicHostname("127.0.0.1"), undefined);
  assert.equal(normalizePublicHostname("localhost"), undefined);
  assert.equal(normalizePublicHostname("bad host.example"), undefined);
});

test("private, loopback, link-local, and multicast addresses are prohibited", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
});

test("a domain resolving to any prohibited address fails closed", async () => {
  const mixedResolver = async () => [
    { address: "93.184.216.34", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
  ];
  assert.equal(
    await validatePublicHostname("example.com", mixedResolver),
    undefined,
  );
});
