import {
  BurstImportCardNotFoundError,
  BurstImportEmptyBatchError,
  BurstImportQuantityOverflowError,
  ValidationError,
} from "@pokevault/domain";
import { type BurstImportServiceShape, DatabaseError, type Sql } from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import type { BurstSetCardsPayload } from "./burst-client.ts";
import {
  type BurstServerDeps,
  handleBurstSetCards,
  handleCommitBurstImport,
  handleListBurstSets,
  handlePreviewBurstImport,
  loadBurstSetCards,
  MAX_BURST_BODY_BYTES,
  mapBurstSetRow,
} from "./burst-server.ts";

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

const set = (id = "sv03.5") => ({
  id,
  code: "MEV",
  nameFr: "Évolution à Méga-Éclat",
  seriesNameFr: "Écarlate & Violet",
  logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
  officialCount: 198,
  totalCount: 207,
  releaseDate: "2024-01-19",
});

const report = {
  totalAddedQuantity: 2,
  distinctCardsCount: 1,
  newCardsCount: 1,
  duplicateCardsCount: 0,
  wishlistRemovedCount: 1,
  adjustedVariantsCount: 0,
  items: [],
};

const importService = (
  overrides: Partial<BurstImportServiceShape> = {},
): BurstImportServiceShape => ({
  previewBatch: vi.fn(() => Effect.succeed(report)),
  commitBatch: vi.fn(() => Effect.succeed(report)),
  ...overrides,
});

const makeDeps = (
  service: BurstServerDeps["service"],
): { deps: BurstServerDeps; log: ReturnType<typeof vi.fn> } => {
  const log = vi.fn();
  return {
    deps: { auth: { config, fetch: async (url, init) => gotrue(url, init) }, service, log },
    log,
  };
};

const bundle = (
  service: BurstImportServiceShape,
  listSets: NonNullable<BurstServerDeps["service"]>["listSets"],
  loadSetCards: NonNullable<BurstServerDeps["service"]>["loadSetCards"] = () =>
    Effect.succeed(null),
): NonNullable<BurstServerDeps["service"]> => ({
  importService: service,
  listSets,
  loadSetCards,
});

