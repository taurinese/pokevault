import { Data, Effect, Schema } from "effect";
import {
  CardCondition,
  CardId,
  CardLanguage,
  CardVariant,
  MAX_CARD_COPY_QUANTITY,
  ValidationError,
} from "./card.ts";
import { CARD_VARIANT_ORDER, SqlDate } from "./catalog.ts";

// ---------------------------------------------------------------------------
// Constants (aligned with supabase/migrations/004_binders_and_copies.sql)
// ---------------------------------------------------------------------------

/** `binders.title` CHECK: 1..80 caractères non blancs. */
export const BINDER_TITLE_MAX_LENGTH = 80;
/** `user_card_copies.notes` CHECK: 1000 caractères max. */
export const CARD_COPY_NOTES_MAX_LENGTH = 1000;
/** `user_card_copies.grading_score` CHECK: 1..16 caractères, sans espaces de bord. */
export const GRADING_SCORE_MAX_LENGTH = 16;
/** Taille maximale d'une cover uploadée (bucket `binder-covers`, docs/06 §3). */
export const COVER_MAX_BYTES = 2 * 1024 * 1024;
/** Côté maximal (px) d'une cover recompressée (`fit: "inside"`). */
export const COVER_MAX_DIMENSION = 600;
/** Réexport pratique : plafond de quantité d'un slot d'exemplaires. */
export { MAX_CARD_COPY_QUANTITY };

// ---------------------------------------------------------------------------
// Base schemas
// ---------------------------------------------------------------------------

/** `binders.kind` : classeur d'extension ou dossier perso. */
export const BinderKind = Schema.Literals(["set", "custom"]);
export type BinderKind = typeof BinderKind.Type;

/** `binders.cover_type` : logo officiel (repli neutre), carte ou image uploadée. */
export const BinderCoverType = Schema.Literals(["set_logo", "card", "upload"]);
export type BinderCoverType = typeof BinderCoverType.Type;

/** `user_card_copies.grading_company`. */
export const GradingCompany = Schema.Literals(["PSA", "PCA", "BGS", "CGC"]);
export type GradingCompany = typeof GradingCompany.Type;

/** Identifiant `uuid` (classeur, exemplaire, utilisateur). */
export const Uuid = Schema.String.check(Schema.isUUID());
export type Uuid = typeof Uuid.Type;

/** Identifiant d'extension TCGdex (`catalog_sets.id`), sans espace. */
export const SetId = Schema.NonEmptyString.check(Schema.isPattern(/^\S+$/));
export type SetId = typeof SetId.Type;

/** Titre de classeur : 1..80 caractères, sans espaces de bord, jamais uniquement blanc. */
export const BinderTitle = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, BINDER_TITLE_MAX_LENGTH),
);
export type BinderTitle = typeof BinderTitle.Type;

/** Note de grading normalisée (`10`, `9.5`) : 1..16 caractères sans espaces de bord. */
export const GradingScore = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, GRADING_SCORE_MAX_LENGTH),
);
export type GradingScore = typeof GradingScore.Type;

/** Quantité d'un slot : entier `1..MAX_CARD_COPY_QUANTITY`. */
export const CopyQuantity = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_CARD_COPY_QUANTITY),
);
export type CopyQuantity = typeof CopyQuantity.Type;

/** Prix d'achat en centimes (strictement privé) : entier `>= 0`. */
export const PurchasePriceCents = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type PurchasePriceCents = typeof PurchasePriceCents.Type;

const CopyNotes = Schema.String.check(Schema.isMaxLength(CARD_COPY_NOTES_MAX_LENGTH));

// ---------------------------------------------------------------------------
// Binders
// ---------------------------------------------------------------------------

/** Ligne `binders` (dates en ISO 8601, sérialisables vers le client). */
export const Binder = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  kind: BinderKind,
  setId: Schema.NullOr(SetId),
  title: BinderTitle,
  coverType: BinderCoverType,
  coverCardId: Schema.NullOr(CardId),
  coverStoragePath: Schema.NullOr(Schema.NonEmptyString),
  isPinned: Schema.Boolean,
  sortOrder: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Binder = typeof Binder.Type;

