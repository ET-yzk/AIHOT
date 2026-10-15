// 金标（gold labels）：人工判定「这条资料该不该进精选」，用来校准评分标准与门槛（docs/selection.md 的校准第 1 步）。
// 这一步原来只有一张写成 JSONL 的待标注表，由人逐行改；这里把判定存进 gold_labels，/admin/gold 读它，
// 同一张表也导出成 scripts/eval-selection.ts 能直接读的行，两边不会各存一份标。
// 付费的新鲜评测仍然只在脚本里跑：页面不碰模型（读者和管理员打开任何页面都不触发模型调用）。
import { SELECTION } from "@aihot/industry/selection";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { SELECTION_PROMPT_VERSION, tierThreshold } from "../editorial/analyze.ts";
import { selectionMetrics, selectionThresholdMetrics, type SelectionGoldDecision, type SelectionThresholdCase } from "../editorial/selection-metrics.ts";

export const GOLD_DECISIONS = ["select", "reject", "either"] as const;
export type GoldDecision = (typeof GOLD_DECISIONS)[number];
export const GOLD_SPLITS = ["development", "holdout"] as const;
export type GoldSplit = (typeof GOLD_SPLITS)[number];

/**
 * Where an item sits against its own tier's threshold, plus the two kinds that never got a score.
 * The page samples on these and groups on them, so a band means the same thing in both places.
 */
export type GoldBand = "near-below" | "near-above" | "far-above" | "far-below" | "block" | "unscored";
export const GOLD_BANDS: GoldBand[] = ["near-below", "near-above", "far-above", "far-below", "block", "unscored"];
/** How a sheet is composed: the cases a threshold move can actually change come first. */
export const GOLD_BAND_SHARE: Record<GoldBand, number> = { "near-below": 30, "near-above": 26, "far-above": 14, "far-below": 12, block: 10, unscored: 8 };

/** The parts of a scored item the band depends on; `tier` is the source's own grading. */
export interface GoldScorable {
  relevance: string | null;
  score: number | null;
  sourceTier: string;
}

export function goldBandOf(row: GoldScorable): GoldBand {
  if (row.relevance === "block") return "block";
  const threshold = tierThreshold(row.sourceTier);
  if (row.score === null || threshold === null) return "unscored";
  const gap = row.score - threshold;
  if (gap < -12) return "far-below";
  if (gap < 0) return "near-below";
  return gap < 8 ? "near-above" : "far-above";
}

interface SampleRow extends GoldScorable {
  case_id: string;
  title: string;
  url: string;
  source_name: string;
  source_kind: string;
  first_party: boolean;
  published_at: Date | null;
  language: string | null;
  judged: string | null;
  selected: boolean | null;
  model: string | null;
  prompt_version: string | null;
  reason_zh: string | null;
  title_zh: string | null;
  summary_zh: string | null;
  category: string | null;
  decision: GoldDecision | null;
  note: string | null;
  split: GoldSplit | null;
  labelled_threshold: number | null;
  labelled_score: number | null;
  updated_by: string | null;
  updated_at: Date | null;
  version: number | null;
}

/**
 * Everything the two lists need, in one read: an item, its newest score, and its label if it has one.
 * An item with nothing to judge (no body, no excerpt, no post) is left out — a label on an empty record
 * calibrates nothing, and eval-selection.ts would have no text to score.
 */
async function samples(): Promise<SampleRow[]> {
  return sql<SampleRow[]>`
    SELECT a.id AS case_id, a.title, a.url, a.published_at, a.language,
           coalesce(a.body_text, a.excerpt) AS judged,
           s.name AS source_name, s.kind AS source_kind, s.tier AS "sourceTier", s.first_party,
           an.relevance, an.score::int AS score, an.selected, an.model, an.prompt_version,
           an.reason_zh, an.title_zh, an.summary_zh, an.category,
           g.decision, g.note, g.split, g.threshold AS labelled_threshold, g.model_score AS labelled_score,
           g.updated_by, g.updated_at, g.version
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN LATERAL (
      SELECT n.relevance, n.score, n.selected, n.model, n.prompt_version, n.reason_zh, n.title_zh, n.summary_zh, n.category
      FROM analyses n WHERE n.article_id = a.id ORDER BY n.id DESC LIMIT 1
    ) an ON TRUE
    LEFT JOIN gold_labels g ON g.case_id = a.id
    WHERE s.tier <> 'EXCLUDE_MP'
      AND (a.body_text IS NOT NULL OR a.excerpt IS NOT NULL OR a.x_post IS NOT NULL)`;
}

/** The sheet the page shows and the numbers the labels already give, from one read of the library. */
export async function goldView(f: { awaiting?: number; seed?: number } = {}) {
  const rows = await samples();
  return { board: goldBoard(rows, f), report: goldReport(rows) };
}

