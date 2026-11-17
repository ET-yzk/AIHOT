import { Link, useLoaderData, useSearchParams } from "react-router";
import type { Screen } from "../../../apps/web/app/components/shell/screens";
import { EmptyState } from "../../../apps/web/app/components/ui/Page";
import { cachedPage, loadOr404, pageHeaders } from "../../../apps/web/app/lib/api.server";
import { pageMeta } from "../../../apps/web/app/lib/seo";
import type { Facets, ListResult } from "../read.ts";
import { LifecycleBadge, SyncBand, TagList, dateText, itemTitleHref } from "./parts.tsx";

export const handle: Screen = { tab: "featured", name: "法规信源" };
export { pageHeaders as headers };

const FILTERS: Array<{ key: string; label: string; facet: keyof Facets }> = [
  { key: "region", label: "地区", facet: "region" },
  { key: "lifecycle", label: "生命周期", facet: "lifecycle" },
  { key: "business", label: "业务分类", facet: "businessCategory" },
  { key: "cert", label: "认证类型", facet: "certType" },
  { key: "archived", label: "原文入库", facet: "archived" },
  { key: "subscription", label: "订阅状态", facet: "subscription" },
];

const SORTS: Array<{ key: string; label: string }> = [
  { key: "updated", label: "最近更新" },
  { key: "published", label: "发布日期" },
  { key: "effective", label: "实施日期（近的在前）" },
  { key: "effectiveAsc", label: "实施日期（远的在前）" },
];

const SIZES = [15, 30, 50];
const CONTROL = "h-9 rounded-control border border-line-strong bg-surface px-2.5 text-[13px] text-ink-2 focus:border-accent focus:outline-none";

function queryString(searchParams: URLSearchParams): string {
  const qs = new URLSearchParams();
  for (const key of ["q", "sort", "page", "size"]) {
    const value = searchParams.get(key);
    if (value) qs.set(key, value);
  }
  for (const { key } of FILTERS) for (const value of searchParams.getAll(key)) qs.append(key, value);
  const s = qs.toString();
  return s ? "?" + s : "";
}

export async function loader({ request }: { request: Request }) {
  const searchParams = new URL(request.url).searchParams;
  const data = await loadOr404<ListResult>(`/api/site/source-table${queryString(searchParams)}`, { signal: request.signal });
  return cachedPage(60, { data });
}

export function meta() {
  return pageMeta({
    title: "法规信源",
    description: "车载法规与测评规程台账：按生命周期、地区与业务分类查全部法规，含实施日期、影响评估与官方原文。",
    path: "/sources",
  });
}

