import { EventEmitter } from "node:events";
import { type CatalogSyncReport, ServiceConfigError } from "@pokevault/services";
import { ConfigProvider, Effect, Fiber, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.ts";
import { awaitShutdownSignal, catalogSyncLoop, runWorker, SHUTDOWN_SIGNALS } from "./runtime.ts";
import { parseSyncCatalogArgs, SYNC_CATALOG_FLAG } from "./sync-catalog.ts";

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

  it("runs the catalog sync cron immediately then on each interval, and stops on SIGTERM", async () => {
    const emitter = new EventEmitter();
    const capture = makeCapture();
    const runs: Array<number> = [];
    const report: CatalogSyncReport = {
      seriesCount: 19,
      setsCount: 203,
      cardsCount: 20_000,
      failedSets: [],
      durationMs: 42,
    };
    const run = Effect.sync(() => {
      runs.push(runs.length + 1);
      return report;
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runWorker({
          heartbeatIntervalMs: 60_000,
          signals: emitter,
          catalogSync: { intervalMs: 1_000, run },
        }),
      );
      yield* TestClock.adjust(2_500); // sync runs at t=0, 1s, 2s
      emitter.emit("SIGTERM");
      return yield* Fiber.join(fiber);
    });

    const signal = await Effect.runPromise(withTestRuntime(program, capture.layer));

    expect(signal).toBe("SIGTERM");
    expect(runs).toEqual([1, 2, 3]); // immediate run + 2 interval ticks within 2.5 s
    const messages = capture.entries.map((entry) => entry.message);
    expect(messages).toContain("worker.catalog_sync.started");
    expect(messages).toContain("worker.catalog_sync.completed");
    expect(messages).toContain("worker.catalog_sync.interrupted");
    expect(messages.filter((message) => message === "worker.catalog_sync.started")).toHaveLength(3);
    expect(messages.at(-1)).toBe("worker.stopped");
    expect(listenerCount(emitter)).toBe(0);
  });

  it("logs catalog sync failures without crashing the worker, then keeps the cron alive", async () => {
    const emitter = new EventEmitter();
    const capture = makeCapture();
    let attempts = 0;
    const report: CatalogSyncReport = {
      seriesCount: 1,
      setsCount: 1,
      cardsCount: 2,
      failedSets: ["sv08"],
      durationMs: 7,
    };
    const run = Effect.suspend((): Effect.Effect<CatalogSyncReport, Error> => {
      attempts += 1;
      return attempts === 1 ? Effect.fail(new Error("boom")) : Effect.succeed(report);
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runWorker({
          heartbeatIntervalMs: 60_000,
          signals: emitter,
          catalogSync: { intervalMs: 1_000, run },
        }),
      );
      yield* TestClock.adjust(2_100); // 3 runs: fail, ok, ok
      emitter.emit("SIGINT");
      return yield* Fiber.join(fiber);
    });

    const signal = await Effect.runPromise(withTestRuntime(program, capture.layer));

    expect(signal).toBe("SIGINT");
    expect(attempts).toBe(3);
    const messages = capture.entries.map((entry) => entry.message);
    expect(messages).toContain("worker.catalog_sync.failed");
    expect(messages.filter((message) => message === "worker.catalog_sync.completed")).toHaveLength(
      2,
    );
    expect(messages.at(-1)).toBe("worker.stopped");
  });
});

describe("catalogSyncLoop", () => {
  it("interrupting the loop logs worker.catalog_sync.interrupted and stops scheduling", async () => {
    const capture = makeCapture();
    let runs = 0;
    const run = Effect.sync(() => {
      runs += 1;
      return {
        seriesCount: 0,
        setsCount: 0,
        cardsCount: 0,
        failedSets: [],
        durationMs: 0,
      } satisfies CatalogSyncReport;
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(catalogSyncLoop({ intervalMs: 1_000, run }));
      yield* TestClock.adjust(500); // first run only (interval not reached yet)
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(5_000); // no further run after interruption
    });

    await Effect.runPromise(withTestRuntime(program, capture.layer));
    expect(runs).toBe(1);
    expect(capture.entries.map((entry) => entry.message)).toContain(
      "worker.catalog_sync.interrupted",
    );
  });
});

describe("parseSyncCatalogArgs", () => {
  it("parses --set filters, --base-url and ignores the sync flag itself", () => {
    expect(
      parseSyncCatalogArgs([
        SYNC_CATALOG_FLAG,
        "--set=sv03.5",
        "--set=sv08",
        "--base-url=https://api.tcgdex.net/v2",
      ]),
    ).toEqual({ setIds: ["sv03.5", "sv08"], baseUrl: "https://api.tcgdex.net/v2" });
    expect(parseSyncCatalogArgs([SYNC_CATALOG_FLAG])).toEqual({ setIds: [], baseUrl: null });
    expect(parseSyncCatalogArgs(["--set=", "--base-url="])).toEqual({ setIds: [], baseUrl: null });
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

  it("defaults the catalog sync settings (disabled, 24 h interval, default base URL, no DATABASE_URL)", async () => {
    const config = await Effect.runPromise(
      loadWorkerConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
    );
    expect(config.tcgdexSyncEnabled).toBe(false);
    expect(config.databaseUrl).toBeNull();
    expect(config.tcgdexSyncIntervalMs).toBe(86_400_000);
    expect(config.tcgdexBaseUrl).toBe("https://api.tcgdex.net/v2");
  });

  it("enables the catalog sync when TCGDEX_SYNC_ENABLED=true and DATABASE_URL is set", async () => {
    const config = await Effect.runPromise(
      loadWorkerConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                DATABASE_URL: "postgres://postgres:pass@postgres:5432/postgres?sslmode=disable",
                TCGDEX_SYNC_ENABLED: "true",
                TCGDEX_SYNC_INTERVAL_MS: "3600000",
                TCGDEX_BASE_URL: "https://api.tcgdex.net/v2",
              },
            }),
          ),
        ),
      ),
    );
    expect(config.tcgdexSyncEnabled).toBe(true);
    expect(config.databaseUrl).toBe(
      "postgres://postgres:pass@postgres:5432/postgres?sslmode=disable",
    );
    expect(config.tcgdexSyncIntervalMs).toBe(3_600_000);
  });

  it("fails with ServiceConfigError when TCGDEX_SYNC_ENABLED=true but DATABASE_URL is missing", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadWorkerConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TCGDEX_SYNC_ENABLED: "1" } })),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ServiceConfigError);
    expect(error._tag).toBe("ServiceConfigError");
    expect(error.key).toBe("DATABASE_URL");
  });

  it.each(["0", "-60000", "abc"])(
    "fails with ServiceConfigError for invalid TCGDEX_SYNC_INTERVAL_MS=%s",
    async (raw) => {
      const error = await Effect.runPromise(
        Effect.flip(
          loadWorkerConfig.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { TCGDEX_SYNC_INTERVAL_MS: raw } }),
              ),
            ),
          ),
        ),
      );
      expect(error).toBeInstanceOf(ServiceConfigError);
      expect(error.key).toBe("TCGDEX_SYNC_INTERVAL_MS");
    },
  );

  it("rejects an empty TCGDEX_BASE_URL", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadWorkerConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TCGDEX_BASE_URL: "   " } })),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ServiceConfigError);
    expect(error.key).toBe("TCGDEX_BASE_URL");
  });
});
