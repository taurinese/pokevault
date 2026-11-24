import { Duration, Effect, Fiber, type Layer, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  fetchTransport,
  makeTcgdexClient,
  TCGDEX_MAX_RETRY_DELAY,
  TcgdexClient,
  TcgdexClientLive,
  TcgdexDecodeError,
  TcgdexHttpError,
  type TcgdexTransport,
  tcgdexRetrySchedule,
} from "./tcgdex.ts";

// ---------------------------------------------------------------------------
// Realistic fixtures (captured from https://api.tcgdex.net/v2 on 2026-11-24)
// ---------------------------------------------------------------------------

const SERIES_FR = [
  { id: "base", name: "Base", logo: "https://assets.tcgdex.net/fr/base/base2/logo" },
  { id: "sv", name: "Écarlate et Violet", logo: "https://assets.tcgdex.net/fr/sv/sv01/logo" },
];

const SERIES_EN = [
  { id: "base", name: "Base" },
  { id: "sv", name: "Scarlet & Violet", logo: "https://assets.tcgdex.net/en/sv/sv01/logo" },
];

const SET_SUMMARIES_FR = [
  {
    id: "sv03.5",
    name: "151",
    logo: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
    symbol: "https://assets.tcgdex.net/univ/sv/sv03.5/symbol",
    cardCount: { total: 207, official: 165 },
  },
];

const SET_DETAIL_SV035_FR = {
  cardCount: { firstEd: 0, holo: 90, normal: 135, official: 165, reverse: 158, total: 207 },
  id: "sv03.5",
  legal: { expanded: true, standard: false },
  logo: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
  name: "151",
  releaseDate: "2023-09-22",
  serie: { id: "sv", name: "Écarlate et Violet" },
  symbol: "https://assets.tcgdex.net/univ/sv/sv03.5/symbol",
  abbreviation: { official: "MEW", localized: "151" },
  cards: [
    {
      id: "sv03.5-001",
      image: "https://assets.tcgdex.net/fr/sv/sv03.5/001",
      localId: "001",
      name: "Bulbizarre",
    },
    {
      id: "sv03.5-199",
      image: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
      localId: "199",
      name: "Dracaufeu-ex",
    },
  ],
};

const CARD_SV0335_199_FR = {
  category: "Pokémon",
  id: "sv03.5-199",
  illustrator: "miki kudo",
  image: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  localId: "199",
  name: "Dracaufeu-ex",
  rarity: "Illustration spéciale rare",
  set: { id: "sv03.5", name: "151" },
  variants: { firstEdition: false, holo: true, normal: false, reverse: false, wPromo: false },
  dexId: [6],
  hp: 330,
  types: ["Feu"],
  evolveFrom: "Reptincel",
  stage: "Niveau 2",
  suffix: "ex",
  attacks: [
    { cost: ["Feu"], name: "Aile de Bravoure", effect: "Si au moins un marqueur…", damage: "60+" },
    { cost: ["Feu", "Feu", "Feu", "Feu"], name: "Vortex Explosif", damage: 330 },
  ],
  weaknesses: [{ type: "Eau", value: "×2" }],
  retreat: 2,
  regulationMark: "G",
  pricing: { cardmarket: { idProduct: 733794, unit: "EUR", avg: 336.32 } },
};

const CARD_SV08_189_FR = {
  category: "Dresseur",
  id: "sv08-189",
  localId: "189",
  name: "Orbe Téracristal",
  rarity: "Peu Commune",
  variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
};

// ---------------------------------------------------------------------------
// Fake transport helpers
// ---------------------------------------------------------------------------

type Route = (url: string) => Effect.Effect<string, TcgdexHttpError>;

const json = (payload: unknown): Effect.Effect<string, TcgdexHttpError> =>
  Effect.succeed(JSON.stringify(payload));

const ok =
  (payload: unknown): Route =>
  () =>
    json(payload);

const httpError =
  (status: number, retryable: boolean): Route =>
  (url) =>
    Effect.fail(
      new TcgdexHttpError({ url, status, retryable, body: status === 404 ? "not-found" : null }),
    );

const makeTransport = (routes: ReadonlyArray<readonly [RegExp, Route]>) => {
  const calls: Array<string> = [];
  const transport: TcgdexTransport = (url) => {
    calls.push(url);
    for (const [pattern, route] of routes) {
      if (pattern.test(url)) return route(url);
    }
    return httpError(404, false)(url);
  };
  return { calls, transport };
};

const BASE = "https://api.tcgdex.net/v2";

/** Runs an effect under a `TestClock`, fast-forwarding through all retry sleeps. */
const withTestClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let index = 0; index < 20; index++) {
      yield* TestClock.adjust("30 seconds");
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));

