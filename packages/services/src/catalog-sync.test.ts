import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeCatalogRepositoryMemory } from "./catalog-repo.ts";
import {
  type CatalogSyncOptions,
  cardDetailToRow,
  seriesToRow,
  setDetailToRow,
  TcgdexSyncService,
  TcgdexSyncServiceLive,
} from "./catalog-sync.ts";
import {
  type TcgdexCardDetail,
  TcgdexClient,
  type TcgdexClientShape,
  TcgdexDecodeError,
  TcgdexHttpError,
  type TcgdexSeriesSummary,
  type TcgdexSetDetail,
  type TcgdexSetSummary,
} from "./tcgdex.ts";

// ---------------------------------------------------------------------------
// Fixtures (realistic FR + EN payloads, decoded shapes)
// ---------------------------------------------------------------------------

const SERIES_FR: ReadonlyArray<TcgdexSeriesSummary> = [
  { id: "sv", name: "Écarlate et Violet", logo: "https://assets.tcgdex.net/fr/sv/sv01/logo" },
];
const SERIES_EN: ReadonlyArray<TcgdexSeriesSummary> = [
  { id: "sv", name: "Scarlet & Violet", logo: "https://assets.tcgdex.net/en/sv/sv01/logo" },
];

const SETS_FR: ReadonlyArray<TcgdexSetSummary> = [
  {
    id: "sv03.5",
    name: "151",
    logo: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
    symbol: "https://assets.tcgdex.net/univ/sv/sv03.5/symbol",
    cardCount: { total: 207, official: 165 },
  },
  { id: "sv08", name: "Faille Dimensionnelle", cardCount: { total: 191, official: 86 } },
];

const SET_SV035_FR: TcgdexSetDetail = {
  id: "sv03.5",
  name: "151",
  logo: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
  symbol: "https://assets.tcgdex.net/univ/sv/sv03.5/symbol",
  releaseDate: "2023-09-22",
  cardCount: { firstEd: 0, holo: 90, normal: 135, official: 165, reverse: 158, total: 207 },
  serie: { id: "sv", name: "Écarlate et Violet" },
  abbreviation: { official: "MEW", localized: "151" },
  cards: [
    {
      id: "sv03.5-001",
      localId: "001",
      name: "Bulbizarre",
      image: "https://assets.tcgdex.net/fr/sv/sv03.5/001",
    },
    {
      id: "sv03.5-199",
      localId: "199",
      name: "Dracaufeu-ex",
      image: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
    },
  ],
};

const SET_SV035_EN: TcgdexSetDetail = {
  ...SET_SV035_FR,
  serie: { id: "sv", name: "Scarlet & Violet" },
  cards: [
    {
      id: "sv03.5-001",
      localId: "001",
      name: "Bulbasaur",
      image: "https://assets.tcgdex.net/en/sv/sv03.5/001",
    },
    {
      id: "sv03.5-199",
      localId: "199",
      name: "Charizard ex",
      image: "https://assets.tcgdex.net/en/sv/sv03.5/199",
    },
  ],
};

// sv08 has incoherent counts on purpose (total < official) to test normalization.
const SET_SV08_FR: TcgdexSetDetail = {
  id: "sv08",
  name: "Faille Dimensionnelle",
  releaseDate: "2024-11-08",
  cardCount: { official: 86, total: 42 },
  serie: { id: "sv", name: "Écarlate et Violet" },
  abbreviation: { official: "SSP", localized: "ETD" },
  cards: [{ id: "sv08-189", localId: "189", name: "Orbe Téracristal" }],
};

const CARD_SV035_001: TcgdexCardDetail = {
  id: "sv03.5-001",
  localId: "001",
  name: "Bulbizarre",
  image: "https://assets.tcgdex.net/fr/sv/sv03.5/001",
  category: "Pokémon",
  rarity: "Commune",
  hp: 70,
  types: ["Plante"],
  stage: "Base",
  illustrator: "Takashi Yamazaki",
  variants: { normal: true, reverse: true, holo: false, firstEdition: false, wPromo: false },
  set: { id: "sv03.5" },
};

