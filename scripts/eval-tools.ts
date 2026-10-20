// What the evaluation scripts (scripts/eval-*.ts) share: reading case files, the seeded sample, binary
// metrics, argument checks, the models to compare, bounded concurrency, what their paid attempts used,
// and safe report names. The case-file and metrics helpers live in the backend (editorial/eval-tools.ts)
// because the admin's 金标 page computes the same numbers on stored scores; re-exported here so the
// scripts keep one import site.
import { sql } from "@aihot/backend/db";
import { modelFor } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";

export {
  binaryMetrics, nonEmpty, nullableString, parseCasesJsonl, round, SamplingContext,
} from "@aihot/backend/editorial/eval-tools";

/**
 * The cases of one benchmark split ("all": every case) in a deterministic order drawn from `seed`, the
 * first `n` of them: the same seed draws the same sample in every run.
 */
export function sampleCases<T extends { samplingContext?: { benchmarkSplit?: string } }>(rows: T[], opts: { split: string; n: number; seed: number }): T[] {
  const pool = opts.split === "all" ? rows : rows.filter((row) => row.samplingContext?.benchmarkSplit === opts.split);
  if (!pool.length) throw new Error(`no gold cases for split ${opts.split}`);
  let state = opts.seed >>> 0;
  const next = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return pool.map((row) => ({ row, key: next() })).sort((a, b) => a.key - b.key).slice(0, Math.max(0, opts.n)).map(({ row }) => row);
}

export function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

/** --models as given (`default` or the site's presets), else the model the step uses now. */
export async function evalModels(list: string | undefined, step: string): Promise<string[]> {
  const models = list ? list.split(",").map((model) => model.trim()).filter(Boolean) : [await modelFor(step)];
  if (!models.length) throw new Error("--models did not name any models");
  for (const model of models) if (!MODELS[model]) throw new Error(`unknown model ${model}`);
  return models;
}

/** `fn` over `items`, at most `limit` at a time; results keep the items' order. */
export async function pmap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

/** Every attempt behind these receipts, each receipt once, unusable answers included. */
export async function usageFor(receiptIds: number[]) {
  const ids = [...new Set(receiptIds)];
  if (!ids.length) return { tokensIn: 0, tokensOut: 0, avgLatencyMs: 0 };
  const [usage] = await sql<{ tin: number; tout: number; latency: number }[]>`
    SELECT
      sum(coalesce((usage->>'prompt_tokens')::int, (usage->>'input_tokens')::int, 0)) AS tin,
      sum(coalesce((usage->>'completion_tokens')::int, (usage->>'output_tokens')::int, 0)) AS tout,
      avg(latency_ms) AS latency
    FROM receipt_attempts WHERE receipt_id IN ${sql(ids)}`;
  return {
    tokensIn: Number(usage?.tin ?? 0),
    tokensOut: Number(usage?.tout ?? 0),
    avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
  };
}

/** A user-supplied split may contain path separators; report names must stay inside .data/eval. */
export function safeReportNamePart(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "all";
}
