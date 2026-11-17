// The module's backend: two read endpoints and the six-hourly sync (docs/implement/source-table/03 §4).
// Reads come from source_table_rows only; the sync is the one place that talks to Feishu.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@aihot/backend/config";
import type { ServerModule } from "@aihot/backend/modules";
import { listRows, loadRow, type ListQuery, type PageSize } from "./read.ts";
import { syncSourceTable } from "./sync.ts";

const CACHE = "public, max-age=60, stale-while-revalidate=300";

function problem(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).type("application/json").send({ error: message });
}

/** One value or repeated values (`?region=中国&region=美国`). */
function values(input: unknown): string[] {
  if (typeof input === "string") return input === "" ? [] : [input];
  if (Array.isArray(input)) return input.filter((v): v is string => typeof v === "string" && v !== "");
  return [];
}

function one(input: unknown): string | undefined {
  const [first] = values(input);
  return first;
}

export function queryOf(request: FastifyRequest): ListQuery {
  const q = request.query as Record<string, unknown>;
  const page = Number.parseInt(one(q.page) ?? "1", 10);
  const pageSize = Number.parseInt(one(q.size) ?? one(q.pageSize) ?? "", 10);
  return {
    q: one(q.q)?.slice(0, 120),
    region: values(q.region),
    lifecycle: values(q.lifecycle),
    businessCategory: values(q.business ?? q.category),
    certType: values(q.cert),
    archived: values(q.archived),
    subscription: values(q.subscription),
    sort: one(q.sort),
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? (pageSize as PageSize) : undefined,
  };
}

function registerRoutes(app: FastifyInstance) {
  app.get("/api/site/source-table", async (request, reply) => {
    reply.header("cache-control", CACHE);
    return reply.send(await listRows(queryOf(request)));
  });

  app.get("/api/site/source-table/:slug", async (request, reply) => {
    const slug = (request.params as { slug?: string }).slug ?? "";
    const row = await loadRow(slug);
    if (!row) return problem(reply, 404, "没有这条法规");
    reply.header("cache-control", CACHE);
    return reply.send(row);
  });
}

export default {
  name: "source-table",
  http: registerRoutes,
  schedules: [
    {
      name: "source-table.sync",
      cron: config.sourceTableSyncCron,
      run: () => syncSourceTable(),
      // Off by default: false removes the schedule and its queue when the worker starts.
      when: () => config.sourceTableSyncEnabled,
      missed: "skip",
    },
  ],
} satisfies ServerModule;
