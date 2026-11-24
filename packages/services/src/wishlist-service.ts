import {
  type AddWishlistItemInput,
  type Binder,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  CatalogItemNotFoundError,
  copySlotKey,
  decodeAddWishlistItemInput,
  decodeMarkWishlistAcquiredInput,
  decodeUpdateWishlistItemInput,
  type GradingCompany,
  isUuid,
  type ListWishlistItemsFilter,
  MAX_CARD_COPY_QUANTITY,
  type MarkWishlistAcquiredInput,
  type MarkWishlistAcquiredResult,
  type UpdateWishlistItemInput,
  type UserCardCopy,
  ValidationError,
  type WishlistItem,
  WishlistItemConflictError,
  WishlistItemNotFoundError,
  type WishlistPriority,
  type WishlistQuantityOverflowError,
  wishlistQuantityOverflow,
  wishlistSlotKey,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { CollectionMemoryStore } from "./collection-memory.ts";
import { Database, type DatabaseError, type Sql } from "./db.ts";
import { pgErrorCode, withUserRls } from "./rls.ts";

// ---------------------------------------------------------------------------
// Errors & service contract
// ---------------------------------------------------------------------------

/** Union des erreurs typées des opérations de {@link WishlistService}. */
export type WishlistServiceError =
  | DatabaseError
  | ValidationError
  | WishlistItemNotFoundError
  | WishlistItemConflictError
  | WishlistQuantityOverflowError
  | CatalogItemNotFoundError;

/**
 * Wishlist (`wishlist_items`) d'un utilisateur, unique par slot `(carte, langue, variante)`.
 * Toujours scopée par `userId` ; un souhait d'un autre utilisateur est
 * `WishlistItemNotFoundError`.
 */
export interface WishlistServiceShape {
  /**
   * Souhaits de l'utilisateur : prioritaires (`high`) d'abord, puis du plus récent au plus
   * ancien. Filtrable par `priority`, `cardId` et `setId` (extension de la carte).
   */
  readonly listWishlistItems: (
    userId: string,
    filter?: ListWishlistItemsFilter,
  ) => Effect.Effect<ReadonlyArray<WishlistItem>, WishlistServiceError>;
  /**
   * Ajoute un souhait. Carte absente du catalogue → `CatalogItemNotFoundError`. Slot déjà
   * souhaité → `WishlistItemConflictError`, sauf `ifExists: "return"` (renvoie l'existant,
   * sans le modifier).
   */
  readonly addWishlistItem: (
    userId: string,
    input: AddWishlistItemInput,
  ) => Effect.Effect<WishlistItem, WishlistServiceError>;
  /** Met à jour langue, variante, état minimum, priorité, prix cible (au moins un champ). */
  readonly updateWishlistItem: (
    userId: string,
    itemId: string,
    patch: UpdateWishlistItemInput,
  ) => Effect.Effect<WishlistItem, WishlistServiceError>;
  readonly removeWishlistItem: (
    userId: string,
    itemId: string,
  ) => Effect.Effect<void, WishlistServiceError>;
  /**
   * Bascule 1-tap « ✓ Acquise », **atomique** (une seule transaction) : ajoute (ou incrémente)
   * l'exemplaire non gradé du slot `(carte, langue, variante, état)`, suit l'extension de la
   * carte (classeur `kind = 'set'`, idempotent) puis retire le souhait. Dépasser 999
   * exemplaires → `WishlistQuantityOverflowError` et **rien** n'est modifié (souhait intact).
   */
  readonly markAcquired: (
    userId: string,
    input: MarkWishlistAcquiredInput,
  ) => Effect.Effect<MarkWishlistAcquiredResult, WishlistServiceError>;
}

/** Effect-TS service key of the wishlist service. */
export class WishlistService extends Context.Service<WishlistService, WishlistServiceShape>()(
  "@pokevault/services/WishlistService",
) {}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "ValidationError",
  "WishlistItemNotFoundError",
  "WishlistItemConflictError",
  "WishlistQuantityOverflowError",
  "CatalogItemNotFoundError",
]);

