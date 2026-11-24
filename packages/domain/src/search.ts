import { Effect, Schema } from "effect";
import type { HoloEffect } from "./card.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of cards returned by one `search` page. */
export const SEARCH_MAX_LIMIT = 60;
/** Default page size of `search` (3-column grid friendly). */
export const SEARCH_DEFAULT_LIMIT = 24;
/** Maximum length of the free-text query (DoS guard, one-line input). */
export const SEARCH_MAX_QUERY_LENGTH = 100;
/** Maximum number of recent searches kept (écran 05B). */
export const MAX_RECENT_SEARCHES = 8;

// ---------------------------------------------------------------------------
// Schemas (docs/01 §7, écrans 05A–05D)
// ---------------------------------------------------------------------------

/** Portée de la recherche : pills `Tout` / `Cartes` / `Extensions` / `Illustrateurs`. */
export const SearchScope = Schema.Literals(["all", "cards", "sets", "illustrators"]);
export type SearchScope = typeof SearchScope.Type;

/** Affichage des résultats : Liste (`05C`) ou Grille (`05D`). */
export const SearchViewMode = Schema.Literals(["grid", "list"]);
export type SearchViewMode = typeof SearchViewMode.Type;

/** Tri rapide des résultats. */
export const SearchSort = Schema.Literals(["relevance", "number", "name"]);
export type SearchSort = typeof SearchSort.Type;

/** Accès rapides : SIR / Secrètes, Illustration Rare, ex, Téracristal, Promos. */
export const SearchQuickAccess = Schema.Literals(["sir", "ar", "ex", "tera", "promos"]);
export type SearchQuickAccess = typeof SearchQuickAccess.Type;

/**
 * Requête de recherche du catalogue. Tous les champs ont une valeur par défaut
 * au décodage (`q: ""`, `scope: "all"`, `sort: "relevance"`, `limit: 24`,
 * `offset: 0`) ; `quickAccess` et `setId` sont absents quand le filtre est inactif.
 */
export const SearchQuery = Schema.Struct({
  q: Schema.String.check(Schema.isMaxLength(SEARCH_MAX_QUERY_LENGTH)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
  ),
  scope: SearchScope.pipe(Schema.withDecodingDefaultKey(Effect.succeed("all" as const))),
  quickAccess: Schema.optionalKey(SearchQuickAccess),
  setId: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(64))),
  sort: SearchSort.pipe(Schema.withDecodingDefaultKey(Effect.succeed("relevance" as const))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SEARCH_MAX_LIMIT })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(SEARCH_DEFAULT_LIMIT)),
  ),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
});
export type SearchQuery = typeof SearchQuery.Type;

// ---------------------------------------------------------------------------
// Payloads (JSON entre `/api/catalog/*` et l'écran de recherche)
// ---------------------------------------------------------------------------

/** Carte du catalogue telle qu'affichée par la recherche. */
export interface CardSearchHit {
  readonly id: string;
  readonly setId: string;
  readonly setName: string;
  readonly setCode: string | null;
  readonly localId: string;
  readonly localIdNumeric: number | null;
  readonly nameFr: string;
  readonly rarity: string | null;
  readonly holoEffect: HoloEffect;
  readonly illustrator: string | null;
  /** Miniature `low.webp` TCGdex (jamais d'URL brute dans l'UI) ou `null`. */
  readonly imageUrl: string | null;
}

/** Extension du catalogue telle qu'affichée par la recherche. */
export interface SetSearchHit {
  readonly id: string;
  readonly code: string | null;
  readonly nameFr: string;
  /** Logo TCGdex prêt à afficher (`.webp`) ou `null`. */
  readonly logoUrl: string | null;
  readonly releaseDate: string | null;
  readonly officialCount: number;
  readonly totalCount: number;
}

/** Écran neutre `05A` : extensions récentes + cartes phares. */
export interface SearchDiscoveryPayload {
  readonly popularSets: ReadonlyArray<SetSearchHit>;
  readonly featuredCards: ReadonlyArray<CardSearchHit>;
}

/** Suggestions live `05B` : top cartes + top extensions. */
export interface SearchSuggestionsPayload {
  readonly query: string;
  readonly cards: ReadonlyArray<CardSearchHit>;
  readonly sets: ReadonlyArray<SetSearchHit>;
}

/** Résultats `05C` / `05D`. `cards` est paginé (`limit` / `offset`) ; `sets` est plafonné. */
export interface SearchResultsPayload {
  readonly query: SearchQuery;
  readonly totalCards: number;
  readonly totalSets: number;
  readonly cards: ReadonlyArray<CardSearchHit>;
  readonly sets: ReadonlyArray<SetSearchHit>;
}

