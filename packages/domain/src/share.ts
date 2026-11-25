import { Data, Effect, Schema } from "effect";
import { CardId, CardLanguage, CardVariant, HoloEffect, ValidationError } from "./card.ts";
import { BinderCoverType, BinderKind, Uuid } from "./collection.ts";

// ---------------------------------------------------------------------------
// Constants (aligned with supabase/migrations/008_share_links.sql)
// ---------------------------------------------------------------------------

/** Entropie d'un jeton de partage : 32 octets cryptographiques (docs/06 §2). */
export const SHARE_TOKEN_BYTES = 32;
/** 32 octets en base64url (sans padding) = 43 caractères ; borne basse du CHECK SQL. */
export const SHARE_TOKEN_MIN_LENGTH = 43;
/** Borne haute défensive du CHECK SQL `char_length(token) <= 128`. */
export const SHARE_TOKEN_MAX_LENGTH = 128;
/** Format d'un jeton : alphabet base64url, 43..128 caractères (CHECK SQL `share_links.token`). */
export const SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * `true` si `token` a la forme d'un jeton de partage. Ne dit RIEN de son existence : la
 * route publique `/s/:token` répond la même `404` pour un jeton mal formé, inconnu ou révoqué.
 */
export const isValidShareToken = (token: string): boolean => SHARE_TOKEN_REGEX.test(token);

// ---------------------------------------------------------------------------
// Base schemas
// ---------------------------------------------------------------------------

/** `share_links.token` : secret non devinable, jamais loggé côté serveur. */
export const ShareToken = Schema.String.check(Schema.isPattern(SHARE_TOKEN_REGEX));
export type ShareToken = typeof ShareToken.Type;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

// ---------------------------------------------------------------------------
// Entity & inputs
// ---------------------------------------------------------------------------

/** Ligne `share_links` (dates en ISO 8601). Réservée au propriétaire (RLS), jamais à `anon`. */
export const ShareLink = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  binderId: Uuid,
  token: ShareToken,
  isActive: Schema.Boolean,
  showQuantities: Schema.Boolean,
  createdAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});
export type ShareLink = typeof ShareLink.Type;

/**
 * Création d'un lien de partage pour UN classeur du propriétaire. `showQuantities` vaut
 * `true` par défaut (doublons visibles).
 */
export const CreateShareLinkInput = Schema.Struct({
  binderId: Uuid,
  showQuantities: Schema.optionalKey(Schema.Boolean),
});
export type CreateShareLinkInput = typeof CreateShareLinkInput.Type;

/** Filtre de `ShareService.listLinks`. */
export interface ListShareLinksFilter {
  readonly binderId?: string | undefined;
  /** `true` : uniquement les liens actifs (non révoqués). */
  readonly activeOnly?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Public projection (get_shared_binder) — liste blanche stricte, ADR-008
// ---------------------------------------------------------------------------

/** Propriétaire : nom d'affichage et initiales UNIQUEMENT (jamais e-mail ni `user_id`). */
export const SharedBinderOwner = Schema.Struct({
  displayName: Schema.String,
  avatarInitials: Schema.String,
});
export type SharedBinderOwner = typeof SharedBinderOwner.Type;

/**
 * Métadonnées publiques du classeur. `hasUploadedCover` est un booléen : le chemin Storage
 * (`cover_storage_path`) embarque le `user_id` et n'est JAMAIS exposé (le serveur le proxifie
 * via `get_shared_binder_cover_path`).
 */
export const SharedBinderMeta = Schema.Struct({
  id: Uuid,
  kind: BinderKind,
  title: Schema.String,
  setId: Schema.NullOr(Schema.String),
  setCode: Schema.NullOr(Schema.String),
  setName: Schema.NullOr(Schema.String),
  coverType: BinderCoverType,
  coverLogoUrl: Schema.NullOr(Schema.String),
  coverCardImageUrl: Schema.NullOr(Schema.String),
  hasUploadedCover: Schema.Boolean,
  showQuantities: Schema.Boolean,
  ownedCount: NonNegativeInt,
  totalCards: NonNegativeInt,
});
export type SharedBinderMeta = typeof SharedBinderMeta.Type;

/**
 * Exemplaires d'une carte regroupés par `(langue, variante)`. `quantity` vaut `null` quand le
 * propriétaire masque les quantités (`show_quantities = false`). État, prix d'achat, notes,
 * grading et date d'acquisition ne sont JAMAIS projetés.
 */
export const SharedBinderCopy = Schema.Struct({
  language: CardLanguage,
  variant: CardVariant,
  quantity: Schema.NullOr(PositiveInt),
});
export type SharedBinderCopy = typeof SharedBinderCopy.Type;

/** Carte d'un classeur partagé. `quantity` : somme des exemplaires (0 si non possédée), `null` si masquée. */
export const SharedBinderCard = Schema.Struct({
  cardId: CardId,
  localId: Schema.String,
  localIdNumeric: Schema.NullOr(Schema.Int),
  nameFr: Schema.String,
  setCode: Schema.NullOr(Schema.String),
  rarity: Schema.NullOr(Schema.String),
  holoEffect: HoloEffect,
  imageBaseUrl: Schema.NullOr(Schema.String),
  owned: Schema.Boolean,
  quantity: Schema.NullOr(NonNegativeInt),
  copies: Schema.Array(SharedBinderCopy),
});
export type SharedBinderCard = typeof SharedBinderCard.Type;

/** Réponse complète de `get_shared_binder(token)` (route publique `/s/:token`). */
export const SharedBinderPayload = Schema.Struct({
  owner: SharedBinderOwner,
  binder: SharedBinderMeta,
  cards: Schema.Array(SharedBinderCard),
});
export type SharedBinderPayload = typeof SharedBinderPayload.Type;

// ---------------------------------------------------------------------------
// Typed domain errors (docs/03 §3)
// ---------------------------------------------------------------------------

/**
 * Lien inexistant, appartenant à un autre utilisateur (RLS : invisible), ou — côté route
 * publique — jeton mal formé / inconnu / désactivé / révoqué (même `404`, aucune distinction).
 */
export class ShareLinkNotFoundError extends Data.TaggedError("ShareLinkNotFoundError")<{
  readonly message: string;
  readonly linkId?: string | undefined;
}> {}

/** Action refusée par la base (ex. partager le classeur d'un autre utilisateur, `42501`). */
export class ShareLinkForbiddenError extends Data.TaggedError("ShareLinkForbiddenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const decodeWith =
  <T, E>(schema: Schema.Codec<T, E>, options?: { readonly onExcessProperty: "error" }) =>
  (input: unknown): Effect.Effect<T, ValidationError> =>
    Schema.decodeUnknownEffect(schema)(input, options).pipe(
      Effect.mapError((error) => new ValidationError({ message: error.message, cause: error })),
    );

export const decodeCreateShareLinkInput = decodeWith(CreateShareLinkInput);

/**
 * Décode une réponse de `get_shared_binder` en REFUSANT toute clé inconnue
 * (`onExcessProperty: "error"`) : si la fonction SQL venait à projeter un champ de plus (donc
 * potentiellement privé), le service échoue plutôt que de le relayer au navigateur.
 */
export const decodeSharedBinderPayload = decodeWith(SharedBinderPayload, {
  onExcessProperty: "error",
});
