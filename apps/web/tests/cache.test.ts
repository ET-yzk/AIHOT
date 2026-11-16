// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { ADMIN } from "@aihot/site";
import { SIGN_IN_HOME } from "@aihot/contracts/admin";
import { isPrivatePage } from "@aihot/contracts/http-policy";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { REPORTS, withSubject } from "@aihot/site";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

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
  blocks: [], silence: [], mentions: [],
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
  metrics: { totalStories: 0, selectedCount: 4, reportsCovered: 7 }, readingMinutes: 1, prev: null, next: null, mentions: [],
};

/**
 * A quiet month, same shape as the quiet week but on the monthly branch. Since site/site.ts:220 now carries
 * a monthly sentence distinct from the weekly one, the reader view of a monthly issue is where that split
 * either lands on the page or does not — the compose-side kind lookup has its own credential in
 * tests/report-issues.test.ts; this one proves the page prints what came down for its kind.
 */
const QUIET_MONTH = "2026-10";
const quietMonthlyLine = REPORTS.quiet.monthly.paragraph.replace("{start}", "10 月 1 日 08:00").replace("{end}", "11 月 1 日 08:00");
const quietMonth: ReportDetail = {
  kind: "monthly", key: QUIET_MONTH, issueNumber: 10, title: `${withSubject("月报")} · ${QUIET_MONTH}`,
  generatedAt: "2026-11-01T00:00:00Z",
  lead: null, leadItemId: null, overview: quietMonthlyLine,
  highlights: [], flashes: [], sections: [], cover: null,
  metrics: { totalStories: 0, selectedCount: 6, reportsCovered: 31 }, readingMinutes: 1, prev: null, next: null, mentions: [],
};

