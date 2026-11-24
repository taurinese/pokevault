import {
  type Binder,
  type BinderCardEntry,
  BinderConflictError,
  type BinderKind,
  BinderNotFoundError,
  type BinderSetInfo,
  type BinderSummary,
  binderCoverStoragePath,
  CatalogItemNotFoundError,
  type CompletionCopy,
  type CompletionOptions,
  type CreateCustomBinderInput,
  type CreateSetBinderInput,
  computeSetCompletion,
  type InvalidCoverImageError,
  isUuid,
  type ListBindersFilter,
  normalizeBinderTitle,
  type SetBinderCoverInput,
  type StorageServiceError,
  UnauthorizedBinderAccess,
  type UpdateBinderInput,
  ValidationError,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { CollectionMemoryStore } from "./collection-memory.ts";
import { CoverImageProcessor } from "./cover-image.ts";
import { Database, DatabaseError, type Sql } from "./db.ts";
import { pgErrorCode, withUserRls } from "./rls.ts";
import { BinderCoverStorage } from "./storage.ts";

// ---------------------------------------------------------------------------
// Errors & service contract
// ---------------------------------------------------------------------------

/** Union des erreurs typées des opérations de {@link BinderService}. */
export type BinderServiceError =
  | DatabaseError
  | ValidationError
  | BinderNotFoundError
  | BinderConflictError
  | UnauthorizedBinderAccess
  | CatalogItemNotFoundError
  | InvalidCoverImageError
  | StorageServiceError;

/**
 * Classeurs d'extension (`kind = 'set'`) et dossiers perso (`kind = 'custom'`) d'un utilisateur.
 * Toutes les opérations sont scopées par `userId` : un classeur d'un autre utilisateur est
 * toujours `BinderNotFoundError` (invisible par RLS, jamais « interdit »).
 *
 * `authToken` = JWT Supabase de l'utilisateur, nécessaire uniquement pour toucher au Storage
 * (upload de cover, nettoyage d'un ancien objet).
 */
export interface BinderServiceShape {
  /** Classeurs triés `is_pinned DESC, sort_order ASC, created_at DESC`, avec complétion. */
  readonly listBinders: (
    userId: string,
    filter?: ListBindersFilter,
  ) => Effect.Effect<ReadonlyArray<BinderSummary>, BinderServiceError>;
  readonly getBinder: (
    userId: string,
    binderId: string,
  ) => Effect.Effect<BinderSummary, BinderServiceError>;
  /** Suit une extension. Idempotent (renvoie l'existant) sauf `ifExists: "fail"`. */
  readonly createSetBinder: (
    userId: string,
    input: CreateSetBinderInput,
  ) => Effect.Effect<BinderSummary, BinderServiceError>;
  readonly createCustomBinder: (
    userId: string,
    input: CreateCustomBinderInput,
  ) => Effect.Effect<BinderSummary, BinderServiceError>;
  readonly updateBinder: (
    userId: string,
    binderId: string,
    patch: UpdateBinderInput,
  ) => Effect.Effect<BinderSummary, BinderServiceError>;
  readonly setBinderCover: (
    userId: string,
    binderId: string,
    input: SetBinderCoverInput,
    authToken?: string,
  ) => Effect.Effect<BinderSummary, BinderServiceError>;
  readonly deleteBinder: (
    userId: string,
    binderId: string,
    authToken?: string,
  ) => Effect.Effect<void, BinderServiceError>;
  readonly listBinderCards: (
    userId: string,
    binderId: string,
  ) => Effect.Effect<ReadonlyArray<BinderCardEntry>, BinderServiceError>;
  /** Ajoute (ou déplace, si présente) une carte ; sans `position`, ajout en fin de dossier. */
  readonly addCardToCustomBinder: (
    userId: string,
    binderId: string,
    cardId: string,
    position?: number,
  ) => Effect.Effect<BinderCardEntry, BinderServiceError>;
  /** Réordonne le dossier : `orderedCardIds` doit être une permutation de son contenu. */
  readonly reorderCustomBinderCards: (
    userId: string,
    binderId: string,
    orderedCardIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<BinderCardEntry>, BinderServiceError>;
  /** Retire une carte du dossier (idempotent si elle n'y est pas). */
  readonly removeCardFromCustomBinder: (
    userId: string,
    binderId: string,
    cardId: string,
  ) => Effect.Effect<void, BinderServiceError>;
}

/** Effect-TS service key of the binder service. */
export class BinderService extends Context.Service<BinderService, BinderServiceShape>()(
  "@pokevault/services/BinderService",
) {}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "ValidationError",
  "BinderNotFoundError",
  "BinderConflictError",
  "UnauthorizedBinderAccess",
  "CatalogItemNotFoundError",
]);

