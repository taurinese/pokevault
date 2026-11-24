import {
  CardmarketBlockedError,
  CardmarketNetworkError,
  CardmarketParseError,
  PRICE_MANUAL_COOLDOWN_MS,
  PRICE_TTL_MS,
  PriceCircuitOpenError,
  PriceRefreshCooldownError,
  type PriceRefreshPriority,
  type PriceRefreshTarget,
  type PriceSnapshot,
  type TcgdexFallbackPrices,
} from "@pokevault/domain";
import { Clock, Effect, Fiber, Layer, Random } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  CardmarketFetcherFake,
  CardmarketPriceService,
  type CardmarketPriceServiceConfig,
  CardmarketPriceServiceLive,
  computeCircuitPauseMs,
  isAllowedCardmarketUrl,
  makePriceSnapshotStoreMemory,
  parseRetryAfterMs,
  pickTcgdexFallbackPrices,
  TcgdexPriceFallbackFake,
} from "./cardmarket-price-service.ts";

// ---------------------------------------------------------------------------
// Fixtures & harness
// ---------------------------------------------------------------------------

const HTML_OK = `<table>
  <tr><td>Tendance des prix</td><td><span class="price">124,90&nbsp;€</span></td></tr>
  <tr><td>À partir de</td><td>1.250,50&nbsp;€</td></tr>
  <tr><td>Prix moyen 30 jours</td><td>98,00&nbsp;€</td></tr>
</table>`;

const HTML_CHALLENGE = `<html><head><title>Attention Required! | Cloudflare</title></head>
<body><div class="cf-turnstile" data-sitekey="0x4"></div><h1>Just a moment...</h1></body></html>`;

const HTML_BROKEN = `<html><body><h1>Oops</h1><p>no price here</p></body></html>`;

const urlFor = (cardId: string) =>
  `https://www.cardmarket.com/en/Pokemon/Products/Singles/${cardId}`;

const target = (
  cardId: string,
  cardmarketUrl: string | null = urlFor(cardId),
  priority: PriceRefreshPriority = "featured",
): PriceRefreshTarget => ({
  cardId,
  language: "FR",
  variant: "normal",
  cardmarketUrl,
  priority,
});

type FetchMode = "ok" | "403" | "429" | "challenge" | "broken" | "network";

interface HarnessState {
  mode: FetchMode;
  retryAfterMs: number | undefined;
  calls: Array<string>;
  inFlight: number;
  maxInFlight: number;
  /** When > 0, the fake fetcher sleeps this long while holding the semaphore permit. */
  slowMs: number;
  fallbackPrices: TcgdexFallbackPrices | null;
}

interface Harness {
  readonly state: HarnessState;
  readonly store: ReturnType<typeof makePriceSnapshotStoreMemory>;
  readonly run: <A, E>(
    program: Effect.Effect<A, E, CardmarketPriceService>,
  ) => Promise<A>;
}

const DEFAULT_FALLBACK: TcgdexFallbackPrices = {
  trendCents: 500,
  avg30Cents: 450,
  lowFrCents: 400,
};

const makeHarness = (options?: {
  readonly config?: CardmarketPriceServiceConfig | undefined;
  readonly targets?: ReadonlyArray<PriceRefreshTarget> | undefined;
  readonly mode?: FetchMode | undefined;
}): Harness => {
  const state: HarnessState = {
    mode: options?.mode ?? "ok",
    retryAfterMs: undefined,
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    slowMs: 0,
    fallbackPrices: DEFAULT_FALLBACK,
  };
  const store = makePriceSnapshotStoreMemory();
  store.targets.push(...(options?.targets ?? []));

  const fetchByMode = (
    url: string,
  ): Effect.Effect<string, CardmarketBlockedError | CardmarketNetworkError> => {
    switch (state.mode) {
      case "ok":
        return Effect.succeed(HTML_OK);
      case "403":
        return Effect.fail(
          new CardmarketBlockedError({ status: 403, message: `HTTP 403 for ${url}` }),
        );
      case "429":
        return Effect.fail(
          new CardmarketBlockedError({
            status: 429,
            ...(state.retryAfterMs === undefined ? {} : { retryAfterMs: state.retryAfterMs }),
            message: `HTTP 429 for ${url}`,
          }),
        );
      case "challenge":
        return Effect.succeed(HTML_CHALLENGE);
      case "broken":
        return Effect.succeed(HTML_BROKEN);
      case "network":
        return Effect.fail(new CardmarketNetworkError({ url, message: "socket hang up" }));
    }
  };

  const fetcherLayer = CardmarketFetcherFake((url) =>
    Effect.gen(function* () {
      state.calls.push(url);
      // Simulated slow request: the in-flight counter is only incremented while
      // the semaphore permit is held (the fetch happens inside withPermits).
      if (state.slowMs > 0) {
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        yield* Effect.sleep(state.slowMs);
        state.inFlight -= 1;
      }
      return yield* fetchByMode(url);
    }),
  );

  const fallbackLayer = TcgdexPriceFallbackFake((cardId) =>
    Effect.succeed(cardId === "nofb" ? null : state.fallbackPrices),
  );

  const baseLayer = CardmarketPriceServiceLive({
    jitterMinMs: 0,
    jitterMaxMs: 0,
    ...options?.config,
  }).pipe(Layer.provide(Layer.mergeAll(store.layer, fetcherLayer, fallbackLayer)));

  const run = <A, E>(
    program: Effect.Effect<A, E, CardmarketPriceService>,
  ): Promise<A> =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(Layer.mergeAll(baseLayer, TestClock.layer())),
        Random.withSeed("pokevault-test"),
      ),
    );

  return { state, store, run };
};

