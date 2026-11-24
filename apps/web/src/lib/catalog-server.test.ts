import { type CatalogSearchServiceShape, DatabaseError } from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import {
  type CatalogServerDeps,
  handleDiscover,
  handleSearch,
  handleSuggest,
} from "./catalog-server.ts";

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

const gotrueUser = { id: "u1", email: "ada@pokevault.test", app_metadata: { provider: "google" } };

/** GoTrue factice : `old` expiré, `fresh` valide ; le refresh renvoie `fresh`. */
const gotrue = (url: string, init?: RequestInit): Response => {
  if (url.endsWith("/user")) {
    const bearer = new Headers(init?.headers).get("Authorization");
    return bearer === "Bearer fresh" || bearer === "Bearer valid"
      ? jsonResponse(gotrueUser)
      : jsonResponse({}, 401);
  }
  return jsonResponse({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 });
};

const emptyService = (): CatalogSearchServiceShape => ({
  discover: vi.fn(() =>
    Effect.succeed({
      popularSets: [
        {
          id: "sv08",
          code: "SSP",
          nameFr: "Étincelles Déferlantes",
          logoUrl: null,
          releaseDate: "2024-11-08",
          officialCount: 191,
          totalCount: 252,
        },
      ],
      featuredCards: [],
    }),
  ),
  suggest: vi.fn((query: string) => Effect.succeed({ query: query.trim(), cards: [], sets: [] })),
  search: vi.fn((query) =>
    Effect.succeed({ query, totalCards: 0, totalSets: 0, cards: [], sets: [] }),
  ),
});

const makeDeps = (
  service: CatalogSearchServiceShape | null,
): { deps: CatalogServerDeps; log: ReturnType<typeof vi.fn> } => {
  const log = vi.fn();
  return {
    deps: { auth: { config, fetch: async (url, init) => gotrue(url, init) }, service, log },
    log,
  };
};

const request = (path: string, cookie?: string): Request =>
  new Request(`http://localhost:3000${path}`, cookie === undefined ? {} : { headers: { cookie } });
const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;