const CARD_SV035_199: TcgdexCardDetail = {
  id: "sv03.5-199",
  localId: "199",
  name: "Dracaufeu-ex",
  image: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  category: "Pokémon",
  rarity: "Illustration spéciale rare",
  hp: 330,
  types: ["Feu"],
  stage: "Niveau 2",
  suffix: "ex",
  illustrator: "miki kudo",
  variants: { normal: false, reverse: false, holo: true, firstEdition: false, wPromo: false },
  attacks: [{ name: "Vortex Explosif", damage: 330 }],
  pricing: { cardmarket: { idProduct: 733794 } },
  set: { id: "sv03.5" },
};

const CARD_SV08_189: TcgdexCardDetail = {
  id: "sv08-189",
  localId: "189",
  name: "Orbe Téracristal",
  category: "Dresseur",
  rarity: "Peu Commune",
  variants: { normal: true, reverse: true, holo: false, firstEdition: false, wPromo: false },
  set: { id: "sv08" },
};

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface FakeOptions {
  readonly failSetFr?: ReadonlyArray<string> | undefined;
  readonly failSetEn404?: boolean | undefined;
  readonly failCardFr?: ReadonlyArray<string> | undefined;
}

const makeFakeClient = (options: FakeOptions = {}) => {
  const calls: Array<string> = [];
  const setsFr: Record<string, TcgdexSetDetail> = { "sv03.5": SET_SV035_FR, sv08: SET_SV08_FR };
  const setsEn: Record<string, TcgdexSetDetail> = { "sv03.5": SET_SV035_EN };
  const cards: Record<string, TcgdexCardDetail> = {
    "sv03.5-001": CARD_SV035_001,
    "sv03.5-199": CARD_SV035_199,
    "sv08-189": CARD_SV08_189,
  };
  const shape: TcgdexClientShape = {
    listSeries: (lang) => {
      calls.push(`series:${lang}`);
      return Effect.succeed(lang === "fr" ? SERIES_FR : SERIES_EN);
    },
    listSets: (lang) => {
      calls.push(`sets:${lang}`);
      return Effect.succeed(lang === "fr" ? SETS_FR : SETS_FR);
    },
    getSet: (lang, setId) => {
      calls.push(`set:${lang}:${setId}`);
      if (lang === "fr" && options.failSetFr?.includes(setId)) {
        return Effect.fail(
          new TcgdexHttpError({
            url: `fr/sets/${setId}`,
            status: 500,
            retryable: true,
            body: null,
          }),
        );
      }
      if (lang === "en" && (options.failSetEn404 === true || !(setId in setsEn))) {
        return Effect.fail(
          new TcgdexHttpError({
            url: `en/sets/${setId}`,
            status: 404,
            retryable: false,
            body: "not-found",
          }),
        );
      }
      const found = (lang === "fr" ? setsFr : setsEn)[setId];
      return found === undefined
        ? Effect.fail(
            new TcgdexHttpError({
              url: `${lang}/sets/${setId}`,
              status: 404,
              retryable: false,
              body: null,
            }),
          )
        : Effect.succeed(found);
    },
    getCard: (lang, cardId) => {
      calls.push(`card:${lang}:${cardId}`);
      if (lang === "fr" && options.failCardFr?.includes(cardId)) {
        return Effect.fail(
          new TcgdexHttpError({
            url: `fr/cards/${cardId}`,
            status: 503,
            retryable: true,
            body: null,
          }),
        );
      }
      const found = cards[cardId];
      return found === undefined
        ? Effect.fail(
            new TcgdexDecodeError({
              url: `${lang}/cards/${cardId}`,
              cause: new Error("missing fixture"),
            }),
          )
        : Effect.succeed(found);
    },
  };
  return { calls, layer: Layer.succeed(TcgdexClient, shape) };
};

const makeTestLayer = (options: FakeOptions = {}) => {
  const fake = makeFakeClient(options);
  const repo = makeCatalogRepositoryMemory();
  const layer = Layer.provideMerge(TcgdexSyncServiceLive, Layer.mergeAll(fake.layer, repo.layer));
  return { fake, repo, layer };
};