let web: WebServer;
let origin: string;
let deadline: number;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = fakeApi(async (url, res, req) => {
  apiCookies.push(req.headers.cookie);
  if (url.pathname === "/api/site/meta") {
    // Past the deadline on the wall clock the server reads: timers run on another clock, and a CI VM
    // stepping its wall clock back mid-wait would otherwise answer before the deadline.
    while (metaAfterDeadline && Date.now() < deadline * 1000 + 50) await new Promise((resolve) => setTimeout(resolve, deadline * 1000 + 50 - Date.now()));
    return { changelogVersion: "2026-09-28T12:00" };
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return { filters, cards: [], nextCursor: null, dayCounts: [], hot: null };
  }
  if (url.pathname === "/api/site/hot") return { entries: [] };
  if (url.pathname === "/api/site/echo-client") return { forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] };
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/long-lived") return { id: "long-lived", title: "t" };
  if (url.pathname === "/api/site/contact") return { wechatQr: "/qr.png", feishuQr: "/qr.png" };
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return { mergedInto: "surviving-story" };
  }
  if (url.pathname.startsWith("/api/admin/")) {
    res.statusCode = 401;
    return { code: "not_found" };
  }
  if (url.pathname === `/api/site/reports/daily/${REPORT_KEY}`) return report;
  if (url.pathname === `/api/site/reports/daily/navigation/${REPORT_KEY}`) return { items: [] };
  if (url.pathname === `/api/site/reports/weekly/${QUIET_WEEK}`) return quietWeek;
  if (url.pathname === `/api/site/reports/weekly/navigation/${QUIET_WEEK}`) return { items: [] };
  if (url.pathname === `/api/site/reports/monthly/${QUIET_MONTH}`) return quietMonth;
  if (url.pathname === `/api/site/reports/monthly/navigation/${QUIET_MONTH}`) return { items: [] };
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
  // The api's deadline also fixes the result's own expiry, so reads seconds apart compare byte for byte.
  const plain = await fetch(`${origin}/_.data`);
  const signedIn = await fetch(`${origin}/_.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.equal(plain.headers.get("X-Accel-Expires"), `@${deadline}`);
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
  if (ADMIN) {
    const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
    assert.equal(admin.status, 202);
    assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
    assert.equal(admin.headers.get("X-Accel-Expires"), "0");
    assert.match(await admin.text(), /api\/auth\/login/);
  } else {
    const none = await fetch(`${origin}/admin/sources`);
    assert.equal(none.status, 404, "a site without admin pages has none");
    await none.text();
  }
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("gray pages are private like the admin's, whatever their route asks for", async () => {
  for (const pathname of ["/preview", "/preview/", "/preview/models", "/Preview/models", "/admin", "/admin/runs"]) assert.equal(isPrivatePage(pathname), true, pathname);
  for (const pathname of ["/", "/previews", "/all", "/items/preview", "/administer"]) assert.equal(isPrivatePage(pathname), false, pathname);
  for (const pathname of ["/preview/missing", "/preview/missing.data", "/preview/missing.data?_routes=root"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store", pathname);
    assert.equal(res.headers.get("X-Accel-Expires"), "0", pathname);
    await res.text();
  }
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
  assert.equal(login.status, ADMIN ? 200 : 404, "a site without admin pages has no admin sign-in either");
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  if (ADMIN) assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a signed-in admin is sent past the sign-in page", { skip: !ADMIN && "this site has no admin pages" }, async () => {
  const api = fakeApi((url, res, req) => {
    if (url.pathname === "/api/admin/me") {
      if (req.headers.cookie?.includes("aihot_admin=fixture")) return { name: "Fixture admin", csrf: "fixture", dev: false };
      res.statusCode = 401;
      return { code: "unauthorized" };
    }
    if (url.pathname === "/api/auth/options") return { password: true };
  });
  const signedIn = await startWebServer(api);
  try {
    const res = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin%2Fcontent`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/admin/content");
    await res.text();
    for (const [target, location] of [["javascript:alert(1)", SIGN_IN_HOME], ["//evil.example/admin", SIGN_IN_HOME], ["/x/..//evil.example", SIGN_IN_HOME], ["https://evil.example/admin", "/admin"], ["/free-preview", "/free-preview"]]) {
      const away = await fetch(`${signedIn.origin}/admin/login?return=${encodeURIComponent(target!)}`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
      assert.equal(away.headers.get("location"), location, target);
      await away.text();
    }
    const anonymous = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin`, { redirect: "manual" });
    assert.equal(anonymous.status, 200, "without a session the page still offers the ways in");
    await anonymous.text();
  } finally {
    await signedIn.stop();
  }
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
  const sectionHeading = printed(body).match(/<h2 id="s-1-t"[^>]*>\s*([^<]+?)\s*<\/h2>/);
  assert.ok(sectionHeading, `the section page prints its own heading element to read the name out of: ${printed(body).slice(0, 240)}`);
  assert.equal(sectionHeading[1].trim(), CATEGORIES[0]!.label,
    "the section that has the item is printed under its own name — read out of that section's heading, not out of the 版面 directory that also lists it");
});

/**
 * The part a reader actually sees. React Router serializes the loader payload into a `<script>`, and that payload
 * carries `report.overview` verbatim, so a `body.includes(quietLine)` over the whole document can never fail —
 * measured 2026-10-13 by neutralizing all three writers of the quiet sentence (the front page's Overview, the
 * masthead's dek, the meta description) and watching this case stay green. A quiet issue prints no story
 * `<article>`, so the outer one is the page itself; that premise is asserted here rather than assumed.
 */
function printed(html: string): string {
  const body = html.replace(/<script\b[\s\S]*?<\/script>/g, " ");
  const start = body.indexOf("<article");
  const end = body.lastIndexOf("</article>");
  assert.ok(start >= 0 && end > start, `the page prints no <article> to read the sentence out of: ${body.slice(0, 240)}`);
  return body.slice(start, end);
}

test("a week with nothing to report still comes out, and says so in the pack's own words", async () => {
  assert.ok(REPORTS.quiet.weekly.paragraph.includes("{start}") && REPORTS.quiet.weekly.paragraph.includes("{end}"),
    "the fixture fills the window placeholders the pack's sentence leaves open");
  const res = await fetch(`${origin}/weekly/${QUIET_WEEK}`);
  assert.equal(res.status, 200, web.logs());
  const body = await res.text();
  assert.ok(printed(body).includes(quietLine), `the quiet issue prints the pack's weekly sentence where the reader sees it, not just in the payload: ${printed(body).slice(0, 300)}`);
  assert.deepEqual(body.match(/id="s-\d+"/g) ?? [], [], "an issue that carries no event pages through nothing");
  assert.ok(!body.includes(REPORTS.quiet.daily.title), "the week does not borrow the day's quiet headline: the pack's words are per kind");
  for (const unit of Object.values(REPORTS.metricUnits)) assert.ok(!body.includes(unit), `a quiet issue closes its masthead, so none of its figures reach the reader (${unit})`);
});