/**
 * Suivre une extension. `title` est facultatif (défaut : nom FR de l'extension).
 * `ifExists` : `"return"` (défaut, idempotent) renvoie le classeur existant,
 * `"fail"` lève `BinderConflictError`.
 */
export const CreateSetBinderInput = Schema.Struct({
  setId: SetId,
  title: Schema.optionalKey(BinderTitle),
  ifExists: Schema.optionalKey(Schema.Literals(["return", "fail"])),
});
export type CreateSetBinderInput = typeof CreateSetBinderInput.Type;

/** Nouveau dossier perso (cover neutre par défaut). */
export const CreateCustomBinderInput = Schema.Struct({
  title: BinderTitle,
  isPinned: Schema.optionalKey(Schema.Boolean),
});
export type CreateCustomBinderInput = typeof CreateCustomBinderInput.Type;

const hasAnyKey =
  (keys: ReadonlyArray<string>) =>
  (value: object): true | string =>
    keys.some((key) => (value as Record<string, unknown>)[key] !== undefined)
      ? true
      : `at least one of ${keys.join(", ")} is required`;

/** Patch d'un classeur : titre, épinglage, ordre. Au moins un champ. */
export const UpdateBinderInput = Schema.Struct({
  title: Schema.optionalKey(BinderTitle),
  isPinned: Schema.optionalKey(Schema.Boolean),
  sortOrder: Schema.optionalKey(Schema.Int),
}).check(Schema.makeFilter(hasAnyKey(["title", "isPinned", "sortOrder"])));
export type UpdateBinderInput = typeof UpdateBinderInput.Type;

/** Cover : logo / repli neutre, carte du catalogue, ou image uploadée (octets bruts). */
export const SetBinderCoverInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set_logo") }),
  Schema.Struct({ type: Schema.Literal("card"), cardId: CardId }),
  Schema.Struct({ type: Schema.Literal("upload"), image: Schema.Uint8Array }),
]);
export type SetBinderCoverInput = typeof SetBinderCoverInput.Type;

/** Carte d'un dossier perso (`binder_cards`). */
export const BinderCardEntry = Schema.Struct({
  binderId: Uuid,
  cardId: CardId,
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  addedAt: Schema.String,
});
export type BinderCardEntry = typeof BinderCardEntry.Type;

// ---------------------------------------------------------------------------
// Card copies
// ---------------------------------------------------------------------------

const gradingPair = (value: {
  readonly gradingCompany?: GradingCompany | null | undefined;
  readonly gradingScore?: string | null | undefined;
}): true | string => {
  const hasCompany = value.gradingCompany !== undefined && value.gradingCompany !== null;
  const hasScore = value.gradingScore !== undefined && value.gradingScore !== null;
  return hasCompany === hasScore
    ? true
    : "gradingCompany and gradingScore must be provided together";
};

/** Ligne `user_card_copies` (champs privés inclus : réservée au propriétaire). */
export const UserCardCopy = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  cardId: CardId,
  language: CardLanguage,
  variant: CardVariant,
  condition: CardCondition,
  quantity: CopyQuantity,
  purchasePriceCents: Schema.NullOr(PurchasePriceCents),
  gradingCompany: Schema.NullOr(GradingCompany),
  gradingScore: Schema.NullOr(GradingScore),
  notes: Schema.NullOr(CopyNotes),
  acquiredAt: Schema.NullOr(SqlDate),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).check(Schema.makeFilter(gradingPair));
export type UserCardCopy = typeof UserCardCopy.Type;

/**
 * Ajout d'un exemplaire sur un slot `(carte, langue, variante, état, grading)`.
 * `mode: "increment"` (défaut) ajoute `quantity` au slot existant ; `"set"` la fixe.
 * `language` (défaut `FR`) et `condition` (défaut `NM`) sont facultatifs.
 */
