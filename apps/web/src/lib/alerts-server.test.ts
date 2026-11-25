import {
  AlertNotFoundError,
  AlertValidationError,
  type PriceAlert,
  ValidationError,
} from "@pokevault/domain";
import { type AlertServiceShape, DatabaseError, type Sql } from "@pokevault/services";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  type AlertsEnv,
  type AlertsServerDeps,
  handleCreateAlert,
  handleDeleteAlert,
  handleDeletePushSubscription,
  handleListAlerts,
  handleMarkEventsRead,
  handleRegisterPushSubscription,
  handleUnreadCount,
  handleUpdateAlert,
  handleUpdateChannels,
  MAX_BODY_BYTES,
  readAlertsEnv,
  readJsonBody,
  TRIGGERED_EVENTS_LIMIT,
} from "./alerts-server.ts";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ALERT_ID = "77777777-7777-4777-8777-777777777777";
const EVENT_ID = "88888888-8888-4888-8888-888888888888";
const CARD_ID = "sv03.5-199";

/** Secrets factices : ne doivent JAMAIS apparaître dans une réponse. */
const VAPID_PUBLIC = "B".repeat(87);
const VAPID_PRIVATE_SECRET = "PRIVATE-KEY-SECRET-0123456789";
const WEBHOOK_TOKEN = "abcdefghijklmnopqrstuvwxyz_-0123456789";
const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
const DEFAULT_WEBHOOK_URL = `https://discord.com/api/webhooks/987654321098765432/DEFAULT-SECRET-TOKEN-ABCDEFGHIJKL`;

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

