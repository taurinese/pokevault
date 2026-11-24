import {
  type CardVariant,
  CatalogCard,
  CatalogSeries,
  CatalogSet,
  deriveHoloEffect,
  detectIsTera,
  extractAvailableVariants,
  normalizeCatalogCategory,
  normalizeSetCounts,
  parseLocalIdNumeric,
  ValidationError,
} from "@pokevault/domain";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { CatalogRepository, CatalogRepositoryLive } from "./catalog-repo.ts";
import { type DatabaseError, DatabaseLive } from "./db.ts";
import {
  DEFAULT_TCGDEX_BASE_URL,
  type TcgdexCardDetail,
  TcgdexClient,
  TcgdexClientLive,
  type TcgdexError,
  type TcgdexSeriesSummary,
  type TcgdexSetDetail,
} from "./tcgdex.ts";

// ---------------------------------------------------------------------------
// Options & report
// ---------------------------------------------------------------------------

export interface CatalogSyncOptions {
  /** Restrict the sync to these set ids (bootstrap / targeted tests). */
  readonly setIds?: ReadonlyArray<string> | undefined;
  /** Max concurrent set imports (default 4). */
  readonly concurrency?: number | undefined;
  /**
   * Series ids left out of the catalogue (default {@link DEFAULT_EXCLUDED_SERIES_IDS}).
   * The numeric TCG Pocket series (`tcgp`) is not part of the physical catalogue.
   */
  readonly excludedSeriesIds?: ReadonlyArray<string> | undefined;
}

/** Series skipped by default: TCG Pocket (digital game, not physical cards). */
export const DEFAULT_EXCLUDED_SERIES_IDS: ReadonlyArray<string> = ["tcgp"];

export interface CatalogSyncReport {
  readonly seriesCount: number;
  readonly setsCount: number;
  readonly cardsCount: number;
  /** Cards skipped (fetch failure or failed domain validation) in successfully synced sets. */
  readonly failedCards: number;
  readonly failedSets: ReadonlyArray<string>;
  readonly durationMs: number;
}

export type CatalogSyncError = TcgdexError | DatabaseError;

/** Every error a single set import can end with (never escapes `sync`, reported in `failedSets`). */
export type CatalogSetSyncError = CatalogSyncError | ValidationError;

// ---------------------------------------------------------------------------
// Structured error formatting (log annotations)
// ---------------------------------------------------------------------------

const describeCause = (cause: unknown): string => {
  if (cause === undefined || cause === null) return "";
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code;
    return `${cause.name}: ${cause.message}${typeof code === "string" ? ` (code=${code})` : ""}`;
  }
  return typeof cause === "string" ? cause : (JSON.stringify(cause) ?? String(cause));
};

/**
 * Extracts every diagnostic field of a typed sync error (`errorTag`, `message`,
 * and `status` / `url` / `retryable` / `cause` when present) as flat, structured
 * log annotations — `String(error)` on a `Data.TaggedError` would lose them.
 */
export const formatSyncError = (error: CatalogSetSyncError): Record<string, unknown> => {
  switch (error._tag) {
    case "TcgdexHttpError":
      return {
        errorTag: error._tag,
        message: `TCGdex HTTP ${error.status} on ${error.url}`,
        status: error.status,
        url: error.url,
        retryable: error.retryable,
        ...(error.body !== null ? { body: error.body } : {}),
        ...(error.cause !== undefined ? { cause: describeCause(error.cause) } : {}),
      };
    case "TcgdexDecodeError":
      return {
        errorTag: error._tag,
        message: `TCGdex payload decode failed on ${error.url}`,
        url: error.url,
        cause: describeCause(error.cause),
      };
    case "DatabaseError":
      return {
        errorTag: error._tag,
        message: error.message,
        cause: describeCause(error.cause),
      };
    case "ValidationError":
      return {
        errorTag: error._tag,
        message: error.message,
        cause: describeCause(error.cause),
      };
  }
};

// ---------------------------------------------------------------------------
// Pure mappers (TCGdex payloads → catalog rows)
// ---------------------------------------------------------------------------

/** Maps a FR series summary (+ optional EN name) to a `catalog_series` row. */
export const seriesToRow = (
  fr: TcgdexSeriesSummary,
  en: TcgdexSeriesSummary | undefined,
  releaseOrder: number,
): CatalogSeries => ({
  id: fr.id,
  name_fr: fr.name,
  name_en: en?.name ?? null,
  release_order: releaseOrder,
});

