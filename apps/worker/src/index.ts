import {
  type CatalogSyncError,
  CatalogSyncLayer,
  type CatalogSyncReport,
  TcgdexSyncService,
} from "@pokevault/services";
import { Effect, Logger } from "effect";
import { loadWorkerConfig } from "./config.ts";
import { runWorker } from "./runtime.ts";
import { runSyncCatalogCli, SYNC_CATALOG_FLAG } from "./sync-catalog.ts";

const args = process.argv.slice(2);

const logger = Logger.layer([Logger.consoleJson], { mergeWithExisting: false });

/** One catalog sync run, reading `TcgdexSyncService` from the provided layer. */
const syncOnce: Effect.Effect<CatalogSyncReport, CatalogSyncError, TcgdexSyncService> =
  Effect.flatMap(TcgdexSyncService, (service) => service.sync());

const main = Effect.gen(function* () {
  const config = yield* loadWorkerConfig;
  const catalogSync =
    config.tcgdexSyncEnabled === true
      ? {
          intervalMs: config.tcgdexSyncIntervalMs,
          run: syncOnce.pipe(
            Effect.provide(
              CatalogSyncLayer({ baseUrl: config.tcgdexBaseUrl, databaseUrl: config.databaseUrl }),
            ),
          ),
        }
      : undefined;
  yield* runWorker({
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    signals: process,
    catalogSync,
  });
}).pipe(
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
