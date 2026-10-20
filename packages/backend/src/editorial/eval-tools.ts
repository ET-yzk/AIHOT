// What the evaluation scripts and the admin's 金标 page share: reading case files, binary metrics and the
// helpers their reports are rounded with. The backend half of scripts/eval-tools.ts, because the gold page
// (/admin/gold) computes the same numbers on the scores already stored — see editorial/selection-metrics.ts.
import { z } from "zod";

/**
 * The cases of a JSONL file, one per line (blank lines and lines starting with // are skipped), each
 * checked by `schema`. The whole file is checked before anything is sent; an error names its line.
 */
export function parseCasesJsonl<S extends z.ZodType<{ caseId: string }>>(text: string, schema: S): z.infer<S>[] {
  const rows: z.infer<S>[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (!raw.trim() || raw.trim().startsWith("//")) continue;
    let row: z.infer<S>;
    try {
      row = schema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(`line ${line}: ${error instanceof z.ZodError ? z.prettifyError(error) : String(error)}`);
    }
    if (ids.has(row.caseId)) throw new Error(`line ${line}: duplicate caseId ${row.caseId}`);
    ids.add(row.caseId);
    rows.push(row);
  }
  return rows;
}

/** A string with more than whitespace in it, kept as written. */
export const nonEmpty = z.string().refine((value) => value.trim() !== "", "must be a non-empty string");
/** A string, or null when missing. */
export const nullableString = z.string().nullish().transform((value) => value ?? null);
/** Where a case was drawn from, for splitting and per-stratum reading. */
export const SamplingContext = z.object({
  benchmarkSplit: z.string().nullish().transform((value) => value ?? undefined),
  samplingStratum: z.string().nullish().transform((value) => value ?? undefined),
});

export const round = (value: number) => +value.toFixed(3);

/**
 * Yes/no decisions against gold labels. `answered` are the cases that got a decision; the rest of
 * `total` failed, and count against coverage and completeAccuracy, while accuracy, precision, recall and
 * F1 describe the answers.
 */
export function binaryMetrics(answered: Array<{ gold: boolean; predicted: boolean }>, total = answered.length) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const c of answered) {
    if (c.predicted && c.gold) tp++;
    else if (c.predicted) fp++;
    else if (c.gold) fn++;
    else tn++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  const correct = tp + tn;
  return {
    total,
    answered: answered.length,
    errors: Math.max(0, total - answered.length),
    tp, fp, fn, tn,
    coverage: round(answered.length / Math.max(1, total)),
    accuracy: round(correct / Math.max(1, answered.length)),
    completeAccuracy: round(correct / Math.max(1, total)),
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
  };
}
