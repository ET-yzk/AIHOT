// The industry pack is the only thing that changes when this framework is pointed at another industry,
// so its internal contradictions are worth checking on their own: a source configured with a key its
// kind does not implement is silently ignored (menus as articles, dates never found), and a tag or a
// category no prompt can produce leaves a filter that never matches. No database, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("every source in the pack is configured with keys its own kind implements", () => {
  const { sources } = JSON.parse(pack("industry/sources.json")) as {
    sources: Array<{ id: string; name: string; kind: Parameters<typeof unsupportedConfig>[0]; tier?: string; owner_entity_id?: string | null; config: Record<string, unknown> }>;
  };
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

  for (const [id, entity] of Object.entries(ENTITIES)) {
    if (entity.displayTag) assert.ok(ENTITY_TAGS.includes(entity.displayTag as (typeof ENTITY_TAGS)[number]), `${id} shows ${entity.displayTag}, which is not an entity tag`);
    assert.ok(entity.aliases.length > 0, `${id}: an entity needs the writings that match it`);
  }
  for (const entry of IDENTITY_LEXICON) {
    assert.ok(entry.id in ENTITIES, `the lexicon names ${entry.id}, which the pack has no entity for`);
    assert.ok(entry.patterns.length > 0, `${entry.id}: nothing to match`);
  }
});
