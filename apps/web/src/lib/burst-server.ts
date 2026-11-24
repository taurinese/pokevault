/**
 * Accès serveur au lot de saisie rafale (écran `08A` · configuration, étape 1
 * sur 2) : handlers `Request → Response` des routes `/api/burst/*`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par les routes
 * `routes/api/burst/*` (handlers `server`, retirés du bundle client) — jamais
 * par un composant ou un module client.
 *
 * Toutes les routes exigent une session SSR valide (`getServerSession`, 401
 * sinon) ; les cookies rafraîchis par la session sont propagés via `Set-Cookie`.
 * Les routes POST exigent en plus une requête same-origin (`isRequestSameOrigin`,
 * 403 sinon — CSRF). Réf. : docs/01 §6, docs/06, ADR-006.
 */

import {
  BurstImportService,
  BurstImportServiceLive,
  type BurstImportServiceShape,
  Database,
  DatabaseError,
  DatabaseLive,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import type { BurstSetOption } from "./burst-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type BurstLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** Service des extensions du catalogue : requête SQL `catalog_sets × catalog_series`. */
export type ListBurstSets = () => Effect.Effect<ReadonlyArray<BurstSetOption>, DatabaseError>;

/** Bundle de services serveur de la saisie rafale. */
export interface BurstServiceBundle {
  readonly importService: BurstImportServiceShape;
  readonly listSets: ListBurstSets;
}

export interface BurstServerDeps {
  readonly auth: AuthDeps;
  /**
   * Services serveur, ou `null` quand aucune base n'est configurée
   * (`DATABASE_URL` absent en dev/test) : `sets` répond alors un payload vide,
   * `preview` / `commit` une 503 — jamais une 500 inattendue.
   */
  readonly service: BurstServiceBundle | null;
  readonly log: BurstLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: BurstLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<BurstImportService | Database, never>;
  readonly bundle: Promise<BurstServiceBundle>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultBurstRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

/** Ligne brute renvoyée par Postgres (dates `date` → `Date` via postgres.js). */
interface BurstSetRawRow {
  readonly id: string;
  readonly code: string | null;
  readonly name_fr: string;
  readonly series_name_fr: string;
  readonly logo_url: string | null;
  readonly official_count: number;
  readonly total_count: number;
  readonly release_date: string | Date | null;
}

/** Requête SQL des extensions disponibles (jointure série, tri demandé). */
const listSetsQuery = (): Effect.Effect<ReadonlyArray<BurstSetOption>, DatabaseError, Database> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = (yield* Effect.tryPromise({
      try: () =>
        db.sql`
          SELECT s.id, s.code, s.name_fr, se.name_fr AS series_name_fr, s.logo_url,
                 s.official_count, s.total_count, s.release_date
          FROM catalog_sets s
          JOIN catalog_series se ON se.id = s.series_id
          ORDER BY s.release_date DESC NULLS LAST, s.name_fr ASC
        `,
      catch: (error) => new DatabaseError({ message: "burst sets query failed", cause: error }),
    })) as unknown as ReadonlyArray<BurstSetRawRow>;
    return rows.map(
      (row): BurstSetOption => ({
        id: row.id,
        code: row.code,
        nameFr: row.name_fr,
        seriesNameFr: row.series_name_fr,
        logoUrl: row.logo_url,
        officialCount: row.official_count,
        totalCount: row.total_count,
        releaseDate:
          row.release_date === null
            ? null
            : row.release_date instanceof Date
              ? row.release_date.toISOString().slice(0, 10)
              : row.release_date,
      }),
    );
  });

/**
 * Services Postgres (pool `postgres.js` paresseux, rôle `authenticated` à
 * moindre privilège : RLS + lecture seule du catalogue). Mis en cache sur
 * `globalThis` pour survivre au HMR Vite sans fuiter de pools ; une promesse
 * rejetée est immédiatement purgée du cache.
 */
