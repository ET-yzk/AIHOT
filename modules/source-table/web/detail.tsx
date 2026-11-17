import { Link, useLoaderData } from "react-router";
import type { Screen } from "../../../apps/web/app/components/shell/screens";
import { cachedPage, loadOr404, pageHeaders } from "../../../apps/web/app/lib/api.server";
import { pageMeta } from "../../../apps/web/app/lib/seo";
import type { SourceTableDetail, SourceTableField } from "../read.ts";
import { FieldRow, LifecycleBadge, NeutralBadge, SyncBand, TagList, dateText } from "./parts.tsx";

export const handle: Screen = { tab: "featured", name: "法规信源" };
export { pageHeaders as headers };

export async function loader({ params, request }: { params: { slug?: string }; request: Request }) {
  const data = await loadOr404<SourceTableDetail>(`/api/site/source-table/${encodeURIComponent(params.slug ?? "")}`, { signal: request.signal });
  return cachedPage(60, { data });
}

export function meta({ data }: { data?: { data: SourceTableDetail } }) {
  const row = data?.data;
  return [
    ...pageMeta({
      title: row ? (row.code ? `${row.code} ${row.title}` : row.title) : "法规信源",
      description: row?.fields.find((f) => f.label === "核心摘要")?.value?.toString().slice(0, 120) ?? "车载法规与测评规程台账",
      path: `/sources/${row?.slug ?? ""}`,
    }),
    { name: "robots", content: "noindex" },
  ];
}

const DATED = new Set(["实施日期", "发布日期", "征求意见截止", "报批稿截止", "修订日期"]);
const GROUP_ORDER: Array<{ group: SourceTableField["group"]; title: string }> = [
  { group: "内容", title: "摘要与影响" },
  { group: "日期", title: "关键日期" },
  { group: "范围", title: "适用范围" },
  { group: "分类", title: "分类与功能" },
  { group: "原文", title: "原文" },
];

function value(field: SourceTableField) {
  if (Array.isArray(field.value)) return field.value.length === 0 ? <span className="text-ink-4">—</span> : <TagList values={field.value} />;
  if (!field.value) return <span className="text-ink-4">—</span>;
  if (field.group === "原文") {
    return (
      <a href={field.value} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
        打开原文 ↗
      </a>
    );
  }
  return <span className="whitespace-pre-line">{field.value}</span>;
}

export default function SourceTableDetailPage() {
  const { data } = useLoaderData<{ data: SourceTableDetail }>();
  const body = GROUP_ORDER.map(({ group, title }) => ({ title, fields: data.fields.filter((f) => f.group === group && !f.meta) })).filter((s) => s.fields.length > 0);
  const summary = data.fields.find((f) => f.label === "核心摘要");
  const impact = data.fields.find((f) => f.label === "影响评估");
  const dates = data.fields.filter((f) => DATED.has(f.label));
  const lifecycle = data.fields.find((f) => f.label === "生命周期阶段");
  const meta = data.fields.filter((f) => f.meta);
  const origin = data.fields.find((f) => f.label === "原文链接");

  return (
    <article className="pb-6">
      <Link to="/sources" className="inline-flex items-center gap-1 text-[12.5px] text-ink-4 hover:text-accent">‹ 返回法规信源</Link>

      <header className="mt-3">
        <p className="num text-[12.5px] text-ink-3">{data.code ?? "—"}</p>
        <h1 className="mt-1 text-[26px] font-semibold leading-[1.3] text-ink">{data.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          <LifecycleBadge value={data.lifecycle} />
          <NeutralBadge value={data.certType} />
          <span>{data.region ?? "—"}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {origin?.value ? (
            <a href={origin.value as string} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center rounded-control border border-line-strong px-3 text-[12.5px] text-ink-2 hover:border-accent hover:text-accent">
              打开原文 ↗
            </a>
          ) : null}
          <Link to="/sources" className="inline-flex h-8 items-center rounded-control border border-line px-3 text-[12.5px] text-ink-3 hover:text-accent">
            回到列表
          </Link>
        </div>
      </header>

      <section className="mt-6">
        <h2 className="text-[13px] font-semibold tracking-[0.04em] text-ink-4">摘要与影响</h2>
        <p className="mt-3 text-[15px] leading-[1.8] text-ink-2">{summary?.value ?? <span className="text-ink-4">—</span>}</p>
        {impact?.value ? (
          <div className="mt-4 border-l-2 border-accent pl-3">
            <p className="text-[12px] tracking-[0.04em] text-ink-4">对我们意味着什么</p>
            <p className="mt-1 text-[14px] leading-[1.75] text-ink-2">{impact.value}</p>
          </div>
        ) : null}
      </section>

      <section className="mt-7">
        <h2 className="text-[13px] font-semibold tracking-[0.04em] text-ink-4">关键日期</h2>
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {dates.map((field) => (
            <div key={field.label} className="rounded-tile border border-line bg-surface px-3 py-2">
              <dt className="text-[11.5px] text-ink-4">{field.label}</dt>
              <dd className="num mt-1 text-[13px] text-ink-2">{dateText(Array.isArray(field.value) ? null : field.value)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-3">
          <span className="text-ink-4">生命周期阶段</span>
          <LifecycleBadge value={lifecycle?.value as string | null} />
        </div>
      </section>

      {body
        .filter((section) => section.title !== "摘要与影响" && section.title !== "关键日期")
        .map((section) => (
          <section key={section.title} className="mt-7">
            <h2 className="text-[13px] font-semibold tracking-[0.04em] text-ink-4">{section.title}</h2>
            <dl className="mt-2">
              {section.fields.map((field) => (
                <FieldRow key={field.label} label={field.label}>{value(field)}</FieldRow>
              ))}
            </dl>
          </section>
        ))}

      <details className="mt-7 rounded-card border border-line bg-surface px-3 py-2">
        <summary className="cursor-pointer text-[12.5px] text-ink-3 marker:text-ink-4">元数据 · 信源与维护信息</summary>
        <div className="mt-2">
          {(["信源与印证", "维护记录"] as const).map((group) => {
            const rows = meta.filter((f) => f.metaGroup === group);
            if (rows.length === 0) return null;
            return (
              <div key={group} className="mt-3 first:mt-1">
                <h3 className="text-[12px] text-ink-4">{group}</h3>
                <dl className="mt-1">
                  {rows.map((field) => (
                    <FieldRow key={field.label} label={field.label}>{value(field)}</FieldRow>
                  ))}
                </dl>
              </div>
            );
          })}
          {data.extra.length > 0 && (
            <div className="mt-3">
              <h3 className="text-[12px] text-ink-4">其他字段</h3>
              <dl className="mt-1">
                {data.extra.map((field) => (
                  <FieldRow key={field.label} label={field.label}>{field.value}</FieldRow>
                ))}
              </dl>
            </div>
          )}
        </div>
      </details>

      <SyncBand sync={data.sync} updatedAt={data.updatedOn} />
    </article>
  );
}
