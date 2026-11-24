import { type SearchQuery, SearchQuery as SearchQuerySchema } from "@pokevault/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SEARCH_FIXTURE_CARDS, SEARCH_FIXTURE_SETS } from "./catalog-search.fixture.ts";
import {
  CatalogSearchService,
  CatalogSearchServiceLive,
  CatalogSearchServiceMemory,
  DISCOVER_CARD_LIMIT,
  DISCOVER_SET_LIMIT,
  SUGGEST_CARD_LIMIT,
  SUGGEST_SET_LIMIT,
  trigramSimilarity,
} from "./catalog-search.ts";
import { Database, type Sql } from "./db.ts";

const layer = CatalogSearchServiceMemory({
  sets: SEARCH_FIXTURE_SETS,
  cards: SEARCH_FIXTURE_CARDS,
});

const query = (input: Record<string, unknown> = {}): SearchQuery =>
  Schema.decodeUnknownSync(SearchQuerySchema)(input);

const run = <A, E>(
  program: (service: typeof CatalogSearchService.Service) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* program(yield* CatalogSearchService);
    }).pipe(Effect.provide(layer)),
  );

const search = (input: Record<string, unknown> = {}) =>
  run((service) => service.search(query(input)));
const ids = (hits: ReadonlyArray<{ readonly id: string }>): Array<string> =>
  hits.map((hit) => hit.id);

describe("trigramSimilarity (pg_trgm parity)", () => {
  it("scores identical strings 1 and unrelated strings 0", () => {
    expect(trigramSimilarity("Pikachu", "pikachu")).toBe(1);
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
    expect(trigramSimilarity("", "abc")).toBe(0);
  });

  it("tolerates a typo above the 0.2 threshold", () => {
    expect(trigramSimilarity("Dracaufeu ex", "dracofeu")).toBeGreaterThan(0.2);
  });
});

describe("CatalogSearchService.discover", () => {
  it("returns the most recent sets (release_date DESC, no empty sets) and featured SIR/gold/tera cards", async () => {
    const payload = await run((service) => service.discover());
    expect(ids(payload.popularSets)).toEqual(["sv08", "sv03.5", "swsh12"]);
    expect(payload.popularSets.length).toBeLessThanOrEqual(DISCOVER_SET_LIMIT);
    expect(payload.popularSets[1]).toEqual({
      id: "sv03.5",
      code: "151",
      nameFr: "151",
      logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
      releaseDate: "2023-09-22",
      officialCount: 165,
      totalCount: 207,
    });
    expect(payload.popularSets[2]?.logoUrl).toBeNull();
    expect(ids(payload.featuredCards)).toEqual(["sv08-238", "sv08-201", "sv08-100", "sv03.5-199"]);
    expect(payload.featuredCards.length).toBeLessThanOrEqual(DISCOVER_CARD_LIMIT);
    expect(payload.featuredCards[0]).toMatchObject({
      setName: "Étincelles Déferlantes",
      localId: "238",
      imageUrl: "https://assets.tcgdex.net/fr/sv08/238/low.webp",
    });
  });

  it("is empty for an empty catalogue", async () => {
    const empty = CatalogSearchServiceMemory({ sets: [], cards: [] });
    const payload = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CatalogSearchService).discover();
      }).pipe(Effect.provide(empty)),
    );
    expect(payload).toEqual({ popularSets: [], featuredCards: [] });
  });
});

describe("CatalogSearchService.suggest", () => {
  it("returns nothing for a blank query", async () => {
    expect(await run((service) => service.suggest("   "))).toEqual({
      query: "",
      cards: [],
      sets: [],
    });
  });

  it("groups cards and sets (best name match first, capped)", async () => {
    const payload = await run((service) => service.suggest("Pikachu"));
    expect(payload.query).toBe("Pikachu");
    expect(payload.cards[0]?.nameFr).toBe("Pikachu");
    expect(payload.cards.length).toBeLessThanOrEqual(SUGGEST_CARD_LIMIT);
    expect(ids(payload.cards)).toContain("sv08-238");
    expect(payload.sets.length).toBeLessThanOrEqual(SUGGEST_SET_LIMIT);
  });

  it("tolerates typos (pg_trgm)", async () => {
    const payload = await run((service) => service.suggest("Dracofeu"));
    expect(ids(payload.cards)).toEqual(
      expect.arrayContaining(["sv03.5-006", "sv03.5-199", "sv08-201"]),
    );
  });

  it("matches a set by name and by code", async () => {
    const byName = await run((service) => service.suggest("Étincelles"));
    expect(ids(byName.sets)).toEqual(["sv08"]);
    const byCode = await run((service) => service.suggest("mew"));
    expect(ids(byCode.sets)).toContain("sv03.5");
    expect(ids(byCode.cards)).toContain("sv03.5-205");
  });

  it("matches card numbers with or without #", async () => {
    const hashed = await run((service) => service.suggest("#199"));
    expect(ids(hashed.cards)).toContain("sv03.5-199");
    const prefixed = await run((service) => service.suggest("TG01"));
    expect(ids(prefixed.cards)).toContain("swsh12-TG01");
  });

  it("treats LIKE wildcards literally", async () => {
    // Un `%` / `_` non échappé matcherait tout le catalogue ; échappé, seule l'extension
    // dont le nom contient réellement ces caractères remonte.
    expect(ids((await run((service) => service.suggest("%"))).cards)).toEqual(["promo-x-001"]);
    expect(ids((await run((service) => service.suggest("_"))).cards)).toEqual(["promo-x-001"]);
    const sets = await run((service) => service.suggest("100% _sp"));
    expect(ids(sets.sets)).toEqual(["promo-x"]);
  });
});

