/**
 * Client de l'écran `03 · Grille Classeur` (`/binder/$id`) : types du payload
 * `/api/binder-grid/$id`, filtres purs (rapides & avancés), facettes, découpage
 * en rangées de 3 colonnes pour `@tanstack/react-virtual`, et fetch typé.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de `@pokevault/domain`
 * (jamais `@pokevault/services`, `postgres` ni `node:*` — l'accès base vit dans
 * `binder-grid-server.ts`, module serveur uniquement).
 */

import type { CardLanguage, CardVariant } from "@pokevault/domain";
import type { CardDetailPrice } from "./card-detail-client.ts";

// ---------------------------------------------------------------------------
// Payload (JSON entre `/api/binder-grid/$id` et l'écran 03)
// ---------------------------------------------------------------------------

/** Exemplaire possédé exposé par la grille (champs non privés uniquement). */
export interface BinderGridCopy {
  readonly id: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: string;
  readonly quantity: number;
  readonly gradingCompany: string | null;
  readonly gradingScore: string | null;
}

/**
 * Dernier prix Cardmarket connu d'une carte du classeur (centimes d'euro, `null` =
 * non coté). La fraîcheur est calculée côté client (`computePriceFreshness`).
 */
export type BinderGridPrice = Omit<CardDetailPrice, "isFresh">;

/** Carte du classeur + agrégation de possession de l'utilisateur courant. */
export interface BinderGridCard {
  readonly id: string;
  readonly setId: string;
  readonly localId: string;
  readonly localIdNumeric: number | null;
  readonly nameFr: string;
  readonly rarity: string | null;
  /** Types de la carte (ex. `["Feu"]`), utilisés par le filtre avancé « type ». */
  readonly types: ReadonlyArray<string>;
  /** Base d'image TCGdex (sans suffixe) ; l'UI ajoute `/low.webp` via `tcgdexCardImageUrl`. */
  readonly imageBaseUrl: string | null;
  /** `true` si la carte est en wishlist (rempli par M3 ; `false` tant que la table n'existe pas). */
  readonly inWishlist: boolean;
  /** Somme des quantités des exemplaires de l'utilisateur. */
  readonly totalQuantity: number;
  /** Langues distinctes possédées (ordre canonique FR, EN, JP, ZH). */
  readonly languages: ReadonlyArray<CardLanguage>;
  /** Variantes distinctes possédées (ordre canonique du catalogue). */
  readonly variants: ReadonlyArray<CardVariant>;
  /** Exemplaires détaillés (sans prix d'achat ni notes, strictement privés). */
  readonly copies: ReadonlyArray<BinderGridCopy>;
  /**
   * Dernier prix connu de la carte : snapshot de la langue/variante possédée
   * (FR / normal d'abord), sinon `(FR, normal)`, sinon le plus récent. `null`
   * sans snapshot ; absent d'un ancien payload.
   */
  readonly price?: BinderGridPrice | null | undefined;
}

/** Statistiques de complétion affichées dans la barre 1 ligne. */
export interface BinderGridStats {
  readonly cardCount: number;
  readonly ownedCount: number;
  /** Pourcentage entier 0..100 (`computePercent` / `computeSetCompletion`). */
  readonly percent: number;
  readonly totalCopies: number;
  /** Cartes distinctes possédées en `>= 2` exemplaires. */
  readonly duplicateCardCount: number;
  /**
   * Valeur réelle du classeur en centimes : somme `quantité × prix` de chaque exemplaire
   * possédé (prix de sa langue/variante, sinon prix de la carte). `null` quand aucun
   * exemplaire possédé n'a de prix.
   */
  readonly totalValueCents?: number | null | undefined;
}

export interface BinderGridBinderInfo {
  readonly id: string;
  readonly title: string;
  readonly kind: "set" | "custom";
  readonly setId: string | null;
  readonly setCode: string | null;
  readonly setNameFr: string | null;
  readonly stats: BinderGridStats;
}

/**
 * Payload de `GET /api/binder-grid/$id`. `binder: null` = payload vide documenté
 * (ex. `DATABASE_URL` absent en dev) ou classeur introuvable côté client.
 */
export interface BinderGridPayload {
  readonly binder: BinderGridBinderInfo | null;
  readonly cards: ReadonlyArray<BinderGridCard>;
}

/** Payload vide documenté, renvoyé sans base configurée (jamais de 500). */
export const emptyBinderGridPayload: BinderGridPayload = { binder: null, cards: [] };

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

/** Filtres rapides de la barre de défilement horizontal (`aria-pressed`). */
export type BinderGridQuickFilter = "all" | "owned" | "missing" | "duplicates" | "wishlist";

/** Filtres avancés (rareté, type, langue possédée, variante possédée). */
export interface BinderGridAdvancedFilters {
  readonly rarity?: string | null | undefined;
  readonly type?: string | null | undefined;
  readonly language?: CardLanguage | null | undefined;
  readonly variant?: CardVariant | null | undefined;
}

/** `true` si au moins un filtre avancé est actif. */
export const hasActiveAdvancedFilters = (filters: BinderGridAdvancedFilters): boolean =>
  filters.rarity != null ||
  filters.type != null ||
  filters.language != null ||
  filters.variant != null;

