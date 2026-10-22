// Reader identity: Feishu OAuth (the same passport app the admin sign-in uses), an opaque session cookie
// kept hashed in reader_sessions, and the small cookie/state helpers. The module owns its own session so
// the admin's identity and allowlist stay untouched.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";

export const SESSION_COOKIE = "aihot_reader";
export const STATE_COOKIE = "aihot_reader_state";
export const SESSION_DAYS = 30;
const PASSPORT = "https://passport.feishu.cn";
const CALLBACK_PATH = "/api/subscriptions/auth/callback";

/** The Feishu profile fields the reader session needs; every one but the ids may be missing. */
export interface FeishuProfile {
  unionId: string | null;
  openId: string | null;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** A signed-in reader as the api reads it from the cookie. */
export interface ReaderIdentity {
  userId: number;
  csrf: string;
  name: string | null;
  avatarUrl: string | null;
  unionId: string | null;
  openId: string | null;
}

export class LoginRejected extends Error {}

/** Reader sign-in is offered only when the login app is configured; it may be the message app too. */
export function readerLoginConfigured(): boolean {
  return !!credential("integrations", "FEISHU_LOGIN_APP_ID") && !!credential("integrations", "FEISHU_LOGIN_APP_SECRET");
}

/** Register this callback in the Feishu open platform when reader sign-in is used. */
export function callbackUrl(): string {
  return `${config.siteUrl}${CALLBACK_PATH}`;
}

function secret(): string {
  const s = credential("auth", "SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

function sign(value: string): string {
  return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`;
}

function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value).slice(i + 1));
  const given = Buffer.from(signed.slice(i + 1));
  return expected.length === given.length && timingSafeEqual(expected, given) ? value : null;
}

/** A cookie header may carry malformed values from anywhere; one bad value must not break sign-in. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Other cookies need not be URI-encoded.
    }
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Cookies are Secure whenever the site is served over HTTPS. */
export const secureCookies = () => config.siteUrl.startsWith("https://");

/** Only subscription paths on this site; anything else (other hosts, protocol-relative) falls back there. */
export function safeReturn(target: string): string {
  let path = target;
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    } catch {
      return "/subscriptions";
    }
  }
  return /^\/subscriptions(\/|\?|$)/.test(path) && !path.startsWith("//") ? path : "/subscriptions";
}

/** Where to send the browser to sign in; the signed state also carries where to return. */
export function loginRedirect(returnTo: string): { url: string; stateCookie: string } {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId) throw new Error("FEISHU_LOGIN_APP_ID is not configured");
  const state = `${randomBytes(16).toString("base64url")}|${safeReturn(returnTo)}`;
  const url = `${PASSPORT}/suite/passport/oauth/authorize?${new URLSearchParams({
    client_id: appId, redirect_uri: callbackUrl(), response_type: "code", state: sign(state),
  })}`;
  return { url, stateCookie: sign(state) };
}

/** JSON decoding errors may quote response bytes, which are private authentication data. */
async function json<T>(response: Response, step: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Feishu ${step} response is not valid JSON (HTTP ${response.status})`);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Exchange the authorization code and read the profile. Network and configuration failures throw. */
export async function feishuProfile(code: string): Promise<FeishuProfile> {
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  const appSecret = credential("integrations", "FEISHU_LOGIN_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu login app is not configured");
  const tokenRes = await fetch(`${PASSPORT}/suite/passport/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: callbackUrl() }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = await json<{ access_token?: string }>(tokenRes, "token");
  if (!token.access_token) throw new Error(`Feishu token exchange failed (HTTP ${tokenRes.status})`);
  const userRes = await fetch(`${PASSPORT}/suite/passport/oauth/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const u = await json<Record<string, unknown>>(userRes, "profile");
  const email = text(u.enterprise_email) ?? text(u.email);
  return {
    unionId: text(u.union_id),
    openId: text(u.open_id),
    email: email?.toLowerCase() ?? null,
    name: text(u.name),
    avatarUrl: text(u.avatar_url) ?? text(u.picture),
  };
}

/** The session is bound to the login app and the user, so rotating the secret or changing the app signs readers out. */
function sessionBinding(appId: string, userId: number): string {
  return createHmac("sha256", secret()).update(JSON.stringify(["reader-session-v1", appId, userId])).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function createSession(userId: number, appId: string, userAgent: string | undefined): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`INSERT INTO reader_sessions (id_hash, user_id, csrf_token, auth_binding, expires_at, user_agent)
            VALUES (${sha256(token)}, ${userId}, ${randomBytes(18).toString("base64url")}, ${sessionBinding(appId, userId)},
                    ${new Date(Date.now() + SESSION_DAYS * 86400_000)}, ${userAgent?.slice(0, 300) ?? null})`;
  return token;
}

/** Upsert the reader by union_id, then email, and start a session. Exported for tests without the network. */
export async function loginWithProfile(profile: FeishuProfile, appId: string, userAgent: string | undefined): Promise<{ token: string; userId: number }> {
  if (!profile.unionId && !profile.email) throw new LoginRejected("飞书没有返回可用的账号标识");
  const [existing] = await sql<{ id: number }[]>`
    SELECT id FROM reader_users
    WHERE (${profile.unionId}::text IS NOT NULL AND feishu_union_id = ${profile.unionId})
       OR (${profile.email}::text IS NOT NULL AND email = ${profile.email})
    LIMIT 1`;
  const [user] = existing
    ? await sql<{ id: number }[]>`UPDATE reader_users SET
        feishu_open_id = coalesce(${profile.openId}, feishu_open_id),
        email = coalesce(email, ${profile.email}),
        display_name = coalesce(${profile.name}, display_name),
        avatar_url = coalesce(${profile.avatarUrl}, avatar_url),
        last_login_at = now()
      WHERE id = ${existing.id} RETURNING id`
    : await sql<{ id: number }[]>`INSERT INTO reader_users (feishu_union_id, feishu_open_id, email, display_name, avatar_url)
        VALUES (${profile.unionId}, ${profile.openId}, ${profile.email}, ${profile.name}, ${profile.avatarUrl}) RETURNING id`;
  const token = await createSession(user!.id, appId, userAgent);
  return { token, userId: user!.id };
}

/** OAuth callback: verify the state, identify the Feishu user, start a reader session. */
export async function completeLogin(code: string, state: string, stateCookie: string | undefined, userAgent: string | undefined): Promise<{ token: string; returnTo: string }> {
  const expected = unsign(stateCookie);
  const given = unsign(state);
  if (!expected || !given || expected !== given) throw new LoginRejected("登录状态已失效，请重新登录");
  const returnTo = safeReturn(given.split("|")[1] ?? "/subscriptions");
  const profile = await feishuProfile(code);
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId) throw new Error("FEISHU_LOGIN_APP_ID is not configured");
  const { token } = await loginWithProfile(profile, appId, userAgent);
  return { token, returnTo };
}

/** The reader behind the cookie; a session whose binding no longer holds is deleted, not trusted. */
export async function sessionReader(cookieHeader: string | undefined): Promise<ReaderIdentity | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const [row] = await sql<{
    user_id: number; csrf_token: string; auth_binding: string;
    display_name: string | null; avatar_url: string | null; feishu_union_id: string | null; feishu_open_id: string | null;
  }[]>`
    SELECT s.user_id, s.csrf_token, s.auth_binding, u.display_name, u.avatar_url, u.feishu_union_id, u.feishu_open_id
    FROM reader_sessions s JOIN reader_users u ON u.id = s.user_id
    WHERE s.id_hash = ${sha256(token)} AND s.expires_at > now()`;
  if (!row) return null;
  const appId = credential("integrations", "FEISHU_LOGIN_APP_ID");
  if (!appId || !sameHex(row.auth_binding, sessionBinding(appId, row.user_id))) {
    await sql`DELETE FROM reader_sessions WHERE id_hash = ${sha256(token)}`;
    return null;
  }
  return {
    userId: row.user_id, csrf: row.csrf_token, name: row.display_name, avatarUrl: row.avatar_url,
    unionId: row.feishu_union_id, openId: row.feishu_open_id,
  };
}

export async function endSession(cookieHeader: string | undefined): Promise<void> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await sql`DELETE FROM reader_sessions WHERE id_hash = ${sha256(token)}`;
}

/** Delete the reader and everything that hangs off it (sessions, subscription, deliveries). */
export async function deleteReader(userId: number): Promise<void> {
  await sql`DELETE FROM reader_users WHERE id = ${userId}`;
}
