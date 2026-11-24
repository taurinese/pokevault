import {
  CatalogItemNotFoundError,
  ValidationError,
  type WishlistItem,
  WishlistItemConflictError,
  WishlistItemNotFoundError,
  WishlistQuantityOverflowError,
} from "@pokevault/domain";
import type { Sql, WishlistServiceShape } from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import {
  handleAcquireWishlistItem,
  handleAddWishlistItem,
  handleDeleteWishlistItem,
  handleListWishlist,
  handleUpdateWishlistItem,
  MAX_BODY_BYTES,
  readJsonBody,
  type WishlistServerDeps,
} from "./wishlist-server.ts";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "77777777-7777-4777-8777-777777777777";
const COPY_ID = "55555555-5555-4555-8555-555555555555";
const BINDER_ID = "33333333-3333-4333-8333-333333333333";
const CARD_ID = "sv03.5-199";

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

const itemFixture = (overrides: Partial<WishlistItem> = {}): WishlistItem => ({
  id: ITEM_ID,
  userId: USER_ID,
  cardId: CARD_ID,
  language: "FR",
  variant: "holo",
  minCondition: "NM",
  priority: "normal",
  targetPriceCents: 1500,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const enrichedRow = {
  id: ITEM_ID,
  user_id: USER_ID,
  card_id: CARD_ID,
  language: "FR",
  variant: "holo",
  min_condition: "NM",
  priority: "high",
  target_price_cents: 1500,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: "2026-01-02T00:00:00.000Z",
  local_id: "199",
  name_fr: "Dracaufeu ex",
  name_en: "Charizard ex",
  rarity: "Rare secrète",
  image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  set_id: "sv03.5",
  set_code: "SV03.5",
  cardmarket_set_code: "MEW",
  set_name_fr: "151",
  trend_cents: 1700,
  low_fr_cents: 1400,
  avg30_cents: 1650,
  price_source: "cardmarket",
  price_fetched_at: new Date("2026-01-03T10:00:00.000Z"),
  price_expires_at: "2026-01-03T10:15:00.000Z",
  price_is_fresh: true,
};

/**
 * SQL factice : `begin` rejoue la transaction sur le même template, et chaque
 * requête reçoit sa réponse du `responder` (routé sur le contenu de la requête).
 */
const makeSql = (
  responder: (query: string, values: unknown[]) => unknown,
): { sql: Sql; queries: string[]; values: unknown[][] } => {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const fn = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    values.push(params);
    try {
      return Promise.resolve(responder(query, params));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const sql = Object.assign(fn, { begin: (cb: (tx: unknown) => Promise<unknown>) => cb(fn) });
  return { sql: sql as unknown as Sql, queries, values };
};

interface Harness {
  readonly deps: WishlistServerDeps;
  readonly wishlist: {
    addWishlistItem: ReturnType<typeof vi.fn>;
    updateWishlistItem: ReturnType<typeof vi.fn>;
    removeWishlistItem: ReturnType<typeof vi.fn>;
    markAcquired: ReturnType<typeof vi.fn>;
    listWishlistItems: ReturnType<typeof vi.fn>;
  };
  readonly log: ReturnType<typeof vi.fn>;
  readonly queries: string[];
  readonly values: unknown[][];
}

const makeHarness = (
  options: {
    readonly noDatabase?: boolean;
    readonly responder?: (query: string, values: unknown[]) => unknown;
  } = {},
): Harness => {
  const wishlist = {
    listWishlistItems: vi.fn(() => Effect.succeed([])),
    addWishlistItem: vi.fn((_userId: string, input: unknown) =>
      Effect.succeed(itemFixture({ cardId: (input as { cardId: string }).cardId })),
    ),
    updateWishlistItem: vi.fn((_userId: string, _itemId: string, patch: unknown) =>
      Effect.succeed(itemFixture(patch as Partial<WishlistItem>)),
    ),
    removeWishlistItem: vi.fn(() => Effect.succeed(undefined)),
    markAcquired: vi.fn((_userId: string, input: { wishlistItemId: string }) =>
      Effect.succeed({
        removedWishlistItemId: input.wishlistItemId,
        copy: { id: COPY_ID, cardId: CARD_ID, quantity: 1 },
        setBinderId: BINDER_ID,
      }),
    ),
  };
  const log = vi.fn();
  const { sql, queries, values } = makeSql(options.responder ?? (() => [enrichedRow]));
  const deps: WishlistServerDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    services: options.noDatabase
      ? null
      : { wishlist: wishlist as unknown as WishlistServiceShape, sql },
    log,
  };
  return { deps, wishlist, log, queries, values };
};

const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;

const req = (
  method: string,
  path: string,
  options: {
    readonly cookie?: string;
    readonly origin?: string | null;
    readonly body?: unknown;
    readonly raw?: string;
    readonly contentLength?: string;
  } = {},
): Request => {
  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.origin !== null) headers.set("origin", options.origin ?? "http://localhost:3000");
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  const bodyText =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (bodyText !== undefined) headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (bodyText !== undefined) init.body = bodyText;
  return new Request(`http://localhost:3000${path}`, init);
};

const streamRequest = (method: string, path: string, stream: ReadableStream<Uint8Array>) =>
  new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      cookie: signedIn,
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit);