export const UpsertCardCopyInput = Schema.Struct({
  cardId: CardId,
  language: Schema.optionalKey(CardLanguage),
  variant: CardVariant,
  condition: Schema.optionalKey(CardCondition),
  quantity: Schema.optionalKey(CopyQuantity),
  mode: Schema.optionalKey(Schema.Literals(["increment", "set"])),
  purchasePriceCents: Schema.optionalKey(Schema.NullOr(PurchasePriceCents)),
  gradingCompany: Schema.optionalKey(Schema.NullOr(GradingCompany)),
  gradingScore: Schema.optionalKey(Schema.NullOr(GradingScore)),
  notes: Schema.optionalKey(Schema.NullOr(CopyNotes)),
  acquiredAt: Schema.optionalKey(Schema.NullOr(SqlDate)),
}).check(Schema.makeFilter(gradingPair));
export type UpsertCardCopyInput = typeof UpsertCardCopyInput.Type;

/**
 * Patch d'un exemplaire : état, prix d'achat, notes, date d'acquisition, grading
 * (société + note ensemble, ou les deux à `null`). Au moins un champ.
 */
export const UpdateCardCopyInput = Schema.Struct({
  condition: Schema.optionalKey(CardCondition),
  purchasePriceCents: Schema.optionalKey(Schema.NullOr(PurchasePriceCents)),
  gradingCompany: Schema.optionalKey(Schema.NullOr(GradingCompany)),
  gradingScore: Schema.optionalKey(Schema.NullOr(GradingScore)),
  notes: Schema.optionalKey(Schema.NullOr(CopyNotes)),
  acquiredAt: Schema.optionalKey(Schema.NullOr(SqlDate)),
}).check(
  Schema.makeFilter((patch) => {
    const grading =
      patch.gradingCompany === undefined && patch.gradingScore === undefined
        ? true
        : patch.gradingCompany !== undefined && patch.gradingScore !== undefined
          ? gradingPair(patch)
          : "gradingCompany and gradingScore must be provided together";
    if (grading !== true) return grading;
    return hasAnyKey([
      "condition",
      "purchasePriceCents",
      "gradingCompany",
      "gradingScore",
      "notes",
      "acquiredAt",
    ])(patch);
  }),
);
export type UpdateCardCopyInput = typeof UpdateCardCopyInput.Type;

// ---------------------------------------------------------------------------
// Completion stats
// ---------------------------------------------------------------------------

export const CompletionStatus = Schema.Literals(["not_started", "in_progress", "completed"]);
export type CompletionStatus = typeof CompletionStatus.Type;

/** Complétion d'une extension (`computeSetCompletion`). */
export const SetCompletionStats = Schema.Struct({
  setId: SetId,
  officialCount: Schema.Int,
  totalCount: Schema.Int,
  /** Dénominateur retenu : `totalCount` (secrètes incluses) ou `officialCount`. */
  targetCount: Schema.Int,
  /** Cartes distinctes possédées (selon les options). */
  ownedDistinct: Schema.Int,
  missingCount: Schema.Int,
  /** Pourcentage entier 0..100 ; 100 uniquement si l'extension est complète. */
  percent: Schema.Int,
  /** Total d'exemplaires (somme des quantités). */
  totalCopies: Schema.Int,
  /** Exemplaires en surplus (`quantity - 1` cumulé par carte). */
  duplicateCount: Schema.Int,
  /** Cartes distinctes possédées en `>= 2` exemplaires. */
  duplicateCardCount: Schema.Int,
  status: CompletionStatus,
});
export type SetCompletionStats = typeof SetCompletionStats.Type;

/** Complétion agrégée d'un bloc / série. */
export const SeriesCompletionStats = Schema.Struct({
  seriesId: Schema.NonEmptyString,
  setCount: Schema.Int,
  trackedSetCount: Schema.Int,
  completedSetCount: Schema.Int,
  ownedDistinct: Schema.Int,
  targetCount: Schema.Int,
  percent: Schema.Int,
  totalCopies: Schema.Int,
  duplicateCount: Schema.Int,
});
export type SeriesCompletionStats = typeof SeriesCompletionStats.Type;

