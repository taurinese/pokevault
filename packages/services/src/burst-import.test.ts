import {
  BurstImportCardNotFoundError,
  BurstImportQuantityOverflowError,
  type CardId,
  MAX_CARD_COPY_QUANTITY,
  ValidationError,
} from "@pokevault/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type BurstImportMemoryState,
  BurstImportService,
  BurstImportServiceMemory,
} from "./burst-import.ts";

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const CARDS: BurstImportMemoryState["cards"] = [
  { cardId: "sv08-238" as CardId, setId: "sv08", availableVariants: ["holo"], holoEffect: "sir" },
  { cardId: "sv08-100" as CardId, setId: "sv08", availableVariants: [], holoEffect: "tera" },
  {
    cardId: "sv03.5-205" as CardId,
    setId: "sv03.5",
    availableVariants: ["holo"],
    holoEffect: "ex",
  },
  {
    cardId: "sv03.5-006" as CardId,
    setId: "sv03.5",
    availableVariants: ["normal", "reverse"],
    holoEffect: "none",
  },
  {
    cardId: "sv03.5-025" as CardId,
    setId: "sv03.5",
    availableVariants: ["normal", "reverse", "holo"],
    holoEffect: "none",
  },
  {
    cardId: "promo-x-001" as CardId,
    setId: "promo-x",
    availableVariants: ["promo"],
    holoEffect: "none",
  },
  {
    cardId: "swsh12-030" as CardId,
    setId: "swsh12",
    availableVariants: ["normal"],
    holoEffect: "none",
  },
];

const makeState = (overrides: Partial<BurstImportMemoryState> = {}): BurstImportMemoryState => ({
  cards: CARDS,
  copies: [],
  wishlist: [],
  ...overrides,
});

const previewE = (state: BurstImportMemoryState, userId: string, input: unknown) =>
  Effect.gen(function* () {
    const service = yield* BurstImportService;
    return yield* service.previewBatch(userId, input);
  }).pipe(Effect.provide(BurstImportServiceMemory(state)));

const commitE = (state: BurstImportMemoryState, userId: string, input: unknown) =>
  Effect.gen(function* () {
    const service = yield* BurstImportService;
    return yield* service.commitBatch(userId, input);
  }).pipe(Effect.provide(BurstImportServiceMemory(state)));

const preview = (state: BurstImportMemoryState, userId: string, input: unknown) =>
  Effect.runPromise(previewE(state, userId, input));
const commit = (state: BurstImportMemoryState, userId: string, input: unknown) =>
  Effect.runPromise(commitE(state, userId, input));

const batch = (defaults: Record<string, unknown>, items: Array<Record<string, unknown>>) => ({
  defaults,
  items,
});

describe("BurstImportServiceMemory — previewBatch", () => {
  it("resolves variants, new vs duplicate cards, and writes nothing", async () => {
    const state = makeState({
      copies: [
        {
          userId: ALICE,
          cardId: "sv03.5-006",
          language: "FR",
          variant: "normal",
          condition: "NM",
          gradingCompany: null,
          gradingScore: null,
          quantity: 2,
        },
      ],
      wishlist: [{ userId: ALICE, cardId: "sv03.5-025" }],
    });
    const report = await preview(
      state,
      ALICE,
      batch(
        {
          setId: "sv03.5",
          language: "FR",
          variant: "normal",
          condition: "NM",
          removeFromWishlist: true,
        },
        [
          { cardId: "sv03.5-006", quantity: 1 },
          { cardId: "sv03.5-025", quantity: 2 },
          { cardId: "sv03.5-205", quantity: 1 },
        ],
      ),
    );
    expect(report.totalAddedQuantity).toBe(4);
    expect(report.distinctCardsCount).toBe(3);
    expect(report.newCardsCount).toBe(2);
    expect(report.duplicateCardsCount).toBe(1);
    expect(report.adjustedVariantsCount).toBe(1);
    expect(report.wishlistRemovedCount).toBe(1);
    const byCard = new Map(report.items.map((item) => [item.cardId, item]));
    expect(byCard.get("sv03.5-006")).toMatchObject({
      resolvedVariant: "normal",
      variantAdjusted: false,
      wasNewCard: false,
      addedQuantity: 1,
      newTotalQuantity: 3,
      removedFromWishlist: false,
    });
    expect(byCard.get("sv03.5-025")).toMatchObject({
      resolvedVariant: "normal",
      variantAdjusted: false,
      wasNewCard: true,
      newTotalQuantity: 2,
      removedFromWishlist: true,
    });
    expect(byCard.get("sv03.5-205")).toMatchObject({
      resolvedVariant: "holo",
      variantAdjusted: true,
      wasNewCard: true,
    });
    // Preview wrote nothing.
    expect(state.copies).toHaveLength(1);
    expect(state.wishlist).toHaveLength(1);
  });

  it("fails with BurstImportCardNotFoundError on unknown cards or wrong setId", async () => {
    const state = makeState();
    const unknown = await Effect.runPromise(
      Effect.flip(previewE(state, ALICE, batch({}, [{ cardId: "nope-1", quantity: 1 }]))),
    );
    expect(unknown).toBeInstanceOf(BurstImportCardNotFoundError);
    if (unknown instanceof BurstImportCardNotFoundError) {
      expect(unknown.missingCardIds).toEqual(["nope-1"]);
    }
    const wrongSet = await Effect.runPromise(
      Effect.flip(
        previewE(state, ALICE, batch({ setId: "sv08" }, [{ cardId: "sv03.5-006", quantity: 1 }])),
      ),
    );
    expect(wrongSet).toBeInstanceOf(BurstImportCardNotFoundError);
  });

  it("rejects an invalid userId or payload with ValidationError", async () => {
    const state = makeState();
    const badUser = await Effect.runPromise(
      Effect.flip(previewE(state, "not-a-uuid", batch({}, [{ cardId: "sv08-238", quantity: 1 }]))),
    );
    expect(badUser).toBeInstanceOf(ValidationError);
    const badBatch = await Effect.runPromise(Effect.flip(previewE(state, ALICE, batch({}, []))));
    expect(badBatch).toBeInstanceOf(ValidationError);
    const badQuantity = await Effect.runPromise(
      Effect.flip(previewE(state, ALICE, batch({}, [{ cardId: "sv08-238", quantity: 0 }]))),
    );
    expect(badQuantity).toBeInstanceOf(ValidationError);
  });
});

