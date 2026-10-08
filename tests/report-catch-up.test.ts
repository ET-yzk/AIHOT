// Catch-up is what keeps 期号连续: a run that was missed is filled in, an issue that exists is left
// alone, and nothing is written for a day that has not come yet. Empty windows compose without a
// model call, so the whole rule is checkable offline against a clock the test picks.
// The archive's own lower bound is `min(key) over dailies`, so this file owns that set: it clears
// dailies before it starts and deletes everything it wrote when it finishes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { catchUpReports } from "@aihot/backend/reports/compose";
import { stopBoss } from "@aihot/backend/jobs/queue";

// 2097-03-15 02:30Z is 10:30 Beijing on a Saturday: the day's own report is due, last week's and
// February's are complete. 2097-03-14 23:30Z is 07:30 Beijing on that same Saturday — before the
// 08:00 daily, so 03-15 must not be written.
const AFTER_DAILY = new Date("2097-03-15T02:30:00Z");
const BEFORE_DAILY = new Date("2097-03-14T23:30:00Z");
const DAILIES = ["2097-03-13", "2097-03-14", "2097-03-15"];
const WEEK = "2097-W10";
const MONTH = "2097-02";

const dailyKeys = async () => (await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind = 'daily' ORDER BY key`).map((r) => r.key);
const keyCount = async (kind: "daily" | "weekly" | "monthly", key: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM reports WHERE kind = ${kind} AND key = ${key}`)[0].n;

before(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily'`;
  await sql`DELETE FROM reports WHERE key IN (${WEEK}, ${MONTH})`;
});

after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily'`;
  await sql`DELETE FROM reports WHERE key IN (${WEEK}, ${MONTH})`;
  await stopBoss();
  await closeDb();
});

const clearDailies = async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily'`;
};

test("a missed stretch is generated in one run: the days, the last complete week and the last complete month", async () => {
  const { generated } = await catchUpReports(AFTER_DAILY, 3);
  assert.deepEqual(generated, DAILIES.map((d) => `daily:${d}`).concat([`weekly:${WEEK}`, `monthly:${MONTH}`]));
  assert.deepEqual(await dailyKeys(), DAILIES);
  assert.equal(await keyCount("weekly", WEEK), 1);
  assert.equal(await keyCount("monthly", MONTH), 1);
});

test("a second run over the same clock generates nothing", async () => {
  const { generated } = await catchUpReports(AFTER_DAILY, 3);
  assert.deepEqual(generated, [], "continuous numbering means the schedule cannot fork an issue that already exists");
});

test("an issue a person wrote by hand is left alone, and only the gap is refilled", async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = '2097-03-15'`;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', '2097-03-15', '2097-03-14', '2097-03-15', ${sql.json({ date: "2097-03-15", sections: [] } as never)}, now(), 'manual')`;
  const { generated } = await catchUpReports(AFTER_DAILY, 3);
  assert.deepEqual(generated, [], "nothing is missing, so nothing is written");
  const kept = await sql<{ origin: string; revision: number }[]>`SELECT origin, revision FROM reports WHERE kind = 'daily' AND key = '2097-03-15'`;
  assert.deepEqual(kept[0], { origin: "manual", revision: 1 }, "the hand-written issue was not taken over");

  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = '2097-03-14'`;
  const again = await catchUpReports(AFTER_DAILY, 3);
  assert.deepEqual(again.generated, ["daily:2097-03-14"], "the one missing day inside the archive comes back");
});

test("the day whose report is not due yet stays unwritten", async () => {
  await clearDailies();
  // The week and month catch-up points are already due at 07:30 and already filed, so whatever this
  // run generates is a daily — and the one for the day itself must not be among them.
  const { generated } = await catchUpReports(BEFORE_DAILY, 3);
  assert.deepEqual(generated, ["daily:2097-03-12", "daily:2097-03-13", "daily:2097-03-14"]);
  assert.equal((await dailyKeys()).includes("2097-03-15"), false, "07:30 Beijing is before the 08:00 daily");
});

test("it does not backfill further back than the first issue the archive has", async () => {
  const { generated } = await catchUpReports(AFTER_DAILY, 20);
  assert.deepEqual(generated, ["daily:2097-03-15"], "the archive begins at 03-12, so the earlier days are not invented");
  assert.equal((await dailyKeys()).some((k) => k < "2097-03-12"), false);
});
