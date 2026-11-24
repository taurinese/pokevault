import {
  BinderNotFoundError,
  CardCopyConflictError,
  CardCopyNotFoundError,
  CatalogItemNotFoundError,
  PriceCircuitOpenError,
  PriceRefreshCooldownError,
  type PriceRefreshTarget,
  type PriceSnapshot,
  UnauthorizedBinderAccess,
  type UserCardCopy,
  ValidationError,
} from "@pokevault/domain";
import type {
  BinderServiceShape,
  CardmarketPriceServiceShape,
  CollectionServiceShape,
  PriceRefreshResult,
  Sql,
} from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import {
  type CardDetailServerDeps,
  type CardPriceRefreshDeps,
  handleAddCardCopy,
  handleCardBinder,
  handleCardDetail,
  handleCardPriceRefresh,
  handleDeleteCardCopy,
  handlePatchCardCopy,
  MAX_BODY_BYTES,
  PRICE_REFRESH_MAX_BODY_BYTES,
} from "./card-detail-server.ts";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
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

const cardRow = {
  id: CARD_ID,
  set_id: "sv03.5",
  local_id: "199",
  name_fr: "Dracaufeu ex",
  name_en: "Charizard ex",
  rarity: "Rare secrète",
  holo_effect: "sir",
  category: "Pokemon",
  types: ["Feu"],
  hp: 330,
  illustrator: "takuyoa",
  image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  available_variants: ["normal", "reverse", "holo"],
  cardmarket_url: "https://www.cardmarket.com/fr/Pokemon/Products/123",
  set_name_fr: "Prisme Évolutif",
  set_code: "SV03.5",
  set_official_count: 197,
  set_total_count: 207,
};