const request = (
  path: string,
  init: { cookie?: string; origin?: string; body?: unknown; method?: string } = {},
): Request =>
  new Request(`http://localhost:3000${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      ...(init.origin === undefined ? {} : { origin: init.origin }),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;
const origin = "http://localhost:3000";
const batch = { defaults: { setId: "sv03.5" }, items: [{ cardId: "sv03.5-199", quantity: 2 }] };

describe("GET /api/burst/sets", () => {
  it("returns 401 without session and never touches the database", async () => {
    const listSets = vi.fn(() => Effect.succeed([set()]));
    const service = importService();
    const { deps } = makeDeps(bundle(service, listSets));
    const response = await handleListBurstSets(request("/api/burst/sets"), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(listSets).not.toHaveBeenCalled();
    expect(service.previewBatch).not.toHaveBeenCalled();
  });

  it("returns the catalog sets (200, no-store) with cache-control", async () => {
    const { deps } = makeDeps(bundle(importService(), () => Effect.succeed([set()])));
    const response = await handleListBurstSets(
      request("/api/burst/sets", { cookie: signedIn }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ sets: [set()] });
  });

  it("serves an empty payload + warning when DATABASE_URL is missing", async () => {
    const { deps, log } = makeDeps(null);
    const response = await handleListBurstSets(
      request("/api/burst/sets", { cookie: signedIn }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sets: [], warning: "database_not_configured" });
    expect(log).toHaveBeenCalledWith(
      "burst.database_url_missing",
      expect.objectContaining({ operation: "sets" }),
    );
  });

  it("answers 503 (no SQL leak) when the query fails", async () => {
    const { deps, log } = makeDeps(
      bundle(importService(), () =>
        Effect.fail(new DatabaseError({ message: "postgres query failed", cause: "secret" })),
      ),
    );
    const response = await handleListBurstSets(
      request("/api/burst/sets", { cookie: signedIn }),
      deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "burst_unavailable" });
    expect(log).toHaveBeenCalledWith(
      "burst.operation_failed",
      expect.objectContaining({ operation: "sets", errorTag: "DatabaseError" }),
    );
  });

  it("propagates refreshed session cookies via Set-Cookie", async () => {
    const { deps } = makeDeps(bundle(importService(), () => Effect.succeed([set()])));
    const response = await handleListBurstSets(
      request("/api/burst/sets", { cookie: `${REFRESH_TOKEN_COOKIE}=old-refresh` }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    expect(cookies[1]).toContain(`${REFRESH_TOKEN_COOKIE}=fresh-refresh`);
  });
});

describe("POST /api/burst/preview · /api/burst/commit (CSRF)", () => {
  it("returns 403 for a cross-origin POST (before any service call)", async () => {
    const service = importService();
    const { deps } = makeDeps(bundle(service, () => Effect.succeed([set()])));
    const response = await handlePreviewBurstImport(
      request("/api/burst/preview", {
        cookie: signedIn,
        origin: "http://evil.example",
        body: batch,
      }),
      deps,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "cross_origin" });
    expect(service.previewBatch).not.toHaveBeenCalled();
  });

  it("returns 401 without session before the CSRF check", async () => {
    const service = importService();
    const { deps } = makeDeps(bundle(service, () => Effect.succeed([set()])));
    const response = await handleCommitBurstImport(
      request("/api/burst/commit", { origin, body: batch }),
      deps,
    );
    expect(response.status).toBe(401);
    expect(service.commitBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["preview", handlePreviewBurstImport],
    ["commit", handleCommitBurstImport],
  ] as const)("accepts a same-origin POST and returns the report (%s)", async (mode, handler) => {
    const service = importService();
    const { deps } = makeDeps(bundle(service, () => Effect.succeed([set()])));
    const response = await handler(
      request(`/api/burst/${mode}`, { cookie: signedIn, origin, body: batch }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    const call = mode === "preview" ? service.previewBatch : service.commitBatch;
    expect(call).toHaveBeenCalledWith("u1", batch);
  });

  it("returns 400 for an invalid JSON body", async () => {
    const { deps } = makeDeps(bundle(importService(), () => Effect.succeed([set()])));
    const response = await handlePreviewBurstImport(
      new Request("http://localhost:3000/api/burst/preview", {
        method: "POST",
        headers: { cookie: signedIn, origin, "Content-Type": "application/json" },
        body: "{not json",
      }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  });

  it("returns 413 when body exceeds MAX_BURST_BODY_BYTES (declared or actual)", async () => {
    const service = importService();
    const { deps } = makeDeps(bundle(service, () => Effect.succeed([set()])));
    const oversized = JSON.stringify({ pad: "a".repeat(MAX_BURST_BODY_BYTES + 10) });
    const response = await handleCommitBurstImport(
      new Request("http://localhost:3000/api/burst/commit", {
        method: "POST",
        headers: { cookie: signedIn, origin, "Content-Type": "application/json" },
        body: oversized,
      }),
      deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(service.commitBatch).not.toHaveBeenCalled();

    const byHeader = await handlePreviewBurstImport(
      new Request("http://localhost:3000/api/burst/preview", {
        method: "POST",
        headers: {
          cookie: signedIn,
          origin,
          "Content-Type": "application/json",
          "Content-Length": String(MAX_BURST_BODY_BYTES + 1),
        },
        body: "{}",
      }),
      deps,
    );
    expect(byHeader.status).toBe(413);
    expect(service.previewBatch).not.toHaveBeenCalled();
  });

  it("normalizes raw TCGdex set logo_url to .webp in mapBurstSetRow", () => {
    const mapped = mapBurstSetRow({
      id: "sv03.5",
      code: "MEW",
      name_fr: "151",
      series_name_fr: "Écarlate et Violet",
      logo_url: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
      official_count: 165,
      total_count: 207,
      release_date: new Date("2023-09-22T00:00:00.000Z"),
    });
    expect(mapped.logoUrl).toBe("https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp");
    expect(mapped.releaseDate).toBe("2023-09-22");
    expect(
      mapBurstSetRow({
        id: "base1",
        code: null,
        name_fr: "Set de Base",
        series_name_fr: "Base",
        logo_url: null,
        official_count: 102,
        total_count: 102,
        release_date: null,
      }).logoUrl,
    ).toBeNull();
  });
});

describe("POST /api/burst/preview · /api/burst/commit (mapped errors)", () => {
  const run = async (
    handler: typeof handlePreviewBurstImport,
    error: Effect.Effect<never, unknown>,
  ): Promise<Response> => {
    const service = importService({
      previewBatch: vi.fn(() => error as never),
      commitBatch: vi.fn(() => error as never),
    });
    const { deps, log } = makeDeps(bundle(service, () => Effect.succeed([set()])));
    const response = await handler(
      request("/api/burst/preview", { cookie: signedIn, origin, body: batch }),
      deps,
    );
    expect(log).toHaveBeenCalledWith(
      "burst.operation_failed",
      expect.objectContaining({ errorTag: expect.any(String) }),
    );
    return response;
  };

  it("maps ValidationError to 400", async () => {
    const response = await run(
      handlePreviewBurstImport,
      Effect.fail(new ValidationError({ message: "invalid batch", cause: undefined })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_batch" });
  });

  it("maps BurstImportEmptyBatchError to 400", async () => {
    const response = await run(
      handlePreviewBurstImport,
      Effect.fail(new BurstImportEmptyBatchError({})),
    );
    expect(response.status).toBe(400);
  });

  it("maps BurstImportCardNotFoundError to 404 with the missing ids", async () => {
    const response = await run(
      handleCommitBurstImport,
      Effect.fail(new BurstImportCardNotFoundError({ missingCardIds: ["sv03.5-999"] })),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "cards_not_found",
      missingCardIds: ["sv03.5-999"],
    });
  });

  it("maps BurstImportQuantityOverflowError to 409", async () => {
    const response = await run(
      handleCommitBurstImport,
      Effect.fail(
        new BurstImportQuantityOverflowError({
          cardId: "sv03.5-199",
          currentQuantity: 998,
          requestedDelta: 2,
          maxQuantity: 999,
        }),
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "quantity_overflow",
      cardId: "sv03.5-199",
      maxQuantity: 999,
    });
  });

  it("maps DatabaseError to 503 without leaking SQL details", async () => {
    const response = await run(
      handleCommitBurstImport,
      Effect.fail(new DatabaseError({ message: "postgres query failed", cause: "secret" })),
    );
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("postgres");
    expect(body).not.toContain("secret");
  });

  it("answers 503 when DATABASE_URL is missing", async () => {
    const { deps, log } = makeDeps(null);
    const response = await handlePreviewBurstImport(
      request("/api/burst/preview", { cookie: signedIn, origin, body: batch }),
      deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "burst_unavailable" });
    expect(log).toHaveBeenCalledWith(
      "burst.database_url_missing",
      expect.objectContaining({ operation: "preview" }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /api/burst/cards?setId=…
// ---------------------------------------------------------------------------

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const cardsPayload: BurstSetCardsPayload = {
  set: {
    id: "sv03.5",
    code: "MEV",
    nameFr: "Évolution à Méga-Éclat",
    officialCount: 198,
    totalCount: 207,
    logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
  },
  cards: [
    {
      id: "sv03.5-1",
      localId: "1",
      localIdNumeric: 1,
      nameFr: "Bulbizarre",
      rarity: "Commune",
      imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/1",
      availableVariants: ["normal", "reverse"],
      holoEffect: "none",
      ownedQuantity: 2,
    },
  ],
  binderId: "aaaaaaaa-0000-4000-8000-000000000001",
};

describe("GET /api/burst/cards", () => {
  it("returns 401 + no-store without session and never touches the database", async () => {
    const loadSetCards = vi.fn(() => Effect.succeed(cardsPayload));
    const { deps } = makeDeps(bundle(importService(), () => Effect.succeed([]), loadSetCards));
    const response = await handleBurstSetCards(request("/api/burst/cards?setId=sv03.5"), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(loadSetCards).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "/api/burst/cards"],
    ["empty", "/api/burst/cards?setId="],
    ["blank", "/api/burst/cards?setId=%20%20"],
    ["too long", `/api/burst/cards?setId=${"a".repeat(65)}`],
    ["malformed", "/api/burst/cards?setId=sv03.5%27%3B--"],
  ])("returns 400 when setId is %s (no database access)", async (_label, path) => {
    const loadSetCards = vi.fn(() => Effect.succeed(cardsPayload));
    const { deps } = makeDeps(bundle(importService(), () => Effect.succeed([]), loadSetCards));
    const response = await handleBurstSetCards(request(path, { cookie: signedIn }), deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_set_id" });
    expect(loadSetCards).not.toHaveBeenCalled();
  });

  it("returns 404 when the set does not exist", async () => {
    const { deps } = makeDeps(
      bundle(
        importService(),
        () => Effect.succeed([]),
        () => Effect.succeed(null),
      ),
    );
    const response = await handleBurstSetCards(
      request("/api/burst/cards?setId=nope", { cookie: signedIn }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "set_not_found" });
  });

  it("returns the payload (200, private no-store) for the session user", async () => {
    const loadSetCards = vi.fn(() => Effect.succeed(cardsPayload));
    const { deps } = makeDeps(bundle(importService(), () => Effect.succeed([]), loadSetCards));
    const response = await handleBurstSetCards(
      request("/api/burst/cards?setId=%20sv03.5%20", { cookie: signedIn }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(cardsPayload);
    expect(loadSetCards).toHaveBeenCalledExactlyOnceWith("u1", "sv03.5");
  });

  it("propagates refreshed session cookies via Set-Cookie", async () => {
    const { deps } = makeDeps(
      bundle(
        importService(),
        () => Effect.succeed([]),
        () => Effect.succeed(cardsPayload),
      ),
    );
    const response = await handleBurstSetCards(
      request("/api/burst/cards?setId=sv03.5", { cookie: `${REFRESH_TOKEN_COOKIE}=old-refresh` }),
      deps,
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    expect(cookies[1]).toContain(`${REFRESH_TOKEN_COOKIE}=fresh-refresh`);
  });

  it("answers 503 without SQL leak when the query fails, and without DATABASE_URL", async () => {
    const failing = makeDeps(
      bundle(
        importService(),
        () => Effect.succeed([]),
        () => Effect.fail(new DatabaseError({ message: "boom", cause: "secret" })),
      ),
    );
    const failed = await handleBurstSetCards(
      request("/api/burst/cards?setId=sv03.5", { cookie: signedIn }),
      failing.deps,
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "burst_unavailable" });
    expect(failing.log).toHaveBeenCalledWith(
      "burst.operation_failed",
      expect.objectContaining({ operation: "cards", errorTag: "DatabaseError" }),
    );

    const noDb = makeDeps(null);
    const unavailable = await handleBurstSetCards(
      request("/api/burst/cards?setId=sv03.5", { cookie: signedIn }),
      noDb.deps,
    );
    expect(unavailable.status).toBe(503);
    expect(noDb.log).toHaveBeenCalledWith(
      "burst.database_url_missing",
      expect.objectContaining({ operation: "cards" }),
    );
  });
});

// ---------------------------------------------------------------------------
// loadBurstSetCards — requêtes SQL (fausse base, même contrat que `postgres`)
// ---------------------------------------------------------------------------

const BINDER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const BINDER_B = "aaaaaaaa-0000-4000-8000-000000000002";

const sqlDataset = {
  sets: [
    {
      id: "sv03.5",
      code: "MEV",
      name_fr: "Évolution à Méga-Éclat",
      official_count: 198,
      total_count: 207,
      logo_url: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
    },
  ],
  cards: [
    {
      id: "sv03.5-TG01",
      set_id: "sv03.5",
      local_id: "TG01",
      local_id_numeric: null,
      name_fr: "Professeur",
      rarity: null,
      image_base_url: null,
      available_variants: ["holo"],
      holo_effect: "holo",
    },
    {
      id: "sv03.5-25",
      set_id: "sv03.5",
      local_id: "025",
      local_id_numeric: 25,
      name_fr: "Pikachu",
      rarity: "Commune",
      image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/025",
      available_variants: ["normal", "reverse"],
      holo_effect: "none",
    },
    {
      id: "sv03.5-4",
      set_id: "sv03.5",
      local_id: "004",
      local_id_numeric: 4,
      name_fr: "Salamèche",
      rarity: "Rare",
      image_base_url: null,
      available_variants: null,
      holo_effect: "none",
    },
    {
      id: "sv03.5-AA",
      set_id: "sv03.5",
      local_id: "AA01",
      local_id_numeric: null,
      name_fr: "Secrète",
      rarity: null,
      image_base_url: null,
      available_variants: ["holo"],
      holo_effect: "sir",
    },
    {
      id: "sv08-10",
      set_id: "sv08",
      local_id: "010",
      local_id_numeric: 10,
      name_fr: "Évoli",
      rarity: "Rare",
      image_base_url: null,
      available_variants: ["normal"],
      holo_effect: "none",
    },
  ],
  copies: [
    { user_id: USER_A, card_id: "sv03.5-25", quantity: 2 },
    { user_id: USER_A, card_id: "sv03.5-25", quantity: 3 },
    { user_id: USER_A, card_id: "sv08-10", quantity: 7 },
    // Autre utilisateur : jamais compté.
    { user_id: USER_B, card_id: "sv03.5-4", quantity: 9 },
  ],
  binders: [
    { id: BINDER_A, user_id: USER_A, kind: "set", set_id: "sv03.5" },
    { id: "custom", user_id: USER_A, kind: "custom", set_id: null },
    { id: BINDER_B, user_id: USER_B, kind: "set", set_id: "sv03.5" },
  ],
};

const makeFakeSql = (log: Array<{ text: string; values: ReadonlyArray<unknown> }> = []): Sql => {
  const run = (text: string, values: ReadonlyArray<unknown>): Promise<unknown> => {
    log.push({ text, values });
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("from public.catalog_sets")) {
      return Promise.resolve(sqlDataset.sets.filter((row) => row.id === values[0]));
    }
    if (text.includes("from public.catalog_cards c") && text.includes("order by")) {
      return Promise.resolve(
        sqlDataset.cards
          .filter((row) => row.set_id === values[0])
          .sort(
            (a, b) =>
              (a.local_id_numeric ?? Number.POSITIVE_INFINITY) -
                (b.local_id_numeric ?? Number.POSITIVE_INFINITY) ||
              a.local_id.localeCompare(b.local_id),
          ),
      );
    }
    if (text.includes("from public.user_card_copies")) {
      const [userId, setId] = values;
      const totals = new Map<string, number>();
      for (const copy of sqlDataset.copies) {
        const card = sqlDataset.cards.find((entry) => entry.id === copy.card_id);
        if (copy.user_id === userId && card?.set_id === setId) {
          totals.set(copy.card_id, (totals.get(copy.card_id) ?? 0) + copy.quantity);
        }
      }
      return Promise.resolve(
        [...totals].map(([card_id, quantity]) => ({ card_id, quantity: String(quantity) })),
      );
    }
    if (text.includes("from public.binders")) {
      const [userId, setId] = values;
      return Promise.resolve(
        sqlDataset.binders
          .filter((row) => row.user_id === userId && row.kind === "set" && row.set_id === setId)
          .map((row) => ({ id: row.id })),
      );
    }
    return Promise.resolve([]);
  };
  const fake = (strings: unknown, ...values: ReadonlyArray<unknown>): unknown =>
    Array.isArray(strings) && "raw" in (strings as { raw?: unknown })
      ? run((strings as unknown as TemplateStringsArray).join(" ? "), values)
      : strings;
  const sql = Object.assign(fake, {
    begin: (cb: (tx: unknown) => Promise<unknown>) => Promise.resolve(cb(sql)),
  });
  return sql as unknown as Sql;
};

describe("loadBurstSetCards (SQL)", () => {
  it("sorts by local_id_numeric (NULLS LAST) then local_id and sums owned quantities", async () => {
    const payload = await Effect.runPromise(loadBurstSetCards(makeFakeSql(), USER_A, "sv03.5"));
    expect(payload?.cards.map((card) => card.localId)).toEqual(["004", "025", "AA01", "TG01"]);
    expect(payload?.cards.map((card) => card.ownedQuantity)).toEqual([0, 5, 0, 0]);
    expect(payload?.cards[1]).toEqual({
      id: "sv03.5-25",
      localId: "025",
      localIdNumeric: 25,
      nameFr: "Pikachu",
      rarity: "Commune",
      imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/025",
      availableVariants: ["normal", "reverse"],
      holoEffect: "none",
      ownedQuantity: 5,
    });
    // `available_variants` NULL → liste vide (jamais d'undefined côté client).
    expect(payload?.cards[0]?.availableVariants).toEqual([]);
  });

  it("returns the set metadata (logo normalised to .webp) and the user's set binder", async () => {
    const payload = await Effect.runPromise(loadBurstSetCards(makeFakeSql(), USER_A, "sv03.5"));
    expect(payload?.set).toEqual({
      id: "sv03.5",
      code: "MEV",
      nameFr: "Évolution à Méga-Éclat",
      officialCount: 198,
      totalCount: 207,
      logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
    });
    expect(payload?.binderId).toBe(BINDER_A);
  });

  it("isolates users: never counts or exposes another user's copies / binder", async () => {
    const payload = await Effect.runPromise(loadBurstSetCards(makeFakeSql(), USER_B, "sv03.5"));
    expect(payload?.cards.map((card) => card.ownedQuantity)).toEqual([9, 0, 0, 0]);
    expect(payload?.binderId).toBe(BINDER_B);
  });

  it("returns a null binderId when the user has no set binder yet, null for an unknown set", async () => {
    const noBinder = await Effect.runPromise(
      loadBurstSetCards(makeFakeSql(), "33333333-3333-4333-8333-333333333333", "sv03.5"),
    );
    expect(noBinder?.binderId).toBeNull();
    expect(noBinder?.cards.every((card) => card.ownedQuantity === 0)).toBe(true);
    expect(await Effect.runPromise(loadBurstSetCards(makeFakeSql(), USER_A, "unknown"))).toBeNull();
  });

  it("filters explicitly by user_id and set inside a transaction (defence in depth)", async () => {
    const log: Array<{ text: string; values: ReadonlyArray<unknown> }> = [];
    await Effect.runPromise(loadBurstSetCards(makeFakeSql(log), USER_A, "sv03.5"));
    expect(log[0]?.text).toContain("set_config");
    const copies = log.find((entry) => entry.text.includes("from public.user_card_copies"));
    expect(copies?.text).toMatch(/u\.user_id =\s+\?/);
    expect(copies?.values).toEqual([USER_A, "sv03.5"]);
    const binders = log.find((entry) => entry.text.includes("from public.binders"));
    expect(binders?.text).toMatch(/b\.user_id =\s+\?/);
    expect(binders?.values).toEqual([USER_A, "sv03.5"]);
    const cards = log.find((entry) => entry.text.includes("order by"));
    expect(cards?.text).toContain("order by c.local_id_numeric asc nulls last, c.local_id asc");
  });

  it("rejects a non-UUID user id before opening any transaction", async () => {
    const log: Array<{ text: string; values: ReadonlyArray<unknown> }> = [];
    const exit = await Effect.runPromiseExit(loadBurstSetCards(makeFakeSql(log), "u1", "sv03.5"));
    expect(exit._tag).toBe("Failure");
    expect(log).toEqual([]);
  });
});
