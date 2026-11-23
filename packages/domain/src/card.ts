import { Data, Effect, Schema } from "effect";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Official Pokémon card aspect ratio (63 mm × 88 mm). */
export const CardAspectRatio = 63 / 88;

/** Upper bound for a single user_card_copies row quantity. */
export const MAX_CARD_COPY_QUANTITY = 999;

// ---------------------------------------------------------------------------
// Base schemas (aligned with docs/02-modele-des-donnees.md)
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

/** Non-empty TCGdex card identifier without whitespace (e.g. `sv03.5-199`). */
export const CardId = Schema.NonEmptyString.check(Schema.isPattern(/^\S+$/));
export type CardId = typeof CardId.Type;

/** Owned card copy payload (maps to `user_card_copies`, excluding catalog-only fields). */
export const CardCopy = Schema.Struct({
  cardId: CardId,
  language: CardLanguage,
  variant: CardVariant,
  condition: CardCondition,
  quantity: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_CARD_COPY_QUANTITY),
  ),
});
export type CardCopy = typeof CardCopy.Type;

// ---------------------------------------------------------------------------
// Typed domain errors (aligned with docs/03-architecture.md)
// ---------------------------------------------------------------------------

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/** Decodes an unknown payload into a `CardCopy` with a typed `ValidationError`. */
export const decodeCardCopy = (input: unknown): Effect.Effect<CardCopy, ValidationError> =>
  Schema.decodeUnknownEffect(CardCopy)(input).pipe(
    Effect.mapError((error) => new ValidationError({ message: error.message, cause: error })),
  );

// ---------------------------------------------------------------------------
// Rarity / variant → 3D holo preset mapping (TCGdex FR & EN)
// ---------------------------------------------------------------------------

const normalizeRarity = (rarity: string): string =>
  rarity
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const GOLD_RARITIES: ReadonlySet<string> = new Set([
  "gold",
  "hyper rare",
  "mega hyper rare",
  "secret rare",
  "ur",
  "crown",
  "couronne",
]);

const SIR_RARITIES: ReadonlySet<string> = new Set([
  "sir",
  "sar",
  "special illustration rare",
  "illustration speciale rare",
  "special art rare",
  "trois etoiles",
  "three star",
]);

const EX_RARITIES: ReadonlySet<string> = new Set([
  "ex",
  "dr",
  "double rare",
  "ultra rare",
  "rr",
  "rrr",
  "full art",
  "full art trainer",
  "dresseur full art",
  "chromatique ultra rare",
  "shiny ultra rare",
  "holo rare v",
  "holo rare vmax",
  "holo rare vstar",
  "shiny rare v",
  "shiny rare vmax",
  "rare holo lv.x",
  "rare prime",
  "legende",
  "legend",
  "ace spec rare",
  "high-tech rare",
  "mega attack rare",
  "v",
  "vmax",
  "vstar",
  "gx",
  "deux etoiles",
  "two star",
  "quatre diamants",
  "four diamond",
]);

const HOLO_RARITIES: ReadonlySet<string> = new Set([
  "holo",
  "holo rare",
  "rare holo",
  "ar",
  "ir",
  "illustration rare",
  "shiny rare",
  "un chromatique",
  "deux chromatiques",
  "one shiny",
  "two shiny",
  "radieux rare",
  "radiant rare",
  "magnifique",
  "magnifique rare",
  "amazing rare",
  "collection classique",
  "classic collection",
  "rare noir blanc",
  "black white rare",
  "futuristic rare",
  "pikachu rare",
  "rgb rare",
  "une etoile",
  "one star",
  "trois diamants",
  "three diamond",
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

export interface DeriveHoloEffectInput {
  readonly rarity: string;
  readonly variant?: CardVariant | undefined;
  readonly isTera?: boolean | undefined;
}

/**
 * Derives the 3D holo shader preset from TCGdex FR/EN rarity metadata,
 * card variant, and Tera card flag (`isTera`).
 *
 * Precedence:
 * 1. `isTera` (or explicit `"tera"` in rarity) → `"tera"`.
 * 2. Premium rarities (`gold`, `sir`, `ex`) always take precedence over `variant`.
 * 3. Shiny variants (`reverse`, `pokeball`, `masterball`, `holo`) override basic/holo rarities.
 * 4. Otherwise, fall back to rarity (`holo` or `none`). Plain `"Rare"` maps to `none` unless
 *    paired with a `holo` or `reverse` variant so pre-SV non-holo rares stay accurate.
 */
export const deriveHoloEffect = (input: DeriveHoloEffectInput): HoloEffect => {
  if (input.isTera) return "tera";
  const fromRarity = rarityEffect(input.rarity);
  if (fromRarity !== "none" && fromRarity !== "holo") return fromRarity;
  const fromVariant = variantEffect(input.variant);
  if (fromVariant !== "none") return fromVariant;
  return fromRarity;
};
