/**
 * Auth OAuth (Google & Discord) via Supabase GoTrue — flux PKCE côté serveur.
 *
 * Module pur (aucun import TanStack, aucune dépendance externe) : configuration,
 * PKCE S256, anti-open-redirect, cookies de session `HttpOnly` et mapping des
 * erreurs GoTrue. Les handlers HTTP vivent dans `auth-server.ts`.
 * Réf. : docs/01 §2.1, docs/04 §3, docs/06 §1.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AccountLinkError,
  isLoginError,
  isOAuthProvider,
  LOGIN_ERRORS,
  LOGIN_PATH,
  type LoginError,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  sanitizeRedirectPath,
} from "./auth-shared.ts";

export type { AccountLinkError, LoginError, OAuthProvider };
export {
  isLoginError,
  isOAuthProvider,
  LOGIN_ERRORS,
  LOGIN_PATH,
  OAUTH_PROVIDERS,
  sanitizeRedirectPath,
};

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Scopes minimaux (docs/04 §3). */
export const OAUTH_SCOPES: Readonly<Record<OAuthProvider, string>> = {
  google: "openid email profile",
  discord: "identify email",
};

export const PKCE_COOKIE = "pv_pkce";
export const ACCESS_TOKEN_COOKIE = "pv_access_token";
export const REFRESH_TOKEN_COOKIE = "pv_refresh_token";

export const PKCE_COOKIE_PATH = "/api/auth";
export const PKCE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
export const ACCESS_TOKEN_DEFAULT_MAX_AGE_SECONDS = 60 * 60;
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const AUTH_CALLBACK_PATH = "/api/auth/callback";
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type Env = Readonly<Record<string, string | undefined>>;

export interface AuthConfig {
  /** URL de GoTrue vue par le navigateur (via Caddy), sans slash final. */
  readonly publicUrl: string;
  /**
   * Base GoTrue pour les appels serveur-à-serveur, sans slash final.
   * Docker : `http://auth:9999` (GoTrue sert à la racine) ; via Caddy / dev :
   * `http://localhost:54321/auth/v1`.
   */
  readonly internalAuthBase: string;
  readonly anonKey: string;
  /** Origine publique de l'app (`APP_URL` / `SITE_URL`) si configurée. */
  readonly appUrl: string | undefined;
  readonly isProduction: boolean;
}

const DEFAULT_PUBLIC_URL = "http://localhost:54321";

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

export const readAuthConfig = (env: Env = process.env): AuthConfig => {
  const publicUrl = stripTrailingSlashes(clean(env["SUPABASE_PUBLIC_URL"]) ?? DEFAULT_PUBLIC_URL);
  const internal = clean(env["SUPABASE_INTERNAL_AUTH_URL"]);
  const appUrl = clean(env["APP_URL"]) ?? clean(env["SITE_URL"]);
  return {
    publicUrl,
    // La variable désigne la base GoTrue telle quelle (avec ou sans `/auth/v1`).
    internalAuthBase:
      internal === undefined ? `${publicUrl}/auth/v1` : stripTrailingSlashes(internal),
    anonKey: clean(env["SUPABASE_ANON_KEY"]) ?? "",
    appUrl: appUrl === undefined ? undefined : stripTrailingSlashes(appUrl),
    isProduction: env["NODE_ENV"] === "production",
  };
};

/**
 * Origine de l'app pour `redirect_to` : `APP_URL` / `SITE_URL`, sinon (prod)
 * l'URL publique Supabase — même origine derrière Caddy —, sinon l'origine de
 * la requête (dev).
 */
export const resolveAppOrigin = (config: AuthConfig, requestUrl: string): string => {
  if (config.appUrl !== undefined) return new URL(config.appUrl).origin;
  if (config.isProduction) return new URL(config.publicUrl).origin;
  return new URL(requestUrl).origin;
};

/** `Secure` si l'app est servie en HTTPS (ou en production). */
export const isSecureContext = (config: AuthConfig, appOrigin: string): boolean =>
  config.isProduction || appOrigin.startsWith("https://");

// ---------------------------------------------------------------------------
// PKCE (S256) & anti-open-redirect
// ---------------------------------------------------------------------------

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  /** Jeton CSRF aléatoire, vérifié au retour du callback. */
  readonly state: string;
}

export const codeChallengeFor = (codeVerifier: string): string =>
  createHash("sha256").update(codeVerifier).digest("base64url");

export const generatePkcePair = (): PkcePair => {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: codeChallengeFor(codeVerifier),
    state: randomBytes(16).toString("base64url"),
  };
};

