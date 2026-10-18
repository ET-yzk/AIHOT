// Failure cases: two workers finish the same extraction; a report revises the article while a page
// or X Article is in flight; an obsolete empty response marks new input unconfirmed; an admin
// repeats extraction of unchanged HTML. Neither content nor revision history may go backwards.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { budgetMessage } from "@aihot/backend/providers/receipts";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { queueProcessing, registerExtractionJobs } from "@aihot/backend/jobs/content";

const sourceId = `extract-consistency-${tag()}`;
const body = "This is the original article, with enough substantive text to extract its paragraphs. ".repeat(12);
/** What the Jina stub renders. Short by default: a page with no readable body keeps having no body. */
let jinaBody = "Too short to extract.";
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>>; count: number; empty: boolean; failed?: boolean };
const page = http.createServer(async (_req, res) => {
  if (--hold.count === 0) hold.entered.open();
  await hold.release.promise;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(hold.empty ? "<html><body>Empty</body></html>" : `<html><head><title>Original</title></head><body><article><h1>Original</h1><p>${body}</p></article></body></html>`);
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const socialdata = await stub(async () => {
  hold.entered.open();
  await hold.release.promise;
  if (hold.failed) return new Reply(503, { error: "Temporary extraction failure" });
  return hold.empty ? {} : { article: { title: "Old X Article", content_state: { blocks: [{ text: body }] } } };
});
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.JINA_API_KEY = "test-key";
// Jina answers here instead of being switched off by its budget: a page whose own body is missing is
// then judged on what Jina returns (short markdown keeps it missing), and a spent window stays
// testable as itself — see the last two cases, which need the refusal to reach the worker.
const jina = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/plain");
  res.end(`Title: Article\nURL Source: page\nMarkdown Content:\n${jinaBody}`);
});
await new Promise<void>(resolve => jina.listen(0, "127.0.0.1", resolve));
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Extraction consistency','rss')`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='socialdata'`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`;
});
after(async () => {
  // budgets rows are shared state: leave jina on the caps a fresh deploy ships with.
  await sql`UPDATE budgets SET per_minute=5,per_hour=50,per_day=300 WHERE service='jina'`;
  page.close(); await new Promise<void>(resolve => jina.close(() => resolve())); await socialdata.close(); await stopBoss(); await closeDb();
});
const reset = (count = 1, empty = false) => { hold = { entered: gate(), release: gate(), count, empty }; };
const state = async (id: string) => ({ ...(await sql`SELECT title,body_text,body_status,revision,content_hash FROM articles WHERE id=${id}`)[0] });

for (const x of [false, true]) for (const empty of [false, true]) {
  test(`a stale ${x ? "X Article" : "page"} ${empty ? "empty" : "successful"} response cannot change newer material`, async () => {
    reset(1, empty);
    const tweetId = `${Date.now()}${empty ? 2 : 1}`;
    const material = { sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" as const,
      ...(x ? { xPost: { tweetId, authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } } : {}) };
    const { articleId } = await upsertMaterial(material);
    const pending = extractArticleBody(articleId);
    await hold.entered.promise;
    let expected;
    try {
      await upsertMaterial({ ...material, title: "Corrected report", ...(empty ? {} : { bodyText: "The corrected body supplied by the publisher." }) });
      expected = await state(articleId);
    } finally { hold.release.open(); }
    const result = await pending;
    assert.deepEqual(await state(articleId), expected, "old network results must not touch the new revision or its pending status");
    assert.equal(result, "skipped");
  });
}

test("overlapping page extractions and an unchanged admin retry create only one body revision", async () => {
  reset(2);
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" });
  const pending = [extractArticleBody(articleId), extractArticleBody(articleId)];
  await hold.entered.promise;
  hold.release.open();
  await Promise.all(pending);
  const saved = await state(articleId);
  assert.equal(saved.revision, 2, "concurrent workers must not revise identical content twice");
  reset();
  hold.release.open();
  await sql`UPDATE articles SET body_status='pending' WHERE id=${articleId}`;
  assert.equal(await extractArticleBody(articleId), "ok");
  assert.deepEqual(await state(articleId), saved);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 2);
});

