// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@aihot/backend/modules";
import regulation from "@aihot/regulation/server";
import subscriptions from "@aihot/subscriptions/server";

export const SERVER_MODULES: readonly ServerModule[] = [regulation, subscriptions];
