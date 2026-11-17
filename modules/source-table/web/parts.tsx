// Small pieces both pages draw: the footer's sync band, lifecycle badges, and field values.
// Presentation only — data comes from the page's loader.
import type { SourceTableItem, SourceTableSync } from "../read.ts";

const LIFE: Record<string, string> = {
  正式发布: "bg-ok-soft text-ok-ink",
  征求意见稿: "bg-amber-soft text-amber-ink",
  报批稿: "bg-amber-soft text-amber-ink",
  已修订: "bg-accent-soft text-accent-ink",
  已废止: "bg-hot-soft text-hot",
  起草中: "bg-bg-muted text-ink-3",
};

export function LifecycleBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-ink-4">—</span>;
  const tone = LIFE[value] ?? "bg-bg-muted text-ink-3";
  return <span className={`inline-flex h-[18px] items-center whitespace-nowrap rounded-full px-2 text-[11px] font-semibold ${tone}`}>{value}</span>;
}

export function NeutralBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-ink-4">—</span>;
  return <span className="inline-flex h-[18px] items-center whitespace-nowrap rounded-full bg-bg-muted px-2 text-[11px] font-semibold text-ink-3">{value}</span>;
}

export function TagList({ values, extra = 0 }: { values: string[]; extra?: number }) {
  if (values.length === 0 && extra === 0) return <span className="text-ink-4">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[12px] text-ink-2">
          {v}
        </span>
      ))}
      {extra > 0 && <span className="num whitespace-nowrap text-[11.5px] text-ink-4">+{extra}</span>}
    </span>
  );
}

/** YYYY-MM-DD stays as it is; the reader scans one date with no locale formatting to parse. */
export function dateText(value: string | null): string {
  return value ?? "—";
}

export function fmtInstant(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const STATUS_TEXT: Record<string, string> = {
  ok: "信源同步于",
  failed: "本次同步失败 · 上次成功",
  never: "还没同步过",
  disabled: "同步未开启",
  unconfigured: "未配置同步",
};

/**
 * The band under the page: status on the left, the Feishu table on the right. A failure is shown here
 * and nowhere else (no banner): the dot turns red and the line says when it last worked.
 */
export function SyncBand({ sync, updatedAt }: { sync: SourceTableSync; updatedAt?: string | null }) {
  const ok = sync.status === "ok";
  const stamp = sync.status === "failed" ? sync.lastOkAt : sync.lastOkAt ?? sync.at;
  const head = STATUS_TEXT[sync.status] ?? "信源同步于";
  const shown = sync.status === "failed" ? fmtInstant(sync.lastOkAt) : fmtInstant(stamp);
  const dot = ok ? "bg-ok" : sync.status === "failed" ? "bg-hot" : "bg-ink-4";
  return (
    <div className={`mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-3 text-[12px] ${sync.status === "failed" ? "text-hot" : "text-ink-4"}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="group relative inline-flex items-center">
          <span className="relative flex h-[7px] w-[7px] shrink-0">
            {ok && <span className="absolute inset-0 rounded-full bg-ok opacity-50 motion-safe:animate-ping motion-reduce:hidden" style={{ animationDuration: "2.8s" }} />}
            <span className={`relative h-[7px] w-[7px] rounded-full ${dot}`} />
          </span>
          <span
            tabIndex={0}
            className="absolute bottom-4 left-0 z-20 hidden w-[228px] rounded-tile border border-line bg-surface p-2.5 text-left text-[11.5px] text-ink-2 shadow-lg group-focus-within:block group-hover:block"
          >
            <span className="mb-1 block font-semibold text-ink">最近 5 次同步</span>
            {sync.runs.length === 0 && <span className="block text-ink-4">还没有记录</span>}
            {sync.runs.map((run) => (
              <span key={run.at} className="flex items-center justify-between gap-2 py-0.5">
                <span className="num text-ink-3">{fmtInstant(run.at)}</span>
                <span className={run.ok ? "text-ok-ink" : "text-hot"}>{run.ok ? `成功 · ${run.rows} 条` : "失败"}</span>
              </span>
            ))}
            <span className="mt-1 flex items-center justify-between gap-2 border-t border-line-soft pt-1">
              <span className="text-ink-4">频率</span>
              <span>{sync.every}</span>
            </span>
          </span>
        </span>
        <span className="truncate">
          {head} {shown}
          {updatedAt ? ` · 法规信息更新于 ${updatedAt}` : ""}
        </span>
      </span>
      <span className="text-ink-3">
        数据源{" "}
        {sync.webUrl ? (
          <a href={sync.webUrl} target="_blank" rel="noreferrer" className="hover:text-accent">
            飞书「{sync.tableName}」
          </a>
        ) : (
          <span>飞书「{sync.tableName}」</span>
        )}
      </span>
    </div>
  );
}

/** One row of the detail page's body or its 元数据 block. */
export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3 border-b border-line-soft py-2 last:border-0 sm:grid-cols-[128px_1fr]">
      <dt className="text-[12.5px] text-ink-4">{label}</dt>
      <dd className="min-w-0 text-[13.5px] text-ink-2">{children}</dd>
    </div>
  );
}

export function itemTitleHref(item: SourceTableItem): string {
  return `/sources/${encodeURIComponent(item.slug)}`;
}
