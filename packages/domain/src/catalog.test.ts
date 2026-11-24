import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CARD_VARIANT_ORDER,
  CatalogCard,
  CatalogCategory,
  CatalogSeries,
  CatalogSet,
  detectIsTera,
  extractAvailableVariants,
  normalizeCatalogCategory,
  normalizeSetCounts,
  parseLocalIdNumeric,
  SqlDate,
} from "./catalog.ts";

describe("CatalogCategory", () => {
  it("decodes the three SQL enum values and rejects anything else", () => {
    expect(Schema.decodeUnknownSync(CatalogCategory)("Pokemon")).toBe("Pokemon");
    expect(Schema.decodeUnknownSync(CatalogCategory)("Trainer")).toBe("Trainer");
    expect(Schema.decodeUnknownSync(CatalogCategory)("Energy")).toBe("Energy");
    expect(() => Schema.decodeUnknownSync(CatalogCategory)("Pokémon")).toThrow();
    expect(() => Schema.decodeUnknownSync(CatalogCategory)("Dresseur")).toThrow();
    expect(() => Schema.decodeUnknownSync(CatalogCategory)("")).toThrow();
  });
});

describe("CatalogSeries / CatalogSet / CatalogCard schemas", () => {
  it("decodes a full series row aligned with catalog_series", () => {
    const row = {
      id: "sv",
      name_fr: "Écarlate et Violet",
      name_en: "Scarlet & Violet",
      release_order: 12,
    };
    expect(Schema.decodeUnknownSync(CatalogSeries)(row)).toEqual(row);
    expect(Schema.decodeUnknownSync(CatalogSeries)({ ...row, name_en: null })).toEqual({
      ...row,
      name_en: null,
    });
  });

  it("decodes a set row and enforces total_count >= official_count", () => {
    const row = {
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
    };
    expect(Schema.decodeUnknownSync(CatalogSet)(row)).toEqual(row);
    expect(() => Schema.decodeUnknownSync(CatalogSet)({ ...row, total_count: 100 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CatalogSet)({ ...row, release_date: "22/09/2023" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(CatalogSet)({ ...row, official_count: -1 })).toThrow();
  });

  it("decodes a card row aligned with catalog_cards", () => {
    const row = {
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
    };
    expect(Schema.decodeUnknownSync(CatalogCard)(row)).toEqual(row);
    expect(() => Schema.decodeUnknownSync(CatalogCard)({ ...row, category: "Pokémon" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CatalogCard)({ ...row, holo_effect: "rainbow" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CatalogCard)({ ...row, available_variants: ["firstEdition"] }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(CatalogCard)({ ...row, hp: 0 })).toThrow();
  });

  it("SqlDate only accepts YYYY-MM-DD", () => {
    expect(Schema.decodeUnknownSync(SqlDate)("2024-11-08")).toBe("2024-11-08");
    expect(() => Schema.decodeUnknownSync(SqlDate)("2024-11-8")).toThrow();
    // Format-only check: calendar validity is enforced by Postgres itself.
    expect(Schema.decodeUnknownSync(SqlDate)("2024-13-01")).toBe("2024-13-01");
    expect(() => Schema.decodeUnknownSync(SqlDate)("08-11-2024")).toThrow();
  });
});

describe("normalizeCatalogCategory", () => {
  it("maps real TCGdex FR and EN categories", () => {
    expect(normalizeCatalogCategory("Pokémon")).toBe("Pokemon");
    expect(normalizeCatalogCategory("Pokemon")).toBe("Pokemon");
    expect(normalizeCatalogCategory("pokemon")).toBe("Pokemon");
    expect(normalizeCatalogCategory("Dresseur")).toBe("Trainer");
    expect(normalizeCatalogCategory("Trainer")).toBe("Trainer");
    expect(normalizeCatalogCategory("trainer")).toBe("Trainer");
    expect(normalizeCatalogCategory("Énergie")).toBe("Energy");
    expect(normalizeCatalogCategory("Energie")).toBe("Energy");
    expect(normalizeCatalogCategory("Energy")).toBe("Energy");
  });

  it("falls back to Pokemon for unknown or missing values (SQL DEFAULT)", () => {
    expect(normalizeCatalogCategory(undefined)).toBe("Pokemon");
    expect(normalizeCatalogCategory("")).toBe("Pokemon");
    expect(normalizeCatalogCategory("Objet")).toBe("Pokemon");
    expect(normalizeCatalogCategory("  POKÉMON  ")).toBe("Pokemon");
  });
});

describe("parseLocalIdNumeric", () => {
  it("parses plain and zero-padded numeric ids", () => {
    expect(parseLocalIdNumeric("199")).toBe(199);
    expect(parseLocalIdNumeric("006")).toBe(6);
    expect(parseLocalIdNumeric("025")).toBe(25);
    expect(parseLocalIdNumeric(" 42 ")).toBe(42);
  });

  it("parses prefixed ids (TG, SV, PR, SWSH...) from their trailing digits", () => {
    expect(parseLocalIdNumeric("TG01")).toBe(1);
    expect(parseLocalIdNumeric("TG30")).toBe(30);
    expect(parseLocalIdNumeric("SV025")).toBe(25);
    expect(parseLocalIdNumeric("swshp-25")).toBe(25);
    expect(parseLocalIdNumeric("PR-01")).toBe(1);
  });

  it("returns null when there is no digit run", () => {
    expect(parseLocalIdNumeric("ABC")).toBeNull();
    expect(parseLocalIdNumeric("")).toBeNull();
    expect(parseLocalIdNumeric("TG")).toBeNull();
  });
});

describe("extractAvailableVariants", () => {
  it("maps the TCGdex variants summary to the SQL variant array", () => {
    expect(
      extractAvailableVariants({
        normal: true,
        reverse: true,
        holo: false,
        firstEdition: false,
        wPromo: false,
      }),
    ).toEqual(["normal", "reverse"]);
    expect(extractAvailableVariants({ holo: true, normal: false, reverse: false })).toEqual([
      "holo",
    ]);
    expect(extractAvailableVariants({ wPromo: true })).toEqual(["promo"]);
    // first-edition printings are NOT promos
    expect(extractAvailableVariants({ firstEdition: true })).toEqual([]);
  });

  it("deduplicates and sorts in canonical order", () => {
    expect(
      extractAvailableVariants({
        normal: true,
        reverse: true,
        holo: true,
        wPromo: true,
        firstEdition: true,
      }),
    ).toEqual(["normal", "reverse", "holo", "promo"]);
    expect(extractAvailableVariants({ normal: true, firstEdition: true })).toEqual(["normal"]);
    expect(CARD_VARIANT_ORDER).toEqual([
      "normal",
      "reverse",
      "holo",
      "promo",
      "pokeball",
      "masterball",
    ]);
  });

  it("returns an empty array for missing or all-false variants", () => {
    expect(extractAvailableVariants(undefined)).toEqual([]);
    expect(extractAvailableVariants({})).toEqual([]);
    expect(extractAvailableVariants({ normal: false, reverse: false, holo: false })).toEqual([]);
  });
});

describe("detectIsTera", () => {
  it("detects Téracristal / Tera from name, stage or description", () => {
    expect(detectIsTera({ name: "Orbe Téracristal" })).toBe(true);
    expect(detectIsTera({ name: "Tera Orb" })).toBe(true);
    expect(detectIsTera({ stage: "TéraCristal" })).toBe(true);
    expect(detectIsTera({ stage: "Terastallized" })).toBe(true);
    expect(detectIsTera({ stage: "Téracristallisé" })).toBe(true);
    expect(detectIsTera({ description: "Pokémon téracristallisé" })).toBe(true);
    expect(detectIsTera({ description: "Pokémon Terastal" })).toBe(true);
    expect(detectIsTera({ description: "Pokémon Téracristal" })).toBe(true);
    expect(detectIsTera({ suffix: "ex", name: "Pikachu ex", stage: "Terastallized" })).toBe(true);
  });

  it("detects Tera from ability / attack effect text", () => {
    expect(detectIsTera({ abilities: [{ type: "Talent", name: "Téra", effect: "..." }] })).toBe(
      true,
    );
    expect(
      detectIsTera({
        attacks: [{ name: "Charge Téra", effect: "Ce Pokémon Téracristal inflige..." }],
      }),
    ).toBe(true);
    expect(detectIsTera({ abilities: [undefined, { effect: "Terastallized Pokémon rule" }] })).toBe(
      true,
    );
  });

  it("does not flag ordinary cards (including Terapagos)", () => {
    expect(detectIsTera({ name: "Terapagos", stage: "Base" })).toBe(false);
    expect(detectIsTera({ name: "Dracaufeu-ex", stage: "Niveau 2", suffix: "ex" })).toBe(false);
    expect(detectIsTera({})).toBe(false);
    expect(
      detectIsTera({ name: "Bulbizarre", abilities: [{ name: "Engrais", effect: "..." }] }),
    ).toBe(false);
  });
});

describe("normalizeSetCounts", () => {
  it("keeps valid counts unchanged", () => {
    expect(normalizeSetCounts(165, 207)).toEqual({ official_count: 165, total_count: 207 });
    expect(normalizeSetCounts(0, 0)).toEqual({ official_count: 0, total_count: 0 });
  });

  it("lifts total_count to official_count so CHECK (total_count >= official_count) never fails", () => {
    expect(normalizeSetCounts(165, 100)).toEqual({ official_count: 165, total_count: 165 });
    expect(normalizeSetCounts(10, -5)).toEqual({ official_count: 10, total_count: 10 });
    expect(normalizeSetCounts(-3, -1)).toEqual({ official_count: 0, total_count: 0 });
  });
});
