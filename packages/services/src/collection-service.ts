import {
  buildCollectionOverview,
  type CardCondition,
  CardCopyConflictError,
  CardCopyNotFoundError,
  type CardLanguage,
  type CardVariant,
  CatalogItemNotFoundError,
  type CollectionOverview,
  type CompletionOptions,
  copySlotKey,
  decodeUpdateCardCopyInput,
  decodeUpsertCardCopyInput,
  type GradingCompany,
  isUuid,
  type ListCardCopiesFilter,
  MAX_CARD_COPY_QUANTITY,
  type OverviewCopy,
  UnauthorizedBinderAccess,
  type UpdateCardCopyInput,
  type UpsertCardCopyInput,
  type UserCardCopy,
  ValidationError,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { CollectionMemoryStore } from "./collection-memory.ts";
import { Database, type DatabaseError, type Sql } from "./db.ts";
import { pgErrorCode, withUserRls } from "./rls.ts";

// ---------------------------------------------------------------------------
// Errors & service contract
// ---------------------------------------------------------------------------

/** Union des erreurs typées des opérations de {@link CollectionService}. */
export type CollectionServiceError =
  | DatabaseError
  | ValidationError
  | CardCopyNotFoundError
  | CardCopyConflictError
  | CatalogItemNotFoundError
  | UnauthorizedBinderAccess;

/**
 * Exemplaires possédés (`user_card_copies`) d'un utilisateur, regroupés par slot unique
 * `(carte, langue, variante, état, grading)` avec une `quantity` (`1..MAX_CARD_COPY_QUANTITY`).
 * Toujours scopé par `userId` ; un exemplaire d'un autre utilisateur est `CardCopyNotFoundError`.
 */
export interface CollectionServiceShape {
  readonly listCardCopies: (
    userId: string,
    filter?: ListCardCopiesFilter,
  ) => Effect.Effect<ReadonlyArray<UserCardCopy>, CollectionServiceError>;
  /**
   * Ajoute des exemplaires : crée le slot ou, s'il existe, **incrémente** sa quantité
   * (`mode: "increment"`, défaut) / la **fixe** (`mode: "set"`). Dépasser 999 est refusé
   * (`ValidationError`), jamais tronqué silencieusement.
   */
  readonly upsertCardCopy: (
    userId: string,
    input: UpsertCardCopyInput,
  ) => Effect.Effect<UserCardCopy, CollectionServiceError>;
  /**
   * Stepper `- / +` : ajoute `delta` (entier). Retourne `null` quand la quantité tombe à
   * `<= 0` (la ligne est supprimée) ; `ValidationError` au-delà de 999.
   */
  readonly adjustCardCopyQuantity: (
    userId: string,
    copyId: string,
    delta: number,
  ) => Effect.Effect<UserCardCopy | null, CollectionServiceError>;
  /** Met à jour état, prix d'achat, notes, date d'acquisition et grading. */
  readonly updateCardCopy: (
    userId: string,
    copyId: string,
    patch: UpdateCardCopyInput,
  ) => Effect.Effect<UserCardCopy, CollectionServiceError>;
  readonly deleteCardCopy: (
    userId: string,
    copyId: string,
  ) => Effect.Effect<void, CollectionServiceError>;
  /** Complétion globale, par série et par extension (fonctions pures du domaine). */
  readonly getCollectionOverview: (
    userId: string,
    options?: CompletionOptions,
  ) => Effect.Effect<CollectionOverview, CollectionServiceError>;
}

/** Effect-TS service key of the collection service. */
export class CollectionService extends Context.Service<CollectionService, CollectionServiceShape>()(
  "@pokevault/services/CollectionService",
) {}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "ValidationError",
  "CardCopyNotFoundError",
  "CardCopyConflictError",
  "CatalogItemNotFoundError",
]);

/** Convertit une erreur de transaction en erreur typée (`undefined` ⇒ `DatabaseError`). */
export const mapCollectionError = (cause: unknown): CollectionServiceError | undefined => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    DOMAIN_TAGS.has(cause._tag)
  ) {
    return cause as CollectionServiceError;
  }
  switch (pgErrorCode(cause)) {
    case "42501":
      return new UnauthorizedBinderAccess({ message: "access to card copy denied", cause });
    case "23505":
      return new CardCopyConflictError({
        message: "a copy with the same slot already exists",
        cause,
      });
    case "23514":
    case "22P02":
    case "22003":
      return new ValidationError({ message: "invalid card copy data", cause });
    default:
      return undefined;
  }
};