const copyFixture = (overrides: Partial<UserCardCopy> = {}): UserCardCopy => ({
  id: COPY_ID,
  userId: USER_ID,
  cardId: CARD_ID,
  language: "FR",
  variant: "holo",
  condition: "NM",
  quantity: 2,
  purchasePriceCents: 1250,
  gradingCompany: null,
  gradingScore: null,
  notes: null,
  acquiredAt: "2026-01-01",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/**
 * SQL factice : `begin` rejoue la transaction sur le même template, et chaque
 * requête reçoit sa réponse du `responder` (routé sur le contenu de la requête).
 */
const makeSql = (responder: (query: string) => unknown): { sql: Sql; queries: string[] } => {
  const queries: string[] = [];
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    return Promise.resolve(responder(query));
  };
  const sql = Object.assign(fn, { begin: (cb: (tx: unknown) => Promise<unknown>) => cb(fn) });
  return { sql: sql as unknown as Sql, queries };
};

const defaultResponder = (query: string): unknown => {
  if (query.includes("from public.catalog_cards")) return [cardRow];
  if (query.includes("from public.binders")) {
    return [
      { id: BINDER_ID, title: "Évolutions Favs", contains_card: true },
      { id: "66666666-6666-4666-8666-666666666666", title: "Doublons", contains_card: false },
    ];
  }
  return [];
};

interface Harness {
  readonly deps: CardDetailServerDeps;
  readonly collection: {
    listCardCopies: ReturnType<typeof vi.fn>;
    upsertCardCopy: ReturnType<typeof vi.fn>;
    adjustCardCopyQuantity: ReturnType<typeof vi.fn>;
    updateCardCopy: ReturnType<typeof vi.fn>;
    deleteCardCopy: ReturnType<typeof vi.fn>;
  };
  readonly binders: {
    addCardToCustomBinder: ReturnType<typeof vi.fn>;
    removeCardFromCustomBinder: ReturnType<typeof vi.fn>;
  };
  readonly log: ReturnType<typeof vi.fn>;
  readonly queries: string[];
}

const makeHarness = (
  options: {
    readonly noDatabase?: boolean;
    readonly responder?: (query: string) => unknown;
    readonly copies?: ReadonlyArray<UserCardCopy>;
  } = {},
): Harness => {
  const collection = {
    listCardCopies: vi.fn((_userId: string, _filter?: unknown) =>
      Effect.succeed(options.copies ?? [copyFixture()]),
    ),
    upsertCardCopy: vi.fn((_userId: string, input: unknown) =>
      Effect.succeed(copyFixture({ cardId: (input as { cardId: string }).cardId })),
    ),
    adjustCardCopyQuantity: vi.fn((_userId: string, _copyId: string, delta: number) =>
      Effect.succeed(copyFixture({ quantity: 2 + delta })),
    ),
    updateCardCopy: vi.fn((_userId: string, _copyId: string, _patch: unknown) =>
      Effect.succeed(copyFixture()),
    ),
    deleteCardCopy: vi.fn(() => Effect.succeed(undefined)),
  };
  const binders = {
    addCardToCustomBinder: vi.fn((_userId: string, binderId: string, cardId: string) =>
      Effect.succeed({
        binderId,
        cardId,
        position: 0,
        addedAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
    removeCardFromCustomBinder: vi.fn(() => Effect.succeed(undefined)),
  };
  const log = vi.fn();
  const { sql, queries } = makeSql(options.responder ?? defaultResponder);
  const deps: CardDetailServerDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    services: options.noDatabase
      ? null
      : {
          collection: collection as unknown as CollectionServiceShape,
          binders: binders as unknown as BinderServiceShape,
          sql,
        },
    log,
  };
  return { deps, collection, binders, log, queries };
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

const get = (path: string, cookie?: string): Request =>
  req("GET", path, cookie === undefined ? {} : { cookie });

// ---------------------------------------------------------------------------
// GET /api/cards/$cardId
// ---------------------------------------------------------------------------

describe("GET /api/cards/$cardId", () => {
  it("returns 401 without a session and never touches the database", async () => {
    const h = makeHarness();
    const response = await handleCardDetail(get(`/api/cards/${CARD_ID}`), CARD_ID, h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.collection.listCardCopies).not.toHaveBeenCalled();
    expect(h.queries).toHaveLength(0);
  });

  it("returns 404 for an unknown card", async () => {
    const h = makeHarness({ responder: () => [] });
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    // Exemplaires jamais chargés si la carte est inconnue (listCardCopies tourne en parallèle
    // mais le 404 est prioritaire) ; la requête catalogue a bien eu lieu.
    expect(h.queries.some((q) => q.includes("from public.catalog_cards"))).toBe(true);
  });

  it("returns 404 for a malformed card id without hitting the database", async () => {
    const h = makeHarness();
    const response = await handleCardDetail(get("/api/cards/x", signedIn), "sv 03.5", h.deps);
    expect(response.status).toBe(404);
    expect(h.queries).toHaveLength(0);
  });

  it("returns the full payload: TCGdex metadata, copies and custom binders with containsCard", async () => {
    const h = makeHarness();
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as {
      card: Record<string, unknown>;
      copies: ReadonlyArray<UserCardCopy>;
      customBinders: ReadonlyArray<{ id: string; containsCard: boolean }>;
    };
    expect(body.card["id"]).toBe(CARD_ID);
    expect(body.card["setNameFr"]).toBe("Prisme Évolutif");
    expect(body.card["setCode"]).toBe("SV03.5");
    expect(body.card["officialCount"]).toBe(197);
    expect(body.card["imageBaseUrl"]).toBe("https://assets.tcgdex.net/fr/sv/sv03.5/199");
    expect(body.card["availableVariants"]).toEqual(["normal", "reverse", "holo"]);
    expect(body.copies).toHaveLength(1);
    expect(body.copies[0]?.quantity).toBe(2);
    expect(body.customBinders).toEqual([
      { id: BINDER_ID, title: "Évolutions Favs", containsCard: true },
      { id: "66666666-6666-4666-8666-666666666666", title: "Doublons", containsCard: false },
    ]);
    expect(h.collection.listCardCopies).toHaveBeenCalledWith(USER_ID, { cardId: CARD_ID });
    // La jointure binder_cards porte bien le flag containsCard.
    expect(
      h.queries.some((q) => q.includes("from public.binders") && q.includes("binder_cards")),
    ).toBe(true);
  });

  it("propagates refreshed session cookies via Set-Cookie", async () => {
    const h = makeHarness();
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, `${REFRESH_TOKEN_COOKIE}=refresh-old`),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });

  it("returns 503 without DATABASE_URL (services null)", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "card_detail_unavailable" });
    expect(h.log).toHaveBeenCalledWith(
      "cardDetail.database_url_missing",
      expect.objectContaining({ operation: "detail" }),
    );
  });

  it("returns 503 without SQL details when the query fails", async () => {
    const h = makeHarness({
      responder: (query) => {
        if (query.includes("from public.catalog_cards"))
          throw new Error("boom: select * from secrets");
        return [];
      },
    });
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("card_detail_unavailable");
    expect(JSON.stringify(body)).not.toContain("secrets");
  });
});

