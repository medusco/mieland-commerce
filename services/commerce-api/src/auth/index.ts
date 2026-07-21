import * as jose from "jose";
import { createHmac } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import bcrypt from "bcryptjs";
import WPHash from "wordpress-hash-node";
import { loadConfig } from "../config.js";
import { getOption } from "../repositories/options.js";
import { query, queryOne, t } from "../db/mysql.js";
import { getRedis } from "../redis/client.js";
import { randomToken, toGlobalId } from "../utils/index.js";

export type LoginProviderSettings = {
  isEnabled?: boolean | string | number;
  clientOptions?: Record<string, unknown>;
  loginOptions?: Record<string, unknown>;
  name?: string;
};

export type AccessControlSettings = {
  allowedOrigins?: string[];
  customHeaders?: string[];
  shouldBlockUnauthorizedDomains?: boolean | string | number;
};

export type JwtSettings = {
  jwt_secret_key?: string;
  jwtSecretKey?: string;
};

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

export async function loadJwtSecret(): Promise<Uint8Array> {
  const cfg = loadConfig();
  if (cfg.JWT_SECRET) {
    return new TextEncoder().encode(cfg.JWT_SECRET);
  }
  const settings = await getOption<JwtSettings>("wpgraphql_login_settings");
  const secret =
    settings?.jwt_secret_key ||
    settings?.jwtSecretKey ||
    (typeof settings === "object" && settings
      ? (settings as Record<string, unknown>).jwt_secret_key
      : null);
  if (typeof secret === "string" && secret.length > 0) {
    return new TextEncoder().encode(secret);
  }
  if (!cfg.isProd) {
    return new TextEncoder().encode("dev-only-jwt-secret-change-me");
  }
  throw new Error("JWT secret not configured (wpgraphql_login_settings)");
}

export async function loadProvider(
  provider: string,
): Promise<LoginProviderSettings | null> {
  const opt = await getOption<LoginProviderSettings>(
    `wpgraphql_login_provider_${provider.toLowerCase()}`,
  );
  return opt;
}

export async function loadAccessControl(): Promise<AccessControlSettings | null> {
  return getOption<AccessControlSettings>("wpgraphql_login_access_control");
}

export async function loadCookieSettings(): Promise<Record<
  string,
  unknown
> | null> {
  return getOption("wpgraphql_login_cookies");
}

export type AuthUser = {
  id: number;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
};

export async function findUserByLoginOrEmail(
  login: string,
): Promise<(AuthUser & { user_pass: string }) | null> {
  const row = await queryOne<{
    ID: number;
    user_login: string;
    user_email: string;
    user_pass: string;
    display_name: string;
  }>(
    `SELECT ID, user_login, user_email, user_pass, display_name
     FROM ${t("users")}
     WHERE user_login = ? OR user_email = ?
     LIMIT 1`,
    [login, login],
  );
  if (!row) return null;
  const meta = await loadUserNames(row.ID);
  return {
    id: row.ID,
    email: row.user_email,
    username: row.user_login,
    firstName: meta.firstName,
    lastName: meta.lastName,
    displayName: row.display_name,
    user_pass: row.user_pass,
  };
}

export async function findUserById(id: number): Promise<AuthUser | null> {
  const row = await queryOne<{
    ID: number;
    user_login: string;
    user_email: string;
    display_name: string;
  }>(
    `SELECT ID, user_login, user_email, display_name FROM ${t("users")} WHERE ID = ? LIMIT 1`,
    [id],
  );
  if (!row) return null;
  const meta = await loadUserNames(row.ID);
  return {
    id: row.ID,
    email: row.user_email,
    username: row.user_login,
    firstName: meta.firstName,
    lastName: meta.lastName,
    displayName: row.display_name,
  };
}

