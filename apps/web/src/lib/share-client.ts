/**
 * Client du partage lecture seule (écrans `09C–09D` · Vue publique `/s/$token` et gestion des
 * liens dans `09B` / `03`) : chemins d'API, types des payloads JSON, filtres purs de la vue
 * publique et fetch typés.
 *
 * Module CLIENT-SAFE : il n'importe que des types / helpers purs de `@pokevault/domain`
 * (jamais `@pokevault/services`, `postgres` ni `node:*` — l'accès base vit dans
 * `share-server.ts`, module serveur uniquement).
 */

import {
  isValidShareToken,
  type SharedBinderCard,
  type SharedBinderPayload,
  type ShareLink,
} from "@pokevault/domain";
import type { FetchLike } from "./search-client.ts";

export type { FetchLike };

export const SHARE_LINKS_API_PATH = "/api/share-links";
export const SHARED_BINDER_API_PREFIX = "/api/shared";
export const SHARED_PAGE_PREFIX = "/s";

// ---------------------------------------------------------------------------
// Chemins & URL
// ---------------------------------------------------------------------------

/** `GET /api/shared/<token>` (public, sans session). */
export const sharedBinderApiPath = (token: string): string =>
  `${SHARED_BINDER_API_PREFIX}/${encodeURIComponent(token)}`;

/** `GET /api/shared/<token>/cover` : cover uploadée proxifiée (public, sans session). */
export const sharedBinderCoverPath = (token: string): string =>
  `${sharedBinderApiPath(token)}/cover`;

/** Chemin de la page publique `/s/<token>`. */
export const sharedPagePath = (token: string): string =>
  `${SHARED_PAGE_PREFIX}/${encodeURIComponent(token)}`;

/** URL complète à copier (`<origine>/s/<token>`) ; chemin relatif sans origine connue. */
export const sharedPageUrl = (origin: string | null | undefined, token: string): string =>
  `${(origin ?? "").replace(/\/+$/, "")}${sharedPagePath(token)}`;

/** `PATCH` / `DELETE /api/share-links/<id>`. */
export const shareLinkApiPath = (linkId: string): string =>
  `${SHARE_LINKS_API_PATH}/${encodeURIComponent(linkId)}`;

// ---------------------------------------------------------------------------
// Payloads propriétaire (`/api/share-links`)
// ---------------------------------------------------------------------------

/**
 * Lien de partage vu par son PROPRIÉTAIRE : jamais le `userId` (inutile au navigateur). Le jeton
 * est un secret que seul le propriétaire connaît (nécessaire pour copier l'URL).
 */
export type ShareLinkEntry = Omit<ShareLink, "userId"> & {
  /** Titre du classeur partagé (`null` si le classeur a disparu). */
  readonly binderTitle: string | null;
};

/** Réponse de `GET /api/share-links`. */
export interface ShareLinksPayload {
  readonly links: ReadonlyArray<ShareLinkEntry>;
  /** Nom d'affichage visible publiquement (`null` : repli « Collectionneur » côté public). */
  readonly owner: { readonly displayName: string | null };
}

export type ShareLinksResult =
  | { readonly kind: "ok"; readonly payload: ShareLinksPayload }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

export type ShareLinkResult =
  | { readonly kind: "ok"; readonly link: ShareLinkEntry }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/** Les liens actifs (non révoqués), du plus récent au plus ancien (ordre serveur conservé). */
export const activeShareLinks = (
  links: ReadonlyArray<ShareLinkEntry>,
): ReadonlyArray<ShareLinkEntry> =>
  links.filter((link) => link.isActive && link.revokedAt === null);

/** Date courte `fr-FR` (`12 mars 2026`) d'un horodatage ISO ; chaîne vide si illisible. */
export const formatShareDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
};

const requestJson = async (
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> =>
  fetchImpl(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    credentials: "same-origin",
  });

export const fetchShareLinks = async (
  options: {
    readonly binderId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
  fetchImpl: FetchLike = defaultFetch,
): Promise<ShareLinksResult> => {
  const query =
    options.binderId === undefined
      ? ""
      : `?${new URLSearchParams({ binderId: options.binderId }).toString()}`;
  try {
    const response = await requestJson(
      `${SHARE_LINKS_API_PATH}${query}`,
      { method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }) },
      fetchImpl,
    );
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", payload: (await response.json()) as ShareLinksPayload };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { kind: "error" };
  }
};

const readLinkResponse = async (response: Response): Promise<ShareLinkResult> => {
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 404) return { kind: "not-found" };
  if (!response.ok) return { kind: "error" };
  const body = (await response.json()) as { readonly link: ShareLinkEntry };
  return { kind: "ok", link: body.link };
};

