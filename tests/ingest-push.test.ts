// The door an out-of-tree collector pushes through (1.4's browser-only sources, stage three's original
// texts). What it refuses and what it creates is the part that must not quietly rot: an unset or
// placeholder token has to reject everything, a source nobody registered becomes isolated and external
// rather than joining the collection schedule, one URL never becomes two articles, and a reported date
// that is stale or in the future is history, not today's news. Local inject and database only; nothing
// here reaches a network. Each case asks from its own address because the rate window is per client.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `test-ingest-${T}`;
const TOKEN = `ingest-token-${T}-0123456789`;
const app = await buildApp();

/** One push from a distinct client address; the reply's JSON body, or the plain text of a refusal. */
async function push(from: string, body: unknown, token: string | null = TOKEN): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/ingest/items",
    remoteAddress: from,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
  return { status: res.statusCode, json: res.body.startsWith("{") ? JSON.parse(res.body) : null, text: res.body };
}

const created = async (from: string, body: unknown) => (await push(from, body)).json?.created;
const item = (n: number, over: Record<string, unknown> = {}) => ({ title: `Notice ${n} ${T}`, url: `https://example.org/${T}/${n}`, publishedAt: new Date().toISOString(), ...over });
const url = (n: number) => `https://example.org/${T}/${n}`;
const sourceRow = async (id = SOURCE) =>
  (await sql<{ kind: string; participation_mode: string; tier: string; tags: string[]; name: string }[]>`
    SELECT kind, participation_mode, tier, tags, name FROM sources WHERE id = ${id}`)[0] ?? null;
const stored = async (u: string) =>
  sql<{ id: string; published_at: Date | null; published_at_claim: Date | null; timeline_at: Date; backfill: boolean; backfill_reason: string | null; revision: number }[]>`
    SELECT id, published_at, published_at_claim, timeline_at, backfill, backfill_reason, revision FROM articles WHERE url = ${u}`;

