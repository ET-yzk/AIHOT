// Reports: a scheduled run that starts late still writes the issue it was due for, never one whose
// window is still open; a window that saw no judgement at all is refused rather than printed as a quiet
// day, while a window the editors did judge but that yielded nothing publishable still gets its issue, led
// by the pack's quiet line; and an older weekly that froze no summaries shows the cited articles' public
// summaries.
import { editionAt, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { composeDaily, dueDaily, dueMonthly, dueWeekly } from "@aihot/backend/reports/compose";
import { REPORTS, SITE } from "@aihot/site";

const T = tag();
const SOURCE = `test-reports-${T}`;
const WEEK = "2098-W20";
after(async () => {
  await stopBoss();
  await closeDb();
});

test("a late run writes the issue that was due, not today's", () => {
  assert.equal(dueDaily(editionAt("daily", "2026-09-29", 6)), "2026-09-29");
  assert.equal(dueDaily(editionAt("daily", "2026-09-30", -60)), "2026-09-29", "the 29th's run delayed until just before the next issue");
  assert.equal(dueWeekly(editionAt("weekly", "2026-09-28")), "2026-W39");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", -60)), "2026-W39", "Monday before its edition time: the next week is not due yet");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", 60)), "2026-W40");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01")), "2026-09");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01", -60)), "2026-08");
  assert.equal(dueMonthly(editionAt("monthly", "2027-01-15")), "2026-12");
});

test("a daily whose window saw no judgement at all is refused, not published as a quiet day", async () => {
  const date = "2098-01-15";
  await assert.rejects(composeDaily(date), /no judgement ran/);
  const [row] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(row, undefined, "an outage window stays a failure the run catches up later, not a printed silence");
});

test("a daily judged in its window but with nothing publishable still gets its issue, led by the pack's quiet line", async () => {
  const date = "2098-01-16";
  const end = editionAt("daily", date);
  const quietSource = `${SOURCE}-quiet-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${quietSource}, 'Quiet desk', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // The desk's normal case: a document judged today whose own publication date is weeks older than the
  // window, so it is publishable material that simply does not belong to this issue.
  const { articleId } = await upsertMaterial({ sourceId: quietSource, url: `https://example.com/${T}-older`, title: `Older document ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date(end.getTime() - 40 * 86400000) });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, created_at)
            VALUES (${articleId}, 1, 'rule', 'pass', 'regulation', ${`安静标题-${T}`}, ${`安静摘要-${T}`}, 80, false, ${new Date(end.getTime() - 3600000)})`;
  await publishArticle(articleId);
  assert.deepEqual(await composeDaily(date), { key: date, entries: 0 }, "the quiet window composes without a model call");
  const [row] = await sql<{ lead: { title: string }; leadItemId: string | null; judged: string }[]>`
    SELECT content -> 'lead' AS lead, content ->> 'leadItemId' AS "leadItemId",
           content -> 'generator' ->> 'judgedInWindow' AS judged
    FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(row!.lead.title, REPORTS.quiet.title, "the lead says so in the pack's words, not a string in the composer");
  assert.equal(row!.leadItemId, null);
  assert.ok(Number(row!.judged) >= 1, "what let the issue through is the judgement, not publishability");
});

test("a weekly that froze no summaries shows the articles' public summaries", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Reports', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}`, title: `R ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题-${T}`}, ${`公开摘要-${T}`}, 80, true)`;
  await publishArticle(articleId, { releasedAt: new Date() });
  const content = { kind: "weekly", title: `${SITE.name} 周报 · ${WEEK}`, overview: "o", themes: [{ heading: "h", summary: "s", storyRefs: [{ itemId: articleId, title: `标题-${T}`, sourceName: "Old aggregator", sourceId: "old-source", firstParty: false, sourceUrl: "https://example.com" }] }] };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('weekly', ${WEEK}, now(), now(), ${sql.json(content as never)}, now(), 'imported')`;
  const report = await loadReport("weekly", WEEK);
  assert.equal(report?.sections[0]?.items[0]?.summary, `公开摘要-${T}`);
  assert.equal(report?.sections[0]?.items[0]?.sourceName, "Reports");
  assert.equal(report?.sections[0]?.items[0]?.firstParty, true, "a frozen citation cannot override verified current provenance");
  await sql`UPDATE sources SET tier = 'T1_5', first_party = true WHERE id = ${SOURCE}`;
  await publishArticle(articleId);
  assert.equal((await loadReport("weekly", WEEK))?.sections[0]?.items[0]?.firstParty, false);
});
