// Reader sign-in: the signed state stays on this site, the session is bound to the login app and the
// reader, and deleting a reader removes everything that hangs off it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import {
  cookie, deleteReader, endSession, loginRedirect, loginWithProfile, parseCookies, safeReturn, sessionReader,
  SESSION_COOKIE, type FeishuProfile,
} from "../auth.ts";

// A deployment's .env may carry the real app; this file tests the binding with a known one.
process.env.FEISHU_LOGIN_APP_ID = "cli_test_reader";
process.env.FEISHU_LOGIN_APP_SECRET = "secret_test_reader";

after(closeDb);

const profile = (t: string): FeishuProfile => ({
  unionId: `union-${t}`, openId: `open-${t}`, email: `${t}@example.org`, name: `Reader ${t}`, avatarUrl: null,
});

test("sign-in state is signed, and return paths stay on the subscription page", () => {
  const { url, stateCookie } = loginRedirect("https://evil.example/subscriptions?x=1");
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://passport.feishu.cn");
  assert.equal(parsed.searchParams.get("redirect_uri"), `${config.siteUrl}/api/subscriptions/auth/callback`);
  assert.equal(parsed.searchParams.get("state"), stateCookie);
  assert.ok(stateCookie.includes("."));
  assert.equal(safeReturn("https://evil.example/subscriptions?x=1"), "/subscriptions?x=1");
  assert.equal(safeReturn("//evil.example/subscriptions"), "/subscriptions");
  assert.equal(safeReturn("/admin"), "/subscriptions");
  assert.equal(safeReturn("/subscriptions"), "/subscriptions");
});

test("a malformed cookie value does not hide the others", () => {
  assert.deepEqual(parseCookies("a=%E0%A4%A; b=2"), { b: "2" });
});

test("a reader keeps one row across sign-ins, and a session from another app is not trusted", async () => {
  const t = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const first = await loginWithProfile(profile(t), "cli_test_reader", "node-test");
  const header = cookie(SESSION_COOKIE, first.token, 3600, false);
  const identity = await sessionReader(header);
  assert.ok(identity);
  assert.equal(identity.userId, first.userId);
  assert.ok(identity.csrf.length >= 16);
  assert.equal(identity.name, `Reader ${t}`);
  assert.equal(identity.openId, `open-${t}`);

  // The same union_id signs in again: the same reader row and a fresh session.
  const second = await loginWithProfile(profile(t), "cli_test_reader", "node-test");
  assert.equal(second.userId, first.userId);

  // A session created by another login app (the binding) is dropped, not accepted.
  process.env.FEISHU_LOGIN_APP_ID = "cli_other_reader";
  assert.equal(await sessionReader(cookie(SESSION_COOKIE, second.token, 3600, false)), null);
  process.env.FEISHU_LOGIN_APP_ID = "cli_test_reader";

  // Signing out removes the session; deleting the reader removes the row.
  const third = await loginWithProfile(profile(t), "cli_test_reader", "node-test");
  const thirdHeader = cookie(SESSION_COOKIE, third.token, 3600, false);
  assert.ok(await sessionReader(thirdHeader));
  await endSession(thirdHeader);
  assert.equal(await sessionReader(thirdHeader), null);
  await deleteReader(first.userId);
  assert.equal((await sql`SELECT 1 FROM reader_users WHERE id = ${first.userId}`).length, 0);
});

test("a reader without a union_id is found by email", async () => {
  const t = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const emailOnly: FeishuProfile = { unionId: null, openId: `open-${t}`, email: `${t}@example.org`, name: null, avatarUrl: null };
  const first = await loginWithProfile(emailOnly, "cli_test_reader", "node-test");
  const second = await loginWithProfile({ ...emailOnly, openId: `open2-${t}` }, "cli_test_reader", "node-test");
  assert.equal(second.userId, first.userId);
  await deleteReader(first.userId);
});