describe("GET /api/catalog/discover", () => {
  it("returns 401 without session and never touches the database", async () => {
    const service = emptyService();
    const { deps } = makeDeps(service);
    const response = await handleDiscover(request("/api/catalog/discover"), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(service.discover).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid / expired token", async () => {
    const { deps } = makeDeps(emptyService());
    const response = await handleDiscover(
      request("/api/catalog/discover", `${ACCESS_TOKEN_COOKIE}=expired`),
      deps,
    );
    expect(response.status).toBe(401);
  });

  it("returns 200 JSON with a private 60 s cache", async () => {
    const { deps } = makeDeps(emptyService());
    const response = await handleDiscover(request("/api/catalog/discover", signedIn), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=60");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const body = (await response.json()) as { popularSets: Array<{ id: string }> };
    expect(body.popularSets[0]?.id).toBe("sv08");
  });

  it("propagates refreshed session cookies via Set-Cookie", async () => {
    const { deps } = makeDeps(emptyService());
    const response = await handleDiscover(
      request("/api/catalog/discover", `${REFRESH_TOKEN_COOKIE}=old-refresh`),
      deps,
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    expect(cookies[1]).toContain(`${REFRESH_TOKEN_COOKIE}=fresh-refresh`);
  });

  it("falls back to an empty payload (200) and warns when DATABASE_URL is missing", async () => {
    const { deps, log } = makeDeps(null);
    const response = await handleDiscover(request("/api/catalog/discover", signedIn), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ popularSets: [], featuredCards: [] });
    expect(log).toHaveBeenCalledWith(
      "catalog.database_url_missing",
      expect.objectContaining({ operation: "discover" }),
    );
  });

  it("answers 503 (without leaking SQL details) when the database fails", async () => {
    const service: CatalogSearchServiceShape = {
      ...emptyService(),
      discover: () =>
        Effect.fail(new DatabaseError({ message: "postgres query failed", cause: "secret" })),
    };
    const { deps, log } = makeDeps(service);
    const response = await handleDiscover(request("/api/catalog/discover", signedIn), deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("secret");
    expect(log).toHaveBeenCalledWith("catalog.query_failed", { operation: "discover" });
  });
});

describe("GET /api/catalog/suggest", () => {
  it("returns 401 without session", async () => {
    const service = emptyService();
    const { deps } = makeDeps(service);
    const response = await handleSuggest(request("/api/catalog/suggest?q=pika"), deps);
    expect(response.status).toBe(401);
    expect(service.suggest).not.toHaveBeenCalled();
  });

  it("forwards q to the service with Cache-Control: no-store", async () => {
    const service = emptyService();
    const { deps } = makeDeps(service);
    const response = await handleSuggest(
      request("/api/catalog/suggest?q=%20pika%20", signedIn),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(service.suggest).toHaveBeenCalledWith(" pika ");
    expect(await response.json()).toEqual({ query: "pika", cards: [], sets: [] });
  });

  it("treats a missing q as an empty query and falls back gracefully without database", async () => {
    const { deps, log } = makeDeps(null);
    const response = await handleSuggest(request("/api/catalog/suggest", signedIn), deps);
    expect(await response.json()).toEqual({ query: "", cards: [], sets: [] });
    expect(log).toHaveBeenCalledWith(
      "catalog.database_url_missing",
      expect.objectContaining({ operation: "suggest" }),
    );
  });

  it("propagates refreshed cookies", async () => {
    const { deps } = makeDeps(emptyService());
    const response = await handleSuggest(
      request("/api/catalog/suggest?q=a", `${REFRESH_TOKEN_COOKIE}=r`),
      deps,
    );
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
});

describe("GET /api/catalog/search", () => {
  it("returns 401 without session", async () => {
    const service = emptyService();
    const { deps } = makeDeps(service);
    const response = await handleSearch(request("/api/catalog/search?q=pika"), deps);
    expect(response.status).toBe(401);
    expect(service.search).not.toHaveBeenCalled();
  });

  it.each([
    "scope=everything",
    "sort=price",
    "quickAccess=cheap",
    "limit=0",
    "limit=61",
    "limit=abc",
    "limit=1.5",
    "offset=-1",
    `q=${"x".repeat(101)}`,
  ])("returns 400 for the invalid query %s", async (params) => {
    const service = emptyService();
    const { deps } = makeDeps(service);
    const response = await handleSearch(request(`/api/catalog/search?${params}`, signedIn), deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_query" });
    expect(service.search).not.toHaveBeenCalled();
  });

  it("decodes the full query string (defaults, numbers, ignored empty filters)", async () => {
    const service = emptyService();
    const { deps } = makeDeps(service);
    const response = await handleSearch(
      request(
        "/api/catalog/search?q=dracaufeu&scope=cards&quickAccess=sir&setId=sv03.5&sort=name&limit=12&offset=24",
        signedIn,
      ),
      deps,
    );
    expect(response.status).toBe(200);
    expect(service.search).toHaveBeenCalledWith({
      q: "dracaufeu",
      scope: "cards",
      quickAccess: "sir",
      setId: "sv03.5",
      sort: "name",
      limit: 12,
      offset: 24,
    });

    await handleSearch(request("/api/catalog/search?quickAccess=&setId=", signedIn), deps);
    expect(service.search).toHaveBeenLastCalledWith({
      q: "",
      scope: "all",
      sort: "relevance",
      limit: 24,
      offset: 0,
    });
  });

  it("returns the payload with refreshed cookies", async () => {
    const { deps } = makeDeps(emptyService());
    const response = await handleSearch(
      request("/api/catalog/search?q=mew", `${REFRESH_TOKEN_COOKIE}=r`),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    const body = (await response.json()) as { query: { q: string }; totalCards: number };
    expect(body.query.q).toBe("mew");
    expect(body.totalCards).toBe(0);
  });

  it("falls back to an empty payload without database (still validating the query)", async () => {
    const { deps, log } = makeDeps(null);
    const ok = await handleSearch(request("/api/catalog/search?q=mew", signedIn), deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ totalCards: 0, cards: [], sets: [] });
    expect(log).toHaveBeenCalledWith(
      "catalog.database_url_missing",
      expect.objectContaining({ operation: "search" }),
    );
    const bad = await handleSearch(request("/api/catalog/search?limit=0", signedIn), deps);
    expect(bad.status).toBe(400);
  });

  it("answers 503 when the database fails", async () => {
    const service: CatalogSearchServiceShape = {
      ...emptyService(),
      search: () => Effect.fail(new DatabaseError({ message: "boom" })),
    };
    const { deps } = makeDeps(service);
    const response = await handleSearch(request("/api/catalog/search?q=mew", signedIn), deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "catalog_unavailable" });
  });
});