describe("CatalogSearchService.search", () => {
  it("finds cards by name, relevance puts the exact name first", async () => {
    const result = await search({ q: "pikachu", scope: "cards" });
    expect(ids(result.cards)[0]).toBe("sv03.5-025");
    expect(ids(result.cards)).toEqual(
      expect.arrayContaining(["sv08-238", "sv08-100", "promo-x-001"]),
    );
    expect(result.totalCards).toBe(result.cards.length);
    expect(result.sets).toEqual([]);
    expect(result.query.q).toBe("pikachu");
  });

  it("finds a card by number (#199, zero-padded 025, prefixed TG01)", async () => {
    expect(ids((await search({ q: "#199", scope: "cards" })).cards)).toContain("sv03.5-199");
    expect(ids((await search({ q: "025", scope: "cards" })).cards)).toContain("sv03.5-025");
    expect(ids((await search({ q: "TG01", scope: "cards" })).cards)).toContain("swsh12-TG01");
  });

  it("searches illustrators only with the illustrators scope", async () => {
    const result = await search({ q: "Mizue", scope: "illustrators" });
    expect(ids(result.cards).sort()).toEqual(["swsh12-030", "swsh12-TG01"]);
    expect(result.sets).toEqual([]);
    const byName = await search({ q: "Pikachu", scope: "illustrators" });
    expect(byName.cards).toEqual([]);
  });

  it("scope all combines cards (name/illustrator/set) and sets", async () => {
    const result = await search({ q: "151" });
    expect(ids(result.sets)).toEqual(["sv03.5"]);
    expect(result.totalSets).toBe(1);
    // Toutes les cartes de l'extension 151 + les cartes dont le numéro est 151.
    expect(ids(result.cards)).toEqual(
      expect.arrayContaining(["sv03.5-006", "sv03.5-199", "sv03.5-025", "sv03.5-205"]),
    );
    const byArtist = await search({ q: "Arita" });
    expect(ids(byArtist.cards).sort()).toEqual(["sv03.5-006", "sv08-201"]);
  });

  it("scope sets only returns sets (paginated) and never cards", async () => {
    const result = await search({ q: "", scope: "sets", limit: 2 });
    expect(result.cards).toEqual([]);
    expect(result.totalCards).toBe(0);
    expect(ids(result.sets)).toEqual(["sv08", "sv03.5"]);
    expect(result.totalSets).toBe(4);
    const page2 = await search({ q: "", scope: "sets", limit: 2, offset: 2 });
    expect(ids(page2.sets)).toEqual(["swsh12", "promo-x"]);
    const named = await search({ q: "argent", scope: "sets" });
    expect(ids(named.sets)).toEqual(["swsh12"]);
  });

  it("filters by quick access", async () => {
    const cards = async (quickAccess: string): Promise<ReadonlyArray<string>> =>
      ids((await search({ quickAccess })).cards).sort();
    expect(await cards("sir")).toEqual(["sv03.5-199", "sv08-238"]);
    expect(await cards("ar")).toEqual(["sv03.5-205"]);
    expect(await cards("ex")).toEqual(["sv03.5-205"]);
    expect(await cards("tera")).toEqual(["sv08-100"]);
    expect(await cards("promos")).toEqual(["promo-x-001"]);
  });

  it("filters by set and combines with text and quick access", async () => {
    const bySet = await search({ setId: "sv08" });
    expect(ids(bySet.cards).sort()).toEqual(["sv08-100", "sv08-201", "sv08-238"]);
    expect(bySet.sets).toEqual([]);
    const combined = await search({ q: "pikachu", setId: "sv08", quickAccess: "sir" });
    expect(ids(combined.cards)).toEqual(["sv08-238"]);
  });

  it("sorts by number and by name", async () => {
    const byNumber = await search({ setId: "sv03.5", sort: "number" });
    expect(ids(byNumber.cards)).toEqual(["sv03.5-006", "sv03.5-025", "sv03.5-199", "sv03.5-205"]);
    const byName = await search({ setId: "sv03.5", sort: "name" });
    expect(byName.cards.map((hit) => hit.nameFr)).toEqual([
      "Dracaufeu",
      "Dracaufeu ex",
      "Mew ex",
      "Pikachu",
    ]);
  });

  it("paginates with limit / offset while keeping the total", async () => {
    const first = await search({ setId: "sv03.5", sort: "number", limit: 3 });
    expect(ids(first.cards)).toEqual(["sv03.5-006", "sv03.5-025", "sv03.5-199"]);
    expect(first.totalCards).toBe(4);
    const second = await search({ setId: "sv03.5", sort: "number", limit: 3, offset: 3 });
    expect(ids(second.cards)).toEqual(["sv03.5-205"]);
    const beyond = await search({ setId: "sv03.5", limit: 3, offset: 30 });
    expect(beyond.cards).toEqual([]);
    expect(beyond.totalCards).toBe(4);
  });

  it("returns no card for an unknown set or a query without match", async () => {
    expect((await search({ setId: "nope" })).cards).toEqual([]);
    const none = await search({ q: "zzzzqq" });
    expect(none).toMatchObject({ totalCards: 0, totalSets: 0, cards: [], sets: [] });
  });

  it("exposes null image / fallback fields", async () => {
    const result = await search({ q: "Carapuce", scope: "cards" });
    expect(result.cards[0]).toMatchObject({
      nameFr: "Carapuce",
      imageUrl: null,
      rarity: null,
      setCode: "SIT",
    });
  });
});

