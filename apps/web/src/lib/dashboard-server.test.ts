import type { Sql } from "@pokevault/services";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import type { DashboardPayload } from "./dashboard-client.ts";
import {
  type DashboardServerDeps,
  emptyDashboardPayload,
  handleGetDashboard,
} from "./dashboard-server.ts";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BINDER_ID = "33333333-3333-4333-8333-333333333333";
const BINDER_2_ID = "44444444-4444-4444-8444-444444444444";
const ALERT_ID = "55555555-5555-4555-8555-555555555555";
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

const minutesAgoDate = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

const summaryRow = {
  owned_cards_count: 3,
  total_value_cents: 154200,
  sum_current_cents: 154200,
  sum_avg30_cents: 140000,
  priced_cards_count: 2,
  oldest_price_fetched_at: minutesAgoDate(5),
  has_fallback_price: false,
};

const featuredRow = {
  card_id: CARD_ID,
  name: "Dracaufeu ex",
  local_id: "199",
  image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  set_code: "SV03.5",
  set_name: "151",
  language: "FR",
  variant: "holo",
  quantity: 2,
  effective_price_cents: 77100,
  avg30_cents: 70000,
  price_source: "cardmarket",
  price_fetched_at: minutesAgoDate(5),
  price_expires_at: minutesAgoDate(-10),
};

const binderRow = {
  id: BINDER_ID,
  title: "151",
  kind: "set",
  cover_type: "card",
  updated_at: minutesAgoDate(60),
  set_code: "SV03.5",
  cover_logo_url: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
  cover_card_image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
};

const customBinderRow = {
  id: BINDER_2_ID,
  title: "Mes favoris",
  kind: "custom",
  cover_type: "upload",
  updated_at: minutesAgoDate(30),
  set_code: null,
  cover_logo_url: null,
  cover_card_image_base_url: null,
};

const setAggRow = { binder_id: BINDER_ID, owned_count: 58, total_count: 100, value_cents: 154200 };
const customAggRow = {
  binder_id: BINDER_2_ID,
  card_count: 12,
  owned_count: 5,
  value_cents: 3200,
};

const alertRow = {
  alert_id: ALERT_ID,
  card_id: CARD_ID,
  card_name: "Dracaufeu ex",
  observed_price_cents: 77100,
  threshold_cents: 80000,
  triggered_at: minutesAgoDate(120),
};

type Responder = (query: string, values: unknown[]) => unknown;

const fullResponder: Responder = (query) => {
  if (query.includes("to_regclass")) return [{ has_alerts: true, has_share_links: true }];
  if (query.includes("set_config")) return [];
  if (query.includes("owned_cards_count")) return [summaryRow];
  if (query.includes("effective_price_cents")) return [featuredRow];
  if (query.includes("public.binder_cards")) return [customAggRow];
  if (query.includes("s.total_count")) return [setAggRow];
  if (query.includes("from public.share_links")) return [{ binder_id: BINDER_ID }];
  if (query.includes("from public.alert_events")) return [alertRow];
  if (query.includes("from public.binders")) return [binderRow, customBinderRow];
  return [];
};

interface Harness {
  readonly deps: DashboardServerDeps;
  readonly log: ReturnType<typeof vi.fn>;
  readonly queries: string[];
  readonly values: unknown[][];
}

const makeHarness = (options: { noDatabase?: boolean; responder?: Responder } = {}): Harness => {
  const log = vi.fn();
  const { sql, queries, values } = makeSql(options.responder ?? fullResponder);
  const deps: DashboardServerDeps = {
    auth: { config, fetch: async (url, init) => gotrue(url, init) },
    services: options.noDatabase ? null : { sql },
    log,
  };
  return { deps, log, queries, values };
};

const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;

const req = (path: string, options: { readonly cookie?: string } = {}): Request =>
  new Request(`http://localhost:3000${path}`, {
    method: "GET",
    headers: options.cookie === undefined ? {} : { cookie: options.cookie },
  });

const API = "/api/dashboard";

// ---------------------------------------------------------------------------
// GET /api/dashboard
// ---------------------------------------------------------------------------

