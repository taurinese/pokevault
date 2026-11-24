import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AddWishlistItemInput,
  decodeAddWishlistItemInput,
  decodeMarkWishlistAcquiredInput,
  decodeUpdateWishlistItemInput,
  MAX_CARD_COPY_QUANTITY,
  MarkWishlistAcquiredInput,
  MarkWishlistAcquiredResult,
  UpdateWishlistItemInput,
  ValidationError,
  WishlistItem,
  WishlistItemConflictError,
  WishlistItemNotFoundError,
  WishlistPriority,
  WishlistQuantityOverflowError,
  wishlistQuantityOverflow,
  wishlistSlotKey,
} from "./index.ts";

const USER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ITEM = "cccccccc-0000-4000-8000-000000000001";
const COPY = "dddddddd-0000-4000-8000-000000000001";
const NOW = "2026-01-01T10:00:00.000Z";

const validItem = {
  id: ITEM,
  userId: USER,
  cardId: "sv08-001",
  language: "FR",
  variant: "normal",
  minCondition: "NM",
  priority: "normal",
  targetPriceCents: null,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const validCopy = {
  id: COPY,
  userId: USER,
  cardId: "sv08-001",
  language: "FR",
  variant: "normal",
  condition: "NM",
  quantity: 1,
  purchasePriceCents: null,
  gradingCompany: null,
  gradingScore: null,
  notes: null,
  acquiredAt: "2026-01-01",
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const is = (schema: Schema.Codec<unknown, unknown>, value: unknown): boolean =>
  Schema.decodeUnknownExit(schema)(value)._tag === "Success";

const flip = <A>(effect: Effect.Effect<A, ValidationError>) =>
  Effect.runPromise(Effect.flip(effect));

describe("WishlistPriority", () => {
  it("n'accepte que normal | high", () => {
    expect(is(WishlistPriority, "normal")).toBe(true);
    expect(is(WishlistPriority, "high")).toBe(true);
    expect(is(WishlistPriority, "urgent")).toBe(false);
    expect(is(WishlistPriority, "")).toBe(false);
  });
});

describe("WishlistItem", () => {
  it("accepte une ligne valide (prix cible nul ou >= 0)", () => {
    expect(is(WishlistItem, validItem)).toBe(true);
    expect(is(WishlistItem, { ...validItem, targetPriceCents: 0 })).toBe(true);
    expect(is(WishlistItem, { ...validItem, targetPriceCents: 1250, priority: "high" })).toBe(true);
  });

  it("refuse les valeurs hors CHECK SQL", () => {
    expect(is(WishlistItem, { ...validItem, targetPriceCents: -1 })).toBe(false);
    expect(is(WishlistItem, { ...validItem, targetPriceCents: 1.5 })).toBe(false);
    expect(is(WishlistItem, { ...validItem, language: "DE" })).toBe(false);
    expect(is(WishlistItem, { ...validItem, variant: "shiny" })).toBe(false);
    expect(is(WishlistItem, { ...validItem, minCondition: "MINT" })).toBe(false);
    expect(is(WishlistItem, { ...validItem, priority: "urgent" })).toBe(false);
    expect(is(WishlistItem, { ...validItem, id: "not-a-uuid" })).toBe(false);
    expect(is(WishlistItem, { ...validItem, cardId: "has space" })).toBe(false);
  });
});

describe("AddWishlistItemInput", () => {
  it("n'exige que la carte (le reste a des défauts SQL)", () => {
    expect(is(AddWishlistItemInput, { cardId: "sv08-001" })).toBe(true);
    expect(
      is(AddWishlistItemInput, {
        cardId: "sv08-001",
        language: "JP",
        variant: "masterball",
        minCondition: "PO",
        priority: "high",
        targetPriceCents: 0,
        ifExists: "return",
      }),
    ).toBe(true);
    expect(is(AddWishlistItemInput, { cardId: "sv08-001", targetPriceCents: null })).toBe(true);
  });

  it("refuse carte absente / vide / à espaces et valeurs invalides", async () => {
    expect(is(AddWishlistItemInput, {})).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "" })).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "a b" })).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "x", language: "XX" })).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "x", priority: "low" })).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "x", targetPriceCents: -5 })).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "x", targetPriceCents: 2.5 })).toBe(false);
    expect(is(AddWishlistItemInput, { cardId: "x", ifExists: "upsert" })).toBe(false);
    const error = await flip(decodeAddWishlistItemInput({ cardId: "x", variant: "nope" }));
    expect(error).toBeInstanceOf(ValidationError);
  });

  it("decodeAddWishlistItemInput renvoie l'entrée décodée", async () => {
    const decoded = await Effect.runPromise(
      decodeAddWishlistItemInput({ cardId: "sv08-001", priority: "high" }),
    );
    expect(decoded).toEqual({ cardId: "sv08-001", priority: "high" });
  });
});

