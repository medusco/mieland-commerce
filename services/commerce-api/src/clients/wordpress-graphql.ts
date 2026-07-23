import { loadConfig } from "../config.js";
import { logJson } from "../utils/index.js";

export type WpGraphqlLoginUser = {
  databaseId: number;
  id?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
};

export type WpGraphqlLoginResult = {
  authToken: string;
  authTokenExpiration: string | null;
  refreshToken: string | null;
  refreshTokenExpiration: string | null;
  sessionToken: string | null;
  user: WpGraphqlLoginUser;
  customer: {
    databaseId?: number | null;
    id?: string | null;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    sessionToken?: string | null;
  } | null;
  /** Cookie request header value (name=value; …). Empty if WP did not Set-Cookie. */
  cookieHeader: string;
  /** Suggested Redis TTL in seconds from cookie Max-Age/Expires. */
  cookieTtlSeconds: number;
};

export type WpGraphqlRefreshResult = {
  authToken: string | null;
  authTokenExpiration: string | null;
  refreshToken: string | null;
  refreshTokenExpiration: string | null;
  success: boolean;
};

type GraphqlError = { message?: string };

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: GraphqlError[];
};

const LOGIN_MUTATION = `
mutation Login($input: LoginInput!) {
  login(input: $input) {
    authToken
    authTokenExpiration
    refreshToken
    refreshTokenExpiration
    sessionToken
    customer {
      email
      firstName
      databaseId
      id
      lastName
      username
      sessionToken
    }
    user {
      id
      databaseId
      email
      firstName
      lastName
      username
    }
  }
}
`;

const REFRESH_MUTATION = `
mutation RefreshAuthToken($input: RefreshTokenInput!) {
  refreshToken(input: $input) {
    authToken
    authTokenExpiration
    refreshToken
    refreshTokenExpiration
    success
  }
}
`;

const DEFAULT_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const AUTH_COOKIE_NAME_RE =
  /^(wordpress_logged_in_|wordpress_sec_|wordpress_[a-f0-9]|woocommerce_session_|woocommerce_)/i;

function graphqlUrl(): string {
  const cfg = loadConfig();
  return `${cfg.WORDPRESS_URL.replace(/\/$/, "")}/graphql`;
}

/** Collect raw Set-Cookie header values (Node fetch may join; also try getSetCookie). */
function collectSetCookieHeaders(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    const list = anyHeaders.getSetCookie();
    if (list?.length) return list;
  }
  const single = headers.get("set-cookie");
  if (!single) return [];
  // Split joined Set-Cookie when commas appear between cookies (not inside Expires).
  return splitSetCookieHeader(single);
}

function splitSetCookieHeader(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const segment of raw.split(/,(?=\s*[^;=]+=[^;]+)/)) {
    if (!current) {
      current = segment;
      continue;
    }
    // Expires=Wed, 21-Oct-2015 … — keep attached to previous
    if (/^\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(segment)) {
      current += `,${segment}`;
    } else {
      parts.push(current.trim());
      current = segment;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export type ParsedAuthCookies = {
  cookieHeader: string;
  ttlSeconds: number;
};

/**
 * Turn Set-Cookie headers into a Cookie request header, keeping WP/Woo auth cookies.
 * Also computes a TTL from Max-Age / Expires (minimum across cookies, floored).
 */
export function parseAuthCookiesFromSetCookie(
  setCookies: string[],
): ParsedAuthCookies {
  const pairs: Array<{ name: string; value: string }> = [];
  let ttlSeconds = DEFAULT_COOKIE_TTL_SECONDS;
  const now = Date.now();

  for (const raw of setCookies) {
    const first = raw.split(";")[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!AUTH_COOKIE_NAME_RE.test(name)) continue;
    pairs.push({ name, value });

    const attrs = raw.slice(first.length);
    const maxAge = attrs.match(/;\s*Max-Age=(\d+)/i);
    if (maxAge) {
      const n = Number(maxAge[1]);
      if (Number.isFinite(n) && n > 0) ttlSeconds = Math.min(ttlSeconds, n);
    }
    const expires = attrs.match(/;\s*Expires=([^;]+)/i);
    if (expires) {
      const t = Date.parse(expires[1].trim());
      if (Number.isFinite(t) && t > now) {
        const secs = Math.floor((t - now) / 1000);
        if (secs > 0) ttlSeconds = Math.min(ttlSeconds, secs);
      }
    }
  }

  // Deduplicate by name (last wins)
  const byName = new Map<string, string>();
  for (const p of pairs) byName.set(p.name, p.value);
  const cookieHeader = [...byName.entries()]
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");

  return {
    cookieHeader,
    ttlSeconds: Math.max(60, ttlSeconds),
  };
}

function firstGraphqlError(errors: GraphqlError[] | undefined): string {
  const msg = errors?.[0]?.message?.trim();
  return msg || "WordPress login failed";
}

async function postGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  logMsg: string,
  opts?: { origin?: string | null },
): Promise<{ body: GraphqlEnvelope<T>; setCookies: string[] }> {
  const cfg = loadConfig();
  const url = graphqlUrl();
  const started = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // WP Headless Login access control checks Origin against allowedOrigins.
  const origin =
    opts?.origin?.trim() ||
    cfg.corsOrigins.find((o) => o && o !== "*") ||
    "";
  if (origin) {
    headers.Origin = origin;
    headers.Referer = origin.endsWith("/") ? origin : `${origin}/`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(cfg.WC_REST_TIMEOUT_MS),
  });
  const setCookies = collectSetCookieHeaders(res.headers);
  const text = await res.text();
  let body: GraphqlEnvelope<T>;
  try {
    body = JSON.parse(text) as GraphqlEnvelope<T>;
  } catch {
    body = { errors: [{ message: text.slice(0, 200) }] };
  }
  logJson("info", {
    msg: logMsg,
    status: res.status,
    ms: Date.now() - started,
    hasSetCookie: setCookies.length > 0,
    hasErrors: Boolean(body.errors?.length),
    hasOrigin: Boolean(origin),
  });
  if (!res.ok && !body.data) {
    throw new Error(
      firstGraphqlError(body.errors) || `WP GraphQL ${res.status}`,
    );
  }
  return { body, setCookies };
}

