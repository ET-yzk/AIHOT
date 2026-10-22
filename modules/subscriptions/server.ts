// The subscription module's backend: reader sign-in, subscription management, the 5-minute sweep that
// writes the push ledger, the queue that sends one card per reader, and the module's alerts/retention.
// All of it is site-specific and lives here; the engine only lends its queue/schedule/alerts seams.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import type { ReaderMe, SubscriptionInput } from "@aihot/contracts/subscriptions";
import type { ReportKind } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { config, credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { enqueueOn } from "@aihot/backend/jobs/queue";
import { defineQueue, type Scheduled, type ServerModule } from "@aihot/backend/modules";
import type { Finding } from "@aihot/backend/notify/feishu";
import { sendDirectMessage } from "@aihot/backend/notify/feishu";
import { itemFacets } from "@aihot/backend/publication/facets";
import { TOPICS } from "@aihot/backend/publication/topics";
import {
  callbackUrl, completeLogin, cookie, deleteReader, endSession, LoginRejected, loginRedirect, parseCookies,
  readerLoginConfigured, secureCookies, sessionReader, SESSION_COOKIE, SESSION_DAYS, STATE_COOKIE, type ReaderIdentity,
} from "./auth.ts";
import {
  beginDelivery, deliveryHealth, enabledSubscriptions, favouriteSuggestion, getDeliveries, getSubscription,
  insertDeliveries, latestReports, loadDelivery, loadReader, loadReport, markFailed, markSent, markSkipped,
  markStaleSending, markUnknown, reportUrl, retention as runRetention, saveSubscription, stalePending,
  subscriptionOptions, type DeliveryRow, type ReaderRow, type ReportContentRow,
} from "./data.ts";
import { leadItemId, reportCard, reportEntries, reportLead, testCard } from "./card.ts";

const TOPIC_SLUGS = new Set(TOPICS.map((t) => t.slug));
const subscriptionsUrl = () => `${config.siteUrl}/subscriptions`;

// In-memory rate limits, like the admin's: one api process, small enough not to need a shared counter.
type Hits = Map<string, number[]>;
const loginHits: Hits = new Map();
const suggestHits: Hits = new Map();
const testHits: Hits = new Map();

function hit(map: Hits, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    map.set(key, recent);
    return false;
  }
  recent.push(now);
  map.set(key, recent);
  if (map.size > 5000) {
    for (const [k, v] of map) if (v.every((t) => now - t >= windowMs)) map.delete(k);
  }
  return true;
}

/** First-party JSON error; the page only needs the message. */
function problem(reply: FastifyReply, status: number, detail: string) {
  return reply.code(status).header("Cache-Control", "no-store").send({ error: detail });
}

function csrfOk(req: FastifyRequest, identity: ReaderIdentity): boolean {
  return typeof req.headers["x-csrf-token"] === "string" && req.headers["x-csrf-token"] === identity.csrf;
}

function subscriptionOf(r: ReaderRow): SubscriptionInput | null {
  if (r.scope === null || r.enabled === null) return null;
  return {
    enabled: r.enabled, daily: r.daily ?? false, weekly: r.weekly ?? false, monthly: r.monthly ?? false,
    scope: r.scope, categories: r.categories ?? [], topics: r.topics ?? [],
  };
}

function wantsKind(sub: SubscriptionInput, kind: ReportKind): boolean {
  return kind === "daily" ? sub.daily : kind === "weekly" ? sub.weekly : sub.monthly;
}

const scopeSchema = z.enum(["all", "categories", "topics"]);
const saveSchema = z.object({
  enabled: z.boolean(),
  daily: z.boolean(),
  weekly: z.boolean(),
  monthly: z.boolean(),
  scope: scopeSchema,
  categories: z.array(z.string().max(40)).max(20).default([]),
  topics: z.array(z.string().max(60)).max(60).default([]),
}).strict();

const suggestSchema = z.object({
  itemIds: z.array(z.string().max(80)).max(500),
}).strict();

