import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildCardmarketCsvFilename,
  CARD_CONDITION_ORDER,
  CARDMARKET_CSV_HEADERS,
  CARDMARKET_LANGUAGE_NAMES,
  CardmarketExportEntry,
  CardmarketExportFilters,
  cardConditionRank,
  cardmarketEntryName,
  cardmarketEntrySetCode,
  collectCardmarketWarnings,
  escapeCsvField,
  filterCardmarketEntries,
  generateCardmarketAddCardList,
  generateCardmarketCsv,
  isFoilVariant,
  sanitizeCsvCell,
} from "./cardmarket.ts";
import * as domain from "./index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEntry = (overrides: Partial<CardmarketExportEntry> = {}): CardmarketExportEntry => ({
  cardId: "sv03.5-199",
  localId: "199",
  nameFr: "Dracaufeu-ex",
  nameEn: "Charizard ex",
  setId: "sv03.5",
  setCode: "MEW",
  cardmarketSetCode: "MEW",
  setNameFr: "Évolutions Célestes",
  language: "EN",
  variant: "normal",
  minCondition: "NM",
  priority: "normal",
  targetPriceCents: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Constants & schemas
// ---------------------------------------------------------------------------

describe("CARDMARKET_CSV_HEADERS", () => {
  it("matches docs/04 §2.2 column order", () => {
    expect(CARDMARKET_CSV_HEADERS).toEqual([
      "qty",
      "name",
      "set_code",
      "number",
      "language",
      "min_condition",
      "foil_only",
    ]);
  });
});

describe("CARDMARKET_LANGUAGE_NAMES", () => {
  it("maps every CardLanguage to its Cardmarket name", () => {
    expect(CARDMARKET_LANGUAGE_NAMES).toEqual({
      FR: "French",
      EN: "English",
      JP: "Japanese",
      ZH: "S-Chinese",
    });
  });
});

describe("CardmarketExportEntry schema", () => {
  it("decodes a valid entry and applies no defaults by itself", () => {
    const entry = makeEntry();
    expect(Schema.decodeUnknownSync(CardmarketExportEntry)(entry)).toEqual(entry);
  });

  it("accepts optional currentPriceCents / quantity", () => {
    const entry = makeEntry({ currentPriceCents: 4200, quantity: 3 });
    const decoded = Schema.decodeUnknownSync(CardmarketExportEntry)(entry);
    expect(decoded.currentPriceCents).toBe(4200);
    expect(decoded.quantity).toBe(3);
  });

  it("rejects invalid quantity, language, variant and condition", () => {
    const decode = Schema.decodeUnknownSync(CardmarketExportEntry);
    expect(() => decode(makeEntry({ quantity: 0 }))).toThrow();
    expect(() => decode(makeEntry({ quantity: 1.5 }))).toThrow();
    expect(() => decode(makeEntry({ language: "DE" as never }))).toThrow();
    expect(() => decode(makeEntry({ variant: "shiny" as never }))).toThrow();
    expect(() => decode(makeEntry({ minCondition: "nm" as never }))).toThrow();
  });
});

