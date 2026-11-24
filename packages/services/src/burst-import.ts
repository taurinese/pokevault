import {
  type BurstCardMeta,
  type BurstImportBatchInput,
  BurstImportCardNotFoundError,
  BurstImportEmptyBatchError,
  BurstImportQuantityOverflowError,
  type BurstImportReport,
  buildBurstImportReport,
  burstSlotKey,
  type CardCondition,
  type CardId,
  type CardLanguage,
  type CardVariant,
  consolidateBurstItems,
  decodeBurstImportBatchInput,
  type HoloEffect,
  MAX_CARD_COPY_QUANTITY,
  type ResolvedBurstItem,
  resolveBurstItem,
  ValidationError,
} from "@pokevault/domain";
import { Context, Effect, Layer, Schema } from "effect";
import type postgres from "postgres";
import { Database, DatabaseError } from "./db.ts";

/** `Sql` pool or the transaction-scoped `TransactionSql` of `sql.begin` (both are `ISql`). */
type QuerySql = postgres.ISql<Record<string, never>>;

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/** All typed failures of the burst-import service. */
export type BurstImportError =
  | ValidationError
  | BurstImportCardNotFoundError
  | BurstImportQuantityOverflowError
  | BurstImportEmptyBatchError
  | DatabaseError;

/**
 * Port of the transactional burst import (docs/01 §6 `08A–08D`, ADR-006).
 *
 * - `previewBatch` resolves cards / variants and new-vs-duplicate status
 *   against the current collection, without writing anything.
 * - `commitBatch` applies the whole batch in ONE atomic SQL transaction
 *   (`sql.begin`): unknown card or quantity overflow → full rollback, zero
 *   partial writes, wishlist untouched.
 */
export interface BurstImportServiceShape {
  readonly previewBatch: (
    userId: string,
    input: unknown,
  ) => Effect.Effect<BurstImportReport, BurstImportError>;
  readonly commitBatch: (
    userId: string,
    input: unknown,
  ) => Effect.Effect<BurstImportReport, BurstImportError>;
}

/** Effect-TS service key of the burst import service. */
export class BurstImportService extends Context.Service<
  BurstImportService,
  BurstImportServiceShape
>()("@pokevault/services/BurstImportService") {}

/** `auth.users.id` / `profiles.id` (standard UUID shape, case-insensitive). */
export const UserId = Schema.NonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
export type UserId = typeof UserId.Type;

const decodeUserId = (userId: string): Effect.Effect<UserId, ValidationError> =>
  Schema.decodeUnknownEffect(UserId)(userId).pipe(
    Effect.map((id) => id.toLowerCase() as UserId),
    Effect.mapError(
      (error) => new ValidationError({ message: `invalid userId: ${error.message}`, cause: error }),
    ),
  );

/**
 * Exact wishlist slot key aligned with `wishlist_items` (`UNIQUE (user_id, card_id, language, variant)`).
 * Matching on `(cardId, language, resolvedVariant)` guarantees importing FR `normal` never deletes
 * an EN, JP or `masterball` wish for the same card.
 */
const wishlistSlotKey = (cardId: string, language: CardLanguage, variant: CardVariant): string =>
  `${cardId} ${language} ${variant}`;

const uniqueWishlistTargets = (
  lines: ReadonlyArray<Pick<ResolvedBurstItem, "cardId" | "language" | "variant">>,
): {
  readonly cardIds: Array<string>;
  readonly languages: Array<CardLanguage>;
  readonly variants: Array<CardVariant>;
} => {
  const seen = new Set<string>();
  const cardIds: Array<string> = [];
  const languages: Array<CardLanguage> = [];
  const variants: Array<CardVariant> = [];
  for (const line of lines) {
    const key = wishlistSlotKey(line.cardId, line.language, line.variant);
    if (seen.has(key)) continue;
    seen.add(key);
    cardIds.push(line.cardId);
    languages.push(line.language);
    variants.push(line.variant);
  }
  return { cardIds, languages, variants };
};

