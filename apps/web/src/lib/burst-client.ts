/**
 * Client de l'écran Saisie rafale (`08A` configuration, `08B` grille tactile,
 * `08C` pavé `#`, `08D` grille Light) : types purs, état de session du lot
 * (ajouts, Undo, plafond 999), appariement des numéros du pavé `#`,
 * helpers de filtrage / sérialisation et appels `/api/burst/*`.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de
 * `@pokevault/domain` (jamais `@pokevault/services`, `postgres` ni `node:*` —
 * l'accès base vit dans `burst-server.ts`).
 *
 * Réf. : docs/01 §6, ADR-006.
 */

import {
  type BurstImportBatchInput,
  type BurstImportReport,
  burstSlotKey,
  CARD_VARIANT_ORDER,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  type HoloEffect,
  MAX_BURST_BATCH_ITEMS,
  MAX_CARD_COPY_QUANTITY,
  resolveBurstCardVariant,
} from "@pokevault/domain";

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

// ---------------------------------------------------------------------------
// Catalogue d'une extension (`GET /api/burst/cards?setId=…`, étape 2 `08B`–`08D`)
// ---------------------------------------------------------------------------

/** Une carte du catalogue avec la quantité déjà possédée (toutes variantes / langues). */
export interface BurstCatalogCard {
  readonly id: string;
  readonly localId: string;
  readonly localIdNumeric: number | null;
  readonly nameFr: string;
  readonly rarity: string | null;
  readonly imageBaseUrl: string | null;
  readonly availableVariants: ReadonlyArray<CardVariant>;
  readonly holoEffect: HoloEffect;
  /** Total possédé par l'utilisateur avant le lot (0 = carte nouvelle). */
  readonly ownedQuantity: number;
}

export interface BurstCardsSet {
  readonly id: string;
  readonly code: string | null;
  readonly nameFr: string;
  readonly officialCount: number;
  readonly totalCount: number;
  readonly logoUrl: string | null;
}

/** Réponse de `GET /api/burst/cards` : extension, cartes triées et classeur existant. */
export interface BurstSetCardsPayload {
  readonly set: BurstCardsSet;
  readonly cards: ReadonlyArray<BurstCatalogCard>;
  /** `binders.id` du classeur d'extension de l'utilisateur, `null` s'il n'existe pas encore. */
  readonly binderId: string | null;
}

export type BurstCardsResult = ApiResult<BurstSetCardsPayload> | { readonly kind: "not-found" };

