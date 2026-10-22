// Subscription settings, the push ledger and the favourite suggestion: one row per reader, a unique
// (reader, kind, issue) key, and counts that never keep the reader's favourite ids.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import {
  favouriteSuggestion, getDeliveries, getSubscription, insertDeliveries, saveSubscription,
} from "../data.ts";

after(closeDb);

async function reader(unionId: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO reader_users (feishu_union_id, display_name) VALUES (${unionId}, 'Test reader') RETURNING id`;
  return row!.id;
}

test("a reader has one subscription; saving it twice updates it and deleting the reader removes it", async () => {
  const userId = await reader(`sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  assert.equal(await getSubscription(userId), null);
  const saved = await saveSubscription(userId, {
    enabled: true, daily: true, weekly: true, monthly: false, scope: "categories", categories: ["regulation"], topics: [],
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.scope, "categories");
  assert.deepEqual(saved.categories, ["regulation"]);
  assert.equal(saved.monthly, false);
  assert.ok(saved.updatedAt);

  const updated = await saveSubscription(userId, {
    enabled: false, daily: true, weekly: false, monthly: true, scope: "topics", categories: [], topics: ["byd"],
  });
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.topics, ["byd"]);
  assert.equal(updated.weekly, false);
  const read = await getSubscription(userId);
  assert.equal(read?.enabled, false);
  assert.deepEqual(read?.topics, ["byd"]);

  await sql`DELETE FROM reader_users WHERE id = ${userId}`;
  assert.equal(await getSubscription(userId), null);
});

test("the ledger keeps one row per reader, kind and issue, and lists the newest first", async () => {
  const userId = await reader(`ledger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const rows = [{ userId, kind: "daily" as const, key: "2026-10-20" }];
  const first = await sql.begin((tx) => insertDeliveries(tx, rows));
  const second = await sql.begin((tx) => insertDeliveries(tx, rows));
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);

  // The dedupe row is not part of the list checked below.
  await sql`DELETE FROM reader_deliveries WHERE user_id = ${userId}`;
  await sql`INSERT INTO reader_deliveries (user_id, kind, report_key, status, error, sent_at)
    VALUES (${userId}, 'daily', '2026-10-19', 'sent', null, now())`;
  await sql`INSERT INTO reader_deliveries (user_id, kind, report_key, status, error)
    VALUES (${userId}, 'weekly', '2026-W42', 'skipped', '这一期没有你订阅的内容')`;
  const list = await getDeliveries(userId);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.kind, "weekly");
  assert.equal(list[0]!.status, "skipped");
  assert.ok(list[0]!.reportUrl.endsWith("/weekly/2026-W42"));
  assert.equal(list[1]!.status, "sent");
  assert.ok(list[1]!.reportUrl.endsWith("/daily/2026-10-19"));
  await sql`DELETE FROM reader_users WHERE id = ${userId}`;
});

test("favourite counts cover categories and topics, skip withdrawn items, and store nothing", async () => {
  const t = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const source = `sub-fixture-${t}`;
  const at = new Date("2026-10-20T00:00:00Z");
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode)
    VALUES (${source}, 'Sub fixture', 'rss', 'T1', 'editorial')`;
  async function item(id: string, tags: string[], category: string, visibility = "public") {
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${id}, ${at}, ${at})`;
    await sql`INSERT INTO publications (article_id, source_id, title, url, discovered_at, timeline_at, sort_at,
      visible_after, selected, eligible, visibility, channel, tags, category)
      VALUES (${id}, ${source}, ${id}, ${`https://example.org/${id}`}, ${at}, ${at}, ${at}, ${at},
        true, true, ${visibility}, 'news', ${tags}, ${category})`;
  }
  await item(`${t}-1`, ["ADAS 视觉感知", "entity:byd"], "regulation");
  await item(`${t}-2`, [], "technology");
  await item(`${t}-3`, ["entity:byd"], "regulation", "withdrawn");

  const suggestion = await favouriteSuggestion([`${t}-1`, `${t}-2`, `${t}-3`, `${t}-missing`]);
  assert.equal(suggestion.total, 2);
  assert.equal(suggestion.categories.find((c) => c.key === "regulation")?.count, 1);
  assert.equal(suggestion.topics.find((topic) => topic.slug === "adas-vision")?.count, 1);
  assert.equal(suggestion.topics.find((topic) => topic.slug === "byd")?.count, 1);
});
