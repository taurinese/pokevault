import { Data, Effect, Schema } from "effect";
import {
  CardCondition,
  CardId,
  CardLanguage,
  CardVariant,
  type HoloEffect,
  MAX_CARD_COPY_QUANTITY,
  ValidationError,
} from "./card.ts";

// ---------------------------------------------------------------------------
// Constants (docs/01-cahier-des-charges.md §6, ADR-006 — saisie rafale 08A–08D)
// ---------------------------------------------------------------------------

/** Maximum number of lines in one burst-import batch (DoS guard). */
export const MAX_BURST_BATCH_ITEMS = 500;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Batch-level defaults configured once on screen `08A` (extension cible,
 * langue, variante, état, option « retirer de la Wishlist »).
 * Decoding `{}` yields the full default set (`FR` / `normal` / `NM` / `true`).
 */
export const BurstImportDefaults = Schema.Struct({
  setId: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(64))),
  language: CardLanguage.pipe(Schema.withDecodingDefaultKey(Effect.succeed("FR" as const))),
  variant: CardVariant.pipe(Schema.withDecodingDefaultKey(Effect.succeed("normal" as const))),
  condition: CardCondition.pipe(Schema.withDecodingDefaultKey(Effect.succeed("NM" as const))),
  removeFromWishlist: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type BurstImportDefaults = typeof BurstImportDefaults.Type;

/**
 * One line of a burst batch. `language` / `variant` / `condition` fall back to
 * the batch defaults when absent. `variantExplicit: true` marks an explicit
 * per-line override (grid / `#` keypad) that the automatic variant adjustment
 * must not overwrite.
 */
export const BurstImportItemInput = Schema.Struct({
  cardId: CardId,
  quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CARD_COPY_QUANTITY })),
  language: Schema.optionalKey(CardLanguage),
  variant: Schema.optionalKey(CardVariant),
  condition: Schema.optionalKey(CardCondition),
  variantExplicit: Schema.optionalKey(Schema.Boolean),
});
export type BurstImportItemInput = typeof BurstImportItemInput.Type;

/** A whole burst batch: batch defaults + 1..MAX_BURST_BATCH_ITEMS lines. */
export const BurstImportBatchInput = Schema.Struct({
  defaults: BurstImportDefaults,
  items: Schema.NonEmptyArray(BurstImportItemInput).check(
    Schema.makeFilter((items) =>
      items.length <= MAX_BURST_BATCH_ITEMS
        ? true
        : `batch too large: ${items.length} items > ${MAX_BURST_BATCH_ITEMS}`,
    ),
  ),
});
export type BurstImportBatchInput = typeof BurstImportBatchInput.Type;

/** Per-line outcome of a burst import (preview or committed). */
export const BurstImportItemResult = Schema.Struct({
  cardId: CardId,
  language: CardLanguage,
  resolvedVariant: CardVariant,
  variantAdjusted: Schema.Boolean,
  condition: CardCondition,
  addedQuantity: Schema.Int.check(Schema.isGreaterThan(0)),
  newTotalQuantity: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_CARD_COPY_QUANTITY),
  ),
  wasNewCard: Schema.Boolean,
  removedFromWishlist: Schema.Boolean,
});
export type BurstImportItemResult = typeof BurstImportItemResult.Type;

/** Aggregate report of a burst import. */
export const BurstImportReport = Schema.Struct({
  totalAddedQuantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  distinctCardsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  newCardsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  duplicateCardsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  wishlistRemovedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  adjustedVariantsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  items: Schema.Array(BurstImportItemResult),
});
export type BurstImportReport = typeof BurstImportReport.Type;

// ---------------------------------------------------------------------------
// Typed domain errors (docs/03-architecture.md §3 — Data.TaggedError)
// ---------------------------------------------------------------------------

/** At least one `cardId` of the batch is unknown (or outside `defaults.setId`). */
export class BurstImportCardNotFoundError extends Data.TaggedError("BurstImportCardNotFoundError")<{
  readonly missingCardIds: ReadonlyArray<string>;
}> {}

/** Adding `requestedDelta` to the current slot quantity would exceed the cap. */
export class BurstImportQuantityOverflowError extends Data.TaggedError(
  "BurstImportQuantityOverflowError",
)<{
  readonly cardId: string;
  readonly currentQuantity: number;
  readonly requestedDelta: number;
  readonly maxQuantity: number;
}> {}

