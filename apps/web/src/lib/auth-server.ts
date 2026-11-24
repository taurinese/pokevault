/**
 * Handlers HTTP serveur de l'auth OAuth PKCE (login / link / callback / logout) et
 * lecture de session SSR. Aucune dépendance TanStack : fonctions
 * `Request → Response` testables avec un `fetch` mocké.
 */

import {
  type AccountLinkError,
  type AuthConfig,
  buildAuthorizeUrl,
  decodePkceCookie,
  exchangeCodeForSession,
  expirePkceCookie,
  expireSessionCookies,
  type FetchLike,
  fetchSessionUser,
  generatePkcePair,
  isOAuthProvider,
  isRequestSameOrigin,
  isSecureContext,
  type LoginError,
  loginRedirectPath,
  mapGoTrueError,
  mapLinkError,
  PKCE_COOKIE,
  parseCookies,
  pkceCookie,
  readAuthConfig,
  readCallbackError,
  readSessionTokens,
  refreshSession,
  resolveAppOrigin,
  revokeSession,
  type SessionUser,
  safeTokenEqual,
  sanitizeRedirectPath,
  sessionCookies,
  startLinkIdentity,
} from "./auth.ts";
import { ACCOUNT_PATH, accountRedirectPath, loginRedirectTo } from "./auth-shared.ts";

export interface AuthDeps {
  readonly config: AuthConfig;
  readonly fetch: FetchLike;
}

export const defaultAuthDeps = (): AuthDeps => ({
  config: readAuthConfig(),
  fetch: (input, init) => fetch(input, init),
});

const redirect = (
  location: string,
  status: 302 | 303,
  cookies: readonly string[] = [],
): Response => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
};

const isSecureRequest = (deps: AuthDeps, request: Request): boolean =>
  isSecureContext(deps.config, resolveAppOrigin(deps.config, request.url));

// ---------------------------------------------------------------------------
// GET /api/auth/login?provider=google|discord[&redirect=/chemin]
// ---------------------------------------------------------------------------

