import {
  type CatalogCard,
  type CatalogSeries,
  type CatalogSet,
  deriveHoloEffect,
  detectIsTera,
  extractAvailableVariants,
  normalizeCatalogCategory,
  normalizeSetCounts,
  parseLocalIdNumeric,
} from "@pokevault/domain";
import { Context, Effect, Layer, Option } from "effect";
import {
  CatalogRepository,
  CatalogRepositoryLive,
  chunk,
  UPSERT_BATCH_SIZE,
} from "./catalog-repo.ts";
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
}

export interface CatalogSyncReport {
  readonly seriesCount: number;
  readonly setsCount: number;
  readonly cardsCount: number;
  readonly failedSets: ReadonlyArray<string>;
  readonly durationMs: number;
}

export type CatalogSyncError = TcgdexError | DatabaseError;

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
  const variant =
    availableVariants.find((value) => value === "holo") ??
    availableVariants.find((value) => value === "reverse");
  return {
    id: fr.id,
    set_id: fr.set?.id ?? setId,
    local_id: fr.localId,
    local_id_numeric: parseLocalIdNumeric(fr.localId),
    name_fr: fr.name,
    name_en: nameEn,
    rarity: fr.rarity ?? null,
    holo_effect: deriveHoloEffect({ rarity: fr.rarity ?? "", variant, isTera }),
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
  readonly ok: true;
  readonly setId: string;
  readonly cardsCount: number;
}

interface SetSyncFailure {
  readonly ok: false;
  readonly setId: string;
  readonly error: CatalogSyncError;
}

type SetSyncResult = SetSyncSuccess | SetSyncFailure;

const DEFAULT_SET_CONCURRENCY = 4;
const CARD_CONCURRENCY = 8;

export const TcgdexSyncServiceLive: Layer.Layer<
  TcgdexSyncService,
  never,
  TcgdexClient | CatalogRepository
> = Layer.effect(
  TcgdexSyncService,
  Effect.gen(function* () {
    const client = yield* TcgdexClient;
    const repo = yield* CatalogRepository;

    const cardFailureLog = (setId: string, cardId: string) => (error: TcgdexError) =>
      Effect.logWarning("catalog.sync.card_failed").pipe(
        Effect.annotateLogs({ setId, cardId, error: String(error) }),
      );

    const syncSet = (setId: string): Effect.Effect<SetSyncResult, never> =>
      Effect.gen(function* () {
        const fr = yield* client.getSet("fr", setId);
        const enDetail = Option.getOrNull(yield* Effect.option(client.getSet("en", setId)));
        const enNameByCardId = new Map(
          (enDetail?.cards ?? []).map((card) => [card.id, card.name] as const),
        );
        const setRow = setDetailToRow(fr, enDetail?.name ?? null);
        yield* repo.upsertSets([setRow]);

        const summaries = fr.cards ?? [];
        const rows: Array<CatalogCard> = [];
        yield* Effect.forEach(
          summaries,
          (summary) =>
            client.getCard("fr", summary.id).pipe(
              Effect.tap((detail) =>
                Effect.sync(() => {
                  rows.push(
                    cardDetailToRow(
                      detail,
                      fr.id,
                      enNameByCardId.get(summary.id) ?? null,
                      summary.image ?? null,
                    ),
                  );
                }),
              ),
              Effect.catchTags({
                TcgdexHttpError: cardFailureLog(setId, summary.id),
                TcgdexDecodeError: cardFailureLog(setId, summary.id),
              }),
            ),
          { concurrency: CARD_CONCURRENCY },
        );
        yield* Effect.forEach(chunk(rows, UPSERT_BATCH_SIZE), (batch) => repo.upsertCards(batch), {
          concurrency: 1,
          discard: true,
        });
        yield* Effect.logInfo("catalog.sync.set_done").pipe(
          Effect.annotateLogs({ setId, cardsCount: rows.length }),
        );
        return { ok: true, setId, cardsCount: rows.length } satisfies SetSyncSuccess;
      }).pipe(
        Effect.catchTags({
          TcgdexHttpError: (error) => Effect.succeed<SetSyncResult>({ ok: false, setId, error }),
          TcgdexDecodeError: (error) => Effect.succeed<SetSyncResult>({ ok: false, setId, error }),
          DatabaseError: (error) => Effect.succeed<SetSyncResult>({ ok: false, setId, error }),
        }),
        Effect.tap((result) =>
          result.ok
            ? Effect.void
            : Effect.logWarning("catalog.sync.set_failed").pipe(
                Effect.annotateLogs({ setId: result.setId, error: String(result.error) }),
              ),
        ),
      );

    const sync = (
      options?: CatalogSyncOptions,
    ): Effect.Effect<CatalogSyncReport, CatalogSyncError> =>
      Effect.gen(function* () {
        const startedAt = yield* Effect.sync(() => Date.now());

        // 1. Series FR (+ best-effort EN enrichment) → upsertSeries.
        const seriesFr = yield* client.listSeries("fr");
        const seriesEn = Option.getOrNull(yield* Effect.option(client.listSeries("en")));
        const enSeriesById = new Map(
          (seriesEn ?? []).map((series) => [series.id, series] as const),
        );
        const seriesRows = seriesFr.map((series, index) =>
          seriesToRow(series, enSeriesById.get(series.id), index),
        );
        yield* repo.upsertSeries(seriesRows);
        yield* Effect.logInfo("catalog.sync.series_done").pipe(
          Effect.annotateLogs({ count: seriesRows.length }),
        );

        // 2. Sets FR (+ EN detail for name_en) → upsertSets, then cards per set.
        const allSets = yield* client.listSets("fr");
        const setIds = options?.setIds;
        const wanted =
          setIds === undefined ? allSets : allSets.filter((set) => setIds.includes(set.id));
        const results = yield* Effect.forEach(wanted, (summary) => syncSet(summary.id), {
          concurrency: options?.concurrency ?? DEFAULT_SET_CONCURRENCY,
        });

        const failedSets = results.filter((result) => !result.ok).map((result) => result.setId);
        const setsCount = results.length - failedSets.length;
        const cardsCount = results.reduce(
          (total, result) => total + (result.ok ? result.cardsCount : 0),
          0,
        );
        const durationMs = yield* Effect.sync(() => Date.now() - startedAt);
        const report: CatalogSyncReport = {
          seriesCount: seriesRows.length,
          setsCount,
          cardsCount,
          failedSets,
          durationMs,
        };
        yield* Effect.logInfo("catalog.sync.completed").pipe(
          Effect.annotateLogs({
            seriesCount: report.seriesCount,
            setsCount: report.setsCount,
            cardsCount: report.cardsCount,
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
