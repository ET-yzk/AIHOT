// A fill-in sheet for the selection gold set (docs/selection.md 的“校准”第 1 步): reads the database, calls no
// model, and writes GoldRow lines scripts/eval-selection.ts takes directly. Articles are sampled around each
// source tier's threshold, because those are the cases a threshold move actually changes; the rows far from it
// stay few, so the metrics keep meaning. Each row keeps the model's own verdict in `modelHint` — fill in
// `gold.decision` from the title and body first, then compare.
// Usage: node --env-file=.env scripts/gold-samples.ts [--n 120] [--out .data/gold.draft.jsonl] [--days 90] [--seed 7] [--no-hint] [--fill]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { SELECTION_PROMPT_VERSION, tierThreshold } from "@aihot/backend/editorial/analyze";
import { positiveInt } from "./eval-tools.ts";

const { values } = parseArgs({
  options: {
    n: { type: "string", default: "120" },
    out: { type: "string", default: ".data/gold.draft.jsonl" },
    days: { type: "string" },
    seed: { type: "string", default: "7" },
    "no-hint": { type: "boolean", default: false },
    fill: { type: "boolean", default: false },
  },
});

interface Row {
  id: string;
  title: string;
  url: string;
  published_at: Date | null;
  language: string | null;
  body_text: string | null;
  excerpt: string | null;
  x_post: unknown;
  source_name: string;
  kind: string;
  tier: string;
  first_party: boolean;
  relevance: string | null;
  score: number | null;
  selected: boolean | null;
  category: string | null;
  model: string | null;
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
}

/** Where an item sits against its tier's threshold, plus the two kinds that never got a score. */
type Band = "near-below" | "near-above" | "far-above" | "far-below" | "block" | "unscored";

// Near the threshold first: the sweep in the report is read on these.
const SHARE: Record<Band, number> = { "near-below": 30, "near-above": 26, "far-above": 14, "far-below": 12, block: 10, unscored: 8 };
const BANDS = Object.keys(SHARE) as Band[];

const days = values.days === undefined ? null : positiveInt(values.days, "days");
const rows = await sql<Row[]>`
  SELECT a.id, a.title, a.url, a.published_at, a.language, a.body_text, a.excerpt, a.x_post,
         s.name AS source_name, s.kind, s.tier, s.first_party,
         an.relevance, an.score, an.selected, an.category, an.model, an.title_zh, an.summary_zh, an.reason_zh
  FROM articles a
  JOIN sources s ON s.id = a.source_id
  LEFT JOIN LATERAL (
    SELECT n.relevance, n.score, n.selected, n.category, n.model, n.title_zh, n.summary_zh, n.reason_zh
    FROM analyses n WHERE n.article_id = a.id ORDER BY n.id DESC LIMIT 1
  ) an ON TRUE
  WHERE s.tier <> 'EXCLUDE_MP'
    -- eval-selection.ts scores the body and falls back to the title; with neither there is nothing to judge.
    AND (a.body_text IS NOT NULL OR a.excerpt IS NOT NULL OR a.x_post IS NOT NULL)
    ${days ? sql`AND a.discovered_at >= now() - make_interval(days => ${days}::int)` : sql``}`;

function bandOf(row: Row): Band {
  if (row.relevance === "block") return "block";
  const threshold = tierThreshold(row.tier);
  if (row.score === null || threshold === null) return "unscored";
  const gap = row.score - threshold;
  if (gap < -12) return "far-below";
  if (gap < 0) return "near-below";
  return gap < 8 ? "near-above" : "far-above";
}

// Distance to the threshold, for reading order inside a band.
const gapOf = (row: Row) => {
  const threshold = tierThreshold(row.tier);
  return row.score === null || threshold === null ? 0 : Math.abs(row.score - threshold);
};

