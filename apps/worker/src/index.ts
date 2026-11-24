import type { PriceBatchReport } from "@pokevault/domain";
import {
  CardmarketPriceLayer,
  CardmarketPriceService,
  type CatalogSyncError,
  CatalogSyncLayer,
  type CatalogSyncReport,
  TcgdexSyncService,
} from "@pokevault/services";
import { Effect, Layer, Logger } from "effect";
import { loadWorkerConfig } from "./config.ts";
import { runWorker } from "./runtime.ts";
import { runSyncCatalogCli, SYNC_CATALOG_FLAG } from "./sync-catalog.ts";

const args = process.argv.slice(2);

const logger = Logger.layer([Logger.consoleJson], { mergeWithExisting: false });

/** One catalog sync run, reading `TcgdexSyncService` from the provided layer. */
const syncOnce: Effect.Effect<CatalogSyncReport, CatalogSyncError, TcgdexSyncService> =
  Effect.flatMap(TcgdexSyncService, (service) => service.sync());

const main = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadWorkerConfig;
    const catalogSyncEnv =
      config.tcgdexSyncEnabled === true
        ? yield* Layer.build(
            CatalogSyncLayer({ baseUrl: config.tcgdexBaseUrl, databaseUrl: config.databaseUrl }),
          )
        : undefined;
    const catalogSync =
      catalogSyncEnv !== undefined
        ? {
            intervalMs: config.tcgdexSyncIntervalMs,
            run: syncOnce.pipe(Effect.provide(catalogSyncEnv)),
          }
        : undefined;

    // Build CardmarketPriceLayer ONCE for the worker lifetime so the circuit
    // breaker Ref, concurrency Semaphore, and Postgres pool persist across ticks
    // and close cleanly when the worker scope ends.
    const priceRefreshEnv =
      config.cardmarketPriceSyncEnabled === true
        ? yield* Layer.build(
            CardmarketPriceLayer({
              databaseUrl: config.databaseUrl,
              tcgdexBaseUrl: config.tcgdexBaseUrl,
            }),
          )
        : undefined;
    const priceRefresh =
      priceRefreshEnv !== undefined
        ? {
            intervalMs: config.cardmarketPriceSyncIntervalMs,
            batchLimit: config.cardmarketPriceBatchLimit,
            run: Effect.flatMap(CardmarketPriceService, (service) =>
              service.runScheduledRefresh({ batchLimit: config.cardmarketPriceBatchLimit }),
            ).pipe(Effect.provide(priceRefreshEnv)) satisfies Effect.Effect<
              PriceBatchReport,
              unknown
            >,
          }
        : undefined;

    yield* runWorker({
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      signals: process,
      catalogSync,
      priceRefresh,
    });
  }),
).pipe(
  Effect.tapCause((cause) =>
    Effect.logError("worker.crashed", cause).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(logger),
);

if (args.includes(SYNC_CATALOG_FLAG)) {
  // Bootstrap job: `node dist/index.mjs --sync-catalog [--set=sv03.5]`
  // (equivalently `pnpm --filter @pokevault/worker sync:catalog` in dev).
  Effect.runPromise(runSyncCatalogCli(args).pipe(Effect.provide(logger))).then(
    (code) => {
      process.exitCode = code;
    },
    (defect) => {
      process.exitCode = 1;
      throw defect;
    },
  );
} else {
  Effect.runFork(main);
}