// ---------------------------------------------------------------------------
// POST /api/cards/$cardId/copies
// ---------------------------------------------------------------------------

describe("POST /api/cards/$cardId/copies", () => {
  const path = `/api/cards/${CARD_ID}/copies`;
  const body = {
    language: "FR",
    variant: "holo",
    condition: "NM",
    quantity: 1,
    purchasePriceCents: 1250,
  };

  it("returns 403 for a cross-origin mutation without touching services", async () => {
    const h = makeHarness();
    const response = await handleAddCardCopy(
      req("POST", path, { cookie: signedIn, origin: "https://evil.example", body }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(h.collection.upsertCardCopy).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const h = makeHarness();
    const response = await handleAddCardCopy(req("POST", path, { body }), CARD_ID, h.deps);
    expect(response.status).toBe(401);
    expect(h.collection.upsertCardCopy).not.toHaveBeenCalled();
  });

  it("returns 413 when the declared content-length exceeds the cap", async () => {
    const h = makeHarness();
    const response = await handleAddCardCopy(
      req("POST", path, { cookie: signedIn, contentLength: String(MAX_BODY_BYTES + 1), raw: "{}" }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(h.collection.upsertCardCopy).not.toHaveBeenCalled();
  });

  it("returns 413 when the raw body exceeds the cap", async () => {
    const h = makeHarness();
    const response = await handleAddCardCopy(
      req("POST", path, { cookie: signedIn, raw: `{"notes":"${"x".repeat(MAX_BODY_BYTES)}"}` }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(h.collection.upsertCardCopy).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON or a non-object body", async () => {
    const h = makeHarness();
    for (const raw of ["{oops", "[1,2]"]) {
      const response = await handleAddCardCopy(
        req("POST", path, { cookie: signedIn, raw }),
        CARD_ID,
        h.deps,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_input" });
    }
    expect(h.collection.upsertCardCopy).not.toHaveBeenCalled();
  });

  it("returns 201 with the created copy", async () => {
    const h = makeHarness();
    const response = await handleAddCardCopy(
      req("POST", path, { cookie: signedIn, body }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const created = (await response.json()) as UserCardCopy;
    expect(created.cardId).toBe(CARD_ID);
    expect(h.collection.upsertCardCopy).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ cardId: CARD_ID, variant: "holo", quantity: 1 }),
    );
  });

  it("returns 400 on ValidationError and 404 on CatalogItemNotFoundError", async () => {
    const h = makeHarness();
    h.collection.upsertCardCopy.mockReturnValueOnce(
      Effect.fail(new ValidationError({ message: "bad quantity" })),
    );
    const r400 = await handleAddCardCopy(
      req("POST", path, { cookie: signedIn, body }),
      CARD_ID,
      h.deps,
    );
    expect(r400.status).toBe(400);
    expect(await r400.json()).toEqual({ error: "invalid_input" });

    h.collection.upsertCardCopy.mockReturnValueOnce(
      Effect.fail(new CatalogItemNotFoundError({ entity: "card", id: CARD_ID, message: "nope" })),
    );
    const r404 = await handleAddCardCopy(
      req("POST", path, { cookie: signedIn, body }),
      CARD_ID,
      h.deps,
    );
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/copies/$copyId
// ---------------------------------------------------------------------------

describe("PATCH /api/cards/copies/$copyId", () => {
  const path = `/api/cards/copies/${COPY_ID}`;

  it("returns 403 cross-origin and 401 without session", async () => {
    const h = makeHarness();
    const r403 = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, origin: "https://evil.example", body: { delta: 1 } }),
      COPY_ID,
      h.deps,
    );
    expect(r403.status).toBe(403);
    const r401 = await handlePatchCardCopy(
      req("PATCH", path, { body: { delta: 1 } }),
      COPY_ID,
      h.deps,
    );
    expect(r401.status).toBe(401);
    expect(h.collection.adjustCardCopyQuantity).not.toHaveBeenCalled();
    expect(h.collection.updateCardCopy).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body", async () => {
    const h = makeHarness();
    const response = await handlePatchCardCopy(
      req("PATCH", path, {
        cookie: signedIn,
        contentLength: String(MAX_BODY_BYTES + 1),
        raw: "{}",
      }),
      COPY_ID,
      h.deps,
    );
    expect(response.status).toBe(413);
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
    const request = new Request(`http://localhost:3000${path}`, {
      method: "PATCH",
      headers: {
        cookie: signedIn,
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await handlePatchCardCopy(request, COPY_ID, h.deps);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(chunksEmitted).toBeLessThanOrEqual(6);
  });

  it("returns 400 (never 500) when reading a broken request stream fails", async () => {
    const h = makeHarness();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const request = new Request(`http://localhost:3000${path}`, {
      method: "PATCH",
      headers: {
        cookie: signedIn,
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await handlePatchCardCopy(request, COPY_ID, h.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
  });

  it("ignores a spoofed cardId in the POST body and always uses the URL cardId", async () => {
    const h = makeHarness();
    const response = await handleAddCardCopy(
      req("POST", `/api/cards/${CARD_ID}/copies`, {
        cookie: signedIn,
        body: {
          cardId: "other-set-001",
          language: "FR",
          variant: "normal",
          condition: "NM",
          quantity: 1,
        },
      }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(h.collection.upsertCardCopy).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ cardId: CARD_ID }),
    );
  });

  it("stepper: { delta } → 200 { copy, deleted: false }", async () => {
    const h = makeHarness();
    const response = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { delta: 1 } }),
      COPY_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { copy: UserCardCopy; deleted: boolean };
    expect(body.deleted).toBe(false);
    expect(body.copy.quantity).toBe(3);
    expect(h.collection.adjustCardCopyQuantity).toHaveBeenCalledWith(USER_ID, COPY_ID, 1);
    expect(h.collection.updateCardCopy).not.toHaveBeenCalled();
  });

  it("stepper: quantity reaching 0 → 200 { copy: null, deleted: true }", async () => {
    const h = makeHarness();
    h.collection.adjustCardCopyQuantity.mockReturnValueOnce(Effect.succeed(null));
    const response = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { delta: -2 } }),
      COPY_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ copy: null, deleted: true });
  });

  it("stepper: non-integer delta → 400, unknown copy → 404", async () => {
    const h = makeHarness();
    h.collection.adjustCardCopyQuantity.mockReturnValueOnce(
      Effect.fail(new ValidationError({ message: "delta must be an integer" })),
    );
    const r400 = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { delta: 0.5 } }),
      COPY_ID,
      h.deps,
    );
    expect(r400.status).toBe(400);

    h.collection.adjustCardCopyQuantity.mockReturnValueOnce(
      Effect.fail(new CardCopyNotFoundError({ copyId: COPY_ID, message: "nope" })),
    );
    const r404 = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { delta: 1 } }),
      COPY_ID,
      h.deps,
    );
    expect(r404.status).toBe(404);
  });

  it("field patch → 200 { copy }, conflict → 409, not found → 404", async () => {
    const h = makeHarness();
    const r200 = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { condition: "EX", notes: "nick" } }),
      COPY_ID,
      h.deps,
    );
    expect(r200.status).toBe(200);
    const body = (await r200.json()) as { copy: UserCardCopy };
    expect(body.copy.id).toBe(COPY_ID);
    expect(h.collection.updateCardCopy).toHaveBeenCalledWith(USER_ID, COPY_ID, {
      condition: "EX",
      notes: "nick",
    });
    expect(h.collection.adjustCardCopyQuantity).not.toHaveBeenCalled();

    h.collection.updateCardCopy.mockReturnValueOnce(
      Effect.fail(new CardCopyConflictError({ message: "slot exists" })),
    );
    const r409 = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { condition: "EX" } }),
      COPY_ID,
      h.deps,
    );
    expect(r409.status).toBe(409);
    expect(await r409.json()).toEqual({ error: "conflict" });

    h.collection.updateCardCopy.mockReturnValueOnce(
      Effect.fail(new CardCopyNotFoundError({ copyId: COPY_ID, message: "nope" })),
    );
    const r404 = await handlePatchCardCopy(
      req("PATCH", path, { cookie: signedIn, body: { condition: "EX" } }),
      COPY_ID,
      h.deps,
    );
    expect(r404.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/cards/copies/$copyId
// ---------------------------------------------------------------------------

describe("DELETE /api/cards/copies/$copyId", () => {
  const path = `/api/cards/copies/${COPY_ID}`;

  it("returns 403 cross-origin and 401 without session", async () => {
    const h = makeHarness();
    expect(
      (
        await handleDeleteCardCopy(
          req("DELETE", path, { cookie: signedIn, origin: "https://evil.example" }),
          COPY_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect((await handleDeleteCardCopy(req("DELETE", path), COPY_ID, h.deps)).status).toBe(401);
    expect(h.collection.deleteCardCopy).not.toHaveBeenCalled();
  });

  it("returns 204 on success and 404 when the copy is unknown", async () => {
    const h = makeHarness();
    const ok = await handleDeleteCardCopy(
      req("DELETE", path, { cookie: signedIn }),
      COPY_ID,
      h.deps,
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(await ok.text()).toBe("");
    expect(h.collection.deleteCardCopy).toHaveBeenCalledWith(USER_ID, COPY_ID);

    h.collection.deleteCardCopy.mockReturnValueOnce(
      Effect.fail(new CardCopyNotFoundError({ copyId: COPY_ID, message: "nope" })),
    );
    const r404 = await handleDeleteCardCopy(
      req("DELETE", path, { cookie: signedIn }),
      COPY_ID,
      h.deps,
    );
    expect(r404.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST / DELETE /api/cards/$cardId/binders
// ---------------------------------------------------------------------------

describe("/api/cards/$cardId/binders", () => {
  const path = `/api/cards/${CARD_ID}/binders`;

  it("returns 403 cross-origin and 401 without session", async () => {
    const h = makeHarness();
    expect(
      (
        await handleCardBinder(
          req("POST", path, {
            cookie: signedIn,
            origin: "https://evil.example",
            body: { binderId: BINDER_ID },
          }),
          CARD_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleCardBinder(
          req("POST", path, { body: { binderId: BINDER_ID } }),
          CARD_ID,
          h.deps,
        )
      ).status,
    ).toBe(401);
    expect(h.binders.addCardToCustomBinder).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body and 400 for a non-UUID binderId", async () => {
    const h = makeHarness();
    const r413 = await handleCardBinder(
      req("POST", path, { cookie: signedIn, contentLength: String(MAX_BODY_BYTES + 1), raw: "{}" }),
      CARD_ID,
      h.deps,
    );
    expect(r413.status).toBe(413);
    const r400 = await handleCardBinder(
      req("POST", path, { cookie: signedIn, body: { binderId: "not-a-uuid" } }),
      CARD_ID,
      h.deps,
    );
    expect(r400.status).toBe(400);
    expect(h.binders.addCardToCustomBinder).not.toHaveBeenCalled();
  });

  it("POST → 201 with the binder entry", async () => {
    const h = makeHarness();
    const response = await handleCardBinder(
      req("POST", path, { cookie: signedIn, body: { binderId: BINDER_ID } }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(201);
    const entry = (await response.json()) as { binderId: string; cardId: string };
    expect(entry).toMatchObject({ binderId: BINDER_ID, cardId: CARD_ID });
    expect(h.binders.addCardToCustomBinder).toHaveBeenCalledWith(USER_ID, BINDER_ID, CARD_ID);
  });

  it("DELETE → 204", async () => {
    const h = makeHarness();
    const response = await handleCardBinder(
      req("DELETE", path, { cookie: signedIn, body: { binderId: BINDER_ID } }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(204);
    expect(h.binders.removeCardFromCustomBinder).toHaveBeenCalledWith(USER_ID, BINDER_ID, CARD_ID);
  });

  it("maps domain errors: 400 non-custom, 404 unknown binder, 403 RLS denial", async () => {
    const h = makeHarness();
    h.binders.addCardToCustomBinder.mockReturnValueOnce(
      Effect.fail(new ValidationError({ message: "not a custom binder" })),
    );
    expect(
      (
        await handleCardBinder(
          req("POST", path, { cookie: signedIn, body: { binderId: BINDER_ID } }),
          CARD_ID,
          h.deps,
        )
      ).status,
    ).toBe(400);

    h.binders.addCardToCustomBinder.mockReturnValueOnce(
      Effect.fail(new BinderNotFoundError({ binderId: BINDER_ID, message: "nope" })),
    );
    expect(
      (
        await handleCardBinder(
          req("POST", path, { cookie: signedIn, body: { binderId: BINDER_ID } }),
          CARD_ID,
          h.deps,
        )
      ).status,
    ).toBe(404);

    h.binders.removeCardFromCustomBinder.mockReturnValueOnce(
      Effect.fail(new CatalogItemNotFoundError({ entity: "card", id: CARD_ID, message: "nope" })),
    );
    expect(
      (
        await handleCardBinder(
          req("DELETE", path, { cookie: signedIn, body: { binderId: BINDER_ID } }),
          CARD_ID,
          h.deps,
        )
      ).status,
    ).toBe(404);

    h.binders.addCardToCustomBinder.mockReturnValueOnce(
      Effect.fail(new UnauthorizedBinderAccess({ message: "access to binder denied" })),
    );
    expect(
      (
        await handleCardBinder(
          req("POST", path, { cookie: signedIn, body: { binderId: BINDER_ID } }),
          CARD_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/cards/$cardId — prix Cardmarket (LEFT JOIN LATERAL … LIMIT 1)
// ---------------------------------------------------------------------------

describe("GET /api/cards/$cardId — prix", () => {
  it("joint card_latest_prices en LEFT JOIN LATERAL … LIMIT 1 (FR/normal d'abord)", async () => {
    const h = makeHarness();
    await handleCardDetail(get(`/api/cards/${CARD_ID}`, signedIn), CARD_ID, h.deps);
    const query = h.queries.find((q) => q.includes("from public.catalog_cards")) ?? "";
    expect(query).toContain("left join lateral");
    expect(query).toContain("from public.card_latest_prices");
    expect(query).toContain("lp.card_id = c.id");
    expect(query).toMatch(/limit 1\s*\) p on true/);
    expect(query).toContain("lp.language = 'FR' and lp.variant = 'normal'");
  });

  it("renvoie price: null sans snapshot", async () => {
    const h = makeHarness();
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    const body = (await response.json()) as { price: unknown };
    expect(body.price).toBeNull();
  });

  it("renvoie le dernier prix (centimes, source, dates ISO, isFresh)", async () => {
    const h = makeHarness({
      responder: (query) =>
        query.includes("from public.catalog_cards")
          ? [
              {
                ...cardRow,
                price_source: "cardmarket",
                price_trend_cents: 1234,
                price_low_fr_cents: 950,
                price_avg30_cents: null,
                price_fetched_at: new Date("2026-06-01T11:54:00.000Z"),
                price_expires_at: "2026-06-01T12:09:00.000Z",
                price_is_fresh: true,
              },
            ]
          : [],
    });
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { price: unknown };
    expect(body.price).toEqual({
      trendCents: 1234,
      lowFrCents: 950,
      avg30Cents: null,
      source: "cardmarket",
      fetchedAt: "2026-06-01T11:54:00.000Z",
      expiresAt: "2026-06-01T12:09:00.000Z",
      isFresh: true,
    });
  });

  it("conserve la source tcgdex_fallback", async () => {
    const h = makeHarness({
      responder: (query) =>
        query.includes("from public.catalog_cards")
          ? [
              {
                ...cardRow,
                price_source: "tcgdex_fallback",
                price_trend_cents: 500,
                price_low_fr_cents: null,
                price_avg30_cents: null,
                price_fetched_at: "2026-06-01T08:00:00.000Z",
                price_expires_at: "2026-06-01T08:15:00.000Z",
                price_is_fresh: false,
              },
            ]
          : [],
    });
    const response = await handleCardDetail(
      get(`/api/cards/${CARD_ID}`, signedIn),
      CARD_ID,
      h.deps,
    );
    const body = (await response.json()) as { price: { source: string; isFresh: boolean } };
    expect(body.price.source).toBe("tcgdex_fallback");
    expect(body.price.isFresh).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cards/$cardId/price-refresh
// ---------------------------------------------------------------------------

const snapshotFixture = (overrides: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
  id: 7,
  cardId: CARD_ID,
  language: "FR",
  variant: "normal",
  source: "cardmarket",
  trendCents: 1234,
  lowFrCents: 950,
  avg30Cents: 1180,
  fetchedAt: "2026-06-01T12:00:00.000Z",
  expiresAt: "2026-06-01T12:15:00.000Z",
  isFresh: true,
  ...overrides,
});

interface RefreshHarness {
  readonly deps: CardPriceRefreshDeps;
  readonly refreshCardPrice: ReturnType<typeof vi.fn>;
  readonly log: ReturnType<typeof vi.fn>;
  readonly queries: string[];
}

const makeRefreshHarness = (
  options: {
    readonly noDatabase?: boolean;
    readonly outcome?: Effect.Effect<PriceRefreshResult, unknown>;
    readonly responder?: (query: string) => unknown;
  } = {},
): RefreshHarness => {
  const refreshCardPrice = vi.fn(
    (_target: PriceRefreshTarget, _options?: unknown) =>
      options.outcome ??
      Effect.succeed<PriceRefreshResult>({
        kind: "refreshed_cardmarket",
        snapshot: snapshotFixture(),
      }),
  );
  const log = vi.fn();
  const { sql, queries } = makeSql(
    options.responder ??
      ((query) =>
        query.includes("from public.catalog_cards")
          ? [{ id: CARD_ID, cardmarket_url: "https://www.cardmarket.com/fr/Pokemon/Products/123" }]
          : []),
  );
  const deps: CardPriceRefreshDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    sql: options.noDatabase ? null : sql,
    prices: options.noDatabase
      ? null
      : ({ refreshCardPrice } as unknown as CardmarketPriceServiceShape),
    log,
  };
  return { deps, refreshCardPrice, log, queries };
};

const refreshRequest = (options: Parameters<typeof req>[2] = { cookie: signedIn }): Request =>
  req("POST", `/api/cards/${CARD_ID}/price-refresh`, options);

describe("POST /api/cards/$cardId/price-refresh", () => {
  it("returns 403 for a cross-origin request before anything else", async () => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(
      refreshRequest({ cookie: signedIn, origin: "https://evil.example" }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(h.refreshCardPrice).not.toHaveBeenCalled();
    expect(h.queries).toHaveLength(0);
  });

  it("returns 401 without a session (no-store) and never refreshes", async () => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(refreshRequest({}), CARD_ID, h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.refreshCardPrice).not.toHaveBeenCalled();
  });

  it("returns 413 above the 4 KiB cap (declared and streamed)", async () => {
    const h = makeRefreshHarness();
    const declared = await handleCardPriceRefresh(
      refreshRequest({
        cookie: signedIn,
        raw: "{}",
        contentLength: String(PRICE_REFRESH_MAX_BODY_BYTES + 1),
      }),
      CARD_ID,
      h.deps,
    );
    expect(declared.status).toBe(413);
    const streamed = await handleCardPriceRefresh(
      refreshRequest({
        cookie: signedIn,
        raw: JSON.stringify({ language: "FR", pad: "x".repeat(PRICE_REFRESH_MAX_BODY_BYTES) }),
      }),
      CARD_ID,
      h.deps,
    );
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toEqual({ error: "payload_too_large" });
    expect(h.refreshCardPrice).not.toHaveBeenCalled();
  });

  it("uses a dedicated 4 KiB cap (stricter than the 8 KiB of the other card mutations)", () => {
    expect(PRICE_REFRESH_MAX_BODY_BYTES).toBe(4096);
    expect(PRICE_REFRESH_MAX_BODY_BYTES).toBeLessThan(MAX_BODY_BYTES);
  });

  it.each([
    ["invalid JSON", { raw: "{not json" }],
    ["array body", { body: ["FR"] }],
    ["string body", { body: "FR" }],
    ["unknown language", { body: { language: "DE" } }],
    ["unknown variant", { body: { variant: "gold" } }],
    ["non-string language", { body: { language: 3 } }],
    ["unknown key", { body: { language: "FR", cardId: "other" } }],
  ])("returns 400 for %s", async (_label, options) => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(
      refreshRequest({ cookie: signedIn, ...options }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
    expect(h.refreshCardPrice).not.toHaveBeenCalled();
  });

  it("returns 404 when the card is unknown to the catalogue (before refreshing)", async () => {
    const h = makeRefreshHarness({ responder: () => [] });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(h.queries.some((q) => q.includes("from public.catalog_cards"))).toBe(true);
    expect(h.refreshCardPrice).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed card id without hitting the database", async () => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(refreshRequest(), "sv 03.5", h.deps);
    expect(response.status).toBe(404);
    expect(h.queries).toHaveLength(0);
  });

  it("returns 503 without DATABASE_URL", async () => {
    const h = makeRefreshHarness({ noDatabase: true });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "price_unavailable" });
    expect(h.log).toHaveBeenCalledWith(
      "cardDetail.database_url_missing",
      expect.objectContaining({ operation: "price-refresh" }),
    );
  });

  it("refreshes with { manual: true, force: true } and FR/normal defaults (empty body)", async () => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.refreshCardPrice).toHaveBeenCalledWith(
      {
        cardId: CARD_ID,
        language: "FR",
        variant: "normal",
        cardmarketUrl: "https://www.cardmarket.com/fr/Pokemon/Products/123",
        priority: "featured",
      },
      { manual: true, force: true },
    );
    expect(await response.json()).toEqual({
      kind: "refreshed_cardmarket",
      price: {
        trendCents: 1234,
        lowFrCents: 950,
        avg30Cents: 1180,
        source: "cardmarket",
        fetchedAt: "2026-06-01T12:00:00.000Z",
        expiresAt: "2026-06-01T12:15:00.000Z",
        isFresh: true,
      },
    });
  });

  it("forwards a validated language / variant from the JSON body", async () => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(
      refreshRequest({ cookie: signedIn, body: { language: "EN", variant: "holo" } }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(h.refreshCardPrice.mock.calls[0]?.[0]).toMatchObject({
      language: "EN",
      variant: "holo",
    });
  });

  it.each(["refreshed_fallback", "fresh_cache", "degraded"] as const)(
    "returns 200 { kind: %s, price }",
    async (kind) => {
      const h = makeRefreshHarness({
        outcome: Effect.succeed<PriceRefreshResult>({
          kind,
          snapshot: snapshotFixture({
            source: kind === "refreshed_fallback" ? "tcgdex_fallback" : "cardmarket",
          }),
        }),
      });
      const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string; price: { source: string } };
      expect(body.kind).toBe(kind);
      expect(body.price.source).toBe(
        kind === "refreshed_fallback" ? "tcgdex_fallback" : "cardmarket",
      );
    },
  );

  it("propagates refreshed session cookies on success", async () => {
    const h = makeRefreshHarness();
    const response = await handleCardPriceRefresh(
      refreshRequest({ cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });

  it("maps the cooldown to 429 with Retry-After rounded up to the second", async () => {
    const h = makeRefreshHarness({
      outcome: Effect.fail(
        new PriceRefreshCooldownError({
          cardId: CARD_ID,
          retryAfterMs: 61_200,
          nextAllowedAt: "2026-06-01T12:05:00.000Z",
          message: "cooldown",
        }),
      ),
    });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("62");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "cooldown",
      retryAfterMs: 61_200,
      nextAllowedAt: "2026-06-01T12:05:00.000Z",
    });
  });

  it("keeps Set-Cookie on the 429 response", async () => {
    const h = makeRefreshHarness({
      outcome: Effect.fail(
        new PriceRefreshCooldownError({
          cardId: CARD_ID,
          retryAfterMs: 1_000,
          nextAllowedAt: "2026-06-01T12:05:00.000Z",
          message: "cooldown",
        }),
      ),
    });
    const response = await handleCardPriceRefresh(
      refreshRequest({ cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      CARD_ID,
      h.deps,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });

  it("maps an open circuit breaker to 503 price_unavailable without leaking internals", async () => {
    const h = makeRefreshHarness({
      outcome: Effect.fail(
        new PriceCircuitOpenError({
          openUntil: "2026-06-01T12:30:00.000Z",
          consecutiveBlocks: 2,
          message: "circuit breaker open until secret-internal",
        }),
      ),
    });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "price_unavailable" });
    expect(text).not.toContain("secret-internal");
    expect(text).not.toContain("circuit");
    expect(h.log).toHaveBeenCalledWith(
      "cardDetail.price_circuit_open",
      expect.objectContaining({ operation: "price-refresh", errorTag: "PriceCircuitOpenError" }),
    );
  });

  it("maps any other failure (no fallback) to 503 without leaking details", async () => {
    const h = makeRefreshHarness({
      outcome: Effect.fail({ _tag: "CardmarketBlockedError", message: "Cloudflare challenge xyz" }),
    });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "price_unavailable" });
    expect(text).not.toContain("Cloudflare");
  });

  it("maps a defect (unexpected throw) to 503", async () => {
    const h = makeRefreshHarness({ outcome: Effect.die(new Error("db password leaked")) });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("leaked");
  });

  it("maps a catalogue lookup failure to 503 without SQL details", async () => {
    const h = makeRefreshHarness({
      responder: () => {
        throw new Error("boom: select * from secrets");
      },
    });
    const response = await handleCardPriceRefresh(refreshRequest(), CARD_ID, h.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secrets");
    expect(h.refreshCardPrice).not.toHaveBeenCalled();
  });
});
