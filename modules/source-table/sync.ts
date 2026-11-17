// Feishu 多维表格「信源表_v2.0」→ Postgres 的入站镜像 (docs/implement/source-table/03-实现方案.md §3).
// The module's only file that makes an external request: pages and /api/site/source-table read
// source_table_rows and never call Feishu. A run either replaces every row or changes nothing.
import { beijingDate } from "@aihot/contracts/time";
import { config, credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";

const FEISHU_API = "https://open.feishu.cn/open-apis";
const PAGE_SIZE = 500;
/** A full table is 104 rows; anything past this means the id points at something else. */
const MAX_ROWS = 5000;
const WATERMARK_KEY = "source_table.sync";
const LOCK_KEY = "source-table.sync";
const RUNS_KEPT = 5;

export type SourceTableSyncStatus = "ok" | "failed" | "never" | "disabled" | "unconfigured";

export interface SourceTableRun {
  at: string;
  ok: boolean;
  rows: number;
  error?: string;
}

export interface SourceTableWatermark {
  status: SourceTableSyncStatus;
  /** When the last run finished, successful or not. */
  at: string | null;
  /** When the last run that wrote rows finished; the page's 「信源同步于」. */
  lastOkAt: string | null;
  rows: number;
  created: number;
  updated: number;
  removed: number;
  error: string | null;
  /** Newest first, at most RUNS_KEPT. */
  runs: SourceTableRun[];
}

export interface SourceTableRow {
  recordId: string;
  slug: string;
  code: string | null;
  title: string;
  region: string | null;
  lifecycle: string | null;
  businessCategories: string[];
  productFunctions: string[];
  certType: string | null;
  publishOrg: string | null;
  applyCountries: string[];
  vehicleTypes: string | null;
  publishedOn: string | null;
  revisedOn: string | null;
  effectiveOn: string | null;
  commentDeadline: string | null;
  reportDeadline: string | null;
  originUrl: string | null;
  archivedState: string | null;
  originMode: string | null;
  corroboration: string | null;
  corroborationPolicy: string | null;
  subscriptionState: string | null;
  interpretationState: string | null;
  owners: string[];
  summary: string | null;
  impact: string | null;
  sourceT1: string | null;
  sourceT2: string | null;
  sourceT3: string | null;
  checkedOn: string | null;
  createdOn: string | null;
  updatedOn: string | null;
  raw: Record<string, unknown>;
}

/** What the module needs from the environment; the page shows the first missing piece by name. */
export interface SourceTableConfig {
  appToken: string | null;
  tableId: string | null;
  webUrl: string | null;
  enabled: boolean;
  cron: string;
  configured: boolean;
}

export function syncConfig(): SourceTableConfig {
  const appToken = credential("integrations", "FEISHU_SOURCE_TABLE_APP_TOKEN");
  const tableId = credential("integrations", "FEISHU_SOURCE_TABLE_TABLE_ID");
  return {
    appToken,
    tableId,
    webUrl: credential("integrations", "FEISHU_SOURCE_TABLE_WEB_URL"),
    enabled: config.sourceTableSyncEnabled,
    cron: config.sourceTableSyncCron,
    configured: Boolean(appToken && tableId),
  };
}

/** The page prints this next to the dot; derived so a cron change does not need a code change. */
export function everyLabel(cron: string): string {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  if (m) {
    const minutes = Number(m[1]);
    if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
    return `每 ${minutes} 分钟`;
  }
  const hourly = /^(\d+) \*\/ ?(\d+) \* \* \*$/.exec(cron.trim()) ?? /^0 \*\/(\d+) \* \* \*$/.exec(cron.trim());
  if (hourly) {
    const hours = Number(hourly[hourly.length - 1]);
    if (Number.isFinite(hours) && hours > 0) return `每 ${hours} 小时`;
  }
  if (/^0 \* \* \* \*$/.test(cron.trim())) return "每小时";
  return cron;
}

// --- Feishu -----------------------------------------------------------------------------------------

interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

interface FeishuListResponse {
  code: number;
  msg?: string;
  data?: { items?: FeishuRecord[]; has_more?: boolean; page_token?: string };
}

let tokenCache: { token: string; expires: number } | null = null;

/**
 * The site uses one Feishu app for messaging, reader login and the table read; a deployment that
 * configures only the login pair reads the table with it (same app, same tenant token).
 */
async function tenantToken(): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const appId = credential("integrations", "FEISHU_APP_ID") ?? credential("integrations", "FEISHU_LOGIN_APP_ID");
  const appSecret = credential("integrations", "FEISHU_APP_SECRET") ?? credential("integrations", "FEISHU_LOGIN_APP_SECRET");
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置");
  const res = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = (await res.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (json.code !== 0 || !json.tenant_access_token) throw new Error(`飞书取 token 失败：${json.msg ?? json.code}`);
  tokenCache = { token: json.tenant_access_token, expires: Date.now() + (json.expire ?? 3600) * 1000 };
  return tokenCache.token;
}

async function fetchRecords(token: string, appToken: string, tableId: string): Promise<FeishuRecord[]> {
  const out: FeishuRecord[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (pageToken) query.set("page_token", pageToken);
    const res = await fetch(`${FEISHU_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records/search?${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    const json = (await res.json()) as FeishuListResponse;
    if (json.code !== 0) throw new Error(`读多维表格失败：${json.msg ?? json.code}`);
    out.push(...(json.data?.items ?? []));
    if (!json.data?.has_more || !json.data.page_token) break;
    pageToken = json.data.page_token;
    if (out.length > MAX_ROWS) throw new Error(`记录数超过 ${MAX_ROWS}，表的 id 可能指错了`);
  }
  return out;
}

// --- Mapping ----------------------------------------------------------------------------------------

/** 富文本字段回来是 [{ text }]；偶尔是裸字符串（导出文件）。 */
function textOf(value: unknown): string | null {
  if (typeof value === "string") return blank(value);
  if (Array.isArray(value)) {
    const joined = value.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text ?? "") : "")).join("").trim();
    return blank(joined);
  }
  return null;
}

function selectOf(value: unknown): string | null {
  if (typeof value === "string") return blank(value);
  if (Array.isArray(value)) return textOf(value);
  if (value && typeof value === "object" && "text" in value) return blank(String((value as { text: unknown }).text ?? ""));
  return null;
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text ?? "") : ""))
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set(parts)];
  }
  const single = selectOf(value);
  return single ? [single] : [];
}

function dayOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return beijingDate(new Date(value));
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return beijingDate(new Date(parsed));
  }
  return null;
}

/** 超链接字段带 link；早期手填的纯 Markdown 才需要解析（104 条实测都有 link）。 */
function urlOf(value: unknown): string | null {
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0] as { link?: unknown; text?: unknown };
    if (first && typeof first === "object" && typeof first.link === "string" && first.link.trim() !== "") return first.link.trim();
    const text = textOf(value);
    if (text) return urlFromText(text);
    return null;
  }
  const text = textOf(value) ?? selectOf(value);
  return text ? urlFromText(text) : null;
}

function urlFromText(text: string): string | null {
  const markdown = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(text);
  if (markdown) return markdown[2];
  const bare = /https?:\/\/[^\s)]+/.exec(text);
  return bare ? bare[0] : null;
}

function personNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .map((person) => (person && typeof person === "object" ? String((person as { name?: unknown }).name ?? (person as { en_name?: unknown }).en_name ?? "") : ""))
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function blank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** GB/T 41797-2022 → gb-t-41797-2022; 编号为空时用记录 id (03 §3.3). */
export function slugFor(recordId: string, code: string | null, taken: Set<string> = new Set()): string {
  const base = (code ?? `reg-${recordId}`)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `reg-${recordId}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `reg-${recordId}`;
}

export function mapRecord(record: FeishuRecord, taken = new Set<string>()): SourceTableRow {
  const f = record.fields ?? {};
  const code = textOf(f["法规编号"]);
  const slug = slugFor(record.record_id, code, taken);
  taken.add(slug);
  return {
    recordId: record.record_id,
    slug,
    code,
    title: textOf(f["法规全称"]) ?? code ?? record.record_id,
    region: selectOf(f["地区"]),
    lifecycle: selectOf(f["生命周期阶段"]),
    businessCategories: listOf(f["业务分类"]),
    productFunctions: listOf(f["产品功能"]),
    certType: selectOf(f["法规认证类型"]),
    publishOrg: textOf(f["发布机构"]),
    applyCountries: listOf(f["适用国家"]),
    vehicleTypes: textOf(f["适用车型"]),
    publishedOn: dayOf(f["发布日期"]),
    revisedOn: dayOf(f["修订日期"]),
    effectiveOn: dayOf(f["实施日期"]),
    commentDeadline: dayOf(f["征求意见截止日期"]),
    reportDeadline: dayOf(f["报批稿截止日期"]),
    originUrl: urlOf(f["原文链接"]),
    archivedState: selectOf(f["原文入库"]),
    originMode: selectOf(f["原文获取方式"]),
    corroboration: selectOf(f["印证状态"]),
    corroborationPolicy: textOf(f["印证策略"]),
    subscriptionState: selectOf(f["订阅状态"]),
    interpretationState: selectOf(f["解读状态"]),
    owners: personNames(f["认领人"]),
    summary: textOf(f["核心摘要"]),
    impact: textOf(f["影响评估"]),
    sourceT1: textOf(f["信源T1-官方"]),
    sourceT2: textOf(f["信源T2-行业"]),
    sourceT3: textOf(f["信源T3-资讯"]),
    checkedOn: dayOf(f["上次检查日期"]),
    createdOn: dayOf(f["创建时间"]),
    updatedOn: dayOf(f["更新时间"]),
    raw: f,
  };
}

export function mapRecords(records: FeishuRecord[]): SourceTableRow[] {
  const taken = new Set<string>();
  return records.map((record) => mapRecord(record, taken));
}

// --- Writing ----------------------------------------------------------------------------------------

interface RowDiff {
  created: number;
  updated: number;
  removed: number;
}

const COLUMNS = [
  "record_id", "slug", "code", "title", "region", "lifecycle", "business_categories", "product_functions",
  "cert_type", "publish_org", "apply_countries", "vehicle_types", "published_on", "revised_on", "effective_on",
  "comment_deadline", "report_deadline", "origin_url", "archived_state", "origin_mode", "corroboration",
  "corroboration_policy", "subscription_state", "interpretation_state", "owners", "summary", "impact",
  "source_t1", "source_t2", "source_t3", "checked_on", "created_on", "updated_on", "raw",
] as const;

/**
 * Replaces the mirror inside one transaction: DELETE then INSERT, never an upsert — a row whose slug
 * changed would otherwise collide with its own copy. The advisory lock keeps two runs (the schedule and
 * a manual import) from interleaving.
 */
export async function writeRows(rows: SourceTableRow[]): Promise<RowDiff> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
    const before = await tx<{ record_id: string }[]>`SELECT record_id FROM source_table_rows`;
    const oldIds = new Set(before.map((r) => r.record_id));
    const newIds = new Set(rows.map((r) => r.recordId));
    await tx`DELETE FROM source_table_rows`;
    for (const row of rows) {
      await tx`
        INSERT INTO source_table_rows (${tx(COLUMNS as unknown as string[])})
        VALUES (
          ${row.recordId}, ${row.slug}, ${row.code}, ${row.title}, ${row.region}, ${row.lifecycle},
          ${row.businessCategories}, ${row.productFunctions}, ${row.certType}, ${row.publishOrg},
          ${row.applyCountries}, ${row.vehicleTypes}, ${row.publishedOn}, ${row.revisedOn}, ${row.effectiveOn},
          ${row.commentDeadline}, ${row.reportDeadline}, ${row.originUrl}, ${row.archivedState}, ${row.originMode},
          ${row.corroboration}, ${row.corroborationPolicy}, ${row.subscriptionState}, ${row.interpretationState},
          ${row.owners}, ${row.summary}, ${row.impact}, ${row.sourceT1}, ${row.sourceT2}, ${row.sourceT3},
          ${row.checkedOn}, ${row.createdOn}, ${row.updatedOn}, ${tx.json(row.raw as never)}
        )`;
    }
    await tx`UPDATE source_table_rows SET synced_at = now()`;
    let created = 0;
    for (const id of newIds) if (!oldIds.has(id)) created++;
    let removed = 0;
    for (const id of oldIds) if (!newIds.has(id)) removed++;
    return { created, updated: rows.length - created, removed };
  });
}

