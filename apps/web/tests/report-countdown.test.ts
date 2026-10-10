// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
// What a reader gets of the module's block (FR-02-05): the dates with their countdown, one line for the
// blocks that had nothing, and never the internal words that decide whether a report is corroborated.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

const cited = (title: string): ReportCitation => ({
  itemId: `i-${title}`, title, summary: `《${title}》的正文摘要。`, sourceName: "测试法规源", sourceUrl: "https://example.org/notice",
  sourceIconUrl: null, firstParty: true, publishedAt: "2026-10-09T02:00:00Z", available: true,
});

/** An issue that has dates to count down to, beside one section it did not fill. */
const withDates: ReportDetail = {
  kind: "daily", key: "2026-10-10", issueNumber: 1, title: "测试日报", generatedAt: "2026-10-10T00:00:00Z",
  lead: { title: "工信部发布新版自动驾驶安全要求", leadParagraph: "要求分两步实施。" }, leadItemId: "i-a", overview: null,
  highlights: [], sections: [{ label: "法规与标准", summary: null, items: [cited("a")] }], flashes: [], cover: null,
  metrics: {}, readingMinutes: 1, prev: null, next: null,
  blocks: [{
    label: "实施倒计时",
    items: [
      { title: "某征求意见稿", what: "意见反馈截止", on: "2026-10-20", days: 10, url: null },
      { title: "GB 44497—2024 智能网联汽车 数据安全", what: "实施", on: "2026-11-01", days: 22, url: "https://example.org/gb" },
    ],
  }],
  silence: ["北京时间 10 月 9 日 08:00 至 10 月 10 日 08:00，没有新的测评与认证。"],
};

/** An issue whose module had no date inside the horizon: the block is not laid out, its line is printed. */
const withoutDates: ReportDetail = {
  ...withDates, key: "2026-10-11", generatedAt: "2026-10-11T00:00:00Z", blocks: [],
  silence: ["北京时间 10 月 10 日 08:00 至 10 月 11 日 08:00，没有新的测评与认证。", "未来 90 天没有临近的实施日期或意见截止。"],
};
const issues: Record<string, ReportDetail> = { "2026-10-10": withDates, "2026-10-11": withoutDates };

let web: WebServer;
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://api.local").pathname;
  res.setHeader("Content-Type", "application/json");
  if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
  if (path === "/api/site/reports/daily") {
    return res.end(JSON.stringify({ kind: "daily", items: Object.values(issues).map((r) => ({ key: r.key, issueNumber: r.issueNumber, title: r.title, count: 1 })) }));
  }
  const match = /^\/api\/site\/reports\/daily\/(.+)$/.exec(path);
  if (match) {
    const issue = issues[match[1]!];
    if (issue) return res.end(JSON.stringify(issue));
    if (match[1] === "latest-page") return res.end(JSON.stringify({ index: [], report: withDates }));
    if (match[1]!.startsWith("navigation/")) return res.end(JSON.stringify({ items: [] }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => { web = await startWebServer(api); });
after(() => web.stop());

/** One issue's page, as the writer stored it and as a reader sees it (markup, scripts and separators gone). */
async function issue(key: string): Promise<{ html: string; visible: string }> {
  const response = await fetch(`${web.origin}/daily/${key}`);
  assert.equal(response.status, 200, web.logs());
  const html = await response.text();
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");
  return { html, visible };
}

test("the daily prints the module's dates with the days left and its source link", async () => {
  const { html, visible } = await issue("2026-10-10");
  assert.match(visible, /实施倒计时/);
  assert.match(visible, /意见反馈截止\s*2026-10-20\s*还有 10 天/);
  assert.match(visible, /实施\s*2026-11-01\s*还有 22 天/);
  assert.match(html, /href="https:\/\/example\.org\/gb"/, "a dated rule the reader can open");
  // The block is a page of its own, so it is in the issue's contents too.
  assert.match(html, /id="b-1"/);
});

test("a block the issue had no dates for prints one line instead of an empty page", async () => {
  const { html, visible } = await issue("2026-10-11");
  assert.doesNotMatch(html, /id="b-1"/, "the block with nothing under it is not laid out as a page");
  assert.doesNotMatch(visible, /还有 \d+ 天/);
  assert.match(visible, /未来 90 天没有临近的实施日期或意见截止。/);
  // A section that stayed empty is named in prose, in the pack's sentence, never as a zero count.
  assert.match(visible, /北京时间 10 月 10 日 08:00 至 10 月 11 日 08:00，没有新的测评与认证。/);
  assert.doesNotMatch(visible, /测评与认证 0 件/);
});

test("the words that mark a report as corroborated never reach the reader's issue", async () => {
  for (const key of Object.keys(issues)) {
    const { visible } = await issue(key);
    for (const word of ["印证", "待核实", "信源级别", "T1", "T2", "T3"]) {
      assert.ok(!visible.includes(word), `${key} names ${word} to the reader (FR-02-06)`);
    }
  }
});
