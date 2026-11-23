import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CardAspectRatio,
  CardCondition,
  CardCopy,
  CardLanguage,
  CardVariant,
  decodeCardCopy,
  deriveHoloEffect,
  HoloEffect,
  MAX_CARD_COPY_QUANTITY,
  ValidationError,
} from "./card.ts";

describe("CardAspectRatio", () => {
  it("equals the official 63 / 88 ratio", () => {
    expect(CardAspectRatio).toBe(63 / 88);
  });
});

describe("literal schemas", () => {
  it("decode valid enum values", () => {
    expect(Schema.decodeUnknownSync(CardLanguage)("FR")).toBe("FR");
    expect(Schema.decodeUnknownSync(CardVariant)("masterball")).toBe("masterball");
    expect(Schema.decodeUnknownSync(CardCondition)("NM")).toBe("NM");
    expect(Schema.decodeUnknownSync(HoloEffect)("tera")).toBe("tera");
  });

  it("reject invalid enum values", () => {
    expect(() => Schema.decodeUnknownSync(CardLanguage)("DE")).toThrow();
    expect(() => Schema.decodeUnknownSync(CardVariant)("shiny")).toThrow();
    expect(() => Schema.decodeUnknownSync(CardCondition)("nm")).toThrow();
    expect(() => Schema.decodeUnknownSync(HoloEffect)(42)).toThrow();
  });
});

describe("CardCopy", () => {
  const valid = {
    cardId: "sv03.5-199",
    language: "FR",
    variant: "holo",
    condition: "NM",
    quantity: 2,
  };

  it("decodes a valid card copy", () => {
    expect(Schema.decodeUnknownSync(CardCopy)(valid)).toEqual(valid);
  });

  it("accepts boundary quantity values", () => {
    expect(Schema.decodeUnknownSync(CardCopy)({ ...valid, quantity: 1 }).quantity).toBe(1);
    expect(
      Schema.decodeUnknownSync(CardCopy)({ ...valid, quantity: MAX_CARD_COPY_QUANTITY }).quantity,
    ).toBe(MAX_CARD_COPY_QUANTITY);
  });

  it("rejects out-of-bounds quantities, non-integers, and blank card ids", () => {
    const decode = Schema.decodeUnknownSync(CardCopy);
    expect(() => decode({ ...valid, quantity: 0 })).toThrow();
    expect(() => decode({ ...valid, quantity: MAX_CARD_COPY_QUANTITY + 1 })).toThrow();
    expect(() => decode({ ...valid, quantity: 1.5 })).toThrow();
    expect(() => decode({ ...valid, cardId: "" })).toThrow();
    expect(() => decode({ ...valid, cardId: "   " })).toThrow();
    expect(() => decode({ ...valid, cardId: "sv03.5 199" })).toThrow();
    expect(() => decode({ ...valid, language: "XX" })).toThrow();
    expect(() => decode({ cardId: "x" })).toThrow();
  });

  it("decodeCardCopy succeeds on valid input", async () => {
    await expect(Effect.runPromise(decodeCardCopy(valid))).resolves.toEqual(valid);
  });

  it("decodeCardCopy fails with typed ValidationError carrying cause", async () => {
    const error = await Effect.runPromise(Effect.flip(decodeCardCopy({ ...valid, quantity: -1 })));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error._tag).toBe("ValidationError");
    expect(error.cause).toBeDefined();
  });
});

describe("deriveHoloEffect", () => {
  it("maps real TCGdex FR rarities including accents", () => {
    expect(deriveHoloEffect({ rarity: "Illustration spéciale rare" })).toBe("sir");
    expect(deriveHoloEffect({ rarity: "Méga Hyper Rare" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Hyper rare" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Couronne" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Double rare" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Dresseur Full Art" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Chromatique ultra rare" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "HIGH-TECH rare" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "LÉGENDE" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Illustration rare" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Radieux Rare" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Magnifique" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Commune" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "Peu Commune" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "Sans Rareté" })).toBe("none");
  });

  it("maps real TCGdex EN rarities", () => {
    expect(deriveHoloEffect({ rarity: "Special illustration rare" })).toBe("sir");
    expect(deriveHoloEffect({ rarity: "Mega Hyper Rare" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Secret Rare" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "UR" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Ultra Rare" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Holo Rare V" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Holo Rare VMAX" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Holo Rare VSTAR" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Rare Holo LV.X" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Full Art Trainer" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "ACE SPEC Rare" })).toBe("ex");
    expect(deriveHoloEffect({ rarity: "Holo Rare" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Rare Holo" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Shiny rare" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Common" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "Unknown Future Rarity" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "" })).toBe("none");
  });

  it("is case-, accent-, and whitespace-insensitive", () => {
    expect(deriveHoloEffect({ rarity: "  ILLUSTRATION   SPÉCIALE RARE " })).toBe("sir");
    expect(deriveHoloEffect({ rarity: "HYPER   RARE" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Téra Rare" })).toBe("tera");
  });

  it("prioritizes the explicit isTera flag over rarity and variant", () => {
    expect(deriveHoloEffect({ rarity: "Double rare", isTera: true })).toBe("tera");
    expect(deriveHoloEffect({ rarity: "Illustration spéciale rare", isTera: true })).toBe("tera");
    expect(deriveHoloEffect({ rarity: "Common", variant: "reverse", isTera: true })).toBe("tera");
  });

  it("applies variant on non-premium rarities including Holo and Rare", () => {
    expect(deriveHoloEffect({ rarity: "Common", variant: "reverse" })).toBe("reverse");
    expect(deriveHoloEffect({ rarity: "Common", variant: "pokeball" })).toBe("reverse");
    expect(deriveHoloEffect({ rarity: "Common", variant: "masterball" })).toBe("reverse");
    expect(deriveHoloEffect({ rarity: "Common", variant: "holo" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Common", variant: "normal" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "Common", variant: "promo" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "Rare" })).toBe("none");
    expect(deriveHoloEffect({ rarity: "Rare", variant: "holo" })).toBe("holo");
    expect(deriveHoloEffect({ rarity: "Rare", variant: "reverse" })).toBe("reverse");
    expect(deriveHoloEffect({ rarity: "Holo Rare", variant: "reverse" })).toBe("reverse");
  });

  it("keeps premium rarities above variant overrides", () => {
    expect(deriveHoloEffect({ rarity: "Illustration spéciale rare", variant: "reverse" })).toBe(
      "sir",
    );
    expect(deriveHoloEffect({ rarity: "Hyper rare", variant: "holo" })).toBe("gold");
    expect(deriveHoloEffect({ rarity: "Double rare", variant: "reverse" })).toBe("ex");
  });
});
