import { randomBytes } from "node:crypto";
import {
  type Binder,
  BinderNotFoundError,
  type CardLanguage,
  type CardVariant,
  type CreateShareLinkInput,
  decodeCreateShareLinkInput,
  decodeSharedBinderPayload,
  type HoloEffect,
  isUuid,
  isValidShareToken,
  type ListShareLinksFilter,
  SHARE_TOKEN_BYTES,
  type SharedBinderCard,
  type SharedBinderCopy,
  type SharedBinderOwner,
  type SharedBinderPayload,
  type ShareLink,
  ShareLinkForbiddenError,
  ShareLinkNotFoundError,
  ValidationError,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { CollectionMemoryStore } from "./collection-memory.ts";
import { Database, DatabaseError, type Sql } from "./db.ts";
import { pgErrorCode, withUserRls } from "./rls.ts";

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Jeton de partage : `SHARE_TOKEN_BYTES` (32) octets cryptographiques encodés en base64url,
 * donc toujours 43 caractères `[A-Za-z0-9_-]` (docs/06 §2). Jamais d'ID incrémental ni d'UUID.
 */
export const generateShareToken = (): string =>
  randomBytes(SHARE_TOKEN_BYTES).toString("base64url");

// ---------------------------------------------------------------------------
// Errors & service contract
// ---------------------------------------------------------------------------

/** Union des erreurs typées de la gestion des liens (côté propriétaire). */
export type ShareServiceError =
  | DatabaseError
  | ValidationError
  | BinderNotFoundError
  | ShareLinkNotFoundError
  | ShareLinkForbiddenError;

/** Erreurs de la lecture publique : jamais de détail sur la raison (404 uniforme). */
export type SharedBinderLookupError = DatabaseError | ShareLinkNotFoundError;

/**
 * Liens de partage public (lecture seule) d'un classeur. Les opérations propriétaire sont
 * scopées par `userId` (RLS) : le lien d'un autre utilisateur est `ShareLinkNotFoundError`.
 * La lecture publique ne lit JAMAIS une table privée : elle passe uniquement par la fonction
 * SQL `get_shared_binder(token)` (ADR-008).
 */
export interface ShareServiceShape {
  /**
   * Crée un NOUVEAU lien (jeton cryptographique) pour un classeur du propriétaire ; plusieurs
   * liens actifs par classeur sont permis. Classeur inexistant ou d'autrui → `BinderNotFoundError`.
   */
  readonly createLink: (
    userId: string,
    input: CreateShareLinkInput,
  ) => Effect.Effect<ShareLink, ShareServiceError>;
  /** Liens du propriétaire, du plus récent au plus ancien ; filtrable par classeur / actifs. */
  readonly listLinks: (
    userId: string,
    filter?: ListShareLinksFilter,
  ) => Effect.Effect<ReadonlyArray<ShareLink>, ShareServiceError>;
  /**
   * Révoque immédiatement le lien (`is_active = false`, `revoked_at = now()`). Idempotent : un
   * lien déjà révoqué est renvoyé tel quel. Irréversible (créer un nouveau lien pour repartager).
   */
  readonly revokeLink: (
    userId: string,
    linkId: string,
  ) => Effect.Effect<ShareLink, ShareServiceError>;
  /** Montre / masque les quantités (doublons) sur la page publique. */
  readonly updateShowQuantities: (
    userId: string,
    linkId: string,
    showQuantities: boolean,
  ) => Effect.Effect<ShareLink, ShareServiceError>;
  /**
   * Lecture publique : projection stricte du classeur partagé. Jeton mal formé, inconnu ou
   * révoqué → `ShareLinkNotFoundError` (même `404`, aucune distinction).
   */
  readonly getSharedBinder: (
    token: string,
  ) => Effect.Effect<SharedBinderPayload, SharedBinderLookupError>;
}

/** Effect-TS service key of the share service. */
export class ShareService extends Context.Service<ShareService, ShareServiceShape>()(
  "@pokevault/services/ShareService",
) {}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "ValidationError",
  "BinderNotFoundError",
  "ShareLinkNotFoundError",
  "ShareLinkForbiddenError",
]);

