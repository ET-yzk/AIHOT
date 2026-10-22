// The Feishu cards readers receive: one issue, or a test message. Report text is frozen in the issue and
// escaped here (its model-written words go into card markdown); links use the same absolute addresses as
// every other exit.
import type { ReportKind } from "@aihot/contracts/site";
import { REPORT_NAMES } from "@aihot/contracts/site";
import { itemUrl } from "@aihot/backend/publication/links";

/** One entry a report carries, as the card needs it. */
export interface CardEntry {
  itemId: string;
  title: string;
  summary: string | null;
  sourceName: string;
}

export interface CardInput {
  kind: ReportKind;
  key: string;
  siteName: string;
  /** The issue's written lead, or the quiet sentence; null for a filtered card. */
  lead: { title: string; paragraph: string | null } | null;
  /** Already filtered and limited by the caller. */
  entries: CardEntry[];
  /** True for a category/topic subscription: the intro counts matches instead of showing the issue lead. */
  filtered: boolean;
  totalMatches: number;
  reportUrl: string;
  subscriptionsUrl: string;
}

/** Model-written words go into card markdown: its markup characters are shown as written. */
const literal = (text: string) => text.replace(/[&<>*_~`[\]]/g, (c) => `&#${c.charCodeAt(0)};`);

const link = (label: string, url: string, type: string) => ({
  tag: "column", width: "auto",
  elements: [{ tag: "button", text: { tag: "plain_text", content: label }, type, behaviors: [{ type: "open_url", default_url: url }] }],
});

/** Card JSON 2.0: a header title has one fixed size, so the title is the first body line. */
function shell(elements: unknown[]) {
  return {
    schema: "2.0",
    config: { style: { text_size: { title: { default: "heading-3", pc: "heading-3", mobile: "heading-4" } } } },
    body: { elements },
  };
}

export function reportCard(input: CardInput): unknown {
  const title = `${input.siteName} ${REPORT_NAMES[input.kind]} · ${input.key}`;
  const elements: unknown[] = [
    { tag: "markdown", text_size: "title", content: `**${literal(title)}**` },
  ];
  if (input.filtered) {
    elements.push({ tag: "markdown", text_size: "notation", content: `<font color='grey'>你订阅的内容这一期有 ${input.totalMatches} 条</font>` });
  } else if (input.lead) {
    elements.push({ tag: "markdown", content: `**${literal(input.lead.title)}**` });
    if (input.lead.paragraph) elements.push({ tag: "markdown", content: literal(input.lead.paragraph) });
  }
  if (input.entries.length > 0) {
    const lines = input.entries.map((e, i) => {
      const source = e.sourceName ? ` · ${literal(e.sourceName)}` : "";
      return `${i + 1}. [${literal(e.title)}](${itemUrl(e.itemId)})${source}`;
    });
    elements.push({ tag: "markdown", content: lines.join("\n") });
  }
  elements.push({
    tag: "column_set", horizontal_spacing: "8px",
    columns: [link("阅读整期", input.reportUrl, "primary"), link("订阅管理", input.subscriptionsUrl, "default")],
  });
  elements.push({ tag: "markdown", text_size: "notation", content: `<font color='grey'>由 ${literal(input.siteName)} 发送；在订阅管理里可以关掉。</font>` });
  return shell(elements);
}

export function testCard(siteName: string, subscriptionsUrl: string): unknown {
  return shell([
    { tag: "markdown", text_size: "title", content: `**${literal(`${siteName} 飞书推送测试`)}**` },
    { tag: "markdown", content: "这条消息说明推送已经接通。订阅的日报、周报会发到这个单聊。" },
    { tag: "column_set", horizontal_spacing: "8px", columns: [link("打开订阅管理", subscriptionsUrl, "primary")] },
    { tag: "markdown", text_size: "notation", content: "<font color='grey'>如果你没有订阅，可以忽略这条消息。</font>" },
  ]);
}

// ---------------------------------------------------------------------------------------------------
// Reading an issue's frozen content.

export interface ReportLead {
  title: string;
  paragraph: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The entries an issue cites, in its own order: a daily's sections, a weekly's or monthly's themes. */
export function reportEntries(content: Record<string, unknown>, kind: ReportKind): CardEntry[] {
  const groups = kind === "daily" ? content.sections : content.themes;
  if (!Array.isArray(groups)) return [];
  const out: CardEntry[] = [];
  for (const group of groups) {
    const list = kind === "daily" ? (group as { items?: unknown })?.items : (group as { storyRefs?: unknown })?.storyRefs;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const it = raw as { itemId?: unknown; title?: unknown; summary?: unknown; sourceName?: unknown };
      const itemId = text(it?.itemId);
      const title = text(it?.title);
      if (!itemId || !title) continue;
      out.push({ itemId, title, summary: text(it?.summary), sourceName: text(it?.sourceName) ?? "" });
    }
  }
  return out;
}

/** The issue's written lead, its quiet sentence, or (periodic) its headline and overview. */
export function reportLead(content: Record<string, unknown>, kind: ReportKind): ReportLead | null {
  const lead = content.lead as { title?: unknown; leadParagraph?: unknown } | null;
  const leadTitle = text(lead?.title);
  if (leadTitle) return { title: leadTitle, paragraph: text(lead?.leadParagraph) };
  const headline = text(content.headline);
  const overview = text(content.overview);
  if (headline || overview) return { title: headline ?? REPORT_NAMES[kind], paragraph: overview };
  const title = text(content.title);
  return title ? { title, paragraph: overview } : null;
}

/** The item the issue leads with, when it names one (the card shows it as the lead, not again in the list). */
export function leadItemId(content: Record<string, unknown>): string | null {
  return text(content.leadItemId);
}
