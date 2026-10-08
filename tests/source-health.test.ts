// What the ops baseline (1.6) reads as 「每个信源有健康度」: a source that cannot be fetched is marked
// and backed off, only a run of failures calls it failing, the backoff is capped, and an answering
// source is clean again. A spent budget is neither: it leaves the count and the health alone and asks
// again in a quarter of an hour. The feed and the paid listing are both local stubs; nothing here
// leaves the machine.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `test-source-health-${T}`;
const PAID = `test-source-health-paid-${T}`;
const INTERVAL_MINUTES = 30;
const FAILING_AFTER = 5;

let paidHits = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/good.xml") {
    const entry = `<item><title>法规征求意见稿 ${T}</title><link>https://example.org/${T}-1</link><pubDate>${new Date().toUTCString()}</pubDate><description>正文</description></item>`;
    res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${entry}</channel></rss>`);
  }
  // An anti-crawl refusal: the page is there, a request that identifies itself properly would get it.
  // 附录A's X-09 says a liveness probe must not call this a dead link; the last case here pins what the
  // collector does with it today, which is the opposite.
  if (req.url === "/blocked.xml") {
    res.writeHead(403, { "content-type": "text/html" });
    return res.end("<html>Access denied</html>");
  }
  // JINA_BASE_URL points here too, so a listing read through Jina is a request to this stub: counting
  // them shows a budget-blocked fetch never reached the paid service.
  if (req.url?.includes("jlist")) paidHits += 1;
  res.writeHead(500, { "content-type": "text/plain" });
  res.end("unavailable");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
process.env.JINA_API_KEY = "test-key";
process.env.JINA_BASE_URL = base;

type Row = { health: string; fail_count: number; last_error: string | null; last_ok_at: Date | null; cursor: Record<string, unknown> };
const row = (id = SOURCE) => sql<Row[]>`SELECT health, fail_count, last_error, last_ok_at, cursor FROM sources WHERE id = ${id}`.then((r) => r[0]);
const minutesToRetry = (id = SOURCE) =>
  sql<{ m: number }[]>`SELECT (EXTRACT(EPOCH FROM (next_fetch_at - now())) / 60)::float8 AS m FROM sources WHERE id = ${id}`.then((r) => r[0].m);
const pointAt = (path: string) => sql`UPDATE sources SET config = ${sql.json({ feedUrl: `${base}${path}` })} WHERE id = ${SOURCE}`;
const lastRun = (id = SOURCE) =>
  sql<{ status: string; error: string | null }[]>`SELECT status, error FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`.then((r) => r[0]);

let savedJina: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  savedJina = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'jina'`;
  assert.equal(savedJina.length, 1, "the migrations seed a budget for the paid listing service");
  // Wide open, so a fetch here is refused only when this file says so: the shipped cap (five listings a
  // minute) would otherwise block these attempts on its own and the test would prove nothing.
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'jina'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, cursor, next_fetch_at)
            VALUES (${SOURCE}, 'Test health feed', 'rss', ${sql.json({ feedUrl: `${base}/down.xml` })}, 'T1', 'editorial',
                    ${INTERVAL_MINUTES}, ${sql.json({ initializedAt: new Date().toISOString(), marker: T })}, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, cursor, next_fetch_at)
            VALUES (${PAID}, 'Test paid listing', 'web_list',
                    ${sql.json({ url: `https://r.jina.ai/https://example.org/jlist-${T}`, parseMode: "markdown", allowUrlPrefixes: ["https://example.org/"] })},
                    'T1', 'editorial', ${INTERVAL_MINUTES}, ${sql.json({ initializedAt: new Date().toISOString(), marker: T })}, '2100-01-01')`;
});

after(async () => {
  const jina = savedJina[0];
  if (jina) await sql`UPDATE budgets SET per_minute = ${jina.per_minute}, per_hour = ${jina.per_hour}, per_day = ${jina.per_day} WHERE service = 'jina'`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of [SOURCE, PAID]) {
    await sql`DELETE FROM fetch_runs WHERE source_id = ${id}`;
    await sql`DELETE FROM articles WHERE source_id = ${id}`;
    await sql`DELETE FROM sources WHERE id = ${id}`;
  }
  await stopBoss();
  await closeDb();
});

test("the first failure marks the source degraded, keeps the reason, and does not move the cursor", async () => {
  assert.equal((await collectSource(SOURCE, { force: true })).status, "failed");
  const got = await row();
  assert.equal(got.health, "degraded");
  assert.equal(got.fail_count, 1);
  assert.match(got.last_error ?? "", /500|unavailable|fetch/, "the failure reason is kept for the operator");
  assert.equal(got.last_ok_at, null);
  assert.deepEqual(got.cursor, { initializedAt: got.cursor.initializedAt, marker: T }, "a failed fetch advances nothing");
  const run = await lastRun();
  assert.equal(run.status, "failed");
  assert.ok(run.error, "the run record carries the error too");
  // One failed fetch pushes the next attempt out by two intervals (the count used is the one before
  // this failure), so a source that trips once is not hammered.
  const gap = await minutesToRetry();
  assert.ok(gap > 55 && gap < 65, `the retry gap was ${gap} minutes`);
});

test("only a run of failures calls a source failing", async () => {
  for (let n = 0; n < FAILING_AFTER - 2; n++) await collectSource(SOURCE, { force: true });
  assert.equal((await row()).health, "degraded", `${FAILING_AFTER - 1} failures are still one short`);
  await collectSource(SOURCE, { force: true });
  const got = await row();
  assert.equal(got.health, "failing");
  assert.equal(got.fail_count, FAILING_AFTER);
  const gap = await minutesToRetry();
  assert.ok(gap > 145 && gap < 185, `the wait grows with each failure, it was ${gap} minutes on the ${FAILING_AFTER}th`);
});

test("the backoff is capped, so a source that comes back is not scheduled a day out", async () => {
  await sql`UPDATE sources SET fail_count = 400 WHERE id = ${SOURCE}`;
  await collectSource(SOURCE, { force: true });
  const gap = await minutesToRetry();
  assert.ok(gap > 355 && gap <= 361, `the retry gap was ${gap} minutes, above the six-hour cap`);
});

test("a source that answers again is healthy, with its failure trail cleared", async () => {
  await pointAt("/good.xml");
  assert.equal((await collectSource(SOURCE, { force: true })).status, "ok");
  const got = await row();
  assert.equal(got.health, "ok");
  assert.equal(got.fail_count, 0);
  assert.equal(got.last_error, null);
  assert.ok(got.last_ok_at, "the last good fetch is recorded");
  assert.ok(got.cursor.marker === T && got.cursor.lastOkAt, "the cursor keeps what it had and gains the success watermark");
  const gap = await minutesToRetry();
  assert.ok(gap > INTERVAL_MINUTES - 5 && gap <= INTERVAL_MINUTES + 1, `a healthy source waits its own interval, was ${gap} min`);
});

test("a spent budget leaves the health alone and asks again in a quarter of an hour", async () => {
  // A listing read through Jina is a paid fetch, and a paid fetch is the only one that can be refused
  // for reasons that are not the source's. Four genuine failures first, so the source sits one short
  // of failing and the next real failure would tip it.
  for (let n = 0; n < FAILING_AFTER - 1; n++) {
    assert.equal((await collectSource(PAID, { force: true })).status, "failed");
  }
  const before = await row(PAID);
  assert.equal(before!.health, "degraded");
  assert.equal(before!.fail_count, FAILING_AFTER - 1);
  assert.ok(paidHits >= FAILING_AFTER - 1, `the four failures were four real fetches, saw ${paidHits}`);

  // A zero anywhere in the budget stops the service before a request is made or a cent is spent.
  await sql`UPDATE budgets SET per_day = 0 WHERE service = 'jina'`;
  const hits = paidHits;
  assert.equal((await collectSource(PAID, { force: true })).status, "failed");
  assert.equal(paidHits, hits, "the budget gate sits in front of the paid service: nothing was fetched");

  const got = await row(PAID);
  assert.equal(got!.fail_count, FAILING_AFTER - 1, "a full budget is not the source's failure");
  assert.equal(got!.health, "degraded", "one short of failing still, because the count did not move");
  assert.match(got!.last_error ?? "", /budget for jina/i, "the reason is recorded for the operator all the same");
  const run = await lastRun(PAID);
  assert.equal(run!.status, "failed");
  assert.match(run!.error ?? "", /budget/i, "and in the fetch log");
  const waited = await minutesToRetry(PAID);
  assert.ok(waited > 14 && waited < 16, `a budget-blocked source waits fifteen minutes, not its backoff, was ${waited} min`);

  // Skipping the count is not a free pass: once the budget opens again, the source's own failure tips it.
  await sql`UPDATE budgets SET per_day = 100000 WHERE service = 'jina'`;
  assert.equal((await collectSource(PAID, { force: true })).status, "failed");
  const tipped = await row(PAID);
  assert.equal(tipped!.fail_count, FAILING_AFTER);
  assert.equal(tipped!.health, "failing");
});

test("an anti-crawl refusal retires a source exactly like a dead host does, as things stand", async () => {
  // The premise, so the count below is this case's own doing: the recovery test left this source answering.
  const start = await row();
  assert.equal(start!.health, "ok");
  assert.equal(start!.fail_count, 0);

  await pointAt("/blocked.xml");
  assert.equal((await collectSource(SOURCE, { force: true })).status, "failed", "a refusal is a failed fetch");
  const refused = await row();
  assert.equal(refused!.health, "degraded");
  assert.equal(refused!.fail_count, 1, "one refusal counts as one failure");
  assert.match(refused!.last_error ?? "", /403/, "the status is at least kept for the operator to read");

  // Five refusals and the source is retired on the same schedule as a host that stopped answering. What this
  // pins is 现状而不是应当如此: 附录A's X-09 asks that 403/429 mean "the link may still be valid" rather than
  // "dead", `FetchError` carries a `status` (sources/types.ts) that no code reads, and the paid providers
  // reach the opposite conclusion (a 403 there is marked non-retryable). If X-09 is adopted for collection,
  // this case has to be rewritten deliberately — it will not fade out on its own.
  for (let n = 1; n < FAILING_AFTER; n++) await collectSource(SOURCE, { force: true });
  const retired = await row();
  assert.equal(retired!.fail_count, FAILING_AFTER);
  assert.equal(retired!.health, "failing");
  assert.match((await lastRun()).error ?? "", /403/, "and the refusal is what the fetch log says");

  // A refusal is not a broken source: given a feed that answers, the same source is healthy again at once.
  await pointAt("/good.xml");
  assert.equal((await collectSource(SOURCE, { force: true })).status, "ok");
  assert.equal((await row())!.health, "ok");
});
