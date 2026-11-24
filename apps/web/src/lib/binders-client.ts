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
  COVER_MAX_BYTES,
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
// Filtres & tri (bottom sheet 02C) — fonctions pures
// ---------------------------------------------------------------------------

/** Tris de la grille 2×2 du bottom sheet `02C`. */
export type CollectionSort = "completion_desc" | "value_desc" | "release_date_desc" | "name_asc";

export const COLLECTION_SORTS: ReadonlyArray<CollectionSort> = [
  "completion_desc",
  "value_desc",
  "release_date_desc",
  "name_asc",
];

/** Avancement d'un classeur (`CompletionStatus` du domaine). */
export type ProgressFilter = "in_progress" | "completed" | "not_started";

export const PROGRESS_FILTERS: ReadonlyArray<ProgressFilter> = [
  "in_progress",
  "completed",
  "not_started",
];

export interface CollectionFilters {
  readonly sort: CollectionSort;
  /** Avancements retenus (multi-sélection) ; vide = tous. Classeurs d'extension uniquement. */
  readonly progress: ReadonlyArray<ProgressFilter>;
  /** Blocs retenus (multi-sélection) ; vide = tous. Classeurs d'extension uniquement. */
  readonly seriesIds: ReadonlyArray<string>;
  /** Masque les classeurs sans aucune carte possédée (dossier perso : sans aucune carte). */
  readonly hideEmptySets: boolean;
  /**
   * `false` : la complétion exclut les cartes secrètes et les exemplaires promo (le serveur
   * recalcule, `GET /api/binders?extras=0`). Défaut `true` (tout compte).
   */
  readonly includeSecretsAndPromos: boolean;
}

export const DEFAULT_COLLECTION_FILTERS: CollectionFilters = {
  sort: "completion_desc",
  progress: [],
  seriesIds: [],
  hideEmptySets: false,
  includeSecretsAndPromos: true,
};

/**
 * Tant que les prix Cardmarket ne sont pas synchronisés (milestone M3), aucune « valeur »
 * n'existe côté classeur : le tri `value_desc` se replie sur un ordre stable (complétion
 * décroissante, puis titre). L'UI l'indique discrètement ; passer à `true` dès qu'une valeur
 * estimée est exposée par `BinderSummary`.
 */
export const VALUE_SORT_AVAILABLE = false;

/** Nombre de filtres actifs (pastille du bouton Filtres) : le tri compte s'il n'est pas celui par défaut. */
export const countActiveCollectionFilters = (filters: CollectionFilters): number =>
  (filters.sort === DEFAULT_COLLECTION_FILTERS.sort ? 0 : 1) +
  (filters.progress.length > 0 ? 1 : 0) +
  (filters.seriesIds.length > 0 ? 1 : 0) +
  (filters.hideEmptySets ? 1 : 0) +
  (filters.includeSecretsAndPromos ? 0 : 1);

/** Ajoute ou retire `value` d'une multi-sélection (ordre d'insertion conservé). */
export const toggleInSelection = <T>(selection: ReadonlyArray<T>, value: T): ReadonlyArray<T> =>
  selection.includes(value) ? selection.filter((entry) => entry !== value) : [...selection, value];

const progressOf = (summary: BinderSummary): ProgressFilter | null =>
  summary.completion === null ? null : summary.completion.status;

/** Classeur sans carte possédée (`0 carte`). */
const isEmptyBinder = (summary: BinderSummary): boolean =>
  summary.completion === null ? summary.cardCount === 0 : summary.completion.ownedDistinct === 0;

/** Complétion 0..100 ; dossier perso : part des cartes possédées. */
const completionPercentOf = (summary: BinderSummary): number => {
  if (summary.completion !== null) return summary.completion.percent;
  return summary.cardCount === 0 ? 0 : (summary.ownedCount / summary.cardCount) * 100;
};

const compareText = (a: string, b: string): number =>
  a.localeCompare(b, "fr", { sensitivity: "base" });

const compareByCompletion = (a: BinderSummary, b: BinderSummary): number =>
  completionPercentOf(b) - completionPercentOf(a) || compareText(a.binder.title, b.binder.title);

/** Date de sortie (extension) ou de création (dossier perso), la plus récente d'abord. */
const releaseKeyOf = (summary: BinderSummary): string =>
  summary.set?.releaseDate ?? (summary.binder.kind === "custom" ? summary.binder.createdAt : "");