// ---------------------------------------------------------------------------
// Shared pure planning (used by both the Postgres and the in-memory layers)
// ---------------------------------------------------------------------------

/** One existing `user_card_copies` row, as seen by the planning step. */
export interface ExistingCardCopy {
  readonly cardId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  /** `true` when `grading_company` / `grading_score` are set (never touched by a burst import). */
  readonly graded: boolean;
  readonly quantity: number;
}

interface PlannedLine extends ResolvedBurstItem {
  readonly previousQuantity: number;
  readonly wasNewCard: boolean;
}

interface BurstPlan {
  readonly lines: ReadonlyArray<PlannedLine>;
}

type PlanError =
  | BurstImportCardNotFoundError
  | BurstImportEmptyBatchError
  | BurstImportQuantityOverflowError;

/**
 * Pure planning of a batch: validates that every `cardId` exists in the
 * catalogue (and belongs to `defaults.setId` when set), resolves variants,
 * consolidates duplicated lines and checks the quantity ceiling against the
 * quantities the user already owns. Fails BEFORE any write.
 */
export const planBurstBatch = (input: {
  readonly batch: BurstImportBatchInput;
  readonly cardsById: ReadonlyMap<string, BurstCardMeta>;
  readonly existingCopies: ReadonlyArray<ExistingCardCopy>;
}): Effect.Effect<BurstPlan, PlanError> =>
  Effect.gen(function* () {
    const { batch, cardsById, existingCopies } = input;
    const cardIds = [...new Set(batch.items.map((item) => item.cardId))];

    const missingCardIds: Array<string> = [];
    for (const cardId of cardIds) {
      const card = cardsById.get(cardId);
      if (
        card === undefined ||
        (batch.defaults.setId !== undefined && card.setId !== batch.defaults.setId)
      ) {
        missingCardIds.push(cardId);
      }
    }
    if (missingCardIds.length > 0) {
      return yield* new BurstImportCardNotFoundError({ missingCardIds });
    }

    const resolved: Array<ResolvedBurstItem> = [];
    for (const item of batch.items) {
      const card = cardsById.get(item.cardId);
      if (card !== undefined) resolved.push(resolveBurstItem(item, batch.defaults, card));
    }

    // Quantities already owned, per UNGRADED slot (the slot a burst import
    // upserts into); graded copies still count as "card already owned".
    const ungradedBySlot = new Map<string, number>();
    const ownedCardIds = new Set<string>();
    for (const copy of existingCopies) {
      ownedCardIds.add(copy.cardId);
      if (!copy.graded) {
        const key = burstSlotKey(copy);
        ungradedBySlot.set(key, (ungradedBySlot.get(key) ?? 0) + copy.quantity);
      }
    }

    const consolidated = yield* consolidateBurstItems(resolved, ungradedBySlot);
    const lines: Array<PlannedLine> = consolidated.map((line) => ({
      ...line,
      previousQuantity: ungradedBySlot.get(burstSlotKey(line)) ?? 0,
      wasNewCard: !ownedCardIds.has(line.cardId),
    }));
    return { lines };
  });

const distinctCardIds = (batch: BurstImportBatchInput): Array<string> => [
  ...new Set(batch.items.map((item) => item.cardId)),
];

// ---------------------------------------------------------------------------
// Postgres implementation — one atomic `sql.begin` transaction per commit
// ---------------------------------------------------------------------------

interface CatalogMetaRow {
  readonly id: string;
  readonly set_id: string;
  readonly available_variants: ReadonlyArray<string>;
  readonly rarity: string | null;
  readonly holo_effect: string;
}

interface CopyRow {
  readonly card_id: string;
  readonly language: string;
  readonly variant: string;
  readonly condition: string;
  readonly grading_company: string;
  readonly grading_score: string;
  readonly quantity: number;
}

/** Keeps typed domain errors thrown inside the transaction, wraps the rest. */
const toBurstImportError = (cause: unknown): BurstImportError =>
  cause instanceof ValidationError ||
  cause instanceof BurstImportCardNotFoundError ||
  cause instanceof BurstImportQuantityOverflowError ||
  cause instanceof BurstImportEmptyBatchError
    ? cause
    : new DatabaseError({ message: "burst import transaction failed", cause });