// Deterministic draw, the same shape eval-selection.ts uses to sample the gold file.
let state = Number(values.seed) >>> 0;
const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const keyed = <T,>(items: T[]) => items.map((item) => ({ item, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.item);

const pools = new Map<Band, Row[]>(BANDS.map((band) => [band, keyed(rows.filter((row) => bandOf(row) === band))]));
const target = positiveInt(values.n, "n");
const picked: Row[] = [];
const take = (band: Band, max: number) => pools.get(band)!.splice(0, max);
const room = () => target - picked.length;
for (const band of BANDS) picked.push(...take(band, Math.min(Math.round((target * SHARE[band]) / 100), room())));
// A band with fewer articles than its share cannot be filled. Its rooms go to the other hard cases, and only
// with --fill to the far-from-threshold ones: those are judged at a glance and would lift every accuracy number.
const HARD: Band[] = ["near-above", "near-below", "block", "unscored"];
const EASY: Band[] = ["far-above", "far-below"];
for (const band of HARD) picked.push(...take(band, room()));
if (values.fill) for (const band of EASY) picked.push(...take(band, room()));
const short = target - picked.length;

// One third of the sheet checks a tuned prompt instead of tuning on it (docs/selection.md).
const spread = keyed(picked);
const holdout = new Set(spread.filter((_, i) => (i + 1) % 3 === 0).map((row) => row.id));

function line(row: Row): Record<string, unknown> {
  const gold: Record<string, unknown> = {
    caseId: row.id,
    // Not an eval field: the item's own page, to open while deciding. `caseId` is the article id, so the admin
    // 「内容诊断」 can open the same record too.
    sourceUrl: row.url,
    material: {
      title: row.title_zh || row.title,
      originalTitle: row.title,
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
      sourceName: row.source_name,
      bodyZh: null,
      // A source that only gives an excerpt is scored on that excerpt, so it goes in the same field as a body.
      bodyOriginal: row.body_text || row.excerpt,
    },
    sourceFacts: { sourceKind: row.kind, sourceTier: row.tier, firstParty: row.first_party, language: row.language },
    samplingContext: { benchmarkSplit: holdout.has(row.id) ? "holdout" : "development", samplingStratum: row.category ?? bandOf(row) },
    gold: { decision: "TODO" },
  };
  if (!values["no-hint"]) {
    gold.modelHint = {
      band: bandOf(row),
      threshold: tierThreshold(row.tier),
      relevance: row.relevance,
      score: row.score,
      selected: row.selected,
      model: row.model,
      titleZh: row.title_zh,
      summaryZh: row.summary_zh,
      reasonZh: row.reason_zh,
    };
  }
  return gold;
}

const counts = new Map<Band, number>(BANDS.map((band) => [band, picked.filter((row) => bandOf(row) === band).length]));
const header = [
  "// 待标注：把每行末尾的 \"decision\": \"TODO\" 改成 select / reject / either，然后跑 docs/selection.md 的“校准”。",
  "//   select 该进精选 · reject 不该进 · either 两可（不计入准确率）。",
  "//   按这条资料本身该不该选来标，不要因为同一件事已经选过另一篇就标 reject；评测只跑预筛和两次评分，不含归组去重。",
  "// modelHint 里是模型现在的打分（score）、门槛（threshold）和理由：先只看标题和正文自己标，标完再看它，免得被带着走。",
  "//   每行的 sourceUrl 是这条资料的原文页（评测不读它）；导入的法规条目那里是一段出处文字，不是链接。caseId 就是库里的资料编号，后台「内容诊断」也能打开同一条。",
  `// 每一条在哪个分数段（band）：${BANDS.filter((b) => counts.get(b)).map((b) => `${b} ${counts.get(b)}`).join(" · ")}`,
  "//   near-below 门槛−12～门槛 · near-above 门槛～门槛+8 · far-below / far-above 更远 · block 预筛就拦下 · unscored 没有分数",
  `// 门槛按信源分级：${[...new Set(rows.map((r) => r.tier))].sort().map((t) => `${t} ${tierThreshold(t) ?? "—（不参与精选）"}`).join(" · ")}`,
  "// 跑一遍：node --env-file=.env scripts/eval-selection.ts --gold <这个文件> --split development",
];

const file = path.resolve(REPO_ROOT, values.out!);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, `${[...header, ...spread.map((row) => JSON.stringify(line(row)))].join("\n")}\n`);

console.log(`${BANDS.filter((b) => counts.get(b)).map((b) => `${b}=${counts.get(b)}`).join("  ")}`);
console.log(`sheet: ${file}  ${picked.length} 条待标 · development ${picked.length - holdout.size} · holdout ${holdout.size}（库里可判的有 ${rows.length} 条，评分提示词 ${SELECTION_PROMPT_VERSION}）`);
if (short > 0) console.log(`比 --n 少 ${short} 条：贴着门槛的资料已经取完，没有拿离门槛很远的来凑数（那些一眼就能判断，准确率会虚高）。多跑几天采集再重抽，或加 --fill。`);
console.log(`标完：node --env-file=.env scripts/eval-selection.ts --gold ${values.out} --split development`);
await closeDb();
