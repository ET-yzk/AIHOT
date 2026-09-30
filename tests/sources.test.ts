// Listing parsers on the page shapes Jina returns for real sites: card links that wrap
// an image, a title attribute, http links under https prefixes, and navigation that is no post. Also
// what made articles flip between versions: in-page anchors of an HTML listing and
// promotions a feed rotates inside its posts. And a vendor homepage whose posts have no links in
// its HTML: read without its adapter, it gave the menu (Sample Desktop, 简体中文) as articles.
// The adapter's own name (mimo_home) and the class names, chunk shapes and section titles below are
// what the parser in sources/web-list.ts looks for, so they stay as they are; the pages are synthetic.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sanitizeBody, trimTrailingChrome } from "@aihot/backend/content/sanitize";
import { fetchDetail, fetchWebList, fromHtml, fromMarkdown } from "@aihot/backend/sources/web-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { noiseFiltered } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

const source = (config: Record<string, unknown>) => ({ id: "test-list", config }) as never;

// A script-navigated homepage, cut down: rows that navigate by script, the runtime's chunk
// map, the route table naming the homepage's chunks, and the chunk with the Blog list among the menu,
// the product cards, the other sections and a Paper list built at run time.
const pages: Record<string, (cdn: string) => string> = {
  "/": (cdn) =>
    `<html><head><script defer src="${cdn}static/js/lib-react.a6be410a.js"></script><script defer src="${cdn}static/js/4752.2908c99e.js"></script>` +
    `<script defer src="${cdn}static/js/index.c5195ace.js"></script></head><body><a href="/zh/index">简体中文</a><a href="/samplecode">Sample Code</a>` +
    `<a href="/go/desktop">Sample Desktop</a><a href="/#paper">Paper</a><a href="/#blog">Blog</a><a href="/#joinUs">Join Us</a><div id="blog-list">` +
    `<div class="blogRow-kPt4Cj" data-font-interactive="true"><h3 data-font-text="true">Diagnosing and Mitigating Loop Repetition in Sample-R2.6</h3></div></div></body></html>`,
  // A redesign that moved the list elsewhere.
  "/redesigned/": (cdn) => `<html><head><script defer src="${cdn}static/js/lib-react.a6be410a.js"></script></head><body><a href="/go/desktop">Sample Desktop</a></body></html>`,
  // A news feed: a teaser that ends in "Read the full story", next to a post whose feed carries it whole.
  "/story.xml": () =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<entry><title>Loxfield is acquiring Riverton</title><link rel="alternate" href="https://example.org/loxfield-riverton"/><published>2026-09-28T17:31:35-04:00</published>` +
    `<summary type="html">Loxfield announced today that it's acquiring Riverton.</summary>` +
    `<content type="html"><![CDATA[<p>${"Loxfield announced today that it is acquiring Riverton in an all-stock deal. ".repeat(8)}</p><p>Read the full story at Sample Daily.</p>]]></content></entry>` +
    `<entry><title>A whole post</title><link rel="alternate" href="https://example.org/whole"/><published>2026-09-28T10:00:00Z</published>` +
    `<content type="html"><![CDATA[<p>${"The feed carries this post whole, paragraph after paragraph. ".repeat(30)}</p>]]></content></entry></feed>`,
  // A list API that gives calendar days as yyyymmdd.
  "/days.json": () => JSON.stringify({ data: { list: [{ seq: 695, ttl: "Awards", day: "20260922" }, { seq: 1, ttl: "Bad day", day: "20260230" }] } }),
  // A developer blog: no date in the feed or in meta tags, only in JSON-LD.
  "/ld-post": () =>
    `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Blog"},` +
    `{"@type":"BlogPosting","headline":"Turn fleet APIs into dashboards","datePublished":"2026-09-24"}]}</script></head><body><p>Post</p></body></html>`,
  "/cdn/static/js/lib-react.a6be410a.js": () => '"use strict";(self.webpackChunk=self.webpackChunk||[]).push([["lib-react"],{}]);',
  "/cdn/static/js/index.c5195ace.js": (cdn) =>
    '(()=>{var e={},a={};function t(d){return a[d]}t.u=e=>"static/js/async/"+e+"."+({6159:"4efb0769",7298:"a1b2c3d4",8557:"2d420be2"})[e]+".js",' +
    `t.miniCssF=e=>""+e+".css",t.p="${cdn}",t.rv=()=>"1.3.12"})();`,
  "/cdn/static/js/4752.2908c99e.js": () =>
    '(self.webpackChunk=self.webpackChunk||[]).push([["4752"],{1:function(e,a,t){let r=[{path:"/",element:o.createElement(S),filePath:"en/index.mdx",' +
    'preload:async()=>(await S.preload(),Promise.all([t.e("7298"),t.e("6159"),t.e("8557")]).then(t.bind(t,57573))),lang:"en",version:""},' +
    '{path:"/blog/sample-r2-6-loop-repetition",element:o.createElement(k),filePath:"en/blog/sample-r2-6-loop-repetition.mdx",' +
    'preload:async()=>(await k.preload(),Promise.all([t.e("7298"),t.e("3583"),t.e("8421")]).then(t.bind(t,1105))),lang:"en",version:""}]}}]);',
  "/cdn/static/js/async/7298.a1b2c3d4.js": () => '(self.webpackChunk=self.webpackChunk||[]).push([["7298"],{2:function(){}}]);',
  "/cdn/static/js/async/6159.4efb0769.js": () => '(self.webpackChunk=self.webpackChunk||[]).push([["6159"],{3:function(e,i,t){t.d(i,{H:()=>n})}}]);',
  "/cdn/static/js/async/8557.2d420be2.js": () =>
    '(self.webpackChunk=self.webpackChunk||[]).push([["8557"],{57573:function(e,i,t){function h(e){return(0,n.jsxs)(a.Me,{children:[' +
    '(0,n.jsx)(m.H,{models:[{name:"Sample-R2.6-Series",desc:"Frontier capability in every modality, built in the open.",imageKey:"sample-r2-5-pro",link:"/sample-r2-6"}]}),' +
    '(0,n.jsx)(d.z,{sectionTitle:"Build with Sample",experiences:[{title:"Sample Gallery",link:"/sample-gallery/",desc:"Step into the world created by Sample-R2.6"}]}),' +
    '(0,n.jsx)(r.K,{sectionId:"paper",sectionTitle:"Paper",blogs:l.G.slice().reverse().map(e=>({title:e.title,link:`/paper/${e.slug}`,desc:(0,l.V)(e.date,!1)}))}),' +
    '(0,n.jsx)(r.K,{sectionTitle:"Blog",initialVisibleCount:8,blogs:[' +
    '{title:"Diagnosing and Mitigating Loop Repetition in Sample-R2.6",link:"/blog/sample-r2-6-loop-repetition",desc:"A lesson from scaling the test runs: the reward blind spot."},' +
    '{title:"Introducing Sample-R2.6 series",link:"/sample-r2-6",desc:"Frontier capability in every modality, built in the open."},' +
    '{title:"How Sample-R2.6-Pro Boosts Productivity in New Materials R\\u0026D",link:"/blog/sample-r2-6-material-research",desc:"From literature review to \\"dry-lab\\" experiments."},' +
    '{title:"Sample-R2.5-Pro",link:"/sample-r2-5-pro/index.html",desc:"A leap in long horizon coherence."},' +
    '{title:"Sample Humanities and Social Sciences Capability Assessment",link:"/blog/sample-r2-flash-hss",desc:"Sample Humanities and Social Sciences Capability Assessment"}]}),' +
    '(0,n.jsx)(c.Q,{sectionTitle:"Join Us",positions:[{title:"Research Scientist - Pre-training",link:"joinUs/pre-training"}],contactEmail:"sample@example.org"})]})}}}]);',
};
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  const found = Object.hasOwn(pages, path);
  res.writeHead(found ? 200 : 404, { "content-type": path.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8" });
  res.end(found ? pages[path]!(`${site}/cdn/`) : "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("Jina card links become posts with their own titles", () => {
  const md = [
    "[Skip to main content](http://example.org/blog/#main)",
    "[![Image 1: hero](https://cdn.example.org/a.jpg) ##### 示范厂商发布SR-Act 2.0 新闻资讯 | 2026-09-20](https://example.org/blog/220.html \"示范厂商发布SR-Act 2.0\")",
    "[![Image 2](https://cdn.example.org/b.png) ##### 示范手机 X100 测评 尾巴视频](http://example.org/blog/784.html)",
    "[![Image 3](https://cdn.example.org/c.png)](https://example.org/blog/carousel.html)",
    "# [Introducing v6](http://example.org/blog/introducing-v6)",
    "[2026](http://example.org/blog/2026) [Algorithms & Theory](http://example.org/blog/label/algorithms) [Next page](http://example.org/blog/page/2)",
  ].join("\n\n");
  const out = fromMarkdown(md, "https://example.org", source({ url: "https://r.jina.ai/http://example.org/blog/", allowUrlPrefixes: ["https://example.org/blog/"] }));
  assert.deepEqual(out, [
    { url: "https://example.org/blog/220.html", title: "示范厂商发布SR-Act 2.0" },
    { url: "https://example.org/blog/784.html", title: "示范手机 X100 测评 尾巴视频" },
    { url: "https://example.org/blog/introducing-v6", title: "Introducing v6" },
  ]);
});

test("anchors into the listing page itself are navigation, not posts", () => {
  // A homepage links its own sections (#paper, #blog, #join): all one address once the fragment goes.
  const html = [
    '<a href="/#paper">Paper</a>', '<a href="/#blog">Blog</a>', '<a href="https://example.org/#join">Join Us</a>',
    '<a href="/">Home</a>', '<a href="/blog/sample-r2-6-loop-repetition">Diagnosing Loop Repetition</a>',
  ].join("");
  const out = fromHtml(html, "https://example.org/", source({ url: "https://example.org/" }));
  assert.deepEqual(out.map((c) => c.url), ["https://example.org/blog/sample-r2-6-loop-repetition"]);
});

test("promotions a feed rotates inside its posts are left out of the body", () => {
  // A research site's feed puts a different podcast or product promotion into each post on every load.
  const promo = (label: string, name: string) =>
    `<div class="border-bottom border-top mt-5 mb-5 msr-promo text-center alignwide" data-bi-aN="promo">` +
    `<p class="msr-promo__label text-uppercase"><span>${label}</span></p><div class="row"><div class="msr-promo__content">` +
    `<h2 class="h4">${name}</h2><p>Join the researchers.</p><a href="https://example.org/podcast">Listen now</a></div></div></div>`;
  const post = (p: string) => `<p>Skala is now available in the tools scientists use.</p>${p}<p>From community release to native integration.</p>`;
  const a = sanitizeBody(post(promo("PODCAST SERIES", "Ideas")), "https://example.org/post");
  const b = sanitizeBody(post(promo("", "Harbor Labs")), "https://example.org/post");
  assert.equal(a, b, "the same post whichever promotion it carried");
  assert.ok(!/PODCAST SERIES|Ideas|Harbor Labs|Listen now/.test(a));
  assert.ok(a.includes("native integration"), "the post's own text stays");
});

test("the script-navigated homepage lists its posts and product pages, not its menu", async () => {
  const out = await fetchWebList(source({ url: `${site}/`, adapter: "mimo_home" }));
  assert.deepEqual(out, [
    { url: `${site}/blog/sample-r2-6-loop-repetition`, title: "Diagnosing and Mitigating Loop Repetition in Sample-R2.6", excerpt: "A lesson from scaling the test runs: the reward blind spot." },
    { url: `${site}/sample-r2-6`, title: "Introducing Sample-R2.6 series", excerpt: "Frontier capability in every modality, built in the open." },
    { url: `${site}/blog/sample-r2-6-material-research`, title: "How Sample-R2.6-Pro Boosts Productivity in New Materials R&D", excerpt: 'From literature review to "dry-lab" experiments.' },
    { url: `${site}/sample-r2-5-pro/index.html`, title: "Sample-R2.5-Pro", excerpt: "A leap in long horizon coherence." },
    { url: `${site}/blog/sample-r2-flash-hss`, title: "Sample Humanities and Social Sciences Capability Assessment", excerpt: null },
  ]);
});

test("a homepage without the list fails the fetch instead of listing its menu", async () => {
  // The adapter's name is what sources/web-list.ts registers (an upstream special case, not pack data).
  await assert.rejects(fetchWebList(source({ url: `${site}/redesigned/`, adapter: "mimo_home" })), /mimo_home/);
});

test("config entries a source kind does not implement are named, not ignored", () => {
  // Configs naming adapters or rules a collector does not implement used to fall back to the generic parse.
  assert.deepEqual(
    unsupportedConfig("web_list", { url: "https://example.org/", adapter: "site_cards", detail: { maxFetches: 5, titleFoo: "h1" }, contentPublic: false }),
    ["adapter=site_cards", "detail.titleFoo", "contentPublic"],
  );
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://example.org/feed", denyUrlPrefixes: ["https://example.org/business/"] }), []);
  assert.deepEqual(unsupportedConfig("x_search", { query: "from:a", allowUrlPrefixes: ["https://example.org/"] }), [], "X shards apply the same URL rules");
});

test("a listing that links other articles in its teasers takes only the links that begin a line", () => {
  // 一个行业媒体的目录页走 Jina：每条标题独占一行，摘要里内联链到旧稿。
  const md = [
    "### [WP.29 工作组通过座椅头部碰撞新修正案](https://example.org/2026/09/27/wp29-headrest)",
    "[![Image 3: 独家](https://example.org/a.jpg)](https://example.org/2026/09/27/dms-mandate)",
    "[独家：明年起新车型全系标配驾驶员监测](https://example.org/2026/09/27/dms-mandate)",
    "[高速 NOA 事故回溯：三周内的三次推送](https://example.org/2026/09/25/noa-ota)[![Image 12: 事故车辆](https://example.org/b.jpg)](https://example.org/2026/09/25/noa-ota)",
    "该车型的两批召回在周五被撤销，三周里 [反复推送的补丁](https://example.org/2026-09-15/noa-loop) 一直没解决。",
    "**为什么重要：** 座舱感知很耗电。[标准起草上的分歧](https://example.org/2026-09-24/regulation-politics) 会拖慢进度。",
    "[延伸阅读（3 分钟）](https://example.org/2026/09/25/noa-ota)",
  ].join("\n\n");
  const config = { url: "https://r.jina.ai/https://example.org/technology", allowUrlPrefixes: ["https://example.org/2"], linksStartLine: true };
  assert.deepEqual(fromMarkdown(md, "https://example.org", source(config)).map((c) => c.title), [
    "WP.29 工作组通过座椅头部碰撞新修正案",
    "独家：明年起新车型全系标配驾驶员监测",
    "高速 NOA 事故回溯：三周内的三次推送",
  ]);
  assert.equal(fromMarkdown(md, "https://example.org", source({ ...config, linksStartLine: undefined })).length, 5, "without the option prose links count");
});

test("feed text that only teases the article is a summary: the page is fetched before judging", async () => {
  const read = await fetchRss({ id: "test-feed", config: { feedUrl: `${site}/story.xml` }, participation_mode: "editorial", cursor: null } as never, { force: true });
  const [teaser, whole] = read.candidates;
  assert.equal(teaser!.bodyStatus, "pending");
  assert.equal(teaser!.bodyText, null);
  assert.equal(teaser!.excerpt, "Loxfield announced today that it's acquiring Riverton.");
  assert.equal(whole!.bodyStatus, "ok");
  assert.ok(whole!.bodyText!.length > 1200);
  // Discussion sources only need what the feed says.
  const signal = await fetchRss({ id: "test-feed", config: { feedUrl: `${site}/story.xml` }, participation_mode: "hot_signal", cursor: null } as never, { force: true });
  assert.equal(signal.candidates[0]!.bodyStatus, "ok");
});

test("hidden page parts are dropped whole, and a news page's closing blocks are trimmed", () => {
  // microsoft.ai posts carry <template> blocks of base64 that became 330,000 characters of "body".
  const html = sanitizeBody(
    `<p>MAI-Transcribe-2 is our most capable transcription model.</p><template><div><p>${"QUFB".repeat(500)}</p></div></template>` +
      `<svg><text>chart label</text></svg><p>Energy <math><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></math> matters.</p>`,
    "https://example.org/post",
  );
  assert.ok(!/QUFB|chart label|mc\^2/.test(html), html);
  assert.ok(html.includes("most capable transcription model") && html.includes("Energy E matters"));
  // A linked chart in a paragraph of its own survives, also when a translation is cleaned again.
  const chart = '<p><a href="https://example.org/chart.png"><img src="https://example.org/chart.png" alt="B200 prices"></a></p>';
  assert.ok(sanitizeBody(sanitizeBody(`<p>Prices doubled.</p>${chart}<p> </p>`)).includes('alt="B200 prices"'));
  assert.equal(sanitizeBody("<p>Text.</p><p> <br></p><p><a href=\"https://example.org/\"></a></p>"), "<p>Text.</p>");
  // TechCrunch ends every article the same way.
  const article = "<p>MongoDB’s shares dropped by more than 17%.</p><h2>Topics</h2><p>More on the deal.</p><p>Subscribe to our plan to get the API.</p>";
  assert.equal(trimTrailingChrome(`${article}<p>Topics</p><p>Subscribe for the industry’s biggest tech news</p><h2>Latest in AI</h2>`), article);
  assert.equal(trimTrailingChrome(article), article);
});

test("noise words match whatever their case", () => {
  // 笔记本 is noise, but the lower-case exemption agent keeps a post about an Agent product.
  const source = { config: { ingestNoiseFilter: { dropMarkers: ["笔记本", "iphone"], keepIfMatches: ["agent"] } } } as never;
  const c = (title: string, excerpt: string) => ({ url: "https://example.org/a", title, excerpt }) as never;
  assert.equal(noiseFiltered(c("Manus：正组建团队开发面向国内市场的产品", "与笔记本厂商合作的 Agent 产品"), source), false);
  assert.equal(noiseFiltered(c("新款笔记本开售", "首发价 4999 元"), source), true);
  assert.equal(noiseFiltered(c("iPhone 18 开售", ""), source), true);
});

test("dates in yyyymmdd and in JSON-LD are read", async () => {
  const days = await fetchJsonList({ id: "test-json", config: { url: `${site}/days.json`, itemsPath: "data.list", titlePaths: ["ttl"], urlTemplate: "https://example.org/blog/view?seq={seq}", publishedAtPath: "day", publishedAtUnit: "yyyymmdd" } } as never);
  assert.deepEqual(days.map((c) => c.publishedAt?.toISOString() ?? null), ["2026-09-22T00:00:00.000Z", null], "February 30 is no date");
  const got = await fetchDetail(`${site}/ld-post`, { id: "test-feed", config: { detail: { maxFetches: 20 } } } as never, { date: true, title: false, summary: false, body: false });
  assert.equal(got.publishedAt?.toISOString(), "2026-09-24T00:00:00.000Z");
});
