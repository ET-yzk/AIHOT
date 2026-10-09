import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { PoolResponse } from "@aihot/contracts/site";
import { cachedPage, loadOr404, pageHeaders } from "../../../apps/web/app/lib/api.server";
import { pageReuse } from "../../../apps/web/app/lib/page-reuse";
import { listPath, pageMeta } from "../../../apps/web/app/lib/seo";
import { DayList, Pagination } from "../../../apps/web/app/features/feed/DayList";
import { EmptyState } from "../../../apps/web/app/components/ui/Page";
import { Link } from "react-router";
import { IconArrowLeft } from "../../../apps/web/app/components/icons";
import type { Screen } from "../../../apps/web/app/components/shell/screens";

export const handle: Screen = { tab: "featured", name: "标准解读" };
export { pageHeaders as headers };
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const data = await loadOr404<PoolResponse>(
    listPath("/api/site/pool", { category: "standard", page: page > 1 ? page : null }),
    { signal: request.signal },
  );
  return cachedPage(60, { data });
}

export function meta() {
  return pageMeta({
    title: "标准解读",
    description: "推荐性国家标准、行业标准、团体标准与测评规程换版动态",
    path: "/standards",
  });
}

export default function StandardsPage() {
  const { data } = useLoaderData<{ data: PoolResponse }>();
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const busy = navigation.state === "loading";

  function pageHref(p: number) {
    const sp = new URLSearchParams(searchParams);
    if (p <= 1) sp.delete("page");
    else sp.set("page", String(p));
    const s = sp.toString();
    return s ? `/standards?${s}` : "/standards";
  }

  return (
    <div className="pb-6">
      <div className="mb-6">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">标准解读</h1>
        <p className="mt-1 text-[14px] text-ink-4">推荐性国家标准、行业标准、团体标准与测评规程换版动态</p>
      </div>

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState title="该分类下暂无内容">
              <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline">
                <IconArrowLeft size={14} />
                返回首页查看更多内容
              </Link>
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} todayCount={data.todayCount} />
        )}
      </div>

      <Pagination page={data.page} pageCount={data.pageCount} href={pageHref} />
    </div>
  );
}