const toMeta = (row: CatalogMetaRow): BurstCardMeta => ({
  cardId: row.id as CardId,
  setId: row.set_id,
  availableVariants: row.available_variants as ReadonlyArray<CardVariant>,
  holoEffect: row.holo_effect as HoloEffect,
});

const toExistingCopy = (row: CopyRow): ExistingCardCopy => ({
  cardId: row.card_id,
  language: row.language as CardLanguage,
  variant: row.variant as CardVariant,
  condition: row.condition as CardCondition,
  graded: row.grading_company !== "" || row.grading_score !== "",
  quantity: row.quantity,
});

/**
 * Live layer. The pool must connect as a `NOINHERIT` login role (e.g.
 * `authenticator`) with `role: "authenticated"` (see {@link DatabaseLive});
 * each transaction then poses the RLS context transaction-locally:
 * `request.jwt.claims` (PostgREST convention, `{ sub, role }`) plus
 * `request.jwt.claim.sub` (read by `auth.uid()` of the local Postgres image).
 */
export const BurstImportServiceLive: Layer.Layer<BurstImportService, never, Database> =
  Layer.effect(
    BurstImportService,
    Effect.gen(function* () {
      const db = yield* Database;

      const setRlsClaims = (sql: QuerySql, userId: string): Promise<unknown> =>
        sql`
        SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true) AS claims,
               set_config('request.jwt.claim.sub', ${userId}, true) AS claim_sub
      `;

      const loadCards = (
        sql: QuerySql,
        cardIds: ReadonlyArray<string>,
      ): Promise<CatalogMetaRow[]> =>
        sql<CatalogMetaRow[]>`
        SELECT id, set_id, available_variants, rarity, holo_effect
        FROM public.catalog_cards
        WHERE id = ANY(${cardIds})
      `;

      const loadCopies = (
        sql: QuerySql,
        userId: string,
        cardIds: ReadonlyArray<string>,
      ): Promise<CopyRow[]> =>
        sql<CopyRow[]>`
        SELECT card_id, language, variant, condition,
               coalesce(grading_company, '') AS grading_company,
               coalesce(grading_score, '')  AS grading_score,
               quantity
        FROM public.user_card_copies
        WHERE user_id = ${userId} AND card_id = ANY(${cardIds})
      `;

      const wishlistTableExists = async (sql: QuerySql): Promise<boolean> => {
        const rows = await sql<{ exists: boolean }[]>`
        SELECT to_regclass('public.wishlist_items') IS NOT NULL AS exists
      `;
        return rows[0]?.exists ?? false;
      };

      const wishlistMatchingKeys = async (
        sql: QuerySql,
        userId: string,
        lines: ReadonlyArray<PlannedLine>,
      ): Promise<Set<string>> => {
        if (lines.length === 0 || !(await wishlistTableExists(sql))) return new Set();
        const { cardIds, languages, variants } = uniqueWishlistTargets(lines);
        const rows = await sql<{ card_id: string; language: CardLanguage; variant: CardVariant }[]>`
        SELECT w.card_id, w.language, w.variant
        FROM public.wishlist_items w
        JOIN unnest(${cardIds}::text[], ${languages}::text[], ${variants}::text[])
          AS targets(card_id, language, variant)
          ON w.card_id = targets.card_id
         AND w.language = targets.language
         AND w.variant = targets.variant
        WHERE w.user_id = ${userId}
      `;
        return new Set(rows.map((row) => wishlistSlotKey(row.card_id, row.language, row.variant)));
      };

      const previewBatch = (
        userId: string,
        input: unknown,
      ): Effect.Effect<BurstImportReport, BurstImportError> =>
        Effect.gen(function* () {
          const uid = yield* decodeUserId(userId);
          const batch = yield* decodeBurstImportBatchInput(input);
          return yield* Effect.tryPromise({
            try: async () => {
              // Read-only transaction: the RLS claims are transaction-local too.
              return await db.sql.begin("read only", async (tx) => {
                await setRlsClaims(tx, uid);
                const cardIds = distinctCardIds(batch);
                const metaRows = await loadCards(tx, cardIds);
                const copyRows = await loadCopies(tx, uid, cardIds);
                const plan = await Effect.runPromise(
                  planBurstBatch({
                    batch,
                    cardsById: new Map(metaRows.map((row) => [row.id, toMeta(row)] as const)),
                    existingCopies: copyRows.map(toExistingCopy),
                  }),
                );
                const wishlist = batch.defaults.removeFromWishlist
                  ? await wishlistMatchingKeys(tx, uid, plan.lines)
                  : new Set<string>();
                return buildBurstImportReport(
                  plan.lines.map((line) => ({
                    line,
                    previousQuantity: line.previousQuantity,
                    wasNewCard: line.wasNewCard,
                    removedFromWishlist: wishlist.has(
                      wishlistSlotKey(line.cardId, line.language, line.variant),
                    ),
                  })),
                );
              });
            },
            catch: toBurstImportError,
          });
        });

      const commitBatch = (
        userId: string,
        input: unknown,
      ): Effect.Effect<BurstImportReport, BurstImportError> =>
        Effect.gen(function* () {
          const uid = yield* decodeUserId(userId);
          const batch = yield* decodeBurstImportBatchInput(input);
          return yield* Effect.tryPromise({
            try: async () => {
              // ONE atomic transaction: any failure below rolls back everything.
              return await db.sql.begin(async (tx) => {
                await setRlsClaims(tx, uid);
                const cardIds = distinctCardIds(batch);
                const metaRows = await loadCards(tx, cardIds);
                const copyRows = await loadCopies(tx, uid, cardIds);
                const plan = await Effect.runPromise(
                  planBurstBatch({
                    batch,
                    cardsById: new Map(metaRows.map((row) => [row.id, toMeta(row)] as const)),
                    existingCopies: copyRows.map(toExistingCopy),
                  }),
                );

                // Upsert every slot with an atomic SQL ceiling guard so two concurrent
                // commits can never push `quantity` above MAX_CARD_COPY_QUANTITY.
                // Never touches graded copies (coalesce(grading_company, '') = '').
                const writtenTotals = new Map<string, number>();
                for (const line of plan.lines) {
                  const rows = await tx<{ id: string; quantity: number }[]>`
                  INSERT INTO public.user_card_copies (user_id, card_id, language, variant, condition, quantity)
                  VALUES (${uid}, ${line.cardId}, ${line.language}, ${line.variant}, ${line.condition}, ${line.quantity})
                  ON CONFLICT (user_id, card_id, language, variant, condition, coalesce(grading_company, ''), coalesce(grading_score, ''))
                  DO UPDATE SET quantity = public.user_card_copies.quantity + EXCLUDED.quantity
                  WHERE public.user_card_copies.quantity + EXCLUDED.quantity <= ${MAX_CARD_COPY_QUANTITY}
                  RETURNING id, quantity
                `;
                  const written = rows[0];
                  if (written === undefined) {
                    const [currentRow] = await tx<{ quantity: number }[]>`
                      SELECT quantity
                      FROM public.user_card_copies
                      WHERE user_id = ${uid}
                        AND card_id = ${line.cardId}
                        AND language = ${line.language}
                        AND variant = ${line.variant}
                        AND condition = ${line.condition}
                        AND coalesce(grading_company, '') = ''
                        AND coalesce(grading_score, '') = ''
                    `;
                    throw new BurstImportQuantityOverflowError({
                      cardId: line.cardId,
                      currentQuantity: currentRow?.quantity ?? line.previousQuantity,
                      requestedDelta: line.quantity,
                      maxQuantity: MAX_CARD_COPY_QUANTITY,
                    });
                  }
                  writtenTotals.set(burstSlotKey(line), written.quantity);
                }

                // Automatic wishlist removal matching exact (card_id, language, variant)
                // slots (table only exists from M3 / T7.1: when absent, no-op).
                let removedWishlistKeys = new Set<string>();
                if (
                  batch.defaults.removeFromWishlist &&
                  plan.lines.length > 0 &&
                  (await wishlistTableExists(tx))
                ) {
                  const {
                    cardIds: targetCards,
                    languages,
                    variants,
                  } = uniqueWishlistTargets(plan.lines);
                  const deleted = await tx<
                    { card_id: string; language: CardLanguage; variant: CardVariant }[]
                  >`
                  DELETE FROM public.wishlist_items w
                  USING unnest(${targetCards}::text[], ${languages}::text[], ${variants}::text[])
                    AS targets(card_id, language, variant)
                  WHERE w.user_id = ${uid}
                    AND w.card_id = targets.card_id
                    AND w.language = targets.language
                    AND w.variant = targets.variant
                  RETURNING w.card_id, w.language, w.variant
                `;
                  removedWishlistKeys = new Set(
                    deleted.map((row) => wishlistSlotKey(row.card_id, row.language, row.variant)),
                  );
                }

                return buildBurstImportReport(
                  plan.lines.map((line) => {
                    const writtenTotal =
                      writtenTotals.get(burstSlotKey(line)) ??
                      line.previousQuantity + line.quantity;
                    return {
                      line,
                      previousQuantity: writtenTotal - line.quantity,
                      wasNewCard: line.wasNewCard,
                      removedFromWishlist: removedWishlistKeys.has(
                        wishlistSlotKey(line.cardId, line.language, line.variant),
                      ),
                    };
                  }),
                );
              });
            },
            catch: toBurstImportError,
          });
        });

      return { previewBatch, commitBatch } satisfies BurstImportServiceShape;
    }),
  );