const runSync = (layer: Layer.Layer<TcgdexSyncService>, options?: CatalogSyncOptions) =>
  Effect.gen(function* () {
    const service = yield* TcgdexSyncService;
    return yield* service.sync(options);
  }).pipe(Effect.provide(layer));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const firstOf = <T>(values: ReadonlyArray<T>): T => {
  const value = values.at(0);
  if (value === undefined) throw new Error("fixture must not be empty");
  return value;
};

describe("pure mappers", () => {
  it("seriesToRow enriches name_en and keeps the FR list order", () => {
    expect(seriesToRow(firstOf(SERIES_FR), firstOf(SERIES_EN), 0)).toEqual({
      id: "sv",
      name_fr: "Écarlate et Violet",
      name_en: "Scarlet & Violet",
      release_order: 0,
    });
    expect(seriesToRow(firstOf(SERIES_FR), undefined, 3).name_en).toBeNull();
  });

  it("setDetailToRow maps abbreviation → code / cardmarket_code and normalizes counts", () => {
    const row = setDetailToRow(SET_SV035_FR, "151");
    expect(row).toEqual({
      id: "sv03.5",
      series_id: "sv",
      code: "151",
      cardmarket_code: "MEW",
      name_fr: "151",
      name_en: "151",
      logo_url: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
      symbol_url: "https://assets.tcgdex.net/univ/sv/sv03.5/symbol",
      release_date: "2023-09-22",
      official_count: 165,
      total_count: 207,
    });
    // total < official is lifted so CHECK (total_count >= official_count) holds
    const sv08 = setDetailToRow(SET_SV08_FR, null);
    expect(sv08.official_count).toBe(86);
    expect(sv08.total_count).toBe(86);
    expect(sv08.cardmarket_code).toBe("SSP");
  });

  it("cardDetailToRow derives category, variants, local_id_numeric, holo_effect and cardmarket id", () => {
    const row = cardDetailToRow(CARD_SV035_199, "sv03.5", "Charizard ex", null);
    expect(row).toEqual({
      id: "sv03.5-199",
      set_id: "sv03.5",
      local_id: "199",
      local_id_numeric: 199,
      name_fr: "Dracaufeu-ex",
      name_en: "Charizard ex",
      rarity: "Illustration spéciale rare",
      holo_effect: "sir",
      category: "Pokemon",
      types: ["Feu"],
      hp: 330,
      illustrator: "miki kudo",
      image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
      available_variants: ["holo"],
      cardmarket_product_id: 733794,
      cardmarket_url: null,
    });
  });

  it("cardDetailToRow detects Tera cards and maps FR categories", () => {
    const tera = cardDetailToRow(CARD_SV08_189, "sv08", "Tera Orb", null);
    expect(tera.category).toBe("Trainer");
    expect(tera.holo_effect).toBe("tera");
    expect(tera.local_id_numeric).toBe(189);
    expect(tera.available_variants).toEqual(["normal", "reverse"]);
    expect(tera.cardmarket_product_id).toBeNull();
    const basic = cardDetailToRow(CARD_SV035_001, "sv03.5", "Bulbasaur", "fallback-image");
    expect(basic.category).toBe("Pokemon");
    expect(basic.holo_effect).toBe("reverse"); // Commune + reverse variant
    expect(basic.local_id_numeric).toBe(1);
    expect(basic.image_base_url).toBe("https://assets.tcgdex.net/fr/sv/sv03.5/001");
  });
});

