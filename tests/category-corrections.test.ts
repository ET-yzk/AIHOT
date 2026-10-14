// Failure cases: a benchmark, price change, tool or follow-up is counted as a launch; a category
// correction leaves frozen daily/weekly/monthly columns stale, rewrites the lead or selection, triggers
// a paid digest, leaves an obsolete section introduction, or commits without its audit/revision.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { overrideFields } from "@aihot/backend/admin/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { CATEGORIES, RELEASE } from "@aihot/industry/taxonomy";
import { dailyMetrics } from "@aihot/backend/reports/compose";
import { sectionOf } from "@aihot/backend/reports/edition";
import type { EditionEntry } from "@aihot/backend/reports/edition";
import { QUEUES, getBoss, stopBoss } from "@aihot/backend/jobs/queue";

after(async () => { await stopBoss(); await closeDb(); });

/** The pack's headline launch kind; this pack declares none, so the rows below use its launch category and tag. */
const LAUNCH = RELEASE ?? { category: "vehicle", tag: "新车发布", unit: "款" };
/** A category of the pack that is not the launch kind: where the correction moves the item out to. */
const ELSEWHERE = CATEGORIES.find((c) => c.key !== LAUNCH.category)!.key;
/** The figure dailyMetrics and the correction path report only while the pack declares one. */
const releaseFigure = (metrics: Record<string, number | undefined>) => ({ ...metrics, ...(RELEASE ? { modelsReleased: 0 } : {}) });

test("a launch is counted only with the pack's release classification and an official, new event", () => {
  const base = { category: LAUNCH.category, tags: [LAUNCH.tag], authority: 0, previous: null,
    entry: { sourceId: "official", firstParty: true } } as EditionEntry;
  const rows = [base, { ...base, tags: ["测评结果"] }, { ...base, tags: ["技术落地"] },
    { ...base, category: ELSEWHERE }, { ...base, authority: 3 },
    { ...base, previous: { key: "2026-09-30", title: "已报过的发布" } }, { ...base, tags: [] }];
  assert.equal(dailyMetrics(rows).totalEvents, 7);
  if (!RELEASE) {
    assert.ok(!("modelsReleased" in dailyMetrics(rows)), "a pack without a headline launch kind reports no such figure");
    return;
  }
  assert.equal(dailyMetrics(rows).modelsReleased, 1);
});

test("category corrections revise every standard report atomically without selecting, rewriting or notifying", async () => {
  await getBoss(); // the digest check below reads the job table
  const sourceId = `category-${tag()}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${sourceId},'Category fixture','rss','T1','editorial')`;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.com/${sourceId}`, title: "开源推理工具", bodyText: "工具正文", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,tags,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass',${LAUNCH.category},${[LAUNCH.tag, "工信部"]},'开源推理工具','冻结摘要',88,true)`;
  const [story] = await sql`INSERT INTO stories (public_id,title) VALUES (gen_random_uuid(),'工具事件') RETURNING id`;
  const [fact] = await sql`INSERT INTO facts (public_id,title,story_id) VALUES (${`f-${tag()}`},'工具发布',${story!.id}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${articleId},'report')`;
  await publishArticle(articleId, { releasedAt: new Date() });
  const entry = { itemId: articleId, title: "冻结标题", summary: "冻结摘要", sourceId, firstParty: true, role: "官方" };
  const contents = [
    { kind: "daily", key: "2097-01-02", content: { leadItemId: articleId, lead: { title: "冻结头条" }, highlights: [articleId], flashes: [], sections: [{ label: sectionOf(LAUNCH.category), items: [entry] }], metrics: { totalEvents: 1, ...(RELEASE ? { modelsReleased: 1 } : {}) } } },
    ...(["weekly", "monthly"] as const).map(kind => ({ kind, key: kind === "weekly" ? "2097-W01" : "2097-01", content: { headline: "冻结头条", leadItemId: articleId, storyOrder: [articleId], overview: "保留总述", themes: [{ heading: sectionOf(LAUNCH.category), summary: "旧期导读", storyRefs: [entry] }], metrics: { totalStories: 1 } } })),
  ];
  for (const r of contents) await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,origin)
    VALUES (${r.kind},${r.key},now(),now(),${sql.json(r.content as never)},now(),'imported')`;
  const [before] = await sql`SELECT selected,seat,score,visible_after,selected_ready_at FROM publications WHERE article_id=${articleId}`;
  const change = (actor: string) => overrideFields(articleId, { fields: { category: ELSEWHERE, tags: ["合规/认证", "工信部"] }, version: 0, reason: "工具不是新车型" }, actor);
  await sql.unsafe(`CREATE FUNCTION reject_category_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.actor = 'reject-category' THEN RAISE EXCEPTION 'category audit rejected'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_category_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_category_audit()");
  try {
    await assert.rejects(change("reject-category"), /category audit rejected/);
    assert.equal((await sql`SELECT category FROM publications WHERE article_id=${articleId}`)[0]!.category, LAUNCH.category);
    assert.equal((await sql`SELECT 1 FROM report_revisions WHERE report_id IN (SELECT id FROM reports WHERE key IN ('2097-01-02','2097-W01','2097-01'))`).length, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER reject_category_audit ON audit_log; DROP FUNCTION reject_category_audit()");
  }
  const digestCount = (await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.digest}`)[0]!.n;
  await change("test-category");
  for (const r of contents) {
    const [saved] = await sql`SELECT content,revision FROM reports WHERE kind=${r.kind} AND key=${r.key}`;
    assert.equal(saved!.revision, 2);
    const c = saved!.content;
    assert.equal(c.leadItemId, articleId);
    if (r.kind === "daily") {
      assert.deepEqual(c.sections, [{ label: sectionOf(ELSEWHERE), items: [entry] }]);
      assert.deepEqual(c.metrics, releaseFigure({ totalEvents: 1 }));
      assert.deepEqual(c.highlights, [articleId]);
      assert.equal(c.lead.title, "冻结头条");
    } else {
      assert.deepEqual(c.themes, [{ heading: sectionOf(ELSEWHERE), summary: null, storyRefs: [entry] }]);
      assert.deepEqual(c.storyOrder, [articleId]);
      assert.equal(c.overview, "保留总述");
    }
  }
  assert.deepEqual((await sql`SELECT selected,seat,score,visible_after,selected_ready_at FROM publications WHERE article_id=${articleId}`)[0], before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.digest}`)[0]!.n, digestCount);
  await overrideFields(articleId, { fields: {}, clear: ["category", "tags"], version: 1, reason: "验证撤销纠错" }, "test-category");
  const [restored] = await sql`SELECT content FROM reports WHERE kind='daily' AND key='2097-01-02'`;
  // Clearing the override restores the row's own classification, so the item goes back to the launch
  // section — the fallback section would mean the article ended up uncategorized, which is not what
  // an undo does (upstream wrote this literal as its own pack's launch section).
  assert.equal(restored!.content.sections[0].label, sectionOf(LAUNCH.category));
  assert.deepEqual(restored!.content.metrics, releaseFigure({ totalEvents: 1 }));
});
