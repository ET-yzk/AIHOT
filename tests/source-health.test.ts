// What the ops baseline (1.6) reads as 「每个信源有健康度」: a source that cannot be fetched is marked
// and backed off, only a run of failures calls it failing, the backoff is capped, and an answering
// source is clean again. The feed is a local stub; nothing here leaves the machine. The branch that
// leaves health alone when a *budget* is spent is only reachable through a paid collector (X, WeChat),
// so it is not covered here — see tests/receipts.test.ts for the budget itself.
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
const INTERVAL_MINUTES = 30;
const FAILING_AFTER = 5;

const server = http.createServer((req, res) => {
  if (req.url === "/good.xml") {
    const entry = `<item><title>法规征求意见稿 ${T}</title><link>https://example.org/${T}-1</link><pubDate>${new Date().toUTCString()}</pubDate><description>正文</description></item>`;
    res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${entry}</channel></rss>`);
  }
  res.writeHead(500, { "content-type": "text/plain" });
  res.end("unavailable");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

type Row = { health: string; fail_count: number; last_error: string | null; last_ok_at: Date | null; cursor: Record<string, unknown> };
const row = async () => (await sql<Row[]>`SELECT health, fail_count, last_error, last_ok_at, cursor FROM sources WHERE id = ${SOURCE}`)[0];
const minutesToRetry = async () =>
  (await sql<{ m: number }[]>`SELECT (EXTRACT(EPOCH FROM (next_fetch_at - now())) / 60)::float8 AS m FROM sources WHERE id = ${SOURCE}`)[0].m;
const pointAt = (path: string) => sql`UPDATE sources SET config = ${sql.json({ feedUrl: `${base}${path}` })} WHERE id = ${SOURCE}`;
const lastRun = async () =>
  (await sql<{ status: string; error: string | null }[]>`SELECT status, error FROM fetch_runs WHERE source_id = ${SOURCE} ORDER BY id DESC LIMIT 1`)[0];

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, cursor, next_fetch_at)
            VALUES (${SOURCE}, 'Test health feed', 'rss', ${sql.json({ feedUrl: `${base}/down.xml` })}, 'T1', 'editorial',
                    ${INTERVAL_MINUTES}, ${sql.json({ initializedAt: new Date().toISOString(), marker: T })}, '2100-01-01')`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql`DELETE FROM fetch_runs WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
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
