// Deployment self-check: is this site wired up correctly, before anything is scheduled.
// It reads the database, the source registry and the budget rows; it never writes and never collects.
//   node scripts/doctor.ts            # exit 1 when something must be fixed
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import { SITE } from "@aihot/site";
import { MODELS } from "@aihot/backend/providers/llm";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { config, credential, REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

/** The gateway limit we stay under (design §9.4): the model service must not be budgeted above it. */
const GATEWAY_PER_MINUTE = Number(process.env.DOCTOR_GATEWAY_PER_MINUTE ?? 40);

let problems = 0;
function say(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) problems += 1;
}
function note(label: string, detail = "") {
  console.log(`– ${label}${detail ? `  ${detail}` : ""}`);
}

// ── 1. migrations ───────────────────────────────────────────────────────────────────────
const dir = path.join(REPO_ROOT, "database/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
try {
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const missing = files.filter((f) => !applied.has(f));
  say(missing.length === 0, `migrations ${files.length - missing.length}/${files.length}`, missing.join(", "));
  const unknown = [...applied].filter((n) => !files.includes(n));
  if (unknown.length) note("applied but no longer on disk", unknown.join(", "));
} catch (error) {
  say(false, "migrations", `${String(error)}  数据库不可达或未跑 node scripts/migrate.ts`);
  await closeDb();
  process.exit(1);
}

// ── 2. sources ──────────────────────────────────────────────────────────────────────────
const sources = await sql<{ id: string; name: string; kind: string; config: Record<string, unknown>; enabled: boolean; health: string; last_error: string | null; tier: string }[]>`
  SELECT id, name, kind, config, enabled, health, last_error, tier FROM sources ORDER BY id`;
say(sources.length > 0, `sources registered`, `${sources.length} 个`);

// A key the collector does not implement is silently ignored: menus and fragments land as articles.
const misconfigured = sources.filter((s) => s.enabled && unsupportedConfig(s.kind as never, s.config ?? {}).length);
for (const s of misconfigured) say(false, `source ${s.id}`, unsupportedConfig(s.kind as never, s.config ?? {}).join(", "));
if (!misconfigured.length) say(true, `source configs legal for their kinds`, `${sources.filter((s) => s.enabled).length} 个启用`);

// Sources the registry declares but the database never got: the seed did not run, or drifted.
const registryPath = path.join(REPO_ROOT, "industry/sources.json");
try {
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { sources: { id: string }[] };
  const inDb = new Set(sources.map((s) => s.id));
  const absent = registry.sources.map((s) => s.id).filter((id) => !inDb.has(id));
  if (absent.length) note("in industry/sources.json but not in the database", absent.join(", "));
  else say(true, "registry matches the database", `${registry.sources.length} 条`);
} catch (error) {
  note(`industry/sources.json unreadable`, String(error));
}

const failing = sources.filter((s) => s.enabled && s.health === "failing");
if (failing.length) for (const s of failing) note(`${s.id} health=failing`, (s.last_error ?? "").slice(0, 120));
else say(true, "no source is failing");
const degraded = sources.filter((s) => s.enabled && s.health === "degraded");
if (degraded.length) note("degraded", degraded.map((s) => s.id).join(", "));

// Every enabled source should carry a tier the selection thresholds know, or it never reaches 精选.
const unknownTier = [...new Set(sources.filter((s) => s.enabled).map((s) => s.tier))].filter((t) => !(t in SELECTION.thresholds) && t !== "EXCLUDE_MP");
if (unknownTier.length) note("tiers with no selection threshold (they only reach 全部动态)", unknownTier.join(", "));

// ── 3. budgets ──────────────────────────────────────────────────────────────────────────
const budgets = await sql<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
  SELECT service, per_minute, per_hour, per_day FROM budgets`;
const byService = new Map(budgets.map((b) => [b.service, b]));
// A model preset whose credentials are configured will be called: it needs a budget row above zero.
const liveModelServices = [...new Set(Object.values(MODELS).filter((m) => credential("models", m.baseUrlEnv) && credential("models", m.apiKeyEnv)).map((m) => m.service))];
for (const service of liveModelServices) {
  const row = byService.get(service);
  if (!row) say(false, `budget for ${service}`, "没有预算行，付费请求会被拒");
  else say(row.per_minute > 0 && row.per_hour > 0 && row.per_day > 0, `budget ${service}`, `每分钟 ${row.per_minute}，每小时 ${row.per_hour}，每天 ${row.per_day}`);
  if (row && row.per_minute > GATEWAY_PER_MINUTE) note(`${service} 高于网关限额`, `每分钟 ${row.per_minute} > ${GATEWAY_PER_MINUTE}，会先被服务商限流而不是被本站熔掉`);
}
if (!liveModelServices.length) say(false, "no model service is configured", `LLM_BASE_URL / LLM_API_KEY 都没设，读者看到的还是英文原文`);
const stopped = budgets.filter((b) => b.per_minute === 0 || b.per_hour === 0 || b.per_day === 0);
if (stopped.length) note("services stopped by a zero budget", stopped.map((b) => b.service).join(", "));

// ── 4. knowledge layer (stage three) ────────────────────────────────────────────────────
// Reachability only when a peer is named: the guard refuses private addresses otherwise, and the
// narrow allowlist is the sanctioned way in (production never opens ALLOW_PRIVATE_NETWORK_FETCH).
const knowledgeUrl = process.env.WEKNORA_BASE_URL ?? "";
if (!knowledgeUrl) note("knowledge layer", "未配置 WEKNORA_BASE_URL（阶段三才需要）");
else {
  const host = (() => { try { const u = new URL(knowledgeUrl); return `${u.hostname}${u.port ? `:${u.port}` : ""}`; } catch { return ""; } })();
  if (!host) say(false, "knowledge layer", `WEKNORA_BASE_URL 不是合法地址`);
  else if (!config.internalEgressAllow.some((e) => e === host || e === new URL(knowledgeUrl).hostname)) {
    say(false, `knowledge layer ${host}`, "不在 INTERNAL_EGRESS_ALLOW 里，直连会被 SSRF 防护拒绝");
  } else {
    try {
      const { guardedFetch } = await import("@aihot/backend/lib/http-fetch");
      const res = await guardedFetch(knowledgeUrl.replace(/\/$/, "") + "/health", { route: "direct", timeoutMs: 5_000, maxBytes: 64 * 1024 });
      say(res.status < 500, `knowledge layer ${host}`, `HTTP ${res.status}`);
    } catch (error) {
      say(false, `knowledge layer ${host}`, String(error).slice(0, 160));
    }
  }
}

// ── 5. the switches a deploy expects ────────────────────────────────────────────────────
say(process.env.COLLECT_ENABLED !== "false", "COLLECT_ENABLED", "关掉以后信源不再抓取");
say(config.modelCallsEnabled, "MODEL_CALLS_ENABLED", "关掉以后不会有中文标题和摘要");
note("site", `${SITE.name} · ${CATEGORIES.length} 个分类 · 首页 ${config.siteUrl}`);
if (config.allowPrivateNetworkFetch) note("ALLOW_PRIVATE_NETWORK_FETCH 是打开的", "生产环境会拒绝启动，只用于本机调试");

console.log(problems ? `\n${problems} 项需要处理` : "\n全部通过");
await closeDb();
process.exit(problems ? 1 : 0);
