// The reader push pipeline: the card keeps the issue's lead and only the entries that still have a page;
// a filtered subscription sends only its matches (or nothing); the sweep's unique key makes it idempotent;
// a refused message is recorded as failed.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Reply, stub, tag } from "../../../tests/setup.ts";

interface Sent { receiveId: string; receiveIdType: string | null; card: Record<string, unknown> }
const sent: Sent[] = [];
const api = await stub((_hit, req) => {
  if (req.url.includes("/auth/v3/tenant_access_token/internal")) {
    return { code: 0, tenant_access_token: "token-delivery", expire: 3600 };
  }
  if (req.url.includes("/im/v1/messages")) {
    const body = JSON.parse(req.body || "{}") as { receive_id?: string; content?: string };
    if (body.receive_id === "open-fail") return { code: 230001, msg: "no permission" };
    sent.push({
      receiveId: body.receive_id ?? "",
      receiveIdType: new URL(req.url, "http://stub").searchParams.get("receive_id_type"),
      card: JSON.parse(body.content ?? "{}") as Record<string, unknown>,
    });
    return { code: 0, data: { message_id: `om-${sent.length}` } };
  }
  return new Reply(400, { code: 1, msg: `unexpected ${req.url}` });
});

// FEISHU_API_BASE and the switches are read when the backend modules load.
process.env.FEISHU_API_BASE = api.url;
Object.assign(process.env, {
  FEISHU_APP_ID: "cli_test_delivery",
  FEISHU_APP_SECRET: "secret_test_delivery",
  FEISHU_LOGIN_APP_ID: "cli_test_delivery",
  FEISHU_LOGIN_APP_SECRET: "secret_test_delivery",
  FEISHU_READER_PUSH_ENABLED: "true",
});

const { config } = await import("@aihot/backend/config");
const { closeDb, sql } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { buildReportCard, deliverOne, sweepSubscriptions } = await import("../server.ts");
const { testCard } = await import("../card.ts");

after(async () => {
  await stopBoss();
  await closeDb();
  await api.close();
});

const t = tag();
const now = new Date("2026-10-21T00:00:00Z");
const at = new Date("2026-10-20T00:00:00Z");
const source = `sub-delivery-${t}`;

await sql`INSERT INTO sources (id, name, kind, tier, participation_mode)
  VALUES (${source}, 'Sub delivery', 'rss', 'T1', 'editorial')`;
