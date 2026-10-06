// 枚举体检：迁移里每个 CHECK (列 IN (…)) 允许了哪些值，而这一版代码里有没有人拿它做过判断。
// 只读：不连库、不出网、不写文件。它永远 exit 0——一个没人点名的值不一定是缺陷（有的属于没有任何代码
// 引用的表，有的属于排在后面的写入方），所以判断留给要往 CHECK 名单里加值的那个人。
//   node scripts/audit-schema-enums.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS = join(ROOT, "database/migrations");
const BACKEND = join(ROOT, "packages/backend/src");
/** 算「这张表有人引用吗」的范围：产品代码、前端、脚本和测试，不含迁移自己。 */
const REFERENCE_DIRS = ["packages", "apps", "scripts", "tests"];

function walk(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".data") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, match));
    else if (match(entry.name)) found.push(path);
  }
  return found;
}
const rel = (path: string) => relative(ROOT, path).replaceAll("\\", "/");

// ── 1. 迁移声明的每一个 CHECK (列 IN (…)) ─────────────────────────────────────────
const enums: Array<{ table: string; column: string; values: string[]; where: string }> = [];
const created = new Set<string>();
let table = "";
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  readFileSync(join(MIGRATIONS, file), "utf8")
    .split("\n")
    .forEach((line, i) => {
      const made = line.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/i);
      if (made) {
        table = made[1]!;
        created.add(table);
      }
      const check = line.match(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/i);
      if (!check) return;
      enums.push({
        table,
        column: check[1]!,
        values: check[2]!.split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean),
        where: `${rel(join(MIGRATIONS, file))}:${i + 1}`,
      });
    });
}

// ── 2. 后端代码在非注释行里加过引号的名字 ────────────────────────────────────────
const named = new Map<string, string>();
const backendFiles = walk(BACKEND, (n) => n.endsWith(".ts"));
for (const file of backendFiles) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      for (const hit of line.matchAll(/["']([A-Za-z][A-Za-z0-9_-]*)["']/g)) {
        if (!named.has(hit[1]!)) named.set(hit[1]!, `${rel(file)}:${i + 1}`);
      }
    });
}
// 扫描本身坏了的话，下面每一条都会「全绿」，所以先自证它读到了东西。
if (!named.has("json_list") || !named.has("summary-only") || named.size < 50) {
  console.log(`✗ 这次扫到 ${named.size} 个引号名，少于预期——扫描本身坏了，上面的数字都不算证据`);
  process.exit(0);
}

// ── 3. 哪些表在代码、脚本和测试里一次都没出现 ────────────────────────────────────
const referenceText = REFERENCE_DIRS.flatMap((dir) =>
  walk(join(ROOT, dir), (n) => /\.(ts|tsx|sql)$/.test(n)).map((f) => readFileSync(f, "utf8")),
).join("\n");
const tables = [...new Set(enums.map((e) => e.table))];
const unreferenced = [...created].filter((t) => !new RegExp(`\\b${t}\\b`).test(referenceText)).sort();

// ── 报告 ─────────────────────────────────────────────────────────────────────────
console.log(`${enums.length} 个 CHECK 枚举（分布在 ${tables.length} 张表上），迁移共建了 ${created.size} 张表；后端 ${backendFiles.length} 个文件里扫到 ${named.size} 个引号名`);

const unnamed = enums.flatMap((e) => e.values.filter((v) => !named.has(v)).map((value) => ({ e, value })));
console.log(`\n没有任何非注释代码点名的值：${unnamed.length}`);
for (const { e, value } of unnamed) {
  const tag = unreferenced.includes(e.table) ? "（整张表都没人引用）" : `（表有人用，出处 ${e.where}）`;
  console.log(`– ${e.table}.${e.column} = '${value}' ${tag}`);
}

console.log(`\n迁移建了但代码、脚本、测试一次都没提到的表：${unreferenced.length}`);
for (const t of unreferenced) console.log(`– ${t}`);

console.log(`\n一个值出现在上面第一段里，不等于它是缺陷；一个值没出现，也不等于真有代码拿它做过判断——`);
console.log(`这里数的是名字，不是分支。往 CHECK 名单里加值之前，先读 regdocs/阶段一验收记录.md 第 20 节。`);
