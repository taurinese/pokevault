import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CardAspectRatio,
  CardCondition,
  CardLanguage,
  CardValidationError,
  CardVariant,
  decodeOwnedCard,
  deriveHoloEffect,
  HoloEffect,
  OwnedCard,
} from "./card.ts";

describe("CardAspectRatio", () => {
  it("vaut 63 / 88", () => {
    expect(CardAspectRatio).toBe(63 / 88);
  });
});

describe("schémas littéraux", () => {
  it("décodent les valeurs valides", () => {
    expect(Schema.decodeUnknownSync(CardLanguage)("FR")).toBe("FR");
    expect(Schema.decodeUnknownSync(CardVariant)("masterball")).toBe("masterball");
    expect(Schema.decodeUnknownSync(CardCondition)("NM")).toBe("NM");
    expect(Schema.decodeUnknownSync(HoloEffect)("tera")).toBe("tera");
  });

  it("rejettent les valeurs invalides", () => {
    expect(() => Schema.decodeUnknownSync(CardLanguage)("DE")).toThrow();
    expect(() => Schema.decodeUnknownSync(CardVariant)("shiny")).toThrow();
    expect(() => Schema.decodeUnknownSync(CardCondition)("nm")).toThrow();
    expect(() => Schema.decodeUnknownSync(HoloEffect)(42)).toThrow();
  });
});

describe("OwnedCard", () => {
  const valid = {
    cardId: "sv03.5-199",
    language: "FR",
    variant: "holo",
    condition: "NM",
    quantity: 2,
  };

  it("décode une carte valide", () => {
    expect(Schema.decodeUnknownSync(OwnedCard)(valid)).toEqual(valid);
  });

  it("accepte un effet holo optionnel", () => {
    const decoded = Schema.decodeUnknownSync(OwnedCard)({ ...valid, holoEffect: "sir" });
    expect(decoded.holoEffect).toBe("sir");
  });

  it("rejette une quantité nulle, non entière ou un identifiant vide", () => {
    const decode = Schema.decodeUnknownSync(OwnedCard);
    expect(() => decode({ ...valid, quantity: 0 })).toThrow();
    expect(() => decode({ ...valid, quantity: 1.5 })).toThrow();
    expect(() => decode({ ...valid, cardId: "" })).toThrow();
    expect(() => decode({ ...valid, language: "XX" })).toThrow();
    expect(() => decode({ cardId: "x" })).toThrow();
  });

  it("decodeOwnedCard réussit avec une entrée valide", async () => {
    await expect(Effect.runPromise(decodeOwnedCard(valid))).resolves.toEqual(valid);
  });

  it("decodeOwnedCard échoue avec CardValidationError", async () => {
    const error = await Effect.runPromise(Effect.flip(decodeOwnedCard({ ...valid, quantity: -1 })));
    expect(error).toBeInstanceOf(CardValidationError);
    expect(error._tag).toBe("CardValidationError");
  });
});

describe("deriveHoloEffect", () => {
  it("mappe les raretés premium", () => {
    expect(deriveHoloEffect("Gold")).toBe("gold");
    expect(deriveHoloEffect("UR")).toBe("gold");
    expect(deriveHoloEffect("Hyper Rare")).toBe("gold");
    expect(deriveHoloEffect("SIR")).toBe("sir");
    expect(deriveHoloEffect("Special Illustration Rare")).toBe("sir");
    expect(deriveHoloEffect("Double Rare")).toBe("ex");
    expect(deriveHoloEffect("DR")).toBe("ex");
    expect(deriveHoloEffect("Tera Rare")).toBe("tera");
  });

  it("est insensible à la casse et aux espaces", () => {
    expect(deriveHoloEffect("  sir ")).toBe("sir");
    expect(deriveHoloEffect("HYPER   RARE")).toBe("gold");
  });

  it("mappe les raretés holo et communes", () => {
    expect(deriveHoloEffect("Holo")).toBe("holo");
    expect(deriveHoloEffect("Rare Holo")).toBe("holo");
    expect(deriveHoloEffect("Common")).toBe("none");
    expect(deriveHoloEffect("")).toBe("none");
  });

  it("utilise la variante quand la rareté est basique", () => {
    expect(deriveHoloEffect("Common", "reverse")).toBe("reverse");
    expect(deriveHoloEffect("Common", "pokeball")).toBe("reverse");
    expect(deriveHoloEffect("Common", "masterball")).toBe("reverse");
    expect(deriveHoloEffect("Common", "holo")).toBe("holo");
    expect(deriveHoloEffect("Common", "normal")).toBe("none");
    expect(deriveHoloEffect("Common", "promo")).toBe("none");
    expect(deriveHoloEffect("Rare", "reverse")).toBe("reverse");
  });

  it("les raretés premium l'emportent sur la variante", () => {
    expect(deriveHoloEffect("SIR", "reverse")).toBe("sir");
    expect(deriveHoloEffect("Gold", "holo")).toBe("gold");
  });
});
