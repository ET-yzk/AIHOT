// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { REPORTS, withSubject } from "@aihot/site";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { startWebServer, type WebServer } from "./web-server.ts";

/**
 * One issue whose last section the pack leaves empty. FR-02-05 (不得输出空表格) says a reader never
 * sees an empty section, and it is ReportPaper's own section-to-page assembly that decides that — the
 * read layer hands down the empty section verbatim. Two pack labels are needed for the fixture to mean
 * anything: the assertion is about which `id="s-N"` shows up in the page, and the chrome can't invent
 * one out of thin air.
 */
const REPORT_KEY = "2026-09-28";
const cited = (n: number): ReportCitation => ({
  itemId: `item-${n}`, title: `新规 ${n}`, summary: `摘要 ${n}`, sourceName: "工信部", sourceUrl: `https://example.org/${n}`,
  sourceIconUrl: null, firstParty: true, publishedAt: "2026-09-28T01:00:00Z", available: true,
});
const report: ReportDetail = {
  kind: "daily", key: REPORT_KEY, issueNumber: 1, title: `${CATEGORIES[0]!.label} 一期`,
  generatedAt: "2026-09-28T01:00:00Z",
  lead: { title: "新规 1", leadParagraph: "今日一条。" }, leadItemId: null, overview: null,
  highlights: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
  sections: [
    { label: CATEGORIES[0]!.label, summary: null, items: [cited(1)] },
    { label: CATEGORIES.at(-1)!.label, summary: null, items: [] },
  ],
  blocks: [], silence: [],
};

/**
 * A quiet week (BR-04): the dailies in its window were judged and carried no event, so the issue still comes
 * out — no headline, no lead, no section, and the pack's own weekly quiet sentence stored as the overview. The
 * sentence is read from the pack here rather than copied, so the pack can reword it and this still tests the
 * page, not the wording.
 */
const QUIET_WEEK = "2026-W40";
const quietLine = REPORTS.quiet.weekly.paragraph.replace("{start}", "10 月 5 日 08:00").replace("{end}", "10 月 12 日 08:00");
const quietWeek: ReportDetail = {
  kind: "weekly", key: QUIET_WEEK, issueNumber: 3, title: `${withSubject("周报")} · ${QUIET_WEEK}`,
  generatedAt: "2026-10-12T00:00:00Z",
  lead: null, leadItemId: null, overview: quietLine,
  highlights: [], flashes: [], sections: [], cover: null,
  metrics: { totalStories: 0, selectedCount: 4, reportsCovered: 7 }, readingMinutes: 1, prev: null, next: null,
};

let web: WebServer;
let origin: string;
let deadline: number;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaAfterDeadline ? setTimeout(respond, deadline * 1000 - Date.now() + 50) : respond();
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ filters, cards: [], nextCursor: null, dayCounts: [], hot: null }));
  }
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ entries: [] }));
  if (url.pathname === "/api/site/echo-client") return res.end(JSON.stringify({ forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] }));
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/long-lived") return res.end(JSON.stringify({ id: "long-lived", title: "t" }));
  if (url.pathname === "/api/site/contact") return res.end(JSON.stringify({ wechatQr: "/qr.png", feishuQr: "/qr.png" }));
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return res.end(JSON.stringify({ mergedInto: "surviving-story" }));
  }
  if (url.pathname === `/api/site/reports/daily/${REPORT_KEY}`) return res.end(JSON.stringify(report));
  if (url.pathname === `/api/site/reports/daily/navigation/${REPORT_KEY}`) return res.end(JSON.stringify({ items: [] }));
  if (url.pathname === `/api/site/reports/weekly/${QUIET_WEEK}`) return res.end(JSON.stringify(quietWeek));
  if (url.pathname === `/api/site/reports/weekly/navigation/${QUIET_WEEK}`) return res.end(JSON.stringify({ items: [] }));
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  web = await startWebServer(api);
  origin = web.origin;
});
after(() => web.stop());

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("navigation streams are plain text for download managers, including errors", async () => {
  for (const [pathname, status] of [["/_.data?_routes=root", 200], ["/items/missing.data", 404]] as const) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, status, pathname);
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", pathname);
    assert.equal(res.headers.get("Content-Disposition"), null, pathname);
    assert.ok((await res.text()).length > 0, pathname);
  }
  const download = await fetch(origin + "/api/site/download");
  assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="article.md"');
  assert.equal(await download.text(), "# Article");
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.match(plain.headers.get("X-Accel-Expires")!, /^@\d+$/);
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /api\/auth\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL (at least a whole second), but root metadata
    // finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaAfterDeadline = true;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    metaAfterDeadline = false;
  }
});

test("a shared cache may keep an item page longer than browsers", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  const cc = res.headers.get("Cache-Control")!;
  assert.equal(Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]), 300);
  assert.ok(Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]) > 300);
  await res.text();
});

// A tab opened before a page lost its loader still asks for that page's result, and its router rejects
// a missing one before React's release recovery can run.
test("a page without a loader still answers navigation with an empty result", async () => {
  const res = await fetch(`${origin}/terms.data?_routes=routes%2Fterms`);
  assert.equal(res.status, 200);
  const { value } = await UNSAFE_decodeViaTurboStream(res.body!, globalThis);
  const result = value as Record<string, { data: unknown }>;
  assert.ok("routes/terms" in result, "an already open router must be able to unwrap its requested route");
  assert.equal(result["routes/terms"]!.data, null);
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

test("a section the issue left empty is not printed as a page, and a zero count never reaches the reader", async () => {
  assert.notEqual(CATEGORIES[0]!.label, CATEGORIES.at(-1)!.label, "this pack needs two different category labels for the fixture to mean anything");
  const res = await fetch(`${origin}/daily/${REPORT_KEY}`);
  assert.equal(res.status, 200, web.logs());
  const body = await res.text();
  const pages = body.match(/id="s-\d+"/g) ?? [];
  assert.deepEqual(pages, ['id="s-1"'], `only the section holding an item gets a page, and the page index numbers what is printed: ${pages.join(", ") || "none"}`);
  assert.ok(!body.includes("0 件"), "the front page's 版面 directory does not list an empty section with a zero count");
  assert.ok(body.includes(CATEGORIES[0]!.label), "the section that has the item is printed under its own name");
});

test("a week with nothing to report still comes out, and says so in the pack's own words", async () => {
  assert.ok(REPORTS.quiet.weekly.paragraph.includes("{start}") && REPORTS.quiet.weekly.paragraph.includes("{end}"),
    "the fixture fills the window placeholders the pack's sentence leaves open");
  const res = await fetch(`${origin}/weekly/${QUIET_WEEK}`);
  assert.equal(res.status, 200, web.logs());
  const body = await res.text();
  assert.ok(body.includes(quietLine), `the quiet issue prints the pack's weekly sentence, not a string copied into the page: ${body.slice(0, 300)}`);
  assert.deepEqual(body.match(/id="s-\d+"/g) ?? [], [], "an issue that carries no event pages through nothing");
  assert.ok(!body.includes(REPORTS.quiet.daily.title), "the week does not borrow the day's quiet headline: the pack's words are per kind");
  for (const unit of Object.values(REPORTS.metricUnits)) assert.ok(!body.includes(unit), `a quiet issue closes its masthead, so none of its figures reach the reader (${unit})`);
});
