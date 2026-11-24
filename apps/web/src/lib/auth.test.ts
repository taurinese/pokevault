import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_COOKIE,
  type AuthConfig,
  buildAuthorizeUrl,
  codeChallengeFor,
  decodePkceCookie,
  encodePkceCookie,
  generatePkcePair,
  mapGoTrueError,
  PKCE_COOKIE,
  parseCookies,
  pkceCookie,
  REFRESH_TOKEN_COOKIE,
  readAuthConfig,
  resolveAppOrigin,
  sanitizeRedirectPath,
  sessionCookies,
} from "./auth.ts";
import {
  type AuthDeps,
  getServerSession,
  handleCallback,
  handleLogin,
  handleLogout,
} from "./auth-server.ts";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

const makeDeps = (
  handler: (input: string, init?: RequestInit) => Response | Promise<Response>,
  overrides: Partial<AuthConfig> = {},
): { deps: AuthDeps; fetchMock: FetchMock } => {
  const fetchMock: FetchMock = vi.fn(async (input, init) => handler(input, init));
  return { deps: { config: { ...config, ...overrides }, fetch: fetchMock }, fetchMock };
};

const headerOf = (init: RequestInit | undefined, name: string): string | undefined =>
  new Headers(init?.headers).get(name) ?? undefined;

const noNetwork = () => makeDeps(() => new Response("unexpected", { status: 500 }));

describe("readAuthConfig", () => {
  it("falls back to the dev defaults", () => {
    const result = readAuthConfig({});
    expect(result.publicUrl).toBe("http://localhost:54321");
    expect(result.internalAuthBase).toBe("http://localhost:54321/auth/v1");
    expect(result.anonKey).toBe("");
    expect(result.appUrl).toBeUndefined();
    expect(result.isProduction).toBe(false);
  });

  it("keeps the Docker internal base as is (GoTrue serves at the root)", () => {
    const result = readAuthConfig({
      SUPABASE_PUBLIC_URL: "https://pokevault.example/",
      SUPABASE_INTERNAL_AUTH_URL: "http://auth:9999/",
      SUPABASE_ANON_KEY: "k",
      NODE_ENV: "production",
    });
    expect(result.publicUrl).toBe("https://pokevault.example");
    expect(result.internalAuthBase).toBe("http://auth:9999");
    expect(result.anonKey).toBe("k");
    expect(result.isProduction).toBe(true);
  });

  it("keeps an internal base that already carries /auth/v1 (Caddy)", () => {
    const result = readAuthConfig({ SUPABASE_INTERNAL_AUTH_URL: "http://localhost:54321/auth/v1" });
    expect(result.internalAuthBase).toBe("http://localhost:54321/auth/v1");
  });

  it("prefers APP_URL over SITE_URL and ignores blanks", () => {
    expect(readAuthConfig({ APP_URL: "http://a/", SITE_URL: "http://b" }).appUrl).toBe("http://a");
    expect(readAuthConfig({ APP_URL: " ", SITE_URL: "http://b" }).appUrl).toBe("http://b");
  });
});

describe("resolveAppOrigin", () => {
  it("uses APP_URL / SITE_URL when configured", () => {
    expect(resolveAppOrigin(config, "http://0.0.0.0:3000/x")).toBe("http://localhost:3000");
  });

  it("uses the public Supabase origin in production without APP_URL", () => {
    const prod = { ...config, appUrl: undefined, isProduction: true, publicUrl: "https://pv.test" };
    expect(resolveAppOrigin(prod, "http://0.0.0.0:3000/x")).toBe("https://pv.test");
  });

  it("falls back to the request origin in dev", () => {
    expect(resolveAppOrigin({ ...config, appUrl: undefined }, "http://localhost:3001/x")).toBe(
      "http://localhost:3001",
    );
  });
});

