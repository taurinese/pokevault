import { Data, Effect, Schema } from "effect";
import {
  CardCondition,
  CardId,
  CardLanguage,
  CardVariant,
  MAX_CARD_COPY_QUANTITY,
  ValidationError,
} from "./card.ts";
import {
  CARD_COPY_NOTES_MAX_LENGTH,
  CopyQuantity,
  PurchasePriceCents,
  UserCardCopy,
  Uuid,
} from "./collection.ts";

// ---------------------------------------------------------------------------
// Base schemas (aligned with supabase/migrations/006_wishlist_items.sql)
// ---------------------------------------------------------------------------

/** `wishlist_items.priority` : `normale` (défaut) ou `haute` (docs/01 §8). */
export const WishlistPriority = Schema.Literals(["normal", "high"]);
export type WishlistPriority = typeof WishlistPriority.Type;

/** `wishlist_items.target_price_cents` : prix cible en centimes EUR, entier `>= 0`. */
export const WishlistTargetPriceCents = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type WishlistTargetPriceCents = typeof WishlistTargetPriceCents.Type;

const hasAnyKey =
  (keys: ReadonlyArray<string>) =>
  (value: object): true | string =>
    keys.some((key) => (value as Record<string, unknown>)[key] !== undefined)
      ? true
      : `at least one of ${keys.join(", ")} is required`;

// ---------------------------------------------------------------------------
// Entity & inputs
// ---------------------------------------------------------------------------

/** Ligne `wishlist_items` (dates en ISO 8601, sérialisables vers le client). */
export const WishlistItem = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  cardId: CardId,
  language: CardLanguage,
  variant: CardVariant,
  minCondition: CardCondition,
  priority: WishlistPriority,
  targetPriceCents: Schema.NullOr(WishlistTargetPriceCents),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WishlistItem = typeof WishlistItem.Type;

/**
 * Ajout d'un souhait sur le slot `(carte, langue, variante)`. Défauts SQL : langue `FR`,
 * variante `normal`, état minimum `NM`, priorité `normal`, pas de prix cible.
 * `ifExists` : `"fail"` (défaut) lève `WishlistItemConflictError` sur doublon, `"return"`
 * renvoie le souhait existant à l'identique (idempotent, ex. toggle ♥ depuis une fiche carte).
 */
export const AddWishlistItemInput = Schema.Struct({
  cardId: CardId,
  language: Schema.optionalKey(CardLanguage),
  variant: Schema.optionalKey(CardVariant),
  minCondition: Schema.optionalKey(CardCondition),
  priority: Schema.optionalKey(WishlistPriority),
  targetPriceCents: Schema.optionalKey(Schema.NullOr(WishlistTargetPriceCents)),
  ifExists: Schema.optionalKey(Schema.Literals(["return", "fail"])),
});
export type AddWishlistItemInput = typeof AddWishlistItemInput.Type;

/**
 * Patch d'un souhait. La carte (`cardId`) est immuable ; `targetPriceCents: null` retire
 * le seuil. Au moins un champ est requis.
 */
export const UpdateWishlistItemInput = Schema.Struct({
  language: Schema.optionalKey(CardLanguage),
  variant: Schema.optionalKey(CardVariant),
  minCondition: Schema.optionalKey(CardCondition),
  priority: Schema.optionalKey(WishlistPriority),
  targetPriceCents: Schema.optionalKey(Schema.NullOr(WishlistTargetPriceCents)),
}).check(
  Schema.makeFilter(
    hasAnyKey(["language", "variant", "minCondition", "priority", "targetPriceCents"]),
  ),
);
export type UpdateWishlistItemInput = typeof UpdateWishlistItemInput.Type;

/** Filtre de {@link WishlistService.listWishlistItems}. */
export interface ListWishlistItemsFilter {
  readonly priority?: WishlistPriority | undefined;
  readonly cardId?: string | undefined;
  readonly setId?: string | undefined;
}

/**
 * Bascule 1-tap « ✓ Acquise » : l'exemplaire créé reprend langue / variante du souhait.
 * `condition` vaut par défaut l'`minCondition` du souhait, `quantity` (`1..999`) vaut 1.
 */
export const MarkWishlistAcquiredInput = Schema.Struct({
  wishlistItemId: Uuid,
  condition: Schema.optionalKey(CardCondition),
  quantity: Schema.optionalKey(CopyQuantity),
  purchasePriceCents: Schema.optionalKey(Schema.NullOr(PurchasePriceCents)),
  notes: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(CARD_COPY_NOTES_MAX_LENGTH))),
  ),
});
export type MarkWishlistAcquiredInput = typeof MarkWishlistAcquiredInput.Type;

/** Résultat de la bascule : souhait retiré, exemplaire (créé ou incrémenté), classeur d'extension. */
export const MarkWishlistAcquiredResult = Schema.Struct({
  removedWishlistItemId: Uuid,
  copy: UserCardCopy,
  setBinderId: Schema.NullOr(Uuid),
});
export type MarkWishlistAcquiredResult = typeof MarkWishlistAcquiredResult.Type;

// ---------------------------------------------------------------------------
// Typed domain errors (docs/03 §3)
// ---------------------------------------------------------------------------

/** Souhait inexistant, ou appartenant à un autre utilisateur (RLS : invisible). */
export class WishlistItemNotFoundError extends Data.TaggedError("WishlistItemNotFoundError")<{
  readonly itemId: string;
  readonly message: string;
}> {}

/** Le slot `(carte, langue, variante)` est déjà dans la wishlist (`wishlist_items_unique_slot`). */
export class WishlistItemConflictError extends Data.TaggedError("WishlistItemConflictError")<{
  readonly message: string;
  readonly cardId?: string | undefined;
  readonly cause?: unknown;
}> {}

/** Bascule « Acquise » refusée : l'incrément dépasserait `MAX_CARD_COPY_QUANTITY` (999). */
export class WishlistQuantityOverflowError extends Data.TaggedError(
  "WishlistQuantityOverflowError",
)<{
  readonly cardId: string;
  readonly currentQuantity: number;
  readonly requestedDelta: number;
  readonly maxQuantity: number;
  readonly message: string;
}> {}

/** Construit l'erreur de dépassement avec un message lisible. */
export const wishlistQuantityOverflow = (input: {
  readonly cardId: string;
  readonly currentQuantity: number;
  readonly requestedDelta: number;
}): WishlistQuantityOverflowError =>
  new WishlistQuantityOverflowError({
    ...input,
    maxQuantity: MAX_CARD_COPY_QUANTITY,
    message: `card ${input.cardId}: ${input.currentQuantity} + ${input.requestedDelta} exceeds ${MAX_CARD_COPY_QUANTITY} copies`,
  });

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const decodeWith =
  <T, E>(schema: Schema.Codec<T, E>) =>
  (input: unknown): Effect.Effect<T, ValidationError> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => new ValidationError({ message: error.message, cause: error })),
    );

export const decodeAddWishlistItemInput = decodeWith(AddWishlistItemInput);
export const decodeUpdateWishlistItemInput = decodeWith(UpdateWishlistItemInput);
export const decodeMarkWishlistAcquiredInput = decodeWith(MarkWishlistAcquiredInput);

/** Clé de slot d'un souhait, alignée sur `UNIQUE (user_id, card_id, language, variant)`. */
export const wishlistSlotKey = (slot: {
  readonly cardId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
}): string => `${slot.cardId} ${slot.language} ${slot.variant}`;
