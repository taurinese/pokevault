import { type SearchQuery, SearchQuery as SearchQuerySchema } from "@pokevault/domain";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogRepository, CatalogRepositoryLive } from "./catalog-repo.ts";
import { SEARCH_FIXTURE_CARDS, SEARCH_FIXTURE_SETS } from "./catalog-search.fixture.ts";
import {
  CatalogSearchService,
  CatalogSearchServiceLive,
  CatalogSearchServiceMemory,
  type CatalogSearchServiceShape,
} from "./catalog-search.ts";
import { acquirePgLock, PG_HOOK_TIMEOUT_MS, releasePgLock } from "./collection-pg-harness.ts";
import { DatabaseLive } from "./db.ts";

/**
 * Tests SQL réels de `CatalogSearchServiceLive` : ils ne tournent que si
 * `PGTEST_URL` pointe vers un Postgres où `supabase/migrations/002_catalog.sql`
 * est appliquée (conteneur jetable `supabase/postgres`, voir README de la PR).
 * Sans cette variable (CI, dev hors-ligne) ils sont ignorés.
 *
 *   docker run -d --name pv-search-pg -e POSTGRES_PASSWORD=pgtest -p 54399:5432 supabase/postgres:15.8.1.085
 *   PGTEST_URL=postgres://supabase_admin:pgtest@127.0.0.1:54399/postgres pnpm vitest run catalog-search.pg
 */
const PGTEST_URL = process.env["PGTEST_URL"];

const query = (input: Record<string, unknown> = {}): SearchQuery =>
  Schema.decodeUnknownSync(SearchQuerySchema)(input);
const ids = (hits: ReadonlyArray<{ readonly id: string }>): Array<string> =>
  hits.map((hit) => hit.id);

