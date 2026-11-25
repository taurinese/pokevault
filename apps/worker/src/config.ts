import { isAllowedDiscordWebhookUrl } from "@pokevault/domain";
import {
  DEFAULT_TCGDEX_BASE_URL,
  ServiceConfigError,
  signVapidJwt,
  type VapidConfig,
} from "@pokevault/services";
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

/** Default alert evaluation interval: every 15 min (TTL of price snapshots). */
export const DEFAULT_ALERT_EVAL_INTERVAL_MS = 15 * 60 * 1000;

/** Default public URL of the app (links of the notifications) when `APP_URL`/`SITE_URL` are unset. */
export const DEFAULT_APP_URL = "http://localhost:3000";

const HEARTBEAT_ENV_KEY = "WORKER_HEARTBEAT_INTERVAL_MS";
const DATABASE_URL_ENV_KEY = "DATABASE_URL";
const TCGDEX_SYNC_ENABLED_ENV_KEY = "TCGDEX_SYNC_ENABLED";
const TCGDEX_SYNC_INTERVAL_MS_ENV_KEY = "TCGDEX_SYNC_INTERVAL_MS";
const TCGDEX_BASE_URL_ENV_KEY = "TCGDEX_BASE_URL";
const CARDMARKET_PRICE_SYNC_ENABLED_ENV_KEY = "CARDMARKET_PRICE_SYNC_ENABLED";
const CARDMARKET_PRICE_SYNC_INTERVAL_MS_ENV_KEY = "CARDMARKET_PRICE_SYNC_INTERVAL_MS";
const CARDMARKET_PRICE_BATCH_LIMIT_ENV_KEY = "CARDMARKET_PRICE_BATCH_LIMIT";
const ALERT_EVAL_ENABLED_ENV_KEY = "ALERT_EVAL_ENABLED";
const ALERT_EVAL_INTERVAL_MS_ENV_KEY = "ALERT_EVAL_INTERVAL_MS";
const VAPID_PUBLIC_KEY_ENV_KEY = "VAPID_PUBLIC_KEY";
const VAPID_PRIVATE_KEY_ENV_KEY = "VAPID_PRIVATE_KEY";
const VAPID_SUBJECT_ENV_KEY = "VAPID_SUBJECT";
const DISCORD_DEFAULT_WEBHOOK_URL_ENV_KEY = "DISCORD_DEFAULT_WEBHOOK_URL";
const DISCORD_BOT_TOKEN_ENV_KEY = "DISCORD_BOT_TOKEN";
const APP_URL_ENV_KEY = "APP_URL";
const SITE_URL_ENV_KEY = "SITE_URL";

/** Settings of the alert evaluation cron; only present when `ALERT_EVAL_ENABLED=true`. */
export interface AlertEvalSettings {
  /** Postgres connection string (service role), required by the cron. */
  readonly databaseUrl: string;
  /** Public URL of the app (links of the push / Discord notifications), without trailing slash. */
  readonly appUrl: string;
  /** VAPID key pair; `null` disables Web Push (every push delivery fails with a typed error). */
  readonly vapid: VapidConfig | null;
  /** Discord bot token enabling DMs, or `null`. */
  readonly discordBotToken: string | null;
  /** Instance-wide Discord webhook (validated against the SSRF guard), or `null`. */
  readonly defaultDiscordWebhookUrl: string | null;
}

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
  /** Delay between two alert evaluation runs, in milliseconds (strictly positive). */
  readonly alertEvalIntervalMs: number;
  /**
   * Alert evaluation + notifications cron (default disabled: `ALERT_EVAL_ENABLED=false`).
   * `null` when disabled.
   */
  readonly alertEval: AlertEvalSettings | null;
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

/** Optional trimmed string config (missing or blank → `null`). */
const optionalTrimmedConfig = (key: string) =>
  Effect.map(optionalStringConfig(key), (value) => {
    const trimmed = Option.getOrNull(value)?.trim();
    return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
  });

/**
 * Reads the alert evaluation settings (only called when `ALERT_EVAL_ENABLED=true`):
 * `DATABASE_URL` is mandatory, the VAPID triplet is all-or-nothing and cryptographically
 * validated, the default Discord webhook must pass the SSRF guard. Secrets/URLs are never
 * echoed in error messages.
 */