describe("PKCE S256", () => {
  it("generates a 32-byte verifier, its SHA-256 base64url challenge and a state", () => {
    const pair = generatePkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toBe(
      createHash("sha256").update(pair.codeVerifier).digest("base64url"),
    );
    expect(pair.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("matches the RFC 7636 test vector", () => {
    expect(codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("never reuses a verifier or a state", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe("sanitizeRedirectPath (anti open-redirect)", () => {
  it.each([
    ["/", "/"],
    ["/collection", "/collection"],
    ["/s/abc?x=1#top", "/s/abc?x=1#top"],
    ["/日本?q=é", "/%E6%97%A5%E6%9C%AC?q=%C3%A9"],
  ])("keeps and ASCII-encodes the internal path %s", (input, expected) => {
    expect(sanitizeRedirectPath(input)).toBe(expected);
  });

  it.each([
    "//evil.test",
    "//evil.test/path",
    "/\\evil.test",
    "\\evil.test",
    "http://evil.test",
    "https://evil.test/x",
    "javascript:alert(1)",
    "evil.test",
    "collection",
    "/ok\r\nSet-Cookie: a=b",
    "/ok%0d%0aSet-Cookie:a=b",
    "/%5cevil.test",
    "/\tfoo",
    "",
  ])("falls back to / for %j", (input) => {
    expect(sanitizeRedirectPath(input)).toBe("/");
  });

  it("falls back to / for null and undefined", () => {
    expect(sanitizeRedirectPath(null)).toBe("/");
    expect(sanitizeRedirectPath(undefined)).toBe("/");
  });
});

describe("cookies", () => {
  it("builds the short-lived pv_pkce cookie scoped to /api/auth", () => {
    const cookie = pkceCookie({ verifier: "v", state: "s", redirectTo: "/collection" }, true);
    expect(cookie.startsWith(`${PKCE_COOKIE}=`)).toBe(true);
    expect(cookie).toContain("Path=/api/auth");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("omits Secure over plain HTTP", () => {
    const cookie = pkceCookie({ verifier: "v", state: "s", redirectTo: "/" }, false);
    expect(cookie).not.toContain("Secure");
  });

  it("builds HttpOnly SameSite=Lax session cookies on /", () => {
    const [access, refresh] = sessionCookies(
      { accessToken: "a.b.c", refreshToken: "r", expiresIn: 1800 },
      true,
    );
    expect(access).toContain(`${ACCESS_TOKEN_COOKIE}=a.b.c`);
    expect(access).toContain("Max-Age=1800");
    expect(refresh).toContain(`${REFRESH_TOKEN_COOKIE}=r`);
    for (const cookie of [access, refresh]) {
      expect(cookie).toContain("Path=/;");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Secure");
    }
  });

  it("round-trips and validates the pkce payload", () => {
    const payload = { verifier: "v", state: "s", redirectTo: "/wishlist" };
    expect(decodePkceCookie(encodePkceCookie(payload))).toEqual(payload);
    expect(decodePkceCookie(undefined)).toBeNull();
    expect(decodePkceCookie("%%%")).toBeNull();
    expect(decodePkceCookie(Buffer.from('{"verifier":1}').toString("base64url"))).toBeNull();
  });

  it("re-sanitizes a tampered redirectTo", () => {
    const raw = encodePkceCookie({ verifier: "v", state: "s", redirectTo: "//evil.test" });
    expect(decodePkceCookie(raw)?.redirectTo).toBe("/");
  });

  it("parses a Cookie header", () => {
    expect(parseCookies("a=1; b=2; bad; c=x=y")).toEqual({ a: "1", b: "2", c: "x=y" });
    expect(parseCookies(null)).toEqual({});
  });
});

describe("mapGoTrueError", () => {
  const map = (error: string | null, errorCode: string | null, errorDescription: string | null) =>
    mapGoTrueError({ error, errorCode, errorDescription });

  it("maps the allowlist trigger failure to invite_only", () => {
    expect(map("server_error", "unexpected_failure", "Database error saving new user")).toBe(
      "invite_only",
    );
  });

  it("maps signup_disabled to invite_only", () => {
    expect(map("access_denied", "signup_disabled", "Signups not allowed for this instance")).toBe(
      "invite_only",
    );
    expect(map("server_error", null, "signup_disabled")).toBe("invite_only");
  });

  it("maps a server-side access_denied (allowlist) to invite_only", () => {
    expect(map("access_denied", null, "email not in invite allowlist")).toBe("invite_only");
  });

  it("maps a user cancellation (Google or Discord) to oauth_cancelled", () => {
    expect(map("access_denied", null, "The user denied access to the application")).toBe(
      "oauth_cancelled",
    );
    expect(
      map("access_denied", null, "The resource owner or authorization server denied the request"),
    ).toBe("oauth_cancelled");
    expect(map("access_denied", null, "Authorization cancelled")).toBe("oauth_cancelled");
    expect(map("access_denied", null, null)).toBe("oauth_cancelled");
  });

  it("maps anything else to auth_failed", () => {
    expect(map("server_error", null, "boom")).toBe("auth_failed");
    expect(map(null, "bad_oauth_callback", "state mismatch")).toBe("auth_failed");
  });
});

describe("GET /api/auth/login", () => {
  it("rejects an unknown provider with 400", () => {
    const { deps } = noNetwork();
    const response = handleLogin(
      new Request("http://localhost:3000/api/auth/login?provider=github"),
      deps,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(handleLogin(new Request("http://localhost:3000/api/auth/login"), deps).status).toBe(400);
  });

  it.each([
    ["google", "openid email profile"],
    ["discord", "identify email"],
  ])("redirects %s to the public GoTrue authorize endpoint (PKCE S256)", (provider, scopes) => {
    const { deps } = noNetwork();
    const response = handleLogin(
      new Request(`http://localhost:3000/api/auth/login?provider=${provider}&redirect=/collection`),
      deps,
    );
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("http://localhost:54321/auth/v1/authorize");
    expect(location.searchParams.get("provider")).toBe(provider);
    expect(location.searchParams.get("scopes")).toBe(scopes);
    expect(location.searchParams.get("code_challenge_method")).toBe("s256");

    const cookieHeader = response.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("SameSite=Lax");
    expect(cookieHeader).toContain("Path=/api/auth");

    const pkce = decodePkceCookie(parseCookies(cookieHeader.split(";")[0])[PKCE_COOKIE]);
    expect(pkce).not.toBeNull();
    expect(pkce?.redirectTo).toBe("/collection");
    expect(location.searchParams.get("code_challenge")).toBe(
      codeChallengeFor(pkce?.verifier ?? ""),
    );

    const redirectTo = new URL(location.searchParams.get("redirect_to") ?? "");
    expect(redirectTo.origin + redirectTo.pathname).toBe("http://localhost:3000/api/auth/callback");
    expect(redirectTo.searchParams.get("state")).toBe(pkce?.state);
  });

  it("sanitizes a malicious redirect target", () => {
    const { deps } = noNetwork();
    const response = handleLogin(
      new Request("http://localhost:3000/api/auth/login?provider=google&redirect=//evil.test"),
      deps,
    );
    const cookieHeader = response.headers.get("set-cookie") ?? "";
    const pkce = decodePkceCookie(parseCookies(cookieHeader.split(";")[0])[PKCE_COOKIE]);
    expect(pkce?.redirectTo).toBe("/");
  });

  it("marks cookies Secure in production", () => {
    const { deps } = makeDeps(() => new Response(), { isProduction: true, appUrl: undefined });
    const response = handleLogin(
      new Request("http://0.0.0.0:3000/api/auth/login?provider=google"),
      deps,
    );
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("buildAuthorizeUrl", () => {
  it("targets the browser-facing URL, never the internal one", () => {
    const pkce = generatePkcePair();
    const url = buildAuthorizeUrl(config, {
      provider: "google",
      appOrigin: "http://localhost:3000",
      pkce,
    });
    expect(url.startsWith("http://localhost:54321/auth/v1/authorize?")).toBe(true);
    expect(url).not.toContain("auth:9999");
  });
});

describe("GET /api/auth/callback", () => {
  const pkce = { verifier: "verifier-123", state: "state-123", redirectTo: "/collection" };
  const cookieHeader = `${PKCE_COOKIE}=${encodePkceCookie(pkce)}`;
  const callback = (query: string, cookie: string | null = cookieHeader): Request =>
    new Request(`http://localhost:3000/api/auth/callback?${query}`, {
      headers: cookie === null ? {} : { cookie },
    });
  const setCookies = (response: Response): string[] => response.headers.getSetCookie();

  it("exchanges the code via POST /token?grant_type=pkce and sets the session", async () => {
    const { deps, fetchMock } = makeDeps(() =>
      jsonResponse({ access_token: "acc", refresh_token: "ref", expires_in: 3600, user: {} }),
    );
    const response = await handleCallback(callback("code=abc&state=state-123"), deps);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/collection");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://auth:9999/token?grant_type=pkce");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      auth_code: "abc",
      code_verifier: "verifier-123",
    });
    expect(headerOf(init, "apikey")).toBe("anon-key");

    const cookies = setCookies(response);
    expect(cookies.find((c) => c.startsWith(`${ACCESS_TOKEN_COOKIE}=acc`))).toContain("HttpOnly");
    expect(cookies.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE}=ref`))).toContain("HttpOnly");
    expect(cookies.find((c) => c.startsWith(`${PKCE_COOKIE}=`))).toContain("Max-Age=0");
  });

  it("never exposes tokens in the redirect URL", async () => {
    const { deps } = makeDeps(() => jsonResponse({ access_token: "acc", refresh_token: "ref" }));
    const response = await handleCallback(callback("code=abc&state=state-123"), deps);
    expect(response.headers.get("location")).not.toContain("acc");
  });

  it("sanitizes a tampered redirectTo from the cookie", async () => {
    const evil = `${PKCE_COOKIE}=${Buffer.from(
      JSON.stringify({ verifier: "v", state: "s", redirectTo: "https://evil.test" }),
    ).toString("base64url")}`;
    const { deps } = makeDeps(() => jsonResponse({ access_token: "a", refresh_token: "r" }));
    const response = await handleCallback(callback("code=abc&state=s", evil), deps);
    expect(response.headers.get("location")).toBe("/");
  });

  it.each([
    ["server_error", "unexpected_failure", "Database error saving new user", "invite_only"],
    ["access_denied", "signup_disabled", "Signups not allowed", "invite_only"],
    ["access_denied", "", "The user denied access", "oauth_cancelled"],
    [
      "access_denied",
      "",
      "The resource owner or authorization server denied the request",
      "oauth_cancelled",
    ],
    ["server_error", "", "Something else", "auth_failed"],
  ])(
    "maps GoTrue error %s / %s / %s to /login?error=%s",
    async (error, code, description, expected) => {
      const { deps, fetchMock } = noNetwork();
      const query = new URLSearchParams({
        error,
        error_code: code,
        error_description: description,
      });
      const response = await handleCallback(callback(query.toString()), deps);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/login?error=${expected}`);
      expect(setCookies(response).find((c) => c.startsWith(`${PKCE_COOKIE}=`))).toContain(
        "Max-Age=0",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fails when the code or the pkce cookie is missing", async () => {
    const { deps, fetchMock } = noNetwork();
    const noCode = await handleCallback(callback("state=state-123"), deps);
    const noCookie = await handleCallback(callback("code=abc&state=state-123", null), deps);
    expect(noCode.headers.get("location")).toBe("/login?error=auth_failed");
    expect(noCookie.headers.get("location")).toBe("/login?error=auth_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a mismatching CSRF state without calling GoTrue", async () => {
    const { deps, fetchMock } = noNetwork();
    const response = await handleCallback(callback("code=abc&state=forged"), deps);
    expect(response.headers.get("location")).toBe("/login?error=auth_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the PKCE exchange is rejected or the network is down", async () => {
    const rejected = makeDeps(() => jsonResponse({ error: "bad" }, 400));
    const down = makeDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    for (const { deps } of [rejected, down]) {
      const response = await handleCallback(callback("code=abc&state=state-123"), deps);
      expect(response.headers.get("location")).toBe("/login?error=auth_failed");
      expect(setCookies(response).some((c) => c.startsWith(ACCESS_TOKEN_COOKIE))).toBe(false);
    }
  });
});

describe("getServerSession", () => {
  const withCookies = (cookie: string): Request =>
    new Request("http://localhost:3000/collection", { headers: { cookie } });
  const user = { id: "u1", email: "a@b.test", app_metadata: { provider: "discord" } };

  it("returns null without any cookie (no network call)", async () => {
    const { deps, fetchMock } = noNetwork();
    expect(await getServerSession(new Request("http://localhost:3000/"), deps)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the access token via GET /user", async () => {
    const { deps, fetchMock } = makeDeps(() => jsonResponse(user));
    const session = await getServerSession(withCookies(`${ACCESS_TOKEN_COOKIE}=tok`), deps);
    expect(session).toEqual({ user: { id: "u1", email: "a@b.test", provider: "discord" } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://auth:9999/user");
    expect(headerOf(init, "Authorization")).toBe("Bearer tok");
    expect(headerOf(init, "apikey")).toBe("anon-key");
  });

  it("refreshes automatically on 401 and returns the new cookies", async () => {
    const { deps, fetchMock } = makeDeps((url, init) => {
      if (url.endsWith("/user")) {
        const bearer = headerOf(init, "Authorization");
        return bearer === "Bearer new-acc" ? jsonResponse(user) : jsonResponse({}, 401);
      }
      return jsonResponse({ access_token: "new-acc", refresh_token: "new-ref", expires_in: 3600 });
    });
    const session = await getServerSession(
      withCookies(`${ACCESS_TOKEN_COOKIE}=old; ${REFRESH_TOKEN_COOKIE}=ref`),
      deps,
    );
    expect(session?.user.id).toBe("u1");
    expect(session?.refreshedCookies?.[0]).toContain(`${ACCESS_TOKEN_COOKIE}=new-acc`);
    expect(session?.refreshedCookies?.[1]).toContain(`${REFRESH_TOKEN_COOKIE}=new-ref`);

    const refreshCall = fetchMock.mock.calls.find(([url]) =>
      url.includes("grant_type=refresh_token"),
    );
    expect(refreshCall?.[0]).toBe("http://auth:9999/token?grant_type=refresh_token");
    expect(JSON.parse(String(refreshCall?.[1]?.body))).toEqual({ refresh_token: "ref" });
  });

  it("refreshes when only the refresh token cookie remains (expired access cookie)", async () => {
    const { deps } = makeDeps((url) =>
      url.endsWith("/user")
        ? jsonResponse(user)
        : jsonResponse({ access_token: "a2", refresh_token: "r2" }),
    );
    const session = await getServerSession(withCookies(`${REFRESH_TOKEN_COOKIE}=ref`), deps);
    expect(session?.refreshedCookies).toHaveLength(2);
  });

  it("returns null when the refresh is rejected", async () => {
    const { deps } = makeDeps((url) =>
      url.endsWith("/user") ? jsonResponse({}, 401) : jsonResponse({ error: "invalid" }, 400),
    );
    const session = await getServerSession(
      withCookies(`${ACCESS_TOKEN_COOKIE}=old; ${REFRESH_TOKEN_COOKIE}=ref`),
      deps,
    );
    expect(session).toBeNull();
  });

  it("returns null (never grants access) when GoTrue is unreachable", async () => {
    const { deps, fetchMock } = makeDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const session = await getServerSession(
      withCookies(`${ACCESS_TOKEN_COOKIE}=tok; ${REFRESH_TOKEN_COOKIE}=ref`),
      deps,
    );
    expect(session).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/auth/logout", () => {
  const logout = (headers: Record<string, string> = {}): Request =>
    new Request("http://localhost:3000/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=tok; ${REFRESH_TOKEN_COOKIE}=ref`, ...headers },
    });

  it("revokes the session (Bearer), expires cookies and redirects 303 to /login", async () => {
    const { deps, fetchMock } = makeDeps(() => new Response(null, { status: 204 }));
    const response = await handleLogout(logout(), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://auth:9999/logout?scope=local");
    expect(headerOf(init, "Authorization")).toBe("Bearer tok");

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) expect(cookie).toContain("Max-Age=0");
  });

  it("answers 200 JSON when asked", async () => {
    const { deps } = makeDeps(() => new Response(null, { status: 204 }));
    const response = await handleLogout(logout({ accept: "application/json" }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("still clears cookies when GoTrue fails (best-effort)", async () => {
    const { deps } = makeDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const response = await handleLogout(logout(), deps);
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("does not call GoTrue without any token", async () => {
    const { deps, fetchMock } = noNetwork();
    const response = await handleLogout(
      new Request("http://localhost:3000/api/auth/logout", { method: "POST" }),
      deps,
    );
    expect(response.status).toBe(303);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes then revokes when only the refresh token remains", async () => {
    const { deps, fetchMock } = makeDeps((url) =>
      url.includes("grant_type=refresh_token")
        ? jsonResponse({ access_token: "fresh-acc", refresh_token: "fresh-ref" })
        : new Response(null, { status: 204 }),
    );
    const response = await handleLogout(
      new Request("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { cookie: `${REFRESH_TOKEN_COOKIE}=ref`, origin: "http://localhost:3000" },
      }),
      deps,
    );
    expect(response.status).toBe(303);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://auth:9999/logout?scope=local");
    expect(headerOf(fetchMock.mock.calls[1]?.[1], "Authorization")).toBe("Bearer fresh-acc");
  });

  it("rejects cross-site Origin or Referer with 403 (logout CSRF)", async () => {
    const { deps, fetchMock } = noNetwork();
    const badOrigin = await handleLogout(logout({ origin: "https://evil.example" }), deps);
    const badReferer = await handleLogout(logout({ referer: "https://evil.example/form" }), deps);
    for (const response of [badOrigin, badReferer]) {
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
