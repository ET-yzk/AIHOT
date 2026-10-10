-- 法规日程（S-C5「90 天内到期的实施日期」，FR-02-05 的日报倒计时）。
-- 只装人工整理过的日期：scripts/backfill-regulations.ts 从 RegPilot 那份追踪表灌进来，后台可改。
-- 模型抽出的日期不进这张表——日期精度守卫与条件必填的规格是阶段二 2.1 的黄金语料，语料没到手就没有守卫。
-- 阶段二 2.2 建 regulation_tracking 时这张表被它取代：同一个改动里删掉这里的代码、测试和这条表。
CREATE TABLE IF NOT EXISTS regulation_schedule (
  code text PRIMARY KEY,
  title text NOT NULL,
  effective_on date,
  comment_deadline date,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regulation_schedule_names_a_date CHECK (effective_on IS NOT NULL OR comment_deadline IS NOT NULL)
);