/** Maps a FR set detail (+ optional EN name) to a `catalog_sets` row. */
export const setDetailToRow = (fr: TcgdexSetDetail, nameEn: string | null): CatalogSet => {
  const counts = normalizeSetCounts(fr.cardCount?.official ?? 0, fr.cardCount?.total ?? 0);
  return {
    id: fr.id,
    series_id: fr.serie.id,
    code: fr.abbreviation?.localized ?? null,
    cardmarket_code: fr.abbreviation?.official ?? null,
    name_fr: fr.name,
    name_en: nameEn,
    logo_url: fr.logo ?? null,
    symbol_url: fr.symbol ?? null,
    release_date: fr.releaseDate ?? null,
    official_count: counts.official_count,
    total_count: counts.total_count,
  };
};

/**
 * Variant that characterises the *base* card print for `deriveHoloEffect`.
 *
 * `catalog_cards.holo_effect` is the preset of the base card, whereas the
 * reverse effect depends on the variant of the owned copy
 * (`user_card_copies.variant`). A `reverse` print listed next to a `normal`
 * one therefore never makes the base card "reverse"; a variant is only used
 * when the card has no `normal` print (holo-only cards, reverse-only cards).
 */
const baseCardVariant = (
  availableVariants: ReadonlyArray<CardVariant>,
): CardVariant | undefined => {
  if (availableVariants.includes("normal")) return undefined;
  if (availableVariants.includes("holo")) return "holo";
  if (availableVariants.includes("reverse")) return "reverse";
  return undefined;
};

/**
 * Maps a FR card detail (+ EN name from the EN set, image fallback from the
 * set card list) to a `catalog_cards` row, deriving `category`,
 * `available_variants`, `local_id_numeric` and `holo_effect` (via
 * `deriveHoloEffect` with the `isTera` flag) through the pure domain helpers.
 */
export const cardDetailToRow = (
  fr: TcgdexCardDetail,
  setId: string,
  nameEn: string | null,
  imageFallback: string | null,
): CatalogCard => {
  const availableVariants = extractAvailableVariants(fr.variants);
  const isTera = detectIsTera(fr);
  return {
    id: fr.id,
    set_id: fr.set?.id ?? setId,
    local_id: fr.localId,
    local_id_numeric: parseLocalIdNumeric(fr.localId),
    name_fr: fr.name,
    name_en: nameEn,
    rarity: fr.rarity ?? null,
    holo_effect: deriveHoloEffect({
      rarity: fr.rarity ?? "",
      variant: baseCardVariant(availableVariants),
      isTera,
    }),
    category: normalizeCatalogCategory(fr.category),
    types: fr.types ?? [],
    hp: fr.hp ?? null,
    illustrator: fr.illustrator ?? null,
    image_base_url: fr.image ?? imageFallback,
    available_variants: availableVariants,
    cardmarket_product_id: fr.pricing?.cardmarket?.idProduct ?? null,
    cardmarket_url: null,
  };
};

export interface CardDuplicate {
  readonly card: CatalogCard;
  readonly reason: "duplicate_id" | "duplicate_set_local_id";
  /** Id of the card kept instead of {@link CardDuplicate.card}. */
  readonly keptId: string;
}

/**
 * Deduplicates card rows by `id` THEN by `(set_id, local_id)`, keeping the
 * first occurrence. Prevents the Postgres `ON CONFLICT DO UPDATE command cannot
 * affect row a second time` crash and `UNIQUE (set_id, local_id)` violations.
 */
export const dedupeCards = (
  rows: ReadonlyArray<CatalogCard>,
): {
  readonly rows: ReadonlyArray<CatalogCard>;
  readonly duplicates: ReadonlyArray<CardDuplicate>;
} => {
  const duplicates: Array<CardDuplicate> = [];
  const byId = new Map<string, CatalogCard>();
  for (const card of rows) {
    if (byId.has(card.id)) duplicates.push({ card, reason: "duplicate_id", keptId: card.id });
    else byId.set(card.id, card);
  }
  const byLocalId = new Map<string, CatalogCard>();
  const unique: Array<CatalogCard> = [];
  for (const card of byId.values()) {
    const key = JSON.stringify([card.set_id, card.local_id]);
    const kept = byLocalId.get(key);
    if (kept !== undefined) {
      duplicates.push({ card, reason: "duplicate_set_local_id", keptId: kept.id });
    } else {
      byLocalId.set(key, card);
      unique.push(card);
    }
  }
  return { rows: unique, duplicates };
};

// ---------------------------------------------------------------------------
// TcgdexSyncService
// ---------------------------------------------------------------------------

export interface TcgdexSyncServiceShape {
  readonly sync: (
    options?: CatalogSyncOptions,
  ) => Effect.Effect<CatalogSyncReport, CatalogSyncError>;
}

/** Effect-TS service key of the TCGdex catalogue synchronisation. */
export class TcgdexSyncService extends Context.Service<TcgdexSyncService, TcgdexSyncServiceShape>()(
  "@pokevault/services/TcgdexSyncService",
) {}

interface SetSyncSuccess {
  readonly kind: "synced";
  readonly setId: string;
  readonly cardsCount: number;
  readonly failedCards: number;
}