const alertFixture = (overrides: Partial<PriceAlert> = {}): PriceAlert => ({
  id: ALERT_ID,
  userId: USER_ID,
  cardId: CARD_ID,
  language: "FR",
  variant: "normal",
  minCondition: "NM",
  priceField: "low_fr",
  thresholdCents: 1000,
  isActive: true,
  notifyPush: true,
  notifyDiscord: false,
  cooldownHours: 24,
  lastTriggeredAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const eventRow = {
  id: EVENT_ID,
  alert_id: ALERT_ID,
  observed_price_cents: 900,
  threshold_cents: 1000,
  channels_sent: ["push", "discord"],
  read_at: null,
  triggered_at: new Date("2026-03-01T10:00:00.000Z"),
  card_id: CARD_ID,
  language: "FR",
  variant: "holo",
  local_id: "199",
  card_name: "Dracaufeu ex",
  image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  cardmarket_url: "https://www.cardmarket.com/fr/Pokemon/Products/Singles/151/Charizard-ex",
  set_code: "SV03.5",
  set_name: "151",
};

const alertRow = {
  id: ALERT_ID,
  user_id: USER_ID,
  card_id: CARD_ID,
  language: "FR",
  variant: "holo",
  min_condition: "NM",
  price_field: "low_fr",
  threshold_cents: 1000,
  is_active: true,
  notify_push: true,
  notify_discord: false,
  cooldown_hours: 24,
  last_triggered_at: null,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: "2026-01-02T00:00:00.000Z",
  local_id: "199",
  card_name: "Dracaufeu ex",
  image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  cardmarket_url: "javascript:alert(1)",
  set_code: "SV03.5",
  set_name: "151",
  trend_cents: 1300,
  low_fr_cents: 1200,
  price_source: "cardmarket",
  price_fetched_at: new Date("2026-03-01T11:00:00.000Z"),
};

/** Réponses SQL par défaut, routées sur le contenu de la requête. */
const defaultResponder = (query: string): unknown => {
  if (query.includes("from public.profiles")) {
    return [{ discord_linked: true, discord_webhook_configured: true }];
  }
  if (query.includes("from public.push_subscriptions")) return [{ total: 2 }];
  if (query.includes("from public.alert_events e")) return [eventRow];
  if (query.includes("from public.price_alerts a")) return [alertRow];
  if (query.includes("from public.alert_events")) return [{ unread: 3 }];
  if (query.includes("from public.catalog_cards")) return [{ id: CARD_ID }];
  if (query.includes("update public.profiles")) return [{ configured: true }];
  return [];
};

/**
 * SQL factice : `begin` rejoue la transaction sur le même template, et chaque requête reçoit
 * sa réponse du `responder` (routé sur le contenu de la requête).
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

const ENV: AlertsEnv = readAlertsEnv({
  VAPID_PUBLIC_KEY: VAPID_PUBLIC,
  VAPID_PRIVATE_KEY: VAPID_PRIVATE_SECRET,
  DISCORD_DEFAULT_WEBHOOK_URL: DEFAULT_WEBHOOK_URL,
});

interface Harness {
  readonly deps: AlertsServerDeps;
  readonly alerts: {
    createAlert: ReturnType<typeof vi.fn>;
    updateAlert: ReturnType<typeof vi.fn>;
    deleteAlert: ReturnType<typeof vi.fn>;
    markEventRead: ReturnType<typeof vi.fn>;
    markAllEventsRead: ReturnType<typeof vi.fn>;
    countUnreadEvents: ReturnType<typeof vi.fn>;
    upsertPushSubscription: ReturnType<typeof vi.fn>;
    deletePushSubscription: ReturnType<typeof vi.fn>;
  };
  readonly log: ReturnType<typeof vi.fn>;
  readonly queries: string[];
  readonly values: unknown[][];
}

const makeHarness = (
  options: {
    readonly noDatabase?: boolean;
    readonly env?: AlertsEnv;
    readonly responder?: (query: string, values: unknown[]) => unknown;
  } = {},
): Harness => {
  const alerts = {
    createAlert: vi.fn((_userId: string, input: unknown) =>
      Effect.succeed(alertFixture(input as Partial<PriceAlert>)),
    ),
    updateAlert: vi.fn((_userId: string, _alertId: string, patch: unknown) =>
      Effect.succeed(alertFixture(patch as Partial<PriceAlert>)),
    ),
    deleteAlert: vi.fn(() => Effect.succeed(undefined)),
    markEventRead: vi.fn(() => Effect.succeed({})),
    markAllEventsRead: vi.fn(() => Effect.succeed(3)),
    countUnreadEvents: vi.fn(() => Effect.succeed(0)),
    upsertPushSubscription: vi.fn(() => Effect.succeed({})),
    deletePushSubscription: vi.fn(() => Effect.succeed(undefined)),
  };
  const log = vi.fn();
  const { sql, queries, values } = makeSql(options.responder ?? defaultResponder);
  const deps: AlertsServerDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    services: options.noDatabase ? null : { alerts: alerts as unknown as AlertServiceShape, sql },
    env: options.env ?? ENV,
    log,
  };
  return { deps, alerts, log, queries, values };
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

const API = "/api/alerts";
const ALERT_API = `/api/alerts/${ALERT_ID}`;
const READ_API = "/api/alerts/events/read";
const COUNT_API = "/api/alerts/unread-count";
const CHANNELS_API = "/api/alerts/channels";
const PUSH_API = "/api/push-subscriptions";

// ---------------------------------------------------------------------------
// readAlertsEnv
// ---------------------------------------------------------------------------

describe("readAlertsEnv", () => {
  it("expose uniquement la clé VAPID PUBLIQUE bien formée et des booléens", () => {
    expect(ENV).toEqual({ vapidPublicKey: VAPID_PUBLIC, discordDefaultConfigured: true });
    expect(JSON.stringify(ENV)).not.toContain(VAPID_PRIVATE_SECRET);
    expect(JSON.stringify(ENV)).not.toContain("DEFAULT-SECRET");
  });

  it("ignore une clé publique mal formée et un webhook par défaut non autorisé", () => {
    expect(
      readAlertsEnv({
        VAPID_PUBLIC_KEY: "trop-court",
        DISCORD_DEFAULT_WEBHOOK_URL: "https://evil.test/api/webhooks/1/x",
      }),
    ).toEqual({ vapidPublicKey: null, discordDefaultConfigured: false });
    expect(readAlertsEnv({})).toEqual({ vapidPublicKey: null, discordDefaultConfigured: false });
  });
});

// ---------------------------------------------------------------------------
// GET /api/alerts
// ---------------------------------------------------------------------------

describe("GET /api/alerts", () => {
  it("returns 401 without a session (no-store)", async () => {
    const h = makeHarness();
    const response = await handleListAlerts(req("GET", API), h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.queries).toHaveLength(0);
  });

  it("returns channels, triggered events, alerts and the unread count", async () => {
    const h = makeHarness();
    const response = await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      unreadCount: 3,
      channels: {
        pushSubscriptionsCount: 2,
        pushConfigured: true,
        vapidPublicKey: VAPID_PUBLIC,
        discordLinked: true,
        discordWebhookConfigured: true,
        discordDefaultConfigured: true,
      },
    });
    expect(body["triggeredEvents"]).toEqual([
      {
        id: EVENT_ID,
        alertId: ALERT_ID,
        cardId: CARD_ID,
        cardName: "Dracaufeu ex",
        setCode: "SV03.5",
        setName: "151",
        localId: "199",
        language: "FR",
        variant: "holo",
        imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199/low.webp",
        cardmarketUrl: "https://www.cardmarket.com/fr/Pokemon/Products/Singles/151/Charizard-ex",
        observedPriceCents: 900,
        thresholdCents: 1000,
        channelsSent: ["push", "discord"],
        readAt: null,
        triggeredAt: "2026-03-01T10:00:00.000Z",
      },
    ]);
    expect(body["alerts"]).toEqual([
      expect.objectContaining({
        id: ALERT_ID,
        userId: USER_ID,
        cardName: "Dracaufeu ex",
        setName: "151",
        localId: "199",
        thresholdCents: 1000,
        priceField: "low_fr",
        trendCents: 1300,
        lowFrCents: 1200,
        priceSource: "cardmarket",
        priceFetchedAt: "2026-03-01T11:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        // Une URL non https n'est jamais renvoyée au client.
        cardmarketUrl: null,
      }),
    ]);
  });

  it("never leaks the Discord webhook URL, the VAPID private key or any secret", async () => {
    const h = makeHarness();
    const response = await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps);
    const text = await response.text();
    expect(text).not.toContain(VAPID_PRIVATE_SECRET);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(WEBHOOK_TOKEN);
    expect(text).not.toContain("DEFAULT-SECRET");
    expect(text).not.toContain("discord.com/api/webhooks");
    expect(text).not.toContain("p256dh");
    // Le webhook n'est sélectionné QUE comme booléen (`is not null`), jamais en clair.
    const profileQuery = h.queries.find((q) => q.includes("from public.profiles")) ?? "";
    expect(profileQuery).toContain(
      "(discord_webhook_url is not null) as discord_webhook_configured",
    );
    expect(profileQuery).not.toMatch(/select\s+discord_webhook_url/);
    expect(profileQuery).not.toMatch(/,\s*discord_webhook_url\s*,/);
  });

  it("joins card_latest_prices as LEFT JOIN LATERAL (... LIMIT 1), scoped by user", async () => {
    const h = makeHarness();
    await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps);
    const index = h.queries.findIndex((q) => q.includes("from public.price_alerts a"));
    expect(index).toBeGreaterThanOrEqual(0);
    const query = (h.queries[index] ?? "").replace(/\s+/g, " ");
    expect(query).toContain("join public.catalog_cards c on c.id = a.card_id");
    expect(query).toContain("join public.catalog_sets s on s.id = c.set_id");
    expect(query).toMatch(/left join lateral/);
    expect(query).toContain("from public.card_latest_prices lp");
    expect(query).toContain("lp.card_id = a.card_id");
    expect(query).toContain("lp.language = a.language");
    expect(query).toContain("lp.variant = a.variant");
    expect(query).toContain("limit 1");
    expect(query).toContain("a.user_id = ?");
    expect(h.values[index]).toContain(USER_ID);
  });

  it("scopes events, push subscriptions, profile and unread count by the session user", async () => {
    const h = makeHarness();
    await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps);
    const eventIndex = h.queries.findIndex((q) => q.includes("from public.alert_events e"));
    expect(h.queries[eventIndex]).toContain("e.user_id = ?");
    expect(h.values[eventIndex]).toContain(USER_ID);
    expect(h.values[eventIndex]).toContain(TRIGGERED_EVENTS_LIMIT);
    for (const needle of [
      "from public.profiles",
      "from public.push_subscriptions",
      "read_at is null",
    ]) {
      const index = h.queries.findIndex((q) => q.includes(needle));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(h.values[index]).toContain(USER_ID);
    }
  });

  it("returns an empty documented payload (200, never 500) without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      channels: {
        pushSubscriptionsCount: 0,
        pushConfigured: true,
        vapidPublicKey: VAPID_PUBLIC,
        discordLinked: false,
        discordWebhookConfigured: false,
        discordDefaultConfigured: true,
      },
      triggeredEvents: [],
      alerts: [],
      unreadCount: 0,
    });
  });

  it("reports push as not configured when no VAPID public key is set", async () => {
    const h = makeHarness({ env: readAlertsEnv({}) });
    const body = (await (
      await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps)
    ).json()) as { channels: Record<string, unknown> };
    expect(body.channels).toMatchObject({ pushConfigured: false, vapidPublicKey: null });
  });

  it("returns 503 without any SQL detail when a query fails", async () => {
    const h = makeHarness({
      responder: () => {
        throw Object.assign(new Error('relation "price_alerts" does not exist'), {
          code: "42P01",
        });
      },
    });
    const response = await handleListAlerts(req("GET", API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ error: "alerts_unavailable" }));
    expect(text).not.toContain("price_alerts");
    expect(h.log).toHaveBeenCalledWith(
      "alerts.query_failed",
      expect.objectContaining({ operation: "list" }),
    );
    for (const [, fields] of h.log.mock.calls) {
      expect(JSON.stringify(fields)).not.toContain("does not exist");
    }
  });

  it("propagates refreshed session cookies via Set-Cookie", async () => {
    const h = makeHarness();
    const response = await handleListAlerts(
      req("GET", API, { cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });
});

// ---------------------------------------------------------------------------
// GET /api/alerts/unread-count
// ---------------------------------------------------------------------------

describe("GET /api/alerts/unread-count", () => {
  it("returns 401 without a session", async () => {
    const h = makeHarness();
    const response = await handleUnreadCount(req("GET", COUNT_API), h.deps);
    expect(response.status).toBe(401);
    expect(h.alerts.countUnreadEvents).not.toHaveBeenCalled();
  });

  it("returns the unread count of the session user (no-store)", async () => {
    const h = makeHarness();
    h.alerts.countUnreadEvents.mockReturnValue(Effect.succeed(5));
    const response = await handleUnreadCount(req("GET", COUNT_API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ unreadCount: 5 });
    expect(h.alerts.countUnreadEvents).toHaveBeenCalledWith(USER_ID);
  });

  it("returns 0 (200) without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleUnreadCount(req("GET", COUNT_API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unreadCount: 0 });
  });

  it("never answers 500 : a failing query gives a detail-free 503", async () => {
    const h = makeHarness();
    h.alerts.countUnreadEvents.mockReturnValue(
      Effect.fail(
        new DatabaseError({ message: "postgres query failed", cause: new Error("boom") }),
      ),
    );
    const response = await handleUnreadCount(req("GET", COUNT_API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// Corps JSON borné
// ---------------------------------------------------------------------------

describe("bounded streamed JSON body (8 KiB)", () => {
  it("returns 413 when the declared content-length exceeds the cap", async () => {
    const h = makeHarness();
    const response = await handleCreateAlert(
      req("POST", API, {
        cookie: signedIn,
        contentLength: String(MAX_BODY_BYTES + 1),
        raw: "{}",
      }),
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it("returns 413 when the raw body exceeds the cap", async () => {
    const h = makeHarness();
    const response = await handleUpdateAlert(
      req("PATCH", ALERT_API, { cookie: signedIn, raw: `{"x":"${"x".repeat(MAX_BODY_BYTES)}"}` }),
      ALERT_ID,
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(h.alerts.updateAlert).not.toHaveBeenCalled();
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
    const response = await handleCreateAlert(streamRequest("POST", API, stream), h.deps);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(chunksEmitted).toBeLessThanOrEqual(6);
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it("returns 413 on the webhook route too, and 400 (never 500) on a broken stream", async () => {
    const h = makeHarness();
    const big = await handleUpdateChannels(
      req("PATCH", CHANNELS_API, {
        cookie: signedIn,
        raw: JSON.stringify({ discordWebhookUrl: "x".repeat(MAX_BODY_BYTES) }),
      }),
      h.deps,
    );
    expect(big.status).toBe(413);
    const broken = await handleMarkEventsRead(
      streamRequest(
        "POST",
        READ_API,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      ),
      h.deps,
    );
    expect(broken.status).toBe(400);
  });

  it("readJsonBody counts real bytes (multi-byte characters) and supports empty bodies", async () => {
    expect(
      (await readJsonBody(req("POST", API, { raw: JSON.stringify({ a: "é".repeat(3000) }) }))).ok,
    ).toBe(true);
    expect(
      await readJsonBody(req("POST", API, { raw: JSON.stringify({ a: "€".repeat(5000) }) })),
    ).toEqual({ ok: false, status: 413 });
    expect(await readJsonBody(req("POST", API, { raw: "  " }), { allowEmpty: true })).toEqual({
      ok: true,
      body: {},
    });
    expect(await readJsonBody(req("POST", API, { raw: "{" }))).toEqual({ ok: false, status: 400 });
  });
});

// ---------------------------------------------------------------------------
// POST /api/alerts
// ---------------------------------------------------------------------------

describe("POST /api/alerts", () => {
  const body = { cardId: CARD_ID, thresholdCents: 1000, priceField: "trend", notifyPush: true };

  it("returns 403 cross-origin (Origin or Referer)", async () => {
    const h = makeHarness();
    const evil = await handleCreateAlert(
      req("POST", API, { cookie: signedIn, origin: "https://evil.test", body }),
      h.deps,
    );
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: "forbidden_origin" });
    const referer = new Request(`http://localhost:3000${API}`, {
      method: "POST",
      headers: {
        cookie: signedIn,
        referer: "https://evil.test/page",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect((await handleCreateAlert(referer, h.deps)).status).toBe(403);
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const h = makeHarness();
    const response = await handleCreateAlert(req("POST", API, { body }), h.deps);
    expect(response.status).toBe(401);
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-object body, a missing/oversized cardId and invalid JSON", async () => {
    const h = makeHarness();
    for (const raw of [
      "[]",
      '"x"',
      "null",
      "{",
      JSON.stringify({ thresholdCents: 1 }),
      JSON.stringify({ cardId: 12 }),
      JSON.stringify({ cardId: "x".repeat(200) }),
    ]) {
      const response = await handleCreateAlert(req("POST", API, { cookie: signedIn, raw }), h.deps);
      expect(response.status).toBe(400);
    }
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it("returns 404 when the card does not exist in the catalog", async () => {
    const h = makeHarness({
      responder: (query) =>
        query.includes("from public.catalog_cards") ? [] : defaultResponder(query),
    });
    const response = await handleCreateAlert(req("POST", API, { cookie: signedIn, body }), h.deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(h.alerts.createAlert).not.toHaveBeenCalled();
  });

  it("creates the alert for the session user and returns 201", async () => {
    const h = makeHarness();
    const response = await handleCreateAlert(req("POST", API, { cookie: signedIn, body }), h.deps);
    expect(response.status).toBe(201);
    expect(h.alerts.createAlert).toHaveBeenCalledWith(USER_ID, body);
    expect(await response.json()).toMatchObject({ id: ALERT_ID, cardId: CARD_ID });
    const existsIndex = h.queries.findIndex((q) => q.includes("from public.catalog_cards"));
    expect(h.values[existsIndex]).toContain(CARD_ID);
  });

  it("never lets the body override the session user", async () => {
    const h = makeHarness();
    await handleCreateAlert(
      req("POST", API, {
        cookie: signedIn,
        body: { ...body, userId: "99999999-9999-4999-8999-999999999999" },
      }),
      h.deps,
    );
    expect(h.alerts.createAlert.mock.calls[0]?.[0]).toBe(USER_ID);
  });

  it("maps domain validation errors to 400 and database errors to a detail-free 503", async () => {
    const invalid = makeHarness();
    invalid.alerts.createAlert.mockReturnValue(
      Effect.fail(new AlertValidationError({ message: "invalid alert data" })),
    );
    expect(
      (await handleCreateAlert(req("POST", API, { cookie: signedIn, body }), invalid.deps)).status,
    ).toBe(400);

    const generic = makeHarness();
    generic.alerts.createAlert.mockReturnValue(
      Effect.fail(new ValidationError({ message: "bad" })),
    );
    expect(
      (await handleCreateAlert(req("POST", API, { cookie: signedIn, body }), generic.deps)).status,
    ).toBe(400);

    const broken = makeHarness();
    broken.alerts.createAlert.mockReturnValue(
      Effect.fail(
        new DatabaseError({
          message: "postgres query failed",
          cause: Object.assign(new Error("secret sql"), { code: "08006" }),
        }),
      ),
    );
    const response = await handleCreateAlert(
      req("POST", API, { cookie: signedIn, body }),
      broken.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret sql");
    expect(broken.log).toHaveBeenCalledWith(
      "alerts.query_failed",
      expect.objectContaining({ operation: "create", pgCode: "08006" }),
    );
  });

  it("returns 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleCreateAlert(req("POST", API, { cookie: signedIn, body }), h.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "alerts_unavailable" });
  });
});

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/alerts/$id
// ---------------------------------------------------------------------------

describe("PATCH /api/alerts/$id", () => {
  it("returns 403 cross-origin and 401 without a session", async () => {
    const h = makeHarness();
    const evil = await handleUpdateAlert(
      req("PATCH", ALERT_API, {
        cookie: signedIn,
        origin: "https://evil.test",
        body: { isActive: false },
      }),
      ALERT_ID,
      h.deps,
    );
    expect(evil.status).toBe(403);
    const anon = await handleUpdateAlert(
      req("PATCH", ALERT_API, { body: { isActive: false } }),
      ALERT_ID,
      h.deps,
    );
    expect(anon.status).toBe(401);
    expect(h.alerts.updateAlert).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-UUID id without touching the service", async () => {
    const h = makeHarness();
    const response = await handleUpdateAlert(
      req("PATCH", "/api/alerts/not-a-uuid", { cookie: signedIn, body: { isActive: false } }),
      "not-a-uuid",
      h.deps,
    );
    expect(response.status).toBe(404);
    expect(h.alerts.updateAlert).not.toHaveBeenCalled();
  });

  it("updates the alert (switch isActive, threshold, channels…) and returns 200", async () => {
    const h = makeHarness();
    const patch = {
      isActive: false,
      thresholdCents: 850,
      priceField: "trend",
      minCondition: "EX",
      notifyPush: false,
      notifyDiscord: true,
      cooldownHours: 48,
    };
    const response = await handleUpdateAlert(
      req("PATCH", ALERT_API, { cookie: signedIn, body: patch }),
      ALERT_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(h.alerts.updateAlert).toHaveBeenCalledWith(USER_ID, ALERT_ID, patch);
    expect(await response.json()).toMatchObject({ id: ALERT_ID, isActive: false });
  });

  it("maps not-found to 404 and invalid input to 400", async () => {
    const missing = makeHarness();
    missing.alerts.updateAlert.mockReturnValue(
      Effect.fail(new AlertNotFoundError({ alertId: ALERT_ID, message: "nope" })),
    );
    expect(
      (
        await handleUpdateAlert(
          req("PATCH", ALERT_API, { cookie: signedIn, body: { isActive: true } }),
          ALERT_ID,
          missing.deps,
        )
      ).status,
    ).toBe(404);

    const invalid = makeHarness();
    invalid.alerts.updateAlert.mockReturnValue(
      Effect.fail(new AlertValidationError({ message: "at least one field is required" })),
    );
    expect(
      (
        await handleUpdateAlert(
          req("PATCH", ALERT_API, { cookie: signedIn, body: {} }),
          ALERT_ID,
          invalid.deps,
        )
      ).status,
    ).toBe(400);
  });

  it("returns 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleUpdateAlert(
      req("PATCH", ALERT_API, { cookie: signedIn, body: { isActive: true } }),
      ALERT_ID,
      h.deps,
    );
    expect(response.status).toBe(503);
  });
});

describe("DELETE /api/alerts/$id", () => {
  it("returns 403 cross-origin, 401, and 404 for a non-UUID id", async () => {
    const h = makeHarness();
    expect(
      (
        await handleDeleteAlert(
          req("DELETE", ALERT_API, { cookie: signedIn, origin: "https://evil.test" }),
          ALERT_ID,
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect((await handleDeleteAlert(req("DELETE", ALERT_API), ALERT_ID, h.deps)).status).toBe(401);
    expect(
      (await handleDeleteAlert(req("DELETE", "/api/alerts/x", { cookie: signedIn }), "x", h.deps))
        .status,
    ).toBe(404);
    expect(h.alerts.deleteAlert).not.toHaveBeenCalled();
  });

  it("deletes the alert of the session user and returns 200", async () => {
    const h = makeHarness();
    const response = await handleDeleteAlert(
      req("DELETE", ALERT_API, { cookie: signedIn }),
      ALERT_ID,
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.alerts.deleteAlert).toHaveBeenCalledWith(USER_ID, ALERT_ID);
  });

  it("returns 404 when the alert does not exist (or belongs to another user)", async () => {
    const h = makeHarness();
    h.alerts.deleteAlert.mockReturnValue(
      Effect.fail(new AlertNotFoundError({ alertId: ALERT_ID, message: "nope" })),
    );
    const response = await handleDeleteAlert(
      req("DELETE", ALERT_API, { cookie: signedIn }),
      ALERT_ID,
      h.deps,
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/alerts/events/read
// ---------------------------------------------------------------------------

describe("POST /api/alerts/events/read", () => {
  it("returns 403 cross-origin and 401 without a session", async () => {
    const h = makeHarness();
    expect(
      (
        await handleMarkEventsRead(
          req("POST", READ_API, { cookie: signedIn, origin: "https://evil.test", body: {} }),
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect((await handleMarkEventsRead(req("POST", READ_API, { body: {} }), h.deps)).status).toBe(
      401,
    );
    expect(h.alerts.markAllEventsRead).not.toHaveBeenCalled();
  });

  it("marks ALL unread events read (empty body) and returns the new unread count", async () => {
    const h = makeHarness();
    h.alerts.countUnreadEvents.mockReturnValue(Effect.succeed(0));
    const response = await handleMarkEventsRead(
      req("POST", READ_API, { cookie: signedIn }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unreadCount: 0 });
    expect(h.alerts.markAllEventsRead).toHaveBeenCalledWith(USER_ID);
    expect(h.alerts.markEventRead).not.toHaveBeenCalled();
  });

  it("marks a single event read when eventId is given", async () => {
    const h = makeHarness();
    h.alerts.countUnreadEvents.mockReturnValue(Effect.succeed(2));
    const response = await handleMarkEventsRead(
      req("POST", READ_API, { cookie: signedIn, body: { eventId: EVENT_ID } }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unreadCount: 2 });
    expect(h.alerts.markEventRead).toHaveBeenCalledWith(USER_ID, EVENT_ID);
    expect(h.alerts.markAllEventsRead).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-UUID eventId, 400 for a non-string one, 404 for an unknown event", async () => {
    const h = makeHarness();
    expect(
      (
        await handleMarkEventsRead(
          req("POST", READ_API, { cookie: signedIn, body: { eventId: "nope" } }),
          h.deps,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleMarkEventsRead(
          req("POST", READ_API, { cookie: signedIn, body: { eventId: 12 } }),
          h.deps,
        )
      ).status,
    ).toBe(400);
    h.alerts.markEventRead.mockReturnValue(
      Effect.fail(new AlertNotFoundError({ alertId: EVENT_ID, message: "nope" })),
    );
    expect(
      (
        await handleMarkEventsRead(
          req("POST", READ_API, { cookie: signedIn, body: { eventId: EVENT_ID } }),
          h.deps,
        )
      ).status,
    ).toBe(404);
  });

  it("returns 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    expect(
      (await handleMarkEventsRead(req("POST", READ_API, { cookie: signedIn }), h.deps)).status,
    ).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/alerts/channels — webhook Discord (anti-SSRF)
// ---------------------------------------------------------------------------

describe("PATCH /api/alerts/channels", () => {
  const patch = (body: unknown, options: { origin?: string | null; cookie?: string } = {}) =>
    req("PATCH", CHANNELS_API, { cookie: options.cookie ?? signedIn, body, ...options });

  it("returns 403 cross-origin and 401 without a session", async () => {
    const h = makeHarness();
    expect(
      (
        await handleUpdateChannels(
          req("PATCH", CHANNELS_API, {
            cookie: signedIn,
            origin: "https://evil.test",
            body: { discordWebhookUrl: null },
          }),
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleUpdateChannels(
          req("PATCH", CHANNELS_API, { body: { discordWebhookUrl: null } }),
          h.deps,
        )
      ).status,
    ).toBe(401);
    expect(h.queries).toHaveLength(0);
  });

  it.each([
    ["http (non TLS)", `http://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
    [
      "hôte discordapp.com (hors motif SQL)",
      `https://discordapp.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`,
    ],
    [
      "version d'API /v10/",
      `https://discord.com/api/v10/webhooks/123456789012345678/${WEBHOOK_TOKEN}`,
    ],
    [
      "sous-domaine piégé discord.com.evil.test",
      `https://discord.com.evil.test/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`,
    ],
    ["autre hôte", `https://evil.test/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
    ["IP loopback", `https://127.0.0.1/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
    ["metadata cloud", `https://169.254.169.254/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
    [
      "identifiants dans l'URL",
      `https://user:pw@discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`,
    ],
    [
      "port non standard",
      `https://discord.com:8443/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`,
    ],
    ["query string", `${WEBHOOK_URL}?wait=true`],
    ["fragment", `${WEBHOOK_URL}#x`],
    ["traversée de chemin", `https://discord.com/api/webhooks/../../x/${WEBHOOK_TOKEN}`],
    ["chaîne vide", ""],
    ["schéma javascript", "javascript:alert(1)"],
  ])(
    "rejects an invalid webhook (%s) with 400 and never queries the database",
    async (_name, url) => {
      const h = makeHarness();
      const response = await handleUpdateChannels(patch({ discordWebhookUrl: url }), h.deps);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_webhook_url" });
      expect(h.queries).toHaveLength(0);
    },
  );

  it("returns 400 when the key is missing or the value is not a string/null", async () => {
    const h = makeHarness();
    for (const body of [{}, [], "x", { discordWebhookUrl: 12 }, { discordWebhookUrl: {} }]) {
      expect((await handleUpdateChannels(patch(body), h.deps)).status).toBe(400);
    }
    expect(h.queries).toHaveLength(0);
  });

  it("stores a valid webhook under RLS, scoped by user, and never echoes the URL", async () => {
    const h = makeHarness();
    const response = await handleUpdateChannels(
      patch({ discordWebhookUrl: `  ${WEBHOOK_URL}  ` }),
      h.deps,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ discordWebhookConfigured: true });
    expect(text).not.toContain(WEBHOOK_TOKEN);
    const index = h.queries.findIndex((q) => q.includes("update public.profiles"));
    expect(index).toBeGreaterThanOrEqual(0);
    const query = (h.queries[index] ?? "").replace(/\s+/g, " ");
    expect(query).toContain("discord_webhook_url = ?::text");
    expect(query).toContain("discord_alerts_enabled");
    expect(query).toContain("where id = ?");
    expect(h.values[index]).toContain(WEBHOOK_URL);
    expect(h.values[index]).toContain(USER_ID);
    // L'URL (secret) n'est jamais journalisée.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(WEBHOOK_TOKEN);
  });

  it("removes the webhook with null", async () => {
    const h = makeHarness({
      responder: (query) =>
        query.includes("update public.profiles") ? [{ configured: false }] : [],
    });
    const response = await handleUpdateChannels(patch({ discordWebhookUrl: null }), h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ discordWebhookConfigured: false });
    const index = h.queries.findIndex((q) => q.includes("update public.profiles"));
    expect(h.values[index]?.[0]).toBeNull();
  });

  it("returns 404 when no profile row matches and a detail-free 503 on SQL failure", async () => {
    const none = makeHarness({ responder: () => [] });
    expect((await handleUpdateChannels(patch({ discordWebhookUrl: null }), none.deps)).status).toBe(
      404,
    );
    const broken = makeHarness({
      responder: () => {
        throw new Error(`failed for ${WEBHOOK_URL}`);
      },
    });
    const response = await handleUpdateChannels(
      patch({ discordWebhookUrl: WEBHOOK_URL }),
      broken.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(WEBHOOK_TOKEN);
    expect(JSON.stringify(broken.log.mock.calls)).not.toContain(WEBHOOK_TOKEN);
  });

  it("returns 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    expect((await handleUpdateChannels(patch({ discordWebhookUrl: null }), h.deps)).status).toBe(
      503,
    );
  });
});

// ---------------------------------------------------------------------------
// POST / DELETE /api/push-subscriptions
// ---------------------------------------------------------------------------

describe("/api/push-subscriptions", () => {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    p256dh: "B".repeat(87),
    auth: "A".repeat(22),
  };

  it("POST returns 403 cross-origin, 401 and 413", async () => {
    const h = makeHarness();
    expect(
      (
        await handleRegisterPushSubscription(
          req("POST", PUSH_API, {
            cookie: signedIn,
            origin: "https://evil.test",
            body: subscription,
          }),
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleRegisterPushSubscription(req("POST", PUSH_API, { body: subscription }), h.deps))
        .status,
    ).toBe(401);
    expect(
      (
        await handleRegisterPushSubscription(
          req("POST", PUSH_API, {
            cookie: signedIn,
            contentLength: String(MAX_BODY_BYTES + 1),
            raw: "{}",
          }),
          h.deps,
        )
      ).status,
    ).toBe(413);
    expect(h.alerts.upsertPushSubscription).not.toHaveBeenCalled();
  });

  it("POST registers the device subscription for the session user (201, keys never echoed)", async () => {
    const h = makeHarness();
    const response = await handleRegisterPushSubscription(
      req("POST", PUSH_API, { cookie: signedIn, body: subscription }),
      h.deps,
    );
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ registered: true });
    expect(text).not.toContain(subscription.p256dh);
    expect(text).not.toContain(subscription.auth);
    expect(h.alerts.upsertPushSubscription).toHaveBeenCalledWith(USER_ID, subscription);
  });

  it("POST maps an unsafe endpoint to 400 and an endpoint owned by another account to 409", async () => {
    const unsafe = makeHarness();
    unsafe.alerts.upsertPushSubscription.mockReturnValue(
      Effect.fail(new AlertValidationError({ message: "endpoint must be a public https URL" })),
    );
    expect(
      (
        await handleRegisterPushSubscription(
          req("POST", PUSH_API, {
            cookie: signedIn,
            body: { ...subscription, endpoint: "https://127.0.0.1/x" },
          }),
          unsafe.deps,
        )
      ).status,
    ).toBe(400);

    const foreign = makeHarness();
    foreign.alerts.upsertPushSubscription.mockReturnValue(
      Effect.fail(
        new AlertValidationError({ message: "this endpoint is registered by another account" }),
      ),
    );
    const response = await handleRegisterPushSubscription(
      req("POST", PUSH_API, { cookie: signedIn, body: subscription }),
      foreign.deps,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });

  it("DELETE removes the subscription of the session user (idempotent 200)", async () => {
    const h = makeHarness();
    const response = await handleDeletePushSubscription(
      req("DELETE", PUSH_API, { cookie: signedIn, body: { endpoint: subscription.endpoint } }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.alerts.deletePushSubscription).toHaveBeenCalledWith(USER_ID, subscription.endpoint);
  });

  it("DELETE validates the endpoint and enforces CSRF / session", async () => {
    const h = makeHarness();
    for (const body of [{}, { endpoint: 12 }, { endpoint: "" }, { endpoint: "x".repeat(3000) }]) {
      expect(
        (
          await handleDeletePushSubscription(
            req("DELETE", PUSH_API, { cookie: signedIn, body }),
            h.deps,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await handleDeletePushSubscription(
          req("DELETE", PUSH_API, {
            cookie: signedIn,
            origin: "https://evil.test",
            body: { endpoint: subscription.endpoint },
          }),
          h.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleDeletePushSubscription(
          req("DELETE", PUSH_API, { body: { endpoint: subscription.endpoint } }),
          h.deps,
        )
      ).status,
    ).toBe(401);
    expect(h.alerts.deletePushSubscription).not.toHaveBeenCalled();
  });

  it("returns 503 without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    expect(
      (
        await handleRegisterPushSubscription(
          req("POST", PUSH_API, { cookie: signedIn, body: subscription }),
          h.deps,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await handleDeletePushSubscription(
          req("DELETE", PUSH_API, { cookie: signedIn, body: { endpoint: subscription.endpoint } }),
          h.deps,
        )
      ).status,
    ).toBe(503);
  });
});
