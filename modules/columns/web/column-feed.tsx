import { Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { PoolResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import {
  cachedPage,
  loadOr404,
  pageHeaders,
} from "../../../apps/web/app/lib/api.server";
import { pageReuse } from "../../../apps/web/app/lib/page-reuse";
import { listPath, pageMeta, itemListLd } from "../../../apps/web/app/lib/seo";
import { DayList, Pagination } from "../../../apps/web/app/features/feed/DayList";
import { EmptyState } from "../../../apps/web/app/components/ui/Page";
import { IconArrowLeft } from "../../../apps/web/app/components/icons";
import type { Screen } from "../../../apps/web/app/components/shell/screens";

export { pageHeaders as headers };
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export const handle: Screen = { tab: "featured", name: "专栏" };

interface ColumnConfig {
  path: string;
  category: string;
  title: string;
  description: string;
}

const COLUMNS: Record<string, ColumnConfig> = {
  "/regulations": {
    path: "/regulations",
    category: "regulation",
    title: "法规追踪",
    description: "国内外车载法规动态：征求意见稿、正式发布、修订与废止，第一时间追踪",
  },
  "/standards": {
    path: "/standards",
    category: "standard",
    title: "标准解读",
    description: "推荐性国家标准、行业标准、团体标准与测评规程换版动态",
  },
  "/ncap": {
    path: "/ncap",
    category: "ncap",
    title: "NCAP 评测",
    description: "C-NCAP、Euro NCAP、IVISTA 等测评结果与规程更新",
  },
  "/oem": {
    path: "/oem",
    category: "customer",
    title: "车企动态",
    description: "整车厂与零部件伙伴的技术合作、产品规划与市场动向",
  },
};

function resolveColumn(pathname: string): ColumnConfig {
  return COLUMNS[pathname] ?? COLUMNS["/regulations"];
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const col = resolveColumn(url.pathname);
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const data = await loadOr404<PoolResponse>(
    listPath("/api/site/pool", { category: col.category, page: page > 1 ? page : null }),
    { signal: request.signal },
  );
  return cachedPage(60, { data, column: col });
}

export function meta({ params, location }: { params: Record<string, string | undefined>; location?: { pathname?: string } }) {
  const pathname = location?.pathname ?? "/regulations";
  const col = resolveColumn(pathname);
  return pageMeta({
    title: col.title,
    description: col.description,
    path: col.path,
  });
}

export default function ColumnFeedPage() {
  const { data, column } = useLoaderData<{ data: PoolResponse; column: ColumnConfig }>();
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const busy = navigation.state === "loading";

  function pageHref(p: number) {
    const sp = new URLSearchParams(searchParams);
    if (p <= 1) sp.delete("page");
    else sp.set("page", String(p));
    const s = sp.toString();
    return s ? `${column.path}?${s}` : column.path;
  }

  return (
    <div className="pb-6">
      <div className="mb-6">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{column.title}</h1>
        <p className="mt-1 text-[14px] text-ink-4">{column.description}</p>
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
