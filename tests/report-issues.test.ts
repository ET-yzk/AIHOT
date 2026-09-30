// The periodical issues themselves (阶段一 1.5: 自动生成且期号连续): what one is called, that the
// schedule cannot fork an issue, and that an issue's own name is never served as its headline.
// An empty candidate window composes without a model call, so all of this stays offline.
// The index the site reads is cached for a minute, so every issue exists before the first read.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withSubject } from "@aihot/industry/site";
import { closeDb, sql } from "@aihot/backend/db";
import { composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";
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

const index = async (kind: "weekly" | "monthly") => {
  const res = await app.inject({ method: "GET", url: `/api/v1/reports/${kind}` });
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

const wipe = () => sql`DELETE FROM reports WHERE key IN (${WEEK}, ${PREV_WEEK}, ${LEGACY_WEEK}, ${MONTH})`;

before(async () => {
  await wipe();
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
  assert.equal(await storedTitle("weekly", WEEK), `${withSubject("周报")} · ${WEEK}`, "the period word comes from industry/site.ts, not from a string in the composer");
  assert.equal(await storedTitle("weekly", PREV_WEEK), `${withSubject("周报")} · ${PREV_WEEK}`);
  assert.equal(await storedTitle("monthly", MONTH), `${withSubject("月报")} · ${MONTH}`);
});

test("an issue name is an address, not a headline", async () => {
  assert.equal((await entry("weekly", WEEK)).headline, null, "the index must not advertise the issue's own name as its news");
  assert.equal((await entry("weekly", LEGACY_WEEK)).headline, null, "an issue stored under the old wording is still not a headline");
  assert.equal((await entry("monthly", MONTH)).headline, null);
});

test("composing the same week twice leaves one issue, with the earlier content kept as a revision", async () => {
  const [{ id }] = await sql<{ id: string }[]>`SELECT id FROM reports WHERE kind = 'weekly' AND key = ${PREV_WEEK}`;
  await composeWeekly(PREV_WEEK);
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
