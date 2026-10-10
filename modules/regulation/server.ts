// What the regulation module hands the backend (docs/architecture.md 的「模块」一节：插口不够用时在框架里
// 加一个通用插口，而不是把功能写进框架). The daily no longer carries a countdown block (S0, 2026-10-10);
// `upcomingDates` is kept for the regulation page's countdown section (S5).
import { sql } from "@aihot/backend/db";
import type { ReportBlock, ServerModule } from "@aihot/backend/modules";

/** S-C5: the reader is planning the next year, so a date further off than this is not a reminder. */
const HORIZON_DAYS = 90;

interface Upcoming {
  code: string;
  title: string;
  what: string;
  on_date: string;
  days: number;
  source_url: string | null;
}

/**
 * Every date still ahead within the horizon, soonest first — one row per date, so a consultation whose
 * deadline closes next week and whose text takes effect next year appears twice, which is what the reader
 * has to act on twice. Dates come only from `regulation_schedule`: hand-checked, never model-extracted.
 * The column is `on_date` because `on` is reserved in SQL; the block's own field stays `on`.
 */
export async function upcomingDates(from: Date): Promise<ReportBlock["items"]> {
  const rows = await sql<Upcoming[]>`
    SELECT * FROM (
      SELECT code, title, source_url, '实施' AS what, effective_on::text AS on_date,
             (effective_on - ${from}::date)::int AS days
      FROM regulation_schedule
      WHERE effective_on > ${from}::date AND effective_on <= ${from}::date + make_interval(days => ${HORIZON_DAYS})
      UNION ALL
      SELECT code, title, source_url, '意见反馈截止', comment_deadline::text,
             (comment_deadline - ${from}::date)::int
      FROM regulation_schedule
      WHERE comment_deadline > ${from}::date AND comment_deadline <= ${from}::date + make_interval(days => ${HORIZON_DAYS})
    ) coming_up
    ORDER BY on_date, code`;
  return rows.map((r) => ({ title: r.title, what: r.what, on: r.on_date, days: r.days, url: r.source_url }));
}

export default {
  name: "regulation",
  reportBlocks: async () => [],
} satisfies ServerModule;