/** Convertit une erreur de transaction en erreur typée (`undefined` ⇒ `DatabaseError`). */
export const mapBinderError = (cause: unknown): BinderServiceError | undefined => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    DOMAIN_TAGS.has(cause._tag)
  ) {
    return cause as BinderServiceError;
  }
  switch (pgErrorCode(cause)) {
    case "42501":
      return new UnauthorizedBinderAccess({ message: "access to binder denied", cause });
    case "23505":
      return new BinderConflictError({ message: "binder already exists", cause });
    case "23514":
    case "22P02":
    case "22003":
      return new ValidationError({ message: "invalid binder data", cause });
    default:
      return undefined;
  }
};

const notFound = (binderId: string): BinderNotFoundError =>
  new BinderNotFoundError({ binderId, message: `binder ${binderId} not found` });

const NOT_A_CUSTOM = (binderId: string): ValidationError =>
  new ValidationError({
    message: `binder ${binderId} is not a custom binder: set binders are derived from the catalog`,
  });

const completionOptionsOf = (filter: CompletionOptions | undefined): CompletionOptions => ({
  includeSecrets: filter?.includeSecrets,
  includePromos: filter?.includePromos,
});

/** Journalise (sans jamais échouer) la suppression best-effort d'un ancien objet Storage. */
const cleanupCoverObject = (
  storage: Context.Service.Shape<typeof BinderCoverStorage>,
  params: {
    readonly userId: string;
    readonly binderId: string;
    readonly authToken?: string | undefined;
  },
  reason: string,
): Effect.Effect<void> =>
  (params.authToken === undefined
    ? Effect.logWarning("binder.cover.cleanup_skipped_no_token")
    : storage.remove({
        userId: params.userId,
        binderId: params.binderId,
        accessToken: params.authToken,
      })
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("binder.cover.cleanup_failed").pipe(
        Effect.annotateLogs({ reason, binderId: params.binderId, error: error.message }),
      ),
    ),
    Effect.annotateLogs({ reason, binderId: params.binderId }),
  );

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface BinderJoinRow {
  readonly id: string;
  readonly user_id: string;
  readonly kind: BinderKind;
  readonly set_id: string | null;
  readonly title: string;
  readonly cover_type: Binder["coverType"];
  readonly cover_card_id: string | null;
  readonly cover_storage_path: string | null;
  readonly is_pinned: boolean;
  readonly sort_order: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly set_name_fr: string | null;
  readonly set_code: string | null;
  readonly set_logo_url: string | null;
  readonly set_series_id: string | null;
  readonly set_release_date: string | null;
  readonly set_official_count: number | null;
  readonly set_total_count: number | null;
}

interface CopyRow {
  readonly set_id: string;
  readonly card_id: string;
  readonly variant: CompletionCopy["variant"];
  readonly quantity: number;
  readonly local_id_numeric: number | null;
}

interface CustomCountRow {
  readonly binder_id: string;
  readonly card_count: number;
  readonly owned_count: number;
}

