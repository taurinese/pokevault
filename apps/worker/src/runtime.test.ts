import { EventEmitter } from "node:events";
import { ServiceConfigError } from "@pokevault/services";
import { ConfigProvider, Effect, Fiber, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.ts";
import { awaitShutdownSignal, runWorker, SHUTDOWN_SIGNALS } from "./runtime.ts";

interface Captured {
  readonly message: string;
  readonly tick: unknown;
}

const makeCapture = () => {
  const entries: Array<Captured> = [];
  const logger = Logger.make<unknown, void>((options) => {
    const message = Array.isArray(options.message) ? options.message[0] : options.message;
    const { tick } = options.fiber.getRef(References.CurrentLogAnnotations);
    entries.push({
      message: String(message),
      tick,
    });
  });
  return { entries, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const withTestRuntime = <A, E>(program: Effect.Effect<A, E>, logs: Layer.Layer<never>) =>
  program.pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), logs)));

const listenerCount = (emitter: EventEmitter) =>
  SHUTDOWN_SIGNALS.reduce((count, signal) => count + emitter.listenerCount(signal), 0);

describe("awaitShutdownSignal", () => {
  it.each(SHUTDOWN_SIGNALS)("resolves on %s and removes every listener", async (signal) => {
    const emitter = new EventEmitter();
    const fiber = Effect.runFork(awaitShutdownSignal(emitter));
    await Promise.resolve();
    expect(listenerCount(emitter)).toBe(SHUTDOWN_SIGNALS.length);

    emitter.emit(signal);
    expect(await Effect.runPromise(Fiber.join(fiber))).toBe(signal);
    expect(listenerCount(emitter)).toBe(0);
  });

  it("removes listeners when interrupted", async () => {
    const emitter = new EventEmitter();
    const fiber = Effect.runFork(awaitShutdownSignal(emitter));
    await Promise.resolve();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(listenerCount(emitter)).toBe(0);
  });
});

describe("runWorker", () => {
  it("emits heartbeats then stops gracefully on SIGTERM", async () => {
    const emitter = new EventEmitter();
    const capture = makeCapture();

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runWorker({ heartbeatIntervalMs: 1_000, signals: emitter }),
      );
      yield* TestClock.adjust(2_500);
      emitter.emit("SIGTERM");
      return yield* Fiber.join(fiber);
    });

    const signal = await Effect.runPromise(withTestRuntime(program, capture.layer));

    expect(signal).toBe("SIGTERM");
    expect(capture.entries.map((entry) => entry.message)).toEqual([
      "worker.started",
      "worker.heartbeat",
      "worker.heartbeat",
      "worker.heartbeat",
      "worker.heartbeat.interrupted",
      "worker.shutdown_requested",
      "worker.stopped",
    ]);
    expect(
      capture.entries.filter((e) => e.message === "worker.heartbeat").map((e) => e.tick),
    ).toEqual([1, 2, 3]);
    expect(listenerCount(emitter)).toBe(0);
  });

  it("stops gracefully on SIGINT", async () => {
    const emitter = new EventEmitter();
    const capture = makeCapture();

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runWorker({ heartbeatIntervalMs: 1_000, signals: emitter }),
      );
      yield* TestClock.adjust(10);
      emitter.emit("SIGINT");
      return yield* Fiber.join(fiber);
    });

    expect(await Effect.runPromise(withTestRuntime(program, capture.layer))).toBe("SIGINT");
    expect(capture.entries.at(-1)?.message).toBe("worker.stopped");
  });

  it("runs the finalizer when the worker itself is interrupted", async () => {
    const emitter = new EventEmitter();
    const capture = makeCapture();

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runWorker({ heartbeatIntervalMs: 1_000, signals: emitter }),
      );
      yield* TestClock.adjust(10);
      yield* Fiber.interrupt(fiber);
    });

    await Effect.runPromise(withTestRuntime(program, capture.layer));
    expect(capture.entries.at(-1)?.message).toBe("worker.stopped");
    expect(listenerCount(emitter)).toBe(0);
  });
});

describe("loadWorkerConfig", () => {
  it("defaults the heartbeat interval to 30 seconds", async () => {
    const config = await Effect.runPromise(
      loadWorkerConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
    );
    expect(config.heartbeatIntervalMs).toBe(30_000);
  });

  it("parses a custom positive integer heartbeat interval", async () => {
    const config = await Effect.runPromise(
      loadWorkerConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { WORKER_HEARTBEAT_INTERVAL_MS: "5000" } }),
          ),
        ),
      ),
    );
    expect(config.heartbeatIntervalMs).toBe(5_000);
  });

  it.each(["0", "-100", "abc"])(
    "fails with ServiceConfigError for invalid interval %s",
    async (raw) => {
      const error = await Effect.runPromise(
        Effect.flip(
          loadWorkerConfig.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { WORKER_HEARTBEAT_INTERVAL_MS: raw } }),
              ),
            ),
          ),
        ),
      );
      expect(error).toBeInstanceOf(ServiceConfigError);
      expect(error._tag).toBe("ServiceConfigError");
      expect(error.key).toBe("WORKER_HEARTBEAT_INTERVAL_MS");
    },
  );
});
