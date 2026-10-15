-- 人工金标（docs/selection.md 的「校准」第 1 步）：一条资料一行，后台 /admin/gold 录入，
-- scripts/eval-selection.ts 把它导出成 GoldRow 再跑付费的新鲜评测。
-- 存着录入那一刻的门槛与模型打分（threshold / model_score / model_selected / prompt_version）：
-- 门槛和提示词都会改，报告要能说出「这条是在 55 的门槛、这版评分提示词下标的」，而不是拿今天的数字解释昨天的标。
-- 有 updated_at / updated_by / version：这张表每条都由后台人工写，architecture.test.ts 会问是谁写的。
CREATE TABLE IF NOT EXISTS gold_labels (
  case_id text PRIMARY KEY,
  decision text NOT NULL CHECK (decision IN ('select', 'reject', 'either')),
  note text,
  split text NOT NULL DEFAULT 'development' CHECK (split IN ('development', 'holdout')),
  source_tier text,
  threshold integer,
  model_score integer,
  model_selected boolean,
  prompt_version text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
