import { DEFAULT_TCGDEX_BASE_URL, ServiceConfigError } from "@pokevault/services";
import { Config, Effect, Option } from "effect";

/** Default delay between two heartbeat ticks (30 s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default catalog sync interval: once every 24 h. */
export const DEFAULT_TCGDEX_SYNC_INTERVAL_MS = 86_400_000;

/** Default Cardmarket price refresh interval: every 15 min (TTL of price snapshots). */
export const DEFAULT_CARDMARKET_PRICE_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** Default number of cards refreshed per price cron run. */
export const DEFAULT_CARDMARKET_PRICE_BATCH_LIMIT = 30;

/** Allowed range for `CARDMARKET_PRICE_BATCH_LIMIT`. */
export const CARDMARKET_PRICE_BATCH_LIMIT_RANGE = { min: 1, max: 200 } as const;

const HEARTBEAT_ENV_KEY = "WORKER_HEARTBEAT_INTERVAL_MS";
const DATABASE_URL_ENV_KEY = "DATABASE_URL";
const TCGDEX_SYNC_ENABLED_ENV_KEY = "TCGDEX_SYNC_ENABLED";
const TCGDEX_SYNC_INTERVAL_MS_ENV_KEY = "TCGDEX_SYNC_INTERVAL_MS";
const TCGDEX_BASE_URL_ENV_KEY = "TCGDEX_BASE_URL";
const CARDMARKET_PRICE_SYNC_ENABLED_ENV_KEY = "CARDMARKET_PRICE_SYNC_ENABLED";
const CARDMARKET_PRICE_SYNC_INTERVAL_MS_ENV_KEY = "CARDMARKET_PRICE_SYNC_INTERVAL_MS";
const CARDMARKET_PRICE_BATCH_LIMIT_ENV_KEY = "CARDMARKET_PRICE_BATCH_LIMIT";

interface WorkerConfigBase {
  /** Delay between two heartbeat ticks, in milliseconds (strictly positive). */
  readonly heartbeatIntervalMs: number;
  /** Postgres connection string, or `null` when the worker runs heartbeat-only. */
  readonly databaseUrl: string | null;
  /** Whether the daily TCGdex catalog sync cron is enabled. */
  readonly tcgdexSyncEnabled: boolean;
  /** Delay between two catalog sync runs, in milliseconds (strictly positive). */
  readonly tcgdexSyncIntervalMs: number;
  /** TCGdex v2 API root (no trailing slash needed). */
  readonly tcgdexBaseUrl: string;
  /**
   * Whether the Cardmarket price refresh cron is enabled (default `false`:
   * deployments without scraping keep working untouched).
   */
  readonly cardmarketPriceSyncEnabled: boolean;
  /** Delay between two price refresh runs, in milliseconds (strictly positive). */
  readonly cardmarketPriceSyncIntervalMs: number;
  /** Max number of cards refreshed per price cron run (1..200). */
  readonly cardmarketPriceBatchLimit: number;
}

export type WorkerConfig =
  | (WorkerConfigBase & {
      readonly tcgdexSyncEnabled: false;
      readonly cardmarketPriceSyncEnabled: false;
    })
  | (WorkerConfigBase & {
      readonly tcgdexSyncEnabled: false;
      readonly cardmarketPriceSyncEnabled: true;
      readonly databaseUrl: string;
    })
  | (WorkerConfigBase & {
      readonly tcgdexSyncEnabled: true;
      readonly cardmarketPriceSyncEnabled: false;
      readonly databaseUrl: string;
    })
  | (WorkerConfigBase & {
      readonly tcgdexSyncEnabled: true;
      readonly cardmarketPriceSyncEnabled: true;
      readonly databaseUrl: string;
    });

const configError = (key: string, message: string) => new ServiceConfigError({ key, message });

/** Integer config with a default, mapping parse failures to a keyed `ServiceConfigError`. */
const intConfig = (key: string, defaultValue: number) =>
  Config.Int(key).pipe(
    Config.withDefault(defaultValue),
    Effect.mapError((error) => configError(key, String(error))),
  );

/** Optional string config (missing → `None`), mapping parse failures to a keyed error. */
const optionalStringConfig = (key: string) =>
  Config.String(key).pipe(
    Effect.mapError((error) => configError(key, String(error))),
    Effect.option,
  );