/** Convertit une erreur de transaction en erreur typée (`undefined` ⇒ `DatabaseError`). */
export const mapShareError = (cause: unknown): ShareServiceError | undefined => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    DOMAIN_TAGS.has(cause._tag)
  ) {
    return cause as ShareServiceError;
  }
  switch (pgErrorCode(cause)) {
    case "42501":
      return new ShareLinkForbiddenError({ message: "share link operation forbidden", cause });
    case "23514":
    case "22P02":
      return new ValidationError({ message: "invalid share link data", cause });
    default:
      return undefined;
  }
};

const linkNotFound = (linkId: string): ShareLinkNotFoundError =>
  new ShareLinkNotFoundError({ linkId, message: `share link ${linkId} not found` });

const binderNotFound = (binderId: string): BinderNotFoundError =>
  new BinderNotFoundError({ binderId, message: `binder ${binderId} not found` });

/** 404 public uniforme : ne contient JAMAIS le jeton (secret) ni la raison du refus. */
const sharedBinderNotFound = (): ShareLinkNotFoundError =>
  new ShareLinkNotFoundError({ message: "shared binder not found" });

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const requireValidUser = (userId: string): Effect.Effect<string, ValidationError> =>
  isUuid(userId)
    ? Effect.succeed(userId.toLowerCase())
    : Effect.fail(new ValidationError({ message: "userId must be a valid UUID" }));

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface ShareLinkRow {
  readonly id: string;
  readonly user_id: string;
  readonly binder_id: string;
  readonly token: string;
  readonly is_active: boolean;
  readonly show_quantities: boolean;
  readonly created_at: Date | string;
  readonly revoked_at: Date | string | null;
}

const toLink = (row: ShareLinkRow): ShareLink => ({
  id: row.id,
  userId: row.user_id,
  binderId: row.binder_id,
  token: row.token,
  isActive: row.is_active,
  showQuantities: row.show_quantities,
  createdAt: iso(row.created_at),
  revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
});

/**
 * Live {@link ShareService} : opérations propriétaire en RLS transactionnelle (`withUserRls`,
 * filtre explicite par `user_id` en défense en profondeur) ; lecture publique par un appel
 * direct à `public.get_shared_binder(token)` (aucune lecture de table privée).
 */
