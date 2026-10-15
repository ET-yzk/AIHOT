// The fetch guard: internal addresses stay unreachable in every spelling, and a name that resolves
// to one is refused at connect time too (DNS rebinding after the URL check).
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { after, mock, test } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { config } from "@aihot/backend/config";
import { assertPublicUrl, guardedLookup, internalEgressPermitted, isBlockedAddress } from "@aihot/backend/lib/url";

let hits = 0;
const server = http.createServer((_req, res) => { hits++; res.end("public content"); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const { port } = server.address() as { port: number };
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("internal and reserved addresses are blocked in every spelling", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
    "198.18.0.0", "198.18.0.1", "198.19.255.255", "::ffff:198.18.0.1", "64:ff9b::c612:1", "2002:c612:1::1",
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

// Benchmark space is not public address space. Local proxy fake-IP routing must not make it a
// production exception; URL parsing also turns decimal/hex literals into the same destination.
test("benchmark literals are refused without a local-debug override", async () => {
  for (const host of ["198.18.0.1", "198.19.255.255", "3323068417", "0xc6120001", "[::ffff:198.18.0.1]"]) {
    await assert.rejects(assertPublicUrl(`http://${host}/`), /Blocked/, host);
  }
  assert.equal((await assertPublicUrl("http://198.18.0.1/", true)).hostname, "198.18.0.1");
});

test("blocked DNS names keep their boundary with a trailing root dot", async () => {
  const names = ["localhost", "child.localhost", "metadata.google.internal", "anything.internal"];
  for (const name of names) {
    await assert.rejects(assertPublicUrl(`http://${name}./`, false, async () => ["93.184.216.34"]), /Blocked host/, name);
  }
  assert.equal((await assertPublicUrl("https://example.org./", false, async () => ["93.184.216.34"])).hostname, "example.org.");
  let lookups = 0;
  mock.method(dns, "lookup", async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; });
  syncBuiltinESMExports();
  try {
    for (const name of names) for (const all of [false, true]) {
      const error = await new Promise<NodeJS.ErrnoException | null>(resolve => guardedLookup(`${name.toUpperCase()}.`, { all }, err => resolve(err)));
      assert.equal(error?.code, "EBLOCKED", `${name}, all=${all}`);
    }
    assert.equal(lookups, 0, "blocked names are rejected before resolving an address");
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("the connection guard refuses private, mixed, reserved and empty DNS answers, including a changed answer", async () => {
  const agent = new Agent({ connect: { lookup: guardedLookup as never } });
  const before = hits;
  const answers: Record<string, string[]> = { "public.invalid": ["93.184.216.34"], "private.invalid": ["127.0.0.1"],
    "mixed.invalid": ["93.184.216.34", "127.0.0.1"], "reserved.invalid": ["198.18.0.1"], "empty.invalid": [] };
  const savedLookup = dns.lookup;
  mock.method(dns, "lookup", async (host: string, options: unknown) => {
    if (!(host in answers)) return savedLookup(host, options as never);
    return answers[host]!.map(address => ({ address, family: 4 }));
  });
  const savedConnect = net.connect;
  mock.method(net, "connect", function (this: unknown, options: net.TcpNetConnectOpts, ...rest: unknown[]) {
    if (options.host && options.host in answers) {
      const lookup = options.lookup!;
      // Only an address already accepted by the real guard reaches the local fixture.
      options = { ...options, port, lookup(host, opts, done) {
        lookup(host, opts, (error, address, family) => {
          if (error) return done(error, address, family);
          done(null, Array.isArray(address) ? address.map(a => ({ ...a, address: "127.0.0.1" })) : "127.0.0.1", family);
        });
      } };
    }
    return Reflect.apply(savedConnect, this, [options, ...rest]);
  });
  syncBuiltinESMExports();
  try {
    const read = async (host: string, targetPort = port) => {
      const response = await undiciFetch(`http://${host}:${targetPort}/`, { dispatcher: agent });
      return response.text();
    };
    assert.equal(await read("public.invalid"), "public content");
    for (const host of ["private.invalid", "mixed.invalid", "reserved.invalid", "empty.invalid"]) {
      await assert.rejects(read(host));
    }
    answers["public.invalid"] = ["127.0.0.1"];
    await assert.rejects(read("public.invalid", port + 1), "a new connection cannot reuse the name's previous public DNS answer");
    assert.equal(hits, before + 1, "refused DNS answers never reach the destination");
  } finally {
    await agent.destroy();
    mock.restoreAll(); syncBuiltinESMExports();
  }
});

// A named internal peer (INTERNAL_EGRESS_ALLOW) is the only private address the guard lets
// through, on the direct route only, and only while it is named exactly.
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
    assert.equal((await guardedFetch(`http://127.0.0.1:${port}/`, { route: "direct" })).text(), "public content");
    // The egress route is collection traffic: a peer named for the knowledge layer does not open it.
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`), Error, "egress route");
    config.internalEgressAllow = [`127.0.0.1:${port + 1}`];
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`, { route: "direct" }), Error, "another port");
  } finally {
    config.internalEgressAllow = before;
  }
});
