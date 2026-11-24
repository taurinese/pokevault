import { ServiceConfigError } from "@pokevault/services";
import { Config, Effect, Option } from "effect";

/** Default delay between two heartbeat ticks (30 s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default TCGdex v2 API root. */
export const DEFAULT_TCGDEX_BASE_URL = "https://api.tcgdex.net/v2";

/** Default catalog sync interval: once every 24 h. */
export const DEFAULT_TCGDEX_SYNC_INTERVAL_MS = 86_400_000;

const HEARTBEAT_ENV_KEY = "WORKER_HEARTBEAT_INTERVAL_MS";
const DATABASE_URL_ENV_KEY = "DATABASE_URL";
const TCGDEX_SYNC_ENABLED_ENV_KEY = "TCGDEX_SYNC_ENABLED";
const TCGDEX_SYNC_INTERVAL_MS_ENV_KEY = "TCGDEX_SYNC_INTERVAL_MS";
const TCGDEX_BASE_URL_ENV_KEY = "TCGDEX_BASE_URL";

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
}

export type WorkerConfig =
  | (WorkerConfigBase & { readonly tcgdexSyncEnabled: false })
  | (WorkerConfigBase & { readonly tcgdexSyncEnabled: true; readonly databaseUrl: string });

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

    const normalizedDatabaseUrl =
      databaseUrl === undefined || databaseUrl.length === 0 ? null : databaseUrl;

    if (tcgdexSyncEnabled) {
      if (normalizedDatabaseUrl === null) {
        return yield* Effect.fail(
          configError(
            DATABASE_URL_ENV_KEY,
            `${DATABASE_URL_ENV_KEY} is required when ${TCGDEX_SYNC_ENABLED_ENV_KEY}=true`,
          ),
        );
      }
      return {
        heartbeatIntervalMs,
        databaseUrl: normalizedDatabaseUrl,
        tcgdexSyncEnabled: true,
        tcgdexSyncIntervalMs,
        tcgdexBaseUrl,
      } satisfies WorkerConfig;
    }
    return {
      heartbeatIntervalMs,
      databaseUrl: normalizedDatabaseUrl,
      tcgdexSyncEnabled: false,
      tcgdexSyncIntervalMs,
      tcgdexBaseUrl,
    } satisfies WorkerConfig;
  },
).pipe(
  Effect.mapError((error) =>
    error instanceof ServiceConfigError
      ? error
      : new ServiceConfigError({ message: String(error) }),
  ),
);