const iso = (ms: number) => new Date(ms).toISOString();

let seedId = 1000;
const seedSnapshot = (
  store: ReturnType<typeof makePriceSnapshotStoreMemory>,
  overrides: Partial<PriceSnapshot> & { cardId: string; fetchedAtMs: number; expiresAtMs: number },
): PriceSnapshot => {
  const snapshot: PriceSnapshot = {
    id: seedId++,
    language: "FR",
    variant: "normal",
    source: "cardmarket",
    trendCents: 100,
    lowFrCents: 90,
    avg30Cents: 95,
    isFresh: false,
    ...overrides,
    fetchedAt: iso(overrides.fetchedAtMs),
    expiresAt: iso(overrides.expiresAtMs),
  };
  store.seed(snapshot);
  return snapshot;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isAllowedCardmarketUrl (SSRF guard)", () => {
  it.each([
    ["https://www.cardmarket.com/en/Pokemon/Products/Singles/x", true],
    ["https://www.cardmarket.com/fr/Pokemon/Produits/Singles/x", true],
    ["https://m.cardmarket.com/x", true],
    ["http://www.cardmarket.com/x", false],
    ["https://cardmarket.com.evil.example/x", false],
    ["https://evil.example/x", false],
    ["ftp://www.cardmarket.com/x", false],
    ["not a url", false],
    [null, false],
  ])("%s → %s", (url, expected) => {
    expect(isAllowedCardmarketUrl(url as string | null)).toBe(expected);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds, HTTP dates and rejects garbage", () => {
    expect(parseRetryAfterMs("120", 1_000)).toBe(120_000);
    expect(parseRetryAfterMs(null, 1_000)).toBeUndefined();
    expect(parseRetryAfterMs("abc", 1_000)).toBeUndefined();
    const date = new Date(61_000).toUTCString();
    expect(parseRetryAfterMs(date, 1_000)).toBe(60_000);
  });
});

describe("computeCircuitPauseMs", () => {
  const base = 15 * 60_000;
  const max = 60 * 60_000;
  it("backs off exponentially 15 min → 30 min → 60 min, capped at 1 h", () => {
    expect(computeCircuitPauseMs(1, undefined, base, max)).toBe(15 * 60_000);
    expect(computeCircuitPauseMs(2, undefined, base, max)).toBe(30 * 60_000);
    expect(computeCircuitPauseMs(3, undefined, base, max)).toBe(60 * 60_000);
    expect(computeCircuitPauseMs(4, undefined, base, max)).toBe(60 * 60_000);
    expect(computeCircuitPauseMs(10, undefined, base, max)).toBe(60 * 60_000);
  });
  it("respects a larger Retry-After, still capped at 1 h", () => {
    expect(computeCircuitPauseMs(1, 45 * 60_000, base, max)).toBe(45 * 60_000);
    expect(computeCircuitPauseMs(1, 90 * 60_000, base, max)).toBe(60 * 60_000);
    expect(computeCircuitPauseMs(2, 10 * 60_000, base, max)).toBe(30 * 60_000);
  });
});

