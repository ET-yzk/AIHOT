// The industry pack is the only thing that changes when this framework is pointed at another industry,
// so its internal contradictions are worth checking on their own: a source configured with a key its
// kind does not implement is silently ignored (menus as articles, dates never found), and a tag or a
// category no prompt can produce leaves a filter that never matches. No database, no network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import {
  CATEGORIES, CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, IDENTITY_LEXICON,
  ITEM_TYPES, PUBLIC_CATEGORY_FOLDS, TAG_SYNONYMS, TOPIC_TAGS,
} from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";

const pack = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const allTags = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);
const categoryKeys = CATEGORIES.map((c) => c.key) as string[];

interface PackSource { id: string; name: string; kind: Parameters<typeof unsupportedConfig>[0]; tier?: string; owner_entity_id?: string | null; config: Record<string, unknown> }
const sources = (JSON.parse(pack("industry/sources.json")) as { sources: PackSource[] }).sources;

/**
 * The values a column may hold, read out of the migrations that made the table. Reading the DDL instead of a
 * live database keeps this file runnable with no server: the contract between the pack and the schema must hold
 * before anything is inserted, not after.
 */
function checkEnum(table: string, column: string): string[] {
  const dir = new URL("../database/migrations/", import.meta.url);
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const blocks = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\b[\\s\\S]*?\\n\\);`, "g").exec(readFileSync(new URL(file, dir), "utf8"));
    for (const block of blocks ? [blocks[0]!] : []) {
      const line = block.split("\n").find((l) => new RegExp(`^\\s+${column}\\s+text[^\\n]*CHECK \\(${column} IN \\(`).test(l));
      for (const match of line?.matchAll(/'([^']+)'/g) ?? []) found.add(match[1]!);
    }
  }
  return [...found];
}

test("every source in the pack is configured with keys its own kind implements", () => {
  assert.ok(sources.length > 0, "the pack ships at least one source");
  assert.equal(new Set(sources.map((s) => s.id)).size, sources.length, "source ids are unique");
  for (const s of sources) {
    // A kind the collector does not know refuses every key, so an unknown kind reads as "all wrong".
    assert.deepEqual(unsupportedConfig(s.kind, s.config), [], `${s.id}: config keys its kind does not implement`);
    assert.ok(s.name.length > 0, `${s.id}: a source a person can recognise`);
    if (s.tier) assert.ok(s.tier in SELECTION.thresholds, `${s.id}: tier ${s.tier} has no selection threshold`);
    if (s.owner_entity_id) assert.ok(s.owner_entity_id in ENTITIES, `${s.id}: owner ${s.owner_entity_id} is not an entity of the pack`);
  }
});

// A query parameter whose value is JSON is how these search APIs are told what to sort by. A malformed one is
// not an error: the endpoint still answers, ignores the clause and returns its own default order, which for the
// MIIT search put documents from 2004-2019 in front of a source meant to collect this week's notices.
test("a JSON-shaped query parameter in a source URL is valid JSON", () => {
  for (const s of sources) {
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (!/^https?:/.test(url)) continue;
    for (const [key, value] of new URL(url).searchParams) {
      if (!value.startsWith("[") && !value.startsWith("{")) continue;
      assert.doesNotThrow(() => JSON.parse(value), `${s.id}: ?${key}=${value} is not JSON, so the endpoint ignores it`);
    }
  }
});


const REPORT_ENDPOINTS: Record<string, string> = { daily: "/api/v1/dailies", weekly: "/api/v1/reports/weekly", monthly: "/api/v1/reports/monthly" };
const contract = JSON.parse(pack("reference/public-v1.openapi.json")) as { paths: Record<string, unknown> };

// The schema and the pack are two halves of one contract: a kind the migrations refuse makes the pack unseedable,
// and a kind no public endpoint names is stored but never readable. Each side can drift alone without the other
// noticing, so they are checked against each other — from the DDL and the JSON on disk, still with no database.
test("the kinds the schema allows, the pack writes and the public API names are the same kinds", () => {
  const allowed = checkEnum("sources", "kind");
  assert.ok(allowed.length > 0, "the sources table declares its kinds with a CHECK");
  // The collector implements exactly these, so the list is spelled out: growing the enum or the collector on its
  // own is a decision about the framework, not a refactor that should pass quietly.
  assert.deepEqual([...allowed].sort(), ["external", "json_list", "mp_account", "rss", "web_list", "x_search"]);
  for (const s of sources) {
    assert.ok(allowed.includes(s.kind), `${s.id}: kind ${s.kind} is refused by the sources table`);
    assert.ok(["rss", "web_list", "json_list"].includes(s.kind), `${s.id}: ${s.kind} is not a declarative kind, so the pack needs collector code for it`);
  }

  const stored = [...checkEnum("reports", "kind")].sort();
  assert.deepEqual(stored, ["daily", "monthly", "weekly"], "the reports table stores the three periods this site publishes");
  const published = Object.entries(REPORT_ENDPOINTS).filter(([, path]) => path in contract.paths).map(([kind]) => kind).sort();
  assert.deepEqual(stored, published, "each report kind the table stores has one public endpoint, and none names a kind the table refuses");
});

test("the pack's tag lists, synonyms and fallbacks all name tags that exist", () => {
  for (const [written, target] of Object.entries(TAG_SYNONYMS)) {
    assert.ok(allTags.has(target), `the synonym ${written} folds onto ${target}, which the pack does not list`);
    assert.ok(!allTags.has(written), `${written} is listed as a tag and as a synonym of another tag`);
  }
  for (const [itemType, tag] of Object.entries(CATEGORY_BY_ITEM_TYPE)) {
    assert.ok(ITEM_TYPES.includes(itemType as (typeof ITEM_TYPES)[number]), `${itemType} is not an item type of the pack`);
    assert.ok(allTags.has(tag), `the fallback tag ${tag} is not in the tag lists`);
  }
  for (const [publicKey, folded] of Object.entries(PUBLIC_CATEGORY_FOLDS)) {
    assert.ok(categoryKeys.includes(publicKey), `${publicKey} is not a category of the pack`);
    for (const key of folded) assert.ok(categoryKeys.includes(key), `the public category ${publicKey} folds in ${key}, which is not a category`);
  }
});

test("categories, entity tags and the identity lexicon describe the same industry", () => {
  assert.equal(new Set(categoryKeys).size, categoryKeys.length, "category keys are unique");
  assert.ok(new Set(CATEGORIES.map((c) => c.section)).size >= 2, "categories are grouped into more than one section");
  for (const c of CATEGORIES) assert.ok(c.guide.length > 20, `${c.key}: a guide long enough to judge against`);

  // The regulation weighting is a filter over these keys (industry/selection.ts, applied by step 2.6): a key the
  // taxonomy does not have leaves the rule in the pack but nothing for it to match.
  for (const key of SELECTION.regulationCategories) assert.ok(categoryKeys.includes(key), `the weight names ${key}, which is not a category of the pack`);
  if (SELECTION.regulationWeight > 1) assert.ok(SELECTION.regulationCategories.length > 0, "the pack weights regulations but names none of them");

  for (const [id, entity] of Object.entries(ENTITIES)) {
    if (entity.displayTag) assert.ok(ENTITY_TAGS.includes(entity.displayTag as (typeof ENTITY_TAGS)[number]), `${id} shows ${entity.displayTag}, which is not an entity tag`);
    assert.ok(entity.aliases.length > 0, `${id}: an entity needs the writings that match it`);
  }
  for (const entry of IDENTITY_LEXICON) {
    assert.ok(entry.id in ENTITIES, `the lexicon names ${entry.id}, which the pack has no entity for`);
    assert.ok(entry.patterns.length > 0, `${entry.id}: nothing to match`);
  }
});

/**
 * A rule the platform never reads is a number in a file, not a rule, and nothing above catches it: those
 * checks compare the pack with itself. The regulation weighting was found that way — `regulationWeight: 1.6`
 * sits in the pack, the check above pins only that the categories it names exist, and the hot list a reader
 * sees is ordered without anything multiplying. So every rule the thresholds file exports is either read by
 * platform code or waiting here by name, with the step that will read it. Both directions go red: a rule
 * nobody reads and nobody claimed, and a claimed rule someone has since wired up and left in this list.
 */
const WAITING_FOR_A_STEP: Record<string, string> = {
  regulationCategories: "2.6 法规权重（阶段二，依赖阶段一）",
  regulationWeight: "2.6 法规权重（同上）",
};

test("every selection rule the pack declares is read by the platform or named as waiting", () => {
  const read = new Set<string>();
  for (const root of ["packages", "apps", "scripts"]) {
    const dir = fileURLToPath(new URL(`../${root}/`, import.meta.url));
    for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(rel) || /node_modules|[/\\](?:dist|build)[/\\]/.test(`/${rel}`)) continue;
      for (const line of readFileSync(join(dir, rel), "utf8").split("\n")) {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue; // naming a rule in a comment is not the platform reading it
        for (const hit of line.matchAll(/\bSELECTION\.(\w+)/g)) read.add(hit[1]!);
      }
    }
  }
  // The premise: a walk that found nothing would let any unread rule through unnoticed.
  assert.ok(read.has("thresholds"), `the walk found ${[...read].join(", ") || "no reads at all"} — the scan itself is broken`);
  for (const key of Object.keys(SELECTION)) {
    assert.ok(read.has(key) || key in WAITING_FOR_A_STEP, `SELECTION.${key} is declared in the pack and read by nothing: wire it up, or name it in WAITING_FOR_A_STEP with the step that will`);
  }
  for (const [key, step] of Object.entries(WAITING_FOR_A_STEP)) {
    assert.ok(key in SELECTION, `WAITING_FOR_A_STEP claims ${key}, which the pack no longer declares`);
    assert.ok(!read.has(key), `SELECTION.${key} is now read by the platform: drop it from WAITING_FOR_A_STEP (${step})`);
  }
});


/**
 * Two enums decide whether a reader sees anything: `sources.participation_mode` and `publications.visibility`.
 * Both decisions compare the value against names the code knows, and both fall through the open way —
 * `publish.ts:182` treats anything but "isolated" as publishable, `availability.ts:16` answers "public" for anything
 * but "summary-only", and a report counts anything `<> 'withdrawn'` (operations/reports.ts:23). So a value the
 * migrations allow and the code never names is a value that gets shown, and the two halves each grow on their own.
 * The values come out of the DDL rather than being copied here, which is the whole point.
 */
const REACH_ENUMS: Array<{ table: string; column: string; openWay: string }> = [
  { table: "sources", column: "participation_mode", openWay: 'publish.ts sends everything but "isolated" to public' },
  { table: "publications", column: "visibility", openWay: 'availability.ts answers "public" for anything but "summary-only"' },
];

test("every visibility and participation mode the schema allows is one the code decides on", () => {
  const named = new Set<string>();
  const dir = fileURLToPath(new URL("../packages/backend/src/", import.meta.url));
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!/\.ts$/.test(rel)) continue;
    for (const line of readFileSync(join(dir, rel), "utf8").split("\n")) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue; // a comment naming a value is not the platform deciding on it
      for (const hit of line.matchAll(/["']([a-z0-9_-]+)["']/g)) named.add(hit[1]!);
    }
  }
  // The premise, same shape as the SELECTION walk above: a scan that read nothing would pass every value quietly.
  assert.ok(named.has("json_list") && named.size > 50, `the walk collected ${named.size} quoted names — the scan itself is broken`);
  for (const { table, column, openWay } of REACH_ENUMS) {
    const allowed = checkEnum(table, column);
    assert.ok(allowed.length > 0, `${table}.${column} is not declared with a CHECK the way this test assumes`);
    for (const value of [...allowed].sort()) {
      assert.ok(named.has(value), `${table}.${column} allows ${value}, but no code decides on it: ${openWay}, so it would be published unseen`);
    }
  }
  for (const s of sources) {
    const mode = (s as { participation_mode?: string }).participation_mode ?? "editorial";
    assert.ok(checkEnum("sources", "participation_mode").includes(mode), `${s.id}: participation_mode ${mode} is refused by the sources table`);
  }
});


/**
 * The report nameplates are generated by scripts/nameplates.ts and consumed across two files: the page
 * takes the sizing from index.json and pulls the two ink layers out of the svg by id. A regeneration that
 * forgets index.json crops the logotype, and an svg that loses a layer renders nothing at all. Neither is
 * visible to any other check, so the assets are checked against the site that imports them.
 */
const NAMEPLATE_KINDS = ["daily", "weekly", "monthly", "archive"];

test("the nameplates the page imports are the nameplates the pack sizes", () => {
  const page = readFileSync(new URL("../apps/web/app/features/report/Nameplate.tsx", import.meta.url), "utf8");
  const imported = [...new Set([...page.matchAll(/nameplates\/([a-z]+)\.svg/g)].map((m) => m[1]))].sort();
  const sizing = Object.keys(JSON.parse(pack("industry/brand/nameplates/index.json")) as Record<string, string>).sort();
  assert.deepEqual(imported, sizing, "an svg the page imports has no sizing entry, or one is sized but unused");
  assert.deepEqual([...NAMEPLATE_KINDS].sort(), sizing, "the report periods the site has pages for are the ones shipped");
});

test("every nameplate is generated, carries both ink layers, and agrees with its own viewBox", () => {
  const sizing = JSON.parse(pack("industry/brand/nameplates/index.json")) as Record<string, string>;
  for (const kind of NAMEPLATE_KINDS) {
    const svg = pack(`industry/brand/nameplates/${kind}.svg`);
    assert.ok(svg.startsWith("<!-- Generated by scripts/nameplates.ts"), `${kind}: a hand-edited logotype is lost on the next run`);
    // The page references these two ids and nothing else: a missing one is an invisible nameplate.
    assert.equal(svg.match(/id="accent"/g)?.length, 1, `${kind}: exactly one #accent layer`);
    assert.equal(svg.match(/id="ink"/g)?.length, 1, `${kind}: exactly one #ink layer`);
    assert.equal(/<svg[^>]*viewBox="([^"]+)"/.exec(svg)?.[1], sizing[kind], `${kind}: the svg's own box is what the page sizes it with`);
  }
});