export const handleLogin = (request: Request, deps: AuthDeps = defaultAuthDeps()): Response => {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider");
  if (!isOAuthProvider(provider)) {
    return Response.json(
      { error: "invalid_provider" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const appOrigin = resolveAppOrigin(deps.config, request.url);
  const secure = isSecureContext(deps.config, appOrigin);
  const pkce = generatePkcePair();
  const redirectTo = sanitizeRedirectPath(url.searchParams.get("redirect"));

  return redirect(buildAuthorizeUrl(deps.config, { provider, appOrigin, pkce }), 302, [
    pkceCookie({ verifier: pkce.codeVerifier, state: pkce.state, redirectTo }, secure),
  ]);
};

// ---------------------------------------------------------------------------
// GET /api/auth/callback
// ---------------------------------------------------------------------------

export const handleCallback = async (
  request: Request,
  deps: AuthDeps = defaultAuthDeps(),
): Promise<Response> => {
  const url = new URL(request.url);
  const secure = isSecureRequest(deps, request);
  const pkce = decodePkceCookie(parseCookies(request.headers.get("cookie"))[PKCE_COOKIE]);
  // Mode `link` (liaison depuis 09B) : les erreurs ramènent sur `/account`, pas `/login`.
  const linkMode = pkce?.mode === "link";
  const fail = (error: LoginError, linkError: AccountLinkError): Response =>
    redirect(linkMode ? accountRedirectPath({ error: linkError }) : loginRedirectPath(error), 302, [
      expirePkceCookie(secure),
    ]);

  const callbackError = readCallbackError(url.searchParams);
  if (callbackError !== null) {
    return fail(mapGoTrueError(callbackError), mapLinkError(callbackError));
  }

  const code = url.searchParams.get("code");
  if (code === null || code === "" || pkce === null) return fail("auth_failed", "link_failed");

  // CSRF : le `state` renvoyé via `redirect_to` doit correspondre à celui du cookie.
  if (!safeTokenEqual(url.searchParams.get("state"), pkce.state)) {
    return fail("auth_failed", "link_failed");
  }

  const session = await exchangeCodeForSession(deps.config, deps.fetch, code, pkce.verifier);
  if (session === null) return fail("auth_failed", "link_failed");

  return redirect(sanitizeRedirectPath(pkce.redirectTo), 302, [
    ...sessionCookies(session, secure),
    expirePkceCookie(secure),
  ]);
};

// ---------------------------------------------------------------------------
// GET /api/auth/link?provider=google|discord   (liaison `linkIdentity`, 09B)
// ---------------------------------------------------------------------------

export const handleLinkIdentity = async (
  request: Request,
  deps: AuthDeps = defaultAuthDeps(),
): Promise<Response> => {
  const session = await getServerSession(request, deps);
  // Docs/06 §1 : la liaison n'est possible que depuis une session authentifiée valide.
  if (session === null) return redirect(loginRedirectTo(ACCOUNT_PATH), 302);
  const refreshed = session.refreshedCookies ?? [];

  const provider = new URL(request.url).searchParams.get("provider");
  if (!isOAuthProvider(provider)) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const cookie of refreshed) headers.append("Set-Cookie", cookie);
    return Response.json({ error: "invalid_provider" }, { status: 400, headers });
  }

  // Déjà lié : rien à faire côté GoTrue.
  if (session.user.identities.some((identity) => identity.provider === provider)) {
    return redirect(accountRedirectPath({ linked: provider }), 302, refreshed);
  }

  const appOrigin = resolveAppOrigin(deps.config, request.url);
  const secure = isSecureContext(deps.config, appOrigin);
  const pkce = generatePkcePair();
  const authorizationUrl = await startLinkIdentity(deps.config, deps.fetch, session.accessToken, {
    provider,
    appOrigin,
    pkce,
  });
  if (authorizationUrl === null) {
    return redirect(accountRedirectPath({ error: "link_failed" }), 302, refreshed);
  }

  return redirect(authorizationUrl, 302, [
    ...refreshed,
    pkceCookie(
      {
        verifier: pkce.codeVerifier,
        state: pkce.state,
        redirectTo: accountRedirectPath({ linked: provider }),
        mode: "link",
      },
      secure,
    ),
  ]);
};

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

export const handleLogout = async (
  request: Request,
  deps: AuthDeps = defaultAuthDeps(),
): Promise<Response> => {
  const appOrigin = resolveAppOrigin(deps.config, request.url);
  if (!isRequestSameOrigin(request, appOrigin)) {
    return Response.json(
      { error: "forbidden_origin" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const secure = isSecureContext(deps.config, appOrigin);
  const { accessToken, refreshToken } = readSessionTokens(request.headers.get("cookie"));
  let tokenToRevoke = accessToken;
  if (tokenToRevoke === undefined && refreshToken !== undefined) {
    const refreshed = await refreshSession(deps.config, deps.fetch, refreshToken);
    tokenToRevoke = refreshed?.accessToken;
  }
  if (tokenToRevoke !== undefined) await revokeSession(deps.config, deps.fetch, tokenToRevoke);

  const cookies = expireSessionCookies(secure);
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return Response.json({ ok: true }, { status: 200, headers });
  }
  return redirect(loginRedirectPath(), 303, cookies);
};

// ---------------------------------------------------------------------------
// Session SSR
// ---------------------------------------------------------------------------

export interface ServerSession {
  readonly user: SessionUser;
  /** Jeton d'accès valide (éventuellement fraîchement rafraîchi) — jamais renvoyé au client. */
  readonly accessToken: string;
  /**
   * `Set-Cookie` à renvoyer au client quand la session a été rafraîchie.
   * Absent si les jetons existants étaient encore valides.
   */
  readonly refreshedCookies?: readonly string[];
}

/**
 * Vérifie la session auprès de GoTrue (`/user`), avec refresh automatique si
 * le jeton d'accès est absent/expiré et qu'un refresh token est présent.
 * `null` : non authentifié (ou GoTrue injoignable — jamais d'accès accordé).
 */
export const getServerSession = async (
  request: Request,
  deps: AuthDeps = defaultAuthDeps(),
): Promise<ServerSession | null> => {
  const { accessToken, refreshToken } = readSessionTokens(request.headers.get("cookie"));

  if (accessToken !== undefined) {
    const result = await fetchSessionUser(deps.config, deps.fetch, accessToken);
    if (result.kind === "ok") return { user: result.user, accessToken };
    if (result.kind === "unavailable") return null;
  }

  if (refreshToken === undefined) return null;
  const refreshed = await refreshSession(deps.config, deps.fetch, refreshToken);
  if (refreshed === null) return null;

  const result = await fetchSessionUser(deps.config, deps.fetch, refreshed.accessToken);
  if (result.kind !== "ok") return null;
  return {
    user: result.user,
    accessToken: refreshed.accessToken,
    refreshedCookies: sessionCookies(refreshed, isSecureRequest(deps, request)),
  };
};
