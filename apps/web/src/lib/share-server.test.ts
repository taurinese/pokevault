import {
  BinderNotFoundError,
  decodeSharedBinderPayload,
  type SharedBinderPayload,
  type ShareLink,
  ShareLinkForbiddenError,
  ShareLinkNotFoundError,
  ValidationError,
} from "@pokevault/domain";
import { DatabaseError } from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import {
  handleCreateShareLink,
  handleGetSharedBinder,
  handleGetSharedBinderCover,
  handleListShareLinks,
  handleRevokeShareLink,
  handleUpdateShareLink,
  type ShareServerDeps,
} from "./share-server.ts";

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
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "A".repeat(43);
const REVOKED_TOKEN = "B".repeat(43);
const COVER_PATH = `${USER_ID}/${BINDER_ID}.webp`;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** GoTrue factice : `valid` accepté. */
const gotrue = (url: string, init?: RequestInit): Response => {
  if (url.endsWith("/user")) {
    const bearer = new Headers(init?.headers).get("Authorization");
    return bearer === "Bearer valid" || bearer === "Bearer fresh"
      ? jsonResponse({
          id: USER_ID,
          email: "ada@pokevault.test",
          app_metadata: { provider: "google" },
          user_metadata: { full_name: "Ada Lovelace" },
        })
      : jsonResponse({}, 401);
  }
  return jsonResponse({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 });
};

const payload: SharedBinderPayload = {
  owner: { displayName: "Ada Lovelace", avatarInitials: "AL" },
  binder: {
    id: BINDER_ID,
    kind: "set",
    title: "Prisme Évolutif",
    setId: "sv08.5",
    setCode: "SV08.5",
    setName: "Prismatic Evolutions",
    coverType: "upload",
    coverLogoUrl: null,
    coverCardImageUrl: null,
    hasUploadedCover: true,
    showQuantities: true,
    ownedCount: 1,
    totalCards: 2,
  },
  cards: [
    {
      cardId: "sv08.5-1",
      localId: "1",
      localIdNumeric: 1,
      nameFr: "Carte 1",
      setCode: "SV08.5",
      rarity: "Commune",
      holoEffect: "none",
      imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv08.5/1",
      owned: true,
      quantity: 2,
      copies: [{ language: "FR", variant: "normal", quantity: 2 }],
    },
    {
      cardId: "sv08.5-2",
      localId: "2",
      localIdNumeric: 2,
      nameFr: "Carte 2",
      setCode: "SV08.5",
      rarity: "Rare",
      holoEffect: "holo",
      imageBaseUrl: null,
      owned: false,
      quantity: 0,
      copies: [],
    },
  ],
};

