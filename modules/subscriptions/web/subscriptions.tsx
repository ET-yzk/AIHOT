import { useEffect, useState } from "react";
import { data, useLoaderData } from "react-router";
import type {
  DeliveryStatus, DeliveryView, FavoriteSuggestion, ReaderMe, SubscriptionInput, SubscriptionOptions,
} from "@aihot/contracts/subscriptions";
import { REPORT_NAMES } from "@aihot/contracts/site";
import { EDITION_WHEN, SITE } from "@aihot/site";
import { API_BASE_URL, loadOr404 } from "../../../apps/web/app/lib/api.server";
import { pageMeta } from "../../../apps/web/app/lib/seo";
import { fullDateTime } from "../../../apps/web/app/lib/format";
import { useStarred } from "../../../apps/web/app/lib/local-state";
import { PhoneBar } from "../../../apps/web/app/components/shell/PhoneBar";
import { buttonClass } from "../../../apps/web/app/components/ui/Controls";
import type { Screen } from "../../../apps/web/app/components/shell/screens";

export const handle: Screen = { tab: "me", name: "订阅" };

/** A private page: the browser and every cache keep no copy of the reader's settings or deliveries. */
export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export function meta() {
  return pageMeta({
    title: "订阅",
    description: `用飞书登录，订阅 ${SITE.name} 的日报、周报和月报，直接发到你的飞书单聊。`,
    path: "/subscriptions",
    noindex: true,
  });
}