/** The batch contains no line at all. */
export class BurstImportEmptyBatchError extends Data.TaggedError("BurstImportEmptyBatchError")<{
  readonly message?: string | undefined;
}> {}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/** Decodes an unknown payload into a `BurstImportBatchInput` with a typed `ValidationError`. */
export const decodeBurstImportBatchInput = (
  input: unknown,
): Effect.Effect<BurstImportBatchInput, ValidationError> =>
  Schema.decodeUnknownEffect(BurstImportBatchInput)(input).pipe(
    Effect.mapError((error) => new ValidationError({ message: error.message, cause: error })),
  );

// ---------------------------------------------------------------------------
// Automatic variant adjustment (docs/01 §6 & issue #18)
// ---------------------------------------------------------------------------

/** Catalog metadata needed to auto-adjust the variant of one card. */
export interface BurstCardVariantMeta {
  readonly availableVariants: ReadonlyArray<CardVariant>;
  readonly holoEffect: HoloEffect;
}

/** Full catalog metadata of one card targeted by a batch. */
export interface BurstCardMeta extends BurstCardVariantMeta {
  readonly cardId: CardId;
  readonly setId: string;
}

export interface ResolveBurstCardVariantInput extends BurstCardVariantMeta {
  readonly requestedVariant: CardVariant;
  readonly variantExplicit: boolean;
}

export interface BurstVariantResolution {
  readonly variant: CardVariant;
  readonly adjusted: boolean;
}

/**
 * Preference order when the requested (non-explicit) variant is missing from
 * `availableVariants`: `holo` first (typical EX / SIR / AR / UR / Gold / Rare SV
 * cards), then `promo`, then `reverse`, then the first listed variant.
 */
const AUTO_VARIANT_PREFERENCE: ReadonlyArray<CardVariant> = ["holo", "promo", "reverse"];

/** `holo_effect` values of cards that only exist as holo when no variant is listed. */
const HOLO_ONLY_EFFECTS: ReadonlySet<HoloEffect> = new Set(["holo", "ex", "sir", "tera", "gold"]);

/**
 * Resolves the effective variant of one burst line.
 *
 * 1. The requested variant is really available on the card → keep it
 *    (`adjusted: false`).
 * 2. `variantExplicit === true` → always respect the user's choice
 *    (`pokeball`, `masterball`, `promo`… may exist even when TCGdex does not
 *    list them all).
 * 3. Otherwise (variant coming from the batch defaults and absent from
 *    `availableVariants`):
 *    - non-empty `availableVariants` → automatically pick the best real
 *      variant (`holo`, else `promo`, else `reverse`, else the first listed)
 *      with `adjusted: true` ;
 *    - empty `availableVariants` but a premium `holoEffect` and a requested
 *      `"normal"` → adjust to `"holo"` (`adjusted: true`) ;
 *    - otherwise keep the requested variant (`adjusted: false`).
 */
export const resolveBurstCardVariant = (
  input: ResolveBurstCardVariantInput,
): BurstVariantResolution => {
  const { requestedVariant, variantExplicit, availableVariants, holoEffect } = input;
  if (availableVariants.includes(requestedVariant)) {
    return { variant: requestedVariant, adjusted: false };
  }
  if (variantExplicit) {
    return { variant: requestedVariant, adjusted: false };
  }
  if (availableVariants.length > 0) {
    const preferred = AUTO_VARIANT_PREFERENCE.find((variant) =>
      availableVariants.includes(variant),
    );
    const first = availableVariants[0];
    const best = preferred ?? first;
    if (best !== undefined) return { variant: best, adjusted: true };
  }
  if (requestedVariant === "normal" && HOLO_ONLY_EFFECTS.has(holoEffect)) {
    return { variant: "holo", adjusted: true };
  }
  return { variant: requestedVariant, adjusted: false };
};

// ---------------------------------------------------------------------------
// Per-line resolution against the batch defaults
// ---------------------------------------------------------------------------

/** One burst line with every default applied and its variant resolved. */
export interface ResolvedBurstItem {
  readonly cardId: CardId;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity: number;
  readonly variantAdjusted: boolean;
}

/** Applies the batch defaults to one input line and resolves its variant. */
export const resolveBurstItem = (
  item: BurstImportItemInput,
  defaults: BurstImportDefaults,
  card: BurstCardMeta,
): ResolvedBurstItem => {
  const resolution = resolveBurstCardVariant({
    requestedVariant: item.variant ?? defaults.variant,
    variantExplicit: item.variantExplicit ?? false,
    availableVariants: card.availableVariants,
    holoEffect: card.holoEffect,
  });
  return {
    cardId: item.cardId,
    language: item.language ?? defaults.language,
    variant: resolution.variant,
    condition: item.condition ?? defaults.condition,
    quantity: item.quantity,
    variantAdjusted: resolution.adjusted,
  };
};