describe("BurstImportServiceMemory — commitBatch", () => {
  it("inserts new slots, increments existing ones and consolidates duplicated lines", async () => {
    const state = makeState({
      copies: [
        {
          userId: ALICE,
          cardId: "sv03.5-006",
          language: "FR",
          variant: "normal",
          condition: "NM",
          gradingCompany: null,
          gradingScore: null,
          quantity: 2,
        },
      ],
    });
    const report = await commit(
      state,
      ALICE,
      batch({ language: "FR", variant: "normal", condition: "NM" }, [
        { cardId: "sv03.5-006", quantity: 1 },
        { cardId: "sv03.5-006", quantity: 4 }, // same slot → consolidated to +5
        { cardId: "sv03.5-006", quantity: 1, condition: "LP" }, // different slot
        { cardId: "sv08-238", quantity: 2 }, // SIR → auto holo
        { cardId: "sv08-100", quantity: 1 }, // empty variants + tera → auto holo
      ]),
    );
    expect(report.totalAddedQuantity).toBe(9);
    expect(report.distinctCardsCount).toBe(3);
    expect(report.newCardsCount).toBe(2);
    expect(report.duplicateCardsCount).toBe(1);
    expect(report.adjustedVariantsCount).toBe(2);
    expect(state.copies).toHaveLength(4);
    const normal = state.copies.find(
      (copy) =>
        copy.cardId === "sv03.5-006" && copy.variant === "normal" && copy.condition === "NM",
    );
    expect(normal?.quantity).toBe(7); // 2 + 5 consolidated
    expect(
      state.copies.find((copy) => copy.cardId === "sv03.5-006" && copy.condition === "LP")
        ?.quantity,
    ).toBe(1);
    expect(state.copies.find((copy) => copy.cardId === "sv08-238")?.variant).toBe("holo");
    expect(state.copies.find((copy) => copy.cardId === "sv08-100")?.variant).toBe("holo");
    // Re-committing increments the same slot (ON CONFLICT semantics).
    const again = await commit(
      state,
      ALICE,
      batch({ language: "FR", variant: "normal" }, [{ cardId: "sv03.5-006", quantity: 3 }]),
    );
    expect(state.copies).toHaveLength(4);
    expect(
      state.copies.find(
        (copy) =>
          copy.cardId === "sv03.5-006" && copy.variant === "normal" && copy.condition === "NM",
      )?.quantity,
    ).toBe(10);
    expect(again.items[0]).toMatchObject({
      addedQuantity: 3,
      newTotalQuantity: 10,
      wasNewCard: false,
    });
  });

  it("respects an explicit variant override (pokeball) even when not listed by TCGdex", async () => {
    const state = makeState();
    const report = await commit(
      state,
      ALICE,
      batch({ variant: "normal" }, [
        { cardId: "swsh12-030", quantity: 1, variant: "pokeball", variantExplicit: true },
      ]),
    );
    expect(report.items[0]).toMatchObject({ resolvedVariant: "pokeball", variantAdjusted: false });
    expect(state.copies[0]?.variant).toBe("pokeball");
  });

  it("auto-adjusts normal → holo for holo-only / premium-effect cards", async () => {
    const state = makeState();
    const report = await commit(
      state,
      ALICE,
      batch({ variant: "normal" }, [
        { cardId: "sv08-238", quantity: 1 }, // available [holo] → holo
        { cardId: "promo-x-001", quantity: 1 }, // available [promo] → promo (not normal)
        { cardId: "sv03.5-006", quantity: 1 }, // available [normal, reverse] → normal kept
      ]),
    );
    const byCard = new Map(report.items.map((item) => [item.cardId, item]));
    expect(byCard.get("sv08-238")).toMatchObject({
      resolvedVariant: "holo",
      variantAdjusted: true,
    });
    expect(byCard.get("promo-x-001")).toMatchObject({
      resolvedVariant: "promo",
      variantAdjusted: true,
    });
    expect(byCard.get("sv03.5-006")).toMatchObject({
      resolvedVariant: "normal",
      variantAdjusted: false,
    });
  });

  it("removes only matching (card, language, resolvedVariant) wishlist entries and preserves other languages/variants", async () => {
    const state = makeState({
      wishlist: [
        { userId: ALICE, cardId: "sv08-238", language: "FR", variant: "holo" },
        { userId: ALICE, cardId: "sv08-238", language: "EN", variant: "holo" },
        { userId: ALICE, cardId: "sv03.5-006", language: "FR", variant: "normal" },
        { userId: ALICE, cardId: "sv03.5-006", language: "EN", variant: "normal" },
        { userId: ALICE, cardId: "sv03.5-006", language: "FR", variant: "masterball" },
        { userId: BOB, cardId: "sv08-238", language: "FR", variant: "holo" },
      ],
    });
    // Preview reports matching wishlist removal without mutating state.
    const prev = await preview(
      state,
      ALICE,
      batch({ language: "FR", variant: "normal", removeFromWishlist: true }, [
        { cardId: "sv08-238", quantity: 1 }, // auto-adjusted normal → holo, matches FR holo wish
        { cardId: "sv03.5-006", quantity: 1 }, // FR normal matches FR normal wish only
      ]),
    );
    expect(prev.wishlistRemovedCount).toBe(2);
    expect(state.wishlist).toHaveLength(6);

    const removed = await commit(
      state,
      ALICE,
      batch({ language: "FR", variant: "normal", removeFromWishlist: true }, [
        { cardId: "sv08-238", quantity: 1 },
        { cardId: "sv03.5-006", quantity: 1 },
      ]),
    );
    expect(removed.wishlistRemovedCount).toBe(2);
    expect(removed.items.every((item) => item.removedFromWishlist)).toBe(true);
    // EN wishes, masterball wish and Bob's wish remain untouched.
    expect(state.wishlist).toEqual([
      { userId: ALICE, cardId: "sv08-238", language: "EN", variant: "holo" },
      { userId: ALICE, cardId: "sv03.5-006", language: "EN", variant: "normal" },
      { userId: ALICE, cardId: "sv03.5-006", language: "FR", variant: "masterball" },
      { userId: BOB, cardId: "sv08-238", language: "FR", variant: "holo" },
    ]);

    const kept = await commit(
      state,
      ALICE,
      batch({ language: "EN", variant: "normal", removeFromWishlist: false }, [
        { cardId: "sv03.5-006", quantity: 1 },
      ]),
    );
    expect(kept.wishlistRemovedCount).toBe(0);
    expect(kept.items[0]?.removedFromWishlist).toBe(false);
    expect(state.wishlist).toHaveLength(4);
  });

  it("does not fail when the wishlist table does not exist yet (pre-M3)", async () => {
    const state = makeState({
      wishlistTableExists: false,
      wishlist: [{ userId: ALICE, cardId: "sv08-238", language: "FR", variant: "holo" }],
    });
    const report = await commit(
      state,
      ALICE,
      batch({ variant: "holo", removeFromWishlist: true }, [{ cardId: "sv08-238", quantity: 1 }]),
    );
    expect(report.wishlistRemovedCount).toBe(0);
    expect(report.items[0]?.removedFromWishlist).toBe(false);
    expect(state.wishlist).toHaveLength(1); // untouched (no table → no delete)
    expect(state.copies).toHaveLength(1);
  });

  it("is atomic: an unknown card rolls the whole batch back (copies AND wishlist intact)", async () => {
    const state = makeState({
      wishlist: [{ userId: ALICE, cardId: "sv08-238" }],
    });
    const error = await Effect.runPromise(
      Effect.flip(
        commitE(
          state,
          ALICE,
          batch({ variant: "holo", removeFromWishlist: true }, [
            { cardId: "sv08-238", quantity: 2 },
            { cardId: "unknown-404", quantity: 1 },
          ]),
        ),
      ),
    );
    expect(error).toBeInstanceOf(BurstImportCardNotFoundError);
    if (error instanceof BurstImportCardNotFoundError) {
      expect(error.missingCardIds).toEqual(["unknown-404"]);
    }
    expect(state.copies).toHaveLength(0);
    expect(state.wishlist).toHaveLength(1);
  });

  it("is atomic: a quantity overflow rolls the whole batch back", async () => {
    const state = makeState({
      copies: [
        {
          userId: ALICE,
          cardId: "sv03.5-025",
          language: "FR",
          variant: "normal",
          condition: "NM",
          gradingCompany: null,
          gradingScore: null,
          quantity: MAX_CARD_COPY_QUANTITY - 1,
        },
      ],
      wishlist: [{ userId: ALICE, cardId: "sv03.5-006" }],
    });
    const error = await Effect.runPromise(
      Effect.flip(
        commitE(
          state,
          ALICE,
          batch({ variant: "normal", removeFromWishlist: true }, [
            { cardId: "sv03.5-025", quantity: 2 }, // 998 + 2 > 999
            { cardId: "sv03.5-006", quantity: 1 },
          ]),
        ),
      ),
    );
    expect(error).toBeInstanceOf(BurstImportQuantityOverflowError);
    if (error instanceof BurstImportQuantityOverflowError) {
      expect(error.cardId).toBe("sv03.5-025");
      expect(error.currentQuantity).toBe(MAX_CARD_COPY_QUANTITY - 1);
      expect(error.requestedDelta).toBe(2);
      expect(error.maxQuantity).toBe(MAX_CARD_COPY_QUANTITY);
    }
    // Nothing was written: no new slot for sv03.5-006, wishlist intact, quantity unchanged.
    expect(state.copies).toHaveLength(1);
    expect(state.copies[0]?.quantity).toBe(MAX_CARD_COPY_QUANTITY - 1);
    expect(state.wishlist).toHaveLength(1);
  });

  it("never touches graded copies and still counts the card as owned (duplicate)", async () => {
    const state = makeState({
      copies: [
        {
          userId: ALICE,
          cardId: "sv03.5-025",
          language: "FR",
          variant: "holo",
          condition: "NM",
          gradingCompany: "PSA",
          gradingScore: "10",
          quantity: 1,
        },
      ],
    });
    const report = await commit(
      state,
      ALICE,
      batch({ variant: "normal" }, [
        { cardId: "sv03.5-025", quantity: 3 }, // ungraded normal slot (separate from the PSA row)
      ]),
    );
    expect(report.items[0]).toMatchObject({
      resolvedVariant: "normal",
      wasNewCard: false, // owns the graded copy of the same card
      newTotalQuantity: 3,
    });
    expect(report.newCardsCount).toBe(0);
    expect(report.duplicateCardsCount).toBe(1);
    expect(state.copies).toHaveLength(2);
    const graded = state.copies.find((copy) => copy.gradingCompany === "PSA");
    expect(graded?.quantity).toBe(1); // untouched
    const ungraded = state.copies.find((copy) => copy.gradingCompany === null);
    expect(ungraded).toMatchObject({ variant: "normal", quantity: 3 });
  });

  it("keeps users isolated (Bob never sees or modifies Alice's copies)", async () => {
    const state = makeState({
      copies: [
        {
          userId: ALICE,
          cardId: "sv08-238",
          language: "FR",
          variant: "holo",
          condition: "NM",
          gradingCompany: null,
          gradingScore: null,
          quantity: 5,
        },
      ],
    });
    const bobPreview = await preview(
      state,
      BOB,
      batch({ variant: "holo" }, [{ cardId: "sv08-238", quantity: 1 }]),
    );
    expect(bobPreview.items[0]).toMatchObject({ wasNewCard: true, newTotalQuantity: 1 });
    await commit(state, BOB, batch({ variant: "holo" }, [{ cardId: "sv08-238", quantity: 2 }]));
    expect(state.copies).toHaveLength(2);
    expect(state.copies.find((copy) => copy.userId === ALICE)?.quantity).toBe(5);
    expect(state.copies.find((copy) => copy.userId === BOB)?.quantity).toBe(2);
  });
});