function validationError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "请求"}: ${issue.message}`).join("; ").slice(0, 300);
}

// ---------------------------------------------------------------------------------------------------
// Routes.

function registerRoutes(app: FastifyInstance) {
  app.get("/api/subscriptions/options", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.send(subscriptionOptions());
  });

  // The web page links here; the callback is registered in the Feishu open platform.
  app.get("/api/subscriptions/auth/login", async (req, reply) => {
    const returnTo = String((req.query as Record<string, string>).return ?? "/subscriptions");
    reply.header("Cache-Control", "no-store");
    if (!readerLoginConfigured()) return reply.redirect("/subscriptions?login=unconfigured", 302);
    if (!hit(loginHits, `ip:${req.ip}`, 20, 60_000)) return problem(reply, 429, "登录尝试太频繁，请稍后再试");
    try {
      const { url, stateCookie } = loginRedirect(returnTo);
      reply.header("Set-Cookie", cookie(STATE_COOKIE, stateCookie, 600, secureCookies()));
      return reply.redirect(url, 302);
    } catch (error) {
      req.log.error({ err: error }, "reader login redirect failed");
      return reply.redirect("/subscriptions?login=unconfigured", 302);
    }
  });

  app.get("/api/subscriptions/auth/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const stateCookie = parseCookies(req.headers.cookie)[STATE_COOKIE];
    reply.header("Cache-Control", "no-store");
    if (q.error || !q.code || !q.state) return reply.redirect("/subscriptions?login=failed", 302);
    try {
      const { token, returnTo } = await completeLogin(q.code, q.state, stateCookie, req.headers["user-agent"]);
      reply.header("Set-Cookie", [
        cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secureCookies()),
        cookie(STATE_COOKIE, "", 0, secureCookies()),
      ]);
      return reply.redirect(returnTo, 302);
    } catch (error) {
      if (!(error instanceof LoginRejected)) req.log.error({ err: error }, "reader login failed");
      reply.header("Set-Cookie", cookie(STATE_COOKIE, "", 0, secureCookies()));
      return reply.redirect("/subscriptions?login=failed", 302);
    }
  });

  app.post("/api/subscriptions/auth/logout", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = await sessionReader(req.headers.cookie);
    if (!identity) return reply.code(204).send();
    if (!csrfOk(req, identity)) return problem(reply, 403, "缺少或过期的 CSRF 令牌");
    await endSession(req.headers.cookie);
    reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secureCookies()));
    return reply.code(204).send();
  });

  app.get("/api/subscriptions/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = await sessionReader(req.headers.cookie);
    if (!identity) return problem(reply, 401, "请先用飞书登录");
    const [subscription, deliveries] = await Promise.all([getSubscription(identity.userId), getDeliveries(identity.userId)]);
    const me: ReaderMe = {
      user: { name: identity.name, avatarUrl: identity.avatarUrl },
      subscription, deliveries, csrf: identity.csrf,
    };
    return reply.send(me);
  });

  app.put("/api/subscriptions", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = await sessionReader(req.headers.cookie);
    if (!identity) return problem(reply, 401, "请先用飞书登录");
    if (!csrfOk(req, identity)) return problem(reply, 403, "缺少或过期的 CSRF 令牌");
    let body: z.infer<typeof saveSchema>;
    try {
      body = saveSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) return problem(reply, 400, validationError(error));
      throw error;
    }
    const categories = [...new Set(body.categories)];
    const topics = [...new Set(body.topics)];
    if (!categories.every(isCategoryKey)) return problem(reply, 400, "未知的分类");
    if (!topics.every((t) => TOPIC_SLUGS.has(t))) return problem(reply, 400, "未知的主题");
    if (body.enabled && !body.daily && !body.weekly && !body.monthly) return problem(reply, 400, "开启推送时至少选择一期");
    if (body.enabled && body.scope === "categories" && categories.length === 0) return problem(reply, 400, "请至少选择一个分类");
    if (body.enabled && body.scope === "topics" && topics.length === 0) return problem(reply, 400, "请至少选择一个主题");
    const subscription = await saveSubscription(identity.userId, { ...body, categories, topics });
    return reply.send(subscription);
  });

  app.post("/api/subscriptions/test", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = await sessionReader(req.headers.cookie);
    if (!identity) return problem(reply, 401, "请先用飞书登录");
    if (!csrfOk(req, identity)) return problem(reply, 403, "缺少或过期的 CSRF 令牌");
    if (!config.feishuReaderPushEnabled) return problem(reply, 409, "个人推送还没有打开，请联系管理员");
    if (!credential("integrations", "FEISHU_APP_ID") || !credential("integrations", "FEISHU_APP_SECRET")) {
      return problem(reply, 503, "消息应用还没有配置，请联系管理员");
    }
    if (!hit(testHits, `user:${identity.userId}`, 3, 10 * 60_000)) return problem(reply, 429, "测试消息发得太频繁，请稍后再试");
    const receive = identity.openId
      ? { id: identity.openId, type: "open_id" as const }
      : identity.unionId ? { id: identity.unionId, type: "union_id" as const } : null;
    if (!receive) return problem(reply, 409, "这个飞书账号没有可用的消息标识");
    try {
      const result = await sendDirectMessage(receive.id, testCard(SITE.name, subscriptionsUrl()), receive.type);
      if (result.status === "sent") return reply.send({ ok: true });
      if (result.status === "unknown") return problem(reply, 504, "飞书没有及时回应，消息可能已经发出；请先看飞书，不要连续重试");
      return problem(reply, 502, `发送失败：${result.error ?? "飞书返回错误"}`);
    } catch (error) {
      req.log.error({ err: error }, "reader test message failed");
      return problem(reply, 502, "发送失败，请稍后再试");
    }
  });

  app.delete("/api/subscriptions/me", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const identity = await sessionReader(req.headers.cookie);
    if (!identity) return problem(reply, 401, "请先用飞书登录");
    if (!csrfOk(req, identity)) return problem(reply, 403, "缺少或过期的 CSRF 令牌");
    await deleteReader(identity.userId);
    reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secureCookies()));
    return reply.code(204).send();
  });

  // Public: the page reads this browser's favourites and sends only their ids; nothing is stored.
  app.post("/api/subscriptions/suggest", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!hit(suggestHits, `ip:${req.ip}`, 30, 60_000)) return problem(reply, 429, "请求太频繁，请稍后再试");
    let body: z.infer<typeof suggestSchema>;
    try {
      body = suggestSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) return problem(reply, 400, validationError(error));
      throw error;
    }
    return reply.send(await favouriteSuggestion([...new Set(body.itemIds)].slice(0, 500)));
  });
}

// ---------------------------------------------------------------------------------------------------
// The sweep and the queue.

export const DELIVER_QUEUE = defineQueue<{ id: number }>({
  name: "subscriptions.deliver",
  options: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 120 },
  worker: { batchSize: 1, pollingIntervalSeconds: 5 },
  run: async (jobs) => {
    for (const job of jobs) await deliverOne(job.id);
    return { done: jobs.length };
  },
});

const DELIVER_SCHEDULE: Scheduled = {
  name: "subscriptions.deliver",
  cron: "*/5 * * * *",
  when: () => config.feishuReaderPushEnabled,
  run: () => sweepSubscriptions(),
};

/** The card for one issue and one subscription; null when a filtered subscription has no match. */
export async function buildReportCard(report: ReportContentRow, kind: ReportKind, sub: SubscriptionInput): Promise<{ card: unknown; filtered: boolean; totalMatches: number } | null> {
  const entries = reportEntries(report.content, kind);
  const facets = await itemFacets(entries.map((e) => e.itemId));
  const available = entries.filter((e) => facets.get(e.itemId)?.available === true);
  if (sub.scope === "all") {
    const lead = reportLead(report.content, kind);
    const leadId = leadItemId(report.content);
    const top = available.filter((e) => e.itemId !== leadId).slice(0, 4);
    return {
      card: reportCard({
        kind, key: report.key, siteName: SITE.name, lead, entries: top, filtered: false,
        totalMatches: available.length, reportUrl: reportUrl(kind, report.key), subscriptionsUrl: subscriptionsUrl(),
      }),
      filtered: false, totalMatches: available.length,
    };
  }
  const categories = new Set(sub.categories);
  const topics = new Set(sub.topics);
  const matches = available.filter((e) => {
    const f = facets.get(e.itemId);
    if (!f) return false;
    return sub.scope === "categories" ? !!f.category && categories.has(f.category) : f.topics.some((t) => topics.has(t));
  });
  if (matches.length === 0) return null;
  return {
    card: reportCard({
      kind, key: report.key, siteName: SITE.name, lead: null, entries: matches.slice(0, 5), filtered: true,
      totalMatches: matches.length, reportUrl: reportUrl(kind, report.key), subscriptionsUrl: subscriptionsUrl(),
    }),
    filtered: true, totalMatches: matches.length,
  };
}

/** Send one ledger row. A finished or unknowable row is left alone; a transport failure is retried by the queue. */
export async function deliverOne(id: number): Promise<void> {
  const delivery = await loadDelivery(id);
  if (!delivery) return;
  if (delivery.status === "sent" || delivery.status === "unknown" || delivery.status === "skipped") return;
  const reader = await loadReader(delivery.user_id);
  if (!reader) {
    await markSkipped(id, "读者已不存在");
    return;
  }
  const sub = subscriptionOf(reader);
  if (!sub || !sub.enabled) {
    await markSkipped(id, "订阅已关闭");
    return;
  }
  if (!wantsKind(sub, delivery.kind)) {
    await markSkipped(id, "这一期已经关掉");
    return;
  }
  const report = await loadReport(delivery.kind, delivery.report_key);
  if (!report) {
    await markSkipped(id, "这一期已不存在");
    return;
  }
  if (reader.created_at && report.generated_at.getTime() < reader.created_at.getTime()) {
    await markSkipped(id, "订阅之前已经出过的期");
    return;
  }
  const receive = reader.feishu_open_id
    ? { id: reader.feishu_open_id, type: "open_id" as const }
    : reader.feishu_union_id ? { id: reader.feishu_union_id, type: "union_id" as const } : null;
  if (!receive) {
    await markSkipped(id, "没有可用的飞书消息标识");
    return;
  }
  let built: Awaited<ReturnType<typeof buildReportCard>>;
  try {
    built = await buildReportCard(report, delivery.kind, sub);
  } catch (error) {
    await markFailed(id, `拼装卡片失败：${String(error)}`);
    throw error;
  }
  if (!built) {
    await markSkipped(id, "这一期没有你订阅的内容");
    return;
  }
  const claimed = await beginDelivery(id);
  if (claimed === null) return;
  let result: Awaited<ReturnType<typeof sendDirectMessage>>;
  try {
    result = await sendDirectMessage(receive.id, built.card, receive.type);
  } catch (error) {
    await markFailed(id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (result.status === "sent") {
    await markSent(id, result.messageId);
    return;
  }
  if (result.status === "unknown") {
    await markUnknown(id, result.error ?? "发送结果未知");
    return;
  }
  await markFailed(id, result.error ?? "发送失败");
  throw new Error(result.error ?? "feishu send failed");
}

/**
 * Write the ledger for the latest issue of each kind: only readers who asked for it, only issues generated
 * after they subscribed, only fresh issues. The unique key makes repeated sweeps and regenerated reports
 * harmless. Rows and their jobs commit together, so a crash cannot leave a ledger row with no job.
 */
export async function sweepSubscriptions(now = new Date()): Promise<{ users: number; created: number; recovered: number; disabled?: boolean }> {
  if (!config.feishuReaderPushEnabled) return { users: 0, created: 0, recovered: 0, disabled: true };
  const reports = await latestReports(now);
  const wanted = await enabledSubscriptions();
  const rows: Array<{ userId: number; kind: ReportKind; key: string }> = [];
  for (const sub of wanted) {
    for (const r of reports) {
      if (r.kind === "daily" && !sub.daily) continue;
      if (r.kind === "weekly" && !sub.weekly) continue;
      if (r.kind === "monthly" && !sub.monthly) continue;
      if (r.generated_at.getTime() < sub.created_at.getTime()) continue;
      rows.push({ userId: sub.user_id, kind: r.kind, key: r.key });
    }
  }
  const recoveredSending = await markStaleSending(now);
  const pending = await stalePending(now);
  const created = await sql.begin(async (tx) => {
    const ids = await insertDeliveries(tx, rows);
    for (const id of [...ids, ...pending]) await enqueueOn(DELIVER_QUEUE, { id }, {}, tx);
    return ids.length;
  });
  return { users: wanted.length, created, recovered: recoveredSending + pending.length };
}

// ---------------------------------------------------------------------------------------------------
// The module's alerts and retention.

async function alerts(now: number): Promise<Finding[]> {
  if (!config.feishuReaderPushEnabled) return [];
  const out: Finding[] = [];
  if (!credential("integrations", "FEISHU_APP_ID") || !credential("integrations", "FEISHU_APP_SECRET")) {
    out.push({
      key: "subscriptions.messaging-unconfigured", level: "today",
      title: "同事的飞书推送开着，但消息应用没有配好",
      impact: "订阅了的同事收不到报告。",
      action: "在 .env 里填 FEISHU_APP_ID 和 FEISHU_APP_SECRET，然后重启 api 和 worker。",
      detail: "FEISHU_READER_PUSH_ENABLED=true but FEISHU_APP_ID/FEISHU_APP_SECRET is empty",
    });
  }
  const health = await deliveryHealth(new Date(now));
  if (health.sent === 0 && health.failed >= 3) {
    out.push({
      key: "subscriptions.delivery-failing", level: "today",
      title: "给同事的飞书推送最近没有发出去",
      impact: "订阅了的同事收不到报告。",
      heals: "下一次重试成功后会自动恢复。",
      action: "看后台「运行」里的 subscriptions.deliver，确认飞书应用的发送权限和可用范围。",
      detail: health.lastError ?? undefined,
      since: new Date(now - 24 * 3600_000),
    });
  }
  return out;
}

export default {
  name: "subscriptions",
  http: registerRoutes,
  queues: [DELIVER_QUEUE],
  schedules: [DELIVER_SCHEDULE],
  alerts,
  retention: (now) => runRetention(now),
} satisfies ServerModule;

// Kept for the route tests and for anyone reading this file top-down: the callback is the address the
// Feishu console must know about.
export { callbackUrl };