const API = "/api/wishlist";
const ITEM_API = `/api/wishlist/${ITEM_ID}`;

// ---------------------------------------------------------------------------
// GET /api/wishlist
// ---------------------------------------------------------------------------

describe("GET /api/wishlist", () => {
  it("returns 401 + no-store without a session and never touches the database", async () => {
    const h = makeHarness();
    const response = await handleListWishlist(req("GET", API), h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.queries).toHaveLength(0);
  });

  it("returns the enriched items (card, set, latest price) with private no-store", async () => {
    const h = makeHarness();
    const response = await handleListWishlist(req("GET", API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as { items: ReadonlyArray<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: ITEM_ID,
      userId: USER_ID,
      cardId: CARD_ID,
      language: "FR",
      variant: "holo",
      minCondition: "NM",
      priority: "high",
      targetPriceCents: 1500,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      localId: "199",
      nameFr: "Dracaufeu ex",
      nameEn: "Charizard ex",
      rarity: "Rare secrète",
      imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
      setId: "sv03.5",
      setCode: "SV03.5",
      cardmarketSetCode: "MEW",
      setNameFr: "151",
      trendCents: 1700,
      lowFrCents: 1400,
      avg30Cents: 1650,
      priceSource: "cardmarket",
      priceFetchedAt: "2026-01-03T10:00:00.000Z",
      priceExpiresAt: "2026-01-03T10:15:00.000Z",
      priceIsFresh: true,
    });
  });

  it("joins the wishlist with the catalog and card_latest_prices, scoped by user, sorted priority ASC then newest", async () => {
    const h = makeHarness();
    await handleListWishlist(req("GET", API, { cookie: signedIn }), h.deps);
    const index = h.queries.findIndex((q) => q.includes("from public.wishlist_items"));
    expect(index).toBeGreaterThanOrEqual(0);
    const query = (h.queries[index] ?? "").replace(/\s+/g, " ");
    expect(query).toContain("from public.wishlist_items w");
    expect(query).toContain("join public.catalog_cards c on c.id = w.card_id");
    expect(query).toContain("join public.catalog_sets s on s.id = c.set_id");
    expect(query).toContain("public.card_latest_prices");
    expect(query).toMatch(/left join lateral/);
    expect(query).toContain("lp.card_id = w.card_id");
    expect(query).toContain("lp.language = w.language");
    expect(query).toContain("lp.variant = w.variant");
    expect(query).toContain("limit 1");
    expect(query).toContain("w.user_id = ?");
    expect(query).toContain("order by w.priority asc, w.created_at desc");
    // Défense en profondeur : le user_id de la session est bien passé en paramètre.
    expect(h.values[index]).toContain(USER_ID);
  });

  it("returns null price fields when card_latest_prices has no snapshot for the slot", async () => {
    const h = makeHarness({
      responder: (query) =>
        query.includes("from public.wishlist_items")
          ? [
              {
                ...enrichedRow,
                trend_cents: null,
                low_fr_cents: null,
                avg30_cents: null,
                price_source: null,
                price_fetched_at: null,
                price_expires_at: null,
                price_is_fresh: null,
              },
            ]
          : [],
    });
    const response = await handleListWishlist(req("GET", API, { cookie: signedIn }), h.deps);
    const body = (await response.json()) as { items: ReadonlyArray<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      trendCents: null,
      lowFrCents: null,
      avg30Cents: null,
      priceSource: null,
      priceFetchedAt: null,
      priceExpiresAt: null,
      priceIsFresh: null,
    });
  });

  it("returns an empty list for an empty wishlist", async () => {
    const h = makeHarness({ responder: () => [] });
    const response = await handleListWishlist(req("GET", API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("propagates refreshed session cookies via Set-Cookie", async () => {
    const h = makeHarness();
    const response = await handleListWishlist(
      req("GET", API, { cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });

  it("returns 503 without DATABASE_URL (services null), keeping the cookies", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleListWishlist(
      req("GET", API, { cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "wishlist_unavailable" });
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
    expect(h.log).toHaveBeenCalledWith(
      "wishlist.database_url_missing",
      expect.objectContaining({ operation: "list" }),
    );
  });

  it("returns 503 without any SQL detail when the query fails", async () => {
    const h = makeHarness({
      responder: () => {
        throw Object.assign(new Error("boom: select * from secrets"), { code: "42P01" });
      },
    });
    const response = await handleListWishlist(req("GET", API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    expect(text).toBe('{"error":"wishlist_unavailable"}');
    expect(text).not.toMatch(/select|secrets|boom|42P01/i);
    expect(JSON.stringify(h.log.mock.calls)).not.toMatch(/select \*|secrets/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/wishlist
// ---------------------------------------------------------------------------

describe("POST /api/wishlist", () => {
  const body = { cardId: CARD_ID, language: "FR", variant: "holo", targetPriceCents: 1500 };

  it("returns 403 for a cross-origin request before any work", async () => {
    const h = makeHarness();
    const response = await handleAddWishlistItem(
      req("POST", API, { cookie: signedIn, origin: "https://evil.example", body }),
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(h.wishlist.addWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 401 + no-store without a session", async () => {
    const h = makeHarness();
    const response = await handleAddWishlistItem(req("POST", API, { body }), h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.wishlist.addWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 201 + the created item and calls the service as the session user", async () => {
    const h = makeHarness();
    const response = await handleAddWishlistItem(
      req("POST", API, { cookie: signedIn, body }),
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(((await response.json()) as WishlistItem).cardId).toBe(CARD_ID);
    expect(h.wishlist.addWishlistItem).toHaveBeenCalledWith(USER_ID, body);
  });

  it("returns 400 for a ValidationError, 404 for an unknown card and 409 on a duplicate slot", async () => {
    const cases: ReadonlyArray<readonly [unknown, number, string]> = [
      [new ValidationError({ message: "bad" }), 400, "invalid_input"],
      [
        new CatalogItemNotFoundError({ entity: "card", id: CARD_ID, message: "nope" }),
        404,
        "not_found",
      ],
      [new WishlistItemConflictError({ message: "dup" }), 409, "conflict"],
    ];
    for (const [failure, status, error] of cases) {
      const h = makeHarness();
      h.wishlist.addWishlistItem.mockReturnValueOnce(Effect.fail(failure));
      const response = await handleAddWishlistItem(
        req("POST", API, { cookie: signedIn, body }),
        h.deps,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("returns 400 for invalid JSON or a non-object body", async () => {
    const h = makeHarness();
    for (const raw of ["{oops", "[1,2]", ""]) {
      const response = await handleAddWishlistItem(
        req("POST", API, { cookie: signedIn, raw }),
        h.deps,
      );
      expect(response.status).toBe(400);
    }
    expect(h.wishlist.addWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 503 without SQL detail on an unexpected failure, and logs only safe metadata", async () => {
    const h = makeHarness();
    h.wishlist.addWishlistItem.mockReturnValueOnce(
      Effect.fail({ _tag: "DatabaseError", cause: { code: "08006", message: "secret sql" } }),
    );
    const response = await handleAddWishlistItem(
      req("POST", API, { cookie: signedIn, body }),
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "wishlist_unavailable" });
    expect(h.log).toHaveBeenCalledWith(
      "wishlist.query_failed",
      expect.objectContaining({ operation: "add", errorTag: "DatabaseError", pgCode: "08006" }),
    );
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("secret sql");
  });

  it("propagates refreshed cookies on success and on errors", async () => {
    const cookie = `${REFRESH_TOKEN_COOKIE}=refresh-old`;
    const ok = await handleAddWishlistItem(req("POST", API, { cookie, body }), makeHarness().deps);
    expect(ok.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
    const bad = await handleAddWishlistItem(
      req("POST", API, { cookie, raw: "{oops" }),
      makeHarness().deps,
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });
});

// ---------------------------------------------------------------------------
// Corps JSON borné
// ---------------------------------------------------------------------------

describe("bounded streamed JSON body (8 KiB)", () => {
  it("returns 413 when the declared content-length exceeds the cap", async () => {
    const h = makeHarness();
    const response = await handleAddWishlistItem(
      req("POST", API, {
        cookie: signedIn,
        contentLength: String(MAX_BODY_BYTES + 1),
        raw: "{}",
      }),
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(h.wishlist.addWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 413 when the raw body exceeds the cap", async () => {
    const h = makeHarness();
    const response = await handleUpdateWishlistItem(
      req("PATCH", ITEM_API, {
        cookie: signedIn,
        raw: `{"notes":"${"x".repeat(MAX_BODY_BYTES)}"}`,
      }),
      ITEM_ID,
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(h.wishlist.updateWishlistItem).not.toHaveBeenCalled();
  });

  it("aborts a chunked stream > 8 KiB without Content-Length and returns 413", async () => {
    const h = makeHarness();
    let cancelled = false;
    let chunksEmitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksEmitted += 1;
        controller.enqueue(new Uint8Array(2048).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleAddWishlistItem(streamRequest("POST", API, stream), h.deps);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(chunksEmitted).toBeLessThanOrEqual(6);
    expect(h.wishlist.addWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 400 (never 500) when reading a broken request stream fails", async () => {
    const h = makeHarness();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const response = await handleAcquireWishlistItem(
      streamRequest("POST", `${ITEM_API}/acquire`, stream),
      ITEM_ID,
      h.deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
    expect(h.wishlist.markAcquired).not.toHaveBeenCalled();
  });

  it("readJsonBody counts real bytes (multi-byte characters), not string length", async () => {
    // 3 000 × « é » = 6 000 caractères mais 6 000 octets ; 5 000 × « € » = 15 000 octets.
    const ok = await readJsonBody(
      req("POST", API, { raw: JSON.stringify({ a: "é".repeat(3000) }) }),
    );
    expect(ok.ok).toBe(true);
    const tooBig = await readJsonBody(
      req("POST", API, { raw: JSON.stringify({ a: "€".repeat(5000) }) }),
    );
    expect(tooBig).toEqual({ ok: false, status: 413 });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/wishlist/$id
// ---------------------------------------------------------------------------

describe("PATCH /api/wishlist/$id", () => {
  it("returns 403 cross-origin and 401 without a session", async () => {
    const h = makeHarness();
    const cross = await handleUpdateWishlistItem(
      req("PATCH", ITEM_API, {
        cookie: signedIn,
        origin: "https://evil.example",
        body: { priority: "high" },
      }),
      ITEM_ID,
      h.deps,
    );
    expect(cross.status).toBe(403);
    const anon = await handleUpdateWishlistItem(
      req("PATCH", ITEM_API, { body: { priority: "high" } }),
      ITEM_ID,
      h.deps,
    );
    expect(anon.status).toBe(401);
    expect(h.wishlist.updateWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 200 + the updated item", async () => {
    const h = makeHarness();
    const response = await handleUpdateWishlistItem(
      req("PATCH", ITEM_API, { cookie: signedIn, body: { priority: "high" } }),
      ITEM_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as WishlistItem).priority).toBe("high");
    expect(h.wishlist.updateWishlistItem).toHaveBeenCalledWith(USER_ID, ITEM_ID, {
      priority: "high",
    });
  });

  it("maps 400 / 404 / 409 from typed errors, and 404 for a non-UUID id without calling the service", async () => {
    const cases: ReadonlyArray<readonly [unknown, number]> = [
      [new ValidationError({ message: "bad" }), 400],
      [new WishlistItemNotFoundError({ itemId: ITEM_ID, message: "nf" }), 404],
      [new WishlistItemConflictError({ message: "dup" }), 409],
    ];
    for (const [failure, status] of cases) {
      const h = makeHarness();
      h.wishlist.updateWishlistItem.mockReturnValueOnce(Effect.fail(failure));
      const response = await handleUpdateWishlistItem(
        req("PATCH", ITEM_API, { cookie: signedIn, body: { variant: "reverse" } }),
        ITEM_ID,
        h.deps,
      );
      expect(response.status).toBe(status);
    }
    const h = makeHarness();
    const response = await handleUpdateWishlistItem(
      req("PATCH", "/api/wishlist/not-a-uuid", { cookie: signedIn, body: { priority: "high" } }),
      "not-a-uuid",
      h.deps,
    );
    expect(response.status).toBe(404);
    expect(h.wishlist.updateWishlistItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/wishlist/$id
// ---------------------------------------------------------------------------

describe("DELETE /api/wishlist/$id", () => {
  it("returns 403 cross-origin, 401 without a session", async () => {
    const h = makeHarness();
    expect(
      (
        await handleDeleteWishlistItem(
          req("DELETE", ITEM_API, { cookie: signedIn, origin: "https://evil.example" }),
          ITEM_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect((await handleDeleteWishlistItem(req("DELETE", ITEM_API), ITEM_ID, h.deps)).status).toBe(
      401,
    );
    expect(h.wishlist.removeWishlistItem).not.toHaveBeenCalled();
  });

  it("returns 204 with an empty body, no-store and refreshed cookies", async () => {
    const h = makeHarness();
    const response = await handleDeleteWishlistItem(
      req("DELETE", ITEM_API, { cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      ITEM_ID,
      h.deps,
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
    expect(h.wishlist.removeWishlistItem).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it("returns 404 for a missing item and for a non-UUID id", async () => {
    const h = makeHarness();
    h.wishlist.removeWishlistItem.mockReturnValueOnce(
      Effect.fail(new WishlistItemNotFoundError({ itemId: ITEM_ID, message: "nf" })),
    );
    const missing = await handleDeleteWishlistItem(
      req("DELETE", ITEM_API, { cookie: signedIn }),
      ITEM_ID,
      h.deps,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    const malformed = await handleDeleteWishlistItem(
      req("DELETE", "/api/wishlist/zzz", { cookie: signedIn }),
      "zzz",
      h.deps,
    );
    expect(malformed.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/wishlist/$id/acquire
// ---------------------------------------------------------------------------

describe("POST /api/wishlist/$id/acquire", () => {
  const path = `${ITEM_API}/acquire`;

  it("returns 403 cross-origin, 401 without a session", async () => {
    const h = makeHarness();
    expect(
      (
        await handleAcquireWishlistItem(
          req("POST", path, { cookie: signedIn, origin: "https://evil.example", body: {} }),
          ITEM_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleAcquireWishlistItem(req("POST", path, { body: {} }), ITEM_ID, h.deps)).status,
    ).toBe(401);
    expect(h.wishlist.markAcquired).not.toHaveBeenCalled();
  });

  it("accepts an empty body and `{}` and returns 200 + { removedWishlistItemId, copy, setBinderId }", async () => {
    for (const options of [{ cookie: signedIn }, { cookie: signedIn, body: {} }]) {
      const h = makeHarness();
      const response = await handleAcquireWishlistItem(req("POST", path, options), ITEM_ID, h.deps);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        removedWishlistItemId: ITEM_ID,
        copy: { id: COPY_ID, cardId: CARD_ID, quantity: 1 },
        setBinderId: BINDER_ID,
      });
      expect(h.wishlist.markAcquired).toHaveBeenCalledWith(USER_ID, { wishlistItemId: ITEM_ID });
    }
  });

  it("forwards optional fields but never lets the body override the URL item id", async () => {
    const h = makeHarness();
    const response = await handleAcquireWishlistItem(
      req("POST", path, {
        cookie: signedIn,
        body: {
          condition: "EX",
          quantity: 2,
          purchasePriceCents: 900,
          notes: "lot",
          wishlistItemId: "88888888-8888-4888-8888-888888888888",
        },
      }),
      ITEM_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(h.wishlist.markAcquired).toHaveBeenCalledWith(USER_ID, {
      wishlistItemId: ITEM_ID,
      condition: "EX",
      quantity: 2,
      purchasePriceCents: 900,
      notes: "lot",
    });
  });

  it("returns 400, 404 and 409 (quantity overflow) from typed errors", async () => {
    const cases: ReadonlyArray<readonly [unknown, number]> = [
      [new ValidationError({ message: "bad" }), 400],
      [new WishlistItemNotFoundError({ itemId: ITEM_ID, message: "nf" }), 404],
      [
        new WishlistQuantityOverflowError({
          cardId: CARD_ID,
          currentQuantity: 999,
          requestedDelta: 1,
          maxQuantity: 999,
          message: "overflow",
        }),
        409,
      ],
    ];
    for (const [failure, status] of cases) {
      const h = makeHarness();
      h.wishlist.markAcquired.mockReturnValueOnce(Effect.fail(failure));
      const response = await handleAcquireWishlistItem(
        req("POST", path, { cookie: signedIn, body: {} }),
        ITEM_ID,
        h.deps,
      );
      expect(response.status).toBe(status);
    }
  });

  it("returns 400 for a non-object body and 404 for a non-UUID id", async () => {
    const h = makeHarness();
    const array = await handleAcquireWishlistItem(
      req("POST", path, { cookie: signedIn, raw: "[1]" }),
      ITEM_ID,
      h.deps,
    );
    expect(array.status).toBe(400);
    const malformed = await handleAcquireWishlistItem(
      req("POST", "/api/wishlist/x/acquire", { cookie: signedIn, body: {} }),
      "x",
      h.deps,
    );
    expect(malformed.status).toBe(404);
    expect(h.wishlist.markAcquired).not.toHaveBeenCalled();
  });

  it("returns 503 without a database", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleAcquireWishlistItem(
      req("POST", path, { cookie: signedIn, body: {} }),
      ITEM_ID,
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "wishlist_unavailable" });
  });
});
