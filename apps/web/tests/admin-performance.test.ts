// Failure modes fixed before changing admin loading and formatting:
// - a slow/failed navigation badge prevents the actual page from opening;
// - streaming exposes a page before identity is verified, or makes private data cacheable;
// - desktop/phone badges disappear permanently or retain the preceding page's values;
// - hovering private links reads an expensive page that no-store makes navigation read again;
// - reusing number formatters changes rounding, missing values, or currency precision.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { money, num } from "../app/features/admin/format.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let browser: Browser;
let signedIn = true;
let badge = 7;
let badgeFailure = false;
let releaseBadges: (() => void) | undefined;
let badgeGate: Promise<void> | undefined;
const reads: string[] = [];
const saved: Array<{ decision: string; split: string }> = [];
const deleted: string[] = [];
const goldFixtureAt = "2026-10-04T08:00:00.000Z";
const goldCase = (over: Record<string, unknown> = {}) => ({
  caseId: "gold-fixture-1", title: "Rule change 1", url: "https://example.org/gold-1", sourceName: "测试法规源", sourceKind: "rss",
  sourceTier: "T1", firstParty: true, publishedAt: goldFixtureAt, language: "zh", judged: "固定正文：征求意见稿的附件里给了实施时间表。",
  titleZh: "金标检查条目", summaryZh: "固定摘要", reasonZh: "模型说：例行通知，不必占位置", category: "regulation", band: "near-below",
  threshold: 55, relevance: "pass", score: 50, modelSelected: false, model: "fixture-score-model", promptVersion: "structure@fixture",
  decision: null, note: null, split: "development", labelledThreshold: null, labelledScore: null, updatedBy: null, updatedAt: null, version: null, ...over,
});
const goldRow = (t: number) => ({ t, acc: 0, completeAcc: 0, coverage: 1, P: 1, R: 0, F1: 0, sel: 0, decisive: 1, decisiveGold: 1, decisiveErrors: 0 });
const goldView = {
  board: {
    thresholds: { T1: 55, T2: 74 }, promptVersion: "prompt@deadbeef",
    bands: [{ band: "near-below", waiting: 9 }, { band: "block", waiting: 2 }], waiting: 11, labelled: 1,
    cases: [goldCase()],
    labels: [goldCase({ caseId: "gold-fixture-0", title: "Rule change 0", titleZh: "已经标过的条目", decision: "select", note: "实施时间要提前知道", split: "holdout", labelledThreshold: 55, labelledScore: 50, updatedBy: "后台性能检查", updatedAt: goldFixtureAt, version: 2 })],
  },
  report: {
    labelled: 1,
    metrics: { n: 2, decisiveGold: 1, decisive: 1, either: 0, errors: 0, decisiveErrors: 0, eitherErrors: 0, tp: 0, fp: 0, fn: 1, tn: 0, coverage: 1, accuracy: 0, completeAccuracy: 0, precision: 1, recall: 0, f1: 0, selectedRate: 0, goldSelectRate: 0 },
    disagreements: [{ caseId: "gold-fixture-1", title: "Rule change 1", url: "https://example.org/gold-1", sourceTier: "T1", band: "near-below", threshold: 55, relevance: "pass", score: 50, modelSelected: false, decision: "select", kind: "missed" }],
    sweeps: [{ tier: "T1", current: 55, rows: [goldRow(54), goldRow(55)] }],
  },
};
const api = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://api.local");
  if (url.pathname.startsWith("/api/admin/")) reads.push(url.pathname);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
  if (url.pathname.startsWith("/api/admin/") && !signedIn) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ detail: "unauthorized" }));
  }
  if (url.pathname === "/api/admin/me") return res.end(JSON.stringify({ name: "后台性能检查", csrf: "fixture", dev: true }));
  if (url.pathname === "/api/admin/nav-counts") {
    await badgeGate;
    res.statusCode = badgeFailure ? 503 : 200;
    return res.end(JSON.stringify(badgeFailure ? { detail: "busy" } : { sources: badge }));
  }
  if (url.pathname === "/api/admin/sources") return res.end(JSON.stringify({ rows: [], totals: { total: 0, enabled: 0, failing: 0, degraded: 0 }, page: 1 }));
  if (url.pathname === "/api/admin/gold") return res.end(JSON.stringify(goldView));
  if (req.method === "POST" && url.pathname.startsWith("/api/admin/gold/")) {
    const body = await new Promise<string>((resolve) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => resolve(raw)); });
    saved.push(JSON.parse(body) as { decision: string; split: string });
    return res.end(JSON.stringify({ caseId: url.pathname.split("/").pop(), decision: saved.at(-1)!.decision, split: saved.at(-1)!.split }));
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/gold/")) {
    // Mirror the api (Fastify): a DELETE that declares a JSON content type but sends no body is rejected
    // with 400 "The request could not be processed." before the route runs.
    if ((req.headers["content-type"] ?? "").includes("application/json")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ detail: "The request could not be processed." }));
    }
    deleted.push(url.pathname.split("/").pop()!);
    return res.end(JSON.stringify({ caseId: deleted.at(-1) }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: "not_found" }));
});

before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => {
  releaseBadges?.();
  await browser?.close();
  await web?.stop();
});

function holdBadges() {
  badgeGate = new Promise<void>((resolve) => { releaseBadges = resolve; });
}
function resumeBadges() {
  releaseBadges?.();
  releaseBadges = undefined;
  badgeGate = undefined;
}

