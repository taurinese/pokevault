/**
 * Client de la Bottom Sheet `04 · Fiche Carte` : types du payload
 * `GET /api/cards/$cardId`, helpers purs (prix euros → centimes, variante
 * par défaut, formatage `fr-FR`) et appels fetch typés vers `/api/cards/*`.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de
 * `@pokevault/domain` (jamais `@pokevault/services`, `postgres` ni `node:*` —
 * l'accès base vit dans `card-detail-server.ts`, module serveur uniquement).
 */

import {
  CARD_VARIANT_ORDER,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  type UserCardCopy,
} from "@pokevault/domain";

// ---------------------------------------------------------------------------
// Payload (JSON entre `/api/cards/$cardId` et la Bottom Sheet 04)
// ---------------------------------------------------------------------------

/** Extension de la carte, aplatie depuis `catalog_sets`. */
export interface CardDetailSetInfo {
  readonly id: string;
  readonly code: string | null;
  readonly nameFr: string;
  readonly officialCount: number;
  readonly totalCount: number;
}

/** Métadonnées TCGdex complètes de la carte (jointure `catalog_cards` ⨝ `catalog_sets`). */
export interface CardDetailCard {
  readonly id: string;
  readonly setId: string;
  readonly setNameFr: string;
  readonly setCode: string | null;
  readonly officialCount: number;
  readonly totalCount: number;
  readonly localId: string;
  readonly nameFr: string;
  readonly nameEn: string | null;
  readonly rarity: string | null;
  readonly holoEffect: string;
  readonly category: string;
  readonly types: ReadonlyArray<string>;
  readonly hp: number | null;
  readonly illustrator: string | null;
  /** Base d'image TCGdex (sans suffixe) ; l'UI ajoute `/high.webp` via `tcgdexCardImageUrl`. */
  readonly imageBaseUrl: string | null;
  readonly availableVariants: ReadonlyArray<CardVariant>;
  readonly cardmarketUrl: string | null;
}

/** Dossier perso de l'utilisateur, avec flag « contient déjà la carte ». */
export interface CardDetailBinder {
  readonly id: string;
  readonly title: string;
  readonly containsCard: boolean;
}

/** Réponse de `GET /api/cards/$cardId`. */
export interface CardDetailPayload {
  readonly card: CardDetailCard;
  /** Exemplaires possédés de l'utilisateur pour cette carte (un slot par ligne). */
  readonly copies: ReadonlyArray<UserCardCopy>;
  /** Dossiers perso (`kind = 'custom'`) de l'utilisateur, triés (épinglés d'abord). */
  readonly customBinders: ReadonlyArray<CardDetailBinder>;
}

// ---------------------------------------------------------------------------
// Chemins d'API
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `GET /api/cards/$cardId` — fiche carte complète. */
export const cardDetailApiPath = (cardId: string): string =>
  `/api/cards/${encodeURIComponent(cardId)}`;

/** `POST /api/cards/$cardId/copies` — ajout / incrément d'exemplaire. */
export const cardCopiesApiPath = (cardId: string): string =>
  `/api/cards/${encodeURIComponent(cardId)}/copies`;

/** `PATCH` / `DELETE /api/cards/copies/$copyId` — stepper `delta` ou édition, suppression. */
export const cardCopyApiPath = (copyId: string): string =>
  `/api/cards/copies/${encodeURIComponent(copyId)}`;

/** `POST` / `DELETE /api/cards/$cardId/binders` — ajout / retrait d'un dossier perso. */
export const cardBindersApiPath = (cardId: string): string =>
  `/api/cards/${encodeURIComponent(cardId)}/binders`;

// ---------------------------------------------------------------------------
// Helpers purs — prix
// ---------------------------------------------------------------------------

/** Prix saisi en euros → centimes entiers (`Math.round`, jamais de flottant en base). */
export const purchasePriceEurosToCents = (euros: number): number => Math.round(euros * 100);

/** Plafond défensif d'un prix saisi (1 000 000 €). */
const MAX_PURCHASE_PRICE_EUROS = 1_000_000;

export type ParsedPurchasePrice =
  | { readonly ok: true; readonly cents: number | null }
  | { readonly ok: false };

/**
 * Champ « prix d'achat (€) » → centimes. Accepte la virgule décimale
 * (`12,50`), les espaces fines et un champ vide (`cents: null` = non renseigné).
 * Toute autre valeur est invalide (`ok: false`).
 */
export const parsePurchasePriceEuros = (raw: string): ParsedPurchasePrice => {
  const normalized = raw
    .trim()
    .replace(/[\s  ]/g, "")
    .replace(",", ".");
  if (normalized === "") return { ok: true, cents: null };
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return { ok: false };
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PURCHASE_PRICE_EUROS)
    return { ok: false };
  return { ok: true, cents: purchasePriceEurosToCents(value) };
};

/** Formate des centimes en euros `fr-FR` (ex. `1250` → `12,50 €`) ; `null` si absent. */
export const formatPriceCents = (cents: number | null, locale = "fr-FR"): string | null => {
  if (cents === null) return null;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(cents / 100);
};

/** Formate une date ISO (`acquiredAt` / `createdAt`) en `fr-FR` (`31 déc. 2025`). */
export const formatIsoDate = (iso: string | null, locale = "fr-FR"): string | null => {
  if (iso === null) return null;
  // Date SQL sans heure (`YYYY-MM-DD`) : formatée en UTC pour éviter tout
  // décalage d'un jour dans les fuseaux à l'ouest d'UTC.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(utcDate.getTime())) return null;
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      utcDate,
    );
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
};