// ---------------------------------------------------------------------------
// In-memory implementation (unit tests, 100 % offline, atomic too)
// ---------------------------------------------------------------------------

/** One simulated `catalog_cards` row used by the memory layer. */
export type BurstImportMemoryCard = BurstCardMeta;

/** One simulated `user_card_copies` row (mutable quantity). */
export interface BurstImportMemoryCopy {
  userId: string;
  cardId: string;
  language: CardLanguage;
  variant: CardVariant;
  condition: CardCondition;
  gradingCompany: string | null;
  gradingScore: string | null;
  quantity: number;
}

/** One simulated `wishlist_items` row (aligned with `UNIQUE (user_id, card_id, language, variant)`). */
export interface BurstImportMemoryWishlistItem {
  userId: string;
  cardId: string;
  language?: CardLanguage | undefined;
  variant?: CardVariant | undefined;
}

const memoryWishlistKey = (item: BurstImportMemoryWishlistItem): string =>
  wishlistSlotKey(item.cardId, item.language ?? "FR", item.variant ?? "normal");

/**
 * Mutable state of {@link BurstImportServiceMemory}. `copies` and `wishlist`
 * are mutated in place by `commitBatch` so tests can inspect them; a failed
 * batch never mutates anything (planning happens before any write).
 */
export interface BurstImportMemoryState {
  readonly cards: ReadonlyArray<BurstImportMemoryCard>;
  copies: Array<BurstImportMemoryCopy>;
  wishlist: Array<BurstImportMemoryWishlistItem>;
  /** Simulates the absence of `public.wishlist_items` (pre-M3 database). Default: `true`. */
  readonly wishlistTableExists?: boolean | undefined;
}

