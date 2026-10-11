// The gold labels behind /admin/gold (docs/selection.md 的校准第 1 步): which band an item sits in, what a
// verdict stores, what the page's agreement numbers charge against those verdicts, and what the exported
// sheet looks like for scripts/eval-selection.ts. Nothing here calls a model — the page reads stored scores.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { GOLD_DECISIONS, deleteGoldLabel, goldBandOf, goldSheet, goldView, saveGoldLabel } from "@aihot/backend/admin/gold";
import { tierThreshold } from "@aihot/backend/editorial/analyze";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sha256 } from "@aihot/backend/lib/ids";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `gold-${T}`;
const CATEGORY = CATEGORIES[0].key;
const BAR = tierThreshold("T1")!;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Gold source', 'rss', 'T1')`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function item(n: number, score: number | null, relevance: "pass" | "block" = "pass") {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/${T}-${n}`, title: `Rule change ${n} ${T}`,
    bodyText: `BODY-${n}-${T}`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  if (score !== null || relevance === "block") {
    const selected = relevance !== "block" && score !== null && score >= BAR;
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
              VALUES (${articleId}, 1, 'rule', ${relevance}, ${CATEGORY}, ${`新规变化 ${n}-${T}`}, ${`摘要 ${n}`}, '因为这条重要', ${score}, ${selected})`;
  }
  return articleId;
}

test("a band is the distance to that item's own tier bar", () => {
  assert.equal(goldBandOf({ relevance: "block", score: null, sourceTier: "T1" }), "block");
  assert.equal(goldBandOf({ relevance: "pass", score: null, sourceTier: "T1" }), "unscored");
  assert.equal(goldBandOf({ relevance: "pass", score: BAR - 20, sourceTier: "T1" }), "far-below");
  assert.equal(goldBandOf({ relevance: "pass", score: BAR - 5, sourceTier: "T1" }), "near-below");
  assert.equal(goldBandOf({ relevance: "pass", score: BAR, sourceTier: "T1" }), "near-above");
  assert.equal(goldBandOf({ relevance: "pass", score: BAR + 20, sourceTier: "T1" }), "far-above");
  // A tier with no bar is never scored against one, so it cannot be near or far from it.
  assert.equal(goldBandOf({ relevance: "pass", score: 90, sourceTier: "EXCLUDE_MP" }), "unscored");
});

test("a label keeps the bar and the score it was judged against, and re-labelling is one row", async () => {
  const id = await item(1, BAR - 5);
  await saveGoldLabel({ caseId: id, decision: "select", note: "读者要看的实施时间", split: "holdout" }, "tester");
  const [first] = await sql`SELECT * FROM gold_labels WHERE case_id = ${id}`;
  assert.equal(first!.decision, "select");
  assert.equal(first!.split, "holdout");
  assert.equal(first!.threshold, BAR);
  assert.equal(first!.model_score, BAR - 5);
  assert.equal(first!.model_selected, false);
  assert.equal(first!.updated_by, "tester");
  assert.equal(first!.version, 1);

  await saveGoldLabel({ caseId: id, decision: "reject" }, "tester");
  const [again] = await sql`SELECT * FROM gold_labels WHERE case_id = ${id}`;
  assert.equal(again!.decision, "reject");
  assert.equal(again!.note, null, "a new verdict without a reason does not keep the old one");
  assert.equal(again!.version, 2);
  const [count] = await sql`SELECT count(*)::int AS n FROM gold_labels WHERE case_id = ${id}`;
  assert.equal(count!.n, 1);

  const audits = await sql`SELECT action, reason, before, after FROM audit_log WHERE subject = ${`gold:${id}`} ORDER BY id`;
  assert.deepEqual(audits.map((a) => a.action), ["gold.label", "gold.label"]);
  assert.equal(audits[0]!.reason, "读者要看的实施时间", "the reason the admin gave lands in the audit trail");
  assert.equal(audits[0]!.before, null);
  assert.deepEqual(audits[1]!.after, { decision: "reject", split: "development" });

  assert.equal((await deleteGoldLabel(id, "tester"))!.deleted, true);
  assert.equal(await deleteGoldLabel(id, "tester"), null, "deleting a label that is gone is a 404, not a 500");
  const [left] = await sql`SELECT count(*)::int AS n FROM gold_labels WHERE case_id = ${id}`;
  assert.equal(left!.n, 0);
});

test("the agreement numbers charge today's stored verdicts against the labels", async () => {
  const hit = await item(2, BAR + 25);
  const missed = await item(3, BAR - 5);
  const blocked = await item(4, null, "block");
  const either = await item(5, BAR + 15);
  for (const id of [hit, missed, blocked]) await saveGoldLabel({ caseId: id, decision: "select" }, "tester");
  await saveGoldLabel({ caseId: either, decision: "either" }, "tester");

  const m = (await goldView()).report.metrics;
  assert.equal(m.decisiveGold, 3, "the either case is not in the denominator");
  assert.equal(m.either, 1);
  assert.equal(m.tp, 1);
  assert.equal(m.fn, 2, "below the bar and blocked are both misses");
  assert.equal(m.accuracy, 0.333, "one of the three it could answer");
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 0.333);

  const { report } = await goldView();
  const kinds = Object.fromEntries(report.disagreements.map((d) => [d.caseId, d.kind]));
  assert.equal(kinds[missed], "missed");
  assert.equal(kinds[blocked], "missed");
  assert.equal(kinds[hit], undefined);
  assert.equal(kinds[either], undefined, "两可 does not disagree either way");
  assert.ok(report.sweeps.every((s) => s.rows.length === 0 || s.tier === "T1"), "only a tier with labels gets a sweep");
  const t1 = report.sweeps.find((s) => s.tier === "T1")!;
  assert.equal(t1.current, BAR);
  assert.equal(t1.rows.length, 13, "the bar swept six either side");
  const atBar = t1.rows.find((r) => r.t === BAR)!;
  assert.equal(atBar.R, m.recall, "the sweep at today's bar is the same denominator as the numbers above, not a second one");
  assert.equal(atBar.R, 0.333);
});

test("the exported sheet is what the eval script reads, with no TODO left in it", async () => {
  const labelled = await item(6, BAR + 5);
  await saveGoldLabel({ caseId: labelled, decision: "reject", note: "例行播报" }, "tester");
  const rows = await goldSheet();
  assert.ok(rows.some((r) => r.caseId === labelled));
  for (const row of rows) {
    assert.ok(GOLD_DECISIONS.includes(row.gold.decision), "every exported row is a verdict the eval accepts");
    assert.ok(row.material.title && row.material.bodyOriginal, "the eval scores the text, so it must be there");
    assert.ok(row.sourceFacts.sourceTier);
    assert.ok(["development", "holdout"].includes(row.samplingContext.benchmarkSplit));
  }
  assert.deepEqual(rows.find((r) => r.caseId === labelled)!.gold, { decision: "reject" });
  assert.equal((await goldSheet("holdout")).every((r) => r.samplingContext.benchmarkSplit === "holdout"), true);
});

test("the draw is stable per seed, keeps judged items out of 待标, and sets a third aside", async () => {
  for (const n of [7, 8, 9, 10]) await item(n, BAR - 3);
  const first = await goldView({ seed: 11 });
  const again = await goldView({ seed: 11 });
  assert.deepEqual([...first.board.cases.map((c) => c.caseId)].sort(), [...again.board.cases.map((c) => c.caseId)].sort());
  const splitOf = (view: typeof first) => Object.fromEntries(view.board.cases.map((c) => [c.caseId, c.split]));
  assert.deepEqual(splitOf(first), splitOf(again), "the same seed sets the same items aside as holdout");
  assert.ok(first.board.cases.length >= 3 && first.board.cases.some((c) => c.split === "holdout"));
  assert.equal(first.board.cases.every((c) => c.decision === null), true);

  const judged = first.board.cases[0]!;
  await saveGoldLabel({ caseId: judged.caseId, decision: "select" }, "tester");
  const next = await goldView({ seed: 11 });
  assert.equal(next.board.cases.some((c) => c.caseId === judged.caseId), false, "a judged item leaves 待标");
  assert.equal(next.board.labels.map((c) => c.caseId).includes(judged.caseId), true);
  assert.equal(next.board.waiting, first.board.waiting - 1);
});

// The routes: the same session guard as every other admin write, and a sheet that downloads as the eval reads it.
async function adminHeaders(label: string) {
  const token = `gold-session-${label}-${T}`;
  const [user] = await sql`INSERT INTO admin_users (display_name) VALUES ('Gold reviewer') RETURNING id`;
  const claims = { appId: "gold-app", unionId: `gold-user-${label}`, email: null };
  process.env.FEISHU_LOGIN_APP_ID = claims.appId;
  process.env.FEISHU_LOGIN_APP_SECRET = "gold-secret";
  config.adminUnionIds = [claims.unionId];
  const binding = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(["admin-session-v1", "feishu", claims])).digest("hex");
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at, auth_method, auth_binding, auth_claims)
            VALUES (${sha256(token)}, ${user!.id}, 'gold-csrf', now() + interval '1 hour', 'feishu', ${binding}, ${sql.json(claims)})`;
  return { cookie: `aihot_admin=${token}`, "x-csrf-token": "gold-csrf", "idempotency-key": `gold-${label}-${T}` };
}

