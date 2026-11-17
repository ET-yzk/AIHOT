// Writes a saved snapshot of the Feishu table into the mirror without calling Feishu: the fallback for a
// deployment whose app cannot read the table yet, and how tests and demos load 104 real rows.
//   node --env-file=.env scripts/import-source-table-snapshot.ts .data/regpilot/sources_v2.ndjson
// The file is either an array of { record_id, fields } or NDJSON of the same objects.
import { readFileSync } from "node:fs";
import { sql } from "@aihot/backend/db";
import { importSnapshot } from "../modules/source-table/sync.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --env-file=.env scripts/import-source-table-snapshot.ts <snapshot.ndjson>");
  process.exit(1);
}
const text = readFileSync(file, "utf8").trim();
const records: Array<{ record_id: string; fields: Record<string, unknown> }> = text.startsWith("[")
  ? JSON.parse(text)
  : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const result = await importSnapshot(records);
console.log(JSON.stringify(result, null, 2));
await sql.end();
