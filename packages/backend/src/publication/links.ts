import { config } from "../config.ts";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string): string => `${config.siteUrl}${path}`;
export const itemUrl = (id: string): string => siteUrl(`/items/${id}`);
export const storyUrl = (publicId: string): string => siteUrl(`/story/${publicId}`);
export const dailyUrl = (date: string): string => siteUrl(`/daily/${date}`);
/** A weekly or monthly issue's own page; without a key it is the newest issue of that kind. */
export const reportUrl = (kind: "weekly" | "monthly", key?: string | null): string =>
  siteUrl(key ? `/${kind}/${key}` : `/${kind}`);
export const storyApiUrl = (publicId: string): string => siteUrl(`/api/v1/stories/${publicId}`);