/**
 * Offline layer with the same semantics as {@link BurstImportServiceLive}
 * (including a fully simulated wishlist, and atomicity: an error in the
 * middle of a batch leaves no partial mutation).
 */
export const BurstImportServiceMemory = (
  state: BurstImportMemoryState,
): Layer.Layer<BurstImportService> => {
  const cardsById = new Map(state.cards.map((card) => [card.cardId, card] as const));
  const wishlistExists = state.wishlistTableExists ?? true;

  const existingCopiesOf = (
    userId: string,
    cardIds: ReadonlyArray<string>,
  ): ReadonlyArray<ExistingCardCopy> =>
    state.copies
      .filter((copy) => copy.userId.toLowerCase() === userId && cardIds.includes(copy.cardId))
      .map((copy) => ({
        cardId: copy.cardId,
        language: copy.language,
        variant: copy.variant,
        condition: copy.condition,
        graded: (copy.gradingCompany ?? "") !== "" || (copy.gradingScore ?? "") !== "",
        quantity: copy.quantity,
      }));

  const impl: BurstImportServiceShape = {
    previewBatch: (userId, input) =>
      Effect.gen(function* () {
        const uid = yield* decodeUserId(userId);
        const batch = yield* decodeBurstImportBatchInput(input);
        const cardIds = distinctCardIds(batch);
        const plan = yield* planBurstBatch({
          batch,
          cardsById,
          existingCopies: existingCopiesOf(uid, cardIds),
        });
        const targetKeys = new Set(
          plan.lines.map((line) => wishlistSlotKey(line.cardId, line.language, line.variant)),
        );
        const wishlist =
          batch.defaults.removeFromWishlist && wishlistExists
            ? new Set(
                state.wishlist
                  .filter(
                    (item) =>
                      item.userId.toLowerCase() === uid && targetKeys.has(memoryWishlistKey(item)),
                  )
                  .map(memoryWishlistKey),
              )
            : new Set<string>();
        return buildBurstImportReport(
          plan.lines.map((line) => ({
            line,
            previousQuantity: line.previousQuantity,
            wasNewCard: line.wasNewCard,
            removedFromWishlist: wishlist.has(
              wishlistSlotKey(line.cardId, line.language, line.variant),
            ),
          })),
        );
      }),

    commitBatch: (userId, input) =>
      Effect.gen(function* () {
        const uid = yield* decodeUserId(userId);
        const batch = yield* decodeBurstImportBatchInput(input);
        const cardIds = distinctCardIds(batch);
        // Plan first: on error, NOTHING is mutated (atomic like a SQL rollback).
        const plan = yield* planBurstBatch({
          batch,
          cardsById,
          existingCopies: existingCopiesOf(uid, cardIds),
        });

        for (const line of plan.lines) {
          const slot = state.copies.find(
            (copy) =>
              copy.userId.toLowerCase() === uid &&
              copy.cardId === line.cardId &&
              copy.language === line.language &&
              copy.variant === line.variant &&
              copy.condition === line.condition &&
              (copy.gradingCompany ?? "") === "" &&
              (copy.gradingScore ?? "") === "",
          );
          if (slot === undefined) {
            state.copies.push({
              userId: uid,
              cardId: line.cardId,
              language: line.language,
              variant: line.variant,
              condition: line.condition,
              gradingCompany: null,
              gradingScore: null,
              quantity: line.quantity,
            });
          } else {
            slot.quantity += line.quantity;
          }
        }

        const removedWishlistKeys = new Set<string>();
        if (batch.defaults.removeFromWishlist && wishlistExists) {
          const targetKeys = new Set(
            plan.lines.map((line) => wishlistSlotKey(line.cardId, line.language, line.variant)),
          );
          for (const item of state.wishlist) {
            const key = memoryWishlistKey(item);
            if (item.userId.toLowerCase() === uid && targetKeys.has(key)) {
              removedWishlistKeys.add(key);
            }
          }
          state.wishlist = state.wishlist.filter(
            (item) =>
              !(item.userId.toLowerCase() === uid && targetKeys.has(memoryWishlistKey(item))),
          );
        }

        return buildBurstImportReport(
          plan.lines.map((line) => ({
            line,
            previousQuantity: line.previousQuantity,
            wasNewCard: line.wasNewCard,
            removedFromWishlist: removedWishlistKeys.has(
              wishlistSlotKey(line.cardId, line.language, line.variant),
            ),
          })),
        );
      }),
  };
  return Layer.succeed(BurstImportService, impl);
};
