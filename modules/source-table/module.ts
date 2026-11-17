import { defineModule } from "@aihot/contracts/modules";

// 飞书「信源表_v2.0」的站内只读镜像：总览页 /sources 与详情页 /sources/:slug，
// 数据由 server.ts 的定时同步或 scripts/import-source-table-snapshot.ts 写入。
export default defineModule({
  name: "source-table",
  pages: [
    { path: "sources", file: "web/list.tsx", id: "source-table-list" },
    { path: "sources/:slug", file: "web/detail.tsx", id: "source-table-detail" },
  ],
  apiPaths: [/^\/api\/site\/source-table(\/|$)/],
});
