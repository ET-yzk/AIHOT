// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { checkAlerts } from "@aihot/backend/operations/alerts";

const T = tag();
const SOURCE = `test-alerts-${T}`;
let saved: { key: string; value: unknown }[] = [];
const ids: string[] = [];

before(async () => {
  await getBoss(); // collectFindings reads the job tables
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-${i}`, title: `stuck ${i}`, bodyStatus: "none", via: "fetch" } as never);
    ids.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(ids)}`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  for (const s of saved) await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await stopBoss();
  await closeDb();
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json({ "receipts.unknown": { title: "付费请求结果未知", since: new Date(t0 - 86400_000).toISOString(), sentAt: new Date(t0 - 3600_000).toISOString() } })}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

  let r = await checkAlerts(t0);
  assert.deepEqual(stuck(r.sent), ["content.process"]);
  assert.ok(!r.sent.some((k) => k.startsWith("receipts.unknown")), "an entry from before the levels closes silently");
  assert.ok(!r.open.includes("receipts.unknown"));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
  r = await checkAlerts(t0 + 61 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(ids)}`;
  r = await checkAlerts(t0 + 70 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
  r = await checkAlerts(t0 + 80 * 60_000);
  assert.deepEqual(stuck(r.sent), []);
});

test("a source that keeps failing and a spent daily budget are announced once", async () => {
  // The other two rules of the ops baseline, both provable in the database: a source nobody notices because
  // the rest of the site keeps moving, and a paid provider whose 24-hour cap has been reached.
  const SERVICE = `alerts-${T}`;
  const key = `budget.day.${SERVICE}`;
  try {
    await sql`UPDATE sources SET enabled = true, health = 'failing', fail_count = 3, last_error = 'Fetched page had no items', last_ok_at = NULL WHERE id = ${SOURCE}`;
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${SERVICE}, 0, 0, 2) ON CONFLICT (service) DO UPDATE SET per_day = 2`;
    const [receipt] = await sql<{ id: string }[]>`
      INSERT INTO receipts (logical_key, service, purpose, status) VALUES (${`alert-${T}`}, ${SERVICE}, 'test', 'completed') RETURNING id`;
    for (const attempt of [1, 2]) {
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status)
                VALUES (${receipt!.id}, ${attempt}, ${SERVICE}, 'live', 'received')`;
    }

    const sent = (await checkAlerts()).sent;
    assert.ok(sent.includes("source.failing"), `the failing source is announced: ${sent.join(",")}`);
    assert.ok(sent.includes(key), `the spent daily budget is announced: ${sent.join(",")}`);
    assert.deepEqual((await checkAlerts()).sent.filter((k) => k === "source.failing" || k === key), [], "neither is repeated inside its window");
  } finally {
    await sql`DELETE FROM receipts WHERE logical_key = ${`alert-${T}`}`; // its attempts go with it
    await sql`DELETE FROM budgets WHERE service = ${SERVICE}`;
    await sql`UPDATE sources SET enabled = false, health = 'ok', fail_count = 0, last_error = NULL WHERE id = ${SOURCE}`;
  }
});