/** Convertit une erreur de transaction en erreur typée (`undefined` ⇒ `DatabaseError`). */
export const mapWishlistError = (cause: unknown): WishlistServiceError | undefined => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    DOMAIN_TAGS.has(cause._tag)
  ) {
    return cause as WishlistServiceError;
  }
  switch (pgErrorCode(cause)) {
    case "23505":
      return new WishlistItemConflictError({
        message: "this card is already in the wishlist for the same language and variant",
        cause,
      });
    case "23514":
    case "22P02":
    case "22003":
      return new ValidationError({ message: "invalid wishlist data", cause });
    default:
      return undefined;
  }
};

const itemNotFound = (itemId: string): WishlistItemNotFoundError =>
  new WishlistItemNotFoundError({ itemId, message: `wishlist item ${itemId} not found` });

const cardNotFound = (cardId: string): CatalogItemNotFoundError =>
  new CatalogItemNotFoundError({
    entity: "card",
    id: cardId,
    message: `card ${cardId} not found in the catalog`,
  });

const slotConflict = (cardId: string, cause?: unknown): WishlistItemConflictError =>
  new WishlistItemConflictError({
    message: `card ${cardId} is already in the wishlist for this language and variant`,
    cardId,
    cause,
  });

const DEFAULT_LANGUAGE: CardLanguage = "FR";
const DEFAULT_VARIANT: CardVariant = "normal";
const DEFAULT_CONDITION: CardCondition = "NM";
const DEFAULT_PRIORITY: WishlistPriority = "normal";
const SET_BINDER_TITLE_MAX_LENGTH = 80;

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface WishlistRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly min_condition: CardCondition;
  readonly priority: WishlistPriority;
  readonly target_price_cents: number | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

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

