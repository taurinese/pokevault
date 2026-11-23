import { Data, Effect, Schema } from "effect";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Ratio officiel d'une carte Pokémon (63 mm × 88 mm). */
export const CardAspectRatio = 63 / 88;

// ---------------------------------------------------------------------------
// Schémas des types de base
// ---------------------------------------------------------------------------

export const CardLanguage = Schema.Literals(["FR", "EN", "JP", "ZH"]);
export type CardLanguage = typeof CardLanguage.Type;

export const CardVariant = Schema.Literals([
  "normal",
  "reverse",
  "holo",
  "promo",
  "pokeball",
  "masterball",
]);
export type CardVariant = typeof CardVariant.Type;

export const CardCondition = Schema.Literals(["M", "NM", "EX", "GD", "LP", "PL", "PO"]);
export type CardCondition = typeof CardCondition.Type;

export const HoloEffect = Schema.Literals(["none", "holo", "reverse", "ex", "sir", "tera", "gold"]);
export type HoloEffect = typeof HoloEffect.Type;

/** Carte d'une collection utilisateur (représentation de domaine minimale). */
export const OwnedCard = Schema.Struct({
  cardId: Schema.NonEmptyString,
  language: CardLanguage,
  variant: CardVariant,
  condition: CardCondition,
  quantity: Schema.Int.check(Schema.isGreaterThan(0)),
  holoEffect: Schema.optionalKey(HoloEffect),
});
export type OwnedCard = typeof OwnedCard.Type;

// ---------------------------------------------------------------------------
// Erreurs typées
// ---------------------------------------------------------------------------

export class CardValidationError extends Data.TaggedError("CardValidationError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Décodage
// ---------------------------------------------------------------------------

/** Décode une charge utile inconnue en `OwnedCard`, avec une erreur typée. */
export const decodeOwnedCard = (input: unknown): Effect.Effect<OwnedCard, CardValidationError> =>
  Schema.decodeUnknownEffect(OwnedCard)(input).pipe(
    Effect.mapError((error) => new CardValidationError({ message: error.message })),
  );

// ---------------------------------------------------------------------------
// Mapping rareté / variante → effet holo 3D
// ---------------------------------------------------------------------------

const normalizeRarity = (rarity: string): string =>
  rarity.trim().toLowerCase().replace(/\s+/g, " ");

const GOLD_RARITIES: ReadonlySet<string> = new Set(["ur", "hyper rare", "gold", "secret rare"]);
const SIR_RARITIES: ReadonlySet<string> = new Set([
  "sir",
  "sar",
  "special illustration rare",
  "special art rare",
]);
const EX_RARITIES: ReadonlySet<string> = new Set([
  "ex",
  "dr",
  "double rare",
  "ultra rare",
  "rr",
  "rrr",
  "full art",
  "v",
  "vmax",
  "vstar",
  "gx",
]);
const HOLO_RARITIES: ReadonlySet<string> = new Set([
  "holo",
  "holo rare",
  "rare holo",
  "rare",
  "ar",
  "ir",
  "illustration rare",
]);

const rarityEffect = (rarity: string): HoloEffect => {
  const value = normalizeRarity(rarity);
  if (value.includes("tera")) return "tera";
  if (GOLD_RARITIES.has(value)) return "gold";
  if (SIR_RARITIES.has(value)) return "sir";
  if (EX_RARITIES.has(value)) return "ex";
  if (HOLO_RARITIES.has(value)) return "holo";
  return "none";
};

const variantEffect = (variant: CardVariant | undefined): HoloEffect => {
  switch (variant) {
    case "reverse":
    case "pokeball":
    case "masterball":
      return "reverse";
    case "holo":
      return "holo";
    default:
      return "none";
  }
};

/**
 * Déduit l'effet holo 3D d'une carte à partir de sa rareté (texte TCGdex / normalisé)
 * et, optionnellement, de sa variante.
 *
 * - Les raretés premium (`tera`, `gold`, `sir`, `ex`) l'emportent toujours.
 * - Sinon, une variante brillante (`reverse`, `pokeball`, `masterball`, `holo`) prime.
 * - Sinon, l'effet dépend de la rareté (`holo`) ou vaut `none`.
 */
export const deriveHoloEffect = (rarity: string, variant?: CardVariant): HoloEffect => {
  const fromRarity = rarityEffect(rarity);
  if (fromRarity !== "none" && fromRarity !== "holo") return fromRarity;
  const fromVariant = variantEffect(variant);
  if (fromVariant !== "none") return fromVariant;
  return fromRarity;
};