describe("pickTcgdexFallbackPrices", () => {
  it("extracts variant/language prices in cents and rejects empty payloads", () => {
    const payload = {
      pricing: {
        cardmarket: {
          prices: {
            normal: { FR: { trend: 1.5, avg30: 2, low: 0.9 }, EN: { trend: 3 } },
            holo: { fr: { low: 10 } },
          },
        },
      },
    };
    expect(pickTcgdexFallbackPrices(payload, "FR", "normal")).toEqual({
      trendCents: 150,
      avg30Cents: 200,
      lowFrCents: 90,
    });
    expect(pickTcgdexFallbackPrices(payload, "EN", "normal")).toEqual({
      trendCents: 300,
      avg30Cents: null,
      lowFrCents: null,
    });
    expect(pickTcgdexFallbackPrices(payload, "FR", "holo")).toEqual({
      trendCents: null,
      avg30Cents: null,
      lowFrCents: 1000,
    });
    expect(pickTcgdexFallbackPrices(payload, "JP", "normal")).toBeNull();
    expect(pickTcgdexFallbackPrices({}, "FR", "normal")).toBeNull();
    expect(
      pickTcgdexFallbackPrices(
        { pricing: { cardmarket: { prices: { normal: { FR: { trend: -1 } } } } } },
        "FR",
        "normal",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getLatestPrice & freshness
// ---------------------------------------------------------------------------

describe("getLatestPrice", () => {
  it("returns null when nothing is known, with freshness per computePriceFreshness", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        const missing = yield* svc.getLatestPrice("unknown");
        seedSnapshot(h.store, {
          cardId: "fresh-card",
          fetchedAtMs: now - 6 * 60_000,
          expiresAtMs: now + 9 * 60_000,
        });
        seedSnapshot(h.store, {
          cardId: "aging-card",
          fetchedAtMs: now - 2 * 60 * 60_000,
          expiresAtMs: now - 30 * 60_000,
        });
        seedSnapshot(h.store, {
          cardId: "old-card",
          fetchedAtMs: now - 8 * 60 * 60_000,
          expiresAtMs: now - 7 * 60 * 60_000,
        });
        seedSnapshot(h.store, {
          cardId: "fb-card",
          source: "tcgdex_fallback",
          fetchedAtMs: now - 60_000,
          expiresAtMs: now + 14 * 60_000,
        });
        return {
          missing,
          fresh: yield* svc.getLatestPrice("fresh-card"),
          aging: yield* svc.getLatestPrice("aging-card"),
          stale: yield* svc.getLatestPrice("old-card"),
          fallback: yield* svc.getLatestPrice("fb-card"),
        };
      }),
    );
    expect(result.missing).toBeNull();
    expect(result.fresh?.freshness).toBe("fresh");
    expect(result.fresh?.snapshot.isFresh).toBe(true);
    expect(result.aging?.freshness).toBe("aging");
    expect(result.stale?.freshness).toBe("stale");
    expect(result.fallback?.freshness).toBe("stale");
    expect(result.fallback?.snapshot.source).toBe("tcgdex_fallback");
  });
});

// ---------------------------------------------------------------------------
// refreshCardPrice: cache, TTL, cooldown, scrape
// ---------------------------------------------------------------------------

describe("refreshCardPrice", () => {
  it("serves a fresh snapshot without any Cardmarket call (fresh_cache)", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        const seeded = seedSnapshot(h.store, {
          cardId: "c1",
          fetchedAtMs: now - 60_000,
          expiresAtMs: now + 14 * 60_000,
        });
        const res = yield* svc.refreshCardPrice(target("c1"));
        return { res, seeded };
      }),
    );
    expect(result.res.kind).toBe("fresh_cache");
    expect(result.res.kind === "fresh_cache" && result.res.snapshot.id).toBe(result.seeded.id);
    expect(h.state.calls).toEqual([]);
  });

  it("scrapes Cardmarket when forced and persists an explicit TTL 15 min snapshot", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const res = yield* svc.refreshCardPrice(target("c1"), { force: true });
        const latest = yield* svc.getLatestPrice("c1");
        return { res, latest };
      }),
    );
    expect(h.state.calls).toEqual([urlFor("c1")]);
    expect(result.res.kind).toBe("refreshed_cardmarket");
    if (result.res.kind === "refreshed_cardmarket") {
      expect(result.res.snapshot.source).toBe("cardmarket");
      expect(result.res.snapshot.trendCents).toBe(12490);
      expect(result.res.snapshot.lowFrCents).toBe(125050);
      expect(result.res.snapshot.avg30Cents).toBe(9800);
      // fetched_at & expires_at explicites : expires_at = fetched_at + 15 min
      expect(
        Date.parse(result.res.snapshot.expiresAt) - Date.parse(result.res.snapshot.fetchedAt),
      ).toBe(PRICE_TTL_MS);
    }
    expect(result.latest?.freshness).toBe("fresh");
    expect(h.store.history.get("c1|FR|normal")).toHaveLength(1);
  });

  it("re-scrapes an expired snapshot even without force", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        seedSnapshot(h.store, {
          cardId: "c1",
          fetchedAtMs: now - 2 * 60 * 60_000,
          expiresAtMs: now - 30 * 60_000,
        });
        return yield* svc.refreshCardPrice(target("c1"));
      }),
    );
    expect(result.kind).toBe("refreshed_cardmarket");
    expect(h.state.calls).toEqual([urlFor("c1")]);
  });

  it("enforces the global 5 min/carte manual cooldown without any network call", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        seedSnapshot(h.store, {
          cardId: "c1",
          fetchedAtMs: now - 2 * 60_000,
          expiresAtMs: now + 13 * 60_000,
        });
        const error = yield* Effect.flip(svc.refreshCardPrice(target("c1"), { manual: true }));
        const circuit = yield* svc.getCircuitState();
        // after the cooldown window, a manual refresh scrapes again
        yield* TestClock.adjust(PRICE_MANUAL_COOLDOWN_MS + 60_000);
        const after = yield* svc.refreshCardPrice(target("c1"), { manual: true, force: true });
        return { error, circuit, after, now };
      }),
    );
    expect(result.error).toBeInstanceOf(PriceRefreshCooldownError);
    const cooldown = result.error as PriceRefreshCooldownError;
    expect(cooldown.cardId).toBe("c1");
    expect(cooldown.retryAfterMs).toBe(PRICE_MANUAL_COOLDOWN_MS - 2 * 60_000); // fetched 2 min ago
    expect(cooldown.nextAllowedAt).toBe(iso(result.now + cooldown.retryAfterMs));
    expect(h.state.calls).toEqual([urlFor("c1")]); // only the post-cooldown scrape
    expect(result.after.kind).toBe("refreshed_cardmarket");
    expect(result.circuit.status).toBe("closed");
  });

  it("bounds concurrency with the semaphore (max concurrent ≤ maxConcurrency)", async () => {
    const h = makeHarness({ config: { maxConcurrency: 2 } });
    h.state.slowMs = 50; // slow in-flight request inside the semaphore permit
    const results = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const fiber = yield* Effect.forkChild(
          Effect.forEach(
            ["a", "b", "c", "d", "e"].map((id) => target(id)),
            (t) => svc.refreshCardPrice(t, { force: true }),
            { concurrency: 5 },
          ),
        );
        yield* TestClock.adjust(10_000);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(results.every((r) => r.kind === "refreshed_cardmarket")).toBe(true);
    expect(h.state.maxInFlight).toBeLessThanOrEqual(2);
    expect(h.state.maxInFlight).toBeGreaterThanOrEqual(1);
    expect(h.state.calls).toHaveLength(5);
  });

  it("applies the prod jitter window (1500..4000 ms) between requests", async () => {
    const h = makeHarness({ config: { jitterMinMs: 1500, jitterMaxMs: 4000 } });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const fiber = yield* Effect.forkChild(svc.refreshCardPrice(target("jit"), { force: true }));
        // jitter >= 1500 ms: the refresh must still be sleeping at t+1499 ms
        yield* TestClock.adjust(1499);
        const stillSleeping = fiber.pollUnsafe();
        // by t+4000 ms every possible jitter in [1500, 4000] has elapsed
        yield* TestClock.adjust(4000 - 1499);
        const done = fiber.pollUnsafe();
        const res = yield* Fiber.join(fiber);
        return { res, stillSleeping, done };
      }),
    );
    expect(result.res.kind).toBe("refreshed_cardmarket");
    expect(result.stillSleeping).toBeUndefined(); // fiber still running at t+1499
    expect(result.done).not.toBeUndefined();
  });

  it("rejects non-Cardmarket URLs (SSRF) without any network call and falls back", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const evil = yield* svc.refreshCardPrice(
          target("evil", "https://evil.example.com/phish", "featured"),
          { force: true },
        );
        const http = yield* svc.refreshCardPrice(
          target("http", "http://www.cardmarket.com/x", "featured"),
          { force: true },
        );
        const noUrl = yield* svc.refreshCardPrice(target("nourl", null), { force: true });
        return { evil, http, noUrl };
      }),
    );
    expect(h.state.calls).toEqual([]);
    expect(result.evil.kind).toBe("refreshed_fallback");
    expect(result.http.kind).toBe("refreshed_fallback");
    expect(result.noUrl.kind).toBe("refreshed_fallback");
    if (result.evil.kind === "refreshed_fallback") {
      expect(result.evil.snapshot.source).toBe("tcgdex_fallback");
    }
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  it("opens on 403, serves the TCGdex fallback and makes no further Cardmarket call while open", async () => {
    const h = makeHarness({ mode: "403", targets: [target("c3"), target("c4")] });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        const first = yield* svc.refreshCardPrice(target("c1"), { force: true });
        const circuitAfterBlock = yield* svc.getCircuitState();
        // while open: no network call, fallback served
        const second = yield* svc.refreshCardPrice(target("c2"), { force: true });
        const report = yield* svc.runScheduledRefresh({ batchLimit: 10 });
        return { first, second, circuitAfterBlock, report, now };
      }),
    );
    expect(result.first.kind).toBe("refreshed_fallback");
    expect(result.circuitAfterBlock.status).toBe("open");
    expect(result.circuitAfterBlock.consecutiveBlocks).toBe(1);
    expect(result.circuitAfterBlock.openUntilMs).toBe(result.now + 15 * 60_000);
    expect(result.circuitAfterBlock.openUntil).toBe(iso(result.now + 15 * 60_000));
    expect(result.second.kind).toBe("refreshed_fallback");
    expect(h.state.calls).toEqual([urlFor("c1")]); // c2 never hit the network
    expect(result.report.skippedCircuitOpen).toBe(2); // c3 + c4 skipped
    expect(result.report.circuitOpenUntil).toBe(iso(result.now + 15 * 60_000));
  });

  it("backs off 15 min → 30 min → 60 min (capped) across consecutive blocks", async () => {
    const h = makeHarness({ mode: "403" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const pauses: Array<number> = [];
        const blocks: Array<number> = [];
        let previousOpenUntil = 0;
        for (let step = 0; step < 4; step++) {
          const before = yield* Clock.currentTimeMillis;
          yield* svc.refreshCardPrice(target(`c${step}`), { force: true });
          const circuit = yield* svc.getCircuitState();
          pauses.push(circuit.openUntilMs - before);
          blocks.push(circuit.consecutiveBlocks);
          previousOpenUntil = circuit.openUntilMs;
          // wait past the current pause so the circuit closes again
          yield* TestClock.adjust(circuit.openUntilMs - (yield* Clock.currentTimeMillis) + 1000);
          const closed = yield* svc.getCircuitState();
          expect(closed.status).toBe("closed");
          void previousOpenUntil;
        }
        return { pauses, blocks };
      }),
    );
    expect(result.blocks).toEqual([1, 2, 3, 4]);
    expect(result.pauses).toEqual([15 * 60_000, 30 * 60_000, 60 * 60_000, 60 * 60_000]);
  });

  it("honours a larger Retry-After (429) up to the 1 h cap", async () => {
    const h = makeHarness({ mode: "429" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        h.state.retryAfterMs = 45 * 60_000;
        const now1 = yield* Clock.currentTimeMillis;
        yield* svc.refreshCardPrice(target("c1"), { force: true });
        const first = yield* svc.getCircuitState();
        yield* TestClock.adjust(46 * 60_000);
        h.state.retryAfterMs = 90 * 60_000;
        const now2 = yield* Clock.currentTimeMillis;
        yield* svc.refreshCardPrice(target("c2"), { force: true });
        const second = yield* svc.getCircuitState();
        return { first, second, now1, now2 };
      }),
    );
    expect(result.first.openUntilMs - result.now1).toBe(45 * 60_000);
    expect(result.second.openUntilMs - result.now2).toBe(60 * 60_000); // capped
    expect(result.second.consecutiveBlocks).toBe(2);
  });

  it("opens on an anti-bot challenge page (never bypassed)", async () => {
    const h = makeHarness({ mode: "challenge" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const res = yield* svc.refreshCardPrice(target("c1"), { force: true });
        const circuit = yield* svc.getCircuitState();
        return { res, circuit };
      }),
    );
    expect(result.res.kind).toBe("refreshed_fallback");
    expect(result.circuit.status).toBe("open");
    expect(result.circuit.consecutiveBlocks).toBe(1);
    expect(h.state.calls).toEqual([urlFor("c1")]);
  });

  it("resets consecutiveBlocks after a successful scrape once the circuit reclosed", async () => {
    const h = makeHarness({ mode: "403" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        yield* svc.refreshCardPrice(target("c1"), { force: true });
        expect((yield* svc.getCircuitState()).status).toBe("open");
        yield* TestClock.adjust(16 * 60_000); // past the 15 min pause
        h.state.mode = "ok";
        const res = yield* svc.refreshCardPrice(target("c2"), { force: true });
        const circuit = yield* svc.getCircuitState();
        return { res, circuit };
      }),
    );
    expect(result.res.kind).toBe("refreshed_cardmarket");
    expect(result.circuit.status).toBe("closed");
    expect(result.circuit.consecutiveBlocks).toBe(0);
    expect(result.circuit.openUntil).toBeNull();
  });

  it("does NOT open the circuit on network/parse errors (fallback instead)", async () => {
    const h = makeHarness({ mode: "network" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const res = yield* svc.refreshCardPrice(target("c1"), { force: true });
        const circuit = yield* svc.getCircuitState();
        return { res, circuit };
      }),
    );
    expect(result.res.kind).toBe("refreshed_fallback");
    expect(result.circuit.status).toBe("closed");
    expect(result.circuit.consecutiveBlocks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fallback & degraded mode
// ---------------------------------------------------------------------------

describe("fallback & degraded mode", () => {
  it("persists a tcgdex_fallback snapshot when the scrape fails", async () => {
    const h = makeHarness({ mode: "network" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const res = yield* svc.refreshCardPrice(target("c1"), { force: true });
        const latest = yield* svc.getLatestPrice("c1");
        return { res, latest };
      }),
    );
    expect(result.res.kind).toBe("refreshed_fallback");
    if (result.res.kind === "refreshed_fallback") {
      expect(result.res.snapshot.source).toBe("tcgdex_fallback");
      expect(result.res.snapshot.trendCents).toBe(500);
      expect(
        Date.parse(result.res.snapshot.expiresAt) - Date.parse(result.res.snapshot.fetchedAt),
      ).toBe(PRICE_TTL_MS);
    }
    expect(result.latest?.freshness).toBe("stale"); // fallback = toujours indicatif
  });

  it("uses the target-provided tcgdexFallback prices without calling the API", async () => {
    const h = makeHarness({ mode: "network" });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const res = yield* svc.refreshCardPrice(
          {
            ...target("c1"),
            tcgdexFallback: { trendCents: 777, avg30Cents: null, lowFrCents: 666 },
          },
          { force: true },
        );
        return res;
      }),
    );
    expect(result.kind).toBe("refreshed_fallback");
    if (result.kind === "refreshed_fallback") {
      expect(result.snapshot.trendCents).toBe(777);
      expect(result.snapshot.lowFrCents).toBe(666);
      expect(result.snapshot.avg30Cents).toBeNull();
    }
  });

  it("serves the last known snapshot in degraded mode when everything fails", async () => {
    const h = makeHarness({ mode: "broken" });
    h.state.fallbackPrices = null;
    const degraded = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        const seeded = seedSnapshot(h.store, {
          cardId: "c1",
          fetchedAtMs: now - 3 * 60 * 60_000,
          expiresAtMs: now - 2 * 60 * 60_000,
        });
        const res = yield* svc.refreshCardPrice(target("c1"), { force: true });
        return { res, seeded };
      }),
    );
    expect(degraded.res.kind).toBe("degraded");
    if (degraded.res.kind === "degraded") {
      expect(degraded.res.snapshot.id).toBe(degraded.seeded.id);
    }
  });

  it("fails with the typed scrape error when nothing is available at all", async () => {
    const h = makeHarness({ mode: "broken" });
    const error = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        h.state.fallbackPrices = null;
        return yield* Effect.flip(svc.refreshCardPrice(target("c1"), { force: true }));
      }),
    );
    expect(error).toBeInstanceOf(CardmarketParseError);
    expect((error as CardmarketParseError).cardId).toBe("c1");
  });

  it("fails with PriceCircuitOpenError when the circuit is open and no fallback/snapshot exists", async () => {
    const h = makeHarness({ mode: "403" });
    const error = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        yield* svc.refreshCardPrice(target("c1"), { force: true }); // opens the circuit
        h.state.mode = "ok";
        h.state.fallbackPrices = null;
        return yield* Effect.flip(svc.refreshCardPrice(target("c2"), { force: true }));
      }),
    );
    expect(error).toBeInstanceOf(PriceCircuitOpenError);
    expect((error as PriceCircuitOpenError).consecutiveBlocks).toBe(1);
    expect(h.state.calls).toEqual([urlFor("c1")]); // c2 never hit the network
  });
});

