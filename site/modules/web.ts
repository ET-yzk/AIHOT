// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import columns from "@aihot/columns/web";
import sourceTable from "@aihot/source-table/web";
import subscriptions from "@aihot/subscriptions/web";

// 专栏一项在前：法规信源是台账，法规追踪是动态流，读者先查「有哪些法规」再问「最近发生了什么」。
export const WEB_MODULES: readonly WebModule[] = [sourceTable, columns, subscriptions];
