/**
 * Client des écrans `06A–06C` (Wishlist & Export Cardmarket) : types du payload
 * `GET /api/wishlist`, helpers purs (prix effectif, seuil, fraîcheur, synthèse,
 * filtres, conversion vers le générateur d'export) et appels fetch typés vers
 * `/api/wishlist/*`.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de
 * `@pokevault/domain` (jamais `@pokevault/services`, `postgres` ni `node:*` —
 * l'accès base vit dans `wishlist-server.ts`, module serveur uniquement).
 */

import type {
  CardCondition,
  CardmarketExportEntry,
  CardmarketExportFilters,
  CardVariant,
  UserCardCopy,
  WishlistItem,
  WishlistPriority,
} from "@pokevault/domain";
import type { FetchLike, MutationResult } from "./card-detail-client.ts";

// ---------------------------------------------------------------------------
// Chemins
// ---------------------------------------------------------------------------

export const WISHLIST_PATH = "/wishlist";
export const WISHLIST_API_PATH = "/api/wishlist";

export const wishlistItemApiPath = (itemId: string): string =>
  `${WISHLIST_API_PATH}/${encodeURIComponent(itemId)}`;

export const wishlistAcquireApiPath = (itemId: string): string =>
  `${wishlistItemApiPath(itemId)}/acquire`;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Source du dernier prix connu (`price_snapshots.source`). */
export type WishlistPriceSource = "cardmarket" | "tcgdex_fallback";

/**
 * Souhait enrichi : champs `WishlistItem` + métadonnées carte / extension
 * (jointure `catalog_cards` ⨝ `catalog_sets`) + dernier prix (`card_latest_prices`,
 * `null` partout tant qu'aucun snapshot n'existe pour le slot).
 */
export interface WishlistEnrichedItem extends WishlistItem {
  readonly localId: string;
  readonly nameFr: string;
  readonly nameEn: string | null;
  readonly rarity: string | null;
  /** Base d'image TCGdex (sans suffixe) ; l'UI ajoute `/low.webp` via `tcgdexCardImageUrl`. */
  readonly imageBaseUrl: string | null;
  readonly setId: string;
  readonly setCode: string | null;
  readonly cardmarketSetCode: string | null;
  readonly setNameFr: string;
  readonly trendCents: number | null;
  readonly lowFrCents: number | null;
  readonly avg30Cents: number | null;
  readonly priceSource: WishlistPriceSource | null;
  readonly priceFetchedAt: string | null;
  readonly priceExpiresAt: string | null;
  readonly priceIsFresh: boolean | null;
}

/** Réponse de `GET /api/wishlist`. */
export interface WishlistPayload {
  readonly items: ReadonlyArray<WishlistEnrichedItem>;
}

export type WishlistFilterTab = "all" | "below_threshold" | "high_priority";

export interface WishlistSummary {
  readonly totalCount: number;
  readonly pricedCount: number;
  readonly unpricedCount: number;
  /** Somme des prix effectifs (centimes) des souhaits ayant un prix. */
  readonly estimatedTotalCents: number;
  readonly belowThresholdCount: number;
}

export interface WishlistFilters {
  readonly tab: WishlistFilterTab;
  /** `null` : toutes les extensions. */
  readonly setId: string | null;
}

export const DEFAULT_WISHLIST_FILTERS: WishlistFilters = { tab: "all", setId: null };