/** Every labelled item plus the hard cases still waiting, nearest the bar first. */
function goldBoard(rows: SampleRow[], f: { awaiting?: number; seed?: number } = {}) {
  const labelled = rows.filter((r) => r.decision).sort((a, b) => (b.updated_at?.getTime() ?? 0) - (a.updated_at?.getTime() ?? 0));
  // Deterministic draw, so reloading the page shows the same items and 「换一批」 is the only thing that moves them.
  let state = (f.seed ?? 7) >>> 0;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const keyed = <T,>(items: T[]) => items.map((item) => ({ item, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.item);
  const waiting = rows.filter((r) => !r.decision);
  const pools = new Map<GoldBand, SampleRow[]>(GOLD_BANDS.map((band) => [band, keyed(waiting.filter((r) => goldBandOf(r) === band))]));
  const target = Math.max(1, Math.min(200, f.awaiting ?? 24));
  const picked: SampleRow[] = [];
  const take = (band: GoldBand, max: number) => pools.get(band)!.splice(0, max);
  const room = () => target - picked.length;
  for (const band of GOLD_BANDS) picked.push(...take(band, Math.min(Math.round((target * GOLD_BAND_SHARE[band]) / 100), room())));
  // A band with fewer items than its share cannot be filled; the rooms go to the hard cases only, never to the
  // far-from-bar ones — those are judged at a glance and would lift every accuracy number on the page.
  for (const band of ["near-above", "near-below", "block", "unscored"] as GoldBand[]) picked.push(...take(band, room()));
  // A third of what is still waiting is set aside as holdout before you judge it, the same draw the sheet used:
  // it fixes the split when the label is written, so tuning the prompt never sees these.
  const holdout = new Set(keyed(picked).filter((_, i) => (i + 1) % 3 === 0).map((r) => r.case_id));
  return {
    thresholds: SELECTION.thresholds,
    promptVersion: SELECTION_PROMPT_VERSION,
    bands: GOLD_BANDS.map((band) => ({ band, waiting: waiting.filter((r) => goldBandOf(r) === band).length })),
    waiting: waiting.length,
    labelled: labelled.length,
    cases: picked.map((r) => asCase(r, holdout.has(r.case_id) ? "holdout" : "development")),
    labels: labelled.map((r) => asCase(r)),
  };
}

function asCase(r: SampleRow, drawnSplit?: GoldSplit) {
  return {
    caseId: r.case_id,
    title: r.title,
    url: r.url,
    sourceName: r.source_name,
    sourceKind: r.source_kind,
    sourceTier: r.sourceTier,
    firstParty: r.first_party,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    language: r.language,
    judged: r.judged,
    titleZh: r.title_zh,
    summaryZh: r.summary_zh,
    reasonZh: r.reason_zh,
    category: r.category,
    band: goldBandOf(r),
    threshold: tierThreshold(r.sourceTier),
    relevance: r.relevance,
    score: r.score,
    modelSelected: r.selected,
    model: r.model,
    promptVersion: r.prompt_version,
    decision: r.decision,
    note: r.note,
    split: r.split ?? drawnSplit ?? "development",
    labelledThreshold: r.labelled_threshold,
    labelledScore: r.labelled_score,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
    version: r.version,
  };
}

export type GoldCase = ReturnType<typeof goldBoard>["cases"][number];

/**
 * What today's stored verdicts get right on the labels that exist. Read-only and free: it compares the human
 * label with the score already in the library, so no model is called. scripts/eval-selection.ts remains the
 * place that re-runs the model for a fresh answer — that one costs money and needs the valves open.
 */
function goldReport(rows: SampleRow[]) {
  const labelledRows = rows.filter((r) => r.decision);
  const cases = labelledRows.map((r) => ({
    gold: r.decision as SelectionGoldDecision,
    // A blocked item has been answered — it is a reject at every threshold, so sweeping the bar must not drop it
    // out of the denominator and report the rest as a better recall than the stored verdicts give.
    available: r.relevance === "block" || (r.relevance === "pass" && r.score !== null),
    relevance: r.relevance,
    score: r.score,
    tier: r.sourceTier,
    selected: r.selected,
  }));
  const metrics = selectionMetrics(cases.map((c) => ({
    gold: c.gold,
    // The pipeline's own verdict, as stored. A blocked or unscored item answered nothing.
    decision: c.relevance === "block" ? "reject" : c.selected === null ? null : c.selected ? "select" : "reject",
  })));
  const disagreements = labelledRows
    .filter((r) => r.decision !== "either" && r.relevance !== null && (r.relevance === "block" ? r.decision === "select" : r.selected !== (r.decision === "select")))
    .map((r) => ({
      caseId: r.case_id,
      title: r.title,
      url: r.url,
      sourceTier: r.sourceTier,
      band: goldBandOf(r),
      threshold: tierThreshold(r.sourceTier),
      relevance: r.relevance,
      score: r.score,
      modelSelected: r.selected,
      decision: r.decision as GoldDecision,
      // false negative: the human would publish it and the bar let it through as rejected.
      kind: (r.relevance === "block" || r.selected === false) && r.decision === "select" ? "missed" : "picked",
    }));
  // Sweep per tier: the rule `mean >= threshold` is the one eval-selection applies, but a single number across
  // three tiers would compare a T1 item's bar with a T2 item's bar and call the difference accuracy.
  const sweeps = Object.entries(SELECTION.thresholds).map(([tier, current]) => ({
    tier,
    current,
    rows: Array.from({ length: 13 }, (_, i) => current - 6 + i)
      .map((t) => ({ ...selectionThresholdMetrics(cases.filter((c) => c.tier === tier), t), t }))
      .filter((row) => row.decisiveGold > 0),
  }));
  return { metrics, disagreements, sweeps, labelled: labelledRows.length };
}

/** The rows scripts/eval-selection.ts reads, so a sheet labelled in the browser goes straight to the paid eval. */
export async function goldSheet(split?: GoldSplit) {
  const rows = (await samples()).filter((r): r is SampleRow & { decision: GoldDecision } => !!r.decision && (!split || r.split === split));
  return rows.map((r) => ({
    caseId: r.case_id,
    sourceUrl: r.url,
    material: {
      title: r.title_zh || r.title,
      originalTitle: r.title,
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      sourceName: r.source_name,
      bodyZh: null,
      bodyOriginal: r.judged,
    },
    sourceFacts: { sourceKind: r.source_kind, sourceTier: r.sourceTier, firstParty: r.first_party, language: r.language },
    samplingContext: { benchmarkSplit: r.split ?? "development", samplingStratum: r.category ?? goldBandOf(r) },
    gold: { decision: r.decision },
    ...(r.note ? { note: r.note } : {}),
  }));
}

/** One human verdict, with the bar and score it was judged against kept beside it. `null` — the item is not in the library. */
export async function saveGoldLabel(input: { caseId: string; decision: string; note?: string; split?: string }, actor: string) {
  const decision = input.decision as GoldDecision;
  if (!GOLD_DECISIONS.includes(decision)) throw Object.assign(new Error(`decision must be one of ${GOLD_DECISIONS.join(" / ")}`), { statusCode: 400 });
  const split = (input.split ?? "development") as GoldSplit;
  if (!GOLD_SPLITS.includes(split)) throw Object.assign(new Error(`split must be one of ${GOLD_SPLITS.join(" / ")}`), { statusCode: 400 });
  const [row] = await sql<{ tier: string; score: number | null; selected: boolean | null; decision: GoldDecision | null; note: string | null; split: GoldSplit | null }[]>`
    SELECT s.tier, an.score::int AS score, an.selected, g.decision, g.note, g.split
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN LATERAL (SELECT n.score, n.selected FROM analyses n WHERE n.article_id = a.id ORDER BY n.id DESC LIMIT 1) an ON TRUE
    LEFT JOIN gold_labels g ON g.case_id = a.id
    WHERE a.id = ${input.caseId}`;
  if (!row) return null;
  const before = row.decision ? { decision: row.decision, note: row.note, split: row.split } : null;
  await sql`
    INSERT INTO gold_labels (case_id, decision, note, split, source_tier, threshold, model_score, model_selected, prompt_version, updated_by, updated_at, version)
    VALUES (${input.caseId}, ${decision}, ${input.note ?? null}, ${split}, ${row.tier}, ${tierThreshold(row.tier)}, ${row.score}, ${row.selected},
            ${SELECTION_PROMPT_VERSION}, ${actor}, now(), 1)
    ON CONFLICT (case_id) DO UPDATE
    SET decision = EXCLUDED.decision, note = EXCLUDED.note, split = EXCLUDED.split, source_tier = EXCLUDED.source_tier,
        threshold = EXCLUDED.threshold, model_score = EXCLUDED.model_score, model_selected = EXCLUDED.model_selected,
        prompt_version = EXCLUDED.prompt_version, updated_by = EXCLUDED.updated_by, updated_at = now(),
        version = gold_labels.version + 1`;
  await audit(actor, "gold.label", `gold:${input.caseId}`, input.note ?? null, before, { decision, split });
  return { caseId: input.caseId, decision, split };
}

/** Removing a verdict is as auditable as making one: the label is a measurement, not a scratch note. */
export async function deleteGoldLabel(caseId: string, actor: string) {
  const [before] = await sql<{ decision: GoldDecision; note: string | null; split: GoldSplit }[]>`
    SELECT decision, note, split FROM gold_labels WHERE case_id = ${caseId}`;
  if (!before) return null;
  await sql`DELETE FROM gold_labels WHERE case_id = ${caseId}`;
  await audit(actor, "gold.delete", `gold:${caseId}`, before.note, before, null);
  return { caseId, deleted: true };
}
