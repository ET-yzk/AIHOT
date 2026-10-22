// Reader subscriptions: the first-party site API under /api/subscriptions. Not part of the public v1
// interface; it may change with the website. The page (apps/web) and the api share these shapes.
import type { ReportKind } from "./site.ts";

/** The signed-in reader, as the page shows them. */
export interface ReaderUserView {
  name: string | null;
  avatarUrl: string | null;
}

export type SubscriptionScope = "all" | "categories" | "topics";

/** One reader's subscription: one row per reader, every kind it asks for, and the content it narrows to. */
export interface SubscriptionView {
  enabled: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  scope: SubscriptionScope;
  /** Category keys; only read when scope is "categories". */
  categories: string[];
  /** Topic slugs; only read when scope is "topics". */
  topics: string[];
  updatedAt: string | null;
}

/** What the page saves; the server stores it as is after checking the keys against the industry pack. */
export interface SubscriptionInput {
  enabled: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  scope: SubscriptionScope;
  categories: string[];
  topics: string[];
}

export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "unknown";

/** One push of one issue, as the reader sees it under 最近推送. */
export interface DeliveryView {
  kind: ReportKind;
  reportKey: string;
  status: DeliveryStatus;
  /** Why it failed or was skipped; null while it is still waiting. */
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  /** The issue's page, so the reader can open what was pushed. */
  reportUrl: string;
}

/** GET /api/subscriptions/me */
export interface ReaderMe {
  user: ReaderUserView;
  /** Null until the reader saves the first time. */
  subscription: SubscriptionView | null;
  deliveries: DeliveryView[];
  /** Writes send this as x-csrf-token. */
  csrf: string;
}

export interface SubscriptionCategoryOption {
  key: string;
  label: string;
  tagColor: string;
}

export interface SubscriptionTopicOption {
  slug: string;
  name: string;
  group: string;
}

export interface SubscriptionGroupOption {
  key: string;
  name: string;
}

/** GET /api/subscriptions/options: what the page can offer, and whether sign-in is configured at all. */
export interface SubscriptionOptions {
  categories: SubscriptionCategoryOption[];
  topics: SubscriptionTopicOption[];
  groups: SubscriptionGroupOption[];
  loginConfigured: boolean;
}

/**
 * POST /api/subscriptions/suggest: counts over the reader's local favourites. The ids are used for this
 * one answer and never stored.
 */
export interface FavoriteSuggestion {
  /** Favourites that still have a page and a known category or topic. */
  total: number;
  categories: Array<{ key: string; label: string; count: number }>;
  topics: Array<{ slug: string; name: string; group: string; count: number }>;
}