export async function loader({ request }: { request: Request }) {
  const options = await loadOr404<SubscriptionOptions>("/api/subscriptions/options", { signal: request.signal });
  const cookie = request.headers.get("cookie");
  const res = await fetch(`${API_BASE_URL}/api/subscriptions/me`, {
    headers: { accept: "application/json", "x-aihot-ssr": "1", ...(cookie ? { cookie } : {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  let me: ReaderMe | null = null;
  if (res.status === 401) me = null;
  else if (res.ok) me = (await res.json()) as ReaderMe;
  else throw data({ message: "unavailable" }, { status: 503 });
  return { options, me, loginError: new URL(request.url).searchParams.get("login") };
}

const DEFAULT_FORM: SubscriptionInput = {
  enabled: true, daily: true, weekly: true, monthly: false, scope: "all", categories: [], topics: [],
};

function formOf(sub: SubscriptionInput): SubscriptionInput {
  return {
    enabled: sub.enabled, daily: sub.daily, weekly: sub.weekly, monthly: sub.monthly,
    scope: sub.scope, categories: [...sub.categories], topics: [...sub.topics],
  };
}

const STATUS: Record<DeliveryStatus, string> = {
  pending: "等待发送", sending: "发送中", sent: "已发送", failed: "发送失败", skipped: "没有发送", unknown: "结果未知",
};

/** What the reader needs to know about a push; the technical error stays out of their page. */
function deliveryNote(d: DeliveryView): string | null {
  if (d.status === "failed") return "发送失败，系统会自动再试。";
  if (d.status === "unknown") return "结果未知，可能已经发出；请先看飞书，不要重复点测试。";
  if (d.status === "skipped") return d.error;
  return null;
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2.5">
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-1 size-4 shrink-0 accent-accent" />
      <span className="min-w-0">
        <span className="block text-[15px] font-medium text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-4">{hint}</span>}
      </span>
    </label>
  );
}

function Scope({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2.5">
      <input type="radio" name="subscription-scope" checked={checked} onChange={onChange} className="mt-1 size-4 shrink-0 accent-accent" />
      <span className="min-w-0">
        <span className="block text-[15px] font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-4">{hint}</span>
      </span>
    </label>
  );
}

export default function SubscriptionsPage() {
  const { options, me, loginError } = useLoaderData<{ options: SubscriptionOptions; me: ReaderMe | null; loginError: string | null }>();
  const starred = useStarred();
  const [mounted, setMounted] = useState(false);
  const [form, setForm] = useState<SubscriptionInput>(() => (me?.subscription ? formOf(me.subscription) : { ...DEFAULT_FORM }));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [suggestion, setSuggestion] = useState<FavoriteSuggestion | null>(null);
  useEffect(() => setMounted(true), []);

  const set = <K extends keyof SubscriptionInput>(key: K, value: SubscriptionInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleCategory = (key: string) => setForm((f) => ({
    ...f,
    categories: f.categories.includes(key) ? f.categories.filter((k) => k !== key) : [...f.categories, key],
  }));
  const toggleTopic = (slug: string) => setForm((f) => ({
    ...f,
    topics: f.topics.includes(slug) ? f.topics.filter((s) => s !== slug) : [...f.topics, slug],
  }));

  const save = async () => {
    if (!me) return;
    if (form.enabled && !form.daily && !form.weekly && !form.monthly) {
      setNotice({ kind: "error", text: "开启推送时，至少选日报、周报或月报中的一期。" });
      return;
    }
    if (form.enabled && form.scope === "categories" && form.categories.length === 0) {
      setNotice({ kind: "error", text: "请至少选择一个分类。" });
      return;
    }
    if (form.enabled && form.scope === "topics" && form.topics.length === 0) {
      setNotice({ kind: "error", text: "请至少选择一个主题。" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": me.csrf },
        body: JSON.stringify(form),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "保存失败，请稍后再试。");
      setNotice({ kind: "ok", text: "已保存。下一期出刊后会按这个设置推送。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "保存失败，请稍后再试。" });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!me) return;
    setBusy(true);
    try {
      const res = await fetch("/api/subscriptions/test", { method: "POST", headers: { "x-csrf-token": me.csrf } });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "发送失败，请稍后再试。");
      setNotice({ kind: "ok", text: "测试消息已发出，请打开飞书看看。" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "发送失败，请稍后再试。" });
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    if (!me) return;
    await fetch("/api/subscriptions/auth/logout", { method: "POST", headers: { "x-csrf-token": me.csrf } });
    window.location.assign("/subscriptions");
  };

  const remove = async () => {
    if (!me) return;
    if (!window.confirm("删除后，订阅设置和推送记录都会删除，且无法恢复。确定删除吗？")) return;
    await fetch("/api/subscriptions/me", { method: "DELETE", headers: { "x-csrf-token": me.csrf } });
    window.location.assign("/subscriptions");
  };

  const suggest = async () => {
    if (starred.length === 0) {
      setNotice({ kind: "error", text: "这台设备上还没有收藏，先收藏几条内容再来试试。" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/subscriptions/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIds: starred.map((s) => s.id) }),
      });
      const body = (await res.json().catch(() => null)) as (FavoriteSuggestion & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error ?? "暂时无法推荐，请稍后再试。");
      setSuggestion(body);
      setNotice({ kind: "ok", text: `根据这台设备上的 ${body.total} 条收藏，整理了下面的分类和主题。` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "暂时无法推荐，请稍后再试。" });
    } finally {
      setBusy(false);
    }
  };

  const adoptCategories = () => {
    if (!suggestion) return;
    setForm((f) => ({ ...f, scope: "categories", categories: suggestion.categories.map((c) => c.key) }));
  };
  const adoptTopics = () => {
    if (!suggestion) return;
    setForm((f) => ({ ...f, scope: "topics", topics: suggestion.topics.map((t) => t.slug) }));
  };

  const name = me?.user.name?.trim() || "飞书用户";

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="订阅" />
      <header className="pb-4 pt-3 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">订阅</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">{`${SITE.name} 的日报、周报和月报，可以直接发到你的飞书单聊。`}</p>
      </header>

      {!me ? (
        <section className="card p-5">
          <h2 className="text-[17px] font-semibold text-ink">用飞书登录，订阅 {SITE.name}</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            登录后可以选择只收日报、周报或月报，也可以只看你关心的分类和主题。报告会以飞书卡片发到你的单聊。
            阅读和收藏不需要登录，收藏仍然只保存在这台设备上。
          </p>
          {options.loginConfigured ? (
            <a href="/api/subscriptions/auth/login?return=/subscriptions" className={`${buttonClass("primary")} mt-4`}>
              用飞书登录
            </a>
          ) : (
            <p className="mt-4 text-[13px] text-ink-4">管理员还没有配置飞书登录，暂时不能订阅。</p>
          )}
          {loginError === "failed" && <p className="mt-3 text-[13px] text-hot">登录没有完成，请再试一次。</p>}
          {loginError === "unconfigured" && <p className="mt-3 text-[13px] text-ink-4">管理员还没有配置飞书登录。</p>}
        </section>
      ) : (
        <div className="space-y-4">
          <section className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 items-center gap-3">
              {me.user.avatarUrl ? (
                <img src={me.user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" />
              ) : (
                <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-[16px] font-semibold text-accent">
                  {name.slice(0, 1)}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-[16px] font-semibold text-ink">{name}</p>
                <p className="text-[12.5px] text-ink-4">已用飞书登录</p>
              </div>
            </div>
            <button type="button" onClick={logout} className="text-[12.5px] text-ink-3 transition-colors hover:text-accent">
              退出登录
            </button>
          </section>

          <section className="card px-4 py-2">
            <Check
              checked={form.enabled}
              onChange={() => set("enabled", !form.enabled)}
              label="接收飞书推送"
              hint="关掉后不再发新报告；已经保存的分类和主题会留着。"
            />
            <div className="border-t border-line-soft">
              <Check checked={form.daily} onChange={() => set("daily", !form.daily)} label="日报" hint={`${EDITION_WHEN.daily} 出刊，当天的重要动态`} />
              <Check checked={form.weekly} onChange={() => set("weekly", !form.weekly)} label="周报" hint={`${EDITION_WHEN.weekly} 出刊，一周的脉络`} />
              <Check checked={form.monthly} onChange={() => set("monthly", !form.monthly)} label="月报" hint={`${EDITION_WHEN.monthly} 出刊，一个月的回顾`} />
            </div>
          </section>

          <section className="card px-4 py-2">
            <h2 className="pt-2 text-[15px] font-semibold text-ink">推什么内容</h2>
            <Scope checked={form.scope === "all"} onChange={() => set("scope", "all")} label="全部内容" hint="每期都发；这一期没有大事时，也会收到一句说明。" />
            <Scope checked={form.scope === "categories"} onChange={() => set("scope", "categories")} label="只看这些分类" hint="只发包含所选分类的期；没有就不发。" />
            {form.scope === "categories" && (
              <div className="grid grid-cols-2 gap-2 pb-3 pl-7 sm:grid-cols-3">
                {options.categories.map((c) => (
                  <label key={c.key} className={`flex cursor-pointer items-center gap-2 rounded-card border px-3 py-2.5 text-[14px] transition-colors ${form.categories.includes(c.key) ? "border-accent/40 bg-accent-soft text-accent" : "border-line-soft bg-surface text-ink-2 hover:border-line-strong"}`}>
                    <input type="checkbox" checked={form.categories.includes(c.key)} onChange={() => toggleCategory(c.key)} className="size-4 accent-accent" />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
            <Scope checked={form.scope === "topics"} onChange={() => set("scope", "topics")} label="只看这些主题" hint="只发包含所选主题的期；没有就不发。" />
            {form.scope === "topics" && (
              <div className="pb-3 pl-7">
                {options.groups.map((g) => {
                  const topics = options.topics.filter((t) => t.group === g.key);
                  if (topics.length === 0) return null;
                  return (
                    <div key={g.key}>
                      <h3 className="pb-1.5 pt-2 text-[12.5px] font-semibold text-ink-3">{g.name}</h3>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {topics.map((t) => (
                          <label key={t.slug} className={`flex cursor-pointer items-center gap-2 rounded-card border px-3 py-2.5 text-[14px] transition-colors ${form.topics.includes(t.slug) ? "border-accent/40 bg-accent-soft text-accent" : "border-line-soft bg-surface text-ink-2 hover:border-line-strong"}`}>
                            <input type="checkbox" checked={form.topics.includes(t.slug)} onChange={() => toggleTopic(t.slug)} className="size-4 accent-accent" />
                            {t.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-semibold text-ink">根据我的收藏推荐</h2>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-4">
                  只读取这台设备上的收藏，点一下才会把条目编号发给服务器统计分类和主题；不会保存你的收藏。
                </p>
              </div>
              <button type="button" onClick={suggest} disabled={busy} className={buttonClass("secondary")}>
                {mounted && starred.length > 0 ? `看看我的 ${starred.length} 条收藏` : "看看我的收藏"}
              </button>
            </div>
            {suggestion && (
              <div className="mt-3 rounded-card border border-line-soft bg-bg-sunk p-3">
                <p className="text-[13px] text-ink-3">根据 {suggestion.total} 条收藏：</p>
                {suggestion.categories.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-ink">分类</span>
                      <button type="button" onClick={adoptCategories} className="text-[12.5px] text-accent hover:underline">采用分类</button>
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-4">
                      {suggestion.categories.map((c) => `${c.label} ${c.count}`).join(" · ")}
                    </p>
                  </div>
                )}
                {suggestion.topics.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-ink">主题</span>
                      <button type="button" onClick={adoptTopics} className="text-[12.5px] text-accent hover:underline">采用主题</button>
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-ink-4">
                      {suggestion.topics.map((t) => `${t.name} ${t.count}`).join(" · ")}
                    </p>
                  </div>
                )}
                {suggestion.total === 0 && <p className="mt-1 text-[12.5px] text-ink-4">这些收藏暂时没有可用的分类或主题。</p>}
              </div>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={busy} className={buttonClass("primary")}>保存</button>
            <button type="button" onClick={sendTest} disabled={busy} className={buttonClass("secondary")}>发送测试消息</button>
          </div>
          {notice && <p role="status" className={`text-[13px] ${notice.kind === "ok" ? "text-accent" : "text-hot"}`}>{notice.text}</p>}

          <section className="card p-4">
            <h2 className="text-[15px] font-semibold text-ink">最近推送</h2>
            {me.deliveries.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-4">还没有推送记录。下一期出刊后，这里会显示结果。</p>
            ) : (
              <ul className="mt-1 divide-y divide-line-soft">
                {me.deliveries.map((d) => {
                  const note = deliveryNote(d);
                  return (
                    <li key={`${d.kind}:${d.reportKey}`} className="py-2.5 text-[13px]">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <a href={d.reportUrl} className="font-medium text-ink transition-colors hover:text-accent">
                          {REPORT_NAMES[d.kind]} · {d.reportKey}
                        </a>
                        <span className="text-ink-3">{STATUS[d.status]}</span>
                        <span className="text-ink-4">{fullDateTime(d.sentAt ?? d.createdAt)}</span>
                      </div>
                      {note && <p className="mt-0.5 text-[12px] text-ink-4">{note}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="flex justify-end">
            <button type="button" onClick={remove} className="text-[12.5px] text-ink-4 transition-colors hover:text-hot">
              删除我的订阅数据
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
