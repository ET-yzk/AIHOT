// The subscription page is private: a signed-out reader gets the sign-in invitation, a signed-in reader
// gets their saved settings, and neither copy may be cached.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReaderMe, SubscriptionOptions } from "@aihot/contracts/subscriptions";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

const OPTIONS: SubscriptionOptions = {
  categories: [{ key: "regulation", label: "法律法规", tagColor: "orange" }],
  topics: [{ slug: "miit", name: "工业和信息化部", group: "company" }],
  groups: [{ key: "company", name: "主管部门" }],
  loginConfigured: true,
};

const ME: ReaderMe = {
  user: { name: "测试读者", avatarUrl: null },
  subscription: {
    enabled: true, daily: true, weekly: false, monthly: false,
    scope: "categories", categories: ["regulation"], topics: [], updatedAt: "2026-10-20T08:00:00.000Z",
  },
  deliveries: [],
  csrf: "csrf-fixture",
};

let signedIn = false;
const api = fakeApi((url, res) => {
  if (url.pathname === "/api/subscriptions/options") return OPTIONS;
  if (url.pathname === "/api/subscriptions/me") {
    if (!signedIn) {
      res.statusCode = 401;
      return { code: "unauthorized" };
    }
    return ME;
  }
  return undefined;
});
let web: WebServer;

before(async () => {
  web = await startWebServer(api);
});
after(async () => {
  await web?.stop();
});

test("a signed-out reader is invited to sign in, and the page is private", async () => {
  signedIn = false;
  const res = await fetch(`${web.origin}/subscriptions`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const html = await res.text();
  assert.match(html, /用飞书登录/);
  assert.match(html, /\/api\/subscriptions\/auth\/login\?return=\/subscriptions/);
  assert.match(html, /noindex/);
});

test("a signed-in reader sees their saved settings and the test button", async () => {
  signedIn = true;
  const res = await fetch(`${web.origin}/subscriptions`, { headers: { cookie: "aihot_reader=fixture" } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /测试读者/);
  assert.match(html, /已用飞书登录/);
  assert.match(html, /保存/);
  assert.match(html, /发送测试消息/);
  assert.match(html, /法律法规/);
});