// The worker's error path is also a write: a late provider error must not add retry state to a
// newer, complete report. Exercise pg-boss's actual callback rather than only the extractor.
test("an obsolete extraction failure cannot penalize a newer complete report", async () => {
  reset();
  hold.failed = true;
  const source = `${sourceId}-worker`;
  await sql`INSERT INTO sources(id,name,kind) VALUES (${source},'Extraction worker','x_search')`;
  const material = { sourceId: source, url: `https://x.com/author/status/${Date.now()}`, title: "Original", via: "fetch" as const,
    xPost: { tweetId: `${Date.now()}9`, authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } };
  const { articleId } = await upsertMaterial(material);
  const job = await queueProcessing(articleId);
  await registerExtractionJobs(await getBoss());
  await hold.entered.promise;
  try { await upsertMaterial({ ...material, title: "Corrected", bodyText: "Complete corrected body" }); }
  finally { hold.release.open(); }
  const deadline = Date.now() + 12_000;
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${job!}`)[0]?.state !== "completed") {
    assert.ok(Date.now() < deadline, "extraction worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const [row] = await sql`SELECT body_status,processing_attempts,processing_error,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { body_status: "ok", processing_attempts: 0, processing_error: null, processing_retry_at: null });
});

// A spent budget window is the provider's schedule, not a verdict about the page: the article must
// stay pending, keep its attempts, and get another turn once the window refills. Measured on the
// 2026-10-14 C-NCAP first import, where 15 articles were marked unconfirmed with no receipt at all
// because the refusal was swallowed and turned into a content judgement.
let strandedId: string;

test("a spent Jina window leaves the body pending and requeues without spending an attempt", async () => {
  reset(1, true);
  hold.release.open();
  const created = await upsertMaterial({ sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" });
  strandedId = created.articleId;
  // A window that is genuinely spent: the cap is one call and one live attempt has already gone out this
  // minute. Zeroing the caps instead reads as "stopped" — an operator switched the provider off — which is
  // a different refusal with a different retry window (receipts.ts:110), so the case would never see a minute.
  const spent = `spent-jina-${tag()}`;
  const [receipt] = await sql<{ id: string }[]>`
    INSERT INTO receipts (logical_key, service, purpose, status) VALUES (${spent}, 'jina', 'test', 'completed') RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, origin, status)
            VALUES (${receipt!.id}, 1, 'jina', 'live', 'received')`;
  await sql`UPDATE budgets SET per_minute=1,per_hour=1000,per_day=1000 WHERE service='jina'`;
  let job: string | null | undefined;
  try {
    job = await queueProcessing(strandedId);
    assert.ok(job, "the extraction job was queued");
    const deadline = Date.now() + 20_000;
    while ((await sql`SELECT state FROM pgboss.job WHERE id=${job}`)[0]?.state !== "completed") {
      assert.ok(Date.now() < deadline, "the extraction worker did not finish");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`;
    await sql`DELETE FROM receipts WHERE logical_key = ${spent}`; // its attempt goes with it
  }
  const [saved] = await sql<{ body_status: string; processing_state: string; processing_attempts: number; processing_error: string | null; processing_retry_at: Date | null }[]>`
    SELECT body_status, processing_state, processing_attempts, processing_error, processing_retry_at FROM articles WHERE id=${strandedId}`;
  assert.equal(saved!.body_status, "pending", "a refused read cannot become the article's body verdict");
  assert.equal(saved!.processing_state, "new", "it stays queued for the retry the sweep will re-enqueue");
  assert.equal(saved!.processing_attempts, 0, "the window is not the article's failure, so it costs no attempt");
  assert.equal(saved!.processing_error, `extract: ${budgetMessage("jina", "minute")}`, "the refusal is recorded as the reason, not hidden");
  assert.ok(saved!.processing_retry_at instanceof Date && saved!.processing_retry_at.getTime() <= Date.now() + 60_000
    && saved!.processing_retry_at.getTime() >= Date.now() - 60_000, `retry is scheduled on the provider's own window: ${String(saved!.processing_retry_at)}`);
});

test("the same article gets its body once the window is free, so the refusal was never terminal", async () => {
  assert.ok(strandedId, "the previous case left an article waiting for a retry");
  jinaBody = body;
  assert.equal(await extractArticleBody(strandedId), "ok");
  const [saved] = await sql<{ body_status: string; n: number }[]>`SELECT body_status, length(coalesce(body_text,'')) AS n FROM articles WHERE id=${strandedId}`;
  assert.equal(saved!.body_status, "ok");
  assert.ok(saved!.n > 200, `the retried read supplies the real body, not the placeholder: ${saved!.n} chars`);
});