describe("makeTcgdexClient / TcgdexClientLive", () => {
  it("decodes the series list payload", async () => {
    const { transport } = makeTransport([[/\/fr\/series$/, ok(SERIES_FR)]]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport });
    expect(await Effect.runPromise(client.listSeries("fr"))).toEqual(SERIES_FR);
  });

  it("decodes the sets list payload", async () => {
    const { transport } = makeTransport([[/\/fr\/sets$/, ok(SET_SUMMARIES_FR)]]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport });
    const sets = await Effect.runPromise(client.listSets("fr"));
    expect(sets).toEqual(SET_SUMMARIES_FR);
  });

  it("decodes the set detail payload (abbreviation, cardCount, cards)", async () => {
    const { calls, transport } = makeTransport([[/\/fr\/sets\/sv03\.5$/, ok(SET_DETAIL_SV035_FR)]]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport });
    const set = await Effect.runPromise(client.getSet("fr", "sv03.5"));
    expect(set.id).toBe("sv03.5");
    expect(set.serie.id).toBe("sv");
    expect(set.abbreviation).toEqual({ official: "MEW", localized: "151" });
    expect(set.releaseDate).toBe("2023-09-22");
    expect(set.cardCount?.total).toBe(207);
    expect(set.cards?.map((card) => card.name)).toEqual(["Bulbizarre", "Dracaufeu-ex"]);
    // baseUrl trailing slashes are normalized before joining the path
    expect(calls[0]).toBe(`${BASE}/fr/sets/sv03.5`);
  });

  it("decodes the card detail payload (variants, pricing, attacks)", async () => {
    const { transport } = makeTransport([[/\/fr\/cards\/sv03\.5-199$/, ok(CARD_SV0335_199_FR)]]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport });
    const card = await Effect.runPromise(client.getCard("fr", "sv03.5-199"));
    expect(card.name).toBe("Dracaufeu-ex");
    expect(card.category).toBe("Pokémon");
    expect(card.rarity).toBe("Illustration spéciale rare");
    expect(card.variants).toEqual({
      firstEdition: false,
      holo: true,
      normal: false,
      reverse: false,
      wPromo: false,
    });
    expect(card.hp).toBe(330);
    expect(card.types).toEqual(["Feu"]);
    expect(card.pricing?.cardmarket?.idProduct).toBe(733794);
    expect(card.attacks?.[0]?.damage).toBe("60+");
  });

  it("decodes trainer cards without hp / attacks", async () => {
    const { transport } = makeTransport([[/\/fr\/cards\/sv08-189$/, ok(CARD_SV08_189_FR)]]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport });
    const card = await Effect.runPromise(client.getCard("fr", "sv08-189"));
    expect(card.category).toBe("Dresseur");
    expect(card.hp).toBeUndefined();
    expect(card.variants?.reverse).toBe(true);
  });

  it("retries retryable 500 failures with backoff, then succeeds", async () => {
    let attempts = 0;
    const { transport } = makeTransport([
      [
        /sets\/sv03\.5$/,
        (url) => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(new TcgdexHttpError({ url, status: 500, retryable: true, body: null }))
            : json(SET_DETAIL_SV035_FR);
        },
      ],
    ]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 5 });
    const set = await Effect.runPromise(withTestClock(client.getSet("fr", "sv03.5")));
    expect(set.id).toBe("sv03.5");
    expect(attempts).toBe(3);
  });

  it("retries 429 (rate limited) responses", async () => {
    let attempts = 0;
    const { transport } = makeTransport([
      [
        /en\/series$/,
        (url) => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(new TcgdexHttpError({ url, status: 429, retryable: true, body: null }))
            : json(SERIES_EN);
        },
      ],
    ]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 3 });
    const series = await Effect.runPromise(withTestClock(client.listSeries("en")));
    expect(series).toEqual(SERIES_EN);
    expect(attempts).toBe(2);
  });

  it("gives up after maxRetries on persistent 503 and fails with the last error", async () => {
    let attempts = 0;
    const { transport } = makeTransport([
      [
        /sets\//,
        (url) => {
          attempts += 1;
          return Effect.fail(
            new TcgdexHttpError({ url, status: 503, retryable: true, body: null }),
          );
        },
      ],
    ]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 2 });
    const error = await Effect.runPromise(
      Effect.flip(withTestClock(client.getSet("fr", "sv03.5"))),
    );
    expect(error).toBeInstanceOf(TcgdexHttpError);
    expect((error as TcgdexHttpError).status).toBe(503);
    expect(attempts).toBe(3); // initial attempt + 2 retries
  });

  it("does not retry a 404 (not retryable)", async () => {
    let attempts = 0;
    const { transport } = makeTransport([
      [
        /cards\//,
        (url) => {
          attempts += 1;
          return httpError(404, false)(url);
        },
      ],
    ]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 5 });
    const error = await Effect.runPromise(Effect.flip(client.getCard("fr", "nope-1")));
    expect(error).toBeInstanceOf(TcgdexHttpError);
    expect((error as TcgdexHttpError).status).toBe(404);
    expect((error as TcgdexHttpError).retryable).toBe(false);
    expect(attempts).toBe(1);
  });

  it("fails with TcgdexDecodeError on invalid JSON and does not retry", async () => {
    let attempts = 0;
    const { transport } = makeTransport([
      [
        /fr\/series$/,
        () => {
          attempts += 1;
          return Effect.succeed("<html>not json</html>");
        },
      ],
    ]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 5 });
    const error = await Effect.runPromise(Effect.flip(client.listSeries("fr")));
    expect(error).toBeInstanceOf(TcgdexDecodeError);
    expect(attempts).toBe(1);
  });

  it("fails with TcgdexDecodeError when the payload does not match the schema", async () => {
    const { transport } = makeTransport([
      [/sets\/sv03\.5$/, ok({ id: "sv03.5", name: "151", cards: "nope" })],
    ]);
    const client = makeTcgdexClient({ baseUrl: BASE, transport });
    const error = await Effect.runPromise(Effect.flip(client.getSet("fr", "sv03.5")));
    expect(error).toBeInstanceOf(TcgdexDecodeError);
  });

  it("times out slow requests through fetchTransport and retries the transport-level failure", async () => {
    let attempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      attempts += 1;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    try {
      const transport = fetchTransport(50);
      const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 1 });
      const error = await Effect.runPromise(Effect.flip(withTestClock(client.listSeries("fr"))));
      expect(error).toBeInstanceOf(TcgdexHttpError);
      expect((error as TcgdexHttpError).status).toBe(0);
      expect((error as TcgdexHttpError).retryable).toBe(true);
      expect(attempts).toBe(2); // initial attempt + 1 retry
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes an AbortSignal to fetch and aborts the in-flight request on timeout", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    try {
      const transport = fetchTransport(50);
      const error = await Effect.runPromise(
        Effect.flip(withTestClock(transport(`${BASE}/fr/series`))),
      );
      expect(error).toBeInstanceOf(TcgdexHttpError);
      expect((error as TcgdexHttpError).status).toBe(0);
      expect(signals).toHaveLength(1);
      const signal = signals[0];
      expect(signal).toBeInstanceOf(AbortSignal);
      // The timeout interrupted the fetch fiber → the socket request was aborted.
      expect(signal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still retries after a 10 s request timeout (retry schedule is not capped by elapsed time)", async () => {
    let attempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      attempts += 1;
      return attempts < 3
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(JSON.stringify(SERIES_FR), { status: 200 }));
    }) as typeof fetch;
    try {
      const client = makeTcgdexClient({ baseUrl: BASE, maxRetries: 5 }); // default 10 s timeout
      const series = await Effect.runPromise(withTestClock(client.listSeries("fr")));
      expect(series).toEqual(SERIES_FR);
      expect(attempts).toBe(3); // two 10 s timeouts, then success
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps each retry delay at 5 s (exponential backoff, jittered)", async () => {
    const delays = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(tcgdexRetrySchedule);
        const collected: Array<number> = [];
        for (let index = 0; index < 12; index++) {
          const [, delay] = yield* step(index * 1_000, undefined);
          collected.push(Duration.toMillis(delay));
        }
        return collected;
      }),
    );
    expect(Duration.toMillis(Duration.fromInputUnsafe(TCGDEX_MAX_RETRY_DELAY))).toBe(5_000);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(5_000);
    expect(Math.max(...delays)).toBeGreaterThan(100); // grows beyond the first step
  });

  it("maps fetch rejections to a retryable transport-level TcgdexHttpError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;
    try {
      const transport = fetchTransport(1_000);
      const client = makeTcgdexClient({ baseUrl: BASE, transport, maxRetries: 0 });
      const error = await Effect.runPromise(Effect.flip(client.listSets("fr")));
      expect(error).toBeInstanceOf(TcgdexHttpError);
      expect((error as TcgdexHttpError).status).toBe(0);
      expect((error as TcgdexHttpError).retryable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes an injectable Layer (TcgdexClientLive) usable with Effect.provide", async () => {
    const { transport } = makeTransport([[/\/en\/series$/, ok(SERIES_EN)]]);
    const program = Effect.gen(function* () {
      const client = yield* TcgdexClient;
      return yield* client.listSeries("en");
    });
    const layer: Layer.Layer<TcgdexClient> = TcgdexClientLive({ baseUrl: `${BASE}/`, transport });
    const series = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(series[1]?.name).toBe("Scarlet & Violet");
  });
});