function requireUserId(
  user: WpGraphqlLoginUser | null | undefined,
  customer: { databaseId?: number | null } | null | undefined,
): number {
  const id = Number(user?.databaseId ?? customer?.databaseId ?? 0);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("WordPress login response missing user id");
  }
  return id;
}

export async function wpGraphqlLogin(input: {
  provider: string;
  credentials?: { username: string; password: string };
  oauthResponse?: { code: string; state?: string };
  /** Shop request Origin — required by WP Headless Login access control. */
  origin?: string | null;
}): Promise<WpGraphqlLoginResult> {
  const provider = String(input.provider).toUpperCase();
  const loginInput: Record<string, unknown> = { provider };
  if (provider === "PASSWORD") {
    if (!input.credentials) throw new Error("credentials required");
    loginInput.credentials = {
      username: input.credentials.username,
      password: input.credentials.password,
    };
  } else {
    if (!input.oauthResponse?.code) {
      throw new Error("oauthResponse.code required");
    }
    loginInput.oauthResponse = {
      code: input.oauthResponse.code,
      state: input.oauthResponse.state,
    };
  }

  const { body, setCookies } = await postGraphql<{
    login: {
      authToken?: string | null;
      authTokenExpiration?: string | null;
      refreshToken?: string | null;
      refreshTokenExpiration?: string | null;
      sessionToken?: string | null;
      user?: WpGraphqlLoginUser | null;
      customer?: WpGraphqlLoginResult["customer"];
    } | null;
  }>(LOGIN_MUTATION, { input: loginInput }, "wp_graphql_login", {
    origin: input.origin,
  });

  if (body.errors?.length && !body.data?.login?.authToken) {
    const msg = firstGraphqlError(body.errors);
    if (/invalid|incorrect|password|credentials|unauthorized/i.test(msg)) {
      throw new Error("Invalid username or password");
    }
    throw new Error(msg);
  }

  const login = body.data?.login;
  if (!login?.authToken) {
    throw new Error(firstGraphqlError(body.errors));
  }

  const user = login.user;
  const customer = login.customer ?? null;
  const databaseId = requireUserId(user ?? undefined, customer);
  const { cookieHeader, ttlSeconds } = parseAuthCookiesFromSetCookie(setCookies);

  return {
    authToken: login.authToken,
    authTokenExpiration: login.authTokenExpiration ?? null,
    refreshToken: login.refreshToken ?? null,
    refreshTokenExpiration: login.refreshTokenExpiration ?? null,
    sessionToken: login.sessionToken ?? null,
    user: {
      databaseId,
      id: user?.id ?? null,
      email: user?.email ?? customer?.email ?? null,
      firstName: user?.firstName ?? customer?.firstName ?? null,
      lastName: user?.lastName ?? customer?.lastName ?? null,
      username: user?.username ?? customer?.username ?? null,
    },
    customer,
    cookieHeader,
    cookieTtlSeconds: ttlSeconds,
  };
}

export async function wpGraphqlRefreshToken(
  refreshToken: string,
  opts?: { origin?: string | null },
): Promise<WpGraphqlRefreshResult> {
  const { body } = await postGraphql<{
    refreshToken: {
      authToken?: string | null;
      authTokenExpiration?: string | null;
      refreshToken?: string | null;
      refreshTokenExpiration?: string | null;
      success?: boolean | null;
    } | null;
  }>(
    REFRESH_MUTATION,
    { input: { refreshToken } },
    "wp_graphql_refresh_token",
    { origin: opts?.origin },
  );

  const payload = body.data?.refreshToken;
  if (body.errors?.length && !payload?.authToken) {
    return {
      authToken: null,
      authTokenExpiration: null,
      refreshToken: null,
      refreshTokenExpiration: null,
      success: false,
    };
  }

  return {
    authToken: payload?.authToken ?? null,
    authTokenExpiration: payload?.authTokenExpiration ?? null,
    refreshToken: payload?.refreshToken ?? null,
    refreshTokenExpiration: payload?.refreshTokenExpiration ?? null,
    success: Boolean(payload?.success ?? payload?.authToken),
  };
}
