import { defineModule } from "@aihot/contracts/modules";

// Four article-list columns for now. `regulations` is a stopgap: it filters the pool by
// `category='regulation'` until stage 2 step 2.8 lands the real 法规页面 in `modules/regulation/`,
// which reads `regulation_tracking` and shows lifecycle + 关联动态 + 官方原文链接. The other three
// (standard / ncap / customer) are legitimately category-filtered feeds and stay here.
export default defineModule({
  name: "columns",
  pages: [
    { path: "regulations", file: "web/regulations.tsx", id: "columns-regulations" },
    { path: "standards", file: "web/standards.tsx", id: "columns-standards" },
    { path: "ncap", file: "web/ncap.tsx", id: "columns-ncap" },
    { path: "oem", file: "web/oem.tsx", id: "columns-oem" },
  ],
});