describe("UpdateWishlistItemInput", () => {
  it("exige au moins un champ", async () => {
    expect(is(UpdateWishlistItemInput, {})).toBe(false);
    const error = await flip(decodeUpdateWishlistItemInput({}));
    expect(error._tag).toBe("ValidationError");
    expect(error.message).toContain("at least one of");
  });

  it("accepte chaque champ seul, dont targetPriceCents: null (retire le seuil)", () => {
    for (const patch of [
      { language: "EN" },
      { variant: "holo" },
      { minCondition: "LP" },
      { priority: "high" },
      { targetPriceCents: 0 },
      { targetPriceCents: null },
    ]) {
      expect(is(UpdateWishlistItemInput, patch)).toBe(true);
    }
  });

  it("refuse valeurs invalides et ne permet pas de changer la carte (clé inconnue ignorée => vide)", async () => {
    expect(is(UpdateWishlistItemInput, { priority: "low" })).toBe(false);
    expect(is(UpdateWishlistItemInput, { targetPriceCents: -1 })).toBe(false);
    expect(is(UpdateWishlistItemInput, { minCondition: "X" })).toBe(false);
    // `cardId` n'est pas un champ du patch : il est ignoré, donc le patch reste « vide ».
    const error = await flip(decodeUpdateWishlistItemInput({ cardId: "other" }));
    expect(error._tag).toBe("ValidationError");
  });
});

describe("MarkWishlistAcquiredInput", () => {
  it("n'exige que l'identifiant du souhait", async () => {
    const decoded = await Effect.runPromise(
      decodeMarkWishlistAcquiredInput({ wishlistItemId: ITEM }),
    );
    expect(decoded).toEqual({ wishlistItemId: ITEM });
    expect(is(MarkWishlistAcquiredInput, { wishlistItemId: ITEM })).toBe(true);
  });

  it("accepte état, quantité 1..999, prix d'achat >= 0 et notes", () => {
    expect(
      is(MarkWishlistAcquiredInput, {
        wishlistItemId: ITEM,
        condition: "EX",
        quantity: MAX_CARD_COPY_QUANTITY,
        purchasePriceCents: 0,
        notes: "Trouvée en brocante",
      }),
    ).toBe(true);
    expect(is(MarkWishlistAcquiredInput, { wishlistItemId: ITEM, quantity: 1 })).toBe(true);
    expect(
      is(MarkWishlistAcquiredInput, {
        wishlistItemId: ITEM,
        purchasePriceCents: null,
        notes: null,
      }),
    ).toBe(true);
  });

  it("refuse quantité hors bornes, non entière, prix négatif, notes trop longues, id invalide", async () => {
    for (const quantity of [0, -1, 1000, 1.5, Number.NaN]) {
      expect(is(MarkWishlistAcquiredInput, { wishlistItemId: ITEM, quantity })).toBe(false);
    }
    expect(is(MarkWishlistAcquiredInput, { wishlistItemId: ITEM, purchasePriceCents: -1 })).toBe(
      false,
    );
    expect(is(MarkWishlistAcquiredInput, { wishlistItemId: ITEM, notes: "x".repeat(1001) })).toBe(
      false,
    );
    expect(is(MarkWishlistAcquiredInput, { wishlistItemId: ITEM, condition: "MINT" })).toBe(false);
    expect(is(MarkWishlistAcquiredInput, { wishlistItemId: "nope" })).toBe(false);
    expect(is(MarkWishlistAcquiredInput, {})).toBe(false);
    const error = await flip(
      decodeMarkWishlistAcquiredInput({ wishlistItemId: ITEM, quantity: 0 }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe("MarkWishlistAcquiredResult", () => {
  it("embarque l'exemplaire et l'id du classeur d'extension (ou null)", () => {
    const result = { removedWishlistItemId: ITEM, copy: validCopy, setBinderId: COPY };
    expect(is(MarkWishlistAcquiredResult, result)).toBe(true);
    expect(is(MarkWishlistAcquiredResult, { ...result, setBinderId: null })).toBe(true);
    expect(is(MarkWishlistAcquiredResult, { ...result, setBinderId: "x" })).toBe(false);
    expect(is(MarkWishlistAcquiredResult, { ...result, copy: { ...validCopy, quantity: 0 } })).toBe(
      false,
    );
  });
});

describe("erreurs typées & helpers", () => {
  it("portent un _tag stable et leurs champs", () => {
    expect(new WishlistItemNotFoundError({ itemId: ITEM, message: "x" })._tag).toBe(
      "WishlistItemNotFoundError",
    );
    const conflict = new WishlistItemConflictError({ message: "x", cardId: "sv08-001" });
    expect(conflict._tag).toBe("WishlistItemConflictError");
    expect(conflict.cardId).toBe("sv08-001");
    const overflow = wishlistQuantityOverflow({
      cardId: "sv08-001",
      currentQuantity: 998,
      requestedDelta: 2,
    });
    expect(overflow).toBeInstanceOf(WishlistQuantityOverflowError);
    expect(overflow).toMatchObject({
      _tag: "WishlistQuantityOverflowError",
      currentQuantity: 998,
      requestedDelta: 2,
      maxQuantity: MAX_CARD_COPY_QUANTITY,
    });
    expect(overflow.message).toContain("998 + 2");
  });

  it("wishlistSlotKey reproduit UNIQUE (card_id, language, variant)", () => {
    const a = wishlistSlotKey({ cardId: "sv08-001", language: "FR", variant: "normal" });
    expect(a).toBe(wishlistSlotKey({ cardId: "sv08-001", language: "FR", variant: "normal" }));
    expect(a).not.toBe(wishlistSlotKey({ cardId: "sv08-001", language: "EN", variant: "normal" }));
    expect(a).not.toBe(wishlistSlotKey({ cardId: "sv08-001", language: "FR", variant: "holo" }));
    expect(a).not.toBe(wishlistSlotKey({ cardId: "sv08-002", language: "FR", variant: "normal" }));
  });
});