const linkRow = (overrides: Partial<ShareLink> = {}): ShareLink => ({
  id: LINK_ID,
  userId: USER_ID,
  binderId: BINDER_ID,
  token: TOKEN,
  isActive: true,
  showQuantities: true,
  createdAt: "2026-03-01T10:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

interface Harness {
  readonly deps: ShareServerDeps;
  readonly share: Record<
    "createLink" | "listLinks" | "revokeLink" | "updateShowQuantities",
    ReturnType<typeof vi.fn>
  >;
  readonly getSharedBinder: ReturnType<typeof vi.fn>;
  readonly coverPath: ReturnType<typeof vi.fn>;
  readonly binderTitles: ReturnType<typeof vi.fn>;
  readonly storageFetch: ReturnType<typeof vi.fn>;
  readonly log: ReturnType<typeof vi.fn>;
}

const makeHarness = (
  options: {
    readonly noDatabase?: boolean;
    readonly storage?: (url: string, init?: RequestInit) => Response | Promise<Response>;
    readonly serviceKey?: string;
  } = {},
): Harness => {
  const share = {
    createLink: vi.fn((userId: string, input: { binderId: string; showQuantities?: boolean }) =>
      input.binderId === BINDER_ID
        ? Effect.succeed(linkRow({ userId, showQuantities: input.showQuantities ?? true }))
        : Effect.fail(new BinderNotFoundError({ binderId: input.binderId, message: "nope" })),
    ),
    listLinks: vi.fn((userId: string) =>
      Effect.succeed([
        linkRow({ userId }),
        // Défense en profondeur : un lien d'autrui ne doit JAMAIS sortir.
        linkRow({ id: "55555555-5555-4555-8555-555555555555", userId: OTHER_USER_ID }),
      ]),
    ),
    revokeLink: vi.fn((userId: string, linkId: string) =>
      linkId === LINK_ID
        ? Effect.succeed(
            linkRow({ userId, isActive: false, revokedAt: "2026-03-02T10:00:00.000Z" }),
          )
        : Effect.fail(new ShareLinkNotFoundError({ linkId, message: "nope" })),
    ),
    updateShowQuantities: vi.fn((userId: string, linkId: string, showQuantities: boolean) =>
      linkId === LINK_ID
        ? Effect.succeed(linkRow({ userId, showQuantities }))
        : Effect.fail(new ShareLinkNotFoundError({ linkId, message: "nope" })),
    ),
  };
  const getSharedBinder = vi.fn((token: string) =>
    token === TOKEN
      ? decodeSharedBinderPayload(payload).pipe(Effect.orDie)
      : Effect.fail(new ShareLinkNotFoundError({ message: "shared binder not found" })),
  );
  const coverPath = vi.fn((token: string) => Effect.succeed(token === TOKEN ? COVER_PATH : null));
  const binderTitles = vi.fn(() => Effect.succeed({ [BINDER_ID]: "Prisme Évolutif" }));
  const log = vi.fn();
  const storageFetch = vi.fn(
    options.storage ?? (() => new Response("webp-bytes", { status: 200 })),
  );
  const deps: ShareServerDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    owner: options.noDatabase ? null : { share, binderTitles },
    publicBinder: options.noDatabase ? null : { getSharedBinder },
    coverPath: options.noDatabase ? null : coverPath,
    storage: {
      baseUrl: "http://storage:5000",
      anonKey: "anon-key",
      ...(options.serviceKey === undefined ? {} : { serviceKey: options.serviceKey }),
      fetch: async (url, init) => storageFetch(url, init),
    },
    log,
  };
  return { deps, share, getSharedBinder, coverPath, binderTitles, storageFetch, log };
};

const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;

const request = (
  method: string,
  path: string,
  options: {
    cookie?: string;
    origin?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Request => {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.origin !== null && method !== "GET") {
    headers.set("origin", options.origin ?? "http://localhost:3000");
  }
  const body =
    method === "GET"
      ? undefined
      : (options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)));
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

// ---------------------------------------------------------------------------
// Routes PUBLIQUES
// ---------------------------------------------------------------------------

/** Clés qui ne doivent apparaître nulle part dans une réponse publique. */
const FORBIDDEN_KEYS = [
  "user_id",
  "userId",
  "email",
  "purchase_price_cents",
  "purchasePriceCents",
  "notes",
  "cover_storage_path",
  "coverStoragePath",
  "discord",
  "wishlist",
  "token",
  "price_alerts",
];

describe("GET /api/shared/$token (public, sans session)", () => {
  it("serves the projection WITHOUT any authentication, no-store and noindex", async () => {
    const h = makeHarness();
    const response = await handleGetSharedBinder(TOKEN, h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    const body = (await response.json()) as SharedBinderPayload;
    expect(body.owner).toEqual({ displayName: "Ada Lovelace", avatarInitials: "AL" });
    expect(body.binder.title).toBe("Prisme Évolutif");
    expect(body.cards).toHaveLength(2);
    expect(h.getSharedBinder).toHaveBeenCalledWith(TOKEN);
  });

  it("goes EXCLUSIVELY through getSharedBinder: no private service is ever called", async () => {
    const h = makeHarness();
    await handleGetSharedBinder(TOKEN, h.deps);
    for (const fn of Object.values(h.share)) expect(fn).not.toHaveBeenCalled();
    expect(h.binderTitles).not.toHaveBeenCalled();
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it("never leaks a private key nor the Storage path in the JSON", async () => {
    const h = makeHarness();
    const text = await (await handleGetSharedBinder(TOKEN, h.deps)).text();
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          collect(inner);
        }
      }
    };
    collect(JSON.parse(text));
    for (const forbidden of FORBIDDEN_KEYS) expect(keys.has(forbidden)).toBe(false);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain(COVER_PATH);
    expect(text).not.toContain("ada@pokevault.test");
  });

  it("answers 404 not_found (no-store, noindex) without touching the database for a malformed token", async () => {
    const h = makeHarness();
    for (const bad of ["short", "../../etc/passwd", `${"A".repeat(42)}!`, "A".repeat(129), ""]) {
      const response = await handleGetSharedBinder(bad, h.deps);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(h.getSharedBinder).not.toHaveBeenCalled();
  });

  it("answers the SAME 404 for an unknown or revoked token", async () => {
    const h = makeHarness();
    const revoked = await handleGetSharedBinder(REVOKED_TOKEN, h.deps);
    const malformed = await handleGetSharedBinder("nope", h.deps);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe(await malformed.text());
    expect(revoked.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 503 (no-store, token never logged) when the database fails", async () => {
    const h = makeHarness();
    h.getSharedBinder.mockReturnValueOnce(
      Effect.fail(new DatabaseError({ message: "boom", cause: { code: "08006" } })),
    );
    const response = await handleGetSharedBinder(TOKEN, h.deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.log).toHaveBeenCalledWith("share.query_failed", {
      operation: "public_read",
      errorTag: "DatabaseError",
      pgCode: "08006",
    });
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(TOKEN);
  });

  it("answers 503 without a database configured", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleGetSharedBinder(TOKEN, h.deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });
});

describe("GET /api/shared/$token/cover (public, proxy)", () => {
  it("streams the uploaded cover as image/webp without session and without leaking the path", async () => {
    const h = makeHarness({ serviceKey: "service-jwt" });
    const response = await handleGetSharedBinderCover(TOKEN, h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("webp-bytes");
    for (const [name, value] of response.headers) {
      expect(`${name}: ${value}`).not.toContain(USER_ID);
      expect(`${name}: ${value}`).not.toContain(BINDER_ID);
    }
    expect(h.coverPath).toHaveBeenCalledWith(TOKEN);
    expect(h.storageFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.storageFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://storage:5000/object/binder-covers/${COVER_PATH}`);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer service-jwt");
    expect(headers.get("apikey")).toBe("anon-key");
    // Aucune lecture applicative d'une table privée : ni service propriétaire, ni lecture publique.
    expect(h.getSharedBinder).not.toHaveBeenCalled();
    for (const fn of Object.values(h.share)) expect(fn).not.toHaveBeenCalled();
  });

  it("falls back to the anon key when no service key is configured", async () => {
    const h = makeHarness();
    await handleGetSharedBinderCover(TOKEN, h.deps);
    const init = h.storageFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer anon-key");
  });

  it("answers 404 for a malformed token without any database call", async () => {
    const h = makeHarness();
    const response = await handleGetSharedBinderCover("../x", h.deps);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.coverPath).not.toHaveBeenCalled();
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it("answers 404 when revoked / no uploaded cover (RPC returns null)", async () => {
    const h = makeHarness();
    const response = await handleGetSharedBinderCover(REVOKED_TOKEN, h.deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it("refuses to fetch any path that is not <uuid>/<uuid>.webp (no traversal)", async () => {
    const h = makeHarness();
    for (const bad of [
      "../../secret.webp",
      `${USER_ID}/../x.webp`,
      `${USER_ID}/${BINDER_ID}.png`,
    ]) {
      h.coverPath.mockReturnValueOnce(Effect.succeed(bad));
      const response = await handleGetSharedBinderCover(TOKEN, h.deps);
      expect(response.status).toBe(404);
    }
    expect(h.storageFetch).not.toHaveBeenCalled();
  });

  it("maps an unreadable / missing Storage object to 404 and an upstream failure to 502", async () => {
    const missing = makeHarness({ storage: () => new Response("", { status: 400 }) });
    expect((await handleGetSharedBinderCover(TOKEN, missing.deps)).status).toBe(404);
    const broken = makeHarness({ storage: () => new Response("", { status: 500 }) });
    const response = await handleGetSharedBinderCover(TOKEN, broken.deps);
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 502 when the Storage is unreachable and never logs the token", async () => {
    const h = makeHarness({
      storage: () => {
        throw new TypeError("fetch failed");
      },
    });
    const response = await handleGetSharedBinderCover(TOKEN, h.deps);
    expect(response.status).toBe(502);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(TOKEN);
  });

  it("refuses an oversized upstream image", async () => {
    const h = makeHarness({
      storage: () =>
        new Response("x", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }),
    });
    expect((await handleGetSharedBinderCover(TOKEN, h.deps)).status).toBe(502);
  });

  it("answers 503 when the cover lookup fails", async () => {
    const h = makeHarness();
    h.coverPath.mockReturnValueOnce(Effect.fail(new DatabaseError({ message: "boom" })));
    expect((await handleGetSharedBinderCover(TOKEN, h.deps)).status).toBe(503);
  });

  it("answers 404 without a database configured", async () => {
    const h = makeHarness({ noDatabase: true });
    expect((await handleGetSharedBinderCover(TOKEN, h.deps)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Routes PRIVÉES
// ---------------------------------------------------------------------------

describe("GET /api/share-links", () => {
  it("returns 401 without session and never touches the database", async () => {
    const h = makeHarness();
    const response = await handleListShareLinks(request("GET", "/api/share-links"), h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.share.listLinks).not.toHaveBeenCalled();
  });

  it("lists ONLY the current user's links, enriched with the binder title, without userId", async () => {
    const h = makeHarness();
    const response = await handleListShareLinks(
      request("GET", "/api/share-links", { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as {
      links: Array<Record<string, unknown>>;
      owner: { displayName: string | null };
    };
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({
      id: LINK_ID,
      binderId: BINDER_ID,
      binderTitle: "Prisme Évolutif",
      token: TOKEN,
      showQuantities: true,
    });
    expect(body.links[0]).not.toHaveProperty("userId");
    expect(body.owner.displayName).toBe("Ada Lovelace");
    expect(h.share.listLinks).toHaveBeenCalledWith(USER_ID, {});
    expect(h.binderTitles).toHaveBeenCalledWith(USER_ID, [BINDER_ID]);
  });

  it("propagates the refreshed session cookies (Set-Cookie)", async () => {
    const h = makeHarness();
    const response = await handleListShareLinks(
      request("GET", "/api/share-links", {
        cookie: `${ACCESS_TOKEN_COOKIE}=expired; ${REFRESH_TOKEN_COOKIE}=refresh`,
      }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(";")).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("filters by binderId and rejects a non-UUID binderId", async () => {
    const h = makeHarness();
    const ok = await handleListShareLinks(
      request("GET", `/api/share-links?binderId=${BINDER_ID}`, { cookie: signedIn }),
      h.deps,
    );
    expect(ok.status).toBe(200);
    expect(h.share.listLinks).toHaveBeenCalledWith(USER_ID, { binderId: BINDER_ID });
    const bad = await handleListShareLinks(
      request("GET", "/api/share-links?binderId=nope", { cookie: signedIn }),
      h.deps,
    );
    expect(bad.status).toBe(400);
  });

  it("returns an empty list (200) without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleListShareLinks(
      request("GET", "/api/share-links", { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ links: [], owner: { displayName: "Ada Lovelace" } });
  });

  it("keeps the links when the title lookup fails (null title)", async () => {
    const h = makeHarness();
    h.binderTitles.mockReturnValueOnce(Effect.fail(new DatabaseError({ message: "boom" })));
    const response = await handleListShareLinks(
      request("GET", "/api/share-links", { cookie: signedIn }),
      h.deps,
    );
    const body = (await response.json()) as { links: Array<{ binderTitle: string | null }> };
    expect(response.status).toBe(200);
    expect(body.links[0]?.binderTitle).toBeNull();
  });

  it("answers 503 when the list query fails", async () => {
    const h = makeHarness();
    h.share.listLinks.mockReturnValueOnce(Effect.fail(new DatabaseError({ message: "boom" })));
    const response = await handleListShareLinks(
      request("GET", "/api/share-links", { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(503);
  });
});

describe("POST /api/share-links", () => {
  it("returns 403 for a foreign origin (CSRF) before anything else", async () => {
    const h = makeHarness();
    const response = await handleCreateShareLink(
      request("POST", "/api/share-links", {
        cookie: signedIn,
        origin: "https://evil.example",
        body: { binderId: BINDER_ID },
      }),
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(h.share.createLink).not.toHaveBeenCalled();
  });

  it("returns 403 for a foreign Referer when no Origin header is sent", async () => {
    const h = makeHarness();
    const response = await handleCreateShareLink(
      request("POST", "/api/share-links", {
        cookie: signedIn,
        origin: null,
        headers: { referer: "https://evil.example/page" },
        body: { binderId: BINDER_ID },
      }),
      h.deps,
    );
    expect(response.status).toBe(403);
  });

  it("returns 401 without session", async () => {
    const h = makeHarness();
    const response = await handleCreateShareLink(
      request("POST", "/api/share-links", { body: { binderId: BINDER_ID } }),
      h.deps,
    );
    expect(response.status).toBe(401);
    expect(h.share.createLink).not.toHaveBeenCalled();
  });

  it("creates a link (201) with showQuantities defaulting to the service default", async () => {
    const h = makeHarness();
    const response = await handleCreateShareLink(
      request("POST", "/api/share-links", { cookie: signedIn, body: { binderId: BINDER_ID } }),
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { link: Record<string, unknown> };
    expect(body.link).toMatchObject({
      id: LINK_ID,
      binderTitle: "Prisme Évolutif",
      isActive: true,
    });
    expect(body.link).not.toHaveProperty("userId");
    expect(h.share.createLink).toHaveBeenCalledWith(USER_ID, { binderId: BINDER_ID });
  });

  it("forwards showQuantities=false", async () => {
    const h = makeHarness();
    const response = await handleCreateShareLink(
      request("POST", "/api/share-links", {
        cookie: signedIn,
        body: { binderId: BINDER_ID, showQuantities: false },
      }),
      h.deps,
    );
    expect(response.status).toBe(201);
    expect(h.share.createLink).toHaveBeenCalledWith(USER_ID, {
      binderId: BINDER_ID,
      showQuantities: false,
    });
    const body = (await response.json()) as { link: { showQuantities: boolean } };
    expect(body.link.showQuantities).toBe(false);
  });

  it("returns 400 for a non-UUID binderId, a non-boolean showQuantities, bad JSON or a non-object", async () => {
    const h = makeHarness();
    const bodies: Array<{ body?: unknown; raw?: string }> = [
      { body: { binderId: "nope" } },
      { body: { binderId: BINDER_ID, showQuantities: "yes" } },
      { body: {} },
      { raw: "{not json" },
      { raw: "[]" },
    ];
    for (const options of bodies) {
      const response = await handleCreateShareLink(
        request("POST", "/api/share-links", { cookie: signedIn, ...options }),
        h.deps,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_input" });
    }
    expect(h.share.createLink).not.toHaveBeenCalled();
  });

  it("returns 413 above 4 KiB (declared or streamed)", async () => {
    const h = makeHarness();
    const huge = JSON.stringify({ binderId: BINDER_ID, pad: "x".repeat(5000) });
    const declared = await handleCreateShareLink(
      request("POST", "/api/share-links", { cookie: signedIn, raw: huge }),
      h.deps,
    );
    expect(declared.status).toBe(413);
    // Sans Content-Length fiable : le flux est coupé dès que le plafond est dépassé.
    const streamedInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { cookie: signedIn, origin: "http://localhost:3000" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      }),
      // Node exige `duplex` pour un corps en flux.
      duplex: "half",
    };
    const streamed = await handleCreateShareLink(
      new Request("http://localhost:3000/api/share-links", streamedInit),
      h.deps,
    );
    expect(streamed.status).toBe(413);
    expect(h.share.createLink).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's binder and 403 for a forbidden operation", async () => {
    const h = makeHarness();
    const other = await handleCreateShareLink(
      request("POST", "/api/share-links", {
        cookie: signedIn,
        body: { binderId: "99999999-9999-4999-8999-999999999999" },
      }),
      h.deps,
    );
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "not_found" });
    h.share.createLink.mockReturnValueOnce(
      Effect.fail(new ShareLinkForbiddenError({ message: "forbidden" })),
    );
    const forbidden = await handleCreateShareLink(
      request("POST", "/api/share-links", { cookie: signedIn, body: { binderId: BINDER_ID } }),
      h.deps,
    );
    expect(forbidden.status).toBe(403);
  });

  it("maps a ValidationError to 400 and a database failure to 503", async () => {
    const h = makeHarness();
    h.share.createLink.mockReturnValueOnce(Effect.fail(new ValidationError({ message: "bad" })));
    const invalid = await handleCreateShareLink(
      request("POST", "/api/share-links", { cookie: signedIn, body: { binderId: BINDER_ID } }),
      h.deps,
    );
    expect(invalid.status).toBe(400);
    h.share.createLink.mockReturnValueOnce(Effect.fail(new DatabaseError({ message: "boom" })));
    const down = await handleCreateShareLink(
      request("POST", "/api/share-links", { cookie: signedIn, body: { binderId: BINDER_ID } }),
      h.deps,
    );
    expect(down.status).toBe(503);
  });

  it("answers 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleCreateShareLink(
      request("POST", "/api/share-links", { cookie: signedIn, body: { binderId: BINDER_ID } }),
      h.deps,
    );
    expect(response.status).toBe(503);
  });
});

describe("PATCH /api/share-links/$id", () => {
  const patch = (id: string, options: Parameters<typeof request>[2] = {}) =>
    request("PATCH", `/api/share-links/${id}`, options);

  it("enforces CSRF (403), session (401), UUID (404), body size (413) and shape (400)", async () => {
    const h = makeHarness();
    expect(
      (
        await handleUpdateShareLink(
          patch(LINK_ID, {
            cookie: signedIn,
            origin: "https://evil.example",
            body: { showQuantities: true },
          }),
          LINK_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleUpdateShareLink(
          patch(LINK_ID, { body: { showQuantities: true } }),
          LINK_ID,
          h.deps,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleUpdateShareLink(
          patch("nope", { cookie: signedIn, body: { showQuantities: true } }),
          "nope",
          h.deps,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleUpdateShareLink(
          patch(LINK_ID, { cookie: signedIn, raw: JSON.stringify({ pad: "x".repeat(5000) }) }),
          LINK_ID,
          h.deps,
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await handleUpdateShareLink(
          patch(LINK_ID, { cookie: signedIn, body: { showQuantities: "no" } }),
          LINK_ID,
          h.deps,
        )
      ).status,
    ).toBe(400);
    expect(h.share.updateShowQuantities).not.toHaveBeenCalled();
  });

  it("updates showQuantities (200)", async () => {
    const h = makeHarness();
    const response = await handleUpdateShareLink(
      patch(LINK_ID, { cookie: signedIn, body: { showQuantities: false } }),
      LINK_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      ((await response.json()) as { link: { showQuantities: boolean } }).link.showQuantities,
    ).toBe(false);
    expect(h.share.updateShowQuantities).toHaveBeenCalledWith(USER_ID, LINK_ID, false);
  });

  it("returns 404 for a foreign or unknown link", async () => {
    const h = makeHarness();
    const unknown = "66666666-6666-4666-8666-666666666666";
    const response = await handleUpdateShareLink(
      patch(unknown, { cookie: signedIn, body: { showQuantities: true } }),
      unknown,
      h.deps,
    );
    expect(response.status).toBe(404);
  });

  it("answers 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleUpdateShareLink(
      patch(LINK_ID, { cookie: signedIn, body: { showQuantities: true } }),
      LINK_ID,
      h.deps,
    );
    expect(response.status).toBe(503);
  });
});

describe("DELETE /api/share-links/$id (révocation)", () => {
  const del = (id: string, options: Parameters<typeof request>[2] = {}) =>
    request("DELETE", `/api/share-links/${id}`, options);

  it("enforces CSRF (403), session (401) and UUID (404)", async () => {
    const h = makeHarness();
    expect(
      (
        await handleRevokeShareLink(
          del(LINK_ID, { cookie: signedIn, origin: "https://evil.example" }),
          LINK_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect((await handleRevokeShareLink(del(LINK_ID), LINK_ID, h.deps)).status).toBe(401);
    expect(
      (await handleRevokeShareLink(del("nope", { cookie: signedIn }), "nope", h.deps)).status,
    ).toBe(404);
    expect(h.share.revokeLink).not.toHaveBeenCalled();
  });

  it("revokes immediately and returns the revoked link (200)", async () => {
    const h = makeHarness();
    const response = await handleRevokeShareLink(
      del(LINK_ID, { cookie: signedIn }),
      LINK_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as {
      link: { isActive: boolean; revokedAt: string | null };
    };
    expect(body.link.isActive).toBe(false);
    expect(body.link.revokedAt).not.toBeNull();
    expect(h.share.revokeLink).toHaveBeenCalledWith(USER_ID, LINK_ID);
  });

  it("returns 404 for another user's link and 503 without DATABASE_URL", async () => {
    const h = makeHarness();
    const unknown = "66666666-6666-4666-8666-666666666666";
    expect(
      (await handleRevokeShareLink(del(unknown, { cookie: signedIn }), unknown, h.deps)).status,
    ).toBe(404);
    const noDb = makeHarness({ noDatabase: true });
    expect(
      (await handleRevokeShareLink(del(LINK_ID, { cookie: signedIn }), LINK_ID, noDb.deps)).status,
    ).toBe(503);
  });
});
