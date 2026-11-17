// The mapping from Feishu's value shapes and the whole-table replace, on records that look exactly
// like the ones the API returns (rich-text arrays, a link object, millisecond dates, a person array).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { importSnapshot, mapRecord, mapRecords, readWatermark, slugFor } from "../sync.ts";

const T = "st-test";

function record(id: string, fields: Record<string, unknown>) {
  return { record_id: id, fields };
}

const richText = (text: string) => [{ text, type: "text" }];

function fixture(): Array<{ record_id: string; fields: Record<string, unknown> }> {
  return [
    record(`${T}-a`, {
      法规编号: richText("GB/T 41797-2022"),
      法规全称: richText("驾驶员注意力监测系统性能要求及试验方法"),
      地区: "中国",
      生命周期阶段: "正式发布",
      业务分类: ["DMS", "ADAS"],
      产品功能: ["疲劳检测"],
      法规认证类型: "推荐",
      发布机构: richText("全国汽标委"),
      适用国家: ["中国"],
      适用车型: richText("乘用车"),
      发布日期: 1644508800000,
      实施日期: 1682899200000,
      修订日期: null,
      征求意见截止日期: null,
      报批稿截止日期: null,
      原文链接: [{ link: "https://example.test/a", text: "官方原文", type: "url" }],
      原文入库: "已入库",
      原文获取方式: "网页在线阅读",
      印证状态: "已印证",
      印证策略: richText("T1 + 行业转载"),
      信源T1-官方: richText("中汽中心"),
      信源T2-行业: null,
      信源T3-资讯: null,
      订阅状态: "高频监控",
      解读状态: "未认领",
      认领人: [],
      核心摘要: richText("摘要文本"),
      影响评估: richText("影响文本"),
      上次检查日期: 1763337600000,
      创建时间: 1763337600000,
      更新时间: 1763424000000,
    }),
    record(`${T}-b`, {
      法规编号: null,
      法规全称: richText("没有编号的规程"),
      地区: "欧盟",
      生命周期阶段: "征求意见稿",
      业务分类: ["功能安全"],
      产品功能: [],
      原文链接: richText("[标题](https://example.test/b)"),
    }),
  ];
}

after(async () => {
  await sql`DELETE FROM source_table_rows WHERE record_id LIKE ${T + "%"}`;
  await closeDb();
});

test("maps Feishu's shapes onto the columns the pages read", () => {
  const [row] = mapRecords(fixture());
  assert.equal(row!.code, "GB/T 41797-2022");
  assert.equal(row!.slug, "gb-t-41797-2022");
  assert.equal(row!.title, "驾驶员注意力监测系统性能要求及试验方法");
  assert.deepEqual(row!.businessCategories, ["DMS", "ADAS"]);
  assert.equal(row!.publishedOn, "2022-02-11");
  assert.equal(row!.effectiveOn, "2023-05-01");
  assert.equal(row!.revisedOn, null);
  assert.equal(row!.originUrl, "https://example.test/a");
  assert.equal(row!.summary, "摘要文本");
  assert.equal(row!.sourceT2, null);
  assert.equal(row!.checkedOn, "2025-11-17");
});

test("a record without a code falls back to the record id, and a Markdown link is still read", () => {
  const [, row] = mapRecords(fixture());
  assert.equal(row!.slug, `reg-${T}-b`);
  assert.equal(row!.originUrl, "https://example.test/b");
});

test("two records with the same code get distinct slugs", () => {
  const taken = new Set<string>();
  const first = slugFor(`${T}-x`, "GB 44495-2024", taken);
  taken.add(first);
  const second = slugFor(`${T}-y`, "GB 44495-2024", taken);
  assert.equal(first, "gb-44495-2024");
  assert.equal(second, "gb-44495-2024-2");
  assert.notEqual(mapRecord(record(`${T}-x`, {}), new Set()).slug, slugFor(`${T}-x`, null));
});

test("importing the same snapshot twice leaves the same rows and reports the diff", async () => {
  const first = await importSnapshot(fixture());
  assert.equal(first.status, "ok");
  assert.equal(first.rows, 2);
  const second = await importSnapshot(fixture());
  assert.equal(second.rows, 2);
  assert.equal(second.created, 0);
  assert.equal(second.removed, 0);
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_table_rows`;
  assert.equal(count!.n, 2);
  const watermark = await readWatermark();
  assert.equal(watermark.status, "ok");
  assert.equal(watermark.runs.length, 2);
  assert.equal(watermark.runs[0]!.ok, true);
});

test("an empty snapshot is refused and leaves the rows alone", async () => {
  await assert.rejects(() => importSnapshot([]), /空/);
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_table_rows`;
  assert.equal(count!.n, 2);
});

test("only the last five runs are kept", async () => {
  for (let i = 0; i < 5; i++) await importSnapshot(fixture());
  const watermark = await readWatermark();
  assert.equal(watermark.runs.length, 5);
});
