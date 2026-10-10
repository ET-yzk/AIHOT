// Corroboration (BR-22): when an event counts as established, decided at read time. Source tier,
// ownership and participation are all editable in the console, so a stored status would need a replay
// of every source on each change; deriving it lets a tier edit reach the hot list, the reports and every
// other outlet at once, exactly as the heat does (see events/hot.ts `currentSignals`). Which tiers speak
// with authority is the industry pack's to say — the platform never names a tier itself.
import { SELECTION } from "@aihot/industry/selection";

/** Sources that settle a fact on their own: BR-22's "T1 出现即采信". Compared against `sources.tier`. */
export const AUTHORITATIVE_TIERS: readonly string[] = SELECTION.corroboration.authoritativeTiers;

/**
 * An authoritative source is enough; anything else needs the parties to be independent and at least one
 * of them editorial. `minParticipants` stays with each caller because the two places that ask have always
 * wanted different counts: the hot list takes two, a daily's fill-in for a fact the editors missed takes
 * three discussions before it calls the event clearly news.
 */
export function isCorroborated(
  event: { authoritative: boolean; participants: number; editorialParticipants: number },
  minParticipants: number,
): boolean {
  return event.authoritative
    || (event.participants >= minParticipants && event.editorialParticipants >= 1);
}
