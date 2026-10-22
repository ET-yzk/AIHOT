// The subscription module's reads and writes: one settings row per reader, the push ledger, the sweep's
// queries, and the counts behind the page's favourite recommendation. The report text itself is read
// through publication/ (facets) and the reports table, never rewritten here.
import type { ReportKind } from "@aihot/contracts/site";
import type {
  DeliveryStatus, DeliveryView, FavoriteSuggestion, SubscriptionOptions, SubscriptionScope, SubscriptionView,
} from "@aihot/contracts/subscriptions";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { sql, type Db } from "@aihot/backend/db";
import { itemFacets } from "@aihot/backend/publication/facets";
import { dailyUrl, periodUrl } from "@aihot/backend/publication/links";
import { TOPICS, TOPIC_GROUPS } from "@aihot/backend/publication/topics";
import { readerLoginConfigured } from "./auth.ts";

/** A report's page, from the same links every other exit uses. */
export function reportUrl(kind: ReportKind, key: string): string {
  return kind === "daily" ? dailyUrl(key) : periodUrl(kind, key);
}

interface SubscriptionRow {
  user_id: number;
  enabled: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  scope: SubscriptionScope;
  categories: string[];
  topics: string[];
  updated_at: Date;
}

function toSubscription(r: SubscriptionRow): SubscriptionView {
  return {
    enabled: r.enabled, daily: r.daily, weekly: r.weekly, monthly: r.monthly,
    scope: r.scope, categories: r.categories, topics: r.topics,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function getSubscription(userId: number): Promise<SubscriptionView | null> {
  const [r] = await sql<SubscriptionRow[]>`
    SELECT user_id, enabled, daily, weekly, monthly, scope, categories, topics, updated_at
    FROM reader_subscriptions WHERE user_id = ${userId}`;
  return r ? toSubscription(r) : null;
}

/** What the page saves; the server has already checked the keys against the industry pack. */
export interface SubscriptionWrite {
  enabled: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  scope: SubscriptionScope;
  categories: string[];
  topics: string[];
}

export async function saveSubscription(userId: number, input: SubscriptionWrite): Promise<SubscriptionView> {
  const [r] = await sql<SubscriptionRow[]>`
    INSERT INTO reader_subscriptions (user_id, enabled, daily, weekly, monthly, scope, categories, topics)
    VALUES (${userId}, ${input.enabled}, ${input.daily}, ${input.weekly}, ${input.monthly}, ${input.scope},
            ${sql.array(input.categories)}::text[], ${sql.array(input.topics)}::text[])
    ON CONFLICT (user_id) DO UPDATE SET
      enabled = EXCLUDED.enabled, daily = EXCLUDED.daily, weekly = EXCLUDED.weekly, monthly = EXCLUDED.monthly,
      scope = EXCLUDED.scope, categories = EXCLUDED.categories, topics = EXCLUDED.topics, updated_at = now()
    RETURNING user_id, enabled, daily, weekly, monthly, scope, categories, topics, updated_at`;
  return toSubscription(r!);
}

interface DeliveryRowView {
  kind: ReportKind;
  report_key: string;
  status: DeliveryStatus;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
}

/** The reader's last pushes, newest first. */
export async function getDeliveries(userId: number, limit = 10): Promise<DeliveryView[]> {
  const rows = await sql<DeliveryRowView[]>`
    SELECT kind, report_key, status, left(error, 300) AS error, created_at, sent_at
    FROM reader_deliveries WHERE user_id = ${userId}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    kind: r.kind, reportKey: r.report_key, status: r.status, error: r.error,
    createdAt: r.created_at.toISOString(), sentAt: r.sent_at?.toISOString() ?? null,
    reportUrl: reportUrl(r.kind, r.report_key),
  }));
}

/** What the page can offer. The login flag keeps the sign-in card honest when the app is not configured. */
export function subscriptionOptions(): SubscriptionOptions {
  return {
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, tagColor: c.tagColor })),
    topics: TOPICS.map((t) => ({ slug: t.slug, name: t.name, group: t.group })),
    groups: TOPIC_GROUPS.map((g) => ({ key: g.key, name: g.name })),
    loginConfigured: readerLoginConfigured(),
  };
}

/**
 * Counts over the reader's local favourites: categories and topics of the items that still have a page.
 * The ids are used for this answer only; nothing about the reader's favourites is stored.
 */
export async function favouriteSuggestion(itemIds: readonly string[]): Promise<FavoriteSuggestion> {
  const facets = await itemFacets(itemIds);
  const categoryCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  let total = 0;
  for (const f of facets.values()) {
    if (!f.available) continue;
    total += 1;
    if (f.category) categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + 1);
    for (const t of f.topics) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  }
  const categoryOrder = new Map<string, number>(CATEGORIES.map((c, i) => [c.key, i]));
  const topicOrder = new Map(TOPICS.map((t, i) => [t.slug, i]));
  const categories = [...categoryCounts].map(([key, count]) => {
    const c = CATEGORIES.find((x) => x.key === key)!;
    return { key, label: c.label, count };
  }).sort((a, b) => b.count - a.count || (categoryOrder.get(a.key)! - categoryOrder.get(b.key)!));
  const topics = [...topicCounts].map(([slug, count]) => {
    const t = TOPICS.find((x) => x.slug === slug)!;
    return { slug, name: t.name, group: t.group, count };
  }).sort((a, b) => b.count - a.count || (topicOrder.get(a.slug)! - topicOrder.get(b.slug)!));
  return { total, categories, topics };
}

// ---------------------------------------------------------------------------------------------------
// The sweep: the latest issue of each kind, who wants it, and the push ledger.

export interface ReportRef {
  kind: ReportKind;
  key: string;
  window_end: Date;
  generated_at: Date;
}

/** How old the latest issue of each kind may be and still be pushed (a long outage must not flood readers). */
const FRESH_DAYS: Record<ReportKind, number> = { daily: 2, weekly: 9, monthly: 32 };

/** The latest issue of each kind, when it is fresh enough to be pushed now. */
export async function latestReports(now: Date): Promise<ReportRef[]> {
  const rows = await sql<ReportRef[]>`
    SELECT DISTINCT ON (kind) kind, key, window_end, generated_at
    FROM reports WHERE kind IN ('daily', 'weekly', 'monthly')
    ORDER BY kind, key DESC`;
  return rows.filter((r) => now.getTime() - r.window_end.getTime() <= FRESH_DAYS[r.kind] * 86400_000);
}

export interface WantedSubscription {
  user_id: number;
  created_at: Date;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
}

/** Readers who asked for at least one kind and can receive a direct message. */
export async function enabledSubscriptions(): Promise<WantedSubscription[]> {
  return sql<WantedSubscription[]>`
    SELECT s.user_id, s.created_at, s.daily, s.weekly, s.monthly
    FROM reader_subscriptions s JOIN reader_users u ON u.id = s.user_id
    WHERE s.enabled AND (u.feishu_open_id IS NOT NULL OR u.feishu_union_id IS NOT NULL)`;
}

/** Insert the missing ledger rows; the unique key is what keeps a sweep idempotent. */
export async function insertDeliveries(tx: Db, rows: ReadonlyArray<{ userId: number; kind: ReportKind; key: string }>): Promise<number[]> {
  const out: number[] = [];
  for (const r of rows) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO reader_deliveries (user_id, kind, report_key)
      VALUES (${r.userId}, ${r.kind}, ${r.key})
      ON CONFLICT (user_id, kind, report_key) DO NOTHING RETURNING id`;
    if (row) out.push(row.id);
  }
  return out;
}

/** A push a stopped process left "sending" is unknowable: it may have arrived, so it is never retried. */
export async function markStaleSending(now: Date): Promise<number> {
  const done = await sql`UPDATE reader_deliveries SET status = 'unknown', error = '发送中进程中断', updated_at = now()
    WHERE status = 'sending' AND updated_at < ${new Date(now.getTime() - 15 * 60_000)}`;
  return done.count;
}

/** Pending rows whose enqueue never happened (a crash between write and send) are put back in the queue. */
export async function stalePending(now: Date): Promise<number[]> {
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM reader_deliveries
    WHERE status = 'pending' AND updated_at < ${new Date(now.getTime() - 15 * 60_000)}
    ORDER BY id LIMIT 100`;
  return rows.map((r) => r.id);
}

export interface DeliveryRow {
  id: number;
  user_id: number;
  kind: ReportKind;
  report_key: string;
  status: DeliveryStatus;
}

export async function loadDelivery(id: number): Promise<DeliveryRow | null> {
  const [r] = await sql<DeliveryRow[]>`
    SELECT id, user_id, kind, report_key, status FROM reader_deliveries WHERE id = ${id}`;
  return r ?? null;
}

export interface ReaderRow {
  id: number;
  display_name: string | null;
  feishu_union_id: string | null;
  feishu_open_id: string | null;
  enabled: boolean | null;
  daily: boolean | null;
  weekly: boolean | null;
  monthly: boolean | null;
  scope: SubscriptionScope | null;
  categories: string[] | null;
  topics: string[] | null;
  created_at: Date | null;
}

/** The reader and their subscription (the subscription columns are null when they never saved one). */
export async function loadReader(userId: number): Promise<ReaderRow | null> {
  const [r] = await sql<ReaderRow[]>`
    SELECT u.id, u.display_name, u.feishu_union_id, u.feishu_open_id,
           s.enabled, s.daily, s.weekly, s.monthly, s.scope, s.categories, s.topics, s.created_at
    FROM reader_users u LEFT JOIN reader_subscriptions s ON s.user_id = u.id
    WHERE u.id = ${userId}`;
  return r ?? null;
}

export interface ReportContentRow {
  kind: ReportKind;
  key: string;
  content: Record<string, unknown>;
  generated_at: Date;
}

export async function loadReport(kind: ReportKind, key: string): Promise<ReportContentRow | null> {
  const [r] = await sql<ReportContentRow[]>`
    SELECT kind, key, content, generated_at FROM reports WHERE kind = ${kind} AND key = ${key}`;
  return r ?? null;
}

/** Claim a pending or failed push; null when another run already finished or claimed it. */
export async function beginDelivery(id: number): Promise<number | null> {
  const [r] = await sql<{ attempts: number }[]>`
    UPDATE reader_deliveries SET status = 'sending', attempts = attempts + 1, updated_at = now()
    WHERE id = ${id} AND status IN ('pending', 'failed')
    RETURNING attempts`;
  return r?.attempts ?? null;
}

export async function markSent(id: number, messageId: string | undefined): Promise<void> {
  await sql`UPDATE reader_deliveries SET status = 'sent', error = null, feishu_message_id = ${messageId ?? null},
    sent_at = now(), updated_at = now() WHERE id = ${id}`;
}

export async function markFailed(id: number, error: string): Promise<void> {
  await sql`UPDATE reader_deliveries SET status = 'failed', error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${id}`;
}

export async function markSkipped(id: number, reason: string): Promise<void> {
  await sql`UPDATE reader_deliveries SET status = 'skipped', error = ${reason.slice(0, 500)}, updated_at = now() WHERE id = ${id}`;
}

export async function markUnknown(id: number, error: string): Promise<void> {
  await sql`UPDATE reader_deliveries SET status = 'unknown', error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${id}`;
}

/** The module's share of the daily retention run. */
export async function retention(now: Date): Promise<Record<string, unknown>> {
  const sessions = await sql`DELETE FROM reader_sessions WHERE expires_at < ${now}`;
  const deliveries = await sql`DELETE FROM reader_deliveries WHERE created_at < ${new Date(now.getTime() - 90 * 86400_000)}`;
  return { readerSessions: sessions.count, readerDeliveries: deliveries.count };
}

export interface DeliveryHealth {
  sent: number;
  failed: number;
  lastError: string | null;
}

/** The last 24 hours of pushes, for the module's alert. */
export async function deliveryHealth(now: Date): Promise<DeliveryHealth> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [r] = await sql<{ sent: number; failed: number; last_error: string | null }[]>`
    SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
           count(*) FILTER (WHERE status IN ('failed', 'unknown'))::int AS failed,
           (SELECT left(error, 300) FROM reader_deliveries
            WHERE status IN ('failed', 'unknown') AND created_at >= ${since}
            ORDER BY updated_at DESC LIMIT 1) AS last_error
    FROM reader_deliveries WHERE created_at >= ${since}`;
  return { sent: r?.sent ?? 0, failed: r?.failed ?? 0, lastError: r?.last_error ?? null };
}
