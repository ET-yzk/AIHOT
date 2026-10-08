// A content target that was switched on only later never receives what was published before it —
// and the rule is stricter than "delivered as skipped": the delivery is not written at all, so
// nothing about that content is ever retried, resent or counted in that slot (附录A 的 X-18).
// Also pinned here: one dedupe key never produces a second row for the same target, and only
// `purpose = 'content'` targets are read — `alert` and `feedback` stay unwired on purpose (see
// regdocs/阶段一验收记录.md §19; if that decision changes, the last case must change with it).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { deliverContent, type DeliveryRequest } from "@aihot/backend/notify/deliver";
import { tag } from "./setup.ts";

const T = tag();
const key = (name: string) => `t${T}-${name}`;

// The premise this file rests on. With the valve on, every case below would POST to a real
// webhook URL, so the whole file is only meaningful while content push is disabled.
assert.equal(config.feishuContentPushEnabled, false);

async function addTarget(name: string, purpose: string, enabledAt: Date | null) {
  await sql`
    INSERT INTO notify_targets (key, purpose, kind, enabled, enabled_at, config_ref)
    VALUES (${key(name)}, ${purpose}, 'feishu_webhook', true, ${enabledAt}, NULL)`;
}

async function rowsFor(name: string, dedupeKey?: string) {
  // A plain array, not the postgres.js Result: assert.deepEqual compares prototypes too.
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM deliveries WHERE target_key = ${key(name)}
      AND (${dedupeKey ?? null}::text IS NULL OR dedupe_key = ${dedupeKey ?? null})`;
  return rows.map((r) => r.status);
}

const HOUR = 3_600_000;
const request = (id: string, contentAt: Date): DeliveryRequest => ({
  subjectKind: "selected",
  subjectId: `s${T}-${id}`,
  dedupeKey: `k${T}-${id}`,
  contentAt,
  card: { text: `卡片 ${T} ${id}` },
});

after(async () => {
  await sql`DELETE FROM deliveries WHERE target_key LIKE ${`t${T}-%`}`;
  await sql`DELETE FROM notify_targets WHERE key LIKE ${`t${T}-%`}`;
  await closeDb();
});

test("内容早于目标的启用时间：一行都不写，连 skipped 都没有", async () => {
  const openedAt = new Date();
  await addTarget("opened-late", "content", openedAt);
  await addTarget("never-locked", "content", null);

  const out = await deliverContent(request("backfill", new Date(openedAt.getTime() - HOUR)));

  assert.deepEqual(await rowsFor("opened-late"), []);
  assert.deepEqual(await rowsFor("never-locked"), ["skipped"]);
  assert.deepEqual(out.map((r) => r.target), [key("never-locked")]);
});

test("内容晚于目标的启用时间：照常投递", async () => {
  await addTarget("opened-early", "content", new Date(Date.now() - HOUR));
  await deliverContent(request("fresh", new Date()));
  assert.equal((await rowsFor("opened-early")).length, 1);
});

test("同一个 dedupe key 在一个目标上不会写出第二行", async () => {
  await addTarget("dedupe", "content", null);
  const req = request("dedupe", new Date());
  const first = await deliverContent(req);
  const second = await deliverContent(req);

  assert.equal((await rowsFor("dedupe", req.dedupeKey)).length, 1);
  assert.ok(first.some((r) => r.target === key("dedupe")));
  assert.deepEqual(second.filter((r) => r.target === key("dedupe")), []);
});

test("只有 purpose='content' 的目标会被读：alert 与 feedback 一行都不写", async () => {
  await addTarget("alert-slot", "alert", null);
  await addTarget("feedback-slot", "feedback", null);
  await deliverContent(request("purposes", new Date()));

  assert.deepEqual(await rowsFor("alert-slot"), []);
  assert.deepEqual(await rowsFor("feedback-slot"), []);
});
