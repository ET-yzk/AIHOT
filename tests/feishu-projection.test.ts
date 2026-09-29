// The Feishu table mirror (CT-4): the portal's own rows, sent once and never twice, with a withdrawal
// reaching the mirror like it reaches every other exit. The Feishu API is a local stub, and the valve is
// exercised too — a deployment that has not switched the projection on makes no call at all.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Reply, stub, tag } from "./setup.ts";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { setVisibility } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";

const T = tag();
const SOURCE = `test-projection-${T}`;
const CATEGORY = CATEGORY_KEYS[0]!;

interface Sent { url: string; method: string; fields: Record<string, unknown> }
const sent: Sent[] = [];
const api = await stub((_hit, req) => {
  const url = req.url;
  if (url.includes("/auth/v3/tenant_access_token")) return { code: 0, tenant_access_token: `token-${T}`, expire: 3600 };
  const body = JSON.parse(req.body || "{}") as Record<string, any>;
  if (url.endsWith("/records/batch_create")) {
    for (const record of body.records as Array<{ fields: Record<string, unknown> }>) sent.push({ url, method: "POST", fields: record.fields });
    return { code: 0, data: { records: body.records.map((_r: unknown, n: number) => ({ record_id: `rec-${T}-${n}` })) } };
  }
  if (/\/records\/rec-/.test(url)) {
    sent.push({ url, method: "PUT", fields: body.fields as Record<string, unknown> });
    return { code: 0, data: { record: { record_id: url.split("/").pop() } } };
  }
  return new Reply(400, { code: 1, msg: `the projection asked for something unexpected: ${url}` });
});

// FEISHU_API_BASE is read when the module loads, so both halves of the surface arrive together.
Object.assign(process.env, {
  FEISHU_API_BASE: api.url,
  FEISHU_APP_ID: `cli_${T}`,
  FEISHU_APP_SECRET: `secret-${T}`,
  FEISHU_BITABLE_APP_TOKEN: `basc${T}`,
  FEISHU_BITABLE_TABLE_ID: `tbl${T}`,
});
const { PROJECTION_JOB, projectPortalRows } = await import("@aihot/backend/projection/bitable");

let n = 0;
/** A published, selected item — the portal's front page is what the mirror reflects. */
async function item(extra: Record<string, unknown> = {}): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/${T}-${n}`, title: `Rule ${n} ${T}`, bodyText: `BODY-${n}-${T}`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(), ...extra,
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${CATEGORY}, ${`新规 ${n}-${T}`}, ${`SUMMARY-${n}-${T}`}, '理由', 90, true)`;
  await publishArticle(articleId);
  await release();
  return articleId;
}

/**
 * Each cycle starts from an empty portal and an empty mirror, so a count means what it says. The throwaway
 * database keeps items from earlier runs of this file (and of a crashed one), which the projection would
 * otherwise mirror too, so they go first — they are this test's own fixtures, named for it.
 */
async function reset() {
  sent.length = 0;
  await sql`DELETE FROM projection_rows WHERE job = ${PROJECTION_JOB}`;
  await sql`DELETE FROM publications WHERE source_id LIKE 'test-projection-%' OR source_id LIKE 'probe%'`;
  await sql`DELETE FROM analyses WHERE article_id IN (SELECT id FROM articles WHERE source_id LIKE 'test-projection-%' OR source_id LIKE 'probe%')`;
  await sql`DELETE FROM articles WHERE source_id LIKE 'test-projection-%' OR source_id LIKE 'probe%'`;
  n = 0;
}

/**
 * A new selection is released on a schedule, and the portal's order is that schedule: the mirror reads
 * what the portal can show right now, so a test that wants a row visible stamps it visible.
 */
const release = () => sql`
  UPDATE publications SET visible_after = now(), sort_at = now(), timeline_at = now()
   WHERE source_id = ${SOURCE} AND (visible_after > now() OR sort_at > now())`;

const creates = () => sent.filter((s) => s.method === "POST").map((s) => s.fields);
const updates = () => sent.filter((s) => s.method === "PUT");

before(async () => {
  await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test projection', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
  config.feishuBitableEnabled = true;
});
after(async () => {
  await sql`DELETE FROM projection_rows WHERE job = ${PROJECTION_JOB}`;
  await api.close();
  await stopBoss();
  await closeDb();
});

test("with the valve off the plan is computed and nothing is sent", async () => {
  await reset();
  await item();
  const hits = api.hits();
  config.feishuBitableEnabled = false;
  const off = await projectPortalRows();
  config.feishuBitableEnabled = true;
  assert.deepEqual([off.status, off.portal, off.created], ["disabled", 1, 1], "what would have been sent is reported");
  assert.equal(api.hits(), hits, "and not one call leaves the process");
});

test("the mirror carries the portal's rows, and an unchanged row is never sent twice", async () => {
  await reset();
  const [a] = [await item(), await item()];
  const first = await projectPortalRows();
  assert.deepEqual([first.status, first.created, first.updated, first.unchanged], ["sent", 2, 0, 0], `portal said ${first.portal}: ${JSON.stringify(creates().map((c) => c.标题))}`);
  const written = creates();
  assert.equal(written.length, 2);
  assert.deepEqual(written.map((c) => c.标题).sort(), [`新规 1-${T}`, `新规 2-${T}`]);
  assert.equal(new Set(written.map((c) => c.门户链接)).size, 2, "each row links to its own permanent page");
  assert.ok(written.every((c) => c.状态 === "在门户" && c.分类 === CATEGORY && c.摘要?.toString().startsWith("SUMMARY-")));

  const hits = api.hits();
  const second = await projectPortalRows();
  assert.deepEqual([second.created, second.updated, second.unchanged], [0, 0, 2]);
  assert.equal(api.hits(), hits, "a row whose hash matches is not sent, so a quiet cycle makes no call at all");

  await sql`UPDATE analyses SET summary_zh = ${`EDITED-${T}`} WHERE article_id = ${a}`;
  await publishArticle(a);
  await release();
  const third = await projectPortalRows();
  assert.deepEqual([third.updated, third.created], [1, 0], "one row changed, none new");
  assert.equal(updates().length, 1);
  assert.equal(updates()[0]!.fields.摘要, `EDITED-${T}`);
});

test("a cell the platform does not know is left out, never sent empty over someone's note", async () => {
  await reset();
  // A feed that gives no date: the portal still lists the item, at its discovery time.
  await item({ publishedAt: null });
  const result = await projectPortalRows();
  assert.equal(result.created, 1, "the row still arrives");
  const [row] = creates();
  assert.ok(!("发布时间" in row!), "its date column is not touched at all");
  assert.ok(!Object.values(row!).includes(null), "nothing is sent as a null cell");
});

test("a withdrawal reaches the mirror, and the row says so", async () => {
  await reset();
  const a = await item();
  await projectPortalRows();
  sent.length = 0;
  await setVisibility(a, { visibility: "withdrawn", reason: T, version: 0 }, "test");
  const after = await projectPortalRows();
  assert.deepEqual([after.withdrawn, after.created], [1, 0], "the row the portal dropped is written once");
  const [put] = updates();
  assert.equal(put!.fields.状态, "已撤下");
  assert.equal(put!.fields.摘要, "", "and its summary cell is cleared rather than left to be quoted again");
  assert.equal((await projectPortalRows()).withdrawn, 0, "a withdrawn row is not re-sent either");
  await setVisibility(a, { visibility: "public", reason: T, version: 1 }, "test");
});
