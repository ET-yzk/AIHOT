// The periodical issues themselves (阶段一 1.5: 自动生成且期号连续): what one is called, that the
// schedule cannot fork an issue, and that an issue's own name is never served as its headline.
// An empty candidate window composes without a model call, so all of this stays offline.
// The index the site reads is cached for a minute, so every issue exists before the first read.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { REPORTS, withSubject } from "@aihot/site";
import { closeDb, sql } from "@aihot/backend/db";
import { composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
import { addDays, isoWeekRange, monthRange } from "@aihot/contracts/time";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
// A far-past week, the week before it, and a month: nothing outside this file will be named 2097-W30.
const WEEK = "2097-W30";
const PREV_WEEK = "2097-W29";
const LEGACY_WEEK = "2096-W01";
const MONTH = "2097-06";
const app = await buildApp();

// The public v1 names for the two indexes (upstream retired /api/v1/reports/{kind}).
const INDEX_PATH = { weekly: "/api/v1/weeklies", monthly: "/api/v1/monthlies" } as const;
const index = async (kind: "weekly" | "monthly") => {
  const res = await app.inject({ method: "GET", url: INDEX_PATH[kind] });
  assert.equal(res.statusCode, 200, `the ${kind} index answered ${res.statusCode}`);
  return JSON.parse(res.body) as { items: Array<{ key: string; headline: string | null }> };
};

const entry = async (kind: "weekly" | "monthly", key: string) => {
  const found = (await index(kind)).items.find((i) => i.key === key);
  assert.ok(found, `${key} is listed among the ${kind} issues`);
  return found;
};

const storedTitle = async (kind: "weekly" | "monthly", key: string) => {
  const rows = await sql<{ content: { title: string } }[]>`SELECT content FROM reports WHERE kind = ${kind} AND key = ${key}`;
  assert.equal(rows.length, 1, `exactly one ${kind} issue is stored for ${key}`);
  return rows[0].content.title;
};

const storedOverview = async (kind: "weekly" | "monthly", key: string) => {
  const rows = await sql<{ content: { overview: string | null } }[]>`SELECT content FROM reports WHERE kind = ${kind} AND key = ${key}`;
  assert.equal(rows.length, 1, `exactly one ${kind} issue is stored for ${key}`);
  return rows[0].content.overview;
};

/** Fragments of a pack sentence that carry no placeholder — the wording a reader sees between the two window ends. */
const packFragments = (template: string) => template.split(/\{start\}|\{end\}/).filter((f) => f.length > 0);

/**
 * Dailies that exist but carried nothing — the shape of a quiet period on this desk (§49). A period
 * without any daily at all is an outage and still fails, so these are what makes the quiet case real.
 */
async function quietDailies(start: string, end: string) {
  const keys: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    keys.push(date);
    await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
              VALUES ('daily', ${date}, ${date}, ${date},
                      ${sql.json({ date, leadItemId: null, highlights: [], sections: [], flashes: [], blocks: [] } as never)}, now(), 'manual')`;
  }
  return keys;
}

const seeded: string[] = [];

const wipe = async () => {
  await sql`DELETE FROM reports WHERE key IN (${WEEK}, ${PREV_WEEK}, ${LEGACY_WEEK}, ${MONTH})`;
  // One delete per seeded day: the wrapped sql instance this file uses has no join helper.
  for (const day of seeded) await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${day}`;
  seeded.length = 0;
};

before(async () => {
  await wipe();
  const week = isoWeekRange(WEEK)!;
  const prev = isoWeekRange(PREV_WEEK)!;
  const month = monthRange(MONTH)!;
  for (const range of [week, prev, month]) seeded.push(...(await quietDailies(range.start, range.end)));
  await composeWeekly(WEEK);
  await composeWeekly(PREV_WEEK);
  await composeMonthly(MONTH);
  // An issue titled the way the composer wrote it before the period word came from the pack.
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('weekly', ${LEGACY_WEEK}, '2096-01-01', '2096-01-08',
                    ${sql.json({ title: `RegWatch · 车载行业动态 周报 · ${LEGACY_WEEK}`, themes: [] } as never)}, now(), 'manual')`;
});

after(async () => {
  await wipe();
  await app.close();
  await stopBoss();
  await closeDb();
});

test("an issue with nothing to say is still composed, and calls itself what the pack calls the period", async () => {
  const composed = await composeWeekly(WEEK);
  assert.deepEqual(composed, { key: WEEK, entries: 0 }, "the empty window composes without a model call");
  assert.equal(await storedTitle("weekly", WEEK), `${withSubject("周报")} · ${WEEK}`, "the period word comes from site/site.ts, not from a string in the composer");
  assert.equal(await storedTitle("weekly", PREV_WEEK), `${withSubject("周报")} · ${PREV_WEEK}`);
  assert.equal(await storedTitle("monthly", MONTH), `${withSubject("月报")} · ${MONTH}`);
});

/**
 * `compose.ts:255` reads `REPORTS.quiet[kind].paragraph` to write a quiet issue's overview. Until
 * 2026-10-14 the weekly and monthly entries were the same string, so that kind lookup was invisible
 * from the outside — a bug that hardcoded the wrong kind (or dropped the branch entirely) would still
 * produce byte-identical overviews. Once site/site.ts splits them, this is the credential.
 * Fragments come from the pack at test time, so rewording the sentences in site/site.ts keeps this green.
 */
test("a quiet issue takes the pack sentence for its own kind — the kind lookup is not silently swappable", async () => {
  const weeklyTemplate = REPORTS.quiet.weekly.paragraph;
  const monthlyTemplate = REPORTS.quiet.monthly.paragraph;
  assert.notEqual(weeklyTemplate, monthlyTemplate,
    "REPORTS.quiet.weekly and REPORTS.quiet.monthly must be different sentences; while they match, kind-branch at compose.ts:255 is untestable from the stored content");

  const weekly = await storedOverview("weekly", WEEK);
  const monthly = await storedOverview("monthly", MONTH);
  assert.ok(weekly, "the composed quiet week carries an overview from the pack");
  assert.ok(monthly, "the composed quiet month carries an overview from the pack");

  const weeklyFragments = packFragments(weeklyTemplate);
  const monthlyFragments = packFragments(monthlyTemplate);
  const weeklyOnly = weeklyFragments.filter((f) => !monthlyTemplate.includes(f));
  const monthlyOnly = monthlyFragments.filter((f) => !weeklyTemplate.includes(f));
  assert.ok(weeklyOnly.length > 0 && monthlyOnly.length > 0,
    "each kind must contribute at least one fragment that the other's template does not contain, else this test checks nothing");

  for (const fragment of weeklyFragments) {
    assert.ok(weekly!.includes(fragment), `the week's overview carries the weekly pack fragment "${fragment}"`);
  }
  for (const fragment of monthlyFragments) {
    assert.ok(monthly!.includes(fragment), `the month's overview carries the monthly pack fragment "${fragment}"`);
  }
  for (const fragment of weeklyOnly) {
    assert.ok(!monthly!.includes(fragment),
      `the month's overview does NOT carry the week-only fragment "${fragment}" — compose.ts:255 pulled from the right kind`);
  }
  for (const fragment of monthlyOnly) {
    assert.ok(!weekly!.includes(fragment),
      `the week's overview does NOT carry the month-only fragment "${fragment}"`);
  }
});

