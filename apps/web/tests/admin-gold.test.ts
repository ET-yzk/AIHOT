// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
// Failure modes fixed before changing the 金标 page: the rubric and the calibration loop live only in the
// docs; the model's own answer is shown before the admin has given theirs; a verdict or a deletion never
// reaches the admin api; the page reads more than the gold board and the latest eval rounds.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let browser: Browser;
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
// The gold page also carries the latest eval rounds (imported into SelectBench by scripts/eval-selection.ts):
// the loop section is what makes 标注 → 评测 → 改门槛 → 再评测 visible without leaving the page.
const benchRuns = {
  runs: [{
    id: "bench-fixture-1", label: "development 40 条 · fixture-score-model", split: "development", sample_size: 40,
    prompt_version: "prompt@deadbeef", models: ["fixture-score-model"],
    summary: { "fixture-score-model": { completeAccuracy: 0.5, f1: 0.5 } },
    created_at: goldFixtureAt, imported_by: "script:eval-selection", cases: 40,
  }],
};
const api = fakeApi(async (url, res, req) => {
  if (url.pathname.startsWith("/api/admin/")) reads.push(url.pathname);
  if (url.pathname === "/api/admin/me") return { name: "后台性能检查", csrf: "fixture", dev: true };
  if (url.pathname === "/api/admin/nav-counts") return { sources: 7 };
  if (url.pathname === "/api/admin/gold") return goldView;
  if (url.pathname === "/api/admin/selectbench") return benchRuns;
  if (req.method === "POST" && url.pathname.startsWith("/api/admin/gold/")) {
    const body = await new Promise<string>((resolve) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => resolve(raw)); });
    saved.push(JSON.parse(body) as { decision: string; split: string });
    return { caseId: url.pathname.split("/").pop(), decision: saved.at(-1)!.decision, split: saved.at(-1)!.split };
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/gold/")) {
    // Mirror the api (Fastify): a DELETE that declares a JSON content type but sends no body is rejected
    // with 400 "The request could not be processed." before the route runs.
    if ((req.headers["content-type"] ?? "").includes("application/json")) {
      res.statusCode = 400;
      return { detail: "The request could not be processed." };
    }
    deleted.push(url.pathname.split("/").pop()!);
    return { caseId: deleted.at(-1) };
  }
});

before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => {
  await browser?.close();
  await web?.stop();
});

// The 金标 page is the calibration step 1 (docs/selection.md): its rubric must be on the page, not only in the
// docs, and the model's own answer must stay folded away until the admin has committed to theirs.
// The page also frames the whole loop and carries the latest eval rounds, so the SelectBench linkage
// (eval-selection imports every run) is visible where the labelling happens.
test("the gold page states the rubric and the loop, writes one verdict through the admin api, then reveals the hint", async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  try {
    const before = reads.length;
    await page.goto(web.origin + "/admin/gold");
    await expect(page.getByText("校准闭环", { exact: true })).toBeVisible();
    await expect(page.getByText("标注细则", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "development 40 条 · fixture-score-model" })).toBeVisible();
    await expect(page.getByText("评测自动导入")).toBeVisible();
    for (const label of ["该进精选", "不该进", "两可"]) await expect(page.getByRole("button", { name: label, exact: true }).first()).toBeVisible();
    await expect(page.getByText("T1 门槛 55")).toBeVisible();
    await expect(page.getByText("金标检查条目")).toBeVisible();
    assert.deepEqual(
      [...new Set(reads.slice(before).filter((path) => path !== "/api/admin/me" && !path.startsWith("/api/admin/nav-counts")))].sort(),
      ["/api/admin/gold", "/api/admin/selectbench"].sort(),
      "the sheet, the agreement numbers and the latest eval rounds come from the gold and selectbench reads, nothing else",
    );

    const hint = page.locator("details").filter({ hasText: "模型怎么说" }).first();
    assert.equal(await hint.evaluate((el) => (el as HTMLDetailsElement).open), false, "the hint starts folded so the verdict is given first");
    await page.getByRole("button", { name: "该进精选", exact: true }).first().click();
    await expect.poll(() => saved.length).toBeGreaterThan(0);
    assert.equal(saved.at(-1)!.decision, "select");
    assert.equal(saved.at(-1)!.split, "development");
    // The verdict's response and the reveal are separate round-trips; poll rather than read once.
    await expect.poll(() => hint.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);

    // Deleting a wrong label is part of the workflow: the DELETE carries no body, so it must not claim the
    // JSON content type either (the api answers that with 400 before the route runs).
    await page.getByRole("button", { name: "删除", exact: true }).first().click();
    await expect.poll(() => deleted.length).toBeGreaterThan(0);
    assert.match(deleted.at(-1)!, /^gold-fixture-\d+$/);

    const res = await fetch(web.origin + "/admin/gold");
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  } finally { await context.close(); }
});