/** Comparaison temps constant pour les jetons CSRF (`state`). */
export const safeTokenEqual = (candidate: string | null | undefined, expected: string): boolean => {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Vérifie que les en-têtes `Origin` (ou à défaut `Referer`) d'une requête
 * mutante (`POST /api/auth/logout`) correspondent à l'origine attendue.
 * Si aucun des deux n'est présent (ex. client serveur / curl), la requête passe.
 */
export const isRequestSameOrigin = (request: Request, expectedOrigin: string): boolean => {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (referer === null) return true;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// URL d'autorisation
// ---------------------------------------------------------------------------

export interface AuthorizeUrlInput {
  readonly provider: OAuthProvider;
  readonly appOrigin: string;
  readonly pkce: PkcePair;
}

/** `redirect_to` porte le `state` CSRF (GoTrue ne le renvoie pas autrement). */
export const buildCallbackUrl = (appOrigin: string, state: string): string =>
  `${appOrigin}${AUTH_CALLBACK_PATH}?${new URLSearchParams({ state }).toString()}`;

export const buildAuthorizeUrl = (config: AuthConfig, input: AuthorizeUrlInput): string => {
  const params = new URLSearchParams({
    provider: input.provider,
    redirect_to: buildCallbackUrl(input.appOrigin, input.pkce.state),
    code_challenge: input.pkce.codeChallenge,
    code_challenge_method: "s256",
    scopes: OAUTH_SCOPES[input.provider],
  });
  // Permet de choisir un autre compte Google après un refus d'invitation.
  if (input.provider === "google") params.set("prompt", "select_account");
  return `${config.publicUrl}/auth/v1/authorize?${params.toString()}`;
};

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export interface CookieOptions {
  readonly path: string;
  readonly maxAge: number;
  readonly secure: boolean;
}

export const serializeCookie = (name: string, value: string, options: CookieOptions): string => {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
};

export const expireCookie = (name: string, path: string, secure: boolean): string =>
  serializeCookie(name, "", { path, maxAge: 0, secure });

export const parseCookies = (
  header: string | null | undefined,
): Readonly<Record<string, string>> => {
  const cookies: Record<string, string> = {};
  if (header === null || header === undefined) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== "" && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
};

/** `login` : connexion initiale (09A) ; `link` : liaison d'un provider depuis 09B. */
export type PkceFlowMode = "login" | "link";

export interface PkceCookiePayload {
  readonly verifier: string;
  readonly state: string;
  readonly redirectTo: string;
  /** Absent des anciens cookies : traité comme `login`. */
  readonly mode?: PkceFlowMode | undefined;
}

export const encodePkceCookie = (payload: PkceCookiePayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

/** Décode et valide strictement le cookie `pv_pkce` ; `null` si invalide. */
export const decodePkceCookie = (raw: string | undefined): PkceCookiePayload | null => {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { verifier, state, redirectTo, mode } = parsed as Record<string, unknown>;
    if (typeof verifier !== "string" || verifier === "") return null;
    if (typeof state !== "string" || state === "") return null;
    if (typeof redirectTo !== "string") return null;
    return {
      verifier,
      state,
      redirectTo: sanitizeRedirectPath(redirectTo),
      mode: mode === "link" ? "link" : "login",
    };
  } catch {
    return null;
  }
};

export const pkceCookie = (payload: PkceCookiePayload, secure: boolean): string =>
  serializeCookie(PKCE_COOKIE, encodePkceCookie(payload), {
    path: PKCE_COOKIE_PATH,
    maxAge: PKCE_COOKIE_MAX_AGE_SECONDS,
    secure,
  });

export const expirePkceCookie = (secure: boolean): string =>
  expireCookie(PKCE_COOKIE, PKCE_COOKIE_PATH, secure);

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Durée de vie du jeton d'accès en secondes (`expires_in` GoTrue). */
  readonly expiresIn?: number | undefined;
}

export const sessionCookies = (tokens: SessionTokens, secure: boolean): readonly string[] => [
  serializeCookie(ACCESS_TOKEN_COOKIE, encodeURIComponent(tokens.accessToken), {
    path: "/",
    maxAge: tokens.expiresIn ?? ACCESS_TOKEN_DEFAULT_MAX_AGE_SECONDS,
    secure,
  }),
  serializeCookie(REFRESH_TOKEN_COOKIE, encodeURIComponent(tokens.refreshToken), {
    path: "/",
    maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
    secure,
  }),
];

export const expireSessionCookies = (secure: boolean): readonly string[] => [
  expireCookie(ACCESS_TOKEN_COOKIE, "/", secure),
  expireCookie(REFRESH_TOKEN_COOKIE, "/", secure),
];

const decodeCookieValue = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

export const readSessionTokens = (
  cookieHeader: string | null | undefined,
): { readonly accessToken: string | undefined; readonly refreshToken: string | undefined } => {
  const cookies = parseCookies(cookieHeader);
  return {
    accessToken: decodeCookieValue(cookies[ACCESS_TOKEN_COOKIE]),
    refreshToken: decodeCookieValue(cookies[REFRESH_TOKEN_COOKIE]),
  };
};

// ---------------------------------------------------------------------------
// Mapping des erreurs GoTrue → `/login?error=…`
// ---------------------------------------------------------------------------

export interface GoTrueCallbackError {
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly errorDescription: string | null;
}

export const readCallbackError = (params: URLSearchParams): GoTrueCallbackError | null => {
  const error = params.get("error");
  const errorCode = params.get("error_code");
  const errorDescription = params.get("error_description");
  if (error === null && errorCode === null && errorDescription === null) return null;
  return { error, errorCode, errorDescription };
};

/**
 * Le trigger d'allowlist (migration 001) lève `access_denied: email not in
 * invite allowlist` ; GoTrue le remonte en `server_error` /
 * `Database error saving new user`. `GOTRUE_DISABLE_SIGNUP=true` donne
 * `signup_disabled`.
 */
export const mapGoTrueError = (details: GoTrueCallbackError): LoginError => {
  const code = (details.errorCode ?? "").toLowerCase();
  const error = (details.error ?? "").toLowerCase();
  const description = (details.errorDescription ?? "").toLowerCase();

  if (
    code === "signup_disabled" ||
    description.includes("signups not allowed") ||
    description.includes("signup is disabled") ||
    description.includes("signup_disabled") ||
    description.includes("database error saving new user") ||
    description.includes("invite allowlist") ||
    description.includes("not in invite")
  ) {
    return "invite_only";
  }

  // `access_denied` sans marqueur explicite d'allowlist/signup = annulation OAuth
  // côté fournisseur (ex. Discord : "The resource owner or authorization server
  // denied the request", Google : description vide).
  if (error === "access_denied") {
    return "oauth_cancelled";
  }

  return "auth_failed";
};

export const loginRedirectPath = (error?: LoginError): string =>
  error === undefined ? LOGIN_PATH : `${LOGIN_PATH}?error=${error}`;

/**
 * Erreurs d'un retour de liaison (`mode: "link"`) : un refus explicite côté
 * fournisseur est une annulation ; tout le reste (identité déjà rattachée à un
 * autre compte, liaison désactivée, état expiré…) est un échec.
 */
export const mapLinkError = (details: GoTrueCallbackError): AccountLinkError =>
  (details.error ?? "").toLowerCase() === "access_denied" ? "link_cancelled" : "link_failed";

// ---------------------------------------------------------------------------
// Client GoTrue (fetch injectable → tests sans réseau)
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Identité OAuth rattachée à l'utilisateur (`identities[]` de `GET /user`). */
export interface SessionIdentity {
  readonly provider: OAuthProvider;
  /** Identifiant de l'utilisateur chez le fournisseur (Google `sub`, Discord snowflake). */
  readonly providerUserId: string;
  readonly email: string | null;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
  readonly provider: string | null;
  /** Nom affiché (métadonnées du fournisseur, sinon partie locale de l'e-mail). */
  readonly displayName: string | null;
  /** Identités Google / Discord liées (les autres providers sont ignorés). */
  readonly identities: ReadonlyArray<SessionIdentity>;
}

export interface GoTrueSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const parseTokenResponse = (body: unknown): GoTrueSession | null => {
  const record = asRecord(body);
  if (record === null) return null;
  const accessToken = record["access_token"];
  const refreshToken = record["refresh_token"];
  const expiresIn = record["expires_in"];
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (typeof refreshToken !== "string" || refreshToken === "") return null;
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : undefined,
  };
};

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const parseIdentities = (value: unknown): ReadonlyArray<SessionIdentity> => {
  if (!Array.isArray(value)) return [];
  const identities: SessionIdentity[] = [];
  for (const item of value as unknown[]) {
    const record = asRecord(item);
    if (record === null) continue;
    const provider = record["provider"];
    if (!isOAuthProvider(provider)) continue;
    if (identities.some((identity) => identity.provider === provider)) continue;
    const data = asRecord(record["identity_data"]);
    // GoTrue expose l'ID chez le fournisseur dans `id` (`identity_id` = UUID de la ligne).
    const providerUserId =
      nonEmptyString(record["id"]) ??
      nonEmptyString(data?.["provider_id"]) ??
      nonEmptyString(data?.["sub"]);
    if (providerUserId === null) continue;
    identities.push({
      provider,
      providerUserId,
      email: nonEmptyString(record["email"]) ?? nonEmptyString(data?.["email"]),
    });
  }
  return identities;
};

