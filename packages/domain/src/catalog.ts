import { Schema } from "effect";
import { CardVariant, HoloEffect } from "./card.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical order of card variants, aligned with the `available_variants`
 * CHECK constraint of `supabase/migrations/002_catalog.sql`.
 */
export const CARD_VARIANT_ORDER: ReadonlyArray<CardVariant> = [
  "normal",
  "reverse",
  "holo",
  "promo",
  "pokeball",
  "masterball",
];

// ---------------------------------------------------------------------------
// Catalog schemas (aligned with supabase/migrations/002_catalog.sql)
// ---------------------------------------------------------------------------

/** `catalog_cards.category` CHECK: `Pokemon | Trainer | Energy`. */
export const CatalogCategory = Schema.Literals(["Pokemon", "Trainer", "Energy"]);
export type CatalogCategory = typeof CatalogCategory.Type;

/** SQL `date` literal (`YYYY-MM-DD`), as stored in `catalog_sets.release_date`. */
export const SqlDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type SqlDate = typeof SqlDate.Type;

/** Row of `catalog_series` (shared read-only catalogue, synced from TCGdex). */
export const CatalogSeries = Schema.Struct({
  id: Schema.NonEmptyString,
  name_fr: Schema.String,
  name_en: Schema.NullOr(Schema.String),
  release_order: Schema.Int,
});
export type CatalogSeries = typeof CatalogSeries.Type;

