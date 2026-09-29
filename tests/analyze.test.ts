// The judging and writing steps (editorial/analyze.ts): the prefilter decides relevance, two scores
// against the tier threshold decide 精选, selected and near-selected items are written by the content
// understanding and the rest by the title/summary prompts, a structure step gives the category, subjects
// and fact. Material with only a feed summary has its page fetched first. The steps run on the models
// AIHOT assigns them (set through the environment here); every prompt in the pack renders.
// Nothing here is the sample industry's own data: categories, item types, tags and thresholds are read
// from the pack, and the steps are told apart by the prompt text the pack renders for them.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, SCORE_CALLS, SCORE_SYSTEM, tierThreshold, UNDERSTAND_FLOOR } from "@aihot/backend/editorial/analyze";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { compactAnswerFirstSummary, enforceIdentity, matchEntityIds, parseTranslateOutput, PREFILTER_SYSTEM, UNDERSTAND_SYSTEM } from "@aihot/backend/editorial/writing";
import { promptText } from "@aihot/backend/editorial/prompts";
import { CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ITEM_TYPES, TOPIC_TAGS } from "@aihot/backend/editorial/vocabulary";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/industry/site";
import { SELECTION } from "@aihot/industry/selection";
import { IDENTITY_LEXICON, TAG_SYNONYMS } from "@aihot/industry/taxonomy";

const T = tag();
const SOURCE = `test-analyze-${T}`;
const X_SOURCE = `test-analyze-x-${T}`;

/** The pack's own values, which the stub answers with and the assertions below expect. */
const CATEGORY = CATEGORY_KEYS[0]!;
const ITEM_TYPE = ITEM_TYPES[0]!;
const CATEGORY_TAG = CATEGORY_TAGS[0]!;
const UNDERSTAND_TAG = TOPIC_TAGS[0]!;
const STRUCTURE_TAG = TOPIC_TAGS[1]!;
/** A synonym the pack folds onto a category tag other than the one an answer starts with. */
const [SYNONYM, SYNONYM_TAG] = Object.entries(TAG_SYNONYMS).find(([, target]) => target !== CATEGORY_TAG && (CATEGORY_TAGS as readonly string[]).includes(target))!;
/** A subject the pack gives a card tag: the tag the judgement appends to the answer's own. */
const [SUBJECT, SUBJECT_ENTITY] = Object.entries(ENTITIES).find(([, e]) => e.displayTag !== null)!;
/** Scores come from the pack's thresholds: the tier the test's sources are filed under, and its floor. */
const TIER = Object.keys(SELECTION.thresholds)[0]!;
const THRESHOLD = tierThreshold(TIER)!;
const FLOOR = UNDERSTAND_FLOOR;
const scores = (a: number, b: number) => [a, b];
const meanOf = ([a, b]: number[]) => Math.floor((a + b) / SCORE_CALLS);
const WELL_OVER = scores(THRESHOLD + 18, THRESHOLD + 12);
const JUST_OVER = scores(THRESHOLD, THRESHOLD + 2);
const NEARLY = scores(THRESHOLD, FLOOR); // over twice the floor, under twice the tier threshold
const BELOW_FLOOR = scores(FLOOR - 5, FLOOR - 10);
const BOTH_ALIKE = scores(THRESHOLD + 10, THRESHOLD + 10);
const BARE_SCORES = scores(FLOOR - 20, FLOOR - 16);

type Step = "prefilter" | "score" | "understand" | "summarize" | "structure";
interface Req { step: Step; marker: string; system: string; user: string; body: Record<string, any> }
const requests: Req[] = [];
const MARKERS = ["CLEAR", "RESCUE", "LOW", "OFFTOPIC", "BARE", "VAGUE", "THIN", "SENSITIVE", "推文"];
const scoreAnswers: Record<string, number[]> = { CLEAR: [...WELL_OVER], RESCUE: [...NEARLY], LOW: [...BELOW_FLOOR], THIN: [...BOTH_ALIKE], SENSITIVE: scores(THRESHOLD + 20, THRESHOLD + 20), 推文: scores(FLOOR - 10, FLOOR - 10), BARE: [...BARE_SCORES], VAGUE: [...JUST_OVER] };

// Which step a request belongs to: the system prompt the pack renders for it (the three exported ones
// match exactly; the structure prompt is the one carrying the pack's category guide). The title/summary
// prompts have no system message and are answered in the text format parseTranslateOutput reads.
const stepOf = (system: string, user: string): Step =>
  system === PREFILTER_SYSTEM ? "prefilter" : system === SCORE_SYSTEM ? "score"
  : system === UNDERSTAND_SYSTEM ? "understand" : system.includes(CATEGORY_GUIDE) ? "structure"
  : !system && user.includes("title_zh") ? "summarize" : (() => { throw new Error("unknown request"); })();