// ---------------------------------------------------------------------------
// Pure batch consolidation (same slot = same (cardId, language, variant, condition))
// ---------------------------------------------------------------------------

/** Minimal shape of one slot line used for consolidation. */
export interface BurstSlotLine {
  readonly cardId: CardId;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity: number;
}

/** Stable slot key (`CardId` forbids whitespace, so `" "` is a safe separator). */
export const burstSlotKey = (
  line: Pick<BurstSlotLine, "cardId" | "language" | "variant" | "condition">,
): string => `${line.cardId} ${line.language} ${line.variant} ${line.condition}`;

/** Fails with `BurstImportQuantityOverflowError` when `current + delta > max`. */
export const assertQuantityWithinLimit = (
  cardId: string,
  currentQuantity: number,
  requestedDelta: number,
): Effect.Effect<void, BurstImportQuantityOverflowError> =>
  currentQuantity + requestedDelta > MAX_CARD_COPY_QUANTITY
    ? Effect.fail(
        new BurstImportQuantityOverflowError({
          cardId,
          currentQuantity,
          requestedDelta,
          maxQuantity: MAX_CARD_COPY_QUANTITY,
        }),
      )
    : Effect.void;

/**
 * Merges duplicated lines of the same batch (same `cardId`, `language`,
 * resolved `variant`, `condition`) into a single line before the SQL write,
 * and enforces the `MAX_CARD_COPY_QUANTITY` ceiling on every merged slot
 * (taking already-owned quantities from `currentQuantities` into account).
 * Lines keep the order of their first occurrence.
 */
export const consolidateBurstItems = <A extends BurstSlotLine>(
  lines: ReadonlyArray<A>,
  currentQuantities: ReadonlyMap<string, number> = new Map(),
): Effect.Effect<ReadonlyArray<A>, BurstImportEmptyBatchError | BurstImportQuantityOverflowError> =>
  Effect.gen(function* () {
    if (lines.length === 0) return yield* new BurstImportEmptyBatchError({});
    const merged = new Map<string, A>();
    for (const line of lines) {
      const key = burstSlotKey(line);
      const existing = merged.get(key);
      merged.set(
        key,
        existing === undefined
          ? line
          : { ...existing, quantity: existing.quantity + line.quantity },
      );
    }
    const result: Array<A> = [];
    for (const line of merged.values()) {
      const current = currentQuantities.get(burstSlotKey(line)) ?? 0;
      yield* assertQuantityWithinLimit(line.cardId, current, line.quantity);
      result.push(line);
    }
    return result;
  });

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

/** Everything needed to turn one planned line into a `BurstImportItemResult`. */
export interface BurstItemOutcome {
  readonly line: ResolvedBurstItem;
  readonly previousQuantity: number;
  readonly wasNewCard: boolean;
  readonly removedFromWishlist: boolean;
}

/**
 * Builds the aggregate `BurstImportReport` from per-line outcomes.
 *
 * `wasNewCard` is per *card*: a card the user already owns in another variant
 * counts as a duplicate (`duplicateCardsCount`), not as a new card.
 */
export const buildBurstImportReport = (
  outcomes: ReadonlyArray<BurstItemOutcome>,
): BurstImportReport => {
  const items: Array<BurstImportItemResult> = outcomes.map((outcome) => ({
    cardId: outcome.line.cardId,
    language: outcome.line.language,
    resolvedVariant: outcome.line.variant,
    variantAdjusted: outcome.line.variantAdjusted,
    condition: outcome.line.condition,
    addedQuantity: outcome.line.quantity,
    newTotalQuantity: outcome.previousQuantity + outcome.line.quantity,
    wasNewCard: outcome.wasNewCard,
    removedFromWishlist: outcome.removedFromWishlist,
  }));
  const distinctCardIds = new Set(items.map((item) => item.cardId));
  const newCardIds = new Set(items.filter((item) => item.wasNewCard).map((item) => item.cardId));
  const wishlistCardIds = new Set(
    items.filter((item) => item.removedFromWishlist).map((item) => item.cardId),
  );
  return {
    totalAddedQuantity: items.reduce((total, item) => total + item.addedQuantity, 0),
    distinctCardsCount: distinctCardIds.size,
    newCardsCount: newCardIds.size,
    duplicateCardsCount: distinctCardIds.size - newCardIds.size,
    wishlistRemovedCount: wishlistCardIds.size,
    adjustedVariantsCount: items.filter((item) => item.variantAdjusted).length,
    items,
  };
};