const getLiveBundle = (databaseUrl: string): Promise<BurstServiceBundle> => {
  const existing = readCachedRuntime();
  if (existing !== undefined && existing.url === databaseUrl) {
    return existing.bundle;
  }
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const databaseLayer = DatabaseLive({
    connectionString: databaseUrl,
    maxConnections: 5,
    role: "authenticated",
  });
  const layer = Layer.merge(
    BurstImportServiceLive.pipe(Layer.provide(databaseLayer)),
    databaseLayer,
  );
  const runtime = ManagedRuntime.make(layer);
  const bundle = runtime
    .runPromise(
      Effect.gen(function* () {
        const importService = yield* BurstImportService;
        // La requête `listSetsQuery` exige le service `Database` : le runtime
        // live le fournit, l'effet exposé aux handlers n'a plus aucune exigence.
        const listSets = (): Effect.Effect<ReadonlyArray<BurstSetOption>, DatabaseError> =>
          Effect.mapError(
            Effect.tryPromise(() => runtime.runPromise(listSetsQuery())),
            (error) =>
              error instanceof DatabaseError
                ? error
                : new DatabaseError({ message: "burst sets query failed", cause: error }),
          );
        return { importService, listSets };
      }),
    )
    .catch((error: unknown) => {
      if (readCachedRuntime()?.runtime === runtime) writeCachedRuntime(undefined);
      void runtime.dispose();
      throw error;
    });
  writeCachedRuntime({ url: databaseUrl, runtime, bundle });
  return bundle;
};

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`). */
export const defaultBurstDeps = async (): Promise<BurstServerDeps> => {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth: defaultAuthDeps(),
    service:
      databaseUrl === undefined || databaseUrl === "" ? null : await getLiveBundle(databaseUrl),
    log: logWarning,
  };
};

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

const json = (body: unknown, status: number, cookies: ReadonlyArray<string> = []): Response => {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
};

const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

const forbidden = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "cross_origin" }, 403, cookies);

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "burst_unavailable" }, 503, cookies);

const warnNoDatabase = (deps: BurstServerDeps, operation: string): void =>
  deps.log("burst.database_url_missing", {
    operation,
    hint: "DATABASE_URL is not set: serving a degraded payload",
  });

/** Tag de l'erreur typée d'un `Exit` échoué (`undefined` pour un défaut). */
const failureTagOf = (cause: Cause.Cause<unknown>): string | undefined => {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag !== "Some") return undefined;
  const value = failure.value as Record<string, unknown> | null;
  return typeof value?.["_tag"] === "string" ? value["_tag"] : undefined;
};

const failureValueOf = (cause: Cause.Cause<unknown>): Record<string, unknown> | null => {
  const failure = Cause.findErrorOption(cause);
  return failure._tag === "Some" ? (failure.value as Record<string, unknown>) : null;
};

/** Mappage des erreurs typées du service vers les réponses HTTP (jamais de fuite SQL). */
const errorResponse = (cause: Cause.Cause<unknown>, cookies: ReadonlyArray<string>): Response => {
  const tag = failureTagOf(cause);
  switch (tag) {
    case "ValidationError":
    case "BurstImportEmptyBatchError":
      return json({ error: "invalid_batch" }, 400, cookies);
    case "BurstImportCardNotFoundError": {
      const value = failureValueOf(cause);
      return json(
        {
          error: "cards_not_found",
          ...(Array.isArray(value?.["missingCardIds"])
            ? { missingCardIds: value["missingCardIds"] }
            : {}),
        },
        404,
        cookies,
      );
    }
    case "BurstImportQuantityOverflowError": {
      const value = failureValueOf(cause);
      return json(
        {
          error: "quantity_overflow",
          ...(typeof value?.["cardId"] === "string" ? { cardId: value["cardId"] } : {}),
          ...(typeof value?.["maxQuantity"] === "number"
            ? { maxQuantity: value["maxQuantity"] }
            : {}),
        },
        409,
        cookies,
      );
    }
    case "DatabaseError":
      return unavailable(cookies);
    default:
      // Défaut inattendu (die) : journalisé, statut 500 générique.
      return json({ error: "burst_unavailable" }, 500, cookies);
  }
};

/** Exécute une opération du service ; journalise tout échec sans rien fuiter. */
const runLogged = <A, E>(
  deps: BurstServerDeps,
  operation: string,
  effect: Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (!Exit.isSuccess(exit)) {
      deps.log("burst.operation_failed", { operation, errorTag: failureTagOf(exit.cause) });
    }
    return exit;
  });

// ---------------------------------------------------------------------------
// GET /api/burst/sets
// ---------------------------------------------------------------------------

export const handleListBurstSets = async (
  request: Request,
  deps: BurstServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  if (deps.service === null) {
    warnNoDatabase(deps, "sets");
    return json({ sets: [], warning: "database_not_configured" }, 200, cookies);
  }
  const exit = await runLogged(deps, "sets", deps.service.listSets());
  return Exit.isSuccess(exit) ? json({ sets: exit.value }, 200, cookies) : unavailable(cookies);
};

// ---------------------------------------------------------------------------
// POST /api/burst/preview · POST /api/burst/commit
// ---------------------------------------------------------------------------

type BurstBatchMode = "preview" | "commit";

const handleBurstBatch = async (
  request: Request,
  deps: BurstServerDeps,
  mode: BurstBatchMode,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return forbidden(cookies);
  }
  if (deps.service === null) {
    warnNoDatabase(deps, mode);
    return unavailable(cookies);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, cookies);
  }

  const effect =
    mode === "preview"
      ? deps.service.importService.previewBatch(session.user.id, body)
      : deps.service.importService.commitBatch(session.user.id, body);
  const exit = await runLogged(deps, mode, effect);
  return Exit.isSuccess(exit) ? json(exit.value, 200, cookies) : errorResponse(exit.cause, cookies);
};

export const handlePreviewBurstImport = (
  request: Request,
  deps: BurstServerDeps,
): Promise<Response> => handleBurstBatch(request, deps, "preview");

export const handleCommitBurstImport = (
  request: Request,
  deps: BurstServerDeps,
): Promise<Response> => handleBurstBatch(request, deps, "commit");