function PageLink({ to, children, current }: { to: string; children: React.ReactNode; current?: boolean }) {
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-[13px] transition-colors ${current ? "bg-ink text-bg" : "text-ink-3 hover:text-ink"}`}
    >
      {children}
    </Link>
  );
}

export default function SourceTablePage() {
  const { data } = useLoaderData<{ data: ListResult }>();
  const [searchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") ?? "updated";
  const active = FILTERS.flatMap(({ key, label }) => searchParams.getAll(key).map((value) => ({ key, label, value })));
  const hasFilters = active.length > 0 || q !== "";

  const hrefWith = (mutate: (sp: URLSearchParams) => void) => {
    const sp = new URLSearchParams(searchParams);
    mutate(sp);
    sp.delete("page");
    const s = sp.toString();
    return s ? `/sources?${s}` : "/sources";
  };
  const pageHref = (page: number) => {
    const sp = new URLSearchParams(searchParams);
    if (page <= 1) sp.delete("page");
    else sp.set("page", String(page));
    const s = sp.toString();
    return s ? `/sources?${s}` : "/sources";
  };

  const pages = [...new Set([1, data.pageCount, data.page - 1, data.page, data.page + 1])]
    .filter((p) => p >= 1 && p <= data.pageCount)
    .sort((a, b) => a - b);

  return (
    <div className="pb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">法规信源</h1>
          <p className="mt-1 text-[14px] text-ink-4">车载法规与测评规程台账：谁在管哪些法规、管到哪一步。</p>
        </div>
        <p className="num text-[12.5px] text-ink-4">共 {data.total} 条</p>
      </div>

      <form method="get" action="/sources" className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="搜索法规编号、名称、发布机构…"
          className={`${CONTROL} min-w-[220px] flex-1 px-3 text-[13.5px] text-ink placeholder:text-ink-4`}
        />
        <details className="relative">
          <summary className={`${CONTROL} inline-flex cursor-pointer list-none items-center gap-1.5 select-none`}>
            筛选{active.length > 0 ? <span className="rounded-full bg-accent px-1.5 text-[11px] text-accent-contrast">{active.length}</span> : null}
          </summary>
          <div className="absolute right-0 z-30 mt-2 max-h-[70vh] w-[300px] overflow-auto rounded-panel border border-line bg-surface p-3 shadow-xl">
            {FILTERS.map(({ key, label, facet }) => {
              const options = data.facets[facet];
              if (options.length === 0) return null;
              return (
                <fieldset key={key} className="mb-3 last:mb-0">
                  <legend className="mb-1 text-[12px] text-ink-4">{label}</legend>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {options.map((option) => {
                      const checked = searchParams.getAll(key).includes(option.value);
                      return (
                        <label key={option.value} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
                          <input type="checkbox" name={key} value={option.value} defaultChecked={checked} className="accent-[var(--accent)]" />
                          {option.value}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
            <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-2">
              <Link to="/sources" className="text-[12px] text-ink-4 hover:text-accent">清除全部</Link>
              <button type="submit" className="h-8 rounded-control bg-accent px-3 text-[12.5px] text-accent-contrast">查看结果</button>
            </div>
          </div>
        </details>
        <select name="sort" defaultValue={sort} className={CONTROL} aria-label="排序">
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {searchParams.get("size") && <input type="hidden" name="size" value={searchParams.get("size") as string} />}
        <noscript>
          <button type="submit" className="h-9 rounded-control border border-line-strong px-3 text-[13px] text-ink-2">应用</button>
        </noscript>
      </form>

      {active.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
          {active.map((chip) => (
            <Link
              key={chip.key + chip.value}
              to={hrefWith((sp) => {
                const rest = sp.getAll(chip.key).filter((v) => v !== chip.value);
                sp.delete(chip.key);
                for (const value of rest) sp.append(chip.key, value);
              })}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-ink-2 hover:border-accent hover:text-accent"
            >
              {chip.value}
              <span aria-hidden className="text-ink-4">×</span>
            </Link>
          ))}
          <Link to="/sources" className="text-ink-4 hover:text-accent">清除全部</Link>
        </div>
      )}

      {data.total === 0 ? (
        <div className="mt-6 lg:card">
          <EmptyState title={hasFilters ? "没有符合条件的法规" : "还没有同步到法规"}>
            <p className="text-[13px] text-ink-4">
              {hasFilters ? "换个条件试试，或者" : "数据从飞书「信源表_v2.0」同步过来，同步完成后这里会自动出现。"}
              {hasFilters && <Link to="/sources" className="ml-1 text-accent hover:underline">看全部</Link>}
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="mt-4 hidden lg:block">
            <table className="w-full table-fixed border-collapse text-left">
              <thead>
                <tr className="border-b border-line text-[11.5px] tracking-[0.06em] text-ink-4">
                  <th className="w-[132px] py-2 pr-3 font-normal">法规编号</th>
                  <th className="py-2 pr-3 font-normal">法规全称</th>
                  <th className="w-[64px] py-2 pr-3 font-normal">地区</th>
                  <th className="w-[96px] py-2 pr-3 font-normal">生命周期</th>
                  <th className="w-[190px] py-2 pr-3 font-normal">业务分类</th>
                  <th className="w-[96px] py-2 pr-3 font-normal">发布日期</th>
                  <th className="w-[96px] py-2 pr-3 font-normal">实施日期</th>
                  <th className="w-[150px] py-2 font-normal">发布机构</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.slug} className="border-b border-line-soft align-middle hover:bg-bg-muted/60">
                    <td className="py-2.5 pr-3">
                      <Link to={itemTitleHref(item)} className="num whitespace-nowrap text-[12.5px] text-ink-2 hover:text-accent hover:underline">
                        {item.code ?? "—"}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Link to={itemTitleHref(item)} className="block truncate text-[13.5px] text-ink hover:text-accent" title={item.title}>
                        {item.title}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-[12.5px] text-ink-3">{item.region ?? "—"}</td>
                    <td className="py-2.5 pr-3"><LifecycleBadge value={item.lifecycle} /></td>
                    <td className="py-2.5 pr-3"><TagList values={item.businessCategories.slice(0, 3)} /></td>
                    <td className="num whitespace-nowrap py-2.5 pr-3 text-[12.5px] text-ink-3">{dateText(item.publishedOn)}</td>
                    <td className="num whitespace-nowrap py-2.5 pr-3 text-[12.5px] text-ink-3">{dateText(item.effectiveOn)}</td>
                    <td className="py-2.5">
                      <span className="block truncate text-[12.5px] text-ink-3" title={item.publishOrg ?? ""}>{item.publishOrg ?? "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-4 flex flex-col gap-2 lg:hidden">
            {data.items.map((item) => (
              <li key={item.slug}>
                <Link to={itemTitleHref(item)} className="block rounded-card border border-line bg-surface p-3">
                  <span className="flex items-start justify-between gap-2">
                    <span className="num text-[12px] text-ink-3">{item.code ?? "—"}</span>
                    <LifecycleBadge value={item.lifecycle} />
                  </span>
                  <span className="mt-1 block text-[14px] leading-snug text-ink">{item.title}</span>
                  <span className="mt-1.5 block text-[12px] text-ink-4">
                    {item.region ?? "—"} · 实施 {dateText(item.effectiveOn)}
                  </span>
                  <span className="mt-2 block"><TagList values={item.businessCategories} /></span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[12.5px] text-ink-4">
            <div className="flex items-center gap-2">
              <span className="num">共 {data.total} 条</span>
              <span className="flex items-center gap-1">
                {SIZES.map((size) => (
                  <PageLink key={size} to={hrefWith((sp) => { if (size === 15) sp.delete("size"); else sp.set("size", String(size)); })} current={data.pageSize === size}>
                    {size}
                  </PageLink>
                ))}
                <span>条/页</span>
              </span>
            </div>
            {data.pageCount > 1 && (
              <nav aria-label="分页" className="flex items-center gap-4 lg:gap-1">
                {data.page > 1 && <PageLink to={pageHref(data.page - 1)}>上一页</PageLink>}
                <span className="num lg:hidden">{data.page} / {data.pageCount}</span>
                <span className="hidden items-center gap-1 lg:flex">
                  {pages.map((p, i) => (
                    <span key={p} className="flex items-center gap-1">
                      {i > 0 && p - pages[i - 1]! > 1 && <span className="px-0.5 text-ink-4">…</span>}
                      <PageLink to={pageHref(p)} current={p === data.page}>{p}</PageLink>
                    </span>
                  ))}
                </span>
                {data.page < data.pageCount && <PageLink to={pageHref(data.page + 1)}>下一页</PageLink>}
              </nav>
            )}
          </div>

          <SyncBand sync={data.sync} />
        </>
      )}
    </div>
  );
}