const SORT_COMPARATORS: Readonly<
  Record<CollectionSort, (a: BinderSummary, b: BinderSummary) => number>
> = {
  completion_desc: compareByCompletion,
  // Repli stable tant que `VALUE_SORT_AVAILABLE` est faux (voir ci-dessus).
  value_desc: compareByCompletion,
  release_date_desc: (a, b) =>
    releaseKeyOf(b).localeCompare(releaseKeyOf(a)) || compareText(a.binder.title, b.binder.title),
  name_asc: (a, b) => compareText(a.binder.title, b.binder.title),
};

/**
 * Applique filtres puis tri à des classeurs (extensions et/ou dossiers perso). Les filtres
 * `progress` et `seriesIds` ne portent que sur les classeurs d'extension (un dossier perso n'a
 * ni bloc ni statut d'avancement : il n'est jamais exclu par eux). Les classeurs épinglés
 * restent en tête quel que soit le tri. Pur : l'entrée n'est jamais mutée.
 */
export const applyCollectionFiltersAndSort = (
  binders: ReadonlyArray<BinderSummary>,
  filters: CollectionFilters,
): ReadonlyArray<BinderSummary> => {
  const kept = binders.filter((summary) => {
    if (filters.hideEmptySets && isEmptyBinder(summary)) return false;
    if (summary.binder.kind === "set") {
      if (filters.progress.length > 0) {
        const progress = progressOf(summary);
        if (progress === null || !filters.progress.includes(progress)) return false;
      }
      if (filters.seriesIds.length > 0) {
        const seriesId = summary.set?.seriesId;
        if (seriesId === undefined || !filters.seriesIds.includes(seriesId)) return false;
      }
    }
    return true;
  });
  const compare = SORT_COMPARATORS[filters.sort];
  return [...kept].sort(
    (a, b) => Number(b.binder.isPinned) - Number(a.binder.isPinned) || compare(a, b),
  );
};

// ---------------------------------------------------------------------------
// Image de cover : validation côté client (le serveur revalide par magic bytes)
// ---------------------------------------------------------------------------

export const COVER_ACCEPTED_TYPES: ReadonlyArray<string> = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

/** Valeur de l'attribut `accept` du sélecteur de fichier (jamais de SVG). */
export const COVER_ACCEPT_ATTRIBUTE = COVER_ACCEPTED_TYPES.join(",");

export { COVER_MAX_BYTES };

export type CoverFileError = "empty" | "too_large" | "svg" | "unsupported";

export type CoverFileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CoverFileError };