interface BinderCardRow {
  readonly binder_id: string;
  readonly card_id: string;
  readonly position: number;
  readonly added_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toBinder = (row: BinderJoinRow): Binder => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  setId: row.set_id,
  title: row.title,
  coverType: row.cover_type,
  coverCardId: row.cover_card_id,
  coverStoragePath: row.cover_storage_path,
  isPinned: row.is_pinned,
  sortOrder: row.sort_order,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const toSetInfo = (row: BinderJoinRow): BinderSetInfo | null =>
  row.set_id === null
    ? null
    : {
        id: row.set_id,
        nameFr: row.set_name_fr ?? row.title,
        code: row.set_code,
        logoUrl: row.set_logo_url,
        seriesId: row.set_series_id ?? "",
        releaseDate: row.set_release_date,
        officialCount: row.set_official_count ?? 0,
        totalCount: row.set_total_count ?? 0,
      };

const toBinderCard = (row: BinderCardRow): BinderCardEntry => ({
  binderId: row.binder_id,
  cardId: row.card_id,
  position: row.position,
  addedAt: iso(row.added_at),
});

interface SummaryQuery extends ListBindersFilter {
  readonly binderId?: string | undefined;
}

/** Charge classeurs + agrégats de complétion dans la transaction RLS courante. */
const loadSummaries = async (
  tx: Sql,
  userId: string,
  query: SummaryQuery,
): Promise<ReadonlyArray<BinderSummary>> => {
  const rows = await tx<BinderJoinRow[]>`
    select b.id, b.user_id, b.kind, b.set_id, b.title, b.cover_type, b.cover_card_id,
           b.cover_storage_path, b.is_pinned, b.sort_order, b.created_at, b.updated_at,
           s.name_fr as set_name_fr, s.code as set_code, s.logo_url as set_logo_url,
           s.series_id as set_series_id, s.release_date::text as set_release_date,
           s.official_count as set_official_count, s.total_count as set_total_count
      from public.binders b
      left join public.catalog_sets s on s.id = b.set_id
     where b.user_id = ${userId}
       and (${query.binderId ?? null}::uuid is null or b.id = ${query.binderId ?? null}::uuid)
       and (${query.kind ?? null}::text is null or b.kind = ${query.kind ?? null}::text)
       and (${query.seriesId ?? null}::text is null or s.series_id = ${query.seriesId ?? null}::text)
     order by b.is_pinned desc, b.sort_order asc, b.created_at desc, b.id asc`;

  const setIds = [...new Set(rows.flatMap((row) => (row.set_id === null ? [] : [row.set_id])))];
  const customIds = rows.filter((row) => row.kind === "custom").map((row) => row.id);

  const copyRows =
    setIds.length === 0
      ? []
      : await tx<CopyRow[]>`
          select k.set_id, c.card_id, c.variant, c.quantity, k.local_id_numeric
            from public.user_card_copies c
            join public.catalog_cards k on k.id = c.card_id
           where c.user_id = ${userId} and k.set_id in ${tx(setIds)}`;
  const copiesBySet = new Map<string, Array<CompletionCopy>>();
  for (const copy of copyRows) {
    const list = copiesBySet.get(copy.set_id) ?? [];
    list.push({
      cardId: copy.card_id,
      variant: copy.variant,
      quantity: copy.quantity,
      localIdNumeric: copy.local_id_numeric,
    });
    copiesBySet.set(copy.set_id, list);
  }

  const customRows =
    customIds.length === 0
      ? []
      : await tx<CustomCountRow[]>`
          select bc.binder_id,
                 count(*)::int as card_count,
                 (count(*) filter (where exists (
                    select 1 from public.user_card_copies c
                     where c.user_id = ${userId} and c.card_id = bc.card_id and c.quantity > 0
                 )))::int as owned_count
            from public.binder_cards bc
           where bc.binder_id in ${tx(customIds)}
           group by bc.binder_id`;
  const customCounts = new Map(customRows.map((row) => [row.binder_id, row]));

  const options = completionOptionsOf(query);
  return rows.map((row): BinderSummary => {
    const binder = toBinder(row);
    const set = toSetInfo(row);
    if (set !== null) {
      const completion = computeSetCompletion(
        { setId: set.id, officialCount: set.officialCount, totalCount: set.totalCount },
        copiesBySet.get(set.id) ?? [],
        options,
      );
      return {
        binder,
        set,
        completion,
        cardCount: set.totalCount,
        ownedCount: completion.ownedDistinct,
      };
    }
    const counts = customCounts.get(row.id);
    return {
      binder,
      set: null,
      completion: null,
      cardCount: counts?.card_count ?? 0,
      ownedCount: counts?.owned_count ?? 0,
    };
  });
};

const summaryOrThrow = async (
  tx: Sql,
  userId: string,
  binderId: string,
  options: CompletionOptions = {},
): Promise<BinderSummary> => {
  const [summary] = await loadSummaries(tx, userId, { binderId, ...options });
  if (summary === undefined) throw notFound(binderId);
  return summary;
};

interface BinderHeadRow {
  readonly id: string;
  readonly kind: BinderKind;
  readonly cover_type: Binder["coverType"];
  readonly cover_storage_path: string | null;
}

const loadHead = async (tx: Sql, userId: string, binderId: string): Promise<BinderHeadRow> => {
  if (!isUuid(binderId)) throw notFound(binderId);
  const [head] = await tx<BinderHeadRow[]>`
    select id, kind, cover_type, cover_storage_path
      from public.binders where id = ${binderId} and user_id = ${userId}`;
  if (head === undefined) throw notFound(binderId);
  return head;
};

const loadCustomHead = async (tx: Sql, userId: string, binderId: string): Promise<void> => {
  const head = await loadHead(tx, userId, binderId);
  if (head.kind !== "custom") throw NOT_A_CUSTOM(binderId);
};

const cardExists = async (tx: Sql, cardId: string): Promise<boolean> => {
  const rows = await tx<Array<{ ok: number }>>`
    select 1 as ok from public.catalog_cards where id = ${cardId}`;
  return rows.length > 0;
};

/**
 * Live {@link BinderService}. Chaque opération s'exécute dans `withUserRls` (RLS
 * `auth.uid() = user_id`) ET filtre explicitement par `user_id`. Une cover uploadée est
 * validée, recompressée en WebP sans EXIF puis envoyée au Storage **avant** la mise à jour
 * de la ligne ; l'ancien objet est supprimé en best-effort (loggé, jamais bloquant).
 */
export const BinderServiceLive: Layer.Layer<
  BinderService,
  never,
  Database | BinderCoverStorage | CoverImageProcessor
> = Layer.effect(
  BinderService,
  Effect.gen(function* () {
    const { sql } = yield* Database;
    const storage = yield* BinderCoverStorage;
    const processor = yield* CoverImageProcessor;

    const rls = <A>(userId: string, fn: (tx: Sql) => Promise<A>) =>
      withUserRls<A, BinderServiceError>(sql, userId, fn, { mapError: mapBinderError });

    const service: BinderServiceShape = {
      listBinders: (userId, filter = {}) => rls(userId, (tx) => loadSummaries(tx, userId, filter)),

      getBinder: (userId, binderId) =>
        isUuid(binderId)
          ? rls(userId, (tx) => summaryOrThrow(tx, userId, binderId))
          : Effect.fail(notFound(binderId)),

      createSetBinder: (userId, input) =>
        rls(userId, async (tx) => {
          const title = input.title === undefined ? null : normalizeBinderTitle(input.title);
          const inserted = await tx<Array<{ id: string }>>`
            insert into public.binders (user_id, kind, set_id, title)
            select ${userId}, 'set', s.id, left(coalesce(${title}::text, s.name_fr), 80)
              from public.catalog_sets s
             where s.id = ${input.setId}
            on conflict (user_id, set_id) do nothing
            returning id`;
          const created = inserted[0];
          if (created !== undefined) return summaryOrThrow(tx, userId, created.id);

          const [existing] = await tx<Array<{ id: string }>>`
            select id from public.binders where user_id = ${userId} and set_id = ${input.setId}`;
          if (existing === undefined) {
            throw new CatalogItemNotFoundError({
              entity: "set",
              id: input.setId,
              message: `set ${input.setId} not found in the catalog`,
            });
          }
          if (input.ifExists === "fail") {
            throw new BinderConflictError({
              message: `set ${input.setId} is already tracked`,
              setId: input.setId,
            });
          }
          return summaryOrThrow(tx, userId, existing.id);
        }),

      createCustomBinder: (userId, input) =>
        rls(userId, async (tx) => {
          const [created] = await tx<Array<{ id: string }>>`
            insert into public.binders (user_id, kind, title, is_pinned)
            values (${userId}, 'custom', ${normalizeBinderTitle(input.title)},
                    ${input.isPinned ?? false})
            returning id`;
          if (created === undefined) throw new DatabaseError({ message: "insert returned no row" });
          return summaryOrThrow(tx, userId, created.id);
        }),

      updateBinder: (userId, binderId, patch) =>
        rls(userId, async (tx) => {
          await loadHead(tx, userId, binderId);
          await tx`
            update public.binders
               set title = coalesce(${patch.title === undefined ? null : normalizeBinderTitle(patch.title)}::text, title),
                   is_pinned = coalesce(${patch.isPinned ?? null}::boolean, is_pinned),
                   sort_order = coalesce(${patch.sortOrder ?? null}::integer, sort_order)
             where id = ${binderId} and user_id = ${userId}`;
          return summaryOrThrow(tx, userId, binderId);
        }),

      setBinderCover: (userId, binderId, input, authToken) =>
        Effect.gen(function* () {
          const head = yield* rls(userId, (tx) => loadHead(tx, userId, binderId));
          const previousUpload = head.cover_type === "upload" && head.cover_storage_path !== null;

          if (input.type === "upload") {
            if (authToken === undefined || authToken.trim() === "") {
              return yield* Effect.fail(
                new UnauthorizedBinderAccess({
                  binderId,
                  message: "an access token is required to upload a cover",
                }),
              );
            }
            const webp = yield* processor.process(input.image);
            yield* storage.upload({ userId, binderId, accessToken: authToken, bytes: webp });
            const path = binderCoverStoragePath(userId, binderId);
            return yield* rls(userId, async (tx) => {
              await tx`
                update public.binders
                   set cover_type = 'upload', cover_card_id = null, cover_storage_path = ${path}
                 where id = ${binderId} and user_id = ${userId}`;
              return summaryOrThrow(tx, userId, binderId);
            }).pipe(
              // Échec DB après upload : l'objet est orphelin sauf si une cover uploadée existait.
              Effect.tapError(() =>
                previousUpload
                  ? Effect.void
                  : cleanupCoverObject(
                      storage,
                      { userId, binderId, authToken },
                      "db_update_failed",
                    ),
              ),
            );
          }

          const summary = yield* rls(userId, async (tx) => {
            if (input.type === "card") {
              if (!(await cardExists(tx, input.cardId))) {
                throw new CatalogItemNotFoundError({
                  entity: "card",
                  id: input.cardId,
                  message: `card ${input.cardId} not found in the catalog`,
                });
              }
              await tx`
                update public.binders
                   set cover_type = 'card', cover_card_id = ${input.cardId}, cover_storage_path = null
                 where id = ${binderId} and user_id = ${userId}`;
            } else {
              await tx`
                update public.binders
                   set cover_type = 'set_logo', cover_card_id = null, cover_storage_path = null
                 where id = ${binderId} and user_id = ${userId}`;
            }
            return summaryOrThrow(tx, userId, binderId);
          });
          if (previousUpload) {
            yield* cleanupCoverObject(storage, { userId, binderId, authToken }, "cover_replaced");
          }
          return summary;
        }),

      deleteBinder: (userId, binderId, authToken) =>
        Effect.gen(function* () {
          if (!isUuid(binderId)) return yield* Effect.fail(notFound(binderId));
          const removed = yield* rls(userId, async (tx) => {
            const [row] = await tx<Array<{ cover_storage_path: string | null }>>`
              delete from public.binders
               where id = ${binderId} and user_id = ${userId}
              returning cover_storage_path`;
            if (row === undefined) throw notFound(binderId);
            return row;
          });
          if (removed.cover_storage_path !== null) {
            yield* cleanupCoverObject(storage, { userId, binderId, authToken }, "binder_deleted");
          }
        }),

      listBinderCards: (userId, binderId) =>
        rls(userId, async (tx) => {
          await loadHead(tx, userId, binderId);
          const rows = await tx<BinderCardRow[]>`
            select bc.binder_id, bc.card_id, bc.position, bc.added_at
              from public.binder_cards bc
              join public.binders b on b.id = bc.binder_id
             where bc.binder_id = ${binderId} and b.user_id = ${userId}
             order by bc.position asc, bc.added_at asc, bc.card_id asc`;
          return rows.map(toBinderCard);
        }),

      addCardToCustomBinder: (userId, binderId, cardId, position) =>
        rls(userId, async (tx) => {
          if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
            throw new ValidationError({ message: "position must be an integer >= 0" });
          }
          await loadCustomHead(tx, userId, binderId);
          if (!(await cardExists(tx, cardId))) {
            throw new CatalogItemNotFoundError({
              entity: "card",
              id: cardId,
              message: `card ${cardId} not found in the catalog`,
            });
          }
          // Seule `position` est modifiable (GRANT UPDATE (position)) : un doublon la met à jour.
          const [row] = await tx<BinderCardRow[]>`
            insert into public.binder_cards (binder_id, card_id, position)
            select ${binderId}, ${cardId},
                   coalesce(${position ?? null}::integer,
                            (select coalesce(max(position) + 1, 0)
                               from public.binder_cards where binder_id = ${binderId}))
            on conflict (binder_id, card_id)
              do update set position = coalesce(${position ?? null}::integer, public.binder_cards.position)
            returning binder_id, card_id, position, added_at`;
          if (row === undefined) throw new DatabaseError({ message: "upsert returned no row" });
          return toBinderCard(row);
        }),

      reorderCustomBinderCards: (userId, binderId, orderedCardIds) =>
        rls(userId, async (tx) => {
          await loadCustomHead(tx, userId, binderId);
          const current = await tx<Array<{ card_id: string }>>`
            select card_id from public.binder_cards where binder_id = ${binderId} for update`;
          const wanted = new Set(orderedCardIds);
          if (
            wanted.size !== orderedCardIds.length ||
            wanted.size !== current.length ||
            current.some((row) => !wanted.has(row.card_id))
          ) {
            throw new ValidationError({
              message: "orderedCardIds must list each card of the binder exactly once",
            });
          }
          if (orderedCardIds.length > 0) {
            await tx`
              update public.binder_cards bc
                 set position = o.pos::integer - 1
                from unnest(${tx.array([...orderedCardIds])}::text[]) with ordinality as o(card_id, pos)
               where bc.binder_id = ${binderId} and bc.card_id = o.card_id`;
          }
          const rows = await tx<BinderCardRow[]>`
            select binder_id, card_id, position, added_at
              from public.binder_cards where binder_id = ${binderId}
             order by position asc, card_id asc`;
          return rows.map(toBinderCard);
        }),

      removeCardFromCustomBinder: (userId, binderId, cardId) =>
        rls(userId, async (tx) => {
          await loadCustomHead(tx, userId, binderId);
          await tx`
            delete from public.binder_cards where binder_id = ${binderId} and card_id = ${cardId}`;
        }),
    };
    return service;
  }),
);