/** Cartes d'une extension + possession de l'utilisateur (`GET /api/burst/cards`). */
export const fetchBurstSetCards = async (
  setId: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<BurstCardsResult> => {
  try {
    const response = await fetchImpl(`/api/burst/cards?${new URLSearchParams({ setId })}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", data: (await response.json()) as BurstSetCardsPayload };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};

// ---------------------------------------------------------------------------
// Paramètres modifiables à la volée (étape 2)
// ---------------------------------------------------------------------------

/** Variantes sélectionnables en cours de saisie (toutes celles du schéma). */
export const BURST_SESSION_VARIANTS: ReadonlyArray<CardVariant> = CARD_VARIANT_ORDER;

/** États sélectionnables en cours de saisie (toutes celles du schéma). */
export const BURST_SESSION_CONDITIONS: ReadonlyArray<CardCondition> = [
  "M",
  "NM",
  "EX",
  "GD",
  "LP",
  "PL",
  "PO",
];

// ---------------------------------------------------------------------------
// État pur du lot (ajouts, quantités plafonnées, Undo exact)
// ---------------------------------------------------------------------------

/** Taille maximale de la pile Undo (les plus anciennes entrées sont abandonnées). */
export const MAX_BURST_UNDO = 200;

/**
 * Une ligne du lot, indexée par `(cardId, language, variant, condition)`.
 * `explicit` : la variante a été choisie à la main (override pavé `#`) et ne
 * doit pas être réajustée par le serveur. `seq` : ordre de dernière
 * modification (ruban des ajouts récents).
 */
export interface BurstLine {
  readonly key: string;
  readonly cardId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity: number;
  readonly explicit: boolean;
  readonly seq: number;
}

/**
 * État du lot. `history` est la pile Undo : chaque entrée est l'ensemble exact
 * des lignes avant l'action, donc `undo` restaure l'état d'origine sans dérive.
 */
export interface BurstSessionState {
  readonly lines: ReadonlyArray<BurstLine>;
  readonly seq: number;
  readonly history: ReadonlyArray<ReadonlyArray<BurstLine>>;
}

export const emptyBurstSession: BurstSessionState = { lines: [], seq: 0, history: [] };

const pushHistory = (state: BurstSessionState): ReadonlyArray<ReadonlyArray<BurstLine>> =>
  [...state.history, state.lines].slice(-MAX_BURST_UNDO);

/** Exemplaires de cette carte déjà présents dans le lot (toutes lignes confondues). */
export const burstBatchQuantity = (lines: ReadonlyArray<BurstLine>, cardId: string): number =>
  lines.reduce((sum, line) => (line.cardId === cardId ? sum + line.quantity : sum), 0);

export interface BurstAddInput {
  readonly cardId: string;
  /** Possédé avant le lot (plafond 999 : possédé + lot ≤ 999 par carte). */
  readonly ownedQuantity: number;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity?: number | undefined;
  readonly explicit?: boolean | undefined;
}

/** Nombre d'exemplaires encore ajoutables à cette carte (plafond 999, `≥ 0`). */
export const burstRemainingCapacity = (
  lines: ReadonlyArray<BurstLine>,
  cardId: string,
  ownedQuantity: number,
): number =>
  Math.max(0, MAX_CARD_COPY_QUANTITY - ownedQuantity - burstBatchQuantity(lines, cardId));

/**
 * Ajoute `quantity` (1 par défaut) exemplaires. Le résultat est borné par le
 * plafond 999 (compte tenu du possédé) et par 500 lignes distinctes ; si rien
 * ne peut être ajouté, l'état **identique** (même référence) est renvoyé et
 * aucune entrée Undo n'est créée.
 */
export const addToBurstSession = (
  state: BurstSessionState,
  input: BurstAddInput,
): BurstSessionState => {
  const requested = Math.max(1, Math.trunc(input.quantity ?? 1));
  const added = Math.min(
    requested,
    burstRemainingCapacity(state.lines, input.cardId, input.ownedQuantity),
  );
  if (added <= 0) return state;
  const key = burstSlotKey(input);
  const existing = state.lines.find((line) => line.key === key);
  if (existing === undefined && state.lines.length >= MAX_BURST_BATCH_ITEMS) return state;
  const seq = state.seq + 1;
  const explicit = input.explicit ?? false;
  const lines =
    existing === undefined
      ? [
          ...state.lines,
          {
            key,
            cardId: input.cardId,
            language: input.language,
            variant: input.variant,
            condition: input.condition,
            quantity: added,
            explicit,
            seq,
          },
        ]
      : state.lines.map((line) =>
          line.key === key
            ? { ...line, quantity: line.quantity + added, explicit: line.explicit || explicit, seq }
            : line,
        );
  return { lines, seq, history: pushHistory(state) };
};

const decrementLineAt = (state: BurstSessionState, key: string): BurstSessionState => {
  const target = state.lines.find((line) => line.key === key);
  if (target === undefined) return state;
  const seq = state.seq + 1;
  const lines =
    target.quantity <= 1
      ? state.lines.filter((line) => line.key !== key)
      : state.lines.map((line) =>
          line.key === key ? { ...line, quantity: line.quantity - 1, seq } : line,
        );
  return { lines, seq, history: pushHistory(state) };
};

/** Retire 1 exemplaire de la ligne (supprime la ligne à 0) — ruban des ajouts récents. */
export const decrementBurstLine = (state: BurstSessionState, key: string): BurstSessionState =>
  decrementLineAt(state, key);

/** Retire 1 exemplaire du **dernier ajout** de cette carte (bouton `−` de la grille). */
export const decrementBurstCard = (state: BurstSessionState, cardId: string): BurstSessionState => {
  const last = state.lines
    .filter((line) => line.cardId === cardId)
    .reduce<BurstLine | undefined>(
      (best, line) => (best === undefined || line.seq > best.seq ? line : best),
      undefined,
    );
  return last === undefined ? state : decrementLineAt(state, last.key);
};

/** Annule exactement la dernière action (restaure les lignes d'avant). */
export const undoBurstSession = (state: BurstSessionState): BurstSessionState => {
  const previous = state.history[state.history.length - 1];
  return previous === undefined
    ? state
    : { lines: previous, seq: state.seq, history: state.history.slice(0, -1) };
};

export const canUndoBurstSession = (state: BurstSessionState): boolean => state.history.length > 0;

/** Lot vidé (après validation ou « Nouvelle saisie »). */
export const clearBurstSession = (): BurstSessionState => emptyBurstSession;

/** Résumé en direct du lot : `+N cartes · M nouvelles`. */
export interface BurstSessionSummary {
  readonly totalQuantity: number;
  readonly distinctCards: number;
  readonly newCards: number;
}

export const summarizeBurstSession = (
  lines: ReadonlyArray<BurstLine>,
  ownedByCard: ReadonlyMap<string, number>,
): BurstSessionSummary => {
  const cardIds = new Set(lines.map((line) => line.cardId));
  let newCards = 0;
  for (const cardId of cardIds) {
    if ((ownedByCard.get(cardId) ?? 0) === 0) newCards += 1;
  }
  return {
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    distinctCards: cardIds.size,
    newCards,
  };
};

/** Lignes du lot de la plus récente à la plus ancienne (ruban du pavé `#`). */
export const burstRecentLines = (lines: ReadonlyArray<BurstLine>): ReadonlyArray<BurstLine> =>
  [...lines].sort((a, b) => b.seq - a.seq);

/** Statut d'une tuile : `new` (jamais possédée), `duplicate` (déjà possédée) ou `none`. */
export type BurstCardStatus = "none" | "new" | "duplicate";

export const burstCardStatus = (ownedQuantity: number, batchQuantity: number): BurstCardStatus =>
  batchQuantity <= 0 ? "none" : ownedQuantity === 0 ? "new" : "duplicate";

/** Index `cardId → ownedQuantity` d'un catalogue. */
export const burstOwnedByCard = (cards: ReadonlyArray<BurstCatalogCard>): Map<string, number> =>
  new Map(cards.map((card) => [card.id, card.ownedQuantity] as const));

/** Variante effectivement enregistrée : même résolution que `BurstImportService`. */
export const resolveBurstVariantForCard = (
  card: BurstCatalogCard,
  requestedVariant: CardVariant,
  explicit: boolean,
): { readonly variant: CardVariant; readonly adjusted: boolean } =>
  resolveBurstCardVariant({
    requestedVariant,
    variantExplicit: explicit,
    availableVariants: card.availableVariants,
    holoEffect: card.holoEffect,
  });

/** Corps de `POST /api/burst/commit` (`null` si le lot est vide). */
export interface BurstCommitParams {
  readonly setId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly removeFromWishlist: boolean;
}

export const buildBurstCommitPayload = (
  params: BurstCommitParams,
  lines: ReadonlyArray<BurstLine>,
): BurstImportBatchInput | null => {
  const [first, ...rest] = [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      cardId: line.cardId,
      quantity: line.quantity,
      language: line.language,
      variant: line.variant,
      condition: line.condition,
      variantExplicit: line.explicit,
    }));
  if (first === undefined) return null;
  return {
    defaults: {
      setId: params.setId,
      language: params.language,
      variant: params.variant,
      condition: params.condition,
      removeFromWishlist: params.removeFromWishlist,
    },
    items: [first, ...rest],
  };
};

// ---------------------------------------------------------------------------
// Pavé numéros `#` : saisie et appariement tolérant
// ---------------------------------------------------------------------------

/** Longueur maximale du numéro saisi (`SV001`, `TG01`, `GG01`… ≤ 6). */
export const MAX_BURST_NUMBER_LENGTH = 6;

/** Caractères acceptés au pavé / clavier : chiffres et lettres (promos, secrètes). */
export const isBurstNumberChar = (char: string): boolean => /^[0-9A-Za-z]$/.test(char);

/** Ajoute un caractère (majuscule) au numéro saisi, plafonné à 6. */
export const appendBurstNumberChar = (input: string, char: string): string =>
  isBurstNumberChar(char) && input.length < MAX_BURST_NUMBER_LENGTH
    ? `${input}${char.toUpperCase()}`
    : input;

/** Efface le dernier caractère (`⌫`). */
export const backspaceBurstNumber = (input: string): string => input.slice(0, -1);

export type BurstNumberMatch =
  | { readonly kind: "empty" }
  | { readonly kind: "none"; readonly query: string }
  | {
      readonly kind: "match";
      readonly query: string;
      readonly card: BurstCatalogCard;
      /** `exact` : numéro / identifiant identique ; `prefix` : début d'un identifiant de promo. */
      readonly quality: "exact" | "prefix";
    };

/**
 * Trouve la carte d'un numéro saisi (cartes déjà triées par numéro) :
 * 1. identifiant exact (`localId`, insensible à la casse) ;
 * 2. saisie 100 % numérique : `localIdNumeric` égal (`25` ou `025` → `025`) ;
 * 3. saisie avec lettres : préfixe d'un `localId` (`SV0` → `SV001`).
 * Une saisie numérique n'apparie jamais par préfixe (taper `1` ne propose pas `100`).
 */
export const matchBurstCardNumber = (
  cards: ReadonlyArray<BurstCatalogCard>,
  rawInput: string,
): BurstNumberMatch => {
  const query = rawInput.replace(/^#/, "").trim().toUpperCase();
  if (query === "") return { kind: "empty" };
  const exact = cards.find((card) => card.localId.toUpperCase() === query);
  if (exact !== undefined) return { kind: "match", query, card: exact, quality: "exact" };
  if (/^\d+$/.test(query)) {
    const value = Number.parseInt(query, 10);
    // Un identifiant 100 % numérique (`025`) l'emporte sur une promo `SV025` de même numéro.
    const numeric =
      cards.find((card) => card.localIdNumeric === value && /^\d+$/.test(card.localId)) ??
      cards.find((card) => card.localIdNumeric === value);
    return numeric === undefined
      ? { kind: "none", query }
      : { kind: "match", query, card: numeric, quality: "exact" };
  }
  const prefix = cards.find((card) => card.localId.toUpperCase().startsWith(query));
  return prefix === undefined
    ? { kind: "none", query }
    : { kind: "match", query, card: prefix, quality: "prefix" };
};

/**
 * Variantes proposées en override pour une carte : celles qu'elle liste
 * (ordre canonique) ; à défaut les 4 variantes courantes.
 */
export const burstVariantChoices = (card: BurstCatalogCard): ReadonlyArray<CardVariant> =>
  card.availableVariants.length > 0
    ? CARD_VARIANT_ORDER.filter((variant) => card.availableVariants.includes(variant))
    : BURST_SETUP_VARIANTS;

/**
 * Filtre léger de la grille : nom (insensible aux accents / à la casse) ou
 * numéro (`25` = `025`, ou `localId` contenant la saisie). Requête vide → tout.
 */
export const filterBurstCards = (
  cards: ReadonlyArray<BurstCatalogCard>,
  query: string,
): ReadonlyArray<BurstCatalogCard> => {
  const needle = normalizeBurstText(query.replace(/^#/, ""));
  if (needle === "") return cards;
  const numeric = /^\d+$/.test(needle) ? Number.parseInt(needle, 10) : null;
  return cards.filter(
    (card) =>
      normalizeBurstText(card.nameFr).includes(needle) ||
      normalizeBurstText(card.localId).includes(needle) ||
      (numeric !== null && card.localIdNumeric === numeric),
  );
};

/** Action clavier physique du pavé `#` (désactivée dans les champs de saisie). */
export type BurstKeypadKeyAction =
  | { readonly type: "char"; readonly char: string }
  | { readonly type: "backspace" }
  | { readonly type: "clear" }
  | { readonly type: "add" };

export interface BurstKeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean | undefined;
  readonly metaKey?: boolean | undefined;
  readonly altKey?: boolean | undefined;
  /** Cible : champ de texte, bouton / lien (Entrée native), pavé `#` ou autre. */
  readonly target: "text-field" | "interactive" | "keypad" | "other";
}

/**
 * Traduit une touche du clavier physique en action du pavé `#` :
 * `0-9` / lettres → caractère, `Backspace`, `Escape` (efface) et `Enter` (+1).
 * `Enter` sur un bouton ou un lien (hors pavé) garde son comportement natif.
 */
export const burstKeypadKeyAction = (event: BurstKeyEventLike): BurstKeypadKeyAction | null => {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  if (event.target === "text-field") return null;
  if (event.key === "Backspace") return { type: "backspace" };
  if (event.key === "Escape") return { type: "clear" };
  if (event.key === "Enter") {
    return event.target === "interactive" ? null : { type: "add" };
  }
  return event.key.length === 1 && isBurstNumberChar(event.key)
    ? { type: "char", char: event.key }
    : null;
};
