// The plan's stage-one check ends with "标签筛选可用", and until now that had only ever been looked at by
// hand with demo rows: the filters read the published row's own category and tags, so a pack whose taxonomy
// differs answers an empty list rather than failing. Seeded through the real write path (material, analysis,
// publication) and read back through the site API the browser calls, with the categories and the tag taken
// from industry/ so they move when the pack does. Local inject and database only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { CATEGORY_TAGS } from "@aihot/industry/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `test-site-filters-${T}`;
const [FIRST, SECOND] = [CATEGORY_KEYS[0]!, CATEGORY_KEYS[1]!];
const TAG = CATEGORY_TAGS[0]!;
const app = await buildApp();

const ids: Record<string, string> = {};

/** A published pick in `category`, carrying `tags`. The marker is in the title so the row is findable. */
async function article(name: string, category: string, tags: string[]): Promise<string> {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.org/${T}/${name}`, title: `Filter ${name} ${T}`, bodyText: `BODY ${name} ${T}`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 60_000),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, tags, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${tags}::text[], ${`标题-${name}`}, ${`摘要-${name}`}, '理由', 90, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  ids[name] = articleId;
  return articleId;
}

const timeline = async (query: string) => {
  const res = await app.inject({ method: "GET", url: `/api/site/timeline?limit=40${query}` });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
};
const listed = (body: Record<string, any>) => (body.cards as { item: { id: string } }[]).map((c) => c.item.id);

before(async () => {
  await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test site filters', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  await article("first-tagged", FIRST, [TAG]);
  await article("first-plain", FIRST, []);
  await article("second", SECOND, []);
});

after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("a category filter answers with that category's items only", async () => {
  // Subset assertions, not the whole page: other files publish items of the same category in the shared test
  // database, and a filter test that demanded to see its own rows alone would fail on the run order.
  const mine = await timeline(`&category=${FIRST}`);
  assert.deepEqual(mine.filters, { channel: "all", category: FIRST, tag: null, topic: null });
  const mineIds = listed(mine);
  assert.ok(mineIds.includes(ids["first-tagged"]) && mineIds.includes(ids["first-plain"]), "both items of this category");
  assert.ok(!mineIds.includes(ids.second), "and none of the other category");
  const theirs = listed(await timeline(`&category=${SECOND}`));
  assert.ok(theirs.includes(ids.second), "the other category answers for its own item");
  assert.ok(!theirs.includes(ids["first-plain"]), "and not for this one");
});

test("a tag filter answers with the tagged item only", async () => {
  const body = await timeline(`&tag=${encodeURIComponent(TAG)}`);
  assert.equal(body.filters.tag, TAG);
  assert.ok(listed(body).includes(ids["first-tagged"]), "the item that carries the tag is there");
  assert.ok(!listed(body).includes(ids["first-plain"]), "the same category without the tag is not");
});

test("a category the pack does not have is refused, not answered as an empty list", async () => {
  const res = await app.inject({ method: "GET", url: `/api/site/timeline?category=${T}` });
  assert.equal(res.statusCode, 400, res.body);
});

test("the public list agrees with the site about which items a category holds", async () => {
  const site = listed(await timeline(`&category=${FIRST}`));
  const v1 = await app.inject({ method: "GET", url: `/api/v1/items?mode=selected&window=7d&limit=30&category=${FIRST}` });
  assert.equal(v1.statusCode, 200, v1.body);
  const publicIds = (JSON.parse(v1.body).items as { id: string }[]).map((i) => i.id);
  for (const id of site) assert.ok(publicIds.includes(id), `${id} is in the site's category list but not the public one`);
});