test("admin HTML and navigation begin before delayed badges while remaining private", async () => {
  for (const path of ["/admin/content", "/admin/content.data?_routes=admin-layout,routes/admin/content"]) {
    holdBadges();
    // SSR deliberately waits for every boundary for bots; this is a browser document request.
    const response = fetch(web.origin + path, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const early = await Promise.race([response, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); })]);
      assert.ok(early, `${path} waited for navigation badges`);
      assert.equal(early.status, 200);
      assert.equal(early.headers.get("Cache-Control"), "private, no-store");
      assert.equal(early.headers.get("X-Accel-Buffering"), "no");
      const first = await early.body!.getReader().read();
      assert.match(new TextDecoder().decode(first.value), /内容诊断|routes\/admin\/content/);
    } finally {
      clearTimeout(timer);
      resumeBadges();
      await response;
    }
  }
});

test("admin streaming still verifies identity before returning the page", async () => {
  signedIn = false;
  try {
    const res = await fetch(web.origin + "/admin/content", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("Location")!, /\/api\/auth\/login/);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  } finally { signedIn = true; }
});

test("both admin navigations render before badges and update them after arriving", async () => {
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      badge = 7;
      await page.goto(web.origin + "/admin/sources");
      const sources = page.locator('nav a[href="/admin/sources"]').filter({ visible: true });
      await expect(sources).toHaveText("信源7");
      badge = 19;
      holdBadges();
      await page.getByRole("link", { name: "内容诊断", exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole("heading", { name: "内容诊断", exact: true })).toBeVisible({ timeout: 1000 });
      resumeBadges();
      await expect(sources).toHaveText("信源19");
      badgeFailure = true;
      await sources.click();
      await expect(page.getByRole("heading", { name: "信源", exact: true })).toBeVisible();
      await expect(sources).toHaveText("信源");
    } finally {
      badgeFailure = false;
      resumeBadges();
      await context.close();
    }
  }
});

test("hovering private navigation does not repeat the page's reads before clicking", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(web.origin + "/admin/content");
    reads.length = 0;
    const sources = page.locator('nav a[href="/admin/sources"]').filter({ visible: true });
    await sources.hover();
    await page.waitForTimeout(250); // Intent prefetch starts after the router's hover delay.
    assert.deepEqual(reads, []);
    await sources.click();
    await expect(page.getByRole("heading", { name: "信源", exact: true })).toBeVisible();
    assert.deepEqual([...reads].sort(), ["/api/admin/me", "/api/admin/nav-counts", "/api/admin/sources"].sort());
  } finally { await page.close(); }
});

test("admin numeric formatting keeps existing missing-value and rounding behavior", () => {
  const values = [null, undefined, "", "bad", NaN, Infinity, -Infinity, -0, -1234567.891, 0, 0.0001, 9.995, 10, 1234567.891, "1234.50"];
  for (const value of values) {
    for (const digits of [0, 1, 2, 4]) {
      const v = Number(value);
      const expected = value == null || value === "" || !Number.isFinite(v) ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
      assert.equal(num(value, digits), expected);
    }
    for (const currency of ["CNY", "USD"]) {
      const v = Number(value);
      const expected = value == null ? "—" : `${currency === "USD" ? "$" : "¥"}${v.toLocaleString("zh-CN", { maximumFractionDigits: v < 10 ? 3 : 2, minimumFractionDigits: 2 })}`;
      assert.equal(money(value, currency), expected);
    }
  }
});

// The 金标 page is the calibration step 1 (docs/selection.md): its rubric must be on the page, not only in the
// docs, and the model's own answer must stay folded away until the admin has committed to theirs.
test("the gold page states the rubric, writes one verdict through the admin api, then reveals the hint", async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  try {
    const before = reads.length;
    await page.goto(web.origin + "/admin/gold");
    await expect(page.getByText("标注细则")).toBeVisible();
    for (const label of ["该进精选", "不该进", "两可"]) await expect(page.getByRole("button", { name: label, exact: true }).first()).toBeVisible();
    await expect(page.getByText("T1 门槛 55")).toBeVisible();
    await expect(page.getByText("金标检查条目")).toBeVisible();
    assert.deepEqual(
      [...new Set(reads.slice(before).filter((path) => path !== "/api/admin/me" && !path.startsWith("/api/admin/nav-counts")))],
      ["/api/admin/gold"],
      "the sheet and the agreement numbers come from one read, and opening the page reads nothing else",
    );

    const hint = page.locator("details").filter({ hasText: "模型怎么说" }).first();
    assert.equal(await hint.evaluate((el) => (el as HTMLDetailsElement).open), false, "the hint starts folded so the verdict is given first");
    await page.getByRole("button", { name: "该进精选", exact: true }).first().click();
    await expect.poll(() => saved.length).toBeGreaterThan(0);
    assert.equal(saved.at(-1)!.decision, "select");
    assert.equal(saved.at(-1)!.split, "development");
    assert.equal(await hint.evaluate((el) => (el as HTMLDetailsElement).open), true, "after judging, the same card may show what the model said");

    // Deleting a wrong label is part of the workflow: the DELETE carries no body, so it must not claim the
    // JSON content type either (the api answers that with 400 before the route runs).
    await page.getByRole("button", { name: "删除", exact: true }).first().click();
    await expect.poll(() => deleted.length).toBeGreaterThan(0);
    assert.match(deleted.at(-1)!, /^gold-fixture-\d+$/);

    const res = await fetch(web.origin + "/admin/gold");
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  } finally { await context.close(); }
});
