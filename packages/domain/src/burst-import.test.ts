import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertQuantityWithinLimit,
  type BurstCardMeta,
  BurstImportBatchInput,
  BurstImportCardNotFoundError,
  BurstImportDefaults,
  BurstImportEmptyBatchError,
  BurstImportItemInput,
  BurstImportQuantityOverflowError,
  buildBurstImportReport,
  burstSlotKey,
  consolidateBurstItems,
  decodeBurstImportBatchInput,
  MAX_BURST_BATCH_ITEMS,
  resolveBurstCardVariant,
  resolveBurstItem,
} from "./burst-import.ts";
import { type CardId, MAX_CARD_COPY_QUANTITY, ValidationError } from "./card.ts";

const card = (overrides: Partial<BurstCardMeta> = {}): BurstCardMeta => ({
  cardId: "sv08-238" as CardId,
  setId: "sv08",
  availableVariants: ["holo"],
  holoEffect: "sir",
  ...overrides,
});

const item = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(BurstImportItemInput)({ cardId: "sv08-238", quantity: 1, ...overrides });

const defaults = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(BurstImportDefaults)(overrides);

describe("BurstImportDefaults", () => {
  it("decodes {} into the full default set (FR / normal / NM / removeFromWishlist)", () => {
    expect(Schema.decodeUnknownSync(BurstImportDefaults)({})).toEqual({
      language: "FR",
      variant: "normal",
      condition: "NM",
      removeFromWishlist: true,
    });
  });

  it("keeps an explicit setId and rejects invalid enum values", () => {
    expect(Schema.decodeUnknownSync(BurstImportDefaults)({ setId: "sv08" }).setId).toBe("sv08");
    expect(() => Schema.decodeUnknownSync(BurstImportDefaults)({ language: "DE" })).toThrow();
    expect(() => Schema.decodeUnknownSync(BurstImportDefaults)({ variant: "shiny" })).toThrow();
    expect(() => Schema.decodeUnknownSync(BurstImportDefaults)({ condition: "nm" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BurstImportDefaults)({ removeFromWishlist: "yes" }),
    ).toThrow();
  });
});

describe("BurstImportItemInput", () => {
  it("accepts a minimal line and boundary quantities", () => {
    expect(
      Schema.decodeUnknownSync(BurstImportItemInput)({ cardId: "sv08-238", quantity: 1 }),
    ).toEqual({
      cardId: "sv08-238",
      quantity: 1,
    });
    expect(
      Schema.decodeUnknownSync(BurstImportItemInput)({
        cardId: "x",
        quantity: MAX_CARD_COPY_QUANTITY,
      }).quantity,
    ).toBe(MAX_CARD_COPY_QUANTITY);
  });

  it("rejects out-of-range quantities, blank ids and bad optionals", () => {
    const decode = Schema.decodeUnknownSync(BurstImportItemInput);
    expect(() => decode({ cardId: "sv08-238", quantity: 0 })).toThrow();
    expect(() => decode({ cardId: "sv08-238", quantity: MAX_CARD_COPY_QUANTITY + 1 })).toThrow();
    expect(() => decode({ cardId: "sv08-238", quantity: 2.5 })).toThrow();
    expect(() => decode({ cardId: "", quantity: 1 })).toThrow();
    expect(() => decode({ cardId: "a b", quantity: 1 })).toThrow();
    expect(() => decode({ cardId: "sv08-238", quantity: 1, variant: "shiny" })).toThrow();
    expect(() => decode({ cardId: "sv08-238", quantity: 1, variantExplicit: "yes" })).toThrow();
  });
});

describe("BurstImportBatchInput", () => {
  it("decodes a batch and applies defaults to each line", () => {
    const batch = Schema.decodeUnknownSync(BurstImportBatchInput)({
      defaults: {},
      items: [{ cardId: "sv08-238", quantity: 2 }],
    });
    expect(batch.defaults).toEqual({
      language: "FR",
      variant: "normal",
      condition: "NM",
      removeFromWishlist: true,
    });
    expect(batch.items).toHaveLength(1);
  });

  it("rejects an empty batch and a batch larger than MAX_BURST_BATCH_ITEMS", () => {
    const decode = Schema.decodeUnknownSync(BurstImportBatchInput);
    expect(() => decode({ defaults: {}, items: [] })).toThrow();
    expect(() =>
      decode({
        defaults: {},
        items: Array.from({ length: MAX_BURST_BATCH_ITEMS + 1 }, () => ({
          cardId: "sv08-238",
          quantity: 1,
        })),
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(BurstImportBatchInput)({
        defaults: {},
        items: Array.from({ length: MAX_BURST_BATCH_ITEMS }, () => ({
          cardId: "sv08-238",
          quantity: 1,
        })),
      }).items,
    ).toHaveLength(MAX_BURST_BATCH_ITEMS);
  });

  it("decodeBurstImportBatchInput fails with a typed ValidationError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(decodeBurstImportBatchInput({ defaults: {}, items: [] })),
    );
    expect(error).toBeInstanceOf(ValidationError);
    const ok = await Effect.runPromise(
      decodeBurstImportBatchInput({
        defaults: { language: "EN" },
        items: [{ cardId: "sv08-238", quantity: 3 }],
      }),
    );
    expect(ok.defaults.language).toBe("EN");
    expect(ok.items[0]?.quantity).toBe(3);
  });
});

describe("resolveBurstCardVariant", () => {
  it("keeps the requested variant when it is really available", () => {
    expect(
      resolveBurstCardVariant({
        requestedVariant: "normal",
        variantExplicit: false,
        availableVariants: ["normal", "reverse", "holo"],
        holoEffect: "none",
      }),
    ).toEqual({ variant: "normal", adjusted: false });
    expect(
      resolveBurstCardVariant({
        requestedVariant: "holo",
        variantExplicit: true,
        availableVariants: ["holo"],
        holoEffect: "holo",
      }),
    ).toEqual({ variant: "holo", adjusted: false });
  });

  it("adjusts normal → holo for holo-only cards (EX / SIR / AR / UR / Gold / Rare SV)", () => {
    for (const holoEffect of ["sir", "ex", "tera", "gold", "holo"] as const) {
      expect(
        resolveBurstCardVariant({
          requestedVariant: "normal",
          variantExplicit: false,
          availableVariants: ["holo"],
          holoEffect,
        }),
      ).toEqual({ variant: "holo", adjusted: true });
    }
  });

  it("prefers holo, then promo, then reverse, then the first listed variant", () => {
    const resolve = (
      availableVariants: Array<"normal" | "reverse" | "holo" | "promo" | "pokeball" | "masterball">,
    ) =>
      resolveBurstCardVariant({
        requestedVariant: "normal",
        variantExplicit: false,
        availableVariants,
        holoEffect: "none",
      });
    expect(resolve(["reverse", "holo"])).toEqual({ variant: "holo", adjusted: true });
    expect(resolve(["reverse", "promo"])).toEqual({ variant: "promo", adjusted: true });
    expect(resolve(["reverse"])).toEqual({ variant: "reverse", adjusted: true });
    expect(resolve(["pokeball", "masterball"])).toEqual({ variant: "pokeball", adjusted: true });
  });

  it("always respects an explicit variant override (pokeball / masterball / promo)", () => {
    expect(
      resolveBurstCardVariant({
        requestedVariant: "pokeball",
        variantExplicit: true,
        availableVariants: ["normal"],
        holoEffect: "none",
      }),
    ).toEqual({ variant: "pokeball", adjusted: false });
    expect(
      resolveBurstCardVariant({
        requestedVariant: "masterball",
        variantExplicit: true,
        availableVariants: [],
        holoEffect: "sir",
      }),
    ).toEqual({ variant: "masterball", adjusted: false });
  });

  it("adjusts normal → holo when availableVariants is empty but holoEffect is premium", () => {
    expect(
      resolveBurstCardVariant({
        requestedVariant: "normal",
        variantExplicit: false,
        availableVariants: [],
        holoEffect: "sir",
      }),
    ).toEqual({ variant: "holo", adjusted: true });
  });

  it("keeps the requested variant when nothing better is known", () => {
    expect(
      resolveBurstCardVariant({
        requestedVariant: "normal",
        variantExplicit: false,
        availableVariants: [],
        holoEffect: "none",
      }),
    ).toEqual({ variant: "normal", adjusted: false });
    expect(
      resolveBurstCardVariant({
        requestedVariant: "reverse",
        variantExplicit: false,
        availableVariants: [],
        holoEffect: "sir",
      }),
    ).toEqual({ variant: "reverse", adjusted: false });
    expect(
      resolveBurstCardVariant({
        requestedVariant: "holo",
        variantExplicit: false,
        availableVariants: [],
        holoEffect: "ex",
      }),
    ).toEqual({ variant: "holo", adjusted: false });
  });
});

describe("resolveBurstItem", () => {
  it("applies batch defaults and resolves the variant", () => {
    const resolved = resolveBurstItem(
      item({ quantity: 3 }),
      defaults({ language: "EN", variant: "normal", condition: "LP" }),
      card({ availableVariants: ["holo"], holoEffect: "sir" }),
    );
    expect(resolved).toEqual({
      cardId: "sv08-238",
      language: "EN",
      variant: "holo",
      condition: "LP",
      quantity: 3,
      variantAdjusted: true,
    });
  });

  it("per-line language / variant / condition override the defaults", () => {
    const resolved = resolveBurstItem(
      item({ language: "JP", variant: "reverse", condition: "M", variantExplicit: true }),
      defaults({}),
      card({ availableVariants: ["normal", "reverse"], holoEffect: "none" }),
    );
    expect(resolved.language).toBe("JP");
    expect(resolved.variant).toBe("reverse");
    expect(resolved.condition).toBe("M");
    expect(resolved.variantAdjusted).toBe(false);
  });
});

describe("consolidateBurstItems", () => {
  const line = (overrides: Record<string, unknown> = {}) => ({
    cardId: "sv08-238" as CardId,
    language: "FR" as const,
    variant: "holo" as const,
    condition: "NM" as const,
    quantity: 1,
    ...overrides,
  });

  it("merges duplicated lines of the same slot and keeps first-occurrence order", async () => {
    const consolidated = await Effect.runPromise(
      consolidateBurstItems([
        line({ quantity: 2 }),
        line({ cardId: "sv03.5-006" as CardId, variant: "normal" as const, quantity: 5 }),
        line({ quantity: 3, condition: "LP" as const }),
        line({ quantity: 4 }),
      ]),
    );
    expect(consolidated).toEqual([
      line({ quantity: 6 }),
      line({ cardId: "sv03.5-006" as CardId, variant: "normal" as const, quantity: 5 }),
      line({ quantity: 3, condition: "LP" as const }),
    ]);
  });

  it("does not merge different variants / languages / conditions of the same card", async () => {
    const consolidated = await Effect.runPromise(
      consolidateBurstItems([
        line({ quantity: 1 }),
        line({ variant: "normal" as const, quantity: 2 }),
        line({ language: "EN" as const, quantity: 3 }),
      ]),
    );
    expect(consolidated).toHaveLength(3);
  });

  it("fails with BurstImportEmptyBatchError on an empty batch", async () => {
    const error = await Effect.runPromise(Effect.flip(consolidateBurstItems([])));
    expect(error).toBeInstanceOf(BurstImportEmptyBatchError);
  });

  it("fails with BurstImportQuantityOverflowError when a merged slot exceeds the cap", async () => {
    const error = await Effect.runPromise(
      Effect.flip(consolidateBurstItems([line({ quantity: 600 }), line({ quantity: 400 })])),
    );
    expect(error).toBeInstanceOf(BurstImportQuantityOverflowError);
    if (error instanceof BurstImportQuantityOverflowError) {
      expect(error.cardId).toBe("sv08-238");
      expect(error.requestedDelta).toBe(1000);
      expect(error.currentQuantity).toBe(0);
      expect(error.maxQuantity).toBe(MAX_CARD_COPY_QUANTITY);
    }
  });

  it("takes already-owned quantities into account (current + delta ≤ 999)", async () => {
    const key = burstSlotKey(line());
    const ok = await Effect.runPromise(
      consolidateBurstItems([line({ quantity: 1 })], new Map([[key, MAX_CARD_COPY_QUANTITY - 1]])),
    );
    expect(ok[0]?.quantity).toBe(1);
    const error = await Effect.runPromise(
      Effect.flip(
        consolidateBurstItems(
          [line({ quantity: 2 })],
          new Map([[key, MAX_CARD_COPY_QUANTITY - 1]]),
        ),
      ),
    );
    expect(error).toBeInstanceOf(BurstImportQuantityOverflowError);
    if (error instanceof BurstImportQuantityOverflowError) {
      expect(error.currentQuantity).toBe(MAX_CARD_COPY_QUANTITY - 1);
      expect(error.requestedDelta).toBe(2);
    }
  });
});

describe("assertQuantityWithinLimit", () => {
  it("passes at the boundary and fails above it", async () => {
    await Effect.runPromise(assertQuantityWithinLimit("c", 0, MAX_CARD_COPY_QUANTITY));
    const error = await Effect.runPromise(
      Effect.flip(assertQuantityWithinLimit("c", 1, MAX_CARD_COPY_QUANTITY)),
    );
    expect(error).toBeInstanceOf(BurstImportQuantityOverflowError);
  });
});

describe("buildBurstImportReport", () => {
  const outcome = (overrides: Record<string, unknown> = {}) => ({
    line: {
      cardId: "sv08-238" as CardId,
      language: "FR" as const,
      variant: "holo" as const,
      condition: "NM" as const,
      quantity: 2,
      variantAdjusted: true,
    },
    previousQuantity: 0,
    wasNewCard: true,
    removedFromWishlist: true,
    ...overrides,
  });

  it("aggregates totals, distinct/new/duplicate cards, wishlist and adjustments", () => {
    const report = buildBurstImportReport([
      outcome(),
      outcome({
        line: {
          cardId: "sv08-238" as CardId,
          language: "FR" as const,
          variant: "normal" as const,
          condition: "NM" as const,
          quantity: 1,
          variantAdjusted: false,
        },
        wasNewCard: true,
        removedFromWishlist: true,
      }),
      outcome({
        line: {
          cardId: "sv03.5-006" as CardId,
          language: "FR" as const,
          variant: "normal" as const,
          condition: "NM" as const,
          quantity: 4,
          variantAdjusted: false,
        },
        previousQuantity: 7,
        wasNewCard: false,
        removedFromWishlist: false,
      }),
    ]);
    expect(report.totalAddedQuantity).toBe(7);
    expect(report.distinctCardsCount).toBe(2);
    expect(report.newCardsCount).toBe(1);
    expect(report.duplicateCardsCount).toBe(1);
    expect(report.wishlistRemovedCount).toBe(1);
    expect(report.adjustedVariantsCount).toBe(1);
    expect(report.items[0]).toMatchObject({
      cardId: "sv08-238",
      resolvedVariant: "holo",
      variantAdjusted: true,
      addedQuantity: 2,
      newTotalQuantity: 2,
      wasNewCard: true,
      removedFromWishlist: true,
    });
    expect(report.items[2]).toMatchObject({
      cardId: "sv03.5-006",
      addedQuantity: 4,
      newTotalQuantity: 11,
      wasNewCard: false,
    });
  });

  it("counts a card already owned in another variant as a duplicate, not as new", () => {
    const report = buildBurstImportReport([
      outcome({
        line: {
          cardId: "sv03.5-025" as CardId,
          language: "FR" as const,
          variant: "holo" as const,
          condition: "NM" as const,
          quantity: 1,
          variantAdjusted: true,
        },
        wasNewCard: false,
        removedFromWishlist: false,
      }),
    ]);
    expect(report.newCardsCount).toBe(0);
    expect(report.duplicateCardsCount).toBe(1);
    expect(report.wishlistRemovedCount).toBe(0);
  });
});

describe("burstSlotKey", () => {
  it("distinguishes slots", () => {
    expect(
      burstSlotKey({ cardId: "a" as CardId, language: "FR", variant: "holo", condition: "NM" }),
    ).toBe("a FR holo NM");
    expect(
      burstSlotKey({ cardId: "a" as CardId, language: "EN", variant: "holo", condition: "NM" }),
    ).not.toBe(
      burstSlotKey({ cardId: "a" as CardId, language: "FR", variant: "holo", condition: "NM" }),
    );
  });
});

describe("typed errors", () => {
  it("carry their tag and payload", () => {
    const notFound = new BurstImportCardNotFoundError({ missingCardIds: ["x", "y"] });
    expect(notFound._tag).toBe("BurstImportCardNotFoundError");
    expect(notFound.missingCardIds).toEqual(["x", "y"]);
    const empty = new BurstImportEmptyBatchError({});
    expect(empty._tag).toBe("BurstImportEmptyBatchError");
    expect(new ValidationError({ message: "boom" })._tag).toBe("ValidationError");
  });
});
