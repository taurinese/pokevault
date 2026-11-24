import { Effect, Layer, Logger, References } from "effect";
import { describe, expect, it } from "vitest";
import { makeCatalogRepositoryMemory } from "./catalog-repo.ts";
import {
  type CatalogSyncOptions,
  cardDetailToRow,
  dedupeCards,
  formatSyncError,
  seriesToRow,
  setDetailToRow,
  TcgdexSyncService,
  TcgdexSyncServiceLive,
} from "./catalog-sync.ts";
import { DatabaseError } from "./db.ts";
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
  /** Extra FR sets (listed in `listSets`), served with their card details. */
  readonly extraSets?: ReadonlyArray<TcgdexSetDetail> | undefined;
  readonly extraCards?: ReadonlyArray<TcgdexCardDetail> | undefined;
  readonly extraSeries?: ReadonlyArray<TcgdexSeriesSummary> | undefined;
}

const makeFakeClient = (options: FakeOptions = {}) => {
  const calls: Array<string> = [];
  const extraSets = options.extraSets ?? [];
  const setsFr: Record<string, TcgdexSetDetail> = {
    "sv03.5": SET_SV035_FR,
    sv08: SET_SV08_FR,
    ...Object.fromEntries(extraSets.map((set) => [set.id, set] as const)),
  };
  const setSummaries: ReadonlyArray<TcgdexSetSummary> = [
    ...SETS_FR,
    ...extraSets.map((set) => ({ id: set.id, name: set.name })),
  ];
  const setsEn: Record<string, TcgdexSetDetail> = { "sv03.5": SET_SV035_EN };
  const cards: Record<string, TcgdexCardDetail> = {
    "sv03.5-001": CARD_SV035_001,
    "sv03.5-199": CARD_SV035_199,
    "sv08-189": CARD_SV08_189,
    ...Object.fromEntries((options.extraCards ?? []).map((card) => [card.id, card] as const)),
  };
  const shape: TcgdexClientShape = {
    listSeries: (lang) => {
      calls.push(`series:${lang}`);
      return Effect.succeed(
        lang === "fr" ? [...SERIES_FR, ...(options.extraSeries ?? [])] : SERIES_EN,
      );
    },
    listSets: (lang) => {
      calls.push(`sets:${lang}`);
      return Effect.succeed(setSummaries);
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

interface CapturedLog {
  readonly message: string;
  readonly annotations: Record<string, unknown>;
}

const makeLogCapture = () => {
  const entries: Array<CapturedLog> = [];
  const logger = Logger.make<unknown, void>((options) => {
    const message = Array.isArray(options.message) ? options.message[0] : options.message;
    entries.push({
      message: String(message),
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  return { entries, layer: Logger.layer([logger], { mergeWithExisting: false }) };
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
    // Commune with normal + reverse prints: the base card is NOT reverse (the reverse
    // effect depends on the owned copy variant, not on the catalogue card).
    expect(basic.holo_effect).toBe("none");
    expect(basic.local_id_numeric).toBe(1);
    expect(basic.image_base_url).toBe("https://assets.tcgdex.net/fr/sv/sv03.5/001");
  });
});

describe("holo_effect of the base card (B1)", () => {
  const card = (rarity: string, variants: NonNullable<TcgdexCardDetail["variants"]>) =>
    cardDetailToRow(
      { id: "sv99-010", localId: "010", name: "Test", rarity, variants, set: { id: "sv99" } },
      "sv99",
      null,
      null,
    );

  it("does not flag a Commune with normal + reverse prints as reverse", () => {
    expect(card("Commune", { normal: true, reverse: true }).holo_effect).toBe("none");
    expect(card("Peu Commune", { normal: true, reverse: true, holo: false }).holo_effect).toBe(
      "none",
    );
  });

  it("uses the holo variant when the card has no normal print (SV Rare)", () => {
    const rare = card("Rare", { normal: false, reverse: false, holo: true });
    expect(rare.holo_effect).toBe("holo");
    expect(rare.available_variants).toEqual(["holo"]);
    expect(card("Rare", { normal: false, reverse: true, holo: true }).holo_effect).toBe("holo");
  });

  it("falls back to the reverse variant only for reverse-only cards", () => {
    expect(card("Commune", { normal: false, reverse: true }).holo_effect).toBe("reverse");
  });

  it("keeps premium rarities regardless of the variants", () => {
    expect(card("Illustration spéciale rare", { normal: true, reverse: true }).holo_effect).toBe(
      "sir",
    );
  });
});

describe("formatSyncError (B4)", () => {
  it("keeps status, url, retryable and cause of an HTTP error", () => {
    const fields = formatSyncError(
      new TcgdexHttpError({
        url: "https://api.tcgdex.net/v2/fr/sets/sv08",
        status: 503,
        retryable: true,
        body: "busy",
        cause: new Error("socket hang up"),
      }),
    );
    expect(fields).toMatchObject({
      errorTag: "TcgdexHttpError",
      status: 503,
      url: "https://api.tcgdex.net/v2/fr/sets/sv08",
      retryable: true,
      body: "busy",
      cause: "Error: socket hang up",
    });
    expect(String(fields["message"])).toContain("503");
  });

  it("keeps url and cause of a decode error and message + cause of a database error", () => {
    expect(
      formatSyncError(new TcgdexDecodeError({ url: "fr/cards/x", cause: new Error("bad json") })),
    ).toMatchObject({ errorTag: "TcgdexDecodeError", url: "fr/cards/x", cause: "Error: bad json" });
    const pg = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(
      formatSyncError(new DatabaseError({ message: "postgres query failed", cause: pg })),
    ).toMatchObject({
      errorTag: "DatabaseError",
      message: "postgres query failed",
      cause: "Error: duplicate key (code=23505)",
    });
  });
});

describe("dedupeCards (B2)", () => {
  const base = cardDetailToRow(CARD_SV035_001, "sv03.5", null, null);
  it("drops duplicate ids first, then duplicate (set_id, local_id), keeping the first", () => {
    const sameId = { ...base, name_fr: "Doublon id" };
    const sameLocal = { ...base, id: "sv03.5-001b", name_fr: "Doublon local_id" };
    const other = { ...base, id: "sv03.5-002", local_id: "002" };
    const result = dedupeCards([base, sameId, sameLocal, other]);
    expect(result.rows.map((row) => row.id)).toEqual(["sv03.5-001", "sv03.5-002"]);
    expect(result.duplicates.map((duplicate) => [duplicate.reason, duplicate.keptId])).toEqual([
      ["duplicate_id", "sv03.5-001"],
      ["duplicate_set_local_id", "sv03.5-001"],
    ]);
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

  it("never crashes a set on duplicate card ids / (set_id, local_id) and logs each ignored duplicate", async () => {
    const dirtySet: TcgdexSetDetail = {
      id: "sv99",
      name: "Set sale",
      releaseDate: "2025-01-01",
      cardCount: { official: 3, total: 3 },
      serie: { id: "sv" },
      cards: [
        { id: "sv99-001", localId: "001", name: "A" },
        { id: "sv99-001", localId: "001", name: "A bis" }, // duplicate id
        { id: "sv99-001x", localId: "001", name: "A ter" }, // duplicate (set_id, local_id)
        { id: "sv99-002", localId: "002", name: "B" },
      ],
    };
    const card = (id: string, localId: string): TcgdexCardDetail => ({
      id,
      localId,
      name: id,
      category: "Pokémon",
      rarity: "Commune",
      variants: { normal: true },
      set: { id: "sv99" },
    });
    const { repo, layer } = makeTestLayer({
      extraSets: [dirtySet],
      extraCards: [card("sv99-001", "001"), card("sv99-001x", "001"), card("sv99-002", "002")],
    });
    const capture = makeLogCapture();
    const report = await Effect.runPromise(
      runSync(layer, { setIds: ["sv99"] }).pipe(Effect.provide(capture.layer)),
    );
    expect(report.failedSets).toEqual([]);
    expect(report.setsCount).toBe(1);
    expect(report.cardsCount).toBe(2);
    expect([...repo.cards.keys()].sort()).toEqual(["sv99-001", "sv99-002"]);
    const warnings = capture.entries.filter(
      (entry) => entry.message === "catalog.sync.card_duplicate_ignored",
    );
    expect(warnings.map((entry) => entry.annotations["reason"])).toEqual([
      "duplicate_id",
      "duplicate_set_local_id",
    ]);
    expect(warnings.map((entry) => entry.annotations["keptCardId"])).toEqual([
      "sv99-001",
      "sv99-001",
    ]);
  });

  it("discards an invalid row (hp: 0) without failing the set and counts it in failedCards", async () => {
    const dirtySet: TcgdexSetDetail = {
      id: "sv98",
      name: "Set hp zéro",
      cardCount: { official: 2, total: 2 },
      serie: { id: "sv" },
      cards: [
        { id: "sv98-001", localId: "001", name: "Valide" },
        { id: "sv98-002", localId: "002", name: "HP zéro" },
      ],
    };
    const card = (id: string, localId: string, hp: number): TcgdexCardDetail => ({
      id,
      localId,
      name: id,
      category: "Pokémon",
      hp,
      variants: { normal: true },
      set: { id: "sv98" },
    });
    const { repo, layer } = makeTestLayer({
      extraSets: [dirtySet],
      extraCards: [card("sv98-001", "001", 60), card("sv98-002", "002", 0)],
    });
    const capture = makeLogCapture();
    const report = await Effect.runPromise(
      runSync(layer, { setIds: ["sv98"] }).pipe(Effect.provide(capture.layer)),
    );
    expect(report.failedSets).toEqual([]);
    expect(report.setsCount).toBe(1);
    expect(report.cardsCount).toBe(1);
    expect(report.failedCards).toBe(1);
    expect([...repo.cards.keys()]).toEqual(["sv98-001"]);
    const invalid = capture.entries.find((entry) => entry.message === "catalog.sync.card_invalid");
    expect(invalid?.annotations).toMatchObject({
      setId: "sv98",
      cardId: "sv98-002",
      errorTag: "ValidationError",
    });
  });

  it("reports failedCards for cards that could not be fetched", async () => {
    const { layer } = makeTestLayer({ failCardFr: ["sv03.5-199"] });
    const report = await Effect.runPromise(runSync(layer));
    expect(report.failedCards).toBe(1);
  });

  it("marks a set whose row fails domain validation as failed and keeps the others", async () => {
    const badSet: TcgdexSetDetail = {
      id: "sv97",
      name: "Date invalide",
      releaseDate: "22/09/2023", // not a SQL date
      serie: { id: "sv" },
      cards: [],
    };
    const { repo, layer } = makeTestLayer({ extraSets: [badSet] });
    const report = await Effect.runPromise(runSync(layer));
    expect(report.failedSets).toEqual(["sv97"]);
    expect(report.setsCount).toBe(2);
    expect(repo.sets.has("sv97")).toBe(false);
    expect(repo.sets.has("sv03.5")).toBe(true);
  });

  it("logs structured error fields (tag, status, url) for a failed set", async () => {
    const { layer } = makeTestLayer({ failSetFr: ["sv08"] });
    const capture = makeLogCapture();
    await Effect.runPromise(runSync(layer).pipe(Effect.provide(capture.layer)));
    const failed = capture.entries.find((entry) => entry.message === "catalog.sync.set_failed");
    expect(failed?.annotations).toMatchObject({
      setId: "sv08",
      errorTag: "TcgdexHttpError",
      status: 500,
      url: "fr/sets/sv08",
    });
  });

  it("excludes the TCG Pocket series (tcgp) by default and honours excludedSeriesIds", async () => {
    const pocketSet: TcgdexSetDetail = {
      id: "A1",
      name: "Puissance génétique",
      cardCount: { official: 1, total: 1 },
      serie: { id: "tcgp" },
      cards: [{ id: "A1-001", localId: "001", name: "Bulbizarre Pocket" }],
    };
    const pocketCard: TcgdexCardDetail = {
      id: "A1-001",
      localId: "001",
      name: "Bulbizarre Pocket",
      set: { id: "A1" },
    };
    const options = {
      extraSets: [pocketSet],
      extraCards: [pocketCard],
      extraSeries: [{ id: "tcgp", name: "Pocket" }],
    } satisfies FakeOptions;

    const excluded = makeTestLayer(options);
    const report = await Effect.runPromise(runSync(excluded.layer));
    expect([...excluded.repo.series.keys()]).toEqual(["sv"]);
    expect(excluded.repo.sets.has("A1")).toBe(false);
    expect(excluded.repo.cards.has("A1-001")).toBe(false);
    expect(report.seriesCount).toBe(1);
    expect(report.setsCount).toBe(2);
    expect(report.failedSets).toEqual([]);

    const included = makeTestLayer(options);
    const all = await Effect.runPromise(runSync(included.layer, { excludedSeriesIds: [] }));
    expect([...included.repo.series.keys()].sort()).toEqual(["sv", "tcgp"]);
    expect(included.repo.sets.has("A1")).toBe(true);
    expect(included.repo.cards.has("A1-001")).toBe(true);
    expect(all.setsCount).toBe(3);
  });
});