describe("GET /api/dashboard", () => {
  it("returns 401 + no-store without a session and never touches the database", async () => {
    const h = makeHarness();
    const response = await handleGetDashboard(req(API), h.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.queries).toHaveLength(0);
  });

  it("returns no-store and propagates refreshed session cookies via Set-Cookie", async () => {
    const h = makeHarness();
    const response = await handleGetDashboard(
      req(API, { cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
  });

  it("serves the documented empty payload (200, no-store) without DATABASE_URL", async () => {
    const h = makeHarness({ noDatabase: true });
    const response = await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(emptyDashboardPayload());
    expect(h.queries).toHaveLength(0);
    expect(h.log).toHaveBeenCalledWith(
      "dashboard.database_url_missing",
      expect.objectContaining({ operation: "get" }),
    );
  });

  it("returns 503 without any detail on SQL error (cookies still propagated)", async () => {
    const h = makeHarness({
      responder: (query) => {
        if (query.includes("set_config")) return [];
        throw new Error("relation public.user_card_copies does not exist");
      },
    });
    const response = await handleGetDashboard(
      req(API, { cookie: `${REFRESH_TOKEN_COOKIE}=refresh-old` }),
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain(`${ACCESS_TOKEN_COOKIE}=`);
    const bodyText = await response.text();
    expect(JSON.parse(bodyText)).toEqual({ error: "dashboard_unavailable" });
    expect(bodyText).not.toContain("does not exist");
    expect(h.log).toHaveBeenCalledWith(
      "dashboard.query_failed",
      expect.objectContaining({ operation: "get" }),
    );
  });

  it("aggregates summary, featured cards, binders and the latest alert", async () => {
    const h = makeHarness();
    const response = await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as DashboardPayload;

    expect(body.summary).toEqual({
      totalValueCents: 154200,
      // (154200 - 140000) / 140000 -> 10,1 %
      delta30dPercent: 10.1,
      globalFreshness: "fresh",
      priceFetchedAt: summaryRow.oldest_price_fetched_at.toISOString(),
      ownedCardsCount: 3,
      globalCompletionPercent: 58,
    });

    expect(body.featuredCards).toEqual([
      {
        cardId: CARD_ID,
        name: "Dracaufeu ex",
        setCode: "SV03.5",
        setName: "151",
        localId: "199",
        imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
        quantity: 2,
        language: "FR",
        variant: "holo",
        unitPriceCents: 77100,
        delta30dPercent: 10.1,
        priceSource: "cardmarket",
        priceFetchedAt: (featuredRow.price_fetched_at as Date).toISOString(),
        priceExpiresAt: (featuredRow.price_expires_at as Date).toISOString(),
      },
    ]);

    expect(body.binders).toEqual([
      {
        id: BINDER_ID,
        title: "151",
        kind: "set",
        setCode: "SV03.5",
        coverType: "card",
        coverLogoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
        coverCardImageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
        coverCustomUrl: null,
        ownedCount: 58,
        totalCards: 100,
        completionPercent: 58,
        estimatedValueCents: 154200,
        isShared: true,
      },
      {
        id: BINDER_2_ID,
        title: "Mes favoris",
        kind: "custom",
        setCode: null,
        coverType: "upload",
        coverLogoUrl: null,
        coverCardImageUrl: null,
        coverCustomUrl: `/api/binders/${BINDER_2_ID}/cover?v=${encodeURIComponent(
          (customBinderRow.updated_at as Date).toISOString(),
        )}`,
        ownedCount: 5,
        totalCards: 12,
        completionPercent: 42,
        estimatedValueCents: 3200,
        isShared: false,
      },
    ]);

    expect(body.latestAlert).toEqual({
      alertId: ALERT_ID,
      cardId: CARD_ID,
      cardName: "Dracaufeu ex",
      triggeredPriceCents: 77100,
      thresholdCents: 80000,
      triggeredAt: (alertRow.triggered_at as Date).toISOString(),
    });
  });

  it("scopes every private-table query to the session user and forces LATERAL LIMIT 1 on prices", async () => {
    const h = makeHarness();
    await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);

    const priceQueries = h.queries.filter((q) => q.includes("public.card_latest_prices"));
    expect(priceQueries.length).toBeGreaterThanOrEqual(3);
    for (const query of priceQueries) {
      const normalized = query.replace(/\s+/g, " ");
      expect(normalized).toMatch(/left join lateral/);
      expect(normalized).toContain("limit 1");
      expect(normalized).toMatch(/lp\.card_id = c\.card_id/);
      expect(normalized).toMatch(/lp\.language = c\.language/);
      expect(normalized).toMatch(/lp\.variant = c\.variant/);
    }

    const privateQueries = h.queries.filter(
      (q) =>
        /public\.(user_card_copies|binders|binder_cards|share_links|alert_events)/.test(q) &&
        !q.includes("to_regclass"),
    );
    expect(privateQueries.length).toBeGreaterThanOrEqual(5);
    for (const query of privateQueries) {
      expect(query).toMatch(/user_id = \?/);
    }
    const privateIndexes = h.queries
      .map((q, index) => ({ q, index }))
      .filter(({ q }) => /user_id = \?/.test(q))
      .map(({ index }) => index);
    for (const index of privateIndexes) {
      expect(h.values[index]).toContain(USER_ID);
    }
  });

  it("guards the M4 tables with to_regclass and skips alert/share queries when absent", async () => {
    const h = makeHarness({
      responder: (query) => {
        if (query.includes("to_regclass")) return [{ has_alerts: false, has_share_links: false }];
        return fullResponder(query, []);
      },
    });
    const response = await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      latestAlert: unknown;
      binders: Array<{ isShared: boolean }>;
    };
    expect(body.latestAlert).toBeNull();
    expect(body.binders.every((binder) => binder.isShared === false)).toBe(true);

    const guardQuery = h.queries.find((q) => q.includes("to_regclass"));
    expect(guardQuery).toContain("to_regclass('public.alert_events')");
    expect(guardQuery).toContain("to_regclass('public.price_alerts')");
    expect(h.queries.some((q) => q.includes("from public.alert_events"))).toBe(false);
    expect(h.queries.some((q) => q.includes("from public.share_links"))).toBe(false);
  });

  it("orders featured cards by effective price DESC NULLS LAST, quantity DESC and caps binders at 4", async () => {
    const h = makeHarness();
    await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);
    const featuredQuery = h.queries.find((q) => q.includes("effective_price_cents"));
    expect(featuredQuery).toContain(
      "order by effective_price_cents desc nulls last, quantity desc, c.card_id asc",
    );
    expect(featuredQuery).toContain("limit 3");
    expect(featuredQuery).toContain("group by c.card_id, c.language, c.variant");
    const bindersQuery = h.queries.find(
      (q) => q.includes("from public.binders") && q.includes("limit 4"),
    );
    expect(bindersQuery).toContain("order by b.updated_at desc, b.created_at desc");
  });

  it("computes delta30dPercent as null when no avg30 base exists", async () => {
    const h = makeHarness({
      responder: (query) => {
        if (query.includes("owned_cards_count")) {
          return [
            {
              ...summaryRow,
              sum_current_cents: 0,
              sum_avg30_cents: 0,
              priced_cards_count: 0,
              oldest_price_fetched_at: null,
              has_fallback_price: null,
            },
          ];
        }
        return fullResponder(query, []);
      },
    });
    const response = await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);
    const body = (await response.json()) as DashboardPayload;
    expect(body.summary.delta30dPercent).toBeNull();
    expect(body.summary.globalFreshness).toBe("missing");
    expect(body.summary.priceFetchedAt).toBeNull();
  });

  it("returns null delta30dPercent for an avg30-only featured card (never a false 0.0 %)", async () => {
    const h = makeHarness({
      responder: (query) => {
        if (query.includes("effective_price_cents")) {
          return [{ ...featuredRow, effective_price_cents: 70000, spot_price_cents: null }];
        }
        return fullResponder(query, []);
      },
    });
    const response = await handleGetDashboard(req(API, { cookie: signedIn }), h.deps);
    const body = (await response.json()) as DashboardPayload;
    expect(body.featuredCards[0]?.unitPriceCents).toBe(70000);
    expect(body.featuredCards[0]?.delta30dPercent).toBeNull();
  });
});