/** Read the worker configuration from the environment (typed `ServiceConfigError` on failure). */
export const loadWorkerConfig: Effect.Effect<WorkerConfig, ServiceConfigError> = Effect.gen(
  function* () {
    const heartbeatIntervalMs = yield* intConfig(HEARTBEAT_ENV_KEY, DEFAULT_HEARTBEAT_INTERVAL_MS);
    if (heartbeatIntervalMs <= 0) {
      return yield* Effect.fail(
        configError(HEARTBEAT_ENV_KEY, `${HEARTBEAT_ENV_KEY} must be a strictly positive integer`),
      );
    }

    const databaseUrl = Option.getOrNull(yield* optionalStringConfig(DATABASE_URL_ENV_KEY))?.trim();

    const tcgdexSyncEnabled = yield* Config.Boolean(TCGDEX_SYNC_ENABLED_ENV_KEY).pipe(
      Config.withDefault(false),
      Effect.mapError((error) => configError(TCGDEX_SYNC_ENABLED_ENV_KEY, String(error))),
    );

    const tcgdexSyncIntervalMs = yield* intConfig(
      TCGDEX_SYNC_INTERVAL_MS_ENV_KEY,
      DEFAULT_TCGDEX_SYNC_INTERVAL_MS,
    );
    if (tcgdexSyncIntervalMs <= 0) {
      return yield* Effect.fail(
        configError(
          TCGDEX_SYNC_INTERVAL_MS_ENV_KEY,
          `${TCGDEX_SYNC_INTERVAL_MS_ENV_KEY} must be a strictly positive integer`,
        ),
      );
    }

    const tcgdexBaseUrl = yield* Config.String(TCGDEX_BASE_URL_ENV_KEY).pipe(
      Config.withDefault(DEFAULT_TCGDEX_BASE_URL),
      Effect.mapError((error) => configError(TCGDEX_BASE_URL_ENV_KEY, String(error))),
    );
    if (tcgdexBaseUrl.trim().length === 0) {
      return yield* Effect.fail(
        configError(TCGDEX_BASE_URL_ENV_KEY, `${TCGDEX_BASE_URL_ENV_KEY} must be a non-empty URL`),
      );
    }

    const cardmarketPriceSyncEnabled = yield* Config.Boolean(
      CARDMARKET_PRICE_SYNC_ENABLED_ENV_KEY,
    ).pipe(
      Config.withDefault(false),
      Effect.mapError((error) => configError(CARDMARKET_PRICE_SYNC_ENABLED_ENV_KEY, String(error))),
    );

    const cardmarketPriceSyncIntervalMs = yield* intConfig(
      CARDMARKET_PRICE_SYNC_INTERVAL_MS_ENV_KEY,
      DEFAULT_CARDMARKET_PRICE_SYNC_INTERVAL_MS,
    );
    if (cardmarketPriceSyncIntervalMs <= 0) {
      return yield* Effect.fail(
        configError(
          CARDMARKET_PRICE_SYNC_INTERVAL_MS_ENV_KEY,
          `${CARDMARKET_PRICE_SYNC_INTERVAL_MS_ENV_KEY} must be a strictly positive integer`,
        ),
      );
    }

    const cardmarketPriceBatchLimit = yield* intConfig(
      CARDMARKET_PRICE_BATCH_LIMIT_ENV_KEY,
      DEFAULT_CARDMARKET_PRICE_BATCH_LIMIT,
    );
    if (
      cardmarketPriceBatchLimit < CARDMARKET_PRICE_BATCH_LIMIT_RANGE.min ||
      cardmarketPriceBatchLimit > CARDMARKET_PRICE_BATCH_LIMIT_RANGE.max
    ) {
      return yield* Effect.fail(
        configError(
          CARDMARKET_PRICE_BATCH_LIMIT_ENV_KEY,
          `${CARDMARKET_PRICE_BATCH_LIMIT_ENV_KEY} must be an integer between ${CARDMARKET_PRICE_BATCH_LIMIT_RANGE.min} and ${CARDMARKET_PRICE_BATCH_LIMIT_RANGE.max}`,
        ),
      );
    }

    const normalizedDatabaseUrl =
      databaseUrl === undefined || databaseUrl.length === 0 ? null : databaseUrl;

    const requireDatabaseUrl = () =>
      Effect.fail(
        configError(
          DATABASE_URL_ENV_KEY,
          `${DATABASE_URL_ENV_KEY} is required when ${TCGDEX_SYNC_ENABLED_ENV_KEY}=true or ${CARDMARKET_PRICE_SYNC_ENABLED_ENV_KEY}=true`,
        ),
      );

    const base = {
      heartbeatIntervalMs,
      tcgdexSyncIntervalMs,
      tcgdexBaseUrl,
      cardmarketPriceSyncIntervalMs,
      cardmarketPriceBatchLimit,
    };

    if (tcgdexSyncEnabled && cardmarketPriceSyncEnabled) {
      if (normalizedDatabaseUrl === null) return yield* requireDatabaseUrl();
      return {
        ...base,
        databaseUrl: normalizedDatabaseUrl,
        tcgdexSyncEnabled: true,
        cardmarketPriceSyncEnabled: true,
      } satisfies WorkerConfig;
    }
    if (tcgdexSyncEnabled) {
      if (normalizedDatabaseUrl === null) return yield* requireDatabaseUrl();
      return {
        ...base,
        databaseUrl: normalizedDatabaseUrl,
        tcgdexSyncEnabled: true,
        cardmarketPriceSyncEnabled: false,
      } satisfies WorkerConfig;
    }
    if (cardmarketPriceSyncEnabled) {
      if (normalizedDatabaseUrl === null) return yield* requireDatabaseUrl();
      return {
        ...base,
        databaseUrl: normalizedDatabaseUrl,
        tcgdexSyncEnabled: false,
        cardmarketPriceSyncEnabled: true,
      } satisfies WorkerConfig;
    }
    return {
      ...base,
      databaseUrl: normalizedDatabaseUrl,
      tcgdexSyncEnabled: false,
      cardmarketPriceSyncEnabled: false,
    } satisfies WorkerConfig;
  },
).pipe(
  Effect.mapError((error) =>
    error instanceof ServiceConfigError
      ? error
      : new ServiceConfigError({ message: String(error) }),
  ),
);