/** Vérifie qu'une URL externe utilise strictement `https:` avant injection dans `href`. */
export const isSafeHttpsUrl = (url: string | null): url is string => {
  if (url === null) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Helpers purs — variante par défaut
// ---------------------------------------------------------------------------

/**
 * Variante proposée par défaut dans le formulaire d'ajout, d'après les
 * variantes réellement disponibles pour la carte (`availableVariants`) :
 * `normal` si présent, sinon la première variante disponible dans l'ordre
 * canonique du catalogue, sinon `normal`.
 */
export const defaultVariantFor = (availableVariants: ReadonlyArray<CardVariant>): CardVariant => {
  if (availableVariants.includes("normal")) return "normal";
  const first = CARD_VARIANT_ORDER.find((variant) => availableVariants.includes(variant));
  return first ?? "normal";
};

// ---------------------------------------------------------------------------
// Corps des mutations
// ---------------------------------------------------------------------------

/** Corps de `POST /api/cards/$cardId/copies`. */
export interface AddCardCopyBody {
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity: number;
  readonly purchasePriceCents?: number | null | undefined;
  readonly notes?: string | null | undefined;
}

/** Corps de `PATCH /api/cards/copies/$copyId` (édition de champs). */
export interface UpdateCardCopyBody {
  readonly condition?: CardCondition | undefined;
  readonly purchasePriceCents?: number | null | undefined;
  readonly notes?: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Résultats d'API
// ---------------------------------------------------------------------------

export type CardDetailApiResult =
  | { readonly kind: "ok"; readonly payload: CardDetailPayload }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

export type MutationResult<T> =
  | { readonly kind: "ok"; readonly body: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
  | { readonly kind: "error" };

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const readErrorKind = (status: number): Exclude<MutationResult<never>["kind"], "ok"> => {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 400:
      return "invalid";
    case 413:
      return "too-large";
    default:
      return "error";
  }
};

/** `GET /api/cards/$cardId` : 401 → `unauthorized`, 404 → `not-found`, 200 → payload décodé. */
export const fetchCardDetail = async (
  cardId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CardDetailApiResult> => {
  try {
    const response = await fetchImpl(cardDetailApiPath(cardId), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", payload: (await response.json()) as CardDetailPayload };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

const postJson = async (
  path: string,
  method: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<Response> =>
  fetchImpl(path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });

const mutation = async <T>(
  response: Response,
  read: (body: unknown) => T,
): Promise<MutationResult<T>> => {
  if (response.status === 204) return { kind: "ok", body: read(null) };
  if (!response.ok) return { kind: readErrorKind(response.status) };
  try {
    return { kind: "ok", body: read(await response.json()) };
  } catch {
    return { kind: "error" };
  }
};

/** `POST /api/cards/$cardId/copies` → 201 + `UserCardCopy`. */
export const addCardCopy = async (
  cardId: string,
  body: AddCardCopyBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<UserCardCopy>> => {
  try {
    return await mutation(
      await postJson(cardCopiesApiPath(cardId), "POST", body, fetchImpl),
      (json) => json as UserCardCopy,
    );
  } catch {
    return { kind: "error" };
  }
};

/** Réponse du stepper `PATCH { delta }`. */
export interface AdjustCopyResult {
  readonly copy: UserCardCopy | null;
  readonly deleted: boolean;
}

/** `PATCH /api/cards/copies/$copyId` avec `{ delta }` → 200 `{ copy, deleted }`. */
export const adjustCardCopyQuantity = async (
  copyId: string,
  delta: number,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<AdjustCopyResult>> => {
  try {
    return await mutation(
      await postJson(cardCopyApiPath(copyId), "PATCH", { delta }, fetchImpl),
      (json) => json as AdjustCopyResult,
    );
  } catch {
    return { kind: "error" };
  }
};

/** `PATCH /api/cards/copies/$copyId` (édition de champs) → 200 `{ copy }`. */
export const updateCardCopy = async (
  copyId: string,
  patch: UpdateCardCopyBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<{ copy: UserCardCopy }>> => {
  try {
    return await mutation(
      await postJson(cardCopyApiPath(copyId), "PATCH", patch, fetchImpl),
      (json) => json as { copy: UserCardCopy },
    );
  } catch {
    return { kind: "error" };
  }
};

/** `DELETE /api/cards/copies/$copyId` → 204. */
export const deleteCardCopy = async (
  copyId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<null>> => {
  try {
    return await mutation(
      await postJson(cardCopyApiPath(copyId), "DELETE", {}, fetchImpl),
      () => null,
    );
  } catch {
    return { kind: "error" };
  }
};

/** `POST` (`add: true`, 201) / `DELETE` (`add: false`, 204) sur `/api/cards/$cardId/binders`. */
export const setCardInBinder = async (
  cardId: string,
  binderId: string,
  add: boolean,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<{ binderId: string; cardId: string } | null>> => {
  try {
    return await mutation(
      await postJson(cardBindersApiPath(cardId), add ? "POST" : "DELETE", { binderId }, fetchImpl),
      (json) => (json === null ? null : (json as { binderId: string; cardId: string })),
    );
  } catch {
    return { kind: "error" };
  }
};
