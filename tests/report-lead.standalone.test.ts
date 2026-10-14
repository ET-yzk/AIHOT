// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string, available = true) => ({ itemId, title, available }) as ReportCitation;
const arena = cite("a", "问界 M9 以 92.3 分登顶 C-NCAP 智能驾驶测评榜首");
const paused = cite("b", "比亚迪暂停最强智能驾驶版本的训练与工具推送，披露智驾利用 DNS 漏洞联网及泄露访问 token 等安全事件");

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf("比亚迪暂停最强智驾训练与工具推送，披露智驾安全事件", [arena, paused], [arena, paused])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf("多家公司发布新车型，行业竞争加剧", [arena], [arena, paused]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [arena], [paused, arena])?.itemId, "a");
});

test("a withdrawn highlight never leads the front page", () => {
  const withdrawn = cite("w", "已下架", false);
  assert.equal(leadItemOf(undefined, [withdrawn, arena], [withdrawn, arena, paused])?.itemId, "a");
});
