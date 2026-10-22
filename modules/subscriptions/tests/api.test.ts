// The first-party subscription API: options are public, everything about a reader needs a session, and
// the suggestion endpoint takes only a list of ids (nothing about the reader's favourites is stored).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { closeDb } from "@aihot/backend/db";

// The deployment's .env may name the real login app; this file checks the unconfigured answer.
process.env.FEISHU_LOGIN_APP_ID = "";
process.env.FEISHU_LOGIN_APP_SECRET = "";

const module = await import("../server.ts");
const app = Fastify();
module.default.http?.(app);
await app.ready();

after(async () => {
  await app.close();
  await closeDb();
});

test("options are public and say whether sign-in is configured", async () => {
  const res = await app.inject({ method: "GET", url: "/api/subscriptions/options" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { loginConfigured: boolean; categories: unknown[]; topics: unknown[] };
  assert.equal(body.loginConfigured, false);
  assert.ok(body.categories.length > 0);
  assert.ok(body.topics.length > 0);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("reader routes require a session, and the suggestion endpoint validates its list", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/subscriptions/me" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/api/subscriptions", payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/subscriptions/test" })).statusCode, 401);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/subscriptions/me" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/subscriptions/auth/logout" })).statusCode, 204);

  const bad = await app.inject({ method: "POST", url: "/api/subscriptions/suggest", payload: { itemIds: "nope" } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/api/subscriptions/suggest", payload: { itemIds: [] } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { total: 0, categories: [], topics: [] });
});