const promptSource = (file: string) => readFileSync(new URL(`../industry/prompts/${file}.md`, import.meta.url), "utf8");
/** The names of the blocks a prompt of the pack inserts, as written in its {{> file}} lines. */
const includesOf = (file: string) => [...promptSource(file).matchAll(/\{\{>\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!);

// One stub stands in for DashScope (prefilter, structure), Zhipu (score, understand) and DeepSeek (summarize).
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> } & Record<string, any>;
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, system, user, body });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: marker === "OFFTOPIC" || marker === "BARE" ? "BLOCK" : marker === "VAGUE" ? "UNKNOWN" : "PASS", reason: "测试" });
  if (step === "score") return answer({ attentionScore: scoreAnswers[marker]!.shift() });
  if (step === "understand") {
    if (marker === "SENSITIVE") return new Reply(400, { contentFilter: [{ level: 1, role: "user" }], error: { code: "1301", message: "系统检测到输入或生成内容可能包含不安全或敏感内容" } });
    // A category tag, a synonym of one, a topic tag and a tag the pack does not list.
    return answer({ itemType: ITEM_TYPE, authorRole: "principal", tags: [CATEGORY_TAG, SYNONYM, UNDERSTAND_TAG, "不存在的标签"], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  }
  if (step === "structure") return answer({ category: CATEGORY, tags: [CATEGORY_TAG, STRUCTURE_TAG], subjects: [SUBJECT, "unknown-subject"], fact: { title: `事实 ${marker}`, subject: "某公司", action: "发布", object: "产品", occurredAt: null } });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";
// AIHOT's own assignment of models to steps (the open-source default is one model for all of them).
Object.assign(process.env, { PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection", UNDERSTAND_MODEL: "glm-5.3-flash", SUMMARIZE_MODEL: "deepseek-flash", STRUCTURE_MODEL: "qwen3.8-flash" });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Test analyze source', 'rss', ${TIER}, 'editorial', '2100-01-01'),
    (${X_SOURCE}, 'Test X account', 'x_search', ${TIER}, 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

// The tag keeps each material unique: identical input would reuse an earlier run's paid answers.
const LONG = "a team released a version with a comparison table and pricing details. ".repeat(8);
const titleOf = (marker: string) => `${marker} launch note ${T}`;
const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${marker}-${T}`, title: titleOf(marker), bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-09-28T01:02:03Z"), ...extra,
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const row = async (id: string) =>
  (await sql<{ selected: boolean; relevance: string; score: string | null; title_zh: string; reason_zh: string | null; category: string | null; tags: string[]; subjects: string[]; receipt_ids: string[]; output: Record<string, any> }[]>`
    SELECT selected, relevance, score, title_zh, reason_zh, category, tags, subjects, receipt_ids, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;

test("every prompt in the pack renders, and the site's name replaces AIHOT's", () => {
  const dir = new URL("../industry/prompts/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  // Every value any prompt asks for, so each renders on its own.
  const names = new Set(files.flatMap((f) => [...promptSource(f.slice(0, -3)).matchAll(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g)].map((m) => m[1]!)));
  const values = Object.fromEntries([...names].map((n) => [n, "x"]));
  for (const file of files) {
    const text = promptText(file.slice(0, -3), values);
    assert.ok(text.length > 20 && !/\{\{/.test(text), file);
  }
  // The prefilter opens with the site's own name, exactly where the pack writes {{siteName}}.
  const first = promptSource("prefilter").split("\n")[0]!;
  const at = first.indexOf("{{siteName}}");
  assert.ok(at >= 0, "the prefilter prompt names the site through {{siteName}}");
  assert.equal(PREFILTER_SYSTEM.slice(0, at + SITE.name.length), `${first.slice(0, at)}${SITE.name}`);
});

test("a selected item: prefilter, two scores, the content understanding and the structure", async () => {
  assert.equal(tierThreshold(TIER), SELECTION.thresholds[TIER], "the tier these sources use is scored at the pack's threshold");
  assert.equal(tierThreshold("tier_the_pack_does_not_list"), null, "a tier without a threshold is not scored for 精选");
  const id = await article("CLEAR");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [true, meanOf(WELL_OVER)], `${WELL_OVER.join(" + ")} is well over twice the ${TIER} threshold`);
  assert.deepEqual(calls("CLEAR").sort(), ["prefilter", "score", "score", "structure", "understand"]);
  const r = await row(id);
  assert.deepEqual([r.title_zh, r.reason_zh, r.category, r.receipt_ids.length], ["理解标题 CLEAR", "理由 CLEAR", CATEGORY, 5]);
  assert.deepEqual(r.tags, [CATEGORY_TAG, SYNONYM_TAG, UNDERSTAND_TAG, SUBJECT_ENTITY.displayTag], "vocabulary tags (synonyms mapped, unknown dropped) and the subject's tag");
  assert.deepEqual(r.subjects, [SUBJECT]);
  assert.deepEqual([r.output.writer, r.output.itemType, r.output.prefilter.label, r.output.fact.title], ["understand", ITEM_TYPE, "PASS", "事实 CLEAR"]);
  const score = requests.find((q) => q.marker === "CLEAR" && q.step === "score")!;
  // 【标题】 is buildScoreInput's own label (editorial/analyze.ts), not wording from the pack.
  assert.ok(score.user.includes(`【标题】\n${titleOf("CLEAR")}`), "the score reads the original title, before any writing");
  assert.deepEqual([score.body.temperature, score.body.reasoning_effort, score.body.max_tokens], [1, "high", 65536]);
  const understand = requests.find((q) => q.marker === "CLEAR" && q.step === "understand")!;
  // The request line is understandUser's own (editorial/writing.ts); the rule blocks it reads are the
  // pack's: every {{> file}} the understand prompt names is in the system prompt as that file renders.
  assert.ok(understand.user.startsWith("请按系统规则理解以下单篇材料，一次返回全部六个字段。"));
  const blocks = includesOf("understand");
  assert.ok(blocks.length >= 2, "the understand prompt inserts shared rule blocks");
  for (const block of blocks) assert.ok(understand.system.includes(promptText(block)), `understand carries the ${block} block`);
  const prefilter = requests.find((q) => q.marker === "CLEAR" && q.step === "prefilter")!;
  // 【材料质量】 is renderContext's own label (editorial/writing.ts), sent as a JSON string.
  assert.ok(JSON.parse(prefilter.user).includes("【材料质量】"), "the material context, sent as a JSON string");
});

test("a near-selected item is written like a selected one; below the floor it is translated", async () => {
  const near = await analyzeArticle(await article("RESCUE"));
  assert.deepEqual([near!.output!.selected, near!.output!.reasonZh], [false, "理由 RESCUE"], `${NEARLY.join(" + ")}: under twice the ${TIER} threshold, over twice the understanding floor`);
  const lowId = await article("LOW");
  const low = await analyzeArticle(lowId);
  assert.deepEqual([low!.output!.selected, low!.output!.titleZh, low!.output!.reasonZh], [false, "翻译标题 LOW", null]);
  assert.deepEqual(calls("LOW").sort(), ["prefilter", "score", "score", "structure", "summarize"]);
  const summarize = requests.find((q) => q.marker === "LOW" && q.step === "summarize")!;
  assert.equal(summarize.body.messages.length, 1, "the title/summary prompt is one user message");
  assert.equal(summarize.body.response_format, undefined, "answered in its own text format");
  assert.deepEqual((await row(lowId)).tags, [CATEGORY_TAG, STRUCTURE_TAG, SUBJECT_ENTITY.displayTag], "structure tags");
});

test("the prefilter's BLOCK stops everything; UNKNOWN goes on like PASS", async () => {
  const off = await analyzeArticle(await article("OFFTOPIC"));
  assert.deepEqual([off!.output!.relevance, off!.output!.selected], ["block", false]);
  assert.deepEqual(calls("OFFTOPIC"), ["prefilter"]);
  // An UNKNOWN with material is judged and written like a PASS, and can reach 精选 (JUST_OVER is over
  // twice the tier threshold).
  const vagueId = await article("VAGUE");
  const vague = await analyzeArticle(vagueId);
  assert.deepEqual([vague!.output!.relevance, vague!.output!.selected, vague!.output!.titleZh], ["pass", true, "理解标题 VAGUE"]);
  assert.equal((await row(vagueId)).output.prefilter.label, "UNKNOWN", "the prefilter's own answer stays on record");
  // Nothing but a title and no page to fetch: the BLOCK counts as UNKNOWN and is scored, but the
  // translation writes nothing from a bare title, so it waits for material instead of being published.
  const bare = await analyzeArticle(await article("BARE", { bodyText: null, excerpt: null, bodyStatus: "none" }));
  assert.deepEqual([bare!.output!.relevance, bare!.output!.selected, bare!.output!.score], ["unknown", false, meanOf(BARE_SCORES)]);
  assert.deepEqual(calls("BARE").sort(), ["prefilter", "score", "score", "structure"]);
});

test("a feed summary alone: the article page is fetched first, then the whole article is judged", async () => {
  const id = await article("THIN", { bodyText: null, bodyStatus: "pending", excerpt: `THIN: a short feed summary (${T}).` });
  // The queue sends it to extraction although its source does not ask for full text (the safety net
  // does the same after a failed fetch, so extraction failures add up to "unconfirmed" and end).
  await queueProcessing(id);
  const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id}`;
  assert.equal(job?.name, QUEUES.extractBody);
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.needsBody, first!.output], [true, null]);
  assert.deepEqual(calls("THIN"), [], "no model call before the page");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, "nothing committed");
  // What extraction does: the body lands as a new revision.
  await sql`UPDATE articles SET body_text = ${`THIN: ${LONG} (${T}) full page`}, body_status = 'ok', revision = revision + 1 WHERE id = ${id}`;
  const second = await analyzeArticle(id);
  assert.deepEqual([second!.needsBody ?? false, second!.output!.selected], [false, true]);
});

test("a short post in Chinese is its own copy; a content-filter refusal is translated instead", async () => {
  // The tag rides as a hashtag, which the language check strips. 推文 is the marker the stub answers for.
  const text = `推文：本周的巡检记录已经归档，值班表也更新好了。#t${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: X_SOURCE, url: `https://x.com/test/status/1${Date.now()}`, title: text, via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: `1${Date.now()}`, authorName: "测试", handle: "test", text },
  });
  const post = await analyzeArticle(articleId);
  assert.deepEqual([post!.output!.titleZh, post!.output!.summaryZh], [text, text]);
  assert.ok(!calls("推文").includes("summarize"), "no translation call");
  const sensitive = await analyzeArticle(await article("SENSITIVE"));
  assert.deepEqual([sensitive!.output!.selected, sensitive!.output!.titleZh], [true, "翻译标题 SENSITIVE"]);
  assert.deepEqual(calls("SENSITIVE").filter((s) => s === "understand" || s === "summarize"), ["understand", "summarize"]);
});

test("guards: a company the input does not name is not written in; long summaries are cut at sentences", () => {
  const input = { title: "某实验室发布新版本", text: "某实验室发布了一个新版本，参数规模和价格都有说明。", sourceKind: "rss" };
  const named = matchEntityIds([input.title, input.text]);
  // A subject the pack's identity lexicon does list (its own name matches it and nothing else does),
  // which this input never names: exactly what the guard is for.
  const invented = IDENTITY_LEXICON.find((e) => matchEntityIds([`${e.name} 发布新版本`]).join() === e.id && !named.includes(e.id)) ?? assert.fail("the identity lexicon lists no checkable subject");
  const guarded = enforceIdentity(input, { titleZh: `${invented.name} 发布新版本`, summaryZh: "某实验室发布新版本。" });
  assert.deepEqual([guarded.titleZh, guarded.summaryZh, guarded.identityGuard.outcome], [input.title, "某实验室发布新版本。", "fallback"]);
  assert.deepEqual(guarded.identityGuard.unsupportedTitleEntityIds, [invented.id], "the guard names the subject it could not support");
  assert.deepEqual(guarded.identityGuard.unsupportedSummaryEntityIds, [], "the summary invented nothing");
  // A subject the lexicon does not list at all cannot be a hallucination, whichever language the copy
  // writes it in: the input names it in Latin letters, the copy in Chinese.
  const unlisted = { title: "Loxfield Instruments 发布新版本", text: "Loxfield Instruments 的新版本参数规模和价格都有说明。", sourceKind: "rss" };
  assert.deepEqual(matchEntityIds([unlisted.title, unlisted.text]), [], "the pack's lexicon lists neither spelling");
  assert.equal(enforceIdentity(unlisted, { titleZh: "洛克斯菲尔德仪器发布新版本", summaryZh: "洛克斯菲尔德仪器发布了新版本并公布价格。" }).identityGuard.outcome, "pass");
  const long = "第一句交代了谁做了什么以及关键结果，这一句本身已经足够说明核心事件的来龙去脉。".repeat(3) + "第二句补充数字。".repeat(20);
  assert.ok(compactAnswerFirstSummary(long).length <= 190);
  assert.deepEqual(parseTranslateOutput("title_zh: 标题\nsummary_zh: 第一句。\n第二句。"), { titleZh: "标题", summaryZh: "第一句。\n第二句。", bodyZh: "" });
  assert.equal(parseTranslateOutput("title_zh: 标题\nbody_zh: 我们懂你。\n\n来源：X：Loxfield (@LoxfieldI)").bodyZh, "我们懂你。", "a repeated prompt line is dropped");
});

test("analysing the same revision again reuses every paid answer", async () => {
  scoreAnswers.CLEAR = scores(THRESHOLD + 20, THRESHOLD + 10);
  const id = await article("CLEAR", { url: `https://example.com/CLEAR-again-${T}`, title: `CLEAR launch note again ${T}` });
  const first = await analyzeArticle(id);
  assert.equal(first!.reused, false);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(provider.hits(), hits, "no new requests");
  assert.deepEqual([again!.reused, again!.receiptIds], [true, first!.receiptIds]);
});