describe.skipIf(PGTEST_URL === undefined)("CatalogSearchServiceLive (Postgres réel)", () => {
  // Les autres fichiers `*.pg.test.ts` insèrent leur propre catalogue : exécution sérialisée.
  beforeAll(acquirePgLock, PG_HOOK_TIMEOUT_MS);
  afterAll(releasePgLock);

  const dbLayer = DatabaseLive({ connectionString: PGTEST_URL ?? "", maxConnections: 2 });
  const liveLayer = Layer.mergeAll(
    CatalogRepositoryLive,
    CatalogSearchServiceLive.pipe(Layer.provide(dbLayer)),
  ).pipe(Layer.provideMerge(dbLayer));

  const withService = <A>(
    program: (service: CatalogSearchServiceShape) => Effect.Effect<A, unknown>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CatalogRepository;
          yield* repo.upsertSeries([
            { id: "sv", name_fr: "Écarlate et Violet", name_en: null, release_order: 12 },
            { id: "swsh", name_fr: "Épée et Bouclier", name_en: null, release_order: 11 },
            { id: "pr", name_fr: "Promos", name_en: null, release_order: 0 },
          ]);
          yield* repo.upsertSets(SEARCH_FIXTURE_SETS);
          yield* repo.upsertCards(SEARCH_FIXTURE_CARDS);
          return yield* program(yield* CatalogSearchService);
        }).pipe(Effect.provide(liveLayer)),
      ),
    );

  it("discover : extensions récentes + cartes phares", async () => {
    const payload = await withService((service) => service.discover());
    expect(ids(payload.popularSets)).toEqual(["sv08", "sv03.5", "swsh12"]);
    expect(payload.popularSets[0]?.releaseDate).toBe("2024-11-08");
    expect(ids(payload.featuredCards)).toEqual(["sv08-238", "sv08-201", "sv08-100", "sv03.5-199"]);
    expect(payload.featuredCards[0]?.imageUrl).toBe(
      "https://assets.tcgdex.net/fr/sv08/238/low.webp",
    );
  });

  it("suggest : nom, faute de frappe, numéro, extension", async () => {
    const pika = await withService((service) => service.suggest("Pikachu"));
    expect(pika.cards[0]?.nameFr).toBe("Pikachu");
    expect(pika.cards.length).toBeLessThanOrEqual(5);
    const typo = await withService((service) => service.suggest("Dracofeu"));
    expect(ids(typo.cards)).toEqual(expect.arrayContaining(["sv03.5-006", "sv03.5-199"]));
    const number = await withService((service) => service.suggest("#199"));
    expect(ids(number.cards)).toContain("sv03.5-199");
    const set = await withService((service) => service.suggest("Étincelles"));
    expect(ids(set.sets)).toEqual(["sv08"]);
    const blank = await withService((service) => service.suggest("  "));
    expect(blank).toEqual({ query: "", cards: [], sets: [] });
  });

  it("suggest / search : la saisie n'est jamais interprétée comme SQL ou joker LIKE", async () => {
    const injection = "'; DROP TABLE catalog_cards; --";
    const hostile = await withService((service) => service.suggest(injection));
    expect(hostile.cards).toEqual([]);
    const stillThere = await withService((service) => service.search(query({ setId: "sv08" })));
    expect(stillThere.totalCards).toBe(3);
    const wildcard = await withService((service) => service.suggest("%"));
    expect(ids(wildcard.cards)).toEqual(["promo-x-001"]);
    for (const q of ["!!!", "&|:*", "\\", "()", "'", "#", "-", '"']) {
      await withService((service) => service.search(query({ q })));
    }
  });

  it("search : scopes, quick access, set, tri et pagination", async () => {
    const mizue = await withService((service) =>
      service.search(query({ q: "Mizue", scope: "illustrators" })),
    );
    expect(ids(mizue.cards).sort()).toEqual(["swsh12-030", "swsh12-TG01"]);
    const tg = await withService((service) => service.search(query({ q: "TG01", scope: "cards" })));
    expect(ids(tg.cards)).toContain("swsh12-TG01");
    const n199 = await withService((service) => service.search(query({ q: "#199" })));
    expect(ids(n199.cards)).toContain("sv03.5-199");

    const quick = async (quickAccess: string) =>
      ids((await withService((service) => service.search(query({ quickAccess })))).cards).sort();
    expect(await quick("sir")).toEqual(["sv03.5-199", "sv08-238"]);
    expect(await quick("ar")).toEqual(["sv03.5-205"]);
    expect(await quick("ex")).toEqual(["sv03.5-205"]);
    expect(await quick("tera")).toEqual(["sv08-100"]);
    expect(await quick("promos")).toEqual(["promo-x-001"]);

    const byNumber = await withService((service) =>
      service.search(query({ setId: "sv03.5", sort: "number", limit: 3 })),
    );
    expect(ids(byNumber.cards)).toEqual(["sv03.5-006", "sv03.5-025", "sv03.5-199"]);
    expect(byNumber.totalCards).toBe(4);
    const page2 = await withService((service) =>
      service.search(query({ setId: "sv03.5", sort: "number", limit: 3, offset: 3 })),
    );
    expect(ids(page2.cards)).toEqual(["sv03.5-205"]);
    const byName = await withService((service) =>
      service.search(query({ setId: "sv03.5", sort: "name" })),
    );
    expect(byName.cards.map((hit) => hit.nameFr)).toEqual([
      "Dracaufeu",
      "Dracaufeu ex",
      "Mew ex",
      "Pikachu",
    ]);

    const sets = await withService((service) =>
      service.search(query({ q: "", scope: "sets", limit: 2 })),
    );
    expect(ids(sets.sets)).toEqual(["sv08", "sv03.5"]);
    expect(sets.totalSets).toBe(4);
    expect(sets.cards).toEqual([]);

    const all = await withService((service) => service.search(query({ q: "151" })));
    expect(ids(all.sets)).toEqual(["sv03.5"]);
    expect(ids(all.cards)).toEqual(expect.arrayContaining(["sv03.5-006", "sv03.5-199"]));
  });

  it("search : relevance met le nom exact d'abord", async () => {
    const result = await withService((service) =>
      service.search(query({ q: "pikachu", scope: "cards" })),
    );
    expect(ids(result.cards)[0]).toBe("sv03.5-025");
  });

  it("parité Memory / Postgres sur des requêtes représentatives", async () => {
    const memory = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* CatalogSearchService;
      }).pipe(
        Effect.provide(
          CatalogSearchServiceMemory({ sets: SEARCH_FIXTURE_SETS, cards: SEARCH_FIXTURE_CARDS }),
        ),
      ),
    );
    const inputs: ReadonlyArray<Record<string, unknown>> = [
      { q: "pikachu", scope: "cards" },
      { q: "Dracofeu" },
      { q: "#199" },
      { q: "Mizue", scope: "illustrators" },
      { q: "151" },
      { quickAccess: "sir", sort: "name" },
      { setId: "sv08", sort: "number" },
      // Combinaisons texte + filtre (régression précédence OR / AND).
      { q: "Dracaufeu", quickAccess: "sir" },
      { q: "Dracaufeu", setId: "sv08" },
      { q: "Pikachu", quickAccess: "tera" },
      { q: "Dracaufeu", scope: "cards", quickAccess: "sir" },
    ];
    for (const input of inputs) {
      const real = await withService((service) => service.search(query(input)));
      const offline = await Effect.runPromise(memory.search(query(input)));
      expect([input, ids(real.cards).sort(), real.totalCards, ids(real.sets)]).toEqual([
        input,
        ids(offline.cards).sort(),
        offline.totalCards,
        ids(offline.sets),
      ]);
    }
  });

  it("fonctionne avec le rôle moindre privilège `authenticated` (RLS lecture seule)", async () => {
    // Seed via superuser/postgres puis lecture via `role: "authenticated"`.
    await withService(() => Effect.void);
    const readerDbLayer = DatabaseLive({
      connectionString: PGTEST_URL ?? "",
      maxConnections: 2,
      role: "authenticated",
    });
    const readerLayer = CatalogSearchServiceLive.pipe(Layer.provide(readerDbLayer));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* CatalogSearchService;
          return yield* service.search(query({ q: "Dracaufeu", quickAccess: "sir" }));
        }).pipe(Effect.provide(readerLayer)),
      ),
    );
    expect(ids(result.cards)).toEqual(["sv03.5-199"]);
    expect(result.totalCards).toBe(1);
  });
});
