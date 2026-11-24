import { CatalogSyncLayer, TcgdexSyncService } from "@pokevault/services";
import { Effect, Exit, Logger } from "effect";
import { loadWorkerConfig } from "./config.ts";

/** CLI flag handled by the bundled worker: `node dist/index.mjs --sync-catalog`. */
export const SYNC_CATALOG_FLAG = "--sync-catalog";

export interface SyncCatalogCliArgs {
  /** `--set=<id>` filters (repeatable); empty means "all sets". */
  readonly setIds: ReadonlyArray<string>;
  /** Optional `--base-url=<url>` override of `TCGDEX_BASE_URL`. */
  readonly baseUrl: string | null;
}

/** Parses `--sync-catalog [--set=sv03.5 ...] [--base-url=...]` style arguments. */
export const parseSyncCatalogArgs = (args: ReadonlyArray<string>): SyncCatalogCliArgs => {
  const setIds: Array<string> = [];
  let baseUrl: string | null = null;
  for (const arg of args) {
    if (arg === SYNC_CATALOG_FLAG) continue;
    if (arg.startsWith("--set=")) {
      const value = arg.slice("--set=".length).trim();
      if (value.length > 0) setIds.push(value);
    } else if (arg.startsWith("--base-url=")) {
      const value = arg.slice("--base-url=".length).trim();
      baseUrl = value.length > 0 ? value : null;
    }
  }
  return { setIds, baseUrl };
};

/**
 * One-shot catalog sync job (bootstrap): synchronizes the TCGdex catalogue into
 * Postgres and completes with a process exit code (0 = success, 1 = failure).
 * `DATABASE_URL` is required; `--set=<id>` restricts the import to given sets.
 */
export const runSyncCatalogCli = (args: ReadonlyArray<string>): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const parsed = parseSyncCatalogArgs(args);
    const configExit = yield* Effect.exit(loadWorkerConfig);
    if (Exit.isFailure(configExit)) {
      yield* Effect.logError("sync.catalog.config_invalid", configExit.cause);
      return 1;
    }
    const config = configExit.value;
    if (config.databaseUrl === null) {
      yield* Effect.logError("sync.catalog.missing_database_url").pipe(
        Effect.annotateLogs({ key: "DATABASE_URL" }),
      );
      return 1;
    }
    const baseUrl = parsed.baseUrl ?? config.tcgdexBaseUrl;
    const setIds = parsed.setIds.length > 0 ? parsed.setIds : undefined;
    yield* Effect.logInfo("sync.catalog.started").pipe(
      Effect.annotateLogs({ baseUrl, setIds: setIds?.join(",") ?? "all" }),
    );
    const report = yield* Effect.gen(function* () {
      const service = yield* TcgdexSyncService;
      return yield* service.sync({ setIds });
    }).pipe(
      Effect.provide(CatalogSyncLayer({ baseUrl, databaseUrl: config.databaseUrl })),
      Effect.catchTags({
        TcgdexHttpError: (error) =>
          Effect.logError("sync.catalog.tcgdex_http_failed", error).pipe(Effect.as(null)),
        TcgdexDecodeError: (error) =>
          Effect.logError("sync.catalog.tcgdex_decode_failed", error).pipe(Effect.as(null)),
        DatabaseError: (error) =>
          Effect.logError("sync.catalog.database_failed", error).pipe(Effect.as(null)),
      }),
    );
    if (report === null) {
      yield* Effect.logError("sync.catalog.failed");
      return 1;
    }
    yield* Effect.logInfo("sync.catalog.completed").pipe(
      Effect.annotateLogs({
        seriesCount: report.seriesCount,
        setsCount: report.setsCount,
        cardsCount: report.cardsCount,
        failedSets: report.failedSets.length,
        durationMs: report.durationMs,
      }),
    );
    return 0;
  });

/** Runs the CLI when executed directly (`node src/sync-catalog.ts [--sync-catalog] ...`). */
export const main = (): void => {
  const logger = Logger.layer([Logger.consoleJson], { mergeWithExisting: false });
  Effect.runPromise(runSyncCatalogCli(process.argv.slice(2)).pipe(Effect.provide(logger))).then(
    (code) => {
      process.exitCode = code;
    },
    (defect) => {
      process.exitCode = 1;
      throw defect;
    },
  );
};

// Direct execution guard: true only when this file is the entry point
// (`node src/sync-catalog.ts`). When bundled into `dist/index.mjs`, argv[1] is
// the bundle path and the daemon entry point (`index.ts`) drives the CLI itself.
if (process.argv[1]?.endsWith("sync-catalog.ts") === true) {
  main();
}