const copyNotFound = (copyId: string): CardCopyNotFoundError =>
  new CardCopyNotFoundError({ copyId, message: `card copy ${copyId} not found` });

const quantityLimit = (): ValidationError =>
  new ValidationError({
    message: `quantity cannot exceed ${MAX_CARD_COPY_QUANTITY} per copy slot`,
  });

const cardNotFound = (cardId: string): CatalogItemNotFoundError =>
  new CatalogItemNotFoundError({
    entity: "card",
    id: cardId,
    message: `card ${cardId} not found in the catalog`,
  });

const DEFAULT_LANGUAGE: CardLanguage = "FR";
const DEFAULT_CONDITION: CardCondition = "NM";

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface CopyRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity: number;
  readonly purchase_price_cents: number | null;
  readonly grading_company: GradingCompany | null;
  readonly grading_score: string | null;
  readonly notes: string | null;
  readonly acquired_at: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toCopy = (row: CopyRow): UserCardCopy => ({
  id: row.id,
  userId: row.user_id,
  cardId: row.card_id,
  language: row.language,
  variant: row.variant,
  condition: row.condition,
  quantity: row.quantity,
  purchasePriceCents: row.purchase_price_cents,
  gradingCompany: row.grading_company,
  gradingScore: row.grading_score,
  notes: row.notes,
  acquiredAt: row.acquired_at,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

/** Live {@link CollectionService} : RLS transactionnelle + filtre explicite par `user_id`. */
export const CollectionServiceLive: Layer.Layer<CollectionService, never, Database> = Layer.effect(
  CollectionService,
  Effect.gen(function* () {
    const { sql } = yield* Database;
    const rls = <A>(userId: string, fn: (tx: Sql) => Promise<A>) =>
      withUserRls<A, CollectionServiceError>(sql, userId, fn, { mapError: mapCollectionError });

    const service: CollectionServiceShape = {
      listCardCopies: (userId, filter = {}) =>
        rls(userId, async (tx) => {
          const rows = await tx<CopyRow[]>`
            select c.id, c.user_id, c.card_id, c.language, c.variant, c.condition, c.quantity,
                   c.purchase_price_cents, c.grading_company, c.grading_score, c.notes,
                   c.acquired_at::text as acquired_at, c.created_at, c.updated_at
              from public.user_card_copies c
              join public.catalog_cards k on k.id = c.card_id
             where c.user_id = ${userId}
               and (${filter.cardId ?? null}::text is null or c.card_id = ${filter.cardId ?? null}::text)
               and (${filter.setId ?? null}::text is null or k.set_id = ${filter.setId ?? null}::text)
             order by c.card_id asc, c.created_at asc, c.id asc`;
          return rows.map(toCopy);
        }),

      upsertCardCopy: (userId, input) =>
        decodeUpsertCardCopyInput(input).pipe(
          Effect.flatMap((validated) =>
            rls(userId, async (tx) => {
              const mode = validated.mode ?? "increment";
              const quantity = validated.quantity ?? 1;
              const exists = await tx<Array<{ ok: number }>>`
                select 1 as ok from public.catalog_cards where id = ${validated.cardId}`;
              if (exists.length === 0) throw cardNotFound(validated.cardId);

              // L'index unique d'expression est la cible de l'ON CONFLICT (slot atomique, sans
              // course entre deux ajouts simultanés). En mode incrément, la clause WHERE refuse
              // de dépasser le plafond : aucune ligne n'est alors renvoyée.
              const total =
                mode === "set"
                  ? tx`excluded.quantity`
                  : tx`public.user_card_copies.quantity + excluded.quantity`;
              const guard =
                mode === "set"
                  ? tx`excluded.quantity between 1 and ${MAX_CARD_COPY_QUANTITY}`
                  : tx`public.user_card_copies.quantity + excluded.quantity <= ${MAX_CARD_COPY_QUANTITY}`;
              const rows = await tx<CopyRow[]>`
                insert into public.user_card_copies
                  (user_id, card_id, language, variant, condition, quantity, purchase_price_cents,
                   grading_company, grading_score, notes, acquired_at)
                values
                  (${userId}, ${validated.cardId}, ${validated.language ?? DEFAULT_LANGUAGE}, ${validated.variant},
                   ${validated.condition ?? DEFAULT_CONDITION}, ${quantity}, ${validated.purchasePriceCents ?? null},
                   ${validated.gradingCompany ?? null}, ${validated.gradingScore ?? null}, ${validated.notes ?? null},
                   case when ${validated.acquiredAt !== undefined}::boolean
                        then ${validated.acquiredAt ?? null}::date else current_date end)
                on conflict (user_id, card_id, language, variant, condition,
                             (coalesce(grading_company, '')), (coalesce(grading_score, '')))
                do update set
                  quantity = ${total},
                  purchase_price_cents = coalesce(excluded.purchase_price_cents, public.user_card_copies.purchase_price_cents),
                  notes = coalesce(excluded.notes, public.user_card_copies.notes)
                where ${guard}
                returning id, user_id, card_id, language, variant, condition, quantity,
                          purchase_price_cents, grading_company, grading_score, notes,
                          acquired_at::text as acquired_at, created_at, updated_at`;
              const row = rows[0];
              if (row === undefined) throw quantityLimit();
              return toCopy(row);
            }),
          ),
        ),

      adjustCardCopyQuantity: (userId, copyId, delta) =>
        rls(userId, async (tx) => {
          if (!Number.isInteger(delta)) {
            throw new ValidationError({ message: "delta must be an integer" });
          }
          if (!isUuid(copyId)) throw copyNotFound(copyId);
          const [row] = await tx<CopyRow[]>`
            select id, user_id, card_id, language, variant, condition, quantity,
                   purchase_price_cents, grading_company, grading_score, notes,
                   acquired_at::text as acquired_at, created_at, updated_at
              from public.user_card_copies
             where id = ${copyId} and user_id = ${userId}
               for update`;
          if (row === undefined) throw copyNotFound(copyId);
          const next = row.quantity + delta;
          if (next > MAX_CARD_COPY_QUANTITY) throw quantityLimit();
          if (next <= 0) {
            await tx`delete from public.user_card_copies where id = ${copyId} and user_id = ${userId}`;
            return null;
          }
          if (delta === 0) return toCopy(row);
          const [updated] = await tx<CopyRow[]>`
            update public.user_card_copies set quantity = ${next}
             where id = ${copyId} and user_id = ${userId}
            returning id, user_id, card_id, language, variant, condition, quantity,
                      purchase_price_cents, grading_company, grading_score, notes,
                      acquired_at::text as acquired_at, created_at, updated_at`;
          if (updated === undefined) throw copyNotFound(copyId);
          return toCopy(updated);
        }),

      updateCardCopy: (userId, copyId, patch) =>
        decodeUpdateCardCopyInput(patch).pipe(
          Effect.flatMap((validated) =>
            rls(userId, async (tx) => {
              if (!isUuid(copyId)) throw copyNotFound(copyId);
              const entries: Array<[string, string | number | null]> = [];
              if (validated.condition !== undefined)
                entries.push(["condition", validated.condition]);
              if (validated.purchasePriceCents !== undefined) {
                entries.push(["purchase_price_cents", validated.purchasePriceCents]);
              }
              if (validated.gradingCompany !== undefined) {
                entries.push(["grading_company", validated.gradingCompany]);
              }
              if (validated.gradingScore !== undefined) {
                entries.push(["grading_score", validated.gradingScore]);
              }
              if (validated.notes !== undefined) entries.push(["notes", validated.notes]);
              if (validated.acquiredAt !== undefined) {
                entries.push(["acquired_at", validated.acquiredAt]);
              }
              const columns = Object.fromEntries(entries);
              const rows = await tx<CopyRow[]>`
                update public.user_card_copies set ${tx(columns)}
                 where id = ${copyId} and user_id = ${userId}
                returning id, user_id, card_id, language, variant, condition, quantity,
                          purchase_price_cents, grading_company, grading_score, notes,
                          acquired_at::text as acquired_at, created_at, updated_at`;
              const row = rows[0];
              if (row === undefined) throw copyNotFound(copyId);
              return toCopy(row);
            }),
          ),
        ),

      deleteCardCopy: (userId, copyId) =>
        rls(userId, async (tx) => {
          if (!isUuid(copyId)) throw copyNotFound(copyId);
          const rows = await tx<Array<{ id: string }>>`
            delete from public.user_card_copies
             where id = ${copyId} and user_id = ${userId} returning id`;
          if (rows.length === 0) throw copyNotFound(copyId);
        }),

      getCollectionOverview: (userId, options = {}) =>
        rls(userId, async (tx) => {
          const series = await tx<Array<{ id: string; name_fr: string; release_order: number }>>`
            select id, name_fr, release_order from public.catalog_series`;
          const sets = await tx<
            Array<{
              id: string;
              series_id: string;
              name_fr: string;
              code: string | null;
              logo_url: string | null;
              release_date: string | null;
              official_count: number;
              total_count: number;
            }>
          >`
            select id, series_id, name_fr, code, logo_url, release_date::text as release_date,
                   official_count, total_count
              from public.catalog_sets`;
          const copies = await tx<
            Array<{
              set_id: string;
              card_id: string;
              variant: CardVariant;
              quantity: number;
              local_id_numeric: number | null;
            }>
          >`
            select k.set_id, c.card_id, c.variant, c.quantity, k.local_id_numeric
              from public.user_card_copies c
              join public.catalog_cards k on k.id = c.card_id
             where c.user_id = ${userId}`;
          const tracked = await tx<Array<{ set_id: string }>>`
            select set_id from public.binders
             where user_id = ${userId} and kind = 'set' and set_id is not null`;
          return buildCollectionOverview(
            {
              series: series.map((row) => ({
                id: row.id,
                nameFr: row.name_fr,
                releaseOrder: row.release_order,
              })),
              sets: sets.map((row) => ({
                id: row.id,
                seriesId: row.series_id,
                nameFr: row.name_fr,
                code: row.code,
                logoUrl: row.logo_url,
                releaseDate: row.release_date,
                officialCount: row.official_count,
                totalCount: row.total_count,
              })),
              copies: copies.map(
                (row): OverviewCopy => ({
                  setId: row.set_id,
                  cardId: row.card_id,
                  variant: row.variant,
                  quantity: row.quantity,
                  localIdNumeric: row.local_id_numeric,
                }),
              ),
              trackedSetIds: new Set(tracked.map((row) => row.set_id)),
            },
            options,
          );
        }),
    };
    return service;
  }),
);

// ---------------------------------------------------------------------------
// Memory implementation (tests)
// ---------------------------------------------------------------------------

/** {@link CollectionService} en mémoire, adossé au {@link CollectionMemoryStore} partagé. */
export const CollectionServiceMemory: Layer.Layer<CollectionService, never, CollectionMemoryStore> =
  Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const { catalog, state } = yield* CollectionMemoryStore;
      const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

      const requireUser = (userId: string): Effect.Effect<string, ValidationError> =>
        isUuid(userId)
          ? Effect.succeed(userId.toLowerCase())
          : Effect.fail(new ValidationError({ message: "userId must be a valid UUID" }));

      const ownCopy = (
        uid: string,
        copyId: string,
      ): Effect.Effect<UserCardCopy, CardCopyNotFoundError> => {
        const copy = state.copies.get(copyId);
        return copy !== undefined && copy.userId.toLowerCase() === uid
          ? Effect.succeed(copy)
          : Effect.fail(copyNotFound(copyId));
      };

      const findSlot = (
        uid: string,
        slot: Parameters<typeof copySlotKey>[0],
      ): UserCardCopy | undefined => {
        const key = copySlotKey(slot);
        return [...state.copies.values()].find(
          (copy) => copy.userId.toLowerCase() === uid && copySlotKey(copy) === key,
        );
      };

      const service: CollectionServiceShape = {
        listCardCopies: (userId, filter = {}) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const cardsOfSet =
              filter.setId === undefined
                ? undefined
                : new Set(
                    catalog.cards.filter((card) => card.setId === filter.setId).map((c) => c.id),
                  );
            return [...state.copies.values()]
              .filter((copy) => copy.userId.toLowerCase() === uid)
              .filter((copy) => filter.cardId === undefined || copy.cardId === filter.cardId)
              .filter((copy) => cardsOfSet === undefined || cardsOfSet.has(copy.cardId))
              .sort(
                (a, b) =>
                  a.cardId.localeCompare(b.cardId) ||
                  a.createdAt.localeCompare(b.createdAt) ||
                  a.id.localeCompare(b.id),
              );
          }),

        upsertCardCopy: (userId, input) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const validated = yield* decodeUpsertCardCopyInput(input);
            if (!catalog.cards.some((card) => card.id === validated.cardId)) {
              return yield* Effect.fail(cardNotFound(validated.cardId));
            }
            const mode = validated.mode ?? "increment";
            const quantity = validated.quantity ?? 1;
            const now = yield* nowIso;
            const slot = {
              cardId: validated.cardId,
              language: validated.language ?? DEFAULT_LANGUAGE,
              variant: validated.variant,
              condition: validated.condition ?? DEFAULT_CONDITION,
              gradingCompany: validated.gradingCompany ?? null,
              gradingScore: validated.gradingScore ?? null,
            };
            const existing = findSlot(uid, slot);
            if (existing !== undefined) {
              const total = mode === "set" ? quantity : existing.quantity + quantity;
              if (total > MAX_CARD_COPY_QUANTITY) return yield* Effect.fail(quantityLimit());
              const next: UserCardCopy = {
                ...existing,
                quantity: total,
                purchasePriceCents: validated.purchasePriceCents ?? existing.purchasePriceCents,
                notes: validated.notes ?? existing.notes,
                updatedAt: now,
              };
              state.copies.set(next.id, next);
              return next;
            }
            const created: UserCardCopy = {
              id: crypto.randomUUID(),
              userId: uid,
              ...slot,
              quantity,
              purchasePriceCents: validated.purchasePriceCents ?? null,
              notes: validated.notes ?? null,
              acquiredAt:
                validated.acquiredAt === undefined ? now.slice(0, 10) : validated.acquiredAt,
              createdAt: now,
              updatedAt: now,
            };
            state.copies.set(created.id, created);
            return created;
          }),

        adjustCardCopyQuantity: (userId, copyId, delta) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            if (!Number.isInteger(delta)) {
              return yield* Effect.fail(
                new ValidationError({ message: "delta must be an integer" }),
              );
            }
            const copy = yield* ownCopy(uid, isUuid(copyId) ? copyId : "");
            const next = copy.quantity + delta;
            if (next > MAX_CARD_COPY_QUANTITY) return yield* Effect.fail(quantityLimit());
            if (next <= 0) {
              state.copies.delete(copy.id);
              return null;
            }
            if (delta === 0) return copy;
            const now = yield* nowIso;
            const updated: UserCardCopy = { ...copy, quantity: next, updatedAt: now };
            state.copies.set(updated.id, updated);
            return updated;
          }),

        updateCardCopy: (userId, copyId, patch) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const validated = yield* decodeUpdateCardCopyInput(patch);
            const copy = yield* ownCopy(uid, isUuid(copyId) ? copyId : "");
            const candidate: UserCardCopy = {
              ...copy,
              ...(validated.condition === undefined ? {} : { condition: validated.condition }),
              ...(validated.purchasePriceCents === undefined
                ? {}
                : { purchasePriceCents: validated.purchasePriceCents }),
              ...(validated.gradingCompany === undefined
                ? {}
                : { gradingCompany: validated.gradingCompany }),
              ...(validated.gradingScore === undefined
                ? {}
                : { gradingScore: validated.gradingScore }),
              ...(validated.notes === undefined ? {} : { notes: validated.notes }),
              ...(validated.acquiredAt === undefined ? {} : { acquiredAt: validated.acquiredAt }),
            };
            const clash = findSlot(uid, candidate);
            if (clash !== undefined && clash.id !== copy.id) {
              return yield* Effect.fail(
                new CardCopyConflictError({ message: "a copy with the same slot already exists" }),
              );
            }
            const now = yield* nowIso;
            const updated: UserCardCopy = { ...candidate, updatedAt: now };
            state.copies.set(updated.id, updated);
            return updated;
          }),

        deleteCardCopy: (userId, copyId) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const copy = yield* ownCopy(uid, isUuid(copyId) ? copyId : "");
            state.copies.delete(copy.id);
          }),

        getCollectionOverview: (userId, options = {}) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const cardById = new Map(catalog.cards.map((card) => [card.id, card]));
            const copies: Array<OverviewCopy> = [];
            for (const copy of state.copies.values()) {
              const card = cardById.get(copy.cardId);
              if (copy.userId.toLowerCase() === uid && card !== undefined) {
                copies.push({
                  setId: card.setId,
                  cardId: copy.cardId,
                  variant: copy.variant,
                  quantity: copy.quantity,
                  localIdNumeric: card.localIdNumeric,
                });
              }
            }
            const trackedSetIds = new Set<string>();
            for (const binder of state.binders.values()) {
              if (
                binder.userId.toLowerCase() === uid &&
                binder.kind === "set" &&
                binder.setId !== null
              ) {
                trackedSetIds.add(binder.setId);
              }
            }
            return buildCollectionOverview(
              { series: catalog.series, sets: catalog.sets, copies, trackedSetIds },
              options,
            );
          }),
      };
      return service;
    }),
  );