// ---------------------------------------------------------------------------
// runScheduledRefresh: priorities, batch limit, report
// ---------------------------------------------------------------------------

describe("runScheduledRefresh", () => {
  it("refreshes targets in priority order (alerts → wishlists → featured) and honours batchLimit", async () => {
    const h = makeHarness({
      targets: [
        target("featured-1"),
        target("alert-1", urlFor("alert-1"), "active_alert"),
        target("wish-1", urlFor("wish-1"), "wishlist"),
        target("alert-2", urlFor("alert-2"), "active_alert"),
      ],
    });
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const full = yield* svc.runScheduledRefresh({ batchLimit: 10 });
        const limited = yield* svc.runScheduledRefresh({ batchLimit: 2 });
        return { full, limited };
      }),
    );
    // priority order on the first run; the second (limited) run is served by
    // the fresh cache written by the first one → no extra network call.
    expect(h.state.calls).toEqual([
      urlFor("alert-1"),
      urlFor("alert-2"),
      urlFor("wish-1"),
      urlFor("featured-1"),
    ]);
    expect(result.full).toMatchObject({
      attempted: 4,
      refreshedCardmarket: 4,
      refreshedFallback: 0,
      skippedFresh: 0,
      skippedCooldown: 0,
      skippedCircuitOpen: 0,
      failed: 0,
      circuitOpenUntil: null,
    });
    expect(result.limited.attempted).toBe(2);
    expect(result.limited.skippedFresh).toBe(2);
  });

  it("counts skippedFresh / refreshedFallback / skippedCircuitOpen in the report", async () => {
    // Dedicated harness whose fetcher routes on the URL: "blocked" → 403,
    // everything else → valid HTML. Concurrency 1 → deterministic order.
    const state: HarnessState = {
      mode: "ok",
      retryAfterMs: undefined,
      calls: [],
      inFlight: 0,
      maxInFlight: 0,
      slowMs: 0,
      fallbackPrices: DEFAULT_FALLBACK,
    };
    const store = makePriceSnapshotStoreMemory();
    store.targets.push(
      target("fresh"),
      target("ok"),
      target("blocked"),
      target("after-open"),
      target("after-open-2"),
    );
    const fetcherLayer = CardmarketFetcherFake((url) => {
      state.calls.push(url);
      if (url.includes("blocked")) {
        return Effect.fail(new CardmarketBlockedError({ status: 403, message: "blocked" }));
      }
      return Effect.succeed(HTML_OK);
    });
    const fallbackLayer = TcgdexPriceFallbackFake(() => Effect.succeed(state.fallbackPrices));
    const layer = CardmarketPriceServiceLive({ jitterMinMs: 0, jitterMaxMs: 0 }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, fetcherLayer, fallbackLayer)),
    );
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        seedSnapshot(store, {
          cardId: "fresh",
          fetchedAtMs: now - 60_000,
          expiresAtMs: now + 14 * 60_000,
        });
        return yield* svc.runScheduledRefresh({ batchLimit: 10 });
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, TestClock.layer())),
        Random.withSeed("pokevault-test"),
      ),
    );
    // sequential: fresh → fresh_cache, ok → cardmarket, blocked → 403 (circuit
    // opens) + fallback, after-open* → skippedCircuitOpen (no network call).
    expect(report.attempted).toBe(5);
    expect(report.skippedFresh).toBe(1);
    expect(report.refreshedCardmarket).toBe(1);
    expect(report.refreshedFallback).toBe(1);
    expect(report.skippedCircuitOpen).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.circuitOpenUntil).not.toBeNull();
    expect(state.calls).toEqual([urlFor("ok"), urlFor("blocked")]);
  });

  it("counts failed when a target has no fallback and no snapshot", async () => {
    const store = makePriceSnapshotStoreMemory();
    store.targets.push(target("broken-nofb"));
    const fetcherLayer = CardmarketFetcherFake(() => Effect.succeed(HTML_BROKEN));
    const fallbackLayer = TcgdexPriceFallbackFake(() => Effect.succeed(null));
    const layer = CardmarketPriceServiceLive({ jitterMinMs: 0, jitterMaxMs: 0 }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, fetcherLayer, fallbackLayer)),
    );
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        return yield* svc.runScheduledRefresh({ batchLimit: 10 });
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, TestClock.layer())),
        Random.withSeed("pokevault-test"),
      ),
    );
    expect(report.attempted).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.refreshedCardmarket).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneExpiredSnapshots: keeps the latest snapshot per (card, language, variant)