export const ShareServiceLive: Layer.Layer<ShareService, never, Database> = Layer.effect(
  ShareService,
  Effect.gen(function* () {
    const { sql } = yield* Database;
    const rls = <A>(userId: string, fn: (tx: Sql) => Promise<A>) =>
      withUserRls<A, ShareServiceError>(sql, userId, fn, { mapError: mapShareError });

    const service: ShareServiceShape = {
      createLink: (userId, input) =>
        decodeCreateShareLinkInput(input).pipe(
          Effect.flatMap((validated) =>
            rls(userId, async (tx) => {
              // RLS : le classeur d'un autre utilisateur est invisible, donc « introuvable ».
              const owned = await tx<Array<{ id: string }>>`
                select id from public.binders
                 where id = ${validated.binderId} and user_id = ${userId}`;
              if (owned.length === 0) throw binderNotFound(validated.binderId);
              const rows = await tx<ShareLinkRow[]>`
                insert into public.share_links (user_id, binder_id, token, show_quantities)
                values (${userId}::uuid, ${validated.binderId}::uuid, ${generateShareToken()},
                        ${validated.showQuantities ?? true})
                returning id, user_id, binder_id, token, is_active, show_quantities,
                          created_at, revoked_at`;
              const row = rows[0];
              if (row === undefined) throw new Error("share link insert returned no row");
              return toLink(row);
            }),
          ),
        ),

      listLinks: (userId, filter = {}) =>
        rls(userId, async (tx) => {
          const rows = await tx<ShareLinkRow[]>`
            select id, user_id, binder_id, token, is_active, show_quantities,
                   created_at, revoked_at
              from public.share_links
             where user_id = ${userId}
               and (${filter.binderId ?? null}::text is null
                    or binder_id::text = ${filter.binderId ?? null}::text)
               and (${filter.activeOnly ?? false}::boolean = false
                    or (is_active and revoked_at is null))
             order by created_at desc, id desc`;
          return rows.map(toLink);
        }),

      revokeLink: (userId, linkId) =>
        rls(userId, async (tx) => {
          if (!isUuid(linkId)) throw linkNotFound(linkId);
          const revoked = await tx<ShareLinkRow[]>`
            update public.share_links
               set is_active = false, revoked_at = now()
             where id = ${linkId} and user_id = ${userId} and is_active
            returning id, user_id, binder_id, token, is_active, show_quantities,
                      created_at, revoked_at`;
          const row =
            revoked[0] ??
            (
              await tx<ShareLinkRow[]>`
                select id, user_id, binder_id, token, is_active, show_quantities,
                       created_at, revoked_at
                  from public.share_links
                 where id = ${linkId} and user_id = ${userId}`
            )[0];
          if (row === undefined) throw linkNotFound(linkId);
          return toLink(row);
        }),

      updateShowQuantities: (userId, linkId, showQuantities) =>
        rls(userId, async (tx) => {
          if (!isUuid(linkId)) throw linkNotFound(linkId);
          const rows = await tx<ShareLinkRow[]>`
            update public.share_links
               set show_quantities = ${showQuantities}
             where id = ${linkId} and user_id = ${userId}
            returning id, user_id, binder_id, token, is_active, show_quantities,
                      created_at, revoked_at`;
          const row = rows[0];
          if (row === undefined) throw linkNotFound(linkId);
          return toLink(row);
        }),

      getSharedBinder: (token) =>
        Effect.gen(function* () {
          if (!isValidShareToken(token)) return yield* Effect.fail(sharedBinderNotFound());
          const rows = yield* Effect.tryPromise({
            try: () =>
              sql<Array<{ payload: unknown }>>`
                select public.get_shared_binder(${token}::text) as payload`,
            // Pas de `cause` : l'erreur postgres pourrait citer le jeton.
            catch: () => new DatabaseError({ message: "get_shared_binder failed" }),
          });
          const payload = rows[0]?.payload ?? null;
          if (payload === null) return yield* Effect.fail(sharedBinderNotFound());
          // Échec fermé : une clé inattendue n'est jamais relayée au navigateur.
          return yield* decodeSharedBinderPayload(payload).pipe(
            Effect.mapError(
              () =>
                new DatabaseError({
                  message: "get_shared_binder returned an unexpected payload shape",
                }),
            ),
          );
        }),
    };
    return service;
  }),
);

// ---------------------------------------------------------------------------
// Memory implementation (unit tests, 100 % offline)
// ---------------------------------------------------------------------------

/** Détails de carte absents du store mémoire (nom, rareté…) ; tout est optionnel. */
export interface MemoryShareCardDetails {
  readonly localId?: string | undefined;
  readonly nameFr?: string | undefined;
  readonly rarity?: string | null | undefined;
  readonly holoEffect?: HoloEffect | undefined;
  readonly imageBaseUrl?: string | null | undefined;
}

export interface ShareServiceMemoryOptions {
  /** Profil public du propriétaire (défaut : « Collectionneur » / « C »). */
  readonly owner?: ((userId: string) => SharedBinderOwner) | undefined;
  /** Détails des cartes (défaut : `localId` = suffixe de l'id, `nameFr` = id). */
  readonly cardDetails?: ((cardId: string) => MemoryShareCardDetails | undefined) | undefined;
  /** Générateur de jetons (défaut {@link generateShareToken}) — injectable pour des tests déterministes. */
  readonly generateToken?: (() => string) | undefined;
}

/**
 * {@link ShareService} en mémoire, adossé au {@link CollectionMemoryStore} partagé (classeurs,
 * dossiers, exemplaires, catalogue). Reproduit la projection SQL : liste blanche stricte de
 * champs, `show_quantities`, tri, jetons invalides / révoqués → `ShareLinkNotFoundError`.
 */
