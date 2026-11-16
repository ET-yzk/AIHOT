// Topic pages: which articles a topic takes, and their counts.
// Written before the code, from the ways it can go wrong:
// - a company topic takes an article about another company that only mentions it (several subjects,
//   its name nowhere in the title), or drops one about it whose title names it in English, in another
//   case, next to Chinese text, or only by a product (it is the article's only subject);
// - a Latin name matches inside another word ("SACD" is not SAC); a headline naming a company
//   that is not a subject of the article gets in;
// - a technical-direction topic stops taking its tags;
// - withdrawn or not yet released articles appear in a list or a count;
// - an article or story page names a topic its reports do not belong to;
// - an article page cannot tell which of its tags are a topic's own, so they link to filtered lists;
// - a topic without content has no page, or an unknown slug or a page past the end has one.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { TOPICS, loadTopicPage, listTopicSummaries, topicsOfStory } from "@aihot/backend/publication/topics";
import { CATEGORY_TAGS } from "@aihot/industry/taxonomy";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-topics-official-${T}`;
const MEDIA = `test-topics-media-${T}`;
const app = await buildApp();

// The pack's topics these cases are written against (industry/topics.json): three companies, one
// technical direction and one content form. Every report carries the launch category's tag, so a
// report of this fixture lands in exactly one content-form topic and the lists below stay short.
const LAUNCH_TAG = "新车发布";
const GENRE = "vehicle-launch";
if (!(CATEGORY_TAGS as readonly string[]).includes(LAUNCH_TAG)) throw new Error(`the pack has no category tag ${LAUNCH_TAG}`);
/** A topic's browse name, straight from the pack, so a rename does not read as a membership bug. */
const topic = (slug: string) => ({ slug, name: TOPICS.find((t) => t.slug === slug)!.name });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
interface Report {
  source?: string;
  at: Date;
  title: string;
  originalTitle?: string;
  subjects?: string[];
  tags?: string[];
  score?: number;
  selected?: boolean;
  fact?: number;
  category?: string;
}

/** A published report; `fact` links it to a fact before publishing, as grouping would. */
async function report(r: Report): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: r.source ?? MEDIA, url: `https://example.com/topics-${T}-${n}`, title: r.originalTitle ?? r.title, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: r.at,
  });
  await sql`UPDATE articles SET discovered_at = ${r.at}, timeline_at = ${r.at}, grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', ${r.category ?? "vehicle"}, ${r.title}, ${`摘要 ${n}`}, ${r.score ?? 80}, ${r.selected ?? true}, ${r.subjects ?? []}, ${[LAUNCH_TAG, ...(r.tags ?? [])]})`;
  if (r.fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${r.fact}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(r.at.getTime() + 60_000) });
  return articleId;
}

async function story(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
  return { id: s!.id, publicId };
}

async function fact(storyId: number | null, title: string): Promise<number> {
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${randomUUID()}`}, ${storyId}, ${title}) RETURNING id`;
  return f!.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const page = async (slug: string, p = 1) => {
  const data = await loadTopicPage(slug, p, new Date());
  assert.ok(data, `${slug} page ${p}`);
  return data;
};
/** Every article of a topic, over all its pages. */
async function members(slug: string): Promise<string[]> {
  const first = await page(slug);
  const out = ids(first.items);
  for (let p = 2; p <= first.pageCount; p++) out.push(...ids((await page(slug, p)).items));
  return out;
}

test("a company topic takes the articles about it, not the ones that only mention it", async () => {
  const about = await report({ at: hoursAgo(30), title: `比亚迪发布新车型 ${T}`, subjects: ["byd"] });
  const product = await report({ at: hoursAgo(31), title: `腾势新车型上市 ${T}`, subjects: ["byd"] });
  const english = await report({ at: hoursAgo(32), title: `新车型发布 ${T}`, originalTitle: `BYD launches a model ${T}`, subjects: ["byd", "huawei"] });
  const notice = await report({ at: hoursAgo(33), title: `监管部门向华为发出整改通知 ${T}`, subjects: ["huawei", "byd", "nio"] });
  const lowerCase = await report({ at: hoursAgo(34), title: `huawei 公布新的舱内数据框架 ${T}`, subjects: ["huawei", "byd"] });
  const pact = await report({ at: hoursAgo(35), title: `二十余家车企与供应商签署安全协议 ${T}`, subjects: ["huawei", "byd", "bosch"] });
  const sacd = await report({ at: hoursAgo(36), title: `SACD 音频标准发布，华为参与 ${T}`, subjects: ["samr-sac", "huawei"] });
  const adjacent = await report({ at: hoursAgo(37), title: `携手SAC发布新规程 ${T}`, subjects: ["samr-sac", "huawei"] });
  const headline = await report({ at: hoursAgo(38), title: `比亚迪被一篇盘点提到 ${T}`, subjects: ["bosch"] });
  const vision = await report({ at: hoursAgo(39), title: `视觉感知方案发布 ${T}`, tags: ["ADAS 视觉感知"] });

  const byd = await members("byd");
  for (const id of [about, product, english]) assert.ok(byd.includes(id), "about 比亚迪");
  for (const id of [notice, lowerCase, pact, headline]) assert.ok(!byd.includes(id), "only mentions 比亚迪");
  const huawei = await members("huawei");
  for (const id of [notice, lowerCase, sacd]) assert.ok(huawei.includes(id), "about 华为");
  for (const id of [english, pact]) assert.ok(!huawei.includes(id), "only mentions 华为");
  const samr = await members("samr-sac");
  assert.ok(samr.includes(adjacent), "SAC next to Chinese text");
  assert.ok(!samr.includes(sacd), "SACD is not SAC");
  assert.ok((await members("adas-vision")).includes(vision), "a technical direction takes its tag");

  // The article page names the topics it belongs to.
  const topicsOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    return (JSON.parse(res.body) as { topics: Array<{ slug: string }> }).topics.map((t) => t.slug);
  };
  assert.deepEqual(await topicsOf(about), ["byd", GENRE]);
  assert.deepEqual(await topicsOf(notice), ["huawei", GENRE]);
  assert.deepEqual(await topicsOf(pact), [GENRE]);
  assert.deepEqual(await topicsOf(vision), ["adas-vision", GENRE]);
});

