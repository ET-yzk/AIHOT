// The query that finds every date still ahead within the 90-day horizon.
// The daily no longer carries a countdown block (S0 withdrawal, 2026-10-10);
// the same query will serve the regulation page's countdown section (S5).
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upcomingDates } from "../server.ts";
import regulation from "../server.ts";

const T = tag();
installModules([regulation]);

after(async () => {
  await sql`DELETE FROM regulation_schedule WHERE code LIKE ${`${T}%`}`;
  await stopBoss();
  await closeDb();
});

async function track(code: string, title: string, effective: string | null, deadline: string | null): Promise<void> {
  await sql`INSERT INTO regulation_schedule (code, title, effective_on, comment_deadline)
            VALUES (${code}, ${title}, ${effective}, ${deadline}) ON CONFLICT (code) DO NOTHING`;
}

test("upcomingDates names every date still ahead within the horizon, soonest first", async () => {
  const from = new Date("2030-06-10T08:00:00+08:00");
  await track(`${T}-soon`, `${T}  soon`, "2030-06-20", null);
  await track(`${T}-far`, `${T}  far`, "2030-12-01", null);
  await track(`${T}-past`, `${T}  past`, "2030-06-01", null);
  await track(`${T}-both`, `${T}  both`, "2030-07-01", "2030-06-15");

  const rows = await upcomingDates(from);
  assert.deepEqual(rows.map((r) => [r.title.replace(`${T}  `, ""), r.what, r.days]), [
    ["both", "意见反馈截止", 5],
    ["soon", "实施", 10],
    ["both", "实施", 21],
  ]);
  assert.equal(rows.every((r) => r.days >= 1 && r.days <= 90), true, "only a date inside the horizon, and only still ahead");
  assert.equal(rows.some((r) => r.title.includes("past")), false, "a date already passed is not a countdown");
});
