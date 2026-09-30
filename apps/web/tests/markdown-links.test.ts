import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../app/lib/markdown.ts";

// Copy pages are the only markdown this site renders, and their links are written against whatever address
// the deployment has (SITE_URL). A domain baked into the renderer would classify this site's own links as
// outside ones, and rewrite the address it was baked with into paths of the reader's site.
test("a link to this site's own address is internal, and its origin is dropped", () => {
  process.env.SITE_URL = "https://regwatch.example.cn";
  const { html } = renderMarkdown("## 条款\n\n参见[日报首页](https://regwatch.example.cn/daily)。");
  assert.ok(html.includes('<a href="/daily">日报首页</a>'), html);
  assert.ok(!html.includes("target="), html);
});

test("the bare address of this site is a link too", () => {
  process.env.SITE_URL = "https://regwatch.example.cn";
  const { html } = renderMarkdown("## 首页\n\n回到[本站](https://regwatch.example.cn)。");
  assert.ok(html.includes('<a href="https://regwatch.example.cn">本站</a>'), html);
  assert.ok(!html.includes("target="), html);
});

test("every other address is outside, including the domain the framework came from", () => {
  process.env.SITE_URL = "https://regwatch.example.cn";
  const { html } = renderMarkdown("## 依据\n\n来源[工信部](https://www.miit.gov.cn/x)与[上游示范站](https://aihot.news/daily)。");
  assert.ok(html.includes('<a href="https://www.miit.gov.cn/x" target="_blank" rel="noopener noreferrer">工信部</a>'), html);
  assert.ok(html.includes('<a href="https://aihot.news/daily" target="_blank" rel="noopener noreferrer">上游示范站</a>'), html);
});

test("links already written as paths are left alone", () => {
  process.env.SITE_URL = "https://regwatch.example.cn";
  const { html } = renderMarkdown("## 说明\n\n看[条款](/terms)和[条目](https://elsewhere.test/items/1)。");
  assert.ok(html.includes('<a href="/terms">条款</a>'), html);
  assert.ok(html.includes('<a href="https://elsewhere.test/items/1" target="_blank" rel="noopener noreferrer">条目</a>'), html);
});