describe("CardmarketExportFilters schema", () => {
  it("decodes an empty filter object and a full one", () => {
    expect(Schema.decodeUnknownSync(CardmarketExportFilters)({})).toEqual({});
    expect(
      Schema.decodeUnknownSync(CardmarketExportFilters)({
        scope: "below_threshold",
        setId: "sv03.5",
        minCondition: "EX",
        minConditionOverride: "NM",
        language: "ALL",
        foilOnly: true,
      }),
    ).toEqual({
      scope: "below_threshold",
      setId: "sv03.5",
      minCondition: "EX",
      minConditionOverride: "NM",
      language: "ALL",
      foilOnly: true,
    });
  });

  it("rejects unknown scopes and languages", () => {
    const decode = Schema.decodeUnknownSync(CardmarketExportFilters);
    expect(() => decode({ scope: "wishlist" as never })).toThrow();
    expect(() => decode({ language: "DE" as never })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isFoilVariant", () => {
  it("returns false only for the normal variant", () => {
    expect(isFoilVariant("normal")).toBe(false);
    for (const variant of ["reverse", "holo", "promo", "pokeball", "masterball"] as const) {
      expect(isFoilVariant(variant)).toBe(true);
    }
  });
});

describe("cardConditionRank / CARD_CONDITION_ORDER", () => {
  it("orders conditions from best (M) to worst (PO)", () => {
    expect(CARD_CONDITION_ORDER).toEqual(["M", "NM", "EX", "GD", "LP", "PL", "PO"]);
    expect(cardConditionRank("M")).toBeLessThan(cardConditionRank("NM"));
    expect(cardConditionRank("NM")).toBeLessThan(cardConditionRank("PO"));
  });
});

describe("cardmarketEntryName / cardmarketEntrySetCode", () => {
  it("prefers the English name and falls back to the French name", () => {
    expect(cardmarketEntryName(makeEntry())).toBe("Charizard ex");
    expect(cardmarketEntryName(makeEntry({ nameEn: null }))).toBe("Dracaufeu-ex");
  });

  it("prefers cardmarketSetCode, then setCode, then setId", () => {
    expect(cardmarketEntrySetCode(makeEntry())).toBe("MEW");
    expect(cardmarketEntrySetCode(makeEntry({ cardmarketSetCode: null }))).toBe("MEW");
    expect(cardmarketEntrySetCode(makeEntry({ cardmarketSetCode: null, setCode: "EV3.5" }))).toBe(
      "EV3.5",
    );
    expect(cardmarketEntrySetCode(makeEntry({ cardmarketSetCode: null, setCode: null }))).toBe(
      "sv03.5",
    );
  });
});

// ---------------------------------------------------------------------------
// CSV escaping (RFC 4180 + formula injection)
// ---------------------------------------------------------------------------

describe("escapeCsvField / sanitizeCsvCell", () => {
  it("leaves plain values untouched (incl. accents and positive numbers)", () => {
    expect(escapeCsvField("Pikachu")).toBe("Pikachu");
    expect(escapeCsvField("Évoli")).toBe("Évoli");
    expect(escapeCsvField("Dracaufeu-ex")).toBe("Dracaufeu-ex");
    expect(escapeCsvField("1")).toBe("1");
    expect(escapeCsvField("199")).toBe("199");
  });

  it("quotes fields containing a comma", () => {
    expect(escapeCsvField("Pikachu, promo")).toBe('"Pikachu, promo"');
  });

  it("doubles inner quotes (RFC 4180)", () => {
    expect(escapeCsvField('M. Mime "Ex"')).toBe('"M. Mime ""Ex"""');
  });

  it("quotes fields containing \\n or \\r\\n", () => {
    expect(escapeCsvField("a\nb")).toBe('"a\nb"');
    expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("neutralizes formula-injection prefixes with an apostrophe", () => {
    expect(sanitizeCsvCell("=CMD()")).toBe("'=CMD()");
    expect(sanitizeCsvCell("+1")).toBe("'+1");
    expect(sanitizeCsvCell("-1")).toBe("'-1");
    expect(sanitizeCsvCell("@SUM")).toBe("'@SUM");
    expect(sanitizeCsvCell("\t=1")).toBe("'\t=1");
    expect(escapeCsvField("=CMD()")).toBe("'=CMD()");
    expect(escapeCsvField("+1")).toBe("'+1");
    expect(escapeCsvField("@SUM")).toBe("'@SUM");
  });

  it("preserves positive numbers while neutralizing dangerous ones", () => {
    expect(escapeCsvField("42")).toBe("42");
    expect(escapeCsvField("-42")).toBe("'-42");
  });

  it("combines formula neutralization and RFC 4180 quoting", () => {
    // leading '=' → apostrophe prefix, then comma → quoted
    expect(escapeCsvField("=SUM(A1),x")).toBe('"\'=SUM(A1),x"');
    // leading \r → apostrophe prefix, then \r forces quoting
    expect(escapeCsvField("\r=1")).toBe('"\'\r=1"');
  });
});

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

describe("buildCardmarketCsvFilename", () => {
  it("builds wants-cardmarket-YYYY-MM-DD.csv in UTC", () => {
    expect(buildCardmarketCsvFilename(new Date(Date.UTC(2025, 0, 5)))).toBe(
      "wants-cardmarket-2025-01-05.csv",
    );
    // 23:30 UTC on Dec 31 must stay Dec 31 regardless of the local timezone
    expect(buildCardmarketCsvFilename(new Date(Date.UTC(2025, 11, 31, 23, 30)))).toBe(
      "wants-cardmarket-2025-12-31.csv",
    );
    expect(buildCardmarketCsvFilename(new Date(Date.UTC(2026, 6, 4, 12, 0)))).toBe(
      "wants-cardmarket-2026-07-04.csv",
    );
  });
});

// ---------------------------------------------------------------------------
// filterCardmarketEntries
// ---------------------------------------------------------------------------

describe("filterCardmarketEntries", () => {
  const entries: CardmarketExportEntry[] = [
    makeEntry({
      cardId: "a-1",
      localId: "1",
      priority: "high",
      targetPriceCents: 5000,
      currentPriceCents: 4000,
    }),
    makeEntry({
      cardId: "a-2",
      localId: "2",
      priority: "normal",
      targetPriceCents: 5000,
      currentPriceCents: 6000,
    }),
    makeEntry({
      cardId: "a-3",
      localId: "3",
      priority: "normal",
      targetPriceCents: 5000,
      currentPriceCents: 5000,
    }),
    makeEntry({
      cardId: "a-4",
      localId: "4",
      priority: "normal",
      targetPriceCents: null,
      currentPriceCents: 100,
    }),
    makeEntry({
      cardId: "a-5",
      localId: "5",
      priority: "normal",
      targetPriceCents: 5000,
      currentPriceCents: null,
    }),
    makeEntry({
      cardId: "b-1",
      localId: "6",
      setId: "sv01",
      setCode: "SVI",
      cardmarketSetCode: "SVI",
      setNameFr: "Maskabri",
      language: "FR",
      variant: "holo",
      minCondition: "EX",
    }),
  ];

  it("returns everything (sorted) with no filters", () => {
    const result = filterCardmarketEntries(entries);
    // set_code "MEW" < "SVI", then numeric localId 1..5
    expect(result.map((e) => e.cardId)).toEqual(["a-1", "a-2", "a-3", "a-4", "a-5", "b-1"]);
  });

  it("scope=below_threshold keeps only entries with target & current price, current <= target", () => {
    const result = filterCardmarketEntries(entries, { scope: "below_threshold" });
    expect(result.map((e) => e.cardId).sort()).toEqual(["a-1", "a-3"]);
  });

  it("scope=high_priority keeps only priority=high", () => {
    const result = filterCardmarketEntries(entries, { scope: "high_priority" });
    expect(result.map((e) => e.cardId)).toEqual(["a-1"]);
  });

  it("scope=set filters on setId, and behaves like all without setId", () => {
    const result = filterCardmarketEntries(entries, { scope: "set", setId: "sv01" });
    expect(result.map((e) => e.cardId)).toEqual(["b-1"]);
    expect(filterCardmarketEntries(entries, { scope: "set" }).length).toBe(entries.length);
  });

  it("language filter keeps a single language, ALL keeps everything", () => {
    expect(filterCardmarketEntries(entries, { language: "FR" }).map((e) => e.cardId)).toEqual([
      "b-1",
    ]);
    expect(filterCardmarketEntries(entries, { language: "ALL" }).length).toBe(entries.length);
  });

  it("minCondition filters entries whose own condition is at least as good", () => {
    const withConditions = [
      makeEntry({ cardId: "c-m", minCondition: "M" }),
      makeEntry({ cardId: "c-nm", minCondition: "NM" }),
      makeEntry({ cardId: "c-ex", minCondition: "EX" }),
      makeEntry({ cardId: "c-gd", minCondition: "GD" }),
      makeEntry({ cardId: "c-po", minCondition: "PO" }),
    ];
    const result = filterCardmarketEntries(withConditions, { minCondition: "EX" });
    expect(result.map((e) => e.cardId).sort()).toEqual(["c-ex", "c-m", "c-nm"]);
  });

  it("foilOnly keeps only foil variants", () => {
    const withVariants = [
      makeEntry({ cardId: "v-normal", variant: "normal" }),
      makeEntry({ cardId: "v-holo", variant: "holo" }),
      makeEntry({ cardId: "v-promo", variant: "promo" }),
    ];
    const result = filterCardmarketEntries(withVariants, { foilOnly: true });
    expect(result.map((e) => e.cardId).sort()).toEqual(["v-holo", "v-promo"]);
    expect(filterCardmarketEntries(withVariants, { foilOnly: false }).length).toBe(3);
  });

  it("combines filters and returns an empty array for an empty input", () => {
    const result = filterCardmarketEntries(entries, {
      scope: "below_threshold",
      language: "EN",
      foilOnly: false,
    });
    expect(result.map((e) => e.cardId).sort()).toEqual(["a-1", "a-3"]);
    expect(filterCardmarketEntries([], { scope: "all" })).toEqual([]);
  });

  it("sorts deterministically: set_code, numeric localId, language, variant", () => {
    const unsorted = [
      makeEntry({ cardId: "x-10", localId: "10" }),
      makeEntry({ cardId: "x-9", localId: "9" }),
      makeEntry({ cardId: "x-sv10", localId: "SV10" }),
      makeEntry({ cardId: "x-sv2", localId: "SV02" }),
      makeEntry({ cardId: "x-en-holo", localId: "1", language: "EN", variant: "holo" }),
      makeEntry({ cardId: "x-fr-normal", localId: "1", language: "FR", variant: "normal" }),
      makeEntry({
        cardId: "y-1",
        localId: "1",
        setId: "zzz",
        setCode: "ZZZ",
        cardmarketSetCode: "ZZZ",
      }),
    ];
    const result = filterCardmarketEntries(unsorted);
    expect(result.map((e) => e.cardId)).toEqual([
      "x-en-holo", // localId "1" (numeric 1), EN < FR on language tiebreak
      "x-fr-normal", // localId "1", FR
      "x-sv2", // localId numeric 2
      "x-9", // 9
      "x-10", // 10, tie with SV10 broken by string compare ("10" < "SV10")
      "x-sv10", // 10
      "y-1", // set_code "ZZZ" sorts after "MEW"
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [
      makeEntry({ cardId: "z-2", localId: "2" }),
      makeEntry({ cardId: "z-1", localId: "1" }),
    ];
    filterCardmarketEntries(input);
    expect(input.map((e) => e.cardId)).toEqual(["z-2", "z-1"]);
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe("collectCardmarketWarnings", () => {
  it("aggregates missing_cardmarket_code per set without duplicating it", () => {
    const warnings = collectCardmarketWarnings([
      makeEntry({ cardId: "w-1", cardmarketSetCode: null, setCode: "EV3.5" }),
      makeEntry({ cardId: "w-2", cardmarketSetCode: null, setCode: "EV3.5" }),
      makeEntry({ cardId: "w-3", setId: "xy99", setCode: null, cardmarketSetCode: null }),
      makeEntry({ cardId: "w-4", cardmarketSetCode: "MEW" }),
    ]);
    expect(warnings).toEqual([
      {
        kind: "missing_cardmarket_code",
        setId: "sv03.5",
        setNameFr: "Évolutions Célestes",
        fallbackCode: "EV3.5",
        count: 2,
      },
      {
        kind: "missing_cardmarket_code",
        setId: "xy99",
        setNameFr: "Évolutions Célestes",
        fallbackCode: "xy99",
        count: 1,
      },
    ]);
  });

  it("emits one missing_english_name per card without nameEn", () => {
    const warnings = collectCardmarketWarnings([
      makeEntry({ cardId: "n-1", nameEn: null }),
      makeEntry({ cardId: "n-1", nameEn: null, localId: "200" }),
      makeEntry({ cardId: "n-2", nameEn: "Pikachu" }),
    ]);
    expect(warnings).toEqual([
      { kind: "missing_english_name", cardId: "n-1", nameFr: "Dracaufeu-ex" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// generateCardmarketCsv
// ---------------------------------------------------------------------------

describe("generateCardmarketCsv", () => {
  it("always emits the header line with CRLF endings", () => {
    const result = generateCardmarketCsv([]);
    expect(result.content).toBe("qty,name,set_code,number,language,min_condition,foil_only\r\n");
    expect(result.rowCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.filename).toMatch(/^wants-cardmarket-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("builds one RFC 4180 row per entry with CRLF and a final CRLF", () => {
    const result = generateCardmarketCsv([
      makeEntry({ quantity: 2 }),
      makeEntry({
        cardId: "sv01-12",
        localId: "12",
        nameEn: "Pikachu",
        nameFr: "Pikachu",
        setId: "sv01",
        setCode: "SVI",
        cardmarketSetCode: "SVI",
        setNameFr: "Maskabri",
        language: "FR",
        variant: "holo",
        minCondition: "EX",
      }),
    ]);
    expect(result.content).toBe(
      "qty,name,set_code,number,language,min_condition,foil_only\r\n" +
        "2,Charizard ex,MEW,199,EN,NM,false\r\n" +
        "1,Pikachu,SVI,12,FR,EX,true\r\n",
    );
    expect(result.rowCount).toBe(2);
    // no parasite empty line: the content ends with exactly one CRLF
    expect(result.content.endsWith("\r\n")).toBe(true);
    expect(result.content.endsWith("\r\n\r\n")).toBe(false);
    expect(result.content.split("\r\n")).toEqual([
      "qty,name,set_code,number,language,min_condition,foil_only",
      "2,Charizard ex,MEW,199,EN,NM,false",
      "1,Pikachu,SVI,12,FR,EX,true",
      "",
    ]);
  });

  it("defaults qty to 1 and uses nameEn ?? nameFr, cardmarketSetCode ?? setCode ?? setId", () => {
    const result = generateCardmarketCsv([
      makeEntry({ cardId: "f-1", nameEn: null, cardmarketSetCode: null, setCode: "EV3.5" }),
      makeEntry({
        cardId: "f-2",
        nameEn: null,
        cardmarketSetCode: null,
        setCode: null,
        setId: "xy99",
      }),
    ]);
    const lines = result.content.split("\r\n");
    expect(lines[1]).toBe("1,Dracaufeu-ex,EV3.5,199,EN,NM,false");
    expect(lines[2]).toBe("1,Dracaufeu-ex,xy99,199,EN,NM,false");
    expect(result.warnings).toEqual([
      {
        kind: "missing_cardmarket_code",
        setId: "sv03.5",
        setNameFr: "Évolutions Célestes",
        fallbackCode: "EV3.5",
        count: 1,
      },
      {
        kind: "missing_cardmarket_code",
        setId: "xy99",
        setNameFr: "Évolutions Célestes",
        fallbackCode: "xy99",
        count: 1,
      },
      { kind: "missing_english_name", cardId: "f-1", nameFr: "Dracaufeu-ex" },
      { kind: "missing_english_name", cardId: "f-2", nameFr: "Dracaufeu-ex" },
    ]);
  });

  it("escapes dangerous names inside generated rows", () => {
    const result = generateCardmarketCsv([
      makeEntry({ cardId: "e-1", nameEn: "Pikachu, promo" }),
      makeEntry({ cardId: "e-2", nameEn: 'M. Mime "Ex"' }),
      makeEntry({ cardId: "e-3", nameEn: "=CMD()" }),
    ]);
    const lines = result.content.split("\r\n");
    // rows are sorted by name: "=CMD()" < 'M. Mime "Ex"' < "Pikachu, promo"
    expect(lines[1]).toBe("1,'=CMD(),MEW,199,EN,NM,false");
    expect(lines[2]).toBe('1,"M. Mime ""Ex""",MEW,199,EN,NM,false');
    expect(lines[3]).toBe('1,"Pikachu, promo",MEW,199,EN,NM,false');
  });

  it("applies filters and minConditionOverride to the exported rows", () => {
    const result = generateCardmarketCsv(
      [
        makeEntry({ cardId: "o-1", priority: "high", minCondition: "PO", variant: "normal" }),
        makeEntry({ cardId: "o-2", priority: "normal", minCondition: "M", variant: "reverse" }),
      ],
      { scope: "high_priority", minConditionOverride: "NM", foilOnly: false },
    );
    const lines = result.content.split("\r\n");
    expect(result.rowCount).toBe(1);
    expect(lines[1]).toBe("1,Charizard ex,MEW,199,EN,NM,false");
  });

  it("writes foil_only=true for foil variants only", () => {
    const result = generateCardmarketCsv([
      makeEntry({ cardId: "v-1", variant: "normal" }),
      makeEntry({ cardId: "v-2", variant: "masterball" }),
    ]);
    const lines = result.content.split("\r\n");
    expect(lines[1]?.endsWith(",false")).toBe(true);
    expect(lines[2]?.endsWith(",true")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateCardmarketAddCardList
// ---------------------------------------------------------------------------

describe("generateCardmarketAddCardList", () => {
  it("emits `1 Charizard ex (MEW 199)` style lines with a trailing newline", () => {
    const result = generateCardmarketAddCardList([makeEntry()]);
    expect(result.content).toBe("1 Charizard ex (MEW 199)\n");
    expect(result.lineCount).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("uses the entry quantity and falls back to nameFr / setCode / localId only", () => {
    const result = generateCardmarketAddCardList([
      makeEntry({ cardId: "l-1", quantity: 3, nameEn: null }),
      makeEntry({ cardId: "l-2", cardmarketSetCode: null, setCode: "EV3.5" }),
      makeEntry({ cardId: "l-3", cardmarketSetCode: null, setCode: null, setId: "xy99" }),
    ]);
    // sorted by exported set_code: "EV3.5" < "MEW" < "xy99"
    expect(result.content).toBe(
      "1 Charizard ex (EV3.5 199)\n" + "3 Dracaufeu-ex (MEW 199)\n" + "1 Charizard ex (199)\n",
    );
    expect(result.lineCount).toBe(3);
    expect(result.warnings).toContainEqual({
      kind: "missing_cardmarket_code",
      setId: "sv03.5",
      setNameFr: "Évolutions Célestes",
      fallbackCode: "EV3.5",
      count: 1,
    });
    expect(result.warnings).toContainEqual({
      kind: "missing_cardmarket_code",
      setId: "xy99",
      setNameFr: "Évolutions Célestes",
      fallbackCode: "xy99",
      count: 1,
    });
    expect(result.warnings).toContainEqual({
      kind: "missing_english_name",
      cardId: "l-1",
      nameFr: "Dracaufeu-ex",
    });
  });

  it("aggregates entries producing the exact same line by summing quantities", () => {
    const result = generateCardmarketAddCardList([
      makeEntry({ cardId: "d-1", quantity: 1, language: "FR" }),
      makeEntry({ cardId: "d-2", quantity: 2, language: "EN" }), // same card line (name/code/number identical)
      makeEntry({ cardId: "d-3", localId: "200", nameEn: "Pikachu", quantity: 1 }),
    ]);
    // d-1 and d-2 merge (qty 3); d-3 has a different number → distinct line
    expect(result.content).toBe("3 Charizard ex (MEW 199)\n1 Pikachu (MEW 200)\n");
    expect(result.lineCount).toBe(2);
  });

  it("neutralizes \\r and \\n inside names so one card stays on one line", () => {
    const result = generateCardmarketAddCardList([
      makeEntry({ cardId: "nl-1", nameEn: "Foo\nBar\r\nBaz" }),
    ]);
    expect(result.content).toBe("1 Foo Bar Baz (MEW 199)\n");
    expect(result.lineCount).toBe(1);
    // no CR anywhere, and exactly one LF (the line terminator)
    expect(result.content.includes("\r")).toBe(false);
    expect(result.content.split("\n")).toEqual(["1 Foo Bar Baz (MEW 199)", ""]);
  });

  it("applies filters and sorts deterministically", () => {
    const result = generateCardmarketAddCardList(
      [
        makeEntry({ cardId: "s-2", localId: "10", priority: "high" }),
        makeEntry({ cardId: "s-1", localId: "9", priority: "high" }),
        makeEntry({ cardId: "s-3", localId: "1", priority: "normal" }),
      ],
      { scope: "high_priority" },
    );
    expect(result.content).toBe("1 Charizard ex (MEW 9)\n1 Charizard ex (MEW 10)\n");
    expect(result.lineCount).toBe(2);
  });

  it("returns an empty content for an empty (or fully filtered out) input", () => {
    expect(generateCardmarketAddCardList([])).toEqual({ content: "", lineCount: 0, warnings: [] });
    const filtered = generateCardmarketAddCardList([makeEntry()], { scope: "high_priority" });
    expect(filtered.content).toBe("");
    expect(filtered.lineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// index barrel export
// ---------------------------------------------------------------------------

describe("domain index", () => {
  it("re-exports the cardmarket module", () => {
    expect(typeof domain.generateCardmarketCsv).toBe("function");
    expect(typeof domain.generateCardmarketAddCardList).toBe("function");
    expect(domain.CARDMARKET_CSV_HEADERS).toEqual(CARDMARKET_CSV_HEADERS);
  });
});