const parseDisplayName = (
  metadata: Record<string, unknown> | null,
  email: string | null,
): string | null =>
  nonEmptyString(metadata?.["full_name"]) ??
  nonEmptyString(metadata?.["name"]) ??
  nonEmptyString(metadata?.["user_name"]) ??
  nonEmptyString(metadata?.["preferred_username"]) ??
  nonEmptyString(email?.split("@")[0]);

export const parseSessionUser = (body: unknown): SessionUser | null => {
  const record = asRecord(body);
  if (record === null) return null;
  const id = record["id"];
  if (typeof id !== "string" || id === "") return null;
  const email = nonEmptyString(record["email"]);
  const provider = asRecord(record["app_metadata"])?.["provider"];
  return {
    id,
    email,
    provider: typeof provider === "string" ? provider : null,
    displayName: parseDisplayName(asRecord(record["user_metadata"]), email),
    identities: parseIdentities(record["identities"]),
  };
};

const goTrueHeaders = (config: AuthConfig, accessToken?: string): Record<string, string> => ({
  apikey: config.anonKey,
  "Content-Type": "application/json",
  ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
});

const safeJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/** Échange `code` + `code_verifier` contre une session (`grant_type=pkce`). */
export const exchangeCodeForSession = async (
  config: AuthConfig,
  fetchImpl: FetchLike,
  code: string,
  codeVerifier: string,
): Promise<GoTrueSession | null> => {
  try {
    const response = await fetchImpl(`${config.internalAuthBase}/token?grant_type=pkce`, {
      method: "POST",
      headers: goTrueHeaders(config),
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    });
    if (!response.ok) return null;
    return parseTokenResponse(await safeJson(response));
  } catch {
    return null;
  }
};