/**
 * Filtre les cartes du classeur : filtre rapide (`owned` = `totalQuantity >= 1`,
 * `missing` = `totalQuantity === 0`, `duplicates` = `>= 2`, `wishlist` =
 * `inWishlist`) puis filtres avancés (rareté exacte, type contenu, langue et
 * variante **possédées**). L'ordre d'entrée est conservé.
 */
export const filterBinderGridCards = (
  cards: ReadonlyArray<BinderGridCard>,
  quickFilter: BinderGridQuickFilter,
  advanced: BinderGridAdvancedFilters = {},
): ReadonlyArray<BinderGridCard> => {
  let result = cards;
  switch (quickFilter) {
    case "owned":
      result = result.filter((card) => card.totalQuantity >= 1);
      break;
    case "missing":
      result = result.filter((card) => card.totalQuantity === 0);
      break;
    case "duplicates":
      result = result.filter((card) => card.totalQuantity >= 2);
      break;
    case "wishlist":
      result = result.filter((card) => card.inWishlist);
      break;
    case "all":
      break;
  }
  if (advanced.rarity != null) result = result.filter((card) => card.rarity === advanced.rarity);
  if (advanced.type != null) {
    const type = advanced.type;
    result = result.filter((card) => card.types.includes(type));
  }
  if (advanced.language != null) {
    const language = advanced.language;
    result = result.filter((card) => card.languages.includes(language));
  }
  if (advanced.variant != null) {
    const variant = advanced.variant;
    result = result.filter((card) => card.variants.includes(variant));
  }
  return result;
};

/** Compte les cartes par filtre rapide (filtres avancés ignorés). */
export const countBinderGridQuickFilter = (
  cards: ReadonlyArray<BinderGridCard>,
  quickFilter: BinderGridQuickFilter,
): number => filterBinderGridCards(cards, quickFilter).length;

// ---------------------------------------------------------------------------
// Facettes
// ---------------------------------------------------------------------------

export interface BinderGridFacets {
  /** Raretés présentes dans le classeur (triées, dédupliquées, `null` exclu). */
  readonly rarities: ReadonlyArray<string>;
  /** Types présents dans le classeur (triés, dédupliqués). */
  readonly types: ReadonlyArray<string>;
}

const byFr = (a: string, b: string): number => a.localeCompare(b, "fr");

/** Extrait les facettes filtrables (raretés & types) des cartes du classeur. */
export const extractBinderFilterFacets = (
  cards: ReadonlyArray<BinderGridCard>,
): BinderGridFacets => ({
  rarities: [...new Set(cards.flatMap((card) => (card.rarity === null ? [] : [card.rarity])))].sort(
    byFr,
  ),
  types: [...new Set(cards.flatMap((card) => card.types))].sort(byFr),
});

// ---------------------------------------------------------------------------
// Grille 3 colonnes
// ---------------------------------------------------------------------------

/** Nombre de colonnes de la grille virtualisée (mobile-first 390px). */
export const BINDER_GRID_COLUMNS = 3;

/**
 * Découpe une liste en rangées de `columns` éléments (3 par défaut) pour
 * `@tanstack/react-virtual` : la virtualisation porte sur les rangées, pas sur
 * les cartes. La dernière rangée peut être incomplète.
 */
export const chunkIntoRows = <T>(
  items: ReadonlyArray<T>,
  columns: number = BINDER_GRID_COLUMNS,
): ReadonlyArray<ReadonlyArray<T>> => {
  const safeColumns = Math.max(1, Math.trunc(columns));
  const rows: Array<Array<T>> = [];
  for (let index = 0; index < items.length; index += safeColumns) {
    rows.push(items.slice(index, index + safeColumns));
  }
  return rows;
};

// ---------------------------------------------------------------------------
// État de tuile
// ---------------------------------------------------------------------------

/** État d'affichage d'une tuile, dérivé de la quantité possédée. */
export type BinderCardTileState =
  | { readonly state: "missing" }
  | { readonly state: "owned" }
  | { readonly state: "duplicate"; readonly count: number };

/**
 * `0` → `missing`, `1` → `owned`, `>= 2` → `duplicate` avec le compteur `×N`.
 * Les quantités négatives sont traitées comme `missing`.
 */
export const cardTileStateFor = (totalQuantity: number): BinderCardTileState => {
  if (!(totalQuantity >= 1)) return { state: "missing" };
  if (totalQuantity === 1) return { state: "owned" };
  return { state: "duplicate", count: totalQuantity };
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type BinderGridApiResult =
  | { readonly kind: "ok"; readonly payload: BinderGridPayload }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Chemin de l'API grille classeur (`$id` échappé). */
export const binderGridApiPath = (binderId: string): string =>
  `/api/binder-grid/${encodeURIComponent(binderId)}`;

/** Lien vers la saisie rafale d'une extension (`/burst?setId=…`, livrée par T5.2/T5.3). */
export const burstPathForSetId = (setId: string): string =>
  `/burst?${new URLSearchParams({ setId }).toString()}`;

/**
 * `GET /api/binder-grid/$id` : 401 → `unauthorized`, 404 → `not-found`,
 * autre erreur réseau/HTTP → `error`, 200 → payload décodé (jamais levé).
 */
export const fetchBinderGrid = async (
  binderId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<BinderGridApiResult> => {
  try {
    const response = await fetchImpl(binderGridApiPath(binderId), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", payload: (await response.json()) as BinderGridPayload };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};