async function loadUserNames(
  userId: number,
): Promise<{ firstName: string; lastName: string }> {
  const rows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value FROM ${t("usermeta")}
     WHERE user_id = ? AND meta_key IN ('first_name','last_name')`,
    [userId],
  );
  const map = Object.fromEntries(rows.map((r) => [r.meta_key, r.meta_value]));
  return {
    firstName: map.first_name ?? "",
    lastName: map.last_name ?? "",
  };
}

/**
 * WordPress 6.8+ bcrypt: HMAC-SHA384 (key wp-sha384) → base64 → password_hash.
 * Stored as `$wp` + `$2y$...`.
 */
function wp68Prehash(password: string): string {
  const digest = createHmac("sha384", "wp-sha384")
    .update(password.trim(), "utf8")
    .digest();
  return digest.toString("base64");
}

export function verifyWpPassword(password: string, hash: string): boolean {
  try {
    if (!hash) return false;

    // WP 6.8+ prefixed bcrypt
    if (hash.startsWith("$wp$")) {
      const bcryptHash = hash.slice(3); // drop "$wp"
      return bcrypt.compareSync(wp68Prehash(password), bcryptHash);
    }

    // Plain bcrypt (plugins / PASSWORD_BCRYPT without WP prefix)
    if (hash.startsWith("$2y$") || hash.startsWith("$2a$") || hash.startsWith("$2b$")) {
      return bcrypt.compareSync(password, hash);
    }

    // Legacy phpass ($P$ / $H$)
    return Boolean(WPHash.CheckPassword(password, hash));
  } catch {
    return false;
  }
}

export function hashWpPassword(password: string): string {
  // Match WP 6.8 default so new accounts verify with the same path
  const hashed = bcrypt.hashSync(wp68Prehash(password), 10);
  // bcryptjs emits $2a$; WP uses $2y$ — interchangeable for verify
  const normalized = hashed.replace(/^\$2a\$/, "$2y$");
  return `$wp${normalized}`;
}

const ACCESS_TTL = "1h";
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function issueTokens(user: AuthUser): Promise<{
  authToken: string;
  authTokenExpiration: string;
  refreshToken: string;
  refreshTokenExpiration: string;
}> {
  const secret = await loadJwtSecret();
  const now = Math.floor(Date.now() / 1000);
  const accessExp = now + 60 * 60;
  const refreshExp = now + REFRESH_TTL_SECONDS;

  const authToken = await new jose.SignJWT({
    sub: String(user.id),
    email: user.email,
    username: user.username,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(ACCESS_TTL)
    .sign(secret);

  const refreshSecret = randomToken(24);
  const redis = getRedis();
  await redis.set(
    `refresh:${user.id}:${refreshSecret}`,
    String(user.id),
    "EX",
    REFRESH_TTL_SECONDS,
  );

  const refreshToken = await new jose.SignJWT({
    sub: String(user.id),
    typ: "refresh",
    jti: refreshSecret,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(refreshExp)
    .sign(secret);

  return {
    authToken,
    authTokenExpiration: new Date(accessExp * 1000).toISOString(),
    refreshToken,
    refreshTokenExpiration: new Date(refreshExp * 1000).toISOString(),
  };
}

export async function verifyAccessToken(
  token: string,
): Promise<{ userId: number } | null> {
  try {
    const secret = await loadJwtSecret();
    const { payload } = await jose.jwtVerify(token, secret);
    if (payload.typ === "refresh") return null;
    const userId = Number(payload.sub);
    if (!userId) return null;
    return { userId };
  } catch {
    return null;
  }
}

export async function refreshAuthToken(refreshToken: string): Promise<{
  authToken: string;
  authTokenExpiration: string;
} | null> {
  try {
    const secret = await loadJwtSecret();
    const { payload } = await jose.jwtVerify(refreshToken, secret);
    if (payload.typ !== "refresh") return null;
    const userId = Number(payload.sub);
    const jti = String(payload.jti ?? "");
    if (!userId || !jti) return null;
    const redis = getRedis();
    const stored = await redis.get(`refresh:${userId}:${jti}`);
    if (stored !== String(userId)) return null;

    const user = await findUserById(userId);
    if (!user) return null;
    const tokens = await issueTokens(user);
    // rotate: delete old refresh
    await redis.del(`refresh:${userId}:${jti}`);
    return {
      authToken: tokens.authToken,
      authTokenExpiration: tokens.authTokenExpiration,
    };
  } catch {
    return null;
  }
}

export function toGraphqlUser(user: AuthUser) {
  return {
    id: toGlobalId("user", user.id),
    databaseId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    name: user.displayName || `${user.firstName} ${user.lastName}`.trim(),
  };
}

export async function loginWithGoogleCode(
  code: string,
  _state?: string | null,
): Promise<AuthUser> {
  const provider = await loadProvider("google");
  if (!provider || !truthy(provider.isEnabled)) {
    throw new Error("Google login is disabled");
  }
  const clientOpts = (provider.clientOptions ?? {}) as Record<string, string>;
  const loginOpts = (provider.loginOptions ?? {}) as Record<string, unknown>;
  const clientId = clientOpts.clientId || clientOpts.client_id;
  const clientSecret = clientOpts.clientSecret || clientOpts.client_secret;
  const redirectUri = clientOpts.redirectUri || clientOpts.redirect_uri;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is misconfigured");
  }

  const oauth = new OAuth2Client(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.id_token) throw new Error("Google did not return id_token");
  const ticket = await oauth.verifyIdToken({
    idToken: tokens.id_token,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error("Google account has no email");

  let user = await findUserByLoginOrEmail(payload.email);
  if (!user) {
    if (!truthy(loginOpts.createUserIfNoneExists)) {
      throw new Error("No account for this Google user");
    }
    const created = await createUser({
      email: payload.email,
      username: payload.email,
      password: randomToken(16),
      firstName: payload.given_name ?? "",
      lastName: payload.family_name ?? "",
    });
    user = { ...created, user_pass: "" };
  } else if (
    !truthy(loginOpts.linkExistingUsers) &&
    !truthy(loginOpts.createUserIfNoneExists)
  ) {
    // allow existing by default when linkExistingUsers not explicitly false
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
  };
}

export async function createUser(input: {
  email: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
}): Promise<AuthUser> {
  const existing = await findUserByLoginOrEmail(input.email);
  if (existing) throw new Error("An account with this email already exists");

  const hash = hashWpPassword(input.password);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const nicename = input.username
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 50);

  const { getPool } = await import("../db/mysql.js");
  const [result] = await getPool().execute(
    `INSERT INTO ${t("users")}
      (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_activation_key, user_status, display_name)
     VALUES (?, ?, ?, ?, '', ?, '', 0, ?)`,
    [
      input.username,
      hash,
      nicename,
      input.email,
      now,
      `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim() || input.username,
    ],
  );
  const insertId = Number((result as { insertId: number }).insertId);
  if (!insertId) throw new Error("Failed to create user");

  await setUserMeta(insertId, "first_name", input.firstName ?? "");
  await setUserMeta(insertId, "last_name", input.lastName ?? "");
  await setUserMeta(insertId, "nickname", input.username);
  await setUserMeta(
    insertId,
    `${loadConfig().tablePrefix}capabilities`,
    'a:1:{s:8:"customer";b:1;}',
  );
  await setUserMeta(insertId, `${loadConfig().tablePrefix}user_level`, "0");

  const created = await findUserById(insertId);
  if (!created) throw new Error("Failed to create user");
  return created;
}

