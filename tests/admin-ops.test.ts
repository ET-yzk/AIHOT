// Operations that must act on what they were meant for: releasing an unknown receipt of any analysis
// step puts its article back into processing; a selected card is not sent again to a group that
// already got another report of the same fact.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { releaseReceipt } from "@aihot/backend/operations/recover";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { pushSelected } from "@aihot/backend/notify/selected";
import { publishArticle } from "@aihot/backend/publication/publish";
import { setTargetEnabled } from "@aihot/backend/admin/settings";

const T = tag();
const SOURCE = `test-ops-${T}`;
after(async () => {
  await stopBoss();
  await closeDb();
});

let n = 0;
async function article(selected = false) {
  n += 1;
  if (n === 1) await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Ops', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/ops-${T}-${n}`, title: `Ops ${n} ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  if (selected) {
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
              VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题${n}-${T}`}, ${`摘要${n}-${T}`}, 90, true)`;
  }
  return articleId;
}

test("releasing an unknown receipt of an analysis step puts the article back", async () => {
  const id = await article();
  await sql`UPDATE articles SET processing_state = 'failed', processing_error = 'receipt outcome unknown' WHERE id = ${id}`;
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, purpose, subject, status) VALUES (${`test-${T}`}, 'glm', 'score_article', ${`article:${id}@1`}, 'unknown') RETURNING id`;
  const out = await releaseReceipt(r!.id, { billed: false, note: "checked" }, "test");
  assert.equal(out?.requeued, true);
  const [a] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${id}`;
  assert.notEqual(a!.processing_state, "failed");
});

test("a report grouped into a fact already sent to a group is not sent there again", async () => {
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, note) VALUES (${`test-target-${T}`}, 'content', 'log', true, now() - interval '1 day', 'test')`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`ops-${T}`}, 'fact') RETURNING id`;
  const sent = await article(true);
  const later = await article(true);
  for (const id of [sent, later]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${id}`;
    await publishArticle(id);
  }
  // The first was sent to the group under an earlier fact's key.
  await sql`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status) VALUES (${`test-target-${T}`}, 'selected', ${sent}, ${`selected:fact:old-${T}`}, 'sent')`;
  await pushSelected(later);
  const rows = await sql`SELECT 1 FROM deliveries WHERE target_key = ${`test-target-${T}`} AND subject_id = ${later}`;
  assert.equal(rows.length, 0);
});

test("the content group gets first-party and near-first-party sources only", async () => {
  const media = `${SOURCE}-t2`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${media}, 'Media', 'rss', 'T2', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: media, url: `https://example.com/ops-t2-${T}`, title: `Ops T2 ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题T2-${T}`}, ${`摘要T2-${T}`}, 90, true)`;
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = now() WHERE id = ${articleId}`;
  await publishArticle(articleId);
  assert.deepEqual(await pushSelected(articleId), { status: "skipped", reason: "not a first-party source" });
});

// Item 24: alert/feedback purposes pass the CHECK but no reader delivers them. The admin
// used to accept the toggle, log a notify.enable audit row, and produce a "content group
// has undelivered pushes" report for a path that never fires. Kept in the CHECK for when
// those writers land; blocked at the write path until then.
test("enabling an alert or feedback target is refused while nothing reads it", async () => {
  for (const purpose of ["alert", "feedback"] as const) {
    const key = `${purpose}-unwired-${T}`;
    await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, note) VALUES (${key}, ${purpose}, 'log', false, 'unwired')`;
    await assert.rejects(() => setTargetEnabled(key, true, "operator tried", "test"), /尚未接线/);
    const [row] = await sql<{ enabled: boolean; enabled_at: Date | null }[]>`SELECT enabled, enabled_at FROM notify_targets WHERE key = ${key}`;
    assert.equal(row!.enabled, false, `${purpose} stayed disabled`);
    assert.equal(row!.enabled_at, null, `${purpose} enabled_at untouched`);
    const audits = await sql`SELECT 1 FROM audit_log WHERE action = 'notify.enable' AND subject = ${`notify-target:${key}`}`;
    assert.equal(audits.length, 0, `${purpose} left no notify.enable audit`);
  }
});

test("disabling an already-enabled content target still works through the guard", async () => {
  const key = `content-disable-${T}`;
  await sql`INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, note) VALUES (${key}, 'content', 'log', true, now() - interval '1 day', 'content row')`;
  await setTargetEnabled(key, false, "operator stopped it", "test");
  const [row] = await sql<{ enabled: boolean; enabled_at: Date | null }[]>`SELECT enabled, enabled_at FROM notify_targets WHERE key = ${key}`;
  assert.equal(row!.enabled, false);
  assert.notEqual(row!.enabled_at, null, "enabled_at kept as history even after disable");
});
