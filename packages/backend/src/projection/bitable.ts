// The Feishu table mirror of the portal's front page (CT-4, DES §6.4) — the migration-period report view.
// One way: Postgres out, never back. Nothing in the platform reads the table, so there is no conflict to
// resolve; the table may lag the portal by one cycle, the portal never lags it. Every value comes from the
// public read layer, so the table cannot carry a row the portal does not show.
//
// upsert_preserve, in both directions:
//   - a cell this job has no value for is left out of the request rather than sent empty, so a person's own
//     notes in the table survive a projection cycle;
//   - the cells this job owns are written from the portal, and a row the portal has dropped has them cleared
//     and marked withdrawn — a withdrawal reaches every exit, and a mirror is an exit.
//
// Idempotent: each row's cells are hashed, and a row whose hash already matches is not sent, so a quiet
// quarter of an hour makes no API call at all. FEISHU_BITABLE_ENABLED is the valve: off (the default) the
// plan is computed and reported without any HTTP.
import { createHash } from "node:crypto";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import type { V1ItemPayload } from "../publication/publish.ts";
import { v1Items } from "../publication/v1.ts";
import { API, tenantToken } from "../notify/feishu.ts";

export const PROJECTION_JOB = "portal-items";
/** The portal's own reach: the table mirrors the selected items its front page can still show. */
const PAGE_LIMIT = 200;
const MAX_ROWS = 1000;
const CREATE_BATCH = 50;

/** The cells this job writes; a date cell is epoch milliseconds, which is what a Bitable date column takes. */
type Cells = Record<string, string | number>;

function cellsOf(item: V1ItemPayload): Cells {
  const cells: Cells = { 标题: item.title, 状态: "在门户", 门户链接: item.links.portal };
  if (item.summary) cells.摘要 = item.summary;
  if (item.category) cells.分类 = item.category;
  if (item.source.name) cells.信源 = item.source.name;
  if (item.score !== null) cells.评分 = item.score;
  if (item.publishedAt) cells.发布时间 = Date.parse(item.publishedAt);
  if (item.links.original) cells.原文链接 = item.links.original;
  return cells;
}

const WITHDRAWN: Cells = { 状态: "已撤下", 摘要: "", 门户链接: "", 原文链接: "" };

/** Over the cells this job owns, in a stable order: a note in the table is not our hash to take. */
const hashOf = (cells: Cells) => createHash("sha256").update(JSON.stringify(Object.entries(cells).sort())).digest("hex").slice(0, 16);

interface Planned {
  key: string;
  cells: Cells;
  token: string | null;
}

async function call<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${await tenantToken()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { code: number; msg?: string; data?: T };
  if (json.code !== 0) throw new Error(`feishu bitable ${method}: ${json.msg ?? `code ${json.code}`}`);
  return json.data as T;
}

/** The app and table are the operator's; the columns this job writes are named above. */
const tablePath = (target: { app: string; table: string }, suffix = "") =>
  `/bitable/v1/apps/${target.app}/tables/${target.table}/records${suffix}`;

/** The rows the portal shows now, in the portal's own order. */
async function portalRows(now: Date): Promise<V1ItemPayload[]> {
  const rows: V1ItemPayload[] = [];
  let cursor: string | null = null;
  do {
    const page = await v1Items({ mode: "selected", window: "7d", by: "timeline", category: null, q: null, limit: PAGE_LIMIT, cursor }, now);
    rows.push(...page.items);
    cursor = page.page.nextCursor;
  } while (cursor && rows.length < MAX_ROWS);
  return rows.slice(0, MAX_ROWS);
}

export interface ProjectionResult {
  status: "sent" | "disabled" | "unconfigured" | "failed";
  portal: number;
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  error?: string;
}

/** One cycle. Safe to run every few minutes: a row that has not changed is not sent again. */
export async function projectPortalRows(now = new Date()): Promise<ProjectionResult> {
  const items = await portalRows(now);
  const seen = await sql<{ entity_key: string; row_hash: string; row_token: string }[]>`
    SELECT entity_key, row_hash, row_token FROM projection_rows WHERE job = ${PROJECTION_JOB}`;
  const known = new Map(seen.map((r) => [r.entity_key, r]));

  const plan: Planned[] = [];
  let unchanged = 0;
  for (const item of items) {
    const cells = cellsOf(item);
    const prior = known.get(item.id);
    if (prior && prior.row_hash === hashOf(cells)) unchanged += 1;
    else plan.push({ key: item.id, cells, token: prior?.row_token ?? null });
  }
  // A row the portal dropped was withdrawn or fell out of its window: say so, once, on its own hash.
  let withdrawn = 0;
  const live = new Set(items.map((i) => i.id));
  for (const [key, row] of known) {
    if (live.has(key) || row.row_hash === hashOf(WITHDRAWN)) continue;
    plan.push({ key, cells: WITHDRAWN, token: row.row_token });
    withdrawn += 1;
  }

  const created = plan.filter((p) => !p.token).length;
  const base = { portal: items.length, created, updated: plan.length - created, unchanged, withdrawn };
  // The switch is a deliberate choice, so it answers before a missing credential does.
  if (!config.feishuBitableEnabled) return { status: "disabled", ...base };
  const app = credential("integrations", "FEISHU_BITABLE_APP_TOKEN");
  const table = credential("integrations", "FEISHU_BITABLE_TABLE_ID");
  if (!app || !table) return { status: "unconfigured", ...base };
  const target = { app, table };
  if (!plan.length) return { status: "sent", ...base };

  try {
    for (const fresh of chunks(plan.filter((p) => !p.token), CREATE_BATCH)) {
      const data = await call<{ records: Array<{ record_id: string }> }>(tablePath(target, "/batch_create"), "POST", { records: fresh.map((c) => ({ fields: c.cells })) });
      for (const [n, record] of data.records.entries()) await remember(fresh[n]!.key, record.record_id, hashOf(fresh[n]!.cells));
    }
    for (const change of plan.filter((p) => p.token)) {
      await call<unknown>(tablePath(target, `/${change.token}`), "PUT", { fields: change.cells });
      await remember(change.key, change.token!, hashOf(change.cells));
    }
    return { status: "sent", ...base };
  } catch (error) {
    return { status: "failed", ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

const chunks = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
};

async function remember(entityKey: string, rowToken: string, rowHash: string) {
  await sql`
    INSERT INTO projection_rows (job, entity_key, row_token, row_hash, projected_at)
    VALUES (${PROJECTION_JOB}, ${entityKey}, ${rowToken}, ${rowHash}, now())
    ON CONFLICT (job, entity_key) DO UPDATE SET row_token = EXCLUDED.row_token, row_hash = EXCLUDED.row_hash, projected_at = now()`;
}
