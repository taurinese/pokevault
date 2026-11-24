/**
 * Client de l'écran Saisie rafale (`08A` · configuration du lot) : types purs,
 * helpers de filtrage / sérialisation et appels `/api/burst/*`.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de
 * `@pokevault/domain` (jamais `@pokevault/services`, `postgres` ni `node:*` —
 * l'accès base vit dans `burst-server.ts`).
 *
 * Réf. : docs/01 §6, ADR-006.
 */

import type { BurstImportBatchInput, BurstImportReport, CardLanguage } from "@pokevault/domain";

// ---------------------------------------------------------------------------
// Types purs (configuration de l'étape 1 `08A`)
// ---------------------------------------------------------------------------

/** Mode de saisie de l'étape 2 : grille tactile (`08B`) ou pavé `#` (`08C`). */
export type BurstInputMode = "grid" | "keypad";

/** Variantes proposées par l'écran `08A` (les autres restent saisissables à la main en 08B/08C). */
export type BurstSetupVariant = "normal" | "reverse" | "holo" | "promo";

/** États proposés par l'écran `08A`. */
export type BurstSetupCondition = "NM" | "M" | "EX" | "GD";

/**
 * Une extension disponible pour la saisie rafale, telle que renvoyée par
 * `GET /api/burst/sets` (catalogue TCGdex synchronisé).
 */
export interface BurstSetOption {
  readonly id: string;
  readonly code: string | null;
  readonly nameFr: string;
  readonly seriesNameFr: string;
  readonly logoUrl: string | null;
  readonly officialCount: number;
  readonly totalCount: number;
  readonly releaseDate: string | null;
}

/** Configuration complète du lot, validée par le CTA « Démarrer la saisie ». */
export interface BurstSetupConfig {
  readonly setId: string;
  readonly language: CardLanguage;
  readonly variant: BurstSetupVariant;
  readonly condition: BurstSetupCondition;
  readonly removeFromWishlist: boolean;
  readonly mode: BurstInputMode;
}

/** Réglages par défaut de l'écran `08A` (docs/01 §6, ADR-006). */
export const DEFAULT_BURST_SETUP = {
  language: "FR",
  variant: "normal",
  condition: "NM",
  removeFromWishlist: true,
  mode: "grid",
} as const satisfies Omit<BurstSetupConfig, "setId">;

export const BURST_SETUP_LANGUAGES: ReadonlyArray<CardLanguage> = ["FR", "EN", "JP", "ZH"];

export const BURST_SETUP_VARIANTS: ReadonlyArray<BurstSetupVariant> = [
  "normal",
  "reverse",
  "holo",
  "promo",
];

export const BURST_SETUP_CONDITIONS: ReadonlyArray<BurstSetupCondition> = ["NM", "M", "EX", "GD"];

export const BURST_SETUP_MODES: ReadonlyArray<BurstInputMode> = ["grid", "keypad"];

// ---------------------------------------------------------------------------
// Recherche locale (insensible aux accents et à la casse)
// ---------------------------------------------------------------------------

/** Normalise une chaîne : accents supprimés (NFD), casse minimisée, espaces réduits. */
export const normalizeBurstText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/**
 * Filtre les extensions sur `nameFr`, `code`, `seriesNameFr` et `id`
 * (insensible aux accents / à la casse). Requête vide → liste complète.
 */
export const filterBurstSets = (
  sets: ReadonlyArray<BurstSetOption>,
  query: string,
): ReadonlyArray<BurstSetOption> => {
  const needle = normalizeBurstText(query);
  if (needle === "") return sets;
  return sets.filter((set) =>
    [set.nameFr, set.code ?? "", set.seriesNameFr, set.id].some((field) =>
      normalizeBurstText(field).includes(needle),
    ),
  );
};

// ---------------------------------------------------------------------------
// Paramètres d'URL (`?setId=sv03.5` → pré-sélection ; config → étape 2)
// ---------------------------------------------------------------------------

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const oneOf = <T extends string>(candidates: ReadonlyArray<T>, value: unknown): T | undefined =>
  isNonEmptyString(value) && (candidates as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;

/** Résultat typé de `parseBurstSearchParams` : champs reconnus uniquement. */
export interface BurstSetupSearch {
  readonly setId?: string | undefined;
  readonly language?: CardLanguage | undefined;
  readonly variant?: BurstSetupVariant | undefined;
  readonly condition?: BurstSetupCondition | undefined;
  readonly removeFromWishlist?: boolean | undefined;
  readonly mode?: BurstInputMode | undefined;
}

/** Parse et valide les paramètres d'URL de `/burst` (`?setId=sv03.5`, langues…) */
export const parseBurstSearchParams = (search: Record<string, unknown>): BurstSetupSearch => ({
  ...(isNonEmptyString(search["setId"]) ? { setId: search["setId"].trim() } : {}),
  ...(oneOf(BURST_SETUP_LANGUAGES, search["language"]) === undefined
    ? {}
    : { language: oneOf(BURST_SETUP_LANGUAGES, search["language"]) as CardLanguage }),
  ...(oneOf(BURST_SETUP_VARIANTS, search["variant"]) === undefined
    ? {}
    : { variant: oneOf(BURST_SETUP_VARIANTS, search["variant"]) as BurstSetupVariant }),
  ...(oneOf(BURST_SETUP_CONDITIONS, search["condition"]) === undefined
    ? {}
    : { condition: oneOf(BURST_SETUP_CONDITIONS, search["condition"]) as BurstSetupCondition }),
  ...(typeof search["removeFromWishlist"] === "string" &&
  ["1", "0", "true", "false"].includes(search["removeFromWishlist"])
    ? { removeFromWishlist: ["1", "true"].includes(search["removeFromWishlist"]) }
    : {}),
  ...(oneOf(BURST_SETUP_MODES, search["mode"]) === undefined
    ? {}
    : { mode: oneOf(BURST_SETUP_MODES, search["mode"]) as BurstInputMode }),
});

/** Sérialise la configuration validée en paramètres d'URL (étape 2 + partage). */
export const serializeBurstSearchParams = (config: BurstSetupConfig): URLSearchParams => {
  const params = new URLSearchParams({
    setId: config.setId,
    language: config.language,
    variant: config.variant,
    condition: config.condition,
    removeFromWishlist: config.removeFromWishlist ? "1" : "0",
    mode: config.mode,
  });
  return params;
};

// ---------------------------------------------------------------------------
// API (`/api/burst/*` — même convention que `search-client.ts`)
// ---------------------------------------------------------------------------

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

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
    // Une requête annulée (AbortController) doit remonter à l'appelant.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

const postJson = async <T>(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<ApiResult<T>> => {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", data: (await response.json()) as T };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

export interface BurstSetsPayload {
  readonly sets: ReadonlyArray<BurstSetOption>;
  readonly warning?: string | undefined;
}

/** Liste des extensions disponibles (`GET /api/burst/sets`). */
export const fetchBurstSets = (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ApiResult<BurstSetsPayload>> => getJson("/api/burst/sets", signal, fetchImpl);

/** Aperçu transactionnel d'un lot (`POST /api/burst/preview`). */
export const previewBurstImport = (
  payload: BurstImportBatchInput,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ApiResult<BurstImportReport>> =>
  postJson("/api/burst/preview", payload, signal, fetchImpl);

/** Validation transactionnelle d'un lot (`POST /api/burst/commit`). */
export const commitBurstImport = (
  payload: BurstImportBatchInput,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ApiResult<BurstImportReport>> =>
  postJson("/api/burst/commit", payload, signal, fetchImpl);