test("an issue name is an address, not a headline", async () => {
  assert.equal((await entry("weekly", WEEK)).headline, null, "the index must not advertise the issue's own name as its news");
  assert.equal((await entry("weekly", LEGACY_WEEK)).headline, null, "an issue stored under the old wording is still not a headline");
  assert.equal((await entry("monthly", MONTH)).headline, null);
});

test("composing the same week twice leaves one issue, with the earlier content kept as a revision", async () => {
  const [{ id }] = await sql<{ id: string }[]>`SELECT id FROM reports WHERE kind = 'weekly' AND key = ${PREV_WEEK}`;
  await composeWeekly(PREV_WEEK, "editor correction");
  const rows = await sql<{ revision: number }[]>`SELECT revision FROM reports WHERE kind = 'weekly' AND key = ${PREV_WEEK}`;
  assert.equal(rows.length, 1, "a re-run is not a second issue of the same week");
  assert.equal(rows[0].revision, 2);
  const kept = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM report_revisions WHERE report_id = ${id}`;
  assert.equal(kept[0].n, 1, `the overwritten content of ${PREV_WEEK} is kept (${T})`);
});

test("adjacent issues are listed in period order, newest first", async () => {
  const weeks = (await index("weekly")).items.map((i) => i.key).filter((k) => k === WEEK || k === PREV_WEEK || k === LEGACY_WEEK);
  assert.deepEqual(weeks, [WEEK, PREV_WEEK, LEGACY_WEEK], "the period order is the key order");
});