/** Complétion globale de la collection. */
export const GlobalCompletionStats = Schema.Struct({
  trackedSetCount: Schema.Int,
  completedSetCount: Schema.Int,
  /** Cartes distinctes possédées dans les classeurs suivis. */
  trackedOwnedDistinct: Schema.Int,
  trackedTargetCount: Schema.Int,
  /** Pourcentage global des classeurs suivis. */
  percent: Schema.Int,
  /** Cartes distinctes possédées, toute la collection (extensions non suivies incluses). */
  ownedDistinct: Schema.Int,
  totalCopies: Schema.Int,
  duplicateCount: Schema.Int,
  duplicateCardCount: Schema.Int,
});
export type GlobalCompletionStats = typeof GlobalCompletionStats.Type;

// ---------------------------------------------------------------------------
// Typed domain errors (docs/03 §3)
// ---------------------------------------------------------------------------

/** Classeur inexistant, ou appartenant à un autre utilisateur (RLS : invisible). */
export class BinderNotFoundError extends Data.TaggedError("BinderNotFoundError")<{
  readonly binderId: string;
  readonly message: string;
}> {}

/** Conflit d'unicité (ex. extension déjà suivie avec `ifExists: "fail"`). */
export class BinderConflictError extends Data.TaggedError("BinderConflictError")<{
  readonly message: string;
  readonly setId?: string | undefined;
  readonly cause?: unknown;
}> {}

/** Accès refusé à un classeur (RLS / droit insuffisant, jeton absent ou invalide). */
export class UnauthorizedBinderAccess extends Data.TaggedError("UnauthorizedBinderAccess")<{
  readonly message: string;
  readonly binderId?: string | undefined;
  readonly cause?: unknown;
}> {}

/** Exemplaire inexistant ou appartenant à un autre utilisateur. */
export class CardCopyNotFoundError extends Data.TaggedError("CardCopyNotFoundError")<{
  readonly copyId: string;
  readonly message: string;
}> {}

