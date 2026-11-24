import type { CatalogSyncReport } from "@pokevault/services";
import { Cause, Effect, Ref } from "effect";

/** Signals that trigger a graceful shutdown. */
export const SHUTDOWN_SIGNALS = [
  "SIGTERM",
  "SIGINT",
] as const satisfies ReadonlyArray<NodeJS.Signals>;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Minimal subset of `process` needed to listen to termination signals (fakeable in tests). */
export interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/**
 * Completes with the first shutdown signal received.
 * Listeners are always removed, including when the effect is interrupted.
 */
export const awaitShutdownSignal = (source: SignalSource): Effect.Effect<ShutdownSignal> =>
  Effect.callback<ShutdownSignal>((resume) => {
    const listeners = new Map<ShutdownSignal, () => void>();
    const cleanup = () => {
      for (const [signal, listener] of listeners) {
        source.off(signal, listener);
      }
      listeners.clear();
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      const listener = () => {
        cleanup();
        resume(Effect.succeed(signal));
      };
      listeners.set(signal, listener);
      source.once(signal, listener);
    }
    return Effect.sync(cleanup);
  });

/**
 * Infinite heartbeat loop: logs a structured `worker.heartbeat` entry every `intervalMs`.
 * Interrupting it runs its finalizer (`worker.heartbeat.interrupted`).
 */
export const heartbeatLoop = (intervalMs: number): Effect.Effect<never> =>
  Effect.gen(function* () {
    const ticks = yield* Ref.make(0);
    return yield* Effect.forever(
      Effect.gen(function* () {
        const tick = yield* Ref.updateAndGet(ticks, (n) => n + 1);
        yield* Effect.logInfo("worker.heartbeat").pipe(Effect.annotateLogs({ tick }));
        yield* Effect.sleep(intervalMs);
      }),
    );
  }).pipe(Effect.onInterrupt(() => Effect.logInfo("worker.heartbeat.interrupted")));

/** Configuration of the daily catalog sync cron. */
export interface CatalogSyncCron {
  /** Delay between two sync runs, in milliseconds (strictly positive, default 24 h). */
  readonly intervalMs: number;
  /**
   * One catalog sync run. Its typed errors are logged (`worker.catalog_sync.failed`)
   * and never crash the worker; interruption is always propagated.
   */
  readonly run: Effect.Effect<CatalogSyncReport, unknown>;
}

/**
 * Catalog sync cron: runs `run` immediately, then every `intervalMs`. Failures are
 * logged as warnings and the loop keeps going; interrupting the loop (SIGTERM/SIGINT
 * shutdown) stops it and logs `worker.catalog_sync.interrupted`.
 */
export const catalogSyncLoop = (cron: CatalogSyncCron): Effect.Effect<never, unknown> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.logInfo("worker.catalog_sync.started");
      yield* cron.run.pipe(
        Effect.tap((report) =>
          Effect.logInfo("worker.catalog_sync.completed").pipe(
            Effect.annotateLogs({
              seriesCount: report.seriesCount,
              setsCount: report.setsCount,
              cardsCount: report.cardsCount,
              failedCards: report.failedCards,
              failedSets: report.failedSets.length,
              durationMs: report.durationMs,
            }),
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("worker.catalog_sync.failed", cause),
        ),
      );
      yield* Effect.sleep(cron.intervalMs);
    }),
  ).pipe(Effect.onInterrupt(() => Effect.logInfo("worker.catalog_sync.interrupted")));

export interface RunWorkerOptions {
  readonly heartbeatIntervalMs: number;
  readonly signals: SignalSource;
  /** Optional catalog sync cron, forked in a supervised fiber of the worker scope. */
  readonly catalogSync?: CatalogSyncCron | undefined;
}

/**
 * Worker main program. Runs the heartbeat (and the optional catalog sync cron, in its
 * own supervised fiber) until SIGTERM/SIGINT is received, then interrupts the loops and
 * runs the scope finalizer before completing.
 */
export const runWorker = (options: RunWorkerOptions): Effect.Effect<ShutdownSignal> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.logInfo("worker.stopped"));
      yield* Effect.logInfo("worker.started").pipe(
        Effect.annotateLogs({ heartbeatIntervalMs: options.heartbeatIntervalMs }),
      );
      if (options.catalogSync !== undefined) {
        yield* Effect.forkScoped(catalogSyncLoop(options.catalogSync));
      }
      const signal = yield* Effect.raceFirst(
        awaitShutdownSignal(options.signals),
        heartbeatLoop(options.heartbeatIntervalMs),
      );
      yield* Effect.logInfo("worker.shutdown_requested").pipe(Effect.annotateLogs({ signal }));
      return signal;
    }),
  );
