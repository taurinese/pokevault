/**
 * Client de l'écran Recherche (`05A–05D`) : appels `/api/catalog/*` et
 * persistance locale des recherches récentes. Module CLIENT-SAFE : n'importe
 * que des types / helpers purs de `@pokevault/domain` (jamais `@pokevault/services`,
 * `postgres` ni `node:*` — l'accès base vit dans `catalog-server.ts`).
 */

import {
  MAX_RECENT_SEARCHES,
  type SearchDiscoveryPayload,
  type SearchQuery,
  type SearchResultsPayload,
  type SearchSuggestionsPayload,
} from "@pokevault/domain";

// ---------------------------------------------------------------------------
// Recherches récentes (localStorage, toujours dans un try/catch)
// ---------------------------------------------------------------------------

export const RECENT_SEARCHES_STORAGE_KEY = "pokevault.search.recents";

/** Sous-ensemble de `Storage` utilisé (substituable dans les tests). */
export type RecentsStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): RecentsStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Lit l'historique ; toute erreur (stockage bloqué, JSON invalide) donne une liste vide. */
export const loadRecentSearches = (
  storage: RecentsStorage | null = browserStorage(),
): ReadonlyArray<string> => {
  if (storage === null) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_SEARCHES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
};

/** Persiste l'historique ; les échecs (quota, navigation privée) sont ignorés. */
export const saveRecentSearches = (
  recents: ReadonlyArray<string>,
  storage: RecentsStorage | null = browserStorage(),
): void => {
  if (storage === null) return;
  try {
    storage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(recents));
  } catch {
    // Persistance best-effort : l'écran reste pleinement fonctionnel sans.
  }
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const getJson = async <T>(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<ApiResult<T>> => {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", data: (await response.json()) as T };
  } catch (error) {
    // Une requête annulée (AbortController) doit rester silencieuse pour l'appelant.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

export const fetchDiscovery = (
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<ApiResult<SearchDiscoveryPayload>> =>
  getJson("/api/catalog/discover", signal, fetchImpl);

export const fetchSuggestions = (
  q: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<ApiResult<SearchSuggestionsPayload>> =>
  getJson(`/api/catalog/suggest?${new URLSearchParams({ q }).toString()}`, signal, fetchImpl);

/** Sérialise une requête en paramètres d'URL (filtres inactifs omis). */
export const searchQueryToParams = (query: SearchQuery): URLSearchParams => {
  const params = new URLSearchParams({
    q: query.q,
    scope: query.scope,
    sort: query.sort,
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.quickAccess !== undefined) params.set("quickAccess", query.quickAccess);
  if (query.setId !== undefined) params.set("setId", query.setId);
  return params;
};

export const fetchResults = (
  query: SearchQuery,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<ApiResult<SearchResultsPayload>> =>
  getJson(`/api/catalog/search?${searchQueryToParams(query).toString()}`, signal, fetchImpl);