const loadAlertEvalSettings = (databaseUrl: string | null) =>
  Effect.gen(function* () {
    if (databaseUrl === null) {
      return yield* Effect.fail(
        configError(
          DATABASE_URL_ENV_KEY,
          `${DATABASE_URL_ENV_KEY} is required when ${ALERT_EVAL_ENABLED_ENV_KEY}=true`,
        ),
      );
    }

    const publicKey = yield* optionalTrimmedConfig(VAPID_PUBLIC_KEY_ENV_KEY);
    const privateKey = yield* optionalTrimmedConfig(VAPID_PRIVATE_KEY_ENV_KEY);
    const subject = yield* optionalTrimmedConfig(VAPID_SUBJECT_ENV_KEY);
    let vapid: VapidConfig | null = null;
    if (publicKey !== null || privateKey !== null || subject !== null) {
      if (publicKey === null || privateKey === null || subject === null) {
        const missingKey =
          publicKey === null
            ? VAPID_PUBLIC_KEY_ENV_KEY
            : privateKey === null
              ? VAPID_PRIVATE_KEY_ENV_KEY
              : VAPID_SUBJECT_ENV_KEY;
        return yield* Effect.fail(
          configError(
            missingKey,
            `${VAPID_PUBLIC_KEY_ENV_KEY}, ${VAPID_PRIVATE_KEY_ENV_KEY} and ${VAPID_SUBJECT_ENV_KEY} must all be set together`,
          ),
        );
      }
      if (!/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
        return yield* Effect.fail(
          configError(
            VAPID_SUBJECT_ENV_KEY,
            `${VAPID_SUBJECT_ENV_KEY} must be a mailto: or https: URL`,
          ),
        );
      }
      const candidate: VapidConfig = { publicKey, privateKey, subject };
      try {
        signVapidJwt(candidate, "https://push.example", 0);
      } catch {
        return yield* Effect.fail(
          configError(
            VAPID_PRIVATE_KEY_ENV_KEY,
            `${VAPID_PUBLIC_KEY_ENV_KEY}/${VAPID_PRIVATE_KEY_ENV_KEY} are not a valid base64url P-256 VAPID key pair`,
          ),
        );
      }
      vapid = candidate;
    }

    const defaultDiscordWebhookUrl = yield* optionalTrimmedConfig(
      DISCORD_DEFAULT_WEBHOOK_URL_ENV_KEY,
    );
    if (
      defaultDiscordWebhookUrl !== null &&
      !isAllowedDiscordWebhookUrl(defaultDiscordWebhookUrl)
    ) {
      return yield* Effect.fail(
        configError(
          DISCORD_DEFAULT_WEBHOOK_URL_ENV_KEY,
          `${DISCORD_DEFAULT_WEBHOOK_URL_ENV_KEY} must be a https://discord.com/api/webhooks/<id>/<token> URL`,
        ),
      );
    }

    const discordBotToken = yield* optionalTrimmedConfig(DISCORD_BOT_TOKEN_ENV_KEY);

    const appUrlRaw =
      (yield* optionalTrimmedConfig(APP_URL_ENV_KEY)) ??
      (yield* optionalTrimmedConfig(SITE_URL_ENV_KEY)) ??
      DEFAULT_APP_URL;
    if (!/^https?:\/\/[^\s/]+/i.test(appUrlRaw)) {
      return yield* Effect.fail(
        configError(
          APP_URL_ENV_KEY,
          `${APP_URL_ENV_KEY} (or ${SITE_URL_ENV_KEY}) must be an absolute http(s) URL`,
        ),
      );
    }

    return {
      databaseUrl,
      appUrl: appUrlRaw.replace(/\/+$/, ""),
      vapid,
      discordBotToken,
      defaultDiscordWebhookUrl,
    } satisfies AlertEvalSettings;
  });

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

    const alertEvalEnabled = yield* Config.Boolean(ALERT_EVAL_ENABLED_ENV_KEY).pipe(
      Config.withDefault(false),
      Effect.mapError((error) => configError(ALERT_EVAL_ENABLED_ENV_KEY, String(error))),
    );

    const alertEvalIntervalMs = yield* intConfig(
      ALERT_EVAL_INTERVAL_MS_ENV_KEY,
      DEFAULT_ALERT_EVAL_INTERVAL_MS,
    );
    if (alertEvalIntervalMs <= 0) {
      return yield* Effect.fail(
        configError(
          ALERT_EVAL_INTERVAL_MS_ENV_KEY,
          `${ALERT_EVAL_INTERVAL_MS_ENV_KEY} must be a strictly positive integer`,
        ),
      );
    }

    const normalizedDatabaseUrl =
      databaseUrl === undefined || databaseUrl.length === 0 ? null : databaseUrl;

    const alertEval = alertEvalEnabled ? yield* loadAlertEvalSettings(normalizedDatabaseUrl) : null;

    const requireDatabaseUrl = () =>
      Effect.fail(
        configError(
          DATABASE_URL_ENV_KEY,
          `${DATABASE_URL_ENV_KEY} is required when ${TCGDEX_SYNC_ENABLED_ENV_KEY}=true, ${CARDMARKET_PRICE_SYNC_ENABLED_ENV_KEY}=true or ${ALERT_EVAL_ENABLED_ENV_KEY}=true`,
        ),
      );

    const base = {
      heartbeatIntervalMs,
      tcgdexSyncIntervalMs,
      tcgdexBaseUrl,
      cardmarketPriceSyncIntervalMs,
      cardmarketPriceBatchLimit,
      alertEvalIntervalMs,
      alertEval,
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