async function item(id: string, tags: string[], category: string, visibility = "public") {
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${id}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, source_id, title, url, discovered_at, timeline_at, sort_at,
    visible_after, selected, eligible, visibility, channel, tags, category)
    VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${at}, ${at}, ${at}, ${at},
      true, true, ${visibility}, 'news', ${tags}, ${category})`;
}
await item(`${t}-1`, ["ADAS 视觉感知"], "regulation");
await item(`${t}-2`, [], "technology");
await item(`${t}-3`, ["entity:byd"], "regulation", "withdrawn");

const [reader] = await sql<{ id: number }[]>`
  INSERT INTO reader_users (feishu_union_id, feishu_open_id, display_name)
  VALUES (${`union-${t}`}, ${`open-${t}`}, 'Delivery reader') RETURNING id`;
await sql`INSERT INTO reader_subscriptions (user_id, enabled, daily, weekly, monthly, scope, created_at)
  VALUES (${reader!.id}, true, true, false, false, 'all', ${new Date(now.getTime() - 86400_000)})`;

const content = {
  lead: { title: "今日要闻", leadParagraph: "一条要闻。" },
  leadItemId: `${t}-1`,
  highlights: [`${t}-2`],
  sections: [{ label: "法规", items: [
    { itemId: `${t}-1`, title: "法规一", summary: "摘要一", sourceName: "来源", sourceUrl: `https://example.org/${t}-1` },
    { itemId: `${t}-2`, title: "技术二", summary: "摘要二", sourceName: "来源", sourceUrl: `https://example.org/${t}-2` },
    { itemId: `${t}-3`, title: "已撤回", summary: "摘要三", sourceName: "来源", sourceUrl: `https://example.org/${t}-3` },
  ] }],
};
await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
  VALUES ('daily', '2026-10-20', ${new Date(now.getTime() - 2 * 3600_000)}, ${new Date(now.getTime() - 3600_000)},
    ${sql.json(content as never)}, ${now})`;

const report = { kind: "daily" as const, key: "2026-10-20", content, generated_at: now };

test("the card keeps the lead, lists only entries that still have a page, and skips a withdrawn one", async () => {
  const built = await buildReportCard(report, "daily", {
    enabled: true, daily: true, weekly: true, monthly: false, scope: "all", categories: [], topics: [],
  });
  assert.ok(built);
  assert.equal(built.filtered, false);
  const text = JSON.stringify(built.card);
  assert.ok(text.includes("今日要闻"));
  assert.ok(text.includes("技术二"));
  assert.ok(!text.includes("已撤回"));
});

test("a category subscription lists only its matches, and sends nothing when there are none", async () => {
  const matched = await buildReportCard(report, "daily", {
    enabled: true, daily: true, weekly: true, monthly: false, scope: "categories", categories: ["technology"], topics: [],
  });
  assert.ok(matched);
  assert.equal(matched.filtered, true);
  assert.equal(matched.totalMatches, 1);
  const text = JSON.stringify(matched.card);
  assert.ok(text.includes("技术二"));
  assert.ok(!text.includes("今日要闻"));

  const none = await buildReportCard(report, "daily", {
    enabled: true, daily: true, weekly: true, monthly: false, scope: "categories", categories: ["standard"], topics: [],
  });
  assert.equal(none, null);
});

test("the test card points at the subscription page", () => {
  const text = JSON.stringify(testCard("RegWatch", `${config.siteUrl}/subscriptions`));
  assert.ok(text.includes("飞书推送测试"));
  assert.ok(text.includes("/subscriptions"));
});

test("the sweep writes one row per reader and issue, and the queue sends it once", async () => {
  const first = await sweepSubscriptions(now);
  assert.equal(first.disabled, undefined);
  assert.equal(first.created, 1);
  const second = await sweepSubscriptions(now);
  assert.equal(second.created, 0);

  const [delivery] = await sql<{ id: number; status: string }[]>`
    SELECT id, status FROM reader_deliveries WHERE user_id = ${reader!.id} AND report_key = '2026-10-20'`;
  assert.equal(delivery!.status, "pending");
  await deliverOne(delivery!.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.receiveId, `open-${t}`);
  assert.equal(sent[0]!.receiveIdType, "open_id");
  const [row] = await sql<{ status: string; feishu_message_id: string | null }[]>`
    SELECT status, feishu_message_id FROM reader_deliveries WHERE id = ${delivery!.id}`;
  assert.equal(row!.status, "sent");
  assert.equal(row!.feishu_message_id, "om-1");
  await deliverOne(delivery!.id);
  assert.equal(sent.length, 1);
});

test("a reader who subscribed after the issue was generated is not backfilled", async () => {
  const [later] = await sql<{ id: number }[]>`
    INSERT INTO reader_users (feishu_union_id, feishu_open_id) VALUES (${`union-later-${t}`}, ${`open-later-${t}`}) RETURNING id`;
  await sql`INSERT INTO reader_subscriptions (user_id, daily, scope, created_at)
    VALUES (${later!.id}, true, 'all', ${new Date(now.getTime() + 3600_000)})`;
  const swept = await sweepSubscriptions(now);
  assert.equal(swept.created, 0);
});

test("a filtered issue with no match is recorded as skipped and sends nothing", async () => {
  await sql`UPDATE reader_subscriptions SET scope = 'categories', categories = ${sql.array(["standard"])}::text[] WHERE user_id = ${reader!.id}`;
  const noMatch = {
    sections: [{ label: "技术", items: [
      { itemId: `${t}-2`, title: "技术二", summary: "摘要二", sourceName: "来源", sourceUrl: `https://example.org/${t}-2` },
    ] }],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', '2026-10-21', ${new Date(now.getTime() - 2 * 3600_000)}, ${new Date(now.getTime() - 3600_000)},
      ${sql.json(noMatch as never)}, ${now})`;
  const swept = await sweepSubscriptions(now);
  assert.equal(swept.created, 1);
  const [delivery] = await sql<{ id: number }[]>`
    SELECT id FROM reader_deliveries WHERE user_id = ${reader!.id} AND report_key = '2026-10-21'`;
  await deliverOne(delivery!.id);
  const [row] = await sql<{ status: string; error: string | null }[]>`
    SELECT status, error FROM reader_deliveries WHERE id = ${delivery!.id}`;
  assert.equal(row!.status, "skipped");
  assert.match(row!.error ?? "", /没有你订阅的内容/);
  assert.equal(sent.length, 1);
});

test("a message Feishu refuses is recorded as failed, not sent", async () => {
  const [failReader] = await sql<{ id: number }[]>`
    INSERT INTO reader_users (feishu_union_id, feishu_open_id) VALUES (${`union-fail-${t}`}, 'open-fail') RETURNING id`;
  await sql`INSERT INTO reader_subscriptions (user_id, daily, scope, created_at)
    VALUES (${failReader!.id}, true, 'all', ${new Date(now.getTime() - 86400_000)})`;
  const swept = await sweepSubscriptions(now);
  assert.equal(swept.created, 1);
  const [delivery] = await sql<{ id: number }[]>`
    SELECT id FROM reader_deliveries WHERE user_id = ${failReader!.id} AND report_key = '2026-10-21'`;
  await assert.rejects(deliverOne(delivery!.id), /no permission/);
  const [row] = await sql<{ status: string; error: string | null }[]>`
    SELECT status, error FROM reader_deliveries WHERE id = ${delivery!.id}`;
  assert.equal(row!.status, "failed");
  assert.match(row!.error ?? "", /no permission/);
});

test("the switch off makes the sweep do nothing", async () => {
  const original = config.feishuReaderPushEnabled;
  config.feishuReaderPushEnabled = false;
  const off = await sweepSubscriptions(now);
  assert.equal(off.disabled, true);
  assert.equal(off.created, 0);
  config.feishuReaderPushEnabled = original;
});