export const emptyDiscoveryPayload: SearchDiscoveryPayload = {
  popularSets: [],
  featuredCards: [],
};

export const emptySuggestionsPayload = (query: string): SearchSuggestionsPayload => ({
  query,
  cards: [],
  sets: [],
});

export const emptyResultsPayload = (query: SearchQuery): SearchResultsPayload => ({
  query,
  totalCards: 0,
  totalSets: 0,
  cards: [],
  sets: [],
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * URL d'image d'une carte TCGdex : `${imageBaseUrl}/low.webp` (miniature) ou
 * `/high.webp`. `undefined` quand la base est `null`, vide ou blanche ; les
 * slashs finaux de la base sont ignorés.
 */
export const tcgdexCardImageUrl = (
  imageBaseUrl: string | null,
  quality: "low" | "high",
): string | undefined => {
  if (imageBaseUrl === null) return undefined;
  const base = imageBaseUrl.trim().replace(/\/+$/, "");
  return base === "" ? undefined : `${base}/${quality}.webp`;
};

const IMAGE_EXTENSION = /\.(?:webp|png|jpe?g|avif)$/i;

/**
 * URL du logo d'une extension TCGdex : `catalog_sets.logo_url` est stocké sans
 * extension (`…/fr/sv/sv03.5/logo`) → ajoute `.webp`. Une URL déjà suffixée est
 * conservée telle quelle. `undefined` quand la valeur est `null` ou vide.
 */
export const tcgdexSetLogoUrl = (logoUrl: string | null): string | undefined => {
  if (logoUrl === null) return undefined;
  const base = logoUrl.trim().replace(/\/+$/, "");
  if (base === "") return undefined;
  return IMAGE_EXTENSION.test(base) ? base : `${base}.webp`;
};

/** Résultat de {@link parseCardNumberQuery}. */
export interface ParsedCardNumber {
  /** Partie numérique (`"#199"` → `199`), `null` si aucun chiffre exploitable. */
  readonly numeric: number | null;
  /** Numéro normalisé en minuscules, sans `#` ni espaces (`"# TG01"` → `"tg01"`). */
  readonly normalized: string;
}

// `#`, puis éventuellement un préfixe alphabétique court (TG, SV, GG, H…) suivi de chiffres,
// OU un nombre seul. Un mot ("Dracaufeu", "ex") n'est jamais un numéro.
const CARD_NUMBER_PATTERN = /^#?\s*([a-z]{0,4})\s*(\d{1,4})(?:\s*\/\s*\d{1,4})?$/i;

/**
 * Interprète une saisie comme numéro de carte : `"#199"` → `199`,
 * `"025"` → `25`, `"TG01"` → `1`, `"199/191"` → `199`. Les saisies qui ne sont
 * pas un numéro (`"Dracaufeu"`, `""`) renvoient `null`.
 */
export const parseCardNumberQuery = (raw: string): ParsedCardNumber | null => {
  const match = CARD_NUMBER_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const prefix = (match[1] ?? "").toLowerCase();
  const digits = match[2] ?? "";
  const numeric = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(numeric)) return null;
  return { numeric, normalized: `${prefix}${digits}` };
};

/**
 * Échappe `\`, `%` et `_` d'une saisie pour l'utiliser dans un motif
 * `ILIKE` (échappement par défaut `\`) : la saisie est toujours comparée
 * littéralement.
 */
export const escapeLikePattern = (raw: string): string => raw.replace(/[\\%_]/g, "\\$&");

// ---------------------------------------------------------------------------
// Recherches récentes (05B) — fonctions pures, persistance côté UI
// ---------------------------------------------------------------------------

/**
 * Ajoute une recherche en tête de liste : trim, ignore les chaînes vides,
 * déduplique sans tenir compte de la casse (la saisie la plus récente
 * l'emporte) et plafonne à {@link MAX_RECENT_SEARCHES}.
 */
export const addRecentSearch = (
  recents: ReadonlyArray<string>,
  raw: string,
): ReadonlyArray<string> => {
  const query = raw.trim().replace(/\s+/g, " ");
  if (query === "") return recents;
  const key = query.toLowerCase();
  return [query, ...recents.filter((entry) => entry.trim().toLowerCase() !== key)].slice(
    0,
    MAX_RECENT_SEARCHES,
  );
};

/** Retire une recherche (insensible à la casse). */
export const removeRecentSearch = (
  recents: ReadonlyArray<string>,
  raw: string,
): ReadonlyArray<string> => {
  const key = raw.trim().toLowerCase();
  return recents.filter((entry) => entry.trim().toLowerCase() !== key);
};

/** Efface tout l'historique. */
export const clearRecentSearches = (): ReadonlyArray<string> => [];