// ---------------------------------------------------------------------------
// Memory implementation (tests)
// ---------------------------------------------------------------------------

/**
 * {@link BinderService} en mémoire, adossé à un {@link CollectionMemoryStore} partagé avec
 * `CollectionServiceMemory` (mêmes règles : isolation par utilisateur, cover, doublons).
 */
export const BinderServiceMemory: Layer.Layer<
  BinderService,
  never,
  CollectionMemoryStore | BinderCoverStorage | CoverImageProcessor
> = Layer.effect(
  BinderService,
  Effect.gen(function* () {
    const store = yield* CollectionMemoryStore;
    const storage = yield* BinderCoverStorage;
    const processor = yield* CoverImageProcessor;
    const { catalog, state } = store;

    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

    const own = (userId: string, binderId: string): Binder | undefined => {
      const binder = state.binders.get(binderId);
      return binder !== undefined && binder.userId === userId ? binder : undefined;
    };
    const requireBinder = (
      userId: string,
      binderId: string,
    ): Effect.Effect<Binder, BinderServiceError> => {
      const binder = isUuid(binderId) ? own(userId, binderId) : undefined;
      return binder === undefined ? Effect.fail(notFound(binderId)) : Effect.succeed(binder);
    };
    const requireUser = (userId: string): Effect.Effect<void, ValidationError> =>
      isUuid(userId)
        ? Effect.void
        : Effect.fail(new ValidationError({ message: "userId must be a valid UUID" }));

    const summarize = (binder: Binder, options: CompletionOptions = {}): BinderSummary => {
      if (binder.kind === "set" && binder.setId !== null) {
        const set = catalog.sets.find((entry) => entry.id === binder.setId);
        const info: BinderSetInfo = {
          id: binder.setId,
          nameFr: set?.nameFr ?? binder.title,
          code: set?.code ?? null,
          logoUrl: set?.logoUrl ?? null,
          seriesId: set?.seriesId ?? "",
          releaseDate: set?.releaseDate ?? null,
          officialCount: set?.officialCount ?? 0,
          totalCount: set?.totalCount ?? 0,
        };
        const cardsOfSet = new Map(
          catalog.cards
            .filter((card) => card.setId === binder.setId)
            .map((card) => [card.id, card]),
        );
        const copies: Array<CompletionCopy> = [];
        for (const copy of state.copies.values()) {
          const card = cardsOfSet.get(copy.cardId);
          if (copy.userId === binder.userId && card !== undefined) {
            copies.push({
              cardId: copy.cardId,
              variant: copy.variant,
              quantity: copy.quantity,
              localIdNumeric: card.localIdNumeric,
            });
          }
        }
        const completion = computeSetCompletion(
          { setId: info.id, officialCount: info.officialCount, totalCount: info.totalCount },
          copies,
          options,
        );
        return {
          binder,
          set: info,
          completion,
          cardCount: info.totalCount,
          ownedCount: completion.ownedDistinct,
        };
      }
      const entries = state.binderCards.filter((entry) => entry.binderId === binder.id);
      const ownedCards = new Set(
        [...state.copies.values()]
          .filter((copy) => copy.userId === binder.userId && copy.quantity > 0)
          .map((copy) => copy.cardId),
      );
      return {
        binder,
        set: null,
        completion: null,
        cardCount: entries.length,
        ownedCount: entries.filter((entry) => ownedCards.has(entry.cardId)).length,
      };
    };

    const summaryOf = (userId: string, binderId: string, options?: CompletionOptions) =>
      requireBinder(userId, binderId).pipe(Effect.map((binder) => summarize(binder, options)));

    const sortBinders = (a: Binder, b: Binder): number =>
      Number(b.isPinned) - Number(a.isPinned) ||
      a.sortOrder - b.sortOrder ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id);

    const patchBinder = (binder: Binder, patch: Partial<Binder>, updatedAt: string): Binder => {
      const next: Binder = { ...binder, ...patch, updatedAt };
      state.binders.set(next.id, next);
      return next;
    };

    const cardExistsInCatalog = (cardId: string): boolean =>
      catalog.cards.some((card) => card.id === cardId);

    const requireCustom = (userId: string, binderId: string) =>
      requireBinder(userId, binderId).pipe(
        Effect.flatMap((binder) =>
          binder.kind === "custom" ? Effect.succeed(binder) : Effect.fail(NOT_A_CUSTOM(binderId)),
        ),
      );

    const cardNotFound = (cardId: string) =>
      new CatalogItemNotFoundError({
        entity: "card",
        id: cardId,
        message: `card ${cardId} not found in the catalog`,
      });

    const service: BinderServiceShape = {
      listBinders: (userId, filter = {}) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          const setsOfSeries = new Set(
            catalog.sets.filter((set) => set.seriesId === filter.seriesId).map((set) => set.id),
          );
          return [...state.binders.values()]
            .filter((binder) => binder.userId === userId)
            .filter((binder) => filter.kind === undefined || binder.kind === filter.kind)
            .filter(
              (binder) =>
                filter.seriesId === undefined ||
                (binder.setId !== null && setsOfSeries.has(binder.setId)),
            )
            .sort(sortBinders)
            .map((binder) => summarize(binder, filter));
        }),

      getBinder: (userId, binderId) =>
        requireUser(userId).pipe(Effect.flatMap(() => summaryOf(userId, binderId))),

      createSetBinder: (userId, input) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          const set = catalog.sets.find((entry) => entry.id === input.setId);
          if (set === undefined) {
            return yield* Effect.fail(
              new CatalogItemNotFoundError({
                entity: "set",
                id: input.setId,
                message: `set ${input.setId} not found in the catalog`,
              }),
            );
          }
          const existing = [...state.binders.values()].find(
            (binder) => binder.userId === userId && binder.setId === input.setId,
          );
          if (existing !== undefined) {
            if (input.ifExists === "fail") {
              return yield* Effect.fail(
                new BinderConflictError({
                  message: `set ${input.setId} is already tracked`,
                  setId: input.setId,
                }),
              );
            }
            return summarize(existing);
          }
          const now = yield* nowIso;
          const binder: Binder = {
            id: crypto.randomUUID(),
            userId,
            kind: "set",
            setId: set.id,
            title: (input.title === undefined
              ? set.nameFr
              : normalizeBinderTitle(input.title)
            ).slice(0, 80),
            coverType: "set_logo",
            coverCardId: null,
            coverStoragePath: null,
            isPinned: false,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          };
          state.binders.set(binder.id, binder);
          return summarize(binder);
        }),

      createCustomBinder: (userId, input) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          const now = yield* nowIso;
          const binder: Binder = {
            id: crypto.randomUUID(),
            userId,
            kind: "custom",
            setId: null,
            title: normalizeBinderTitle(input.title),
            coverType: "set_logo",
            coverCardId: null,
            coverStoragePath: null,
            isPinned: input.isPinned ?? false,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          };
          state.binders.set(binder.id, binder);
          return summarize(binder);
        }),

      updateBinder: (userId, binderId, patch) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          const binder = yield* requireBinder(userId, binderId);
          const now = yield* nowIso;
          return summarize(
            patchBinder(
              binder,
              {
                ...(patch.title === undefined ? {} : { title: normalizeBinderTitle(patch.title) }),
                ...(patch.isPinned === undefined ? {} : { isPinned: patch.isPinned }),
                ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
              },
              now,
            ),
          );
        }),

      setBinderCover: (userId, binderId, input, authToken) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          const binder = yield* requireBinder(userId, binderId);
          const previousUpload = binder.coverType === "upload" && binder.coverStoragePath !== null;
          const now = yield* nowIso;

          if (input.type === "upload") {
            if (authToken === undefined || authToken.trim() === "") {
              return yield* Effect.fail(
                new UnauthorizedBinderAccess({
                  binderId,
                  message: "an access token is required to upload a cover",
                }),
              );
            }
            const webp = yield* processor.process(input.image);
            yield* storage.upload({ userId, binderId, accessToken: authToken, bytes: webp });
            return summarize(
              patchBinder(
                binder,
                {
                  coverType: "upload",
                  coverCardId: null,
                  coverStoragePath: binderCoverStoragePath(userId, binderId),
                },
                now,
              ),
            );
          }

          if (input.type === "card") {
            if (!cardExistsInCatalog(input.cardId)) {
              return yield* Effect.fail(cardNotFound(input.cardId));
            }
            const next = patchBinder(
              binder,
              { coverType: "card", coverCardId: input.cardId, coverStoragePath: null },
              now,
            );
            if (previousUpload) {
              yield* cleanupCoverObject(storage, { userId, binderId, authToken }, "cover_replaced");
            }
            return summarize(next);
          }

          const next = patchBinder(
            binder,
            { coverType: "set_logo", coverCardId: null, coverStoragePath: null },
            now,
          );
          if (previousUpload) {
            yield* cleanupCoverObject(storage, { userId, binderId, authToken }, "cover_replaced");
          }
          return summarize(next);
        }),

      deleteBinder: (userId, binderId, authToken) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          const binder = yield* requireBinder(userId, binderId);
          state.binders.delete(binder.id);
          state.binderCards = state.binderCards.filter((entry) => entry.binderId !== binder.id);
          if (binder.coverStoragePath !== null) {
            yield* cleanupCoverObject(storage, { userId, binderId, authToken }, "binder_deleted");
          }
        }),

      listBinderCards: (userId, binderId) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          yield* requireBinder(userId, binderId);
          return state.binderCards
            .filter((entry) => entry.binderId === binderId)
            .sort(
              (a, b) =>
                a.position - b.position ||
                a.addedAt.localeCompare(b.addedAt) ||
                a.cardId.localeCompare(b.cardId),
            );
        }),

      addCardToCustomBinder: (userId, binderId, cardId, position) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
            return yield* Effect.fail(
              new ValidationError({ message: "position must be an integer >= 0" }),
            );
          }
          yield* requireCustom(userId, binderId);
          if (!cardExistsInCatalog(cardId)) return yield* Effect.fail(cardNotFound(cardId));
          const now = yield* nowIso;
          const inBinder = state.binderCards.filter((entry) => entry.binderId === binderId);
          const index = state.binderCards.findIndex(
            (entry) => entry.binderId === binderId && entry.cardId === cardId,
          );
          const current = index === -1 ? undefined : state.binderCards[index];
          if (current !== undefined) {
            const updated: BinderCardEntry = {
              ...current,
              position: position ?? current.position,
            };
            state.binderCards[index] = updated;
            return updated;
          }
          const entry: BinderCardEntry = {
            binderId,
            cardId,
            position:
              position ?? inBinder.reduce((max, item) => Math.max(max, item.position + 1), 0),
            addedAt: now,
          };
          state.binderCards.push(entry);
          return entry;
        }),

      reorderCustomBinderCards: (userId, binderId, orderedCardIds) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          yield* requireCustom(userId, binderId);
          const current = state.binderCards.filter((entry) => entry.binderId === binderId);
          const wanted = new Set(orderedCardIds);
          if (
            wanted.size !== orderedCardIds.length ||
            wanted.size !== current.length ||
            current.some((entry) => !wanted.has(entry.cardId))
          ) {
            return yield* Effect.fail(
              new ValidationError({
                message: "orderedCardIds must list each card of the binder exactly once",
              }),
            );
          }
          const positions = new Map(orderedCardIds.map((id, index) => [id, index]));
          state.binderCards = state.binderCards.map((entry) =>
            entry.binderId === binderId
              ? { ...entry, position: positions.get(entry.cardId) ?? entry.position }
              : entry,
          );
          return state.binderCards
            .filter((entry) => entry.binderId === binderId)
            .sort((a, b) => a.position - b.position);
        }),

      removeCardFromCustomBinder: (userId, binderId, cardId) =>
        Effect.gen(function* () {
          yield* requireUser(userId);
          yield* requireCustom(userId, binderId);
          state.binderCards = state.binderCards.filter(
            (entry) => !(entry.binderId === binderId && entry.cardId === cardId),
          );
        }),
    };
    return service;
  }),
);
