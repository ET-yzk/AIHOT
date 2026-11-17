// Reads source_table_rows for the two pages and /api/site/source-table. Only SQL, no requests.
// Field order is the reading order (03 §4.1): what a reader came for first, maintenance metadata last
// and folded into the detail page's 元数据 block.
import { sql } from "@aihot/backend/db";
import { syncState, type SourceTableSyncStatus } from "./sync.ts";

export type SourceTableGroup = "内容" | "日期" | "范围" | "分类" | "原文" | "信源" | "维护";
export type SourceTableMetaGroup = "信源与印证" | "维护记录";

export interface SourceTableField {
  key: string;
  label: string;
  group: SourceTableGroup;
  value: string | string[] | null;
  /** Rendered in the detail page's collapsed 元数据 block instead of the body. */
  meta?: boolean;
  metaGroup?: SourceTableMetaGroup;
}

export interface SourceTableItem {
  slug: string;
  code: string | null;
  title: string;
  region: string | null;
  lifecycle: string | null;
  businessCategories: string[];
  productFunctions: string[];
  certType: string | null;
  publishOrg: string | null;
  publishedOn: string | null;
  effectiveOn: string | null;
  updatedOn: string | null;
}

export interface FacetValue {
  value: string;
  count: number;
}

export type Facets = Record<"region" | "lifecycle" | "certType" | "businessCategory" | "archived" | "subscription", FacetValue[]>;

export interface SourceTableSync {
  status: SourceTableSyncStatus;
  at: string | null;
  lastOkAt: string | null;
  rows: number;
  error: string | null;
  runs: Array<{ at: string; ok: boolean; rows: number; error?: string }>;
  every: string;
  webUrl: string | null;
  /** The Feishu table's name as readers see it in the footer. */
  tableName: string;
}