export interface WishlistSetOption {
  readonly id: string;
  readonly nameFr: string;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Helpers purs — prix
// ---------------------------------------------------------------------------

/** Prix de référence d'un souhait : plus bas FR, sinon tendance, sinon moyenne 30 j. */
export const effectiveWishlistPriceCents = (
  item: Pick<WishlistEnrichedItem, "lowFrCents" | "trendCents" | "avg30Cents">,
): number | null => item.lowFrCents ?? item.trendCents ?? item.avg30Cents ?? null;

/** `true` quand un prix cible est défini ET que le prix actuel l'a atteint (`<=`). */
export const isWishlistBelowThreshold = (
  item: Pick<WishlistEnrichedItem, "targetPriceCents" | "lowFrCents" | "trendCents" | "avg30Cents">,
): boolean => {
  const current = effectiveWishlistPriceCents(item);
  return item.targetPriceCents !== null && current !== null && current <= item.targetPriceCents;
};

export type WishlistFreshness = "fresh" | "aging" | "stale" | "missing";

/** Seuils de fraîcheur de docs/04 §2.1 : `< 15 min` / `15 min – 6 h` / `> 6 h`. */
export const FRESH_MAX_AGE_MS = 15 * 60 * 1000;
export const AGING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Fraîcheur du prix affiché :
 * - `missing` : aucun prix connu ;
 * - `stale` : repli TCGdex (indicatif), date illisible, ou prix de plus de 6 h ;
 * - `fresh` : source Cardmarket de moins de 15 min ;
 * - `aging` : source Cardmarket entre 15 min et 6 h.
 */
export const computeWishlistFreshness = (
  item: Pick<
    WishlistEnrichedItem,
    "lowFrCents" | "trendCents" | "avg30Cents" | "priceSource" | "priceFetchedAt"
  >,
  nowMs: number,
): WishlistFreshness => {
  if (effectiveWishlistPriceCents(item) === null) return "missing";
  if (item.priceSource !== "cardmarket" || item.priceFetchedAt === null) return "stale";
  const fetchedMs = Date.parse(item.priceFetchedAt);
  if (Number.isNaN(fetchedMs)) return "stale";
  const age = Math.max(0, nowMs - fetchedMs);
  if (age < FRESH_MAX_AGE_MS) return "fresh";
  if (age <= AGING_MAX_AGE_MS) return "aging";
  return "stale";
};

/** Âge relatif structuré d'un snapshot de prix (docs/04 §2.1 : `il y a 6 min`, `il y a 2 h`). */
export type WishlistPriceAge =
  | { readonly kind: "just_now" }
  | { readonly kind: "minutes"; readonly count: number }
  | { readonly kind: "hours"; readonly count: number }
  | { readonly kind: "days"; readonly count: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const computeWishlistPriceAge = (
  priceFetchedAt: string | null,
  nowMs: number,
): WishlistPriceAge | null => {
  if (priceFetchedAt === null) return null;
  const fetchedMs = Date.parse(priceFetchedAt);
  if (Number.isNaN(fetchedMs)) return null;
  const ageMs = Math.max(0, nowMs - fetchedMs);
  if (ageMs < MINUTE_MS) return { kind: "just_now" };
  if (ageMs < HOUR_MS) return { kind: "minutes", count: Math.floor(ageMs / MINUTE_MS) };
  if (ageMs < DAY_MS) return { kind: "hours", count: Math.floor(ageMs / HOUR_MS) };
  return { kind: "days", count: Math.floor(ageMs / DAY_MS) };
};

/** Retourne `setId` seulement s'il existe encore dans les souhaits, sinon `null`. */
export const resolveEffectiveWishlistSetId = (
  items: ReadonlyArray<WishlistEnrichedItem>,
  setId: string | null,
): string | null => (setId !== null && items.some((item) => item.setId === setId) ? setId : null);

// ---------------------------------------------------------------------------
// Helpers purs — synthèse & filtres
// ---------------------------------------------------------------------------

export const summarizeWishlist = (items: ReadonlyArray<WishlistEnrichedItem>): WishlistSummary => {
  let pricedCount = 0;
  let estimatedTotalCents = 0;
  let belowThresholdCount = 0;
  for (const item of items) {
    const price = effectiveWishlistPriceCents(item);
    if (price !== null) {
      pricedCount += 1;
      estimatedTotalCents += price;
    }
    if (isWishlistBelowThreshold(item)) belowThresholdCount += 1;
  }
  return {
    totalCount: items.length,
    pricedCount,
    unpricedCount: items.length - pricedCount,
    estimatedTotalCents,
    belowThresholdCount,
  };
};

export const filterWishlistItems = (
  items: ReadonlyArray<WishlistEnrichedItem>,
  filters: WishlistFilters,
): ReadonlyArray<WishlistEnrichedItem> =>
  items.filter((item) => {
    if (filters.setId !== null && item.setId !== filters.setId) return false;
    if (filters.tab === "below_threshold") return isWishlistBelowThreshold(item);
    if (filters.tab === "high_priority") return item.priority === "high";
    return true;
  });

/** Compteurs des onglets (`Sous seuil`, `Prioritaires`), indépendants de l'onglet actif. */
export const countWishlistTabs = (
  items: ReadonlyArray<WishlistEnrichedItem>,
): Readonly<Record<WishlistFilterTab, number>> => ({
  all: items.length,
  below_threshold: items.filter(isWishlistBelowThreshold).length,
  high_priority: items.filter((item) => item.priority === "high").length,
});

/** Extensions présentes dans la wishlist, triées par nom (`fr`), avec leur effectif. */
export const wishlistSetOptions = (
  items: ReadonlyArray<WishlistEnrichedItem>,
): ReadonlyArray<WishlistSetOption> => {
  const bySet = new Map<string, { nameFr: string; count: number }>();
  for (const item of items) {
    const entry = bySet.get(item.setId);
    if (entry === undefined) bySet.set(item.setId, { nameFr: item.setNameFr, count: 1 });
    else entry.count += 1;
  }
  return [...bySet.entries()]
    .map(([id, { nameFr, count }]) => ({ id, nameFr, count }))
    .sort((a, b) => a.nameFr.localeCompare(b.nameFr, "fr") || a.id.localeCompare(b.id));
};

// ---------------------------------------------------------------------------
// Conversion vers le générateur d'export (`@pokevault/domain/cardmarket`)
// ---------------------------------------------------------------------------

export const toCardmarketExportEntries = (
  items: ReadonlyArray<WishlistEnrichedItem>,
): ReadonlyArray<CardmarketExportEntry> =>
  items.map((item) => ({
    cardId: item.cardId,
    localId: item.localId,
    nameFr: item.nameFr,
    nameEn: item.nameEn,
    setId: item.setId,
    setCode: item.setCode,
    cardmarketSetCode: item.cardmarketSetCode,
    setNameFr: item.setNameFr,
    language: item.language,
    variant: item.variant,
    minCondition: item.minCondition,
    priority: item.priority,
    targetPriceCents: item.targetPriceCents,
    currentPriceCents: effectiveWishlistPriceCents(item),
  }));

/** Filtres d'export de la feuille `06C` (valeurs d'UI, converties par {@link toExportFilters}). */
export interface WishlistExportOptions {
  readonly scope: NonNullable<CardmarketExportFilters["scope"]>;
  readonly setId: string | null;
  readonly language: NonNullable<CardmarketExportFilters["language"]>;
  /** `null` : « Par carte » (chaque ligne garde son propre état minimum). */
  readonly minConditionOverride: CardCondition | null;
  readonly foilOnly: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: WishlistExportOptions = {
  scope: "all",
  setId: null,
  language: "ALL",
  minConditionOverride: null,
  foilOnly: false,
};

/** Convertit les options d'UI en `CardmarketExportFilters` (`exactOptionalPropertyTypes`). */
export const toExportFilters = (options: WishlistExportOptions): CardmarketExportFilters => ({
  scope: options.scope,
  ...(options.scope === "set" && options.setId !== null ? { setId: options.setId } : {}),
  language: options.language,
  ...(options.minConditionOverride === null
    ? {}
    : { minConditionOverride: options.minConditionOverride }),
  foilOnly: options.foilOnly,
});

// ---------------------------------------------------------------------------
// Fetch typé
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export type WishlistFetchResult =
  | { readonly kind: "ok"; readonly items: ReadonlyArray<WishlistEnrichedItem> }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

/** `GET /api/wishlist` : 401 → `unauthorized`, 200 → souhaits enrichis. */
export const fetchWishlist = async (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<WishlistFetchResult> => {
  try {
    const response = await fetchImpl(WISHLIST_API_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as Partial<WishlistPayload>;
    if (!Array.isArray(body.items)) return { kind: "error" };
    return { kind: "ok", items: body.items };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

const errorKind = (status: number): Exclude<MutationResult<never>["kind"], "ok"> => {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 413:
      return "too-large";
    default:
      return "error";
  }
};

const send = async <T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  read: (json: unknown) => T,
  fetchImpl: FetchLike,
): Promise<MutationResult<T>> => {
  try {
    const response = await fetchImpl(path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (response.status === 204) return { kind: "ok", body: read(null) };
    if (!response.ok) return { kind: errorKind(response.status) };
    return { kind: "ok", body: read(await response.json()) };
  } catch {
    return { kind: "error" };
  }
};

/** Corps de `POST /api/wishlist`. */
export interface AddWishlistBody {
  readonly cardId: string;
  readonly language?: WishlistItem["language"] | undefined;
  readonly variant?: CardVariant | undefined;
  readonly minCondition?: CardCondition | undefined;
  readonly priority?: WishlistPriority | undefined;
  readonly targetPriceCents?: number | null | undefined;
}

/** Corps de `PATCH /api/wishlist/$id` (au moins un champ). */
export interface UpdateWishlistBody {
  readonly language?: WishlistItem["language"] | undefined;
  readonly variant?: CardVariant | undefined;
  readonly minCondition?: CardCondition | undefined;
  readonly priority?: WishlistPriority | undefined;
  readonly targetPriceCents?: number | null | undefined;
}

/** Corps optionnel de `POST /api/wishlist/$id/acquire`. */
export interface AcquireWishlistBody {
  readonly condition?: CardCondition | undefined;
  readonly quantity?: number | undefined;
  readonly purchasePriceCents?: number | null | undefined;
  readonly notes?: string | null | undefined;
}

/** Réponse de `POST /api/wishlist/$id/acquire`. */
export interface AcquireWishlistResult {
  readonly removedWishlistItemId: string;
  readonly copy: UserCardCopy;
  readonly setBinderId: string | null;
}

/** `POST /api/wishlist` → 201 + `WishlistItem`. */
export const addWishlistItem = (
  body: AddWishlistBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<WishlistItem>> =>
  send(WISHLIST_API_PATH, "POST", body, (json) => json as WishlistItem, fetchImpl);

/** `PATCH /api/wishlist/$id` → 200 + `WishlistItem`. */
export const updateWishlistItem = (
  itemId: string,
  patch: UpdateWishlistBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<WishlistItem>> =>
  send(wishlistItemApiPath(itemId), "PATCH", patch, (json) => json as WishlistItem, fetchImpl);

/** `DELETE /api/wishlist/$id` → 204. */
export const deleteWishlistItem = (
  itemId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<null>> =>
  send(wishlistItemApiPath(itemId), "DELETE", {}, () => null, fetchImpl);

/** `POST /api/wishlist/$id/acquire` → 200 + `{ removedWishlistItemId, copy, setBinderId }`. */
export const acquireWishlistItem = (
  itemId: string,
  body: AcquireWishlistBody = {},
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<AcquireWishlistResult>> =>
  send(
    wishlistAcquireApiPath(itemId),
    "POST",
    body,
    (json) => json as AcquireWishlistResult,
    fetchImpl,
  );