// ---------------------------------------------------------------------------

describe("pruneExpiredSnapshots", () => {
  it("deletes expired history but always keeps the most recent snapshot per key", async () => {
    const h = makeHarness();
    const result = await h.run(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        // card A: expired old + fresh latest → old removed, latest kept
        seedSnapshot(h.store, {
          cardId: "A",
          fetchedAtMs: now - 2 * 60 * 60_000,
          expiresAtMs: now - 1 * 60 * 60_000,
        });
        seedSnapshot(h.store, {
          cardId: "A",
          fetchedAtMs: now - 10 * 60_000,
          expiresAtMs: now + 5 * 60_000,
        });
        // card B: two expired snapshots → the latest is kept (degraded mode)
        seedSnapshot(h.store, {
          cardId: "B",
          fetchedAtMs: now - 3 * 60 * 60_000,
          expiresAtMs: now - 2 * 60 * 60_000,
        });
        seedSnapshot(h.store, {
          cardId: "B",
          fetchedAtMs: now - 1 * 60 * 60_000,
          expiresAtMs: now - 45 * 60_000,
        });
        const removedFirst = yield* svc.pruneExpiredSnapshots();
        const sizesAfterFirst = {
          A: h.store.history.get("A|FR|normal")?.length ?? 0,
          B: h.store.history.get("B|FR|normal")?.length ?? 0,
        };
        // everything expires later: the latest per key is STILL kept
        yield* TestClock.adjust(2 * 60 * 60_000);
        const removedSecond = yield* svc.pruneExpiredSnapshots();
        const sizesAfterSecond = {
          A: h.store.history.get("A|FR|normal")?.length ?? 0,
          B: h.store.history.get("B|FR|normal")?.length ?? 0,
        };
        return { removedFirst, sizesAfterFirst, removedSecond, sizesAfterSecond };
      }),
    );
    expect(result.removedFirst).toBe(2); // A-old + B-old
    expect(result.sizesAfterFirst).toEqual({ A: 1, B: 1 });
    expect(result.removedSecond).toBe(0); // latest per key always kept
    expect(result.sizesAfterSecond).toEqual({ A: 1, B: 1 });
  });
});

// ---------------------------------------------------------------------------
// Misc: error extraction from batch exits
// ---------------------------------------------------------------------------

describe("batch error accounting", () => {
  it("counts a manual cooldown as skippedCooldown", async () => {
    const store = makePriceSnapshotStoreMemory();
    store.targets.push(target("c1"));
    const fetcherLayer = CardmarketFetcherFake(() => Effect.succeed(HTML_OK));
    const fallbackLayer = TcgdexPriceFallbackFake(() => Effect.succeed(DEFAULT_FALLBACK));
    const layer = CardmarketPriceServiceLive({ jitterMinMs: 0, jitterMaxMs: 0 }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, fetcherLayer, fallbackLayer)),
    );
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CardmarketPriceService;
        const now = yield* Clock.currentTimeMillis;
        seedSnapshot(store, {
          cardId: "c1",
          fetchedAtMs: now - 60_000,
          expiresAtMs: now + 14 * 60_000,
        });
        return yield* svc.runScheduledRefresh({ batchLimit: 5, manual: true });
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, TestClock.layer())),
        Random.withSeed("pokevault-test"),
      ),
    );
    expect(report.skippedCooldown).toBe(1);
    expect(report.attempted).toBe(1);
  });
});