export const PAGE_SIZES = [15, 30, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 15;
export const TABLE_NAME = "信源表_v2.0";

export interface ListQuery {
  q?: string;
  region?: string[];
  lifecycle?: string[];
  businessCategory?: string[];
  certType?: string[];
  archived?: string[];
  subscription?: string[];
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ListResult {
  items: SourceTableItem[];
  total: number;
  page: number;
  pageSize: PageSize;
  pageCount: number;
  facets: Facets;
  sync: SourceTableSync;
}

interface Row {
  slug: string;
  code: string | null;
  title: string;
  region: string | null;
  lifecycle: string | null;
  business_categories: string[];
  product_functions: string[];
  cert_type: string | null;
  publish_org: string | null;
  published_on: string | null;
  effective_on: string | null;
  updated_on: string | null;
}

type Fragment = ReturnType<typeof sql>;

const ITEM_COLUMNS = sql`
  slug, code, title, region, lifecycle, business_categories, product_functions, cert_type, publish_org,
  published_on::text AS published_on, effective_on::text AS effective_on, updated_on::text AS updated_on`;

/** A date column as YYYY-MM-DD: the list query casts to text, the detail query's driver hands back Date. */
function dayText(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text.length > 10 ? text.slice(0, 10) : text;
}

function toItem(row: Row): SourceTableItem {
  return {
    slug: row.slug,
    code: row.code,
    title: row.title,
    region: row.region,
    lifecycle: row.lifecycle,
    businessCategories: row.business_categories ?? [],
    productFunctions: row.product_functions ?? [],
    certType: row.cert_type,
    publishOrg: row.publish_org,
    publishedOn: row.published_on,
    effectiveOn: row.effective_on,
    updatedOn: row.updated_on,
  };
}

/** Fixed four sorts (03 §4.4); anything else falls back to the last-updated order. */
const SORTS: Record<string, Fragment> = {
  updated: sql`updated_on DESC NULLS LAST, code ASC NULLS LAST`,
  published: sql`published_on DESC NULLS LAST, code ASC NULLS LAST`,
  effective: sql`effective_on DESC NULLS LAST, code ASC NULLS LAST`,
  effectiveAsc: sql`effective_on ASC NULLS LAST, code ASC NULLS LAST`,
};

export function normalisePage(page: number | undefined, pageSize: number | undefined): { page: number; pageSize: PageSize } {
  const size = (PAGE_SIZES as readonly number[]).includes(pageSize ?? 0) ? (pageSize as PageSize) : DEFAULT_PAGE_SIZE;
  const p = Number.isFinite(page) && (page ?? 0) > 0 ? Math.floor(page!) : 1;
  return { page: p, pageSize: size };
}


export async function listRows(query: ListQuery): Promise<ListResult> {
  const { page, pageSize } = normalisePage(query.page, query.pageSize);
  const q = (query.q ?? "").trim();
  const escaped = q.replace(/[%_\\]/g, (m) => "\\" + m);
  const like = q === "" ? null : "%" + escaped + "%";
  const sort = SORTS[query.sort ?? "updated"] ?? SORTS.updated;

  const parts: Fragment[] = [];
  if (like) parts.push(sql`(code ILIKE ${like} OR title ILIKE ${like} OR summary ILIKE ${like} OR publish_org ILIKE ${like})`);
  if (query.region?.length) parts.push(sql`region = ANY(${query.region})`);
  if (query.lifecycle?.length) parts.push(sql`lifecycle = ANY(${query.lifecycle})`);
  if (query.businessCategory?.length) parts.push(sql`business_categories && ${query.businessCategory}`);
  if (query.certType?.length) parts.push(sql`cert_type = ANY(${query.certType})`);
  if (query.archived?.length) parts.push(sql`archived_state = ANY(${query.archived})`);
  if (query.subscription?.length) parts.push(sql`subscription_state = ANY(${query.subscription})`);
  const where: Fragment = parts.length === 0 ? sql`` : sql`WHERE ${parts.reduce((a, c) => sql`${a} AND ${c}`)}`;

  const [countRow] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM source_table_rows ${where}`;
  const total = countRow?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const offset = (current - 1) * pageSize;

  const rows = await sql<Row[]>`
    SELECT ${ITEM_COLUMNS} FROM source_table_rows ${where}
    ORDER BY ${sort} LIMIT ${pageSize} OFFSET ${offset}`;

  return {
    items: rows.map(toItem),
    total,
    page: current,
    pageSize,
    pageCount,
    facets: await facets(),
    sync: await syncForPage(),
  };
}

interface FacetRow {
  value: string | null;
  count: number;
}

async function facet(column: Fragment): Promise<FacetValue[]> {
  const rows = await sql<FacetRow[]>`
    SELECT ${column} AS value, count(*)::int AS count
    FROM source_table_rows GROUP BY 1 ORDER BY 2 DESC, 1 ASC`;
  return rows.filter((r) => r.value !== null && r.value !== "").map((r) => ({ value: r.value as string, count: r.count }));
}

export async function facets(): Promise<Facets> {
  const [region, lifecycle, certType, businessCategory, archived, subscription] = await Promise.all([
    facet(sql`region`),
    facet(sql`lifecycle`),
    facet(sql`cert_type`),
    facet(sql`unnest(business_categories)`),
    facet(sql`archived_state`),
    facet(sql`subscription_state`),
  ]);
  return { region, lifecycle, certType, businessCategory, archived, subscription };
}

export async function syncForPage(): Promise<SourceTableSync> {
  const state = await syncState();
  return {
    status: state.status,
    at: state.at,
    lastOkAt: state.lastOkAt,
    rows: state.rows,
    error: state.error,
    runs: state.runs,
    every: state.every,
    webUrl: state.webUrl,
    tableName: TABLE_NAME,
  };
}

// --- Detail -----------------------------------------------------------------------------------------

export interface SourceTableDetail extends SourceTableItem {
  fields: SourceTableField[];
  /** Fields only the table has (its 规范外 columns): kept, shown last inside 元数据. */
  extra: Array<{ label: string; value: string }>;
  sync: SourceTableSync;
}

interface DetailRow extends Row {
  summary: string | null;
  impact: string | null;
  origin_url: string | null;
  apply_countries: string[];
  vehicle_types: string | null;
  revised_on: string | null;
  comment_deadline: string | null;
  report_deadline: string | null;
  source_t1: string | null;
  source_t2: string | null;
  source_t3: string | null;
  corroboration: string | null;
  corroboration_policy: string | null;
  archived_state: string | null;
  origin_mode: string | null;
  subscription_state: string | null;
  interpretation_state: string | null;
  owners: string[];
  checked_on: string | null;
  created_on: string | null;
  raw: { fields?: Record<string, unknown> };
}

const KNOWN_LABELS = new Set([
  "法规编号", "法规全称", "地区", "生命周期阶段", "业务分类", "产品功能", "法规认证类型", "发布机构",
  "适用国家", "适用车型", "发布日期", "修订日期", "实施日期", "征求意见截止日期", "报批稿截止日期",
  "原文链接", "原文入库", "原文获取方式", "印证状态", "印证策略", "订阅状态", "解读状态", "认领人",
  "核心摘要", "影响评估", "信源T1-官方", "信源T2-行业", "信源T3-资讯", "上次检查日期", "创建时间", "更新时间",
]);

function metaField(label: string, value: string | string[] | null, metaGroup: SourceTableMetaGroup): SourceTableField {
  return { key: label, label, group: metaGroup === "信源与印证" ? "信源" : "维护", value, meta: true, metaGroup };
}

function detailFields(row: DetailRow): SourceTableField[] {
  return [
    { key: "summary", label: "核心摘要", group: "内容", value: row.summary },
    { key: "impact", label: "影响评估", group: "内容", value: row.impact },
    { key: "lifecycle", label: "生命周期阶段", group: "日期", value: row.lifecycle },
    { key: "effectiveOn", label: "实施日期", group: "日期", value: dayText(row.effective_on) },
    { key: "publishedOn", label: "发布日期", group: "日期", value: dayText(row.published_on) },
    { key: "commentDeadline", label: "征求意见截止", group: "日期", value: dayText(row.comment_deadline) },
    { key: "reportDeadline", label: "报批稿截止", group: "日期", value: dayText(row.report_deadline) },
    { key: "revisedOn", label: "修订日期", group: "日期", value: dayText(row.revised_on) },
    { key: "region", label: "地区", group: "范围", value: row.region },
    { key: "applyCountries", label: "适用国家", group: "范围", value: row.apply_countries },
    { key: "vehicleTypes", label: "适用车型", group: "范围", value: row.vehicle_types },
    { key: "certType", label: "法规认证类型", group: "范围", value: row.cert_type },
    { key: "publishOrg", label: "发布机构", group: "范围", value: row.publish_org },
    { key: "businessCategories", label: "业务分类", group: "分类", value: row.business_categories },
    { key: "productFunctions", label: "产品功能", group: "分类", value: row.product_functions },
    { key: "originUrl", label: "原文链接", group: "原文", value: row.origin_url },
    metaField("信源 T1（官方）", row.source_t1, "信源与印证"),
    metaField("信源 T2（行业）", row.source_t2, "信源与印证"),
    metaField("信源 T3（资讯）", row.source_t3, "信源与印证"),
    metaField("印证状态", row.corroboration, "信源与印证"),
    metaField("印证策略", row.corroboration_policy, "信源与印证"),
    metaField("原文入库", row.archived_state, "信源与印证"),
    metaField("原文获取方式", row.origin_mode, "信源与印证"),
    metaField("订阅状态", row.subscription_state, "维护记录"),
    metaField("解读状态", row.interpretation_state, "维护记录"),
    metaField("认领人", row.owners, "维护记录"),
    metaField("上次检查", dayText(row.checked_on), "维护记录"),
    metaField("创建时间", dayText(row.created_on), "维护记录"),
    metaField("更新时间", dayText(row.updated_on), "维护记录"),
  ];
}

export async function loadRow(slug: string): Promise<SourceTableDetail | null> {
  const [row] = await sql<DetailRow[]>`SELECT * FROM source_table_rows WHERE slug = ${slug}`;
  if (!row) return null;
  const extra = Object.entries(row.raw?.fields ?? {})
    .filter(([label]) => !KNOWN_LABELS.has(label))
    .map(([label, value]) => ({ label, value: typeof value === "string" ? value : JSON.stringify(value) }));
  return {
    ...toItem({
      ...(row as unknown as Row),
      published_on: dayText(row.published_on),
      effective_on: dayText(row.effective_on),
      updated_on: dayText(row.updated_on),
    }),
    fields: detailFields(row),
    extra,
    sync: await syncForPage(),
  };
}

/** Row count, for the empty-state copy and the tests. */
export async function rowCount(): Promise<number> {
  const [row] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM source_table_rows`;
  return row?.total ?? 0;
}