const toItem = (row: WishlistRow): WishlistItem => ({
  id: row.id,
  userId: row.user_id,
  cardId: row.card_id,
  language: row.language,
  variant: row.variant,
  minCondition: row.min_condition,
  priority: row.priority,
  targetPriceCents: row.target_price_cents,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

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

/**
 * Live {@link WishlistService} : RLS transactionnelle (`withUserRls`) + filtre explicite par
 * `user_id` (défense en profondeur). Chaque opération est une transaction : une erreur levée
 * (typée ou SQL) provoque un `ROLLBACK` complet.
 */
export const WishlistServiceLive: Layer.Layer<WishlistService, never, Database> = Layer.effect(
  WishlistService,
  Effect.gen(function* () {
    const { sql } = yield* Database;
    const rls = <A>(userId: string, fn: (tx: Sql) => Promise<A>) =>
      withUserRls<A, WishlistServiceError>(sql, userId, fn, { mapError: mapWishlistError });

    const service: WishlistServiceShape = {
      listWishlistItems: (userId, filter = {}) =>
        rls(userId, async (tx) => {
          const rows = await tx<WishlistRow[]>`
            select w.id, w.user_id, w.card_id, w.language, w.variant, w.min_condition,
                   w.priority, w.target_price_cents, w.created_at, w.updated_at
              from public.wishlist_items w
              join public.catalog_cards k on k.id = w.card_id
             where w.user_id = ${userId}
               and (${filter.priority ?? null}::text is null or w.priority = ${filter.priority ?? null}::text)
               and (${filter.cardId ?? null}::text is null or w.card_id = ${filter.cardId ?? null}::text)
               and (${filter.setId ?? null}::text is null or k.set_id = ${filter.setId ?? null}::text)
             order by (w.priority = 'high') desc, w.created_at desc, w.id desc`;
          return rows.map(toItem);
        }),

      addWishlistItem: (userId, input) =>
        decodeAddWishlistItemInput(input).pipe(
          Effect.flatMap((validated) =>
            rls(userId, async (tx) => {
              const language = validated.language ?? DEFAULT_LANGUAGE;
              const variant = validated.variant ?? DEFAULT_VARIANT;
              const inserted = await tx<WishlistRow[]>`
                insert into public.wishlist_items
                  (user_id, card_id, language, variant, min_condition, priority, target_price_cents)
                select ${userId}::uuid, k.id, ${language}::text, ${variant}::text,
                       ${validated.minCondition ?? DEFAULT_CONDITION}::text,
                       ${validated.priority ?? DEFAULT_PRIORITY}::text,
                       ${validated.targetPriceCents ?? null}::integer
                  from public.catalog_cards k
                 where k.id = ${validated.cardId}
                on conflict (user_id, card_id, language, variant) do nothing
                returning id, user_id, card_id, language, variant, min_condition, priority,
                          target_price_cents, created_at, updated_at`;
              const created = inserted[0];
              if (created !== undefined) return toItem(created);

              // Aucune ligne insérée : carte inconnue, ou slot déjà souhaité.
              const [existing] = await tx<WishlistRow[]>`
                select id, user_id, card_id, language, variant, min_condition, priority,
                       target_price_cents, created_at, updated_at
                  from public.wishlist_items
                 where user_id = ${userId} and card_id = ${validated.cardId}
                   and language = ${language} and variant = ${variant}`;
              if (existing === undefined) throw cardNotFound(validated.cardId);
              if (validated.ifExists === "return") return toItem(existing);
              throw slotConflict(validated.cardId);
            }),
          ),
        ),

      updateWishlistItem: (userId, itemId, patch) =>
        decodeUpdateWishlistItemInput(patch).pipe(
          Effect.flatMap((validated) =>
            rls(userId, async (tx) => {
              if (!isUuid(itemId)) throw itemNotFound(itemId);
              const entries: Array<[string, string | number | null]> = [];
              if (validated.language !== undefined) entries.push(["language", validated.language]);
              if (validated.variant !== undefined) entries.push(["variant", validated.variant]);
              if (validated.minCondition !== undefined) {
                entries.push(["min_condition", validated.minCondition]);
              }
              if (validated.priority !== undefined) entries.push(["priority", validated.priority]);
              if (validated.targetPriceCents !== undefined) {
                entries.push(["target_price_cents", validated.targetPriceCents]);
              }
              const columns = Object.fromEntries(entries);
              const rows = await tx<WishlistRow[]>`
                update public.wishlist_items set ${tx(columns)}
                 where id = ${itemId} and user_id = ${userId}
                returning id, user_id, card_id, language, variant, min_condition, priority,
                          target_price_cents, created_at, updated_at`;
              const row = rows[0];
              if (row === undefined) throw itemNotFound(itemId);
              return toItem(row);
            }),
          ),
        ),

      removeWishlistItem: (userId, itemId) =>
        rls(userId, async (tx) => {
          if (!isUuid(itemId)) throw itemNotFound(itemId);
          const rows = await tx<Array<{ id: string }>>`
            delete from public.wishlist_items
             where id = ${itemId} and user_id = ${userId} returning id`;
          if (rows.length === 0) throw itemNotFound(itemId);
        }),

      markAcquired: (userId, input) =>
        decodeMarkWishlistAcquiredInput(input).pipe(
          Effect.flatMap((validated) =>
            // UNE transaction : tout échec ci-dessous annule l'ajout, le classeur ET la suppression.
            rls(userId, async (tx): Promise<MarkWishlistAcquiredResult> => {
              // 1. Verrouille le souhait (deux « Acquise » concurrents sont sérialisés : le
              //    second ne trouve plus la ligne et reçoit WishlistItemNotFoundError).
              const [item] = await tx<WishlistRow[]>`
                select id, user_id, card_id, language, variant, min_condition, priority,
                       target_price_cents, created_at, updated_at
                  from public.wishlist_items
                 where id = ${validated.wishlistItemId} and user_id = ${userId}
                   for update`;
              if (item === undefined) throw itemNotFound(validated.wishlistItemId);

              const condition = validated.condition ?? item.min_condition;
              const quantity = validated.quantity ?? 1;

              // 2. Slot non gradé : crée ou incrémente, plafond 999 vérifié atomiquement en SQL.
              const copies = await tx<CopyRow[]>`
                insert into public.user_card_copies
                  (user_id, card_id, language, variant, condition, quantity, purchase_price_cents, notes)
                values
                  (${userId}, ${item.card_id}, ${item.language}, ${item.variant}, ${condition},
                   ${quantity}, ${validated.purchasePriceCents ?? null}, ${validated.notes ?? null})
                on conflict (user_id, card_id, language, variant, condition,
                             (coalesce(grading_company, '')), (coalesce(grading_score, '')))
                do update set
                  quantity = public.user_card_copies.quantity + excluded.quantity,
                  purchase_price_cents = coalesce(excluded.purchase_price_cents, public.user_card_copies.purchase_price_cents),
                  notes = coalesce(excluded.notes, public.user_card_copies.notes)
                where public.user_card_copies.quantity + excluded.quantity <= ${MAX_CARD_COPY_QUANTITY}
                returning id, user_id, card_id, language, variant, condition, quantity,
                          purchase_price_cents, grading_company, grading_score, notes,
                          acquired_at::text as acquired_at, created_at, updated_at`;
              const copy = copies[0];
              if (copy === undefined) {
                const [current] = await tx<Array<{ quantity: number }>>`
                  select quantity
                    from public.user_card_copies
                   where user_id = ${userId} and card_id = ${item.card_id}
                     and language = ${item.language} and variant = ${item.variant}
                     and condition = ${condition}
                     and coalesce(grading_company, '') = '' and coalesce(grading_score, '') = ''`;
                throw wishlistQuantityOverflow({
                  cardId: item.card_id,
                  currentQuantity: current?.quantity ?? 0,
                  requestedDelta: quantity,
                });
              }

              // 3. Classeur d'extension de la carte (idempotent) : la carte apparaît dans la collection.
              const [card] = await tx<Array<{ set_id: string }>>`
                select set_id from public.catalog_cards where id = ${item.card_id}`;
              let setBinderId: string | null = null;
              if (card !== undefined) {
                const created = await tx<Array<{ id: string }>>`
                  insert into public.binders (user_id, kind, set_id, title)
                  select ${userId}::uuid, 'set', s.id, left(s.name_fr, ${SET_BINDER_TITLE_MAX_LENGTH})
                    from public.catalog_sets s
                   where s.id = ${card.set_id}
                  on conflict (user_id, set_id) do nothing
                  returning id`;
                const binder =
                  created[0] ??
                  (
                    await tx<Array<{ id: string }>>`
                      select id from public.binders
                       where user_id = ${userId} and kind = 'set' and set_id = ${card.set_id}`
                  )[0];
                setBinderId = binder?.id ?? null;
              }

              // 4. Retire le souhait (même transaction).
              await tx`
                delete from public.wishlist_items
                 where id = ${item.id} and user_id = ${userId}`;

              return {
                removedWishlistItemId: item.id,
                copy: toCopy(copy),
                setBinderId,
              };
            }),
          ),
        ),
    };
    return service;
  }),
);

// ---------------------------------------------------------------------------
// Memory implementation (unit tests, 100 % offline, atomic too)
// ---------------------------------------------------------------------------

/**
 * {@link WishlistService} en mémoire, adossé au {@link CollectionMemoryStore} partagé
 * (catalogue, exemplaires, classeurs). Mêmes règles que le Live : validation Effect Schema,
 * unicité du slot, plafond 999 et atomicité de `markAcquired` (toute vérification est faite
 * AVANT la première mutation, comme un `ROLLBACK`).
 */
export const WishlistServiceMemory: Layer.Layer<WishlistService, never, CollectionMemoryStore> =
  Layer.effect(
    WishlistService,
    Effect.gen(function* () {
      const { catalog, state } = yield* CollectionMemoryStore;
      const items = new Map<string, WishlistItem>();
      /** Ordre d'insertion : départage deux souhaits créés dans la même milliseconde. */
      const sequence = new Map<string, number>();
      let nextSequence = 0;
      const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

      const requireUser = (userId: string): Effect.Effect<string, ValidationError> =>
        isUuid(userId)
          ? Effect.succeed(userId.toLowerCase())
          : Effect.fail(new ValidationError({ message: "userId must be a valid UUID" }));

      const ownItem = (
        uid: string,
        itemId: string,
      ): Effect.Effect<WishlistItem, WishlistItemNotFoundError> => {
        const item = items.get(itemId.toLowerCase());
        return item !== undefined && item.userId.toLowerCase() === uid
          ? Effect.succeed(item)
          : Effect.fail(itemNotFound(itemId));
      };

      const findSlot = (
        uid: string,
        slot: Parameters<typeof wishlistSlotKey>[0],
      ): WishlistItem | undefined => {
        const key = wishlistSlotKey(slot);
        return [...items.values()].find(
          (item) => item.userId.toLowerCase() === uid && wishlistSlotKey(item) === key,
        );
      };

      const remember = (item: WishlistItem): void => {
        items.set(item.id, item);
      };

      const service: WishlistServiceShape = {
        listWishlistItems: (userId, filter = {}) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const cardsOfSet =
              filter.setId === undefined
                ? undefined
                : new Set(
                    catalog.cards.filter((card) => card.setId === filter.setId).map((c) => c.id),
                  );
            return [...items.values()]
              .filter((item) => item.userId.toLowerCase() === uid)
              .filter((item) => filter.priority === undefined || item.priority === filter.priority)
              .filter((item) => filter.cardId === undefined || item.cardId === filter.cardId)
              .filter((item) => cardsOfSet === undefined || cardsOfSet.has(item.cardId))
              .sort(
                (a, b) =>
                  Number(b.priority === "high") - Number(a.priority === "high") ||
                  b.createdAt.localeCompare(a.createdAt) ||
                  (sequence.get(b.id) ?? 0) - (sequence.get(a.id) ?? 0),
              );
          }),

        addWishlistItem: (userId, input) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const validated = yield* decodeAddWishlistItemInput(input);
            if (!catalog.cards.some((card) => card.id === validated.cardId)) {
              return yield* Effect.fail(cardNotFound(validated.cardId));
            }
            const slot = {
              cardId: validated.cardId,
              language: validated.language ?? DEFAULT_LANGUAGE,
              variant: validated.variant ?? DEFAULT_VARIANT,
            };
            const existing = findSlot(uid, slot);
            if (existing !== undefined) {
              return validated.ifExists === "return"
                ? existing
                : yield* Effect.fail(slotConflict(validated.cardId));
            }
            const now = yield* nowIso;
            const created: WishlistItem = {
              id: crypto.randomUUID(),
              userId: uid,
              ...slot,
              minCondition: validated.minCondition ?? DEFAULT_CONDITION,
              priority: validated.priority ?? DEFAULT_PRIORITY,
              targetPriceCents: validated.targetPriceCents ?? null,
              createdAt: now,
              updatedAt: now,
            };
            sequence.set(created.id, nextSequence++);
            remember(created);
            return created;
          }),

        updateWishlistItem: (userId, itemId, patch) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const validated = yield* decodeUpdateWishlistItemInput(patch);
            const item = yield* ownItem(uid, itemId);
            const next: WishlistItem = {
              ...item,
              language: validated.language ?? item.language,
              variant: validated.variant ?? item.variant,
              minCondition: validated.minCondition ?? item.minCondition,
              priority: validated.priority ?? item.priority,
              targetPriceCents:
                validated.targetPriceCents === undefined
                  ? item.targetPriceCents
                  : validated.targetPriceCents,
              updatedAt: yield* nowIso,
            };
            const clash = findSlot(uid, next);
            if (clash !== undefined && clash.id !== item.id) {
              return yield* Effect.fail(slotConflict(item.cardId));
            }
            remember(next);
            return next;
          }),

        removeWishlistItem: (userId, itemId) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const item = yield* ownItem(uid, itemId);
            items.delete(item.id);
            sequence.delete(item.id);
          }),

        markAcquired: (userId, input) =>
          Effect.gen(function* () {
            const uid = yield* requireUser(userId);
            const validated = yield* decodeMarkWishlistAcquiredInput(input);
            const item = yield* ownItem(uid, validated.wishlistItemId);
            const condition = validated.condition ?? item.minCondition;
            const quantity = validated.quantity ?? 1;
            const now = yield* nowIso;

            // Toutes les vérifications AVANT la moindre mutation (équivalent du ROLLBACK SQL).
            const slotKey = copySlotKey({
              cardId: item.cardId,
              language: item.language,
              variant: item.variant,
              condition,
            });
            const existing = [...state.copies.values()].find(
              (copy) => copy.userId.toLowerCase() === uid && copySlotKey(copy) === slotKey,
            );
            if (existing !== undefined && existing.quantity + quantity > MAX_CARD_COPY_QUANTITY) {
              return yield* Effect.fail(
                wishlistQuantityOverflow({
                  cardId: item.cardId,
                  currentQuantity: existing.quantity,
                  requestedDelta: quantity,
                }),
              );
            }
            const card = catalog.cards.find((entry) => entry.id === item.cardId);
            const set =
              card === undefined
                ? undefined
                : catalog.sets.find((entry) => entry.id === card.setId);

            // Mutations (synchrones : aucune interruption possible entre elles).
            const copy: UserCardCopy =
              existing === undefined
                ? {
                    id: crypto.randomUUID(),
                    userId: uid,
                    cardId: item.cardId,
                    language: item.language,
                    variant: item.variant,
                    condition,
                    quantity,
                    purchasePriceCents: validated.purchasePriceCents ?? null,
                    gradingCompany: null,
                    gradingScore: null,
                    notes: validated.notes ?? null,
                    acquiredAt: now.slice(0, 10),
                    createdAt: now,
                    updatedAt: now,
                  }
                : {
                    ...existing,
                    quantity: existing.quantity + quantity,
                    purchasePriceCents: validated.purchasePriceCents ?? existing.purchasePriceCents,
                    notes: validated.notes ?? existing.notes,
                    updatedAt: now,
                  };
            state.copies.set(copy.id, copy);

            let setBinderId: string | null = null;
            if (set !== undefined) {
              const binder: Binder | undefined = [...state.binders.values()].find(
                (entry) => entry.userId.toLowerCase() === uid && entry.setId === set.id,
              );
              if (binder !== undefined) {
                setBinderId = binder.id;
              } else {
                const created: Binder = {
                  id: crypto.randomUUID(),
                  userId: uid,
                  kind: "set",
                  setId: set.id,
                  title: set.nameFr.slice(0, SET_BINDER_TITLE_MAX_LENGTH),
                  coverType: "set_logo",
                  coverCardId: null,
                  coverStoragePath: null,
                  isPinned: false,
                  sortOrder: 0,
                  createdAt: now,
                  updatedAt: now,
                };
                state.binders.set(created.id, created);
                setBinderId = created.id;
              }
            }

            items.delete(item.id);
            sequence.delete(item.id);
            return { removedWishlistItemId: item.id, copy, setBinderId };
          }),
      };
      return service;
    }),
  );