export const refreshSession = async (
  config: AuthConfig,
  fetchImpl: FetchLike,
  refreshToken: string,
): Promise<GoTrueSession | null> => {
  try {
    const response = await fetchImpl(`${config.internalAuthBase}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: goTrueHeaders(config),
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) return null;
    return parseTokenResponse(await safeJson(response));
  } catch {
    return null;
  }
};

export type FetchUserResult =
  | { readonly kind: "ok"; readonly user: SessionUser }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable" };

export const fetchSessionUser = async (
  config: AuthConfig,
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<FetchUserResult> => {
  try {
    const response = await fetchImpl(`${config.internalAuthBase}/user`, {
      method: "GET",
      headers: goTrueHeaders(config, accessToken),
    });
    if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "unavailable" };
    const user = parseSessionUser(await safeJson(response));
    return user === null ? { kind: "unauthorized" } : { kind: "ok", user };
  } catch {
    return { kind: "unavailable" };
  }
};

export interface LinkIdentityInput {
  readonly provider: OAuthProvider;
  readonly appOrigin: string;
  readonly pkce: PkcePair;
}

/**
 * Valide l'URL d'autorisation renvoyée par GoTrue : `http(s)` uniquement, sans
 * identifiants embarqués. GoTrue renvoie déjà l'URL du fournisseur (hôte public
 * `accounts.google.com` / `discord.com`) : aucun hôte interne à réécrire.
 */
export const parseAuthorizationUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * Liaison manuelle GoTrue (`linkIdentity`) : `GET /user/identities/authorize`
 * avec le jeton de l'utilisateur connecté. Exige
 * `GOTRUE_SECURITY_MANUAL_LINKING_ENABLED=true` (sinon `404 manual_linking_disabled`).
 * Retourne l'URL d'autorisation du fournisseur, `null` en cas d'échec.
 */
export const startLinkIdentity = async (
  config: AuthConfig,
  fetchImpl: FetchLike,
  accessToken: string,
  input: LinkIdentityInput,
): Promise<string | null> => {
  const params = new URLSearchParams({
    provider: input.provider,
    redirect_to: buildCallbackUrl(input.appOrigin, input.pkce.state),
    code_challenge: input.pkce.codeChallenge,
    code_challenge_method: "s256",
    scopes: OAUTH_SCOPES[input.provider],
    skip_http_redirect: "true",
  });
  try {
    const response = await fetchImpl(
      `${config.internalAuthBase}/user/identities/authorize?${params.toString()}`,
      { method: "GET", headers: goTrueHeaders(config, accessToken) },
    );
    if (!response.ok) return null;
    return parseAuthorizationUrl(asRecord(await safeJson(response))?.["url"]);
  } catch {
    return null;
  }
};

/** Révocation locale best-effort (ne déconnecte pas les autres appareils) : n'échoue jamais. */
export const revokeSession = async (
  config: AuthConfig,
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<void> => {
  try {
    await fetchImpl(`${config.internalAuthBase}/logout?scope=local`, {
      method: "POST",
      headers: goTrueHeaders(config, accessToken),
    });
  } catch {
    // Les cookies sont expirés de toute façon.
  }
};
