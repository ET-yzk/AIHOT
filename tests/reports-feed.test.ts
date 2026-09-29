// The periodical content feed (CT-5): what an out-of-tree renderer gets is content — the lead, the
// sections as edited, every cited story in the editor's reading order — and never a rendered card.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `test-reports-feed-${T}`;
const WEEKLY = "2099-W52";
const MONTHLY = "2099-12";
const FIRST_CATEGORY = CATEGORIES[0].key;
const app = await buildApp();

const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.body, etag: res.headers.etag as string | undefined, cache: res.headers["cache-control"] as string };
};

async function article(n: number): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/${T}-${n}`, title: `Rule change ${n} ${T}`, bodyText: `BODY-${n}-${T}`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${FIRST_CATEGORY}, ${`新规变化 ${n}-${T}`}, ${`SUMMARY-${n}-${T}`}, '理由', 90, true)`;
  await publishArticle(articleId);
  return articleId;
}

const entry = (itemId: string, n: number) => ({
  itemId,
  title: `新规变化 ${n}-${T}`,
  summary: `SUMMARY-${n}-${T}`,
  sourceName: "测试法规源",
  sourceUrl: `https://example.org/${T}-${n}`,
  sourceId: SOURCE,
  firstParty: true,
  role: "官方公告",
});