after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM ingest_events WHERE summary::text LIKE ${`%${T}%`}`;
  await sql`DELETE FROM sources WHERE id = ANY(${[SOURCE, `${SOURCE}-oversize`]}::text[])`;
  await stopBoss();
  await closeDb();
});

test("an unset, placeholder or too-short server token rejects every push and writes nothing", async () => {
  for (const configured of ["", "changeme", "test", "x".repeat(15)]) {
    if (configured) process.env.INGEST_TOKEN = configured;
    else delete process.env.INGEST_TOKEN;
    const res = await push("fd00::a1", { sourceId: SOURCE, items: [item(1)] });
    assert.equal(res.status, 401, `INGEST_TOKEN=${JSON.stringify(configured)} must not admit a push`);
    assert.equal(res.text, "Unauthorized");
    assert.equal(await sourceRow(), null, `${JSON.stringify(configured)} left a source behind`);
  }
  process.env.INGEST_TOKEN = "changeme";
  assert.equal((await push("fd00::a2", { sourceId: SOURCE, items: [item(1)] }, "some-other-token")).status, 401, "a guessed token against a placeholder secret was admitted");
  delete process.env.INGEST_TOKEN;
});

test("the first push creates its own source: external, isolated, never scheduled", async () => {
  process.env.INGEST_TOKEN = TOKEN;
  assert.deepEqual((await push("fd00::b1", { sourceId: SOURCE, sourceName: "推送信源", items: [item(2)] })).json, { ok: true, created: 1 });
  const row = await sourceRow();
  assert.ok(row, "the pushed source is registered");
  assert.equal(row!.kind, "external", "a pusher's source is not a kind the collector runs");
  assert.equal(row!.participation_mode, "isolated", "it waits for an operator instead of joining events");
  assert.equal(row!.tier, "T2", "an unknown channel is not trusted as official");
  assert.ok(row!.tags.includes("ingest:auto-created"), "it is marked as created by a push");
  assert.equal(row!.name, "推送信源");
  assert.equal((await stored(url(2))).length, 1, "the pushed item is stored");
});

test("the same URL reported twice stays one article and adds no creation", async () => {
  process.env.INGEST_TOKEN = TOKEN;
  assert.equal(await created("fd00::c1", { sourceId: SOURCE, items: [item(3, { url: url(3) }), item(3, { url: url(3), title: `Renoticed 3 ${T}` })] }), 1, "one batch counted a repeated URL twice");
  assert.equal(await created("fd00::c2", { sourceId: SOURCE, items: [item(3, { url: url(3) })] }), 0, "a second report of the same URL created something");
  const rows = await stored(url(3));
  assert.equal(rows.length, 1, "the repeat became a second article");
  assert.equal(rows[0]!.revision, 1, "an unchanged repeat became a new revision");
  assert.equal((await sql`SELECT 1 FROM article_discoveries WHERE article_id = ${rows[0]!.id} AND via = 'ingest'`).length, 1, "discovery history is per source, not per report");
});

test("a stale date is history and a future date is not believed, but the claim is kept", async () => {
  process.env.INGEST_TOKEN = TOKEN;
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await push("fd00::d1", { sourceId: SOURCE, items: [item(4, { publishedAt: old })] });
  const [oldRow] = await stored(url(4));
  assert.ok(oldRow, "the old item is stored");
  assert.equal(oldRow!.backfill, true, "an old report counted as today's news");
  assert.equal(oldRow!.backfill_reason, "stale-on-discovery");
  assert.equal(oldRow!.timeline_at.toISOString(), new Date(old).toISOString(), "stale material sorts by the date it was published, not by when it arrived");

  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await push("fd00::d2", { sourceId: SOURCE, items: [item(5, { publishedAt: future })] });
  const [futureRow] = await stored(url(5));
  assert.ok(futureRow, "the future-dated item is stored");
  assert.notEqual(futureRow!.published_at?.toISOString(), future, "a date beyond the tolerance was believed");
  assert.equal(futureRow!.published_at_claim?.toISOString(), new Date(future).toISOString(), "the source's own claim was discarded");

  // A pusher that says "this is backfill" is archived by the reported date, not by discovery time.
  await push("fd00::d3", { sourceId: SOURCE, items: [item(6, { publishedAt: old, raw: { _aihot: { backfill: true } } })] });
  const [backfillRow] = await stored(url(6));
  assert.equal(backfillRow!.backfill_reason, "reported-backfill");
  assert.equal(backfillRow!.timeline_at.toISOString(), new Date(old).toISOString(), "reported backfill sorts by its own date");
});

test("a batch over the limit or missing its source answers 413 / 400 before writing anything", async () => {
  process.env.INGEST_TOKEN = TOKEN;
  const tooMany = { sourceId: `${SOURCE}-oversize`, items: Array.from({ length: 51 }, (_, i) => item(7, { url: `${url(7)}-${i}` })) };
  assert.equal((await push("fd00::e1", tooMany)).status, 413);
  assert.equal(await sourceRow(`${SOURCE}-oversize`), null, "a refused batch registered a source");

  assert.equal((await push("fd00::e2", { sourceId: SOURCE, items: [] })).status, 400);
  assert.equal((await push("fd00::e3", { items: [item(8)] })).status, 400, "a push without a source id was accepted");

  // An item with no title or no url is dropped; the rest of the batch still lands.
  assert.deepEqual((await push("fd00::e4", { sourceId: SOURCE, items: [{ url: url(9) }, { title: `Titleless ${T}` }, item(10)] })).json, { ok: true, created: 1 });
});

test("ten requests in a minute fill the pusher's own window and the eleventh is refused", async () => {
  process.env.INGEST_TOKEN = TOKEN;
  const from = "fd00::f1";
  for (let i = 0; i < 10; i += 1) {
    const res = await push(from, { sourceId: SOURCE, items: [item(11, { url: url(11) })] });
    assert.equal(res.status, 200, `request ${i + 1} inside the window was refused`);
  }
  const over = await push(from, { sourceId: SOURCE, items: [item(12, { url: url(12) })] });
  assert.equal(over.status, 429, "an eleventh request in the same minute went through");
  assert.equal(over.json?.error, "rate limited");
});
