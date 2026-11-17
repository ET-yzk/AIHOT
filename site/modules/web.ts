// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import columns from "@aihot/columns/web";
import sourceTable from "@aihot/source-table/web";
import subscriptions from "@aihot/subscriptions/web";

export const WEB_MODULES: readonly WebModule[] = [columns, sourceTable, subscriptions];