// ---------------------------------------------------------------------------
// Live : enrichissement prix (`LEFT JOIN LATERAL … LIMIT 1`) avec une fausse base
// ---------------------------------------------------------------------------

const cardRow = (id: string, localId: string): Record<string, unknown> => ({
  id,
  set_id: "sv03.5",
  set_name: "151",
  set_code: "151",
  local_id: localId,
  local_id_numeric: Number(localId),
  name_fr: `Carte ${localId}`,
  rarity: "Rare",
  holo_effect: "none",
  illustrator: null,
  image_base_url: `https://assets.tcgdex.net/fr/sv/sv03.5/${localId}`,
});

interface FakeSearchSql {
  readonly sql: Sql;
  readonly priceQueries: Array<{ readonly text: string; readonly values: ReadonlyArray<unknown> }>;
}

/** Fausse `Sql` : cartes de la page, prix (ou erreur) et compteur, routés sur le texte SQL. */
const makeFakeSearchSql = (options: {
  readonly cards: ReadonlyArray<Record<string, unknown>>;
  readonly prices: ReadonlyArray<Record<string, unknown>> | Error;
}): FakeSearchSql => {
  const priceQueries: FakeSearchSql["priceQueries"] = [];
  const run = (text: string, values: ReadonlyArray<unknown>): Promise<unknown> => {
    if (text.includes("card_latest_prices")) {
      priceQueries.push({ text, values });
      return options.prices instanceof Error
        ? Promise.reject(options.prices)
        : Promise.resolve(options.prices);
    }
    if (text.includes("FROM catalog_sets")) return Promise.resolve([]);
    if (text.includes("count(*)")) return Promise.resolve([{ total: options.cards.length }]);
    if (text.includes("LIMIT")) return Promise.resolve(options.cards);
    return Promise.resolve([]);
  };
  const fake = (strings: unknown, ...values: ReadonlyArray<unknown>): unknown => {
    if (Array.isArray(strings) && "raw" in (strings as { raw?: unknown })) {
      return run((strings as unknown as TemplateStringsArray).join(" ? "), values);
    }
    return strings;
  };
  return { sql: fake as unknown as Sql, priceQueries };
};

const priceRow = (
  cardId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  card_id: cardId,
  source: "cardmarket",
  trend_cents: 1234,
  low_fr_cents: 900,
  avg30_cents: null,
  fetched_at: new Date("2026-06-01T11:55:00.000Z"),
  expires_at: "2026-06-01T12:10:00.000Z",
  is_fresh: true,
  ...overrides,
});

