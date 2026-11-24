/**
 * Client de l'écran Collection (`02` & `02B`) : appels `/api/binders` et
 * helpers purs (validation du titre, filtre des extensions à suivre, URL de
 * cover). Module CLIENT-SAFE : il n'importe que des types / helpers purs de
 * `@pokevault/domain` (jamais `@pokevault/services`, `postgres` ni `node:*` —
 * l'accès base vit dans `binders-server.ts`).
 */

import {
  BINDER_TITLE_MAX_LENGTH,
  type Binder,
  type BinderSummary,
  type CollectionOverview,
  normalizeBinderTitle,
} from "@pokevault/domain";
import type { FetchLike } from "./search-client.ts";

export type { FetchLike };

export const COLLECTION_PATH = "/collection";
export const BINDERS_API_PATH = "/api/binders";

// ---------------------------------------------------------------------------
// Payloads (JSON entre `/api/binders` et l'écran Collection)
// ---------------------------------------------------------------------------

/** Extension du catalogue proposée par la feuille « Suivre une extension ». */
export interface CatalogSetEntry {
  readonly id: string;
  readonly code: string | null;
  readonly nameFr: string;
  readonly logoUrl: string | null;
  readonly seriesId: string;
  readonly seriesNameFr: string;
  readonly seriesReleaseOrder: number;
  readonly releaseDate: string | null;
  readonly officialCount: number;
  readonly totalCount: number;
}

/** Réponse de `GET /api/binders`. */
export interface BindersPayload {
  readonly binders: ReadonlyArray<BinderSummary>;
  readonly overview: CollectionOverview;
  /**
   * `image_base_url` TCGdex de la carte de couverture, par `coverCardId`
   * (`null` si la carte n'a pas d'image).
   */
  readonly coverCardImageById: Readonly<Record<string, string | null>>;
  /** Catalogue des extensions (récentes d'abord), pour la feuille de suivi. */
  readonly catalogSets: ReadonlyArray<CatalogSetEntry>;
}

// ---------------------------------------------------------------------------
// Helpers purs
// ---------------------------------------------------------------------------

/**
 * URL du proxy de cover uploadée. `?v=<updatedAt>` casse le cache navigateur
 * (`private, max-age=3600`) dès que le classeur est modifié (nouvelle cover).
 */
export const binderCoverUrl = (binder: Pick<Binder, "id" | "updatedAt">): string =>
  `${BINDERS_API_PATH}/${binder.id}/cover?v=${encodeURIComponent(binder.updatedAt)}`;

export type FolderTitleCheck =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: "empty" | "too_long" };

/** Valide le titre d'un dossier perso (1..80 caractères après normalisation). */
export const validateFolderTitle = (raw: string): FolderTitleCheck => {
  const title = normalizeBinderTitle(raw);
  if (title === "") return { ok: false, reason: "empty" };
  if (title.length > BINDER_TITLE_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, title };
};

const fold = (value: string): string =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Extensions du catalogue pas encore suivies, filtrées (insensible à la casse
 * et aux accents) sur le nom, le code ou le bloc. L'ordre du catalogue
 * (récentes d'abord) est conservé.
 */
export const filterTrackableSets = (
  catalogSets: ReadonlyArray<CatalogSetEntry>,
  trackedSetIds: ReadonlySet<string>,
  query: string,
): ReadonlyArray<CatalogSetEntry> => {
  const needle = fold(query);
  return catalogSets.filter((set) => {
    if (trackedSetIds.has(set.id)) return false;
    if (needle === "") return true;
    return [set.nameFr, set.code ?? "", set.id, set.seriesNameFr].some((field) =>
      fold(field).includes(needle),
    );
  });
};

/** Identifiants des extensions déjà suivies (classeurs `kind = 'set'`). */
export const trackedSetIdsOf = (binders: ReadonlyArray<BinderSummary>): ReadonlySet<string> =>
  new Set(
    binders.flatMap(({ binder }) =>
      binder.kind === "set" && binder.setId !== null ? [binder.setId] : [],
    ),
  );

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type BindersResult =
  | { readonly kind: "ok"; readonly data: BindersPayload }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export const fetchBinders = async (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<BindersResult> => {
  try {
    const response = await fetchImpl(BINDERS_API_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", data: (await response.json()) as BindersPayload };
  } catch (error) {
    // Une requête annulée (AbortController) doit rester silencieuse pour l'appelant.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

export type CreateBinderInput =
  | { readonly kind: "set"; readonly setId: string; readonly title?: string | undefined }
  | { readonly kind: "custom"; readonly title: string; readonly isPinned?: boolean | undefined };

export type CreateBinderResult =
  | { readonly kind: "ok"; readonly summary: BinderSummary }
  | { readonly kind: "unauthorized" }
  /** `400` : payload refusé par le domaine. */
  | { readonly kind: "invalid" }
  /** `404` : extension introuvable dans le catalogue. */
  | { readonly kind: "not_found" }
  /** `409` : classeur déjà existant (ex. extension déjà suivie). */
  | { readonly kind: "conflict" }
  | { readonly kind: "error" };

export const createBinder = async (
  input: CreateBinderInput,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CreateBinderResult> => {
  try {
    const response = await fetchImpl(BINDERS_API_PATH, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
    switch (response.status) {
      case 201:
      case 200:
        return { kind: "ok", summary: (await response.json()) as BinderSummary };
      case 401:
        return { kind: "unauthorized" };
      case 400:
        return { kind: "invalid" };
      case 404:
        return { kind: "not_found" };
      case 409:
        return { kind: "conflict" };
      default:
        return { kind: "error" };
    }
  } catch {
    return { kind: "error" };
  }
};

export type SubmitFolderResult =
  | CreateBinderResult
  | { readonly kind: "invalid_title"; readonly reason: "empty" | "too_long" };

/** Valide puis crée un dossier perso (aucun appel réseau si le titre est invalide). */
export const submitCustomFolder = async (
  rawTitle: string,
  isPinned: boolean,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SubmitFolderResult> => {
  const check = validateFolderTitle(rawTitle);
  if (!check.ok) return { kind: "invalid_title", reason: check.reason };
  return createBinder({ kind: "custom", title: check.title, isPinned }, fetchImpl);
};

/** Suit une extension du catalogue (classeur `kind = 'set'`). */
export const followSet = (
  setId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CreateBinderResult> => createBinder({ kind: "set", setId }, fetchImpl);
