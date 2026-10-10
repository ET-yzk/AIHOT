// One-time backfill: import historical regulations from the regpilot tracking table.
// Usage: node --env-file=.env scripts/backfill-regulations.ts [--dry]
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";

const SOURCE_ID = "backfill-regpilot";
const DRY = process.argv.includes("--dry");

interface RegRow {
  "法规编号": string | null;
  "法规全称": string | null;
  "业务分类": string | null;
  "法规认证类型": string | null;
  "地区": string | null;
  "生命周期阶段": string | null;
  "发布日期": string | null;
  "实施日期": string | null;
  "发布机构": string | null;
  "核心摘要": string | null;
  "适用车型": string | null;
  "影响评估": string | null;
  "原文链接": string | null;
}

const rows = JSON.parse(readFileSync(path.join(REPO_ROOT, "scripts/regulations-backfill.json"), "utf-8")) as RegRow[];
console.log(`Loaded ${rows.length} regulations from tracking table.`);

await sql`
  INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
  VALUES (${SOURCE_ID}, 'RegPilot 法规追踪导入', 'external', '{}'::jsonb, 'T1', 'editorial', 1440, true, 'ok', ${["法规", "历史导入"]})
  ON CONFLICT (id) DO NOTHING`;

let created = 0;
let skipped = 0;
for (const r of rows) {
  const title = r["法规编号"] && r["法规全称"]
    ? `${r["法规编号"]} ${r["法规全称"]}`
    : r["法规全称"] ?? r["法规编号"] ?? "";
  const url = r["原文链接"] ?? `https://backfill.internal/reg/${encodeURIComponent(title)}`;
  if (!title) { skipped++; continue; }

  const publishedAt = r["发布日期"] ? new Date(r["发布日期"]) : null;
  const summary = [r["核心摘要"], r["影响评估"]].filter(Boolean).join("\n\n");

  if (DRY) {
    console.log(`[DRY] ${title} → ${url}`);
    created++;
    continue;
  }

  const res = await upsertMaterial({
    sourceId: SOURCE_ID,
    url,
    title,
    author: r["发布机构"] ?? null,
    publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt : null,
    excerpt: summary || null,
    bodyText: summary || null,
    bodyStatus: summary ? "ok" : "none",
    raw: { _aihot: { backfill: true }, reg: r },
    via: "import",
    backfill: "reported-backfill",
  });

  if (res.created) {
    created++;
    await queueProcessing(res.articleId);
  } else {
    skipped++;
  }
}

console.log(`Done. Created: ${created}, Skipped (already exists): ${skipped}.`);

// The same tracking table also answers the daily's countdown (S-C5, FR-02-05): which dated regulations are
// coming up. Only a full calendar day is stored — "2026-10" is not 2026-10-01, and the precision guard the
// stage-2 corpus will define has no say over a value we invented here. Rows with no number cannot be keyed.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
let scheduled = 0;
let undated = 0;
for (const r of rows) {
  const code = r["法规编号"]?.trim();
  const effective = r["实施日期"]?.trim() ?? "";
  if (!code || !DAY.test(effective)) { undated++; continue; }
  if (DRY) {
    console.log(`[DRY] schedule ${code} → ${effective}`);
    scheduled++;
    continue;
  }
  await sql`
    INSERT INTO regulation_schedule (code, title, effective_on, source_url)
    VALUES (${code}, ${r["法规全称"] ?? code}, ${effective}, ${r["原文链接"]})
    ON CONFLICT (code) DO UPDATE
      SET title = EXCLUDED.title, effective_on = EXCLUDED.effective_on, source_url = EXCLUDED.source_url, updated_at = now()`;
  scheduled++;
}
console.log(`Schedule rows: ${scheduled} (skipped without a number or a full date: ${undated}).`);

if (!DRY) {
  console.log(`Source '${SOURCE_ID}' is ready. Articles queued for LLM analysis.`);
  console.log(`Monitor progress: SELECT processing_state, COUNT(*) FROM articles WHERE source_id='${SOURCE_ID}' GROUP BY 1;`);
}
await closeDb();
