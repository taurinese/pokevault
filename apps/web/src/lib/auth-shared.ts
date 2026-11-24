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

export const oauthLoginHref = (provider: OAuthProvider): string =>
  `${AUTH_LOGIN_API_PATH}?provider=${provider}`;