/**
 * Companion to the quiet-week case above. Since 2026-10-14 the pack carries a different sentence for a
 * quiet month than for a quiet week (site/site.ts:220); this proves that split reaches the reader.
 * Deriving the discriminator from the pack rather than writing "这一个月" here keeps the assertion honest
 * if the wording changes — the credential is that the reader sees one kind's sentence and not the other's.
 */
test("a month with nothing to report prints the pack's monthly sentence, not the weekly one", async () => {
  assert.ok(REPORTS.quiet.monthly.paragraph.includes("{start}") && REPORTS.quiet.monthly.paragraph.includes("{end}"),
    "the monthly fixture fills the same window placeholders");
  // Guard the premise: if the two pack sentences ever converge again, this test's kind-discrimination is vacuous.
  const weeklyOnly = REPORTS.quiet.weekly.paragraph
    .split(/\{start\}|\{end\}/)
    .filter((f) => f.length > 0 && !REPORTS.quiet.monthly.paragraph.includes(f));
  const monthlyOnly = REPORTS.quiet.monthly.paragraph
    .split(/\{start\}|\{end\}/)
    .filter((f) => f.length > 0 && !REPORTS.quiet.weekly.paragraph.includes(f));
  assert.ok(weeklyOnly.length > 0 && monthlyOnly.length > 0,
    "REPORTS.quiet.weekly and REPORTS.quiet.monthly must differ for this test to mean anything");

  const res = await fetch(`${origin}/monthly/${QUIET_MONTH}`);
  assert.equal(res.status, 200, web.logs());
  const body = await res.text();
  const seen = printed(body);
  assert.ok(seen.includes(quietMonthlyLine), `the quiet month prints the pack's monthly sentence where the reader sees it: ${seen.slice(0, 300)}`);
  for (const fragment of monthlyOnly) {
    assert.ok(seen.includes(fragment), `the month prints its kind's pack fragment "${fragment}"`);
  }
  for (const fragment of weeklyOnly) {
    assert.ok(!seen.includes(fragment), `the month does NOT print the week-only pack fragment "${fragment}" — the kind split in the pack shows through on the page`);
  }
  assert.deepEqual(body.match(/id="s-\d+"/g) ?? [], [], "an issue that carries no event pages through nothing");
  assert.ok(!body.includes(REPORTS.quiet.daily.title), "the month does not borrow the day's quiet headline: the pack's words are per kind");
  for (const unit of Object.values(REPORTS.metricUnits)) assert.ok(!body.includes(unit), `a quiet issue closes its masthead, so none of its figures reach the reader (${unit})`);
});

// The real listener must own its ephemeral port; reserving and releasing one before spawn races
// another CI process. Canonical URLs still have to identify the listener's actual address.
test("a web server assigned port zero serves its own canonical address", async () => {
  const ephemeral = await startWebServer(fakeApi(), { WEB_PORT: "0", SITE_URL: "http://127.0.0.1:0" });
  try {
    const response = await fetch(`${ephemeral.origin}/about`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`rel="canonical" href="${ephemeral.origin}/about"`));
  } finally { await ephemeral.stop(); }
});
