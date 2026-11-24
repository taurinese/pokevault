/**
 * Constantes d'auth sûres pour le bundle client (aucun import `node:*`) :
 * partagées entre `auth.ts` (serveur) et l'écran de connexion `09A`.
 */

export const OAUTH_PROVIDERS = ["google", "discord"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const isOAuthProvider = (value: unknown): value is OAuthProvider =>
  typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);

export const LOGIN_PATH = "/login";
export const AUTH_LOGIN_API_PATH = "/api/auth/login";

export const LOGIN_ERRORS = ["invite_only", "oauth_cancelled", "auth_failed"] as const;
export type LoginError = (typeof LOGIN_ERRORS)[number];

export const isLoginError = (value: unknown): value is LoginError =>
  typeof value === "string" && (LOGIN_ERRORS as readonly string[]).includes(value);

export const oauthLoginHref = (provider: OAuthProvider, redirectTo?: string): string => {
  const params = new URLSearchParams({ provider });
  if (redirectTo !== undefined && redirectTo !== "/") params.set("redirect", redirectTo);
  return `${AUTH_LOGIN_API_PATH}?${params.toString()}`;
};

// ---------------------------------------------------------------------------
// Compte & paramètres (09B) — liaison d'identités OAuth
// ---------------------------------------------------------------------------

export const ACCOUNT_PATH = "/account";
export const AUTH_LINK_API_PATH = "/api/auth/link";
export const AUTH_LOGOUT_API_PATH = "/api/auth/logout";

export const oauthLinkHref = (provider: OAuthProvider): string =>
  `${AUTH_LINK_API_PATH}?provider=${provider}`;

/** Erreurs affichées sur `/account?error=…` après un retour de liaison. */
export const ACCOUNT_LINK_ERRORS = ["link_cancelled", "link_failed"] as const;
export type AccountLinkError = (typeof ACCOUNT_LINK_ERRORS)[number];

export const isAccountLinkError = (value: unknown): value is AccountLinkError =>
  typeof value === "string" && (ACCOUNT_LINK_ERRORS as readonly string[]).includes(value);

export const accountRedirectPath = (
  result?: { readonly linked: OAuthProvider } | { readonly error: AccountLinkError },
): string => {
  if (result === undefined) return ACCOUNT_PATH;
  const params = new URLSearchParams(
    "linked" in result ? { linked: result.linked } : { error: result.error },
  );
  return `${ACCOUNT_PATH}?${params.toString()}`;
};

/** `/login?redirect=/chemin` (le chemin doit déjà être un chemin interne). */
export const loginRedirectTo = (redirectTo: string): string =>
  `${LOGIN_PATH}?${new URLSearchParams({ redirect: redirectTo }).toString()}`;

// ---------------------------------------------------------------------------
// Anti-open-redirect (sans dépendance Node : utilisé aussi côté client)
// ---------------------------------------------------------------------------

/**
 * N'autorise qu'un chemin relatif interne : commence par un unique `/`, sans
 * `//`, `/\`, schéma, caractères de contrôle ni retour ligne. Repli : `/`.
 * Retourne la forme ASCII percent-encodée (évite un crash ByteString sur `Location`).
 */
export const sanitizeRedirectPath = (input: string | null | undefined): string => {
  if (typeof input !== "string" || input === "") return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: détection volontaire des caractères de contrôle (CR/LF…)
  if (/[\u0000-\u001f\u007f\\]/.test(input) || /%(0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(input)) {
    return "/";
  }
  if (!input.startsWith("/") || input.startsWith("//")) return "/";
  try {
    // Un chemin interne reste sur la même origine une fois résolu.
    const resolved = new URL(input, "http://pokevault.invalid");
    if (resolved.origin !== "http://pokevault.invalid") return "/";
    const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // La normalisation WHATWG retire `.` / `..` et peut produire `//evil.com` depuis `/.//evil.com`.
    return !normalized.startsWith("/") || normalized.startsWith("//") ? "/" : normalized;
  } catch {
    return "/";
  }
};