async function putReport(kind: "weekly" | "monthly", key: string, order: string[], ...refs: Array<Record<string, unknown>>) {
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES (${kind}, ${key}, now() - interval '7 days', now(), ${sql.json({
              headline: `本周规则与测评-${T}`,
              overview: `本期覆盖两周-${T}`,
              themes: [
                { heading: "法规与标准", summary: "两条新规-${T}", storyRefs: refs },
                { heading: "行业动态", summary: "一条合作-${T}", storyRefs: [] },
              ],
              storyOrder: order,
              highlights: refs.map((r) => r.itemId).filter(Boolean),
              metrics: { totalStories: order.length, selectedCount: refs.length },
            } as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content`;
}

before(async () => {
  await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test reports feed', 'rss', 'T1', 'editorial', true, false, '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE key IN (${WEEKLY}, ${MONTHLY})`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("a period with no issues answers an empty index and a 404 latest, not a guess", async () => {
  await sql`DELETE FROM reports WHERE kind = 'monthly' AND key = ${MONTHLY}`;
  const index = await get("/api/v1/reports/monthly");
  assert.equal(index.status, 200);
  assert.equal(JSON.parse(index.body).kind, "monthly");
  const latest = await get("/api/v1/reports/monthly/latest");
  assert.equal(latest.status, 404, "an absent period must not fall back to another month");
});

test("the weekly feed carries the lead, the edited sections and the reading order", async () => {
  const [a, b] = [await article(1), await article(2)];
  // The editor's order puts the later citation first; a renderer that ignored storyOrder would flip them.
  await putReport("weekly", WEEKLY, [b, a], entry(a, 1), entry(b, 2));

  const res = await get(`/api/v1/reports/weekly/${WEEKLY}`);
  assert.equal(res.status, 200);
  const r = JSON.parse(res.body).report;
  assert.equal(r.kind, "weekly");
  assert.equal(r.key, WEEKLY);
  assert.equal(r.title.length > 0, true, "the issue names itself");
  assert.equal(r.lead?.title, `本周规则与测评-${T}`, "a periodical's headline reaches the renderer as its lead");
  assert.equal(r.overview, `本期覆盖两周-${T}`);
  assert.equal(r.sections.length, 2, "both themes are listed, the empty one too: it is edited content");
  assert.equal(r.sections[0].label, "法规与标准");
  assert.deepEqual(r.sections[0].items.map((i: { itemId: string }) => i.itemId), [a, b]);
  assert.deepEqual(r.order, [b, a], "reading order is the editor's, not the section order");
  assert.deepEqual(r.highlights.map((i: { itemId: string }) => i.itemId), [a, b]);
  const cited = r.sections[0].items[0];
  assert.equal(cited.withdrawn, false);
  assert.ok(cited.links.aihot.endsWith(`/items/${a}`), "back link to the permanent page");
  assert.equal(cited.links.original, `https://example.org/${T}-1`, "the original stays attributed");
  assert.ok(r.attribution.name, "every feed item carries who published it");
  assert.equal(res.cache.includes("max-age=3600"), true, "a named period is settled content");
});

test("latest, the index and conditional requests behave across the periodicals", async () => {
  const latest = await get("/api/v1/reports/weekly/latest");
  assert.equal(latest.status, 200);
  assert.equal(JSON.parse(latest.body).report.key, WEEKLY);
  assert.ok(latest.etag, "the feed answers If-None-Match");
  const again = await get("/api/v1/reports/weekly/latest", { "if-none-match": latest.etag! });
  assert.equal(again.status, 304, "an unchanged issue is not resent");

  const index = await get("/api/v1/reports/weekly");
  const listed = JSON.parse(index.body);
  assert.equal(listed.count >= 1, true);
  assert.ok(listed.items.some((i: { key: string }) => i.key === WEEKLY));

  await putReport("monthly", MONTHLY, []);
  const monthly = JSON.parse((await get(`/api/v1/reports/monthly/${MONTHLY}`)).body);
  assert.equal(monthly.report.sections[0].items.length, 0, "a monthly without cited stories still answers");
});

test("a period key that is not a real period is refused, and an unknown one is a 404", async () => {
  for (const url of ["/api/v1/reports/weekly/2099-12", "/api/v1/reports/monthly/2099-W52"]) {
    const res = await get(url);
    assert.equal(res.status, 400, `${url} must not accept the other kind's shape`);
  }
  assert.equal((await get("/api/v1/reports/weekly/1999-W01")).status, 404);
  assert.equal((await get("/api/v1/reports/weekly?fields=minimal")).status, 400, "an unknown parameter is refused");
});

test("a withdrawn story is marked and stripped, not silently dropped from the issue", async () => {
  const [a, b] = [await article(3), await article(4)];
  await putReport("weekly", WEEKLY, [a, b], entry(a, 3), entry(b, 4));
  const before = JSON.parse((await get(`/api/v1/reports/weekly/${WEEKLY}`)).body);
  assert.equal(before.report.sections[0].items.every((i: { withdrawn: boolean }) => !i.withdrawn), true);

  const { setVisibility } = await import("@aihot/backend/admin/content");
  await setVisibility(a, { visibility: "withdrawn", reason: T, version: 0 }, "test");
  const after = JSON.parse((await get(`/api/v1/reports/weekly/${WEEKLY}`)).body);
  const item = after.report.sections[0].items.find((i: { itemId: string }) => i.itemId === a);
  assert.equal(item.withdrawn, true, "the renderer must be able to show it was removed");
  assert.equal(item.summary, null, "a withdrawn story's summary is not sent");
  assert.equal(item.links.original, "", "and neither is its link out");
  await setVisibility(a, { visibility: "public", reason: T, version: 1 }, "test");
});

test("every public v1 route that is served is described in the machine-readable contract", async () => {
  // The contract is the file agents are told to build against; a route missing from it drifts silently.
  const { readFileSync } = await import("node:fs");
  const openapi = JSON.parse(readFileSync(new URL("../reference/public-v1.openapi.json", import.meta.url), "utf8")) as { paths: Record<string, unknown> };
  // Fastify prints `/weekly/:key`, OpenAPI prints `/weekly/{key}` — one path parameter either way.
  const norm = (p: string) => p.split("/").map((s) => (s.startsWith(":") || s.startsWith("{") ? "*" : s)).join("/");
  const documented = new Set(Object.keys(openapi.paths).map(norm));
  // printRoutes() is a depth-indented, prefix-compressed tree: rebuild a path from its nodes' depths.
  const served = new Set<string>();
  const stack: string[] = [];
  for (const line of app.printRoutes({ method: "GET" }).split("\n")) {
    const at = line.indexOf("── ");
    if (at < 0) continue;
    stack.length = (at - 1) / 4;
    stack[stack.length] = line.slice(at + 3).split(" (")[0]!.trim();
    if (/\((?:GET|HEAD)/.test(line)) served.add(stack.join("").replace(/\/+$/, ""));
  }
  // The two catch-all 404s are not content routes, so they are not in the contract either.
  const content = [...served].filter((p) => p.startsWith("/api/v1") && p !== "/api/v1" && p !== "/api/v1/*");
  assert.equal(content.length >= 16, true, `parsed only ${content.length} v1 routes: ${content.join(", ")}`);
  for (const route of content) assert.ok(documented.has(norm(route)), `${route} is served but missing from reference/public-v1.openapi.json`);
});