/** Row of `catalog_sets`. Enforces `CHECK (total_count >= official_count)`. */
export const CatalogSet = Schema.Struct({
  id: Schema.NonEmptyString,
  series_id: Schema.NonEmptyString,
  code: Schema.NullOr(Schema.String),
  cardmarket_code: Schema.NullOr(Schema.String),
  name_fr: Schema.String,
  name_en: Schema.NullOr(Schema.String),
  logo_url: Schema.NullOr(Schema.String),
  symbol_url: Schema.NullOr(Schema.String),
  release_date: Schema.NullOr(SqlDate),
  official_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter((set) =>
    set.total_count >= set.official_count
      ? true
      : `total_count (${set.total_count}) must be >= official_count (${set.official_count})`,
  ),
);
export type CatalogSet = typeof CatalogSet.Type;

/** Row of `catalog_cards`. Enforces the `holo_effect` / `category` / variants CHECKs. */
export const CatalogCard = Schema.Struct({
  id: Schema.NonEmptyString,
  set_id: Schema.NonEmptyString,
  local_id: Schema.NonEmptyString,
  local_id_numeric: Schema.NullOr(Schema.Int),
  name_fr: Schema.String,
  name_en: Schema.NullOr(Schema.String),
  rarity: Schema.NullOr(Schema.String),
  holo_effect: HoloEffect,
  category: CatalogCategory,
  types: Schema.Array(Schema.String),
  hp: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  illustrator: Schema.NullOr(Schema.String),
  image_base_url: Schema.NullOr(Schema.String),
  available_variants: Schema.Array(CardVariant),
  cardmarket_product_id: Schema.NullOr(Schema.Int),
  cardmarket_url: Schema.NullOr(Schema.String),
});
export type CatalogCard = typeof CatalogCard.Type;

// ---------------------------------------------------------------------------
// Pure helpers (TCGdex payload → catalog rows)
// ---------------------------------------------------------------------------

const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * Normalizes a raw TCGdex category (FR or EN) to the SQL enum value.
 *
 * - `"Pokémon"` / `"Pokemon"` / `"pokemon"` → `"Pokemon"`
 * - `"Dresseur"` / `"Trainer"` → `"Trainer"`
 * - `"Énergie"` / `"Energie"` / `"Energy"` → `"Energy"`
 * - anything else (including `undefined`) → `"Pokemon"` (SQL DEFAULT)
 */
export const normalizeCatalogCategory = (raw: string | undefined): CatalogCategory => {
  if (raw === undefined) return "Pokemon";
  const value = fold(raw);
  if (value === "pokemon") return "Pokemon";
  if (value === "trainer" || value === "dresseur") return "Trainer";
  if (value === "energy" || value === "energie") return "Energy";
  return "Pokemon";
};

/**
 * Extracts the numeric part of a TCGdex `localId` for natural sorting.
 *
 * - `"199"` → `199`, `"006"` → `6`
 * - `"TG01"` → `1`, `"SV025"` → `25` (trailing digit run of a prefixed id)
 * - `"ABC"` → `null`
 */
export const parseLocalIdNumeric = (localId: string): number | null => {
  const match = /(\d+)\s*$/.exec(localId.trim());
  if (match === null) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(value) ? value : null;
};

/** Shape of the TCGdex v2 `variants` summary object of a card. */
export interface TcgdexVariants {
  readonly normal?: boolean | undefined;
  readonly reverse?: boolean | undefined;
  readonly holo?: boolean | undefined;
  readonly firstEdition?: boolean | undefined;
  readonly wPromo?: boolean | undefined;
}

/**
 * Maps the TCGdex `variants` summary to the SQL `available_variants` array.
 *
 * Only `normal`, `reverse`, `holo` and `wPromo` (→ `"promo"`) are mapped:
 * `firstEdition` printings are ignored because the CHECK constraint has no
 * first-edition variant and they are not promos. The result is deduplicated
 * and sorted in {@link CARD_VARIANT_ORDER} order so it is stable across syncs
 * (idempotent upserts).
 */
export const extractAvailableVariants = (
  variants?: TcgdexVariants | undefined,
): ReadonlyArray<CardVariant> => {
  if (variants === undefined) return [];
  const selected = new Set<CardVariant>();
  if (variants.normal === true) selected.add("normal");
  if (variants.reverse === true) selected.add("reverse");
  if (variants.holo === true) selected.add("holo");
  if (variants.wPromo === true) selected.add("promo");
  return CARD_VARIANT_ORDER.filter((variant) => selected.has(variant));
};

/**
 * Input of {@link detectIsTera}: the text fields of a TCGdex card that can
 * carry the Téracristal / Terastallized marker.
 */
export interface TeraDetectionInput {
  readonly name?: string | undefined;
  readonly stage?: string | undefined;
  readonly subtype?: string | undefined;
  readonly suffix?: string | undefined;
  readonly description?: string | undefined;
  readonly abilities?: ReadonlyArray<TeraTextEntry | undefined> | undefined;
  readonly attacks?: ReadonlyArray<TeraTextEntry | undefined> | undefined;
}

/** Ability / attack entry of a TCGdex card (only the text fields matter here). */
export interface TeraTextEntry {
  readonly type?: string | undefined;
  readonly name?: string | undefined;
  readonly effect?: string | undefined;
}

// Word-boundary match on "tera" / "téra" and its compounds (téracristal,
// téracristallisé, teracrystal, terastal, terastallized...). "Terapagos" does
// NOT match.
const TERA_PATTERN = /\bt[ée]ra(?:cristal\w*|crystal\w*|stal\w*)?\b/i;

/**
 * Detects Téracristal / Tera cards (e.g. `Orbe Téracristal`, `Tera Orb`,
 * Terastallized Pokémon ex) from the card name, stage, subtype, suffix,
 * description or the effect text of its abilities / attacks. Used to feed
 * `deriveHoloEffect({ rarity, variant, isTera })` with the `tera` preset.
 */
export const detectIsTera = (card: TeraDetectionInput): boolean => {
  const texts: Array<string | undefined> = [
    card.name,
    card.stage,
    card.subtype,
    card.suffix,
    card.description,
  ];
  for (const ability of card.abilities ?? []) {
    texts.push(ability?.name, ability?.effect);
  }
  for (const attack of card.attacks ?? []) {
    texts.push(attack?.name, attack?.effect);
  }
  return texts.some((text) => text !== undefined && TERA_PATTERN.test(text));
};

/**
 * Normalizes the `cardCount` of a TCGdex set so the SQL
 * `CHECK (total_count >= official_count)` can never be violated:
 * `total = Math.max(total, official)`.
 */
export const normalizeSetCounts = (
  officialCount: number,
  totalCount: number,
): { readonly official_count: number; readonly total_count: number } => ({
  official_count: Math.max(0, Math.trunc(officialCount)),
  total_count: Math.max(Math.max(0, Math.trunc(officialCount)), Math.trunc(totalCount)),
});