const runLive = <A>(
  sql: Sql,
  program: (service: typeof CatalogSearchService.Service) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* program(yield* CatalogSearchService);
    }).pipe(
      Effect.provide(
        CatalogSearchServiceLive.pipe(Layer.provide(Layer.succeed(Database, { sql }))),
      ),
    ),
  );

describe("CatalogSearchServiceLive — prix des cartes", () => {
  const cards = [cardRow("sv03.5-3", "3"), cardRow("sv03.5-1", "1"), cardRow("sv03.5-2", "2")];

  it("joint le dernier prix par LEFT JOIN LATERAL … LIMIT 1, après pagination, une seule requête", async () => {
    const fake = makeFakeSearchSql({
      cards,
      prices: [priceRow("sv03.5-1"), priceRow("sv03.5-3", { trend_cents: 99 })],
    });
    const payload = await runLive(fake.sql, (service) =>
      service.search(query({ q: "carte", scope: "cards" })),
    );
    expect(fake.priceQueries).toHaveLength(1);
    const text = fake.priceQueries[0]?.text ?? "";
    expect(text).toContain("LEFT JOIN LATERAL");
    expect(text).toContain("FROM card_latest_prices lp");
    expect(text).toContain("lp.card_id = c.id");
    expect(text).toMatch(/LIMIT 1\s*\) p ON TRUE/);
    expect(text).toContain("(lp.language = 'FR' AND lp.variant = 'normal') DESC");
    // Seuls les ids de la page sont interrogés, dans l'ordre des résultats.
    expect(fake.priceQueries[0]?.values[0]).toEqual(["sv03.5-3", "sv03.5-1", "sv03.5-2"]);
    // L'ordre des résultats est conservé ; chaque carte reçoit SON prix.
    expect(payload.cards.map((hit) => hit.id)).toEqual(["sv03.5-3", "sv03.5-1", "sv03.5-2"]);
    expect(payload.cards[0]?.price?.trendCents).toBe(99);
    expect(payload.cards[1]?.price).toEqual({
      trendCents: 1234,
      lowFrCents: 900,
      avg30Cents: null,
      source: "cardmarket",
      fetchedAt: "2026-06-01T11:55:00.000Z",
      expiresAt: "2026-06-01T12:10:00.000Z",
      isFresh: true,
    });
  });

  it("price: null pour une carte sans snapshot (colonnes null de la jointure latérale)", async () => {
    const fake = makeFakeSearchSql({
      cards: [cardRow("sv03.5-1", "1")],
      prices: [
        priceRow("sv03.5-1", {
          source: null,
          trend_cents: null,
          low_fr_cents: null,
          fetched_at: null,
          expires_at: null,
          is_fresh: null,
        }),
      ],
    });
    const payload = await runLive(fake.sql, (service) => service.search(query({ q: "carte" })));
    expect(payload.cards[0]?.price).toBeNull();
  });

  it("n'interroge pas les prix quand la page est vide", async () => {
    const fake = makeFakeSearchSql({ cards: [], prices: [] });
    const payload = await runLive(fake.sql, (service) => service.search(query({ q: "zzz" })));
    expect(payload.cards).toEqual([]);
    expect(fake.priceQueries).toHaveLength(0);
  });

  it("best-effort : une erreur de la table de prix ne casse jamais la recherche", async () => {
    const fake = makeFakeSearchSql({
      cards: [cardRow("sv03.5-1", "1")],
      prices: new Error('relation "card_latest_prices" does not exist'),
    });
    const payload = await runLive(fake.sql, (service) => service.search(query({ q: "carte" })));
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0]?.id).toBe("sv03.5-1");
    expect(payload.cards[0]?.price).toBeUndefined();
  });

  it("enrichit aussi les suggestions et les cartes phares", async () => {
    const fake = makeFakeSearchSql({
      cards: [cardRow("sv03.5-1", "1")],
      prices: [priceRow("sv03.5-1")],
    });
    const suggestions = await runLive(fake.sql, (service) => service.suggest("carte"));
    expect(suggestions.cards[0]?.price?.trendCents).toBe(1234);
    const discovery = await runLive(fake.sql, (service) => service.discover());
    expect(discovery.featuredCards[0]?.price?.trendCents).toBe(1234);
  });
});

describe("CatalogSearchServiceMemory — prix", () => {
  it("n'ajoute aucun prix (implémentation hors-ligne, champ optionnel absent)", async () => {
    const payload = await search({ q: "dracaufeu" });
    expect(payload.cards.every((hit) => hit.price === undefined)).toBe(true);
  });
});