test("the gold routes guard writes, refuse a bad verdict, and download the sheet", async () => {
  const headers = await adminHeaders("write");
  const id = await item(11, BAR - 5);

  const noCsrf = await app.inject({ method: "POST", url: `/api/admin/gold/${id}`, headers: { cookie: headers.cookie }, payload: { decision: "select" } });
  assert.equal(noCsrf.statusCode, 403, "a write needs the session's CSRF token");

  const bad = await app.inject({ method: "POST", url: `/api/admin/gold/${id}`, headers, payload: { decision: "maybe" } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await sql`SELECT 1 FROM gold_labels WHERE case_id = ${id}`).length, 0, "a refused verdict stores nothing");

  const missing = await app.inject({ method: "POST", url: `/api/admin/gold/no-such-item-${T}`, headers, payload: { decision: "select" } });
  assert.equal(missing.statusCode, 404);

  assert.equal((await app.inject({ method: "POST", url: `/api/admin/gold/${id}`, headers, payload: { decision: "select", note: "该进" } })).statusCode, 200);

  const view = (await app.inject({ method: "GET", url: "/api/admin/gold?seed=5", headers })).json();
  assert.equal(view.board.labels.some((c: { caseId: string }) => c.caseId === id), true);
  assert.equal(view.report.labelled >= 1, true);
  assert.ok(Object.keys(view.board.thresholds).length >= 1);

  const sheet = await app.inject({ method: "GET", url: "/api/admin/gold/sheet", headers });
  assert.match(String(sheet.headers["content-type"]), /^application\/x-ndjson/);
  assert.match(String(sheet.headers["content-disposition"]), /attachment; filename="gold-all\.jsonl"/);
  const lines = sheet.payload.trim().split("\n").map((l) => JSON.parse(l) as { caseId: string; gold: { decision: string } });
  assert.deepEqual(lines.find((l) => l.caseId === id)!.gold, { decision: "select" });

  assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/gold/${id}`, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/gold/${id}`, headers })).statusCode, 404);
});