describe("TcgdexSyncService.sync", () => {
  it("syncs series, sets and cards with FR + EN enrichment", async () => {
    const { repo, layer } = makeTestLayer();
    const report = await Effect.runPromise(runSync(layer));
    expect(report.seriesCount).toBe(1);
    expect(report.setsCount).toBe(2);
    expect(report.cardsCount).toBe(3);
    expect(report.failedSets).toEqual([]);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);

    expect([...repo.series.keys()]).toEqual(["sv"]);
    expect(repo.series.get("sv")?.name_en).toBe("Scarlet & Violet");

    const sv035 = repo.sets.get("sv03.5");
    expect(sv035?.name_en).toBe("151");
    expect(sv035?.cardmarket_code).toBe("MEW");
    expect(sv035?.total_count).toBe(207);
    const sv08 = repo.sets.get("sv08");
    expect(sv08?.total_count).toBe(86); // normalized from 42
    expect(sv08?.name_en).toBeNull(); // EN set 404 → best effort

    const card = repo.cards.get("sv03.5-199");
    expect(card?.name_en).toBe("Charizard ex");
    expect(card?.holo_effect).toBe("sir");
    expect(card?.cardmarket_product_id).toBe(733794);
    expect(repo.cards.get("sv08-189")?.holo_effect).toBe("tera");
    expect(repo.cards.get("sv03.5-001")?.local_id_numeric).toBe(1);
  });

  it("is filterable by setIds (targeted bootstrap)", async () => {
    const { repo, layer } = makeTestLayer();
    const report = await Effect.runPromise(runSync(layer, { setIds: ["sv03.5"] }));
    expect(report.setsCount).toBe(1);
    expect(report.cardsCount).toBe(2);
    expect([...repo.sets.keys()]).toEqual(["sv03.5"]);
    expect([...repo.cards.keys()].sort()).toEqual(["sv03.5-001", "sv03.5-199"]);
  });

  it("is idempotent: two consecutive syncs leave the same state and counts", async () => {
    const { repo, layer } = makeTestLayer();
    const first = await Effect.runPromise(runSync(layer));
    const snapshot = {
      series: [...repo.series.values()],
      sets: [...repo.sets.values()],
      cards: [...repo.cards.values()],
    };
    const second = await Effect.runPromise(runSync(layer));
    expect(second.seriesCount).toBe(first.seriesCount);
    expect(second.setsCount).toBe(first.setsCount);
    expect(second.cardsCount).toBe(first.cardsCount);
    expect(second.failedSets).toEqual(first.failedSets);
    expect([...repo.series.values()]).toEqual(snapshot.series);
    expect([...repo.sets.values()]).toEqual(snapshot.sets);
    expect([...repo.cards.values()]).toEqual(snapshot.cards);
  });

  it("keeps syncing the other sets when one set fails", async () => {
    const { repo, layer } = makeTestLayer({ failSetFr: ["sv08"] });
    const report = await Effect.runPromise(runSync(layer));
    expect(report.setsCount).toBe(1);
    expect(report.cardsCount).toBe(2);
    expect(report.failedSets).toEqual(["sv08"]);
    expect(repo.sets.has("sv08")).toBe(false);
    expect(repo.sets.has("sv03.5")).toBe(true);
    expect(repo.cards.has("sv03.5-199")).toBe(true);
  });

  it("skips a failing card without failing its set", async () => {
    const { repo, layer } = makeTestLayer({ failCardFr: ["sv03.5-199"] });
    const report = await Effect.runPromise(runSync(layer));
    expect(report.failedSets).toEqual([]);
    expect(report.setsCount).toBe(2);
    expect(report.cardsCount).toBe(2); // 001 + sv08-189, the 199 is skipped
    expect(repo.cards.has("sv03.5-199")).toBe(false);
    expect(repo.cards.has("sv03.5-001")).toBe(true);
  });

  it("propagates a hard failure on the FR series listing", async () => {
    const hardFail: TcgdexClientShape = {
      listSeries: () =>
        Effect.fail(
          new TcgdexHttpError({ url: "fr/series", status: 500, retryable: false, body: null }),
        ),
      listSets: () => Effect.succeed(SETS_FR),
      getSet: () => Effect.fail(new TcgdexDecodeError({ url: "x", cause: null })),
      getCard: () => Effect.fail(new TcgdexDecodeError({ url: "x", cause: null })),
    };
    const repo = makeCatalogRepositoryMemory();
    const layer = Layer.provideMerge(
      TcgdexSyncServiceLive,
      Layer.mergeAll(Layer.succeed(TcgdexClient, hardFail), repo.layer),
    );
    const error = await Effect.runPromise(Effect.flip(runSync(layer)));
    expect(error).toBeInstanceOf(TcgdexHttpError);
    expect((error as TcgdexHttpError).status).toBe(500);
    expect(repo.series.size).toBe(0);
  });
});
