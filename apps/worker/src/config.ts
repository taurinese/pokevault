import { ServiceConfigError } from "@pokevault/services";
import { Config, Effect } from "effect";

/** Default delay between two heartbeat ticks (30 s). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface WorkerConfig {
  /** Delay between two heartbeat ticks, in milliseconds (strictly positive). */
  readonly heartbeatIntervalMs: number;
}

const HEARTBEAT_ENV_KEY = "WORKER_HEARTBEAT_INTERVAL_MS";

/** Read the worker configuration from the environment (typed `ServiceConfigError` on failure). */
export const loadWorkerConfig: Effect.Effect<WorkerConfig, ServiceConfigError> = Effect.gen(
  function* () {
    const heartbeatIntervalMs = yield* Config.Int(HEARTBEAT_ENV_KEY).pipe(
      Config.withDefault(DEFAULT_HEARTBEAT_INTERVAL_MS),
    );
    if (heartbeatIntervalMs <= 0) {
      return yield* Effect.fail(
        new ServiceConfigError({
          key: HEARTBEAT_ENV_KEY,
          message: `${HEARTBEAT_ENV_KEY} must be a strictly positive integer`,
        }),
      );
    }
    return { heartbeatIntervalMs } satisfies WorkerConfig;
  },
).pipe(
  Effect.mapError((error) =>
    error instanceof ServiceConfigError
      ? error
      : new ServiceConfigError({ key: HEARTBEAT_ENV_KEY, message: String(error) }),
  ),
);