interface SetSyncSkipped {
  readonly kind: "skipped";
  readonly setId: string;
}

interface SetSyncFailure {
  readonly kind: "failed";
  readonly setId: string;
  readonly error: CatalogSetSyncError;
}

type SetSyncResult = SetSyncSuccess | SetSyncSkipped | SetSyncFailure;

const DEFAULT_SET_CONCURRENCY = 4;
const CARD_CONCURRENCY = 8;

/** Decodes a mapped row through its domain schema; failures become a typed `ValidationError`. */
const validateRow = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  schema: S,
  table: string,
  id: string,
  row: unknown,
): Effect.Effect<S["Type"], ValidationError> =>
  Schema.decodeUnknownEffect(schema)(row).pipe(
    Effect.mapError(
      (error) =>
        new ValidationError({ message: `${table}[${id}]: ${error.message}`, cause: error }),
    ),
  );

export const TcgdexSyncServiceLive: Layer.Layer<
  TcgdexSyncService,
  never,
  TcgdexClient | CatalogRepository
> = Layer.effect(
  TcgdexSyncService,
  Effect.gen(function* () {
    const client = yield* TcgdexClient;
    const repo = yield* CatalogRepository;

    const logCardSkipped =
      (setId: string, cardId: string, event: string) => (error: CatalogSetSyncError) =>
        Effect.logWarning(event).pipe(
          Effect.annotateLogs({ setId, cardId, ...formatSyncError(error) }),
          Effect.as(Option.none<CatalogCard>()),
        );

    const syncSet = (
      setId: string,
      excludedSeries: ReadonlySet<string>,
    ): Effect.Effect<SetSyncResult, never> =>
      Effect.gen(function* () {
        const fr = yield* client.getSet("fr", setId);
        if (excludedSeries.has(fr.serie.id)) {
          yield* Effect.logInfo("catalog.sync.set_skipped").pipe(
            Effect.annotateLogs({ setId, seriesId: fr.serie.id }),
          );
          return { kind: "skipped", setId } satisfies SetSyncSkipped;
        }
        const enDetail = Option.getOrNull(yield* Effect.option(client.getSet("en", setId)));
        const enNameByCardId = new Map(
          (enDetail?.cards ?? []).map((card) => [card.id, card.name] as const),
        );
        const setRow = yield* validateRow(
          CatalogSet,
          "catalog_sets",
          fr.id,
          setDetailToRow(fr, enDetail?.name ?? null),
        );
        yield* repo.upsertSets([setRow]);

        // Fetch + map + validate every card; a dirty card is skipped (never fails the set).
        const summaries = fr.cards ?? [];
        const candidates = yield* Effect.forEach(
          summaries,
          (summary) =>
            client.getCard("fr", summary.id).pipe(
              Effect.flatMap((detail) =>
                validateRow(
                  CatalogCard,
                  "catalog_cards",
                  detail.id,
                  cardDetailToRow(
                    detail,
                    fr.id,
                    enNameByCardId.get(summary.id) ?? null,
                    summary.image ?? null,
                  ),
                ),
              ),
              Effect.map(Option.some),
              Effect.catchTags({
                TcgdexHttpError: logCardSkipped(setId, summary.id, "catalog.sync.card_failed"),
                TcgdexDecodeError: logCardSkipped(setId, summary.id, "catalog.sync.card_failed"),
                ValidationError: logCardSkipped(setId, summary.id, "catalog.sync.card_invalid"),
              }),
            ),
          { concurrency: CARD_CONCURRENCY },
        );
        const valid = candidates.flatMap((candidate) => Option.toArray(candidate));
        const { rows, duplicates } = dedupeCards(valid);
        yield* Effect.forEach(
          duplicates,
          (duplicate) =>
            Effect.logWarning("catalog.sync.card_duplicate_ignored").pipe(
              Effect.annotateLogs({
                setId,
                cardId: duplicate.card.id,
                localId: duplicate.card.local_id,
                reason: duplicate.reason,
                keptCardId: duplicate.keptId,
              }),
            ),
          { discard: true },
        );
        yield* repo.upsertCards(rows);

        const failedCards = summaries.length - valid.length;
        yield* Effect.logInfo("catalog.sync.set_done").pipe(
          Effect.annotateLogs({
            setId,
            cardsCount: rows.length,
            failedCards,
            duplicates: duplicates.length,
          }),
        );
        return {
          kind: "synced",
          setId,
          cardsCount: rows.length,
          failedCards,
        } satisfies SetSyncSuccess;
      }).pipe(
        Effect.catchTags({
          TcgdexHttpError: (error) =>
            Effect.succeed<SetSyncResult>({ kind: "failed", setId, error }),
          TcgdexDecodeError: (error) =>
            Effect.succeed<SetSyncResult>({ kind: "failed", setId, error }),
          DatabaseError: (error) => Effect.succeed<SetSyncResult>({ kind: "failed", setId, error }),
          ValidationError: (error) =>
            Effect.succeed<SetSyncResult>({ kind: "failed", setId, error }),
        }),
        Effect.tap((result) =>
          result.kind !== "failed"
            ? Effect.void
            : Effect.logWarning("catalog.sync.set_failed").pipe(
                Effect.annotateLogs({ setId: result.setId, ...formatSyncError(result.error) }),
              ),
        ),
      );

    const sync = (
      options?: CatalogSyncOptions,
    ): Effect.Effect<CatalogSyncReport, CatalogSyncError> =>
      Effect.gen(function* () {
        const startedAt = yield* Effect.sync(() => Date.now());
        const excludedSeries = new Set(options?.excludedSeriesIds ?? DEFAULT_EXCLUDED_SERIES_IDS);

        // 1. Series FR (+ best-effort EN enrichment) → validated → upsertSeries.
        const seriesFr = (yield* client.listSeries("fr")).filter(
          (series) => !excludedSeries.has(series.id),
        );
        const seriesEn = Option.getOrNull(yield* Effect.option(client.listSeries("en")));
        const enSeriesById = new Map(
          (seriesEn ?? []).map((series) => [series.id, series] as const),
        );
        const seriesRows = (yield* Effect.forEach(seriesFr, (series, index) =>
          validateRow(
            CatalogSeries,
            "catalog_series",
            series.id,
            seriesToRow(series, enSeriesById.get(series.id), index),
          ).pipe(
            Effect.map(Option.some),
            Effect.catchTag("ValidationError", (error) =>
              Effect.logWarning("catalog.sync.series_invalid").pipe(
                Effect.annotateLogs({ seriesId: series.id, ...formatSyncError(error) }),
                Effect.as(Option.none<CatalogSeries>()),
              ),
            ),
          ),
        )).flatMap((row) => Option.toArray(row));
        yield* repo.upsertSeries(seriesRows);
        yield* Effect.logInfo("catalog.sync.series_done").pipe(
          Effect.annotateLogs({ count: seriesRows.length }),
        );

        // 2. Sets FR (+ EN detail for name_en) → upsertSets, then cards per set.
        const allSets = yield* client.listSets("fr");
        const setIds = options?.setIds;
        const wanted =
          setIds === undefined ? allSets : allSets.filter((set) => setIds.includes(set.id));
        const results = yield* Effect.forEach(
          wanted,
          (summary) => syncSet(summary.id, excludedSeries),
          { concurrency: options?.concurrency ?? DEFAULT_SET_CONCURRENCY },
        );

        const failedSets = results.flatMap((result) =>
          result.kind === "failed" ? [result.setId] : [],
        );
        const synced = results.flatMap((result) => (result.kind === "synced" ? [result] : []));
        const setsCount = synced.length;
        const cardsCount = synced.reduce((total, result) => total + result.cardsCount, 0);
        const failedCards = synced.reduce((total, result) => total + result.failedCards, 0);
        const durationMs = yield* Effect.sync(() => Date.now() - startedAt);
        const report: CatalogSyncReport = {
          seriesCount: seriesRows.length,
          setsCount,
          cardsCount,
          failedCards,
          failedSets,
          durationMs,
        };
        yield* Effect.logInfo("catalog.sync.completed").pipe(
          Effect.annotateLogs({
            seriesCount: report.seriesCount,
            setsCount: report.setsCount,
            cardsCount: report.cardsCount,
            failedCards: report.failedCards,
            failedSets: report.failedSets.length,
            durationMs: report.durationMs,
          }),
        );
        return report;
      });

    return { sync };
  }),
);

// ---------------------------------------------------------------------------
// Ready-made composition (worker bootstrap + CLI)
// ---------------------------------------------------------------------------

export interface CatalogSyncLayerOptions {
  readonly baseUrl?: string | undefined;
  readonly databaseUrl: string;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
}

/**
 * Fully wired layer: `TcgdexSyncService` over the live HTTP client and the
 * Postgres repository. The pool lifetime is bound to the scope in which the
 * layer is built (worker shutdown / CLI exit).
 */
export const CatalogSyncLayer = (
  options: CatalogSyncLayerOptions,
): Layer.Layer<TcgdexSyncService> =>
  TcgdexSyncServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        TcgdexClientLive({
          baseUrl: options.baseUrl ?? DEFAULT_TCGDEX_BASE_URL,
          timeoutMs: options.timeoutMs,
          maxRetries: options.maxRetries,
        }),
        CatalogRepositoryLive.pipe(
          Layer.provide(DatabaseLive({ connectionString: options.databaseUrl })),
        ),
      ),
    ),
  );