const mutateLink = async (
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  fetchImpl: FetchLike,
): Promise<ShareLinkResult> => {
  try {
    const response = await requestJson(
      url,
      {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
      },
      fetchImpl,
    );
    return await readLinkResponse(response);
  } catch {
    return { kind: "error" };
  }
};

/** Crée un NOUVEAU lien de partage pour un classeur du propriétaire. */
export const createShareLink = (
  input: { readonly binderId: string; readonly showQuantities?: boolean | undefined },
  fetchImpl: FetchLike = defaultFetch,
): Promise<ShareLinkResult> =>
  mutateLink(
    SHARE_LINKS_API_PATH,
    "POST",
    {
      binderId: input.binderId,
      ...(input.showQuantities === undefined ? {} : { showQuantities: input.showQuantities }),
    },
    fetchImpl,
  );

/** Montre / masque les quantités (doublons) sur la page publique. */
export const updateShareLinkQuantities = (
  linkId: string,
  showQuantities: boolean,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ShareLinkResult> =>
  mutateLink(shareLinkApiPath(linkId), "PATCH", { showQuantities }, fetchImpl);

/** Révoque immédiatement et définitivement le lien. */
export const revokeShareLink = (
  linkId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ShareLinkResult> => mutateLink(shareLinkApiPath(linkId), "DELETE", undefined, fetchImpl);

// ---------------------------------------------------------------------------
// Vue publique (`GET /api/shared/<token>`)
// ---------------------------------------------------------------------------

export type SharedBinderResult =
  | { readonly kind: "ok"; readonly payload: SharedBinderPayload }
  | { readonly kind: "not-found" }
  | { readonly kind: "error" };

/**
 * Charge le classeur partagé. Jeton mal formé → `not-found` SANS appel réseau (même écran qu'un
 * lien révoqué : aucune distinction).
 */
export const fetchSharedBinder = async (
  token: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SharedBinderResult> => {
  if (!isValidShareToken(token)) return { kind: "not-found" };
  try {
    const response = await fetchImpl(sharedBinderApiPath(token), {
      method: "GET",
      headers: { Accept: "application/json" },
      // Page publique : aucune session, aucun cookie.
      credentials: "omit",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", payload: (await response.json()) as SharedBinderPayload };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { kind: "error" };
  }
};

// ---------------------------------------------------------------------------
// Filtres & badges de la vue publique (docs/01 §10 : Toutes · Doublons · Manquantes)
// ---------------------------------------------------------------------------

export type SharedBinderFilter = "all" | "duplicates" | "missing";

export const SHARED_BINDER_FILTERS: ReadonlyArray<SharedBinderFilter> = [
  "all",
  "duplicates",
  "missing",
];

/** Doublon = au moins 2 exemplaires ET quantités visibles (jamais déduit si masquées). */
export const isSharedDuplicate = (card: SharedBinderCard, showQuantities: boolean): boolean =>
  showQuantities && card.owned && card.quantity !== null && card.quantity >= 2;

export const filterSharedCards = (
  cards: ReadonlyArray<SharedBinderCard>,
  filter: SharedBinderFilter,
  showQuantities: boolean,
): ReadonlyArray<SharedBinderCard> => {
  switch (filter) {
    case "duplicates":
      return cards.filter((card) => isSharedDuplicate(card, showQuantities));
    case "missing":
      return cards.filter((card) => !card.owned);
    default:
      return cards;
  }
};

export const countSharedFilter = (
  cards: ReadonlyArray<SharedBinderCard>,
  filter: SharedBinderFilter,
  showQuantities: boolean,
): number => filterSharedCards(cards, filter, showQuantities).length;

/**
 * Badge `×N` d'une tuile : uniquement si les quantités sont visibles ET `N >= 2` (jamais de
 * quantité quand le propriétaire les masque).
 */
export const sharedCardBadge = (card: SharedBinderCard, showQuantities: boolean): number | null =>
  isSharedDuplicate(card, showQuantities) ? card.quantity : null;

/** Pourcentage de complétion arrondi (0 si le classeur est vide). */
export const sharedCompletionPercent = (ownedCount: number, totalCards: number): number =>
  totalCards <= 0 ? 0 : Math.min(100, Math.round((ownedCount / totalCards) * 100));

// ---------------------------------------------------------------------------
// Presse-papiers (« Copier en 1 tap »)
// ---------------------------------------------------------------------------

/** Sous-ensemble de `navigator.clipboard` (injectable pour les tests). */
export interface ClipboardLike {
  readonly writeText: (text: string) => Promise<void>;
}

/** Copie `text` ; `false` si l'API est absente ou refusée (jamais d'exception). */
export const copyToClipboard = async (
  text: string,
  clipboard: ClipboardLike | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.clipboard,
): Promise<boolean> => {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