test("an article page says which of its tags are a topic's own", async () => {
  // A direction's or a form's tags, and the tag cards show for a company (its subject tag is never shown).
  const id = await report({ at: hoursAgo(3), title: `Anthropic 开源智能体框架 ${T}`, subjects: ["anthropic", "openai"], tags: ["Agent", "开源/仓库", "Anthropic", "OpenAI", "框架"] });
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  const body = JSON.parse(res.body) as { tags: string[]; tagTopics: Record<string, string>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.tags, ["模型发布", "Agent", "开源/仓库", "Anthropic", "OpenAI", "框架"]);
  assert.deepEqual(body.tagTopics, { "模型发布": "model-releases", Agent: "agent", "开源/仓库": "open-source", Anthropic: "anthropic", OpenAI: "openai" });
  // The company its title does not name is a topic of the tag, not of the article.
  assert.deepEqual(body.topics.map((t) => t.slug), ["anthropic", "agent", "open-source", "model-releases"]);
});

test("renaming a company topic keeps its old full name usable for search", async () => {
  // A rename keeps the old full name usable for search by declaring it as an alias, so which spellings
  // a topic answers to is the pack's business: this walks all of them instead of assuming one. The
  // subject tag is what the search falls back on when a title never writes the company out.
  const companies = TOPICS.filter((t) => t.entityId);
  assert.ok(companies.length > 0, "the pack names at least one company topic");
  for (const company of companies) {
    assert.ok(company.aliases.length > 0, `${company.slug} answers to some name`);
    const id = await report({at: hoursAgo(2), title: `新车型上市 ${T}`, subjects: [company.entityId!], selected: false});
    for (const name of company.aliases) {
      const res = await app.inject({method: 'GET', url: `/api/site/pool?q=${encodeURIComponent(name)}`});
      assert.equal(res.statusCode, 200);
      assert.ok(ids(JSON.parse(res.body).items).includes(id), `${name} must find subject-tagged reports`);
    }
  }
});

test("a story page names the topics of its reports", async () => {
  const launch = await story(`视觉感知方案 V2 发布 ${T}`);
  await report({ source: OFFICIAL, at: hoursAgo(26), title: `视觉感知方案 V2 发布 ${T}`, tags: ["ADAS 视觉感知"], fact: await fact(launch.id, "发布 V2") });
  assert.deepEqual(await topicsOfStory(launch.id), [topic("adas-vision"), topic(GENRE)]);
});

test("withdrawn articles stay out of lists and counts", async () => {
  const kept = await report({ at: hoursAgo(5), title: `吉利发布新平台 ${T}`, subjects: ["geely"] });
  const withdrawn = await report({ at: hoursAgo(4), title: `吉利撤回的消息 ${T}`, subjects: ["geely"] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;

  const data = await page("geely");
  assert.deepEqual(ids(data.items), [kept]);
  assert.equal(data.topic.total, 1);
  const summary = (await listTopicSummaries()).topics.find((t) => t.slug === "geely")!;
  assert.equal(summary.latest?.title, `吉利发布新平台 ${T}`, "the index shows the newest public article");
});

test("every topic has a page; unknown topics and pages past the end have none", async () => {
  const empty = await page("catarc");
  assert.equal(empty.topic.indexable, false, "a topic without content is not indexed");
  assert.deepEqual(empty.items, []);
  assert.equal(await loadTopicPage("not-a-topic", 1, new Date()), null);
  assert.equal(await loadTopicPage("catarc", 2, new Date()), null);
  const index = await app.inject({ method: "GET", url: "/api/site/topics" });
  const body = JSON.parse(index.body) as { groups: Array<{ key: string }>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.groups.map((g) => g.key), ["company", "field", "genre"]);
  assert.deepEqual(body.topics.map((t) => t.slug).sort(), TOPICS.map((t) => t.slug).sort(), "the index lists every topic");
});