export const ShareServiceMemoryLayer = (
  options: ShareServiceMemoryOptions = {},
): Layer.Layer<ShareService, never, CollectionMemoryStore> =>
  Layer.effect(
    ShareService,
    Effect.gen(function* () {
      const { catalog, state } = yield* CollectionMemoryStore;
      const links = new Map<string, ShareLink>();
      /** Ordre d'insertion : départage deux liens créés dans la même milliseconde. */
      const sequence = new Map<string, number>();
      let nextSequence = 0;
      const newToken = options.generateToken ?? generateShareToken;
      const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

      const ownLink = (
        uid: string,
        linkId: string,
      ): Effect.Effect<ShareLink, ShareLinkNotFoundError> => {
        const link = isUuid(linkId) ? links.get(linkId.toLowerCase()) : undefined;
        return link !== undefined && link.userId === uid
          ? Effect.succeed(link)
          : Effect.fail(linkNotFound(linkId));
      };

      const remember = (link: ShareLink): void => {
        links.set(link.id, link);
      };

      const projectCards = (
        binder: Binder,
        showQuantities: boolean,
      ): ReadonlyArray<SharedBinderCard & { readonly order: ReadonlyArray<number | string> }> => {
        const cardIds =
          binder.kind === "set"
            ? catalog.cards.filter((card) => card.setId === binder.setId).map((card) => card.id)
            : state.binderCards
                .filter((entry) => entry.binderId === binder.id)
                .map((entry) => entry.cardId);
        return cardIds.flatMap((cardId) => {
          const card = catalog.cards.find((entry) => entry.id === cardId);
          if (card === undefined) return [];
          const set = catalog.sets.find((entry) => entry.id === card.setId);
          const details = options.cardDetails?.(cardId);
          const entry = state.binderCards.find(
            (item) => item.binderId === binder.id && item.cardId === cardId,
          );
          const localId = details?.localId ?? cardId.slice(cardId.lastIndexOf("-") + 1);

          // Exemplaires du propriétaire, agrégés par (langue, variante). État, prix d'achat,
          // notes, grading et date d'acquisition ne sont jamais lus.
          const grouped = new Map<
            string,
            { language: CardLanguage; variant: CardVariant; qty: number }
          >();
          for (const copy of state.copies.values()) {
            if (
              copy.userId.toLowerCase() !== binder.userId.toLowerCase() ||
              copy.cardId !== cardId
            ) {
              continue;
            }
            const key = `${copy.language}\u0000${copy.variant}`;
            const current = grouped.get(key);
            grouped.set(key, {
              language: copy.language,
              variant: copy.variant,
              qty: (current?.qty ?? 0) + copy.quantity,
            });
          }
          const groups = [...grouped.values()].sort(
            (a, b) => compare(a.language, b.language) || compare(a.variant, b.variant),
          );
          const copies: ReadonlyArray<SharedBinderCopy> = groups.map((group) => ({
            language: group.language,
            variant: group.variant,
            quantity: showQuantities ? group.qty : null,
          }));
          const total = groups.reduce((sum, group) => sum + group.qty, 0);

          return [
            {
              cardId,
              localId,
              localIdNumeric: card.localIdNumeric,
              nameFr: details?.nameFr ?? cardId,
              setCode: set?.code ?? null,
              rarity: details?.rarity ?? null,
              holoEffect: details?.holoEffect ?? "none",
              imageBaseUrl: details?.imageBaseUrl ?? null,
              owned: total > 0,
              quantity: showQuantities ? total : null,
              copies,
              // `position, added_at` (dossier perso) ; `local_id_numeric NULLS LAST, local_id` (extension).
              order:
                binder.kind === "custom"
                  ? [
                      entry?.position ?? 0,
                      entry?.addedAt ?? "",
                      card.localIdNumeric ?? Number.MAX_SAFE_INTEGER,
                      localId,
                    ]
                  : [card.localIdNumeric ?? Number.MAX_SAFE_INTEGER, localId],
            },
          ];
        });
      };

      const service: ShareServiceShape = {
        createLink: (userId, input) =>
          Effect.gen(function* () {
            const uid = yield* requireValidUser(userId);
            const validated = yield* decodeCreateShareLinkInput(input);
            const binder = state.binders.get(validated.binderId.toLowerCase());
            if (binder === undefined || binder.userId.toLowerCase() !== uid) {
              return yield* Effect.fail(binderNotFound(validated.binderId));
            }
            const token = newToken();
            if ([...links.values()].some((link) => link.token === token)) {
              return yield* Effect.fail(new ValidationError({ message: "share token collision" }));
            }
            const created: ShareLink = {
              id: crypto.randomUUID(),
              userId: uid,
              binderId: binder.id,
              token,
              isActive: true,
              showQuantities: validated.showQuantities ?? true,
              createdAt: yield* nowIso,
              revokedAt: null,
            };
            sequence.set(created.id, nextSequence++);
            remember(created);
            return created;
          }),

        listLinks: (userId, filter = {}) =>
          Effect.gen(function* () {
            const uid = yield* requireValidUser(userId);
            return [...links.values()]
              .filter((link) => link.userId === uid)
              .filter((link) => filter.binderId === undefined || link.binderId === filter.binderId)
              .filter((link) => filter.activeOnly !== true || link.isActive)
              .sort(
                (a, b) =>
                  b.createdAt.localeCompare(a.createdAt) ||
                  (sequence.get(b.id) ?? 0) - (sequence.get(a.id) ?? 0),
              );
          }),

        revokeLink: (userId, linkId) =>
          Effect.gen(function* () {
            const uid = yield* requireValidUser(userId);
            const link = yield* ownLink(uid, linkId);
            if (!link.isActive) return link;
            const revoked: ShareLink = { ...link, isActive: false, revokedAt: yield* nowIso };
            remember(revoked);
            return revoked;
          }),

        updateShowQuantities: (userId, linkId, showQuantities) =>
          Effect.gen(function* () {
            const uid = yield* requireValidUser(userId);
            const link = yield* ownLink(uid, linkId);
            const updated: ShareLink = { ...link, showQuantities };
            remember(updated);
            return updated;
          }),

        getSharedBinder: (token) =>
          Effect.gen(function* () {
            if (!isValidShareToken(token)) return yield* Effect.fail(sharedBinderNotFound());
            const link = [...links.values()].find(
              (entry) => entry.token === token && entry.isActive && entry.revokedAt === null,
            );
            const binder = link === undefined ? undefined : state.binders.get(link.binderId);
            if (
              link === undefined ||
              binder === undefined ||
              binder.userId.toLowerCase() !== link.userId
            ) {
              return yield* Effect.fail(sharedBinderNotFound());
            }
            const set =
              binder.setId === null
                ? undefined
                : catalog.sets.find((entry) => entry.id === binder.setId);
            const coverCardDetails =
              binder.coverCardId === null ? undefined : options.cardDetails?.(binder.coverCardId);
            const cards = projectCards(binder, link.showQuantities)
              .slice()
              .sort((a, b) => compareOrder(a.order, b.order))
              .map(({ order: _order, ...card }): SharedBinderCard => card);
            const owner = options.owner?.(link.userId) ?? {
              displayName: "Collectionneur",
              avatarInitials: "C",
            };

            return {
              owner: { displayName: owner.displayName, avatarInitials: owner.avatarInitials },
              binder: {
                id: binder.id,
                kind: binder.kind,
                title: binder.title,
                setId: binder.setId,
                setCode: set?.code ?? null,
                setName: set?.nameFr ?? null,
                coverType: binder.coverType,
                coverLogoUrl: set?.logoUrl ?? null,
                coverCardImageUrl: coverCardDetails?.imageBaseUrl ?? null,
                // Booléen uniquement : le chemin Storage (qui embarque le user_id) n'est jamais exposé.
                hasUploadedCover: binder.coverType === "upload" && binder.coverStoragePath !== null,
                showQuantities: link.showQuantities,
                ownedCount: cards.filter((card) => card.owned).length,
                totalCards: cards.length,
              },
              cards,
            };
          }),
      };
      return service;
    }),
  );

/** {@link ShareService} en mémoire avec les réglages par défaut. */
export const ShareServiceMemory: Layer.Layer<ShareService, never, CollectionMemoryStore> =
  ShareServiceMemoryLayer();

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareOrder = (
  a: ReadonlyArray<number | string>,
  b: ReadonlyArray<number | string>,
): number => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || left === right) continue;
    const result =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : compare(String(left), String(right));
    if (result !== 0) return result;
  }
  return 0;
};
