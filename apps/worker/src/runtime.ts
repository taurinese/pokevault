import { Effect, Ref } from "effect";

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

export interface RunWorkerOptions {
  readonly heartbeatIntervalMs: number;
  readonly signals: SignalSource;
}

/**
 * Worker main program. Runs the heartbeat until SIGTERM/SIGINT is received, then
 * interrupts the loop and runs the scope finalizer before completing.
 */
export const runWorker = (options: RunWorkerOptions): Effect.Effect<ShutdownSignal> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.logInfo("worker.stopped"));
      yield* Effect.logInfo("worker.started").pipe(
        Effect.annotateLogs({ heartbeatIntervalMs: options.heartbeatIntervalMs }),
      );
      const signal = yield* Effect.raceFirst(
        awaitShutdownSignal(options.signals),
        heartbeatLoop(options.heartbeatIntervalMs),
      );
      yield* Effect.logInfo("worker.shutdown_requested").pipe(Effect.annotateLogs({ signal }));
      return signal;
    }),
  );
