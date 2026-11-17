// Runs one sync of the Feishu source table now (the worker also runs it on SOURCE_TABLE_SYNC_CRON).
//   node --env-file=.env scripts/sync-source-table.ts
// Prints the watermark the page will show; exits 1 when the run failed, so a deploy step notices.
import { sql } from "@aihot/backend/db";
import { syncSourceTable } from "../modules/source-table/sync.ts";

const result = await syncSourceTable();
console.log(JSON.stringify(result, null, 2));
await sql.end();
if (result.status !== "ok") process.exitCode = 1;
