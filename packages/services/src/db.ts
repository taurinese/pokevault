import { Context, Data, Effect, Layer } from "effect";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Any Postgres failure raised by the worker (connection, constraint, SQL). */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Database service (postgres.js — pure JS, safe to bundle with Rolldown)
// ---------------------------------------------------------------------------

/** Tagged-template SQL client of `postgres` (https://github.com/porsager/postgres). */
export type Sql = postgres.Sql<Record<string, never>>;

export interface DatabaseShape {
  readonly sql: Sql;
}

/** Effect-TS service key of the Postgres connection pool. */
export class Database extends Context.Service<Database, DatabaseShape>()(
  "@pokevault/services/Database",
) {}

export interface DatabaseLiveOptions {
  /** e.g. `postgres://postgres:pass@postgres:5432/postgres?sslmode=disable`. */
  readonly connectionString: string;
  /** Pool size (default 10). */
  readonly maxConnections?: number | undefined;
}

/**
 * Live {@link Database} layer backed by a `postgres` pool. The pool is created
 * with `Effect.acquireRelease` and closed (`sql.end()`) when the scope in
 * which the layer is built closes (worker shutdown / CLI exit).
 */
export const DatabaseLive = (options: DatabaseLiveOptions): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.sync(() =>
        postgres(options.connectionString, {
          max: options.maxConnections ?? 10,
          idle_timeout: 20,
          connect_timeout: 10,
        }),
      ),
      (sql) => Effect.promise(() => sql.end({ timeout: 5 })),
    ).pipe(Effect.map((sql) => ({ sql }))),
  );

/**
 * Runs a query against the injected {@link Database} and maps any failure to a
 * typed {@link DatabaseError}.
 */
export const runQuery = <A>(
  query: (sql: Sql) => Promise<A>,
): Effect.Effect<A, DatabaseError, Database> =>
  Effect.flatMap(Database, (db) =>
    Effect.tryPromise({
      try: () => query(db.sql),
      catch: (cause) => new DatabaseError({ message: "postgres query failed", cause }),
    }),
  );
