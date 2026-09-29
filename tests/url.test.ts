// The fetch guard: internal addresses stay unreachable in every spelling, and a name that resolves
// to one is refused at connect time too (DNS rebinding after the URL check).
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { assertPublicUrl, guardedLookup, internalEgressPermitted, isBlockedAddress, isInternalAddress } from "@aihot/backend/lib/url";

const server = http.createServer((_req, res) => res.end("internal"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const { port } = server.address() as { port: number };
const agent = new Agent({ connect: { lookup: guardedLookup as never } });
after(async () => {
  server.close();
  await agent.close();
});

test("internal and reserved addresses are blocked in every spelling", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::7f00:1", // IPv4-mapped and -compatible
    "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", // NAT64, 6to4, Teredo
    "not-an-ip",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"];
  assert.deepEqual(blocked.filter((a) => !isBlockedAddress(a)), [], "not blocked");
  assert.deepEqual(allowed.filter((a) => isBlockedAddress(a)), [], "wrongly blocked");
});

test("URL literals that embed a loopback address are refused before any request", async () => {
  for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::127.0.0.1]/", "http://localhost/"]) {
    await assert.rejects(assertPublicUrl(url), Error, url);
  }
  await assert.rejects(guardedFetch(`http://[::ffff:127.0.0.1]:${port}/`));
});

test("a name resolving to an internal address is refused at connect time", async () => {
  await assert.rejects(undiciFetch(`http://localhost:${port}/`, { dispatcher: agent }));
});

test("through the egress proxy only internal answers refuse a name; literals keep the full check", async () => {
  // The proxy resolves and connects abroad: a poisoned local answer (Teredo, documentation, reserved)
  // must not refuse a blocked site, while anything that reaches this host or its network still does.
  const internal = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:a9fe:a9fe::1"];
  const unroutable = ["2001::58bf:f9b6", "2001:db8::1", "255.255.255.255", "224.0.0.1", "192.0.2.1", "8.8.8.8", "2606:4700:4700::1111"];
  assert.deepEqual(internal.filter((a) => !isInternalAddress(a)), [], "internal not recognised");
  assert.deepEqual(unroutable.filter((a) => isInternalAddress(a)), [], "wrongly internal");
  for (const url of ["http://localhost/", "http://[::ffff:127.0.0.1]/", "http://[2001:db8::1]/", "http://10.0.0.1/"]) {
    await assert.rejects(assertPublicUrl(url, false, true), Error, url);
  }
});

test("the internal allowlist names peers exactly: no prefix, no wildcard, no other port", () => {
  const list = ["172.17.12.199:8080", "knowledge.internal"];
  const hit = (u: string) => internalEgressPermitted(new URL(u), list);
  assert.ok(hit("http://172.17.12.199:8080/api"), "named host and port");
  assert.ok(hit("http://knowledge.internal/"), "named host on the scheme's default port");
  assert.ok(!hit("http://172.17.12.199:9999/"), "another port");
  assert.ok(!hit("http://172.17.12.198:8080/"), "another host");
  assert.ok(!hit("http://172.17.12.199.example:8080/"), "a host that only starts with the name");
  assert.ok(!hit("http://evil.knowledge.internal/"), "a subdomain of a named host");
  assert.deepEqual(["http://10.0.0.1/"].map((u) => internalEgressPermitted(new URL(u), [])), [false], "empty list admits nothing");
});

test("a named internal peer is reachable on the direct route only, and only while named", async () => {
  const before = config.internalEgressAllow;
  try {
    config.internalEgressAllow = [];
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { route: "direct" }), Error, "no allowlist");
    config.internalEgressAllow = [`127.0.0.1:${port}`];
    assert.equal((await guardedFetch(`http://127.0.0.1:${port}/`, { route: "direct" })).text(), "internal");
    // The egress route is collection traffic: a peer named for the knowledge layer does not open it.
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`), Error, "egress route");
    config.internalEgressAllow = [`127.0.0.1:${port + 1}`];
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { route: "direct" }), Error, "another port");
  } finally {
    config.internalEgressAllow = before;
  }
});