// --- Watermark --------------------------------------------------------------------------------------

function emptyWatermark(): SourceTableWatermark {
  return { status: "never", at: null, lastOkAt: null, rows: 0, created: 0, updated: 0, removed: 0, error: null, runs: [] };
}

export async function readWatermark(): Promise<SourceTableWatermark> {
  const [row] = await sql<{ value: Partial<SourceTableWatermark> }[]>`SELECT value FROM settings WHERE key = ${WATERMARK_KEY}`;
  if (!row) return emptyWatermark();
  const value = row.value ?? {};
  return {
    status: (value.status as SourceTableSyncStatus) ?? "never",
    at: value.at ?? null,
    lastOkAt: value.lastOkAt ?? null,
    rows: value.rows ?? 0,
    created: value.created ?? 0,
    updated: value.updated ?? 0,
    removed: value.removed ?? 0,
    error: value.error ?? null,
    runs: Array.isArray(value.runs) ? value.runs.slice(0, RUNS_KEPT) : [],
  };
}

async function saveWatermark(next: SourceTableWatermark): Promise<SourceTableWatermark> {
  await sql`
    INSERT INTO settings (key, value, updated_by) VALUES (${WATERMARK_KEY}, ${sql.json(next as never)}, 'source-table')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return next;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one sync. Never throws: a failure is recorded in the watermark and shown on the page. */
export async function syncSourceTable(): Promise<SourceTableWatermark> {
  const cfg = syncConfig();
  const previous = await readWatermark();
  const at = new Date().toISOString();
  const fail = (error: string) =>
    saveWatermark({
      ...previous,
      status: "failed",
      at,
      rows: previous.rows,
      error,
      runs: [{ at, ok: false, rows: 0, error }, ...previous.runs].slice(0, RUNS_KEPT),
    });

  if (!cfg.configured) return fail("FEISHU_SOURCE_TABLE_APP_TOKEN / FEISHU_SOURCE_TABLE_TABLE_ID 未配置");

  try {
    const records = await fetchRecords(await tenantToken(), cfg.appToken!, cfg.tableId!);
    if (records.length === 0) throw new Error("飞书返回 0 条记录，已放弃写入（避免清空本地镜像）");
    const rows = mapRecords(records);
    const diff = await writeRows(rows);
    return saveWatermark({
      status: "ok",
      at,
      lastOkAt: at,
      rows: rows.length,
      ...diff,
      error: null,
      runs: [{ at, ok: true, rows: rows.length }, ...previous.runs].slice(0, RUNS_KEPT),
    });
  } catch (error) {
    return fail(message(error));
  }
}

/** The status the page shows, resolving the environment-only states at read time. */
export async function syncState(): Promise<SourceTableWatermark & { every: string; webUrl: string | null }> {
  const cfg = syncConfig();
  const watermark = await readWatermark();
  const every = everyLabel(cfg.cron);
  if (!cfg.configured) return { ...watermark, status: "unconfigured", every, webUrl: null };
  if (!cfg.enabled) return { ...watermark, status: watermark.lastOkAt ? "disabled" : "never", every, webUrl: cfg.webUrl };
  return { ...watermark, every, webUrl: cfg.webUrl };
}

/** Import a snapshot of Feishu records (scripts/import-source-table-snapshot.ts): same writer, no request. */
export async function importSnapshot(records: FeishuRecord[]): Promise<SourceTableWatermark> {
  const previous = await readWatermark();
  const at = new Date().toISOString();
  if (records.length === 0) throw new Error("快照是空的，拒绝写入");
  const rows = mapRecords(records);
  const diff = await writeRows(rows);
  return saveWatermark({
    status: "ok",
    at,
    lastOkAt: at,
    rows: rows.length,
    ...diff,
    error: null,
    runs: [{ at, ok: true, rows: rows.length }, ...previous.runs].slice(0, RUNS_KEPT),
  });
}
