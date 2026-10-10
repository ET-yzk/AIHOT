// The regulation module's own coverage: the dates the daily counts down to, and what an issue keeps of them.
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composeDaily } from "@aihot/backend/reports/compose";
import { citedIn, SECTION_ORDER } from "@aihot/backend/reports/edition";
import { publishArticle } from "@aihot/backend/publication/publish";
import regulation from "../server.ts";

const T = tag();
installModules([regulation]);
const SOURCE = `test-regulation-${T}`;

after(async () => {
  await sql`DELETE FROM regulation_schedule WHERE code LIKE ${`${T}%`}`;
  // Publishing a report touches the job queue; without stopping it the process never exits.
  await stopBoss();
  await closeDb();
});

async function track(code: string, title: string, effective: string | null, deadline: string | null): Promise<void> {
  await sql`INSERT INTO regulation_schedule (code, title, effective_on, comment_deadline)
            VALUES (${code}, ${title}, ${effective}, ${deadline}) ON CONFLICT (code) DO NOTHING`;
}

test("the countdown names every date still ahead within the horizon, soonest first", async () => {
  const from = new Date("2030-06-10T08:00:00+08:00");
  await track(`${T}-soon`, `${T}  soon`, "2030-06-20", null);
  await track(`${T}-far`, `${T}  far`, "2030-12-01", null); // beyond 90 days
  await track(`${T}-past`, `${T}  past`, "2030-06-01", null); // already in force
  await track(`${T}-both`, `${T}  both`, "2030-07-01", "2030-06-15");

  const items = await regulation.reportBlocks!({ end: from });
  const rows = items[0]!.items;
  assert.deepEqual(rows.map((r) => [r.title.replace(`${T}  `, ""), r.what, r.days]), [
    ["both", "意见反馈截止", 5],
    ["soon", "实施", 10],
    ["both", "实施", 21],
  ]);
  assert.equal(items[0]!.label, "实施倒计时");
  assert.equal(rows.every((r) => r.days >= 1 && r.days <= 90), true, "only a date inside the horizon, and only still ahead");
  assert.equal(rows.some((r) => r.title.includes("past")), false, "a date already passed is not a countdown");
});

/** The issue as the reader's API reads it: the frozen blocks and the lines for the blocks with nothing to say. */
async function edition(key: string) {
  const [row] = await sql<{ content: { blocks: Array<{ label: string; items: Array<{ on: string; what: string; days: number }>; empty?: string }>; silence: string[]; sections: Array<{ label: string }> } }[]>`
    SELECT content FROM reports WHERE kind = 'daily' AND key = ${key}`;
  return row!.content;
}

test("an issue freezes the dates it saw, and a block with nothing to say leaves one line", async () => {
  const date = "2030-06-11";
  const end = new Date(`${date}T08:00:00+08:00`);
  await sql`DELETE FROM regulation_schedule WHERE code LIKE ${`${T}%`}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Regulation test', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await track(`${T}-consult`, `${T}  征求意见`, "2030-06-25", "2030-06-13");
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://example.com/regulation-countdown-${T}`,
    title: `Countdown ${T}`,
    bodyText: `Countdown ${T} body`,
    bodyStatus: "ok",
    publishedAt: new Date(end.getTime() - 3600_000),
    discoveredAt: new Date(end.getTime() - 3600_000),
    via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'regulation', ${`标题 ${T}`}, ${`摘要 ${T}`}, 90, true)`;
  // An issue carries only reports whose identity decision is finished; that is the article's own state, not the module's.
  await sql`UPDATE articles SET grouping_status = 'complete', grouped_at = ${new Date(end.getTime() - 3600_000)} WHERE id = ${articleId}`;
  const released = await publishArticle(articleId, { now: new Date(end.getTime() - 1800_000) });
  assert.equal(released?.selected, true, "the premise: this issue has one selected report to carry");

  assert.equal((await composeDaily(date)).entries > 0, true);
  const issue = await edition(date);
  assert.deepEqual(issue.blocks.map((b) => b.label), ["实施倒计时"]);
  assert.deepEqual(issue.blocks[0]!.items.map((i) => [i.on, i.what, i.days]), [["2030-06-13", "意见反馈截止", 2], ["2030-06-25", "实施", 14]]);
  // The sections this issue did not carry say so in the pack's own sentence, and the countdown did not need to.
  const quiet = SECTION_ORDER.filter((label) => !issue.sections.some((s) => s.label === label));
  assert.equal(issue.silence.length, quiet.length, "one line per block this issue had nothing under");
  for (const label of quiet) {
    assert.equal(issue.silence.some((line) => line.includes(label)), true, `${label} is named in its own line`);
  }
  assert.equal(issue.silence.some((line) => line.includes("临近的实施日期")), false);
  // A countdown row is not an event: nothing that reads an issue's citations may pick it up (dailyMemory, correct.ts).
  const cited = citedIn(issue);
  assert.equal(cited.length > 0, true);
  assert.equal(cited.some((it) => "days" in it || "what" in it), false);

  // Frozen with the edition: editing the schedule afterwards does not rewrite an issue already published.
  await sql`UPDATE regulation_schedule SET effective_on = '2031-01-01' WHERE code = ${`${T}-consult`}`;
  assert.deepEqual((await edition(date)).blocks[0]!.items.map((i) => i.on), ["2030-06-13", "2030-06-25"]);

  // With nothing coming up the block is not printed empty; the module's own line says so (FR-02-05, BR-20).
  await sql`DELETE FROM regulation_schedule WHERE code = ${`${T}-consult`}`;
  await composeDaily(date, "test: the schedule emptied");
  const empty = await edition(date);
  assert.deepEqual(empty.blocks, []);
  const [{ empty: line }] = await regulation.reportBlocks!({ end });
  assert.equal(empty.silence.includes(line), true);
});
