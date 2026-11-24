import {
  type Binder,
  BinderConflictError,
  type BinderSummary,
  buildCollectionOverview,
  CatalogItemNotFoundError,
  type CollectionOverview,
  ValidationError,
} from "@pokevault/domain";
import {
  type BinderServiceShape,
  type CollectionServiceShape,
  DatabaseError,
} from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import {
  type BindersCatalogShape,
  type BindersServerDeps,
  handleBinderCover,
  handleCreateBinder,
  handleListBinders,
} from "./binders-server.ts";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const BINDER_ID = "33333333-3333-4333-8333-333333333333";
const COVER_PATH = `${USER_ID}/${BINDER_ID}.webp`;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const gotrueUser = {
  id: USER_ID,
  email: "ada@pokevault.test",
  app_metadata: { provider: "google" },
};

/** GoTrue factice : `valid` / `fresh` acceptés ; le refresh renvoie `fresh`. */
const gotrue = (url: string, init?: RequestInit): Response => {
  if (url.endsWith("/user")) {
    const bearer = new Headers(init?.headers).get("Authorization");
    return bearer === "Bearer fresh" || bearer === "Bearer valid"
      ? jsonResponse(gotrueUser)
      : jsonResponse({}, 401);
  }
  return jsonResponse({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 });
};

