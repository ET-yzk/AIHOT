// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string) => ({ itemId, title, available: true }) as ReportCitation;
// Two items and three leads of its own: the match is on the characters the lead shares with a title.
const launch = cite("a", "洛菲尔德工坊发布 W9 平台，公布续航与售价的对比表");
const pause = cite("b", "洛菲尔德工坊暂停 W9 平台的交付，披露电池供应与产线改造的安排");
const ABOUT_PAUSE = "洛菲尔德工坊暂停 W9 平台的交付，披露电池供应安排";
const ABOUT_NOTHING = "几家机构的新预测上线，业内竞争加剧";

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf(ABOUT_PAUSE, [launch, pause], [launch, pause])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf(ABOUT_NOTHING, [launch], [launch, pause]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [launch], [pause, launch])?.itemId, "a");
});
