// After every upstream sync: do the local dotenv files still match the keys the code reads?
// Run in both the Windows checkout and the WSL deployment.
//   node scripts/env-sync-check.ts            # this tree
//   wsl -u zkye -e bash -lc 'cd ~/project/regwatch && node scripts/env-sync-check.ts'
// It reads key names only, never values, and exits 1 when a dead or undocumented key needs a decision.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["packages", "apps", "modules", "site", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".git", "build", ".react-router", ".data", "tests"]);
/** Keys set by the deployment platform rather than read as application config here. */
const INFRA = new Set(["NODE_ENV", "PORT", "SITE_DOMAIN", "POSTGRES_PASSWORD"]);

const activeKey = /^\s*([A-Z][A-Z0-9_]*)=/;
const anyKey = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/;

function keys(file: string, activeOnly: boolean): string[] {
  if (!existsSync(file)) return [];
  if (!activeOnly) {
    // .env.example documents some keys inside prose comments, e.g. "deepseek-flash ... DEEPSEEK_BASE_URL=…".
    return [...new Set([...readFileSync(file, "utf8").matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)].map((m) => m[1]!))].sort();
  }
  const out = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = activeKey.exec(line);
    if (match) out.add(match[1]!);
  }
  return [...out].sort();
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx|mjs|sh|yml|yaml)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
const refs = new Set<string>();
const collect = (text: string, pattern: RegExp) => {
  for (const match of text.matchAll(pattern)) refs.add(match[1]!);
};

for (const file of files) {
  const text = readFileSync(file, "utf8");
  collect(text, /process\.env\.([A-Z][A-Z0-9_]*)/g);
  collect(text, /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g);
  collect(text, /credential\(\s*["'][a-z]+["']\s*,\s*["']([A-Z][A-Z0-9_]*)["']/g);
  collect(text, /(?:baseUrlEnv|apiKeyEnv)\s*:\s*["']([A-Z][A-Z0-9_]*)["']/g);
  if (file.endsWith("config.ts")) {
    collect(text, /\benv\.([A-Z][A-Z0-9_]*)/g);
    collect(text, /\b(?:str|int|bool)\(\s*["']([A-Z][A-Z0-9_]*)["']/g);
  }
  if (file.endsWith("docker-compose.yml")) collect(text, /\$\{([A-Z][A-Z0-9_]*)/g);
}

const shell = files.filter((file) => file.endsWith(".sh")).map((file) => readFileSync(file, "utf8")).join("\n");
const corpus = files.map((file) => readFileSync(file, "utf8")).join("\n");
// Some keys are named indirectly: notify_targets.config_ref rows and model presets store the env name as
// a string and resolve it through credential() later. A quoted occurrence of the exact key counts.
const referenced = (key: string) =>
  refs.has(key) || new RegExp("\\$\\{?" + key + "\\b").test(shell)
  || corpus.includes('"' + key + '"') || corpus.includes("'" + key + "'") || corpus.includes("`" + key + "`");

const envKeys = keys(path.join(ROOT, ".env"), true);
const localKeys = keys(path.join(ROOT, ".env.local"), true);
const exampleKeys = keys(path.join(ROOT, ".env.example"), false);
const local = [...new Set([...envKeys, ...localKeys])];

const dead = local.filter((key) => !referenced(key) && !INFRA.has(key));
const undocumented = local.filter((key) => !exampleKeys.includes(key) && !INFRA.has(key));
const stale = exampleKeys.filter((key) => !referenced(key) && !INFRA.has(key));
const unset = exampleKeys.filter((key) => !local.includes(key));
// --compare <path>: the other checkout's .env. Different key sets mean the two trees disagree on config.
const compareAt = process.argv.indexOf("--compare");
const compareFile = compareAt === -1 ? null : process.argv[compareAt + 1];
const onlyHere = compareFile ? envKeys.filter((key) => !keys(compareFile, true).includes(key)) : [];
const onlyThere = compareFile ? keys(compareFile, true).filter((key) => !envKeys.includes(key)) : [];
/** Runtime/build keys the platform supplies; not configuration this repository documents. */
const RUNTIME = /^(NODE_|PATH$|PWD$|HOME$|TMPDIR$|TZ$|PG(PASSWORD|USER)$|CI$|GITHUB_|TEST_|RESTORED_|DIVERGENCE_|DOCTOR_)/;
const undocumentedCode = [...refs].filter((key) => !exampleKeys.includes(key) && !INFRA.has(key) && !RUNTIME.test(key));

console.log("# env sync check");
console.log("local:", local.length, "documented:", exampleKeys.length, "referenced:", refs.size);
if (dead.length) console.log("\n[dead] set locally but no code reads it:\n  " + dead.join("\n  "));
if (undocumented.length) console.log("\n[undocumented] set locally but missing from .env.example:\n  " + undocumented.join("\n  "));
if (stale.length) console.log("\n[stale example] documented but no code reads it:\n  " + stale.join("\n  "));
if (undocumentedCode.length) console.log("\n[undocumented code] read by code but missing from .env.example:\n  " + undocumentedCode.join("\n  "));
if (onlyHere.length || onlyThere.length) console.log("\n[checkout drift] " + compareFile + "\n  only here: " + onlyHere.join(", ") + "\n  only there: " + onlyThere.join(", "));
console.log("\n[optional] documented, not set locally (" + unset.length + "): " + unset.join(", "));
if (dead.length || undocumented.length || stale.length || undocumentedCode.length || onlyHere.length || onlyThere.length) process.exitCode = 1;
else console.log("\nOK: .env, .env.local and .env.example agree with the code.");