const binderRow = (overrides: Partial<Binder> = {}): Binder => ({
  id: BINDER_ID,
  userId: USER_ID,
  kind: "custom",
  setId: null,
  title: "Évolitions Favs",
  coverType: "set_logo",
  coverCardId: null,
  coverStoragePath: null,
  isPinned: false,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const summaryOf = (binder: Binder): BinderSummary => ({
  binder,
  set: null,
  completion: null,
  cardCount: 0,
  ownedCount: 0,
});

const emptyOverview = (): CollectionOverview =>
  buildCollectionOverview({ series: [], sets: [], copies: [], trackedSetIds: new Set() });

interface Harness {
  readonly deps: BindersServerDeps;
  readonly binders: Record<
    "listBinders" | "getBinder" | "createSetBinder" | "createCustomBinder",
    ReturnType<typeof vi.fn>
  >;
  readonly catalog: { [K in keyof BindersCatalogShape]: ReturnType<typeof vi.fn> };
  readonly collection: { getCollectionOverview: ReturnType<typeof vi.fn> };
  readonly log: ReturnType<typeof vi.fn>;
  readonly storageFetch: ReturnType<typeof vi.fn>;
}

const makeHarness = (
  options: {
    readonly noDatabase?: boolean;
    readonly list?: ReadonlyArray<BinderSummary>;
    readonly storage?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  } = {},
): Harness => {
  const list = options.list ?? [summaryOf(binderRow())];
  const binders = {
    listBinders: vi.fn(() => Effect.succeed(list)),
    getBinder: vi.fn((_userId: string, binderId: string) => {
      const found = list.find(({ binder }) => binder.id === binderId);
      return found === undefined
        ? Effect.fail({ _tag: "BinderNotFoundError", binderId, message: "nope" })
        : Effect.succeed(found);
    }),
    createSetBinder: vi.fn((_userId: string, input: { setId: string }) =>
      Effect.succeed(
        summaryOf(binderRow({ kind: "set", setId: input.setId, title: "Étincelles Déferlantes" })),
      ),
    ),
    createCustomBinder: vi.fn((_userId: string, input: { title: string }) =>
      Effect.succeed(summaryOf(binderRow({ title: input.title }))),
    ),
  };
  const catalog = {
    coverCardImages: vi.fn((ids: ReadonlyArray<string>) =>
      Effect.succeed(Object.fromEntries(ids.map((id) => [id, `https://img.test/${id}`]))),
    ),
    listSets: vi.fn(() => Effect.succeed([])),
  };
  const collection = { getCollectionOverview: vi.fn(() => Effect.succeed(emptyOverview())) };
  const log = vi.fn();
  const storageFetch = vi.fn(
    options.storage ?? (() => new Response("webp-bytes", { status: 200 })),
  );
  const deps: BindersServerDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    services: options.noDatabase
      ? null
      : {
          binders: binders as unknown as BinderServiceShape,
          collection: collection as unknown as CollectionServiceShape,
          catalog: catalog as unknown as BindersCatalogShape,
        },
    storage: {
      baseUrl: "http://storage:5000",
      anonKey: "anon-key",
      fetch: async (url, init) => storageFetch(url, init),
    },
    log,
  };
  return { deps, binders, catalog, collection, log, storageFetch };
};

const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;

const get = (path: string, cookie?: string): Request =>
  new Request(`http://localhost:3000${path}`, cookie === undefined ? {} : { headers: { cookie } });

const post = (
  body: unknown,
  options: { cookie?: string; origin?: string | null; raw?: string } = {},
): Request => {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.origin !== null) headers.set("origin", options.origin ?? "http://localhost:3000");
  return new Request("http://localhost:3000/api/binders", {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
};

describe("GET /api/binders", () => {
  it("returns 401 without session and never touches the database", async () => {
    const h = makeHarness();
    const response = await handleListBinders(get("/api/binders"), h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.binders.listBinders).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired token", async () => {
    const h = makeHarness();
    const response = await handleListBinders(
      get("/api/binders", `${ACCESS_TOKEN_COOKIE}=expired`),
      h.deps,
    );
    expect(response.status).toBe(401);
  });

  it("returns the structured payload scoped to the session user", async () => {
    const withCard = summaryOf(
      binderRow({
        id: "44444444-4444-4444-8444-444444444444",
        coverType: "card",
        coverCardId: "sv03.5-199",
      }),
    );
    const h = makeHarness({ list: [summaryOf(binderRow()), withCard] });
    const response = await handleListBinders(get("/api/binders", signedIn), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as {
      binders: Array<{ binder: { id: string } }>;
      overview: CollectionOverview;
      coverCardImageById: Record<string, string | null>;
      catalogSets: unknown[];
    };
    expect(body.binders).toHaveLength(2);
    expect(body.overview.global.trackedSetCount).toBe(0);
    expect(body.catalogSets).toEqual([]);
    expect(h.binders.listBinders).toHaveBeenCalledWith(USER_ID);
    expect(h.collection.getCollectionOverview).toHaveBeenCalledWith(USER_ID);
    // Seules les covers `card` sont résolues, une fois chacune.
    expect(h.catalog.coverCardImages).toHaveBeenCalledWith(["sv03.5-199"]);
    expect(body.coverCardImageById).toEqual({ "sv03.5-199": "https://img.test/sv03.5-199" });
  });

  it("propagates refreshed session cookies via Set-Cookie with Cache-Control: no-store", async () => {
    const h = makeHarness();
    const response = await handleListBinders(
      get("/api/binders", `${REFRESH_TOKEN_COOKIE}=old-refresh`),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    expect(cookies[1]).toContain(`${REFRESH_TOKEN_COOKIE}=fresh-refresh`);
  });

  it("falls back to an empty payload (200) and logs when DATABASE_URL is missing", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleListBinders(get("/api/binders", signedIn), h.deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      binders: unknown[];
      overview: CollectionOverview;
      coverCardImageById: object;
    };
    expect(body.binders).toEqual([]);
    expect(body.overview.series).toEqual([]);
    expect(body.coverCardImageById).toEqual({});
    expect(h.log).toHaveBeenCalledWith(
      "binders.database_url_missing",
      expect.objectContaining({ operation: "list" }),
    );
  });

  it("answers 503 without leaking SQL details when the database fails", async () => {
    const h = makeHarness();
    h.binders.listBinders.mockReturnValue(
      Effect.fail(new DatabaseError({ message: "select * from secret", cause: { code: "08006" } })),
    );
    const response = await handleListBinders(get("/api/binders", signedIn), h.deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toEqual({ error: "binders_unavailable" });
    expect(h.log).toHaveBeenCalledWith("binders.query_failed", {
      operation: "list",
      errorTag: "DatabaseError",
      pgCode: "08006",
    });
  });
});

describe("POST /api/binders", () => {
  it("returns 403 for a cross-origin request before touching anything", async () => {
    const h = makeHarness();
    const response = await handleCreateBinder(
      post({ kind: "custom", title: "X" }, { cookie: signedIn, origin: "https://evil.example" }),
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(h.binders.createCustomBinder).not.toHaveBeenCalled();
  });

  it("returns 401 without session", async () => {
    const h = makeHarness();
    const response = await handleCreateBinder(post({ kind: "custom", title: "X" }), h.deps);
    expect(response.status).toBe(401);
    expect(h.binders.createCustomBinder).not.toHaveBeenCalled();
  });

  it("creates a custom binder (201) for the session user and drops unknown fields", async () => {
    const h = makeHarness();
    const response = await handleCreateBinder(
      post(
        { kind: "custom", title: "Doublons Échange", isPinned: true, userId: OTHER_USER_ID },
        { cookie: signedIn },
      ),
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as BinderSummary;
    expect(body.binder.title).toBe("Doublons Échange");
    expect(h.binders.createCustomBinder).toHaveBeenCalledWith(USER_ID, {
      title: "Doublons Échange",
      isPinned: true,
    });
  });

  it("follows a set with ifExists: fail so a duplicate yields 409", async () => {
    const h = makeHarness();
    const response = await handleCreateBinder(
      post({ kind: "set", setId: "sv08" }, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(h.binders.createSetBinder).toHaveBeenCalledWith(USER_ID, {
      setId: "sv08",
      ifExists: "fail",
    });
  });

  it("accepts a request without Origin/Referer (non-browser client)", async () => {
    const h = makeHarness();
    const response = await handleCreateBinder(
      post({ kind: "custom", title: "Ok" }, { cookie: signedIn, origin: null }),
      h.deps,
    );
    expect(response.status).toBe(201);
  });

  it.each([
    ["unknown kind", { kind: "other", title: "X" }],
    ["array body", []],
    ["null body", null],
    ["missing kind", { title: "X" }],
  ])("returns 400 for %s", async (_name, body) => {
    const h = makeHarness();
    const response = await handleCreateBinder(post(body, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
  });

  it("returns 400 for malformed JSON and oversized bodies", async () => {
    const h = makeHarness();
    const malformed = await handleCreateBinder(
      post(null, { cookie: signedIn, raw: "{nope" }),
      h.deps,
    );
    expect(malformed.status).toBe(400);
    const huge = await handleCreateBinder(
      post(null, {
        cookie: signedIn,
        raw: JSON.stringify({ kind: "custom", title: "x".repeat(5000) }),
      }),
      h.deps,
    );
    expect(huge.status).toBe(400);
    expect(h.binders.createCustomBinder).not.toHaveBeenCalled();
  });

  it("maps a domain ValidationError to 400", async () => {
    const h = makeHarness();
    h.binders.createCustomBinder.mockReturnValue(
      Effect.fail(new ValidationError({ message: "title" })),
    );
    const response = await handleCreateBinder(
      post({ kind: "custom", title: "" }, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(400);
  });

  it("maps CatalogItemNotFoundError to 404", async () => {
    const h = makeHarness();
    h.binders.createSetBinder.mockReturnValue(
      Effect.fail(new CatalogItemNotFoundError({ entity: "set", id: "zz", message: "no set" })),
    );
    const response = await handleCreateBinder(
      post({ kind: "set", setId: "zz" }, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("maps BinderConflictError to 409", async () => {
    const h = makeHarness();
    h.binders.createSetBinder.mockReturnValue(
      Effect.fail(new BinderConflictError({ message: "exists", setId: "sv08" })),
    );
    const response = await handleCreateBinder(
      post({ kind: "set", setId: "sv08" }, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "binder_exists" });
  });

  it("answers 503 without leaking details on database failure", async () => {
    const h = makeHarness();
    h.binders.createCustomBinder.mockReturnValue(
      Effect.fail(new DatabaseError({ message: "insert into secret_table" })),
    );
    const response = await handleCreateBinder(
      post({ kind: "custom", title: "X" }, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret_table");
  });

  it("answers 503 (never a 500) when no database is configured", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleCreateBinder(
      post({ kind: "custom", title: "X" }, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(h.log).toHaveBeenCalledWith(
      "binders.database_url_missing",
      expect.objectContaining({ operation: "create" }),
    );
  });

  it("propagates refreshed cookies on success", async () => {
    const h = makeHarness();
    const response = await handleCreateBinder(
      post({ kind: "custom", title: "X" }, { cookie: `${REFRESH_TOKEN_COOKIE}=old` }),
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
});

describe("GET /api/binders/$id/cover", () => {
  const uploaded = (overrides: Partial<Binder> = {}): BinderSummary =>
    summaryOf(binderRow({ coverType: "upload", coverStoragePath: COVER_PATH, ...overrides }));

  const coverRequest = (cookie?: string): Request =>
    get(`/api/binders/${BINDER_ID}/cover?v=1`, cookie);

  it("returns 401 without session and never calls the Storage", async () => {
    const h = makeHarness({ list: [uploaded()] });
    const response = await handleBinderCover(coverRequest(), BINDER_ID, h.deps);
    expect(response.status).toBe(401);
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it("streams the private object with the user's JWT and hardened headers", async () => {
    const h = makeHarness({
      list: [uploaded()],
      storage: () =>
        new Response("webp-bytes", { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(await response.text()).toBe("webp-bytes");
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.storageFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://storage:5000/object/binder-covers/${COVER_PATH}`);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer valid");
    expect(headers.get("apikey")).toBe("anon-key");
    expect(h.binders.getBinder).toHaveBeenCalledWith(USER_ID, BINDER_ID);
  });

  it("uses no-store and forwards Set-Cookie when the session was refreshed", async () => {
    const h = makeHarness({ list: [uploaded()] });
    const response = await handleBinderCover(
      coverRequest(`${REFRESH_TOKEN_COOKIE}=old`),
      BINDER_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toHaveLength(2);
    const [, init] = h.storageFetch.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fresh");
  });

  it("returns 404 for an unknown / foreign binder (indistinguishable)", async () => {
    const h = makeHarness({ list: [] });
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(404);
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["not an upload cover", uploaded({ coverType: "set_logo" })],
    ["no storage path", uploaded({ coverStoragePath: null })],
    [
      "a path of another user",
      uploaded({ coverStoragePath: `${OTHER_USER_ID}/${BINDER_ID}.webp` }),
    ],
    ["a traversal path", uploaded({ coverStoragePath: `${USER_ID}/../${OTHER_USER_ID}/x.webp` })],
    ["another owner", uploaded({ userId: OTHER_USER_ID })],
  ])("returns 404 when the binder has %s", async (_name, summary) => {
    const h = makeHarness({ list: [summary] });
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(404);
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-UUID identifier without any lookup", async () => {
    const h = makeHarness({ list: [uploaded()] });
    const response = await handleBinderCover(
      get("/api/binders/..%2Fetc/cover", signedIn),
      "../etc",
      h.deps,
    );
    expect(response.status).toBe(404);
    expect(h.binders.getBinder).not.toHaveBeenCalled();
  });

  it("returns 404 when the Storage reports the object missing", async () => {
    const h = makeHarness({
      list: [uploaded()],
      storage: () => new Response("{}", { status: 400 }),
    });
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(404);
  });

  it("returns 502 when the Storage fails or is unreachable", async () => {
    const failing = makeHarness({
      list: [uploaded()],
      storage: () => new Response("x", { status: 500 }),
    });
    expect((await handleBinderCover(coverRequest(signedIn), BINDER_ID, failing.deps)).status).toBe(
      502,
    );

    const down = makeHarness({
      list: [uploaded()],
      storage: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect((await handleBinderCover(coverRequest(signedIn), BINDER_ID, down.deps)).status).toBe(
      502,
    );
  });

  it("refuses an oversized upstream object", async () => {
    const h = makeHarness({
      list: [uploaded()],
      storage: () =>
        new Response("x", { status: 200, headers: { "Content-Length": String(3 * 1024 * 1024) } }),
    });
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(502);
  });

  it("returns 404 (not 500) when no database is configured", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(404);
  });

  it("answers 503 when the lookup hits a database failure", async () => {
    const h = makeHarness({ list: [uploaded()] });
    h.binders.getBinder.mockReturnValue(Effect.fail(new DatabaseError({ message: "boom" })));
    const response = await handleBinderCover(coverRequest(signedIn), BINDER_ID, h.deps);
    expect(response.status).toBe(503);
  });
});