/** Contrôle préalable d'un fichier choisi : ≤ 2 Mo, JPEG / PNG / WebP uniquement, SVG refusé. */
export const validateCoverFile = (file: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}): CoverFileCheck => {
  const type = file.type.toLowerCase();
  if (type === "image/svg+xml" || /\.svgz?$/i.test(file.name)) {
    return { ok: false, reason: "svg" };
  }
  if (!COVER_ACCEPTED_TYPES.includes(type)) return { ok: false, reason: "unsupported" };
  if (file.size <= 0) return { ok: false, reason: "empty" };
  if (file.size > COVER_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true };
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type BindersResult =
  | { readonly kind: "ok"; readonly data: BindersPayload }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface FetchBindersOptions {
  /** `false` : complétion hors cartes secrètes et promos (`?extras=0`). Défaut `true`. */
  readonly includeSecretsAndPromos?: boolean | undefined;
}

export const bindersListUrl = (options: FetchBindersOptions = {}): string =>
  options.includeSecretsAndPromos === false ? `${BINDERS_API_PATH}?extras=0` : BINDERS_API_PATH;

export const fetchBinders = async (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
  options: FetchBindersOptions = {},
): Promise<BindersResult> => {
  try {
    const response = await fetchImpl(bindersListUrl(options), {
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

// ---------------------------------------------------------------------------
// Réglages d'un classeur : titre / épinglage · cover · suppression
// ---------------------------------------------------------------------------

export const binderUrl = (binderId: string): string =>
  `${BINDERS_API_PATH}/${encodeURIComponent(binderId)}`;

export const binderCoverApiUrl = (binderId: string): string => `${binderUrl(binderId)}/cover`;

/** Issue d'une mutation de classeur (statuts HTTP normalisés). */
export type MutationResult<T = undefined> =
  | (T extends undefined ? { readonly kind: "ok" } : { readonly kind: "ok"; readonly data: T })
  | { readonly kind: "unauthorized" }
  /** `400` : payload refusé par le domaine. */
  | { readonly kind: "invalid" }
  /** `404` : classeur (ou carte) introuvable. */
  | { readonly kind: "not_found" }
  /** `413` : image de plus de 2 Mo. */
  | { readonly kind: "too_large" }
  /** `415` : format d'image refusé (SVG, type inconnu). */
  | { readonly kind: "unsupported" }
  | { readonly kind: "error" };

const statusToFailure = (status: number): MutationResult<never> => {
  switch (status) {
    case 401:
      return { kind: "unauthorized" };
    case 400:
      return { kind: "invalid" };
    case 404:
      return { kind: "not_found" };
    case 413:
      return { kind: "too_large" };
    case 415:
      return { kind: "unsupported" };
    default:
      return { kind: "error" };
  }
};

export type UpdateBinderPatch = {
  readonly title?: string | undefined;
  readonly isPinned?: boolean | undefined;
};

export type UpdateBinderResult = MutationResult<BinderSummary>;

/** `PATCH /api/binders/:id` (titre, épinglage). */
export const updateBinder = async (
  binderId: string,
  patch: UpdateBinderPatch,
  fetchImpl: FetchLike = defaultFetch,
): Promise<UpdateBinderResult> => {
  try {
    const response = await fetchImpl(binderUrl(binderId), {
      method: "PATCH",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(patch),
    });
    if (response.ok) return { kind: "ok", data: (await response.json()) as BinderSummary };
    return statusToFailure(response.status);
  } catch {
    return { kind: "error" };
  }
};

export type SubmitBinderInfoResult =
  | UpdateBinderResult
  | { readonly kind: "invalid_title"; readonly reason: "empty" | "too_long" };

/** Valide le titre (1..80) puis enregistre titre + épinglage ; aucun appel réseau si invalide. */
export const submitBinderInfo = async (
  binderId: string,
  rawTitle: string,
  isPinned: boolean,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SubmitBinderInfoResult> => {
  const check = validateFolderTitle(rawTitle);
  if (!check.ok) return { kind: "invalid_title", reason: check.reason };
  return updateBinder(binderId, { title: check.title, isPinned }, fetchImpl);
};

/** `DELETE /api/binders/:id` (nettoie aussi la cover Storage côté serveur). */
export const deleteBinder = async (
  binderId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult> => {
  try {
    const response = await fetchImpl(binderUrl(binderId), {
      method: "DELETE",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (response.ok) {
      void response.body?.cancel().catch(() => {});
      return { kind: "ok" };
    }
    return statusToFailure(response.status);
  } catch {
    return { kind: "error" };
  }
};

export type BinderCoverChoice =
  | { readonly type: "set_logo" }
  | { readonly type: "card"; readonly cardId: string };

export type SetCoverResult = MutationResult<BinderSummary>;

const readSummary = async (response: Response): Promise<SetCoverResult> =>
  response.ok
    ? { kind: "ok", data: (await response.json()) as BinderSummary }
    : statusToFailure(response.status);

/** `PUT /api/binders/:id/cover` — logo officiel (ou repli) ou carte du catalogue. */
export const setBinderCover = async (
  binderId: string,
  choice: BinderCoverChoice,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SetCoverResult> => {
  try {
    const response = await fetchImpl(binderCoverApiUrl(binderId), {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(choice),
    });
    return await readSummary(response);
  } catch {
    return { kind: "error" };
  }
};

export type UploadCoverResult =
  | SetCoverResult
  | { readonly kind: "invalid_file"; readonly reason: CoverFileError };

/**
 * `PUT /api/binders/:id/cover` en `multipart/form-data` (champ `image`) : le serveur
 * recompresse en WebP ≤ 600×600 sans EXIF. Validation préalable : aucun envoi si le fichier est
 * refusé. Le `Content-Type` est laissé au navigateur (frontière multipart).
 */
export const uploadBinderCover = async (
  binderId: string,
  file: File,
  fetchImpl: FetchLike = defaultFetch,
): Promise<UploadCoverResult> => {
  const check = validateCoverFile(file);
  if (!check.ok) return { kind: "invalid_file", reason: check.reason };
  try {
    const form = new FormData();
    form.set("image", file, file.name);
    const response = await fetchImpl(binderCoverApiUrl(binderId), {
      method: "PUT",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      body: form,
    });
    return await readSummary(response);
  } catch {
    return { kind: "error" };
  }
};