/** Le nouveau slot d'un exemplaire existe déjà (index unique `user_card_copies_unique_slot_idx`). */
export class CardCopyConflictError extends Data.TaggedError("CardCopyConflictError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Extension ou carte du catalogue introuvable (clé étrangère). */
export class CatalogItemNotFoundError extends Data.TaggedError("CatalogItemNotFoundError")<{
  readonly entity: "set" | "card";
  readonly id: string;
  readonly message: string;
}> {}

export type InvalidCoverImageReason =
  | "empty"
  | "too_large"
  | "svg_not_allowed"
  | "unsupported_format"
  | "corrupt";

/** Image de cover refusée (taille, format, SVG, fichier corrompu). */
export class InvalidCoverImageError extends Data.TaggedError("InvalidCoverImageError")<{
  readonly reason: InvalidCoverImageReason;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Échec de l'API Supabase Storage (réseau, 4xx/5xx, jeton absent). */
export class StorageServiceError extends Data.TaggedError("StorageServiceError")<{
  readonly message: string;
  readonly status?: number | undefined;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const decodeWith =
  <T, E>(schema: Schema.Codec<T, E>) =>
  (input: unknown): Effect.Effect<T, ValidationError> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((error) => new ValidationError({ message: error.message, cause: error })),
    );

export const decodeCreateSetBinderInput = decodeWith(CreateSetBinderInput);
export const decodeCreateCustomBinderInput = decodeWith(CreateCustomBinderInput);
export const decodeUpdateBinderInput = decodeWith(UpdateBinderInput);
export const decodeSetBinderCoverInput = decodeWith(SetBinderCoverInput);
export const decodeUpsertCardCopyInput = decodeWith(UpsertCardCopyInput);
export const decodeUpdateCardCopyInput = decodeWith(UpdateCardCopyInput);

// ---------------------------------------------------------------------------
// Pure helpers — identifiers, cover path, cover image sniffing
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si la valeur est un UUID (n'importe quelle casse). */
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

/**
 * Chemin Storage d'une cover : `<userId>/<binderId>.webp`, UUID en minuscules (forme
 * canonique de Postgres, exigée par `binders_cover_storage_path_format` et par les
 * policies `storage.objects`). Les deux identifiants doivent être des UUID valides.
 */
export const binderCoverStoragePath = (userId: string, binderId: string): string =>
  `${userId.toLowerCase()}/${binderId.toLowerCase()}.webp`;

const COVER_PATH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

/**
 * `true` si `path` est exactement `<userId>/<binderId>.webp` (anti path traversal, anti
 * usurpation : un autre utilisateur ou un autre classeur est refusé).
 */
export const isBinderCoverStoragePathOf = (
  path: string,
  userId: string,
  binderId: string,
): boolean => COVER_PATH_PATTERN.test(path) && path === binderCoverStoragePath(userId, binderId);

/** Format d'image détecté d'après les octets (jamais d'après le nom ou le MIME déclaré). */
export type CoverImageFormat = "jpeg" | "png" | "webp" | "svg" | "unknown";

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const looksLikeSvg = (bytes: Uint8Array): boolean => {
  // ASCII/latin1 view of the first bytes: enough to spot `<svg` / `<?xml` markers.
  const head = String.fromCharCode(...bytes.subarray(0, 1024))
    .replace(/^\u00ef\u00bb\u00bf/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype svg");
};

/**
 * Détecte le format d'une image par ses magic bytes : JPEG `FF D8 FF`, PNG
 * `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF....WEBP`. Le SVG (texte XML) est identifié pour être
 * refusé explicitement ; tout le reste est `unknown`.
 */
export const detectCoverImageFormat = (bytes: Uint8Array): CoverImageFormat => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "webp";
  }
  if (looksLikeSvg(bytes)) return "svg";
  return "unknown";
};

/** Normalise un titre saisi : espaces de bord retirés, espaces internes compactés. */
export const normalizeBinderTitle = (raw: string): string => raw.trim().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// Pure helpers — copies aggregation
// ---------------------------------------------------------------------------

/** Exemplaire minimal pour l'agrégation (un enregistrement de slot). */
export interface CopyLike {
  readonly cardId: string;
  readonly variant: CardVariant;
  readonly quantity: number;
}

/** Possession agrégée d'une carte, tous slots confondus. */
export interface CardOwnership {
  readonly cardId: string;
  /** Somme des quantités. */
  readonly totalQuantity: number;
  /** Exemplaires en surplus : `totalQuantity - 1`. */
  readonly duplicateCount: number;
  /** Variantes distinctes possédées, dans l'ordre canonique du catalogue. */
  readonly variants: ReadonlyArray<CardVariant>;
  /** Nombre de slots (lignes) distincts. */
  readonly slotCount: number;
}

/**
 * Agrège les slots d'exemplaires par `cardId` (ordre de première apparition). Les quantités
 * `<= 0` sont ignorées (un slot vide ne compte pas comme « possédé »).
 */
export const aggregateCopiesByCard = (
  copies: ReadonlyArray<CopyLike>,
): ReadonlyArray<CardOwnership> => {
  const byCard = new Map<
    string,
    { quantity: number; variants: Set<CardVariant>; slotCount: number }
  >();
  for (const copy of copies) {
    if (!(copy.quantity > 0)) continue;
    const entry = byCard.get(copy.cardId) ?? { quantity: 0, variants: new Set(), slotCount: 0 };
    entry.quantity += copy.quantity;
    entry.variants.add(copy.variant);
    entry.slotCount += 1;
    byCard.set(copy.cardId, entry);
  }
  return [...byCard.entries()].map(([cardId, entry]) => ({
    cardId,
    totalQuantity: entry.quantity,
    duplicateCount: entry.quantity - 1,
    variants: CARD_VARIANT_ORDER.filter((variant) => entry.variants.has(variant)),
    slotCount: entry.slotCount,
  }));
};

/** Clé de slot normalisée (miroir de `user_card_copies_unique_slot_idx`). */
export const copySlotKey = (copy: {
  readonly cardId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly gradingCompany?: GradingCompany | null | undefined;
  readonly gradingScore?: string | null | undefined;
}): string =>
  JSON.stringify([
    copy.cardId,
    copy.language,
    copy.variant,
    copy.condition,
    copy.gradingCompany ?? "",
    copy.gradingScore ?? "",
  ]);

// ---------------------------------------------------------------------------
// Pure helpers — completion
// ---------------------------------------------------------------------------

/**
 * Pourcentage entier de complétion. `0` si `total <= 0` ; jamais `100` tant que
 * `owned < total` (plafonné à 99) ; jamais `0` dès qu'une carte est possédée (min. 1).
 */
export const computePercent = (owned: number, total: number): number => {
  if (total <= 0 || owned <= 0) return 0;
  if (owned >= total) return 100;
  return Math.min(99, Math.max(1, Math.round((owned / total) * 100)));
};

/** Copie possédée avec les attributs du catalogue nécessaires au calcul. */
export interface CompletionCopy extends CopyLike {
  /** `catalog_cards.local_id_numeric` : `> officialCount` ⇒ carte secrète. */
  readonly localIdNumeric: number | null;
}

export interface CompletionOptions {
  /** Inclure les cartes secrètes (n° > officialCount). Défaut `true`. */
  readonly includeSecrets?: boolean | undefined;
  /** Inclure les exemplaires de variante `promo`. Défaut `true`. */
  readonly includePromos?: boolean | undefined;
}

export interface SetCountsInput {
  readonly setId: string;
  readonly officialCount: number;
  readonly totalCount: number;
}

/**
 * Complétion d'une extension à partir de ses exemplaires possédés.
 *
 * - Dénominateur : `totalCount` (secrètes incluses) ou `officialCount` si
 *   `includeSecrets === false` ; dans ce cas les cartes secrètes ne comptent pas non plus.
 * - `includePromos === false` ignore les exemplaires de variante `promo` (une carte
 *   possédée uniquement en promo n'est pas comptée).
 * - `ownedDistinct` = cartes distinctes ; `totalCopies` = somme des quantités ;
 *   `duplicateCount` = surplus (`quantity - 1` par carte), `duplicateCardCount` = cartes en `>= 2`.
 * - `status` : `not_started` (0 carte), `completed` (toutes), sinon `in_progress`.
 */
export const computeSetCompletion = (
  set: SetCountsInput,
  copies: ReadonlyArray<CompletionCopy>,
  options: CompletionOptions = {},
): SetCompletionStats => {
  const includeSecrets = options.includeSecrets ?? true;
  const includePromos = options.includePromos ?? true;
  const officialCount = Math.max(0, Math.trunc(set.officialCount));
  const totalCount = Math.max(officialCount, Math.trunc(set.totalCount));
  const targetCount = includeSecrets ? totalCount : officialCount;

  const kept = copies.filter((copy) => {
    if (!(copy.quantity > 0)) return false;
    if (!includePromos && copy.variant === "promo") return false;
    if (!includeSecrets && copy.localIdNumeric !== null && copy.localIdNumeric > officialCount) {
      return false;
    }
    return true;
  });
  const owned = aggregateCopiesByCard(kept);
  const ownedDistinct = owned.length;
  const totalCopies = owned.reduce((sum, card) => sum + card.totalQuantity, 0);
  const duplicateCount = owned.reduce((sum, card) => sum + card.duplicateCount, 0);
  const duplicateCardCount = owned.filter((card) => card.totalQuantity >= 2).length;
  const status: CompletionStatus =
    ownedDistinct === 0
      ? "not_started"
      : targetCount > 0 && ownedDistinct >= targetCount
        ? "completed"
        : "in_progress";

  return {
    setId: set.setId,
    officialCount,
    totalCount,
    targetCount,
    ownedDistinct,
    missingCount: Math.max(0, targetCount - ownedDistinct),
    percent: computePercent(ownedDistinct, targetCount),
    totalCopies,
    duplicateCount,
    duplicateCardCount,
    status,
  };
};

/** Statistique d'extension + indicateur « classeur suivi » (entrée des agrégats). */
export interface SetCompletionEntry {
  readonly stats: SetCompletionStats;
  /** `true` si l'utilisateur suit l'extension (classeur `kind = 'set'`). */
  readonly tracked: boolean;
}

/**
 * Complétion agrégée d'un bloc / série. Les compteurs de cartes (`ownedDistinct`,
 * `targetCount`, `percent`) ne portent que sur les extensions **suivies** (en-tête
 * « N sets suivis · X % ») ; `setCount` compte toutes les extensions fournies.
 */
export const computeSeriesCompletion = (
  seriesId: string,
  entries: ReadonlyArray<SetCompletionEntry>,
): SeriesCompletionStats => {
  const tracked = entries.filter((entry) => entry.tracked);
  const ownedDistinct = tracked.reduce((sum, entry) => sum + entry.stats.ownedDistinct, 0);
  const targetCount = tracked.reduce((sum, entry) => sum + entry.stats.targetCount, 0);
  return {
    seriesId,
    setCount: entries.length,
    trackedSetCount: tracked.length,
    completedSetCount: tracked.filter((entry) => entry.stats.status === "completed").length,
    ownedDistinct,
    targetCount,
    percent: computePercent(ownedDistinct, targetCount),
    totalCopies: tracked.reduce((sum, entry) => sum + entry.stats.totalCopies, 0),
    duplicateCount: tracked.reduce((sum, entry) => sum + entry.stats.duplicateCount, 0),
  };
};

/**
 * Complétion globale. Le pourcentage porte sur les classeurs suivis ; les totaux de cartes
 * distinctes, d'exemplaires et de doublons couvrent toute la collection (extensions non
 * suivies comprises).
 */
export const computeGlobalCompletion = (
  entries: ReadonlyArray<SetCompletionEntry>,
): GlobalCompletionStats => {
  const tracked = entries.filter((entry) => entry.tracked);
  const trackedOwnedDistinct = tracked.reduce((sum, entry) => sum + entry.stats.ownedDistinct, 0);
  const trackedTargetCount = tracked.reduce((sum, entry) => sum + entry.stats.targetCount, 0);
  return {
    trackedSetCount: tracked.length,
    completedSetCount: tracked.filter((entry) => entry.stats.status === "completed").length,
    trackedOwnedDistinct,
    trackedTargetCount,
    percent: computePercent(trackedOwnedDistinct, trackedTargetCount),
    ownedDistinct: entries.reduce((sum, entry) => sum + entry.stats.ownedDistinct, 0),
    totalCopies: entries.reduce((sum, entry) => sum + entry.stats.totalCopies, 0),
    duplicateCount: entries.reduce((sum, entry) => sum + entry.stats.duplicateCount, 0),
    duplicateCardCount: entries.reduce((sum, entry) => sum + entry.stats.duplicateCardCount, 0),
  };
};

// ---------------------------------------------------------------------------
// Read models (consumed by the Collection / Binder screens)
// ---------------------------------------------------------------------------

/** Extension rattachée à un classeur `kind = 'set'` (jointure `catalog_sets`). */
export interface BinderSetInfo {
  readonly id: string;
  readonly nameFr: string;
  readonly code: string | null;
  readonly logoUrl: string | null;
  readonly seriesId: string;
  readonly releaseDate: string | null;
  readonly officialCount: number;
  readonly totalCount: number;
}

/**
 * Classeur + agrégats d'affichage.
 * - `kind = 'set'` : `completion` renseigné, `cardCount = totalCount` de l'extension.
 * - `kind = 'custom'` : `completion = null`, `cardCount` = cartes du dossier, `ownedCount` =
 *   cartes du dossier possédées (au moins un exemplaire).
 */
export interface BinderSummary {
  readonly binder: Binder;
  readonly set: BinderSetInfo | null;
  readonly completion: SetCompletionStats | null;
  readonly cardCount: number;
  readonly ownedCount: number;
}

export interface ListBindersFilter extends CompletionOptions {
  readonly kind?: BinderKind | undefined;
  /** Filtre par bloc / série (classeurs d'extension uniquement). */
  readonly seriesId?: string | undefined;
}

export interface ListCardCopiesFilter {
  readonly cardId?: string | undefined;
  readonly setId?: string | undefined;
}

export interface SetOverviewEntry {
  readonly setId: string;
  readonly seriesId: string;
  readonly nameFr: string;
  readonly code: string | null;
  readonly logoUrl: string | null;
  readonly releaseDate: string | null;
  readonly tracked: boolean;
  readonly completion: SetCompletionStats;
}

export interface SeriesOverviewEntry {
  readonly seriesId: string;
  readonly nameFr: string;
  readonly releaseOrder: number;
  readonly completion: SeriesCompletionStats;
}

/** Agrégations de la collection : globale, par série, par extension. */
export interface CollectionOverview {
  readonly global: GlobalCompletionStats;
  readonly series: ReadonlyArray<SeriesOverviewEntry>;
  readonly sets: ReadonlyArray<SetOverviewEntry>;
}

export interface OverviewSetInput {
  readonly id: string;
  readonly seriesId: string;
  readonly nameFr: string;
  readonly code: string | null;
  readonly logoUrl: string | null;
  readonly releaseDate: string | null;
  readonly officialCount: number;
  readonly totalCount: number;
}

export interface OverviewSeriesInput {
  readonly id: string;
  readonly nameFr: string;
  readonly releaseOrder: number;
}

/** Exemplaire possédé, rattaché à l'extension de sa carte. */
export interface OverviewCopy extends CompletionCopy {
  readonly setId: string;
}

export interface BuildCollectionOverviewInput {
  readonly series: ReadonlyArray<OverviewSeriesInput>;
  readonly sets: ReadonlyArray<OverviewSetInput>;
  readonly copies: ReadonlyArray<OverviewCopy>;
  /** Extensions suivies par l'utilisateur (classeurs `kind = 'set'`). */
  readonly trackedSetIds: ReadonlySet<string>;
}

/**
 * Construit la vue d'ensemble de la collection (pure) : une entrée par extension **suivie ou
 * contenant au moins un exemplaire**, regroupées par série (bloc), puis la complétion globale.
 * Tri : séries et extensions les plus récentes d'abord (`releaseOrder` / `releaseDate` desc,
 * puis nom).
 */
export const buildCollectionOverview = (
  input: BuildCollectionOverviewInput,
  options: CompletionOptions = {},
): CollectionOverview => {
  const copiesBySet = new Map<string, Array<OverviewCopy>>();
  for (const copy of input.copies) {
    const list = copiesBySet.get(copy.setId);
    if (list === undefined) copiesBySet.set(copy.setId, [copy]);
    else list.push(copy);
  }

  const sets: Array<SetOverviewEntry> = input.sets
    .filter((set) => input.trackedSetIds.has(set.id) || (copiesBySet.get(set.id)?.length ?? 0) > 0)
    .map((set) => ({
      setId: set.id,
      seriesId: set.seriesId,
      nameFr: set.nameFr,
      code: set.code,
      logoUrl: set.logoUrl,
      releaseDate: set.releaseDate,
      tracked: input.trackedSetIds.has(set.id),
      completion: computeSetCompletion(
        { setId: set.id, officialCount: set.officialCount, totalCount: set.totalCount },
        copiesBySet.get(set.id) ?? [],
        options,
      ),
    }))
    .sort(
      (a, b) =>
        (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") ||
        a.nameFr.localeCompare(b.nameFr),
    );

  const series: Array<SeriesOverviewEntry> = input.series
    .map((entry) => {
      const inSeries = sets.filter((set) => set.seriesId === entry.id);
      return {
        seriesId: entry.id,
        nameFr: entry.nameFr,
        releaseOrder: entry.releaseOrder,
        inSeries,
      };
    })
    .filter((entry) => entry.inSeries.length > 0)
    .sort((a, b) => b.releaseOrder - a.releaseOrder || a.nameFr.localeCompare(b.nameFr))
    .map(({ inSeries, ...entry }) => ({
      ...entry,
      completion: computeSeriesCompletion(
        entry.seriesId,
        inSeries.map((set) => ({ stats: set.completion, tracked: set.tracked })),
      ),
    }));

  return {
    global: computeGlobalCompletion(
      sets.map((set) => ({ stats: set.completion, tracked: set.tracked })),
    ),
    series,
    sets,
  };
};
