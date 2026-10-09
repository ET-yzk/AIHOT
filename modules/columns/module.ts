import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "columns",
  pages: [
    { path: "regulations", file: "web/column-feed.tsx", id: "columns-regulations" },
    { path: "standards", file: "web/column-feed.tsx", id: "columns-standards" },
    { path: "ncap", file: "web/column-feed.tsx", id: "columns-ncap" },
    { path: "oem", file: "web/column-feed.tsx", id: "columns-oem" },
  ],
});