export async function setUserMeta(
  userId: number,
  key: string,
  value: string,
): Promise<void> {
  const existing = await queryOne<{ umeta_id: number }>(
    `SELECT umeta_id FROM ${t("usermeta")} WHERE user_id = ? AND meta_key = ? LIMIT 1`,
    [userId, key],
  );
  if (existing) {
    await query(
      `UPDATE ${t("usermeta")} SET meta_value = ? WHERE umeta_id = ?`,
      [value, existing.umeta_id],
    );
  } else {
    await query(
      `INSERT INTO ${t("usermeta")} (user_id, meta_key, meta_value) VALUES (?, ?, ?)`,
      [userId, key, value],
    );
  }
}

export async function updateUserPassword(
  userId: number,
  password: string,
): Promise<void> {
  const hash = hashWpPassword(password);
  await query(`UPDATE ${t("users")} SET user_pass = ? WHERE ID = ?`, [
    hash,
    userId,
  ]);
}

export async function listEnabledLoginClients(): Promise<
  Array<{
    authorizationUrl: string | null;
    isEnabled: boolean;
    name: string;
    provider: string;
  }>
> {
  const providers = ["password", "google", "facebook", "github"];
  const out = [];
  for (const p of providers) {
    const settings = await loadProvider(p);
    if (!settings || !truthy(settings.isEnabled)) continue;
    const clientOpts = (settings.clientOptions ?? {}) as Record<string, string>;
    let authorizationUrl: string | null = null;
    if (p === "google") {
      const clientId = clientOpts.clientId || clientOpts.client_id;
      const redirectUri = clientOpts.redirectUri || clientOpts.redirect_uri;
      if (clientId && redirectUri) {
        const oauth = new OAuth2Client(clientId, undefined, redirectUri);
        authorizationUrl = oauth.generateAuthUrl({
          access_type: "offline",
          scope: ["openid", "email", "profile"],
          prompt: "select_account",
        });
      }
    }
    out.push({
      authorizationUrl,
      isEnabled: true,
      name: String(settings.name ?? p),
      provider: p.toUpperCase(),
    });
  }
  return out;
}
