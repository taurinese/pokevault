import {
  BurstImportCardNotFoundError,
  BurstImportEmptyBatchError,
  BurstImportQuantityOverflowError,
  ValidationError,
} from "@pokevault/domain";
import { type BurstImportServiceShape, DatabaseError } from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import {
  type BurstServerDeps,
  handleCommitBurstImport,
  handleListBurstSets,
  handlePreviewBurstImport,
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
): NonNullable<BurstServerDeps["service"]> => ({ importService: service, listSets });

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
