import { Effect, Logger } from "effect";
import { loadWorkerConfig } from "./config.ts";
import { runWorker } from "./runtime.ts";

const main = Effect.gen(function* () {
  const config = yield* loadWorkerConfig;
  yield* runWorker({ heartbeatIntervalMs: config.heartbeatIntervalMs, signals: process });
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
  Effect.provide(Logger.layer([Logger.consoleJson], { mergeWithExisting: false })),
);

Effect.runFork(main);
