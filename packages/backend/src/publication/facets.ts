// The category, tags, topics and page availability of items by id, read once for the subscription
// module's recommendations and its filtering of a report's entries. Topics use the same membership rule
// as the topic pages, so a reader's choice means what the topic page means.
import type { CategoryKey } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { hasItemPage } from "./rules.ts";
import { topicMembership } from "./topics.ts";

export interface ItemFacet {
  id: string;
  category: CategoryKey | null;
  tags: string[];
  /** Topic slugs, in the topic directory's order. */
  topics: string[];
  /** The item still has a page (summary-only included); a withdrawn item does not. */
  available: boolean;
}

/**
 * Facets for up to 500 ids, one query. Ids that are absent (never published, or pruned) are absent from
 * the map; the caller decides what an absent id means.
 */
export async function itemFacets(ids: readonly string[]): Promise<Map<string, ItemFacet>> {
  const clean = [...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 500);
  const out = new Map<string, ItemFacet>();
  if (clean.length === 0) return out;
  const rows = await sql<{ id: string; category: CategoryKey | null; tags: string[]; topics: string[]; visibility: string; source_mode: string }[]>`
    SELECT p.article_id AS id, p.category, p.tags, ${topicMembership()} AS topics, p.visibility, s.participation_mode AS source_mode
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id IN ${sql(clean)}`;
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      category: r.category,
      tags: r.tags,
      topics: r.topics,
      available: hasItemPage({ visibility: r.visibility, sourceMode: r.source_mode }),
    });
  }
  return out;
}
