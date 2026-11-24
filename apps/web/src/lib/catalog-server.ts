/**
 * Accès serveur au catalogue (écrans `05A–05D` · Recherche) : handlers
 * `Request → Response` des routes `/api/catalog/*`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par les routes
 * `routes/api/catalog/*` (handlers `server`, retirés du bundle client) — jamais
 * par un composant ou un module client.
 *
 * Toutes les routes exigent une session SSR valide (`getServerSession`, 401
 * sinon) ; les cookies rafraîchis par la session sont propagés via `Set-Cookie`.
 * Réf. : docs/01 §7, docs/03, docs/06.
 */

import {
  emptyDiscoveryPayload,
  emptyResultsPayload,
  emptySuggestionsPayload,
  type SearchDiscoveryPayload,
  SearchQuery,
  type SearchResultsPayload,
  type SearchSuggestionsPayload,
} from "@pokevault/domain";
import {
  CatalogSearchService,
  CatalogSearchServiceLive,
  type CatalogSearchServiceShape,
  DatabaseLive,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type CatalogLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface CatalogServerDeps {
  readonly auth: AuthDeps;
  /**
   * Service de recherche, ou `null` quand aucune base n'est configurée
   * (`DATABASE_URL` absent en dev/test) : les routes répondent alors un payload
   * vide plutôt qu'une 500.
   */
  readonly service: CatalogSearchServiceShape | null;
  readonly log: CatalogLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: CatalogLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<CatalogSearchService, never>;
  readonly service: Promise<CatalogSearchServiceShape>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultCatalogRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

/**
 * Service Postgres (pool `postgres.js` paresseux, rôle `authenticated` à
 * moindre privilège : RLS + `SELECT` uniquement sur le catalogue). Mis en cache
 * sur `globalThis` pour survivre au HMR Vite sans fuiter de pools ; une promesse
 * rejetée est immédiatement purgée du cache.
 */
const getLiveService = (databaseUrl: string): Promise<CatalogSearchServiceShape> => {
  const existing = readCachedRuntime();
  if (existing !== undefined && existing.url === databaseUrl) {
    return existing.service;
  }
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const layer = CatalogSearchServiceLive.pipe(
    Layer.provide(
      DatabaseLive({
        connectionString: databaseUrl,
        maxConnections: 5,
        role: "authenticated",
      }),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const service = runtime
    .runPromise(
      Effect.gen(function* () {
        return yield* CatalogSearchService;
      }),
    )
    .catch((error: unknown) => {
      if (readCachedRuntime()?.runtime === runtime) writeCachedRuntime(undefined);
      void runtime.dispose();
      throw error;
    });
  writeCachedRuntime({ url: databaseUrl, runtime, service });
  return service;
};

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`). */
export const defaultCatalogDeps = async (): Promise<CatalogServerDeps> => {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth: defaultAuthDeps(),
    service:
      databaseUrl === undefined || databaseUrl === "" ? null : await getLiveService(databaseUrl),
    log: logWarning,
  };
};

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

const json = (
  body: unknown,
  status: number,
  cacheControl: string,
  cookies: ReadonlyArray<string> = [],
): Response => {
  const headers = new Headers({ "Cache-Control": cacheControl });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
};

const unauthorized = (): Response => json({ error: "unauthorized" }, 401, "no-store");

const extractErrorMeta = (cause: Cause.Cause<unknown>): Readonly<Record<string, unknown>> => {
  const failure = Cause.squash(cause);
  if (typeof failure !== "object" || failure === null) return {};
  const record = failure as Record<string, unknown>;
  const inner =
    typeof record["cause"] === "object" && record["cause"] !== null
      ? (record["cause"] as Record<string, unknown>)
      : null;
  const tag = typeof record["_tag"] === "string" ? record["_tag"] : undefined;
  const code =
    typeof inner?.["code"] === "string"
      ? inner["code"]
      : typeof record["code"] === "string"
        ? record["code"]
        : undefined;
  return {
    ...(tag === undefined ? {} : { errorTag: tag }),
    ...(code === undefined ? {} : { pgCode: code }),
  };
};

/** Exécute une opération du service ; `null` en cas d'échec (journalisé, jamais de fuite SQL). */
const execute = async <A, E>(
  deps: CatalogServerDeps,
  operation: string,
  effect: Effect.Effect<A, E>,
): Promise<A | null> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  deps.log("catalog.query_failed", { operation, ...extractErrorMeta(exit.cause) });
  return null;
};

const warnNoDatabase = (deps: CatalogServerDeps, operation: string): void =>
  deps.log("catalog.database_url_missing", {
    operation,
    hint: "DATABASE_URL is not set: serving an empty catalogue payload",
  });

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "catalog_unavailable" }, 503, "no-store", cookies);

// ---------------------------------------------------------------------------
// GET /api/catalog/discover
// ---------------------------------------------------------------------------

export const handleDiscover = async (
  request: Request,
  deps: CatalogServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  if (deps.service === null) {
    warnNoDatabase(deps, "discover");
    return json(emptyDiscoveryPayload, 200, "no-store", cookies);
  }
  const payload: SearchDiscoveryPayload | null = await execute(
    deps,
    "discover",
    deps.service.discover(),
  );
  return payload === null
    ? unavailable(cookies)
    : json(payload, 200, cookies.length > 0 ? "no-store" : "private, max-age=60", cookies);
};

// ---------------------------------------------------------------------------
// GET /api/catalog/suggest?q=
// ---------------------------------------------------------------------------

export const handleSuggest = async (
  request: Request,
  deps: CatalogServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (deps.service === null) {
    warnNoDatabase(deps, "suggest");
    return json(emptySuggestionsPayload(q.trim()), 200, "no-store", cookies);
  }
  const payload: SearchSuggestionsPayload | null = await execute(
    deps,
    "suggest",
    deps.service.suggest(q),
  );
  return payload === null ? unavailable(cookies) : json(payload, 200, "no-store", cookies);
};

// ---------------------------------------------------------------------------
// GET /api/catalog/search?q=&scope=&quickAccess=&setId=&sort=&limit=&offset=
// ---------------------------------------------------------------------------

const TEXT_PARAMS = ["q", "scope", "quickAccess", "setId", "sort"] as const;
const NUMBER_PARAMS = ["limit", "offset"] as const;

/**
 * Paramètres d'URL → objet à décoder. Les paramètres absents prennent leur
 * valeur par défaut ; `quickAccess` / `setId` vides sont ignorés ; un
 * `limit` / `offset` non entier est laissé en chaîne (donc rejeté → 400).
 */
const searchParamsToInput = (params: URLSearchParams): Record<string, unknown> => {
  const input: Record<string, unknown> = {};
  for (const key of TEXT_PARAMS) {
    const value = params.get(key);
    if (value === null) continue;
    if ((key === "quickAccess" || key === "setId") && value === "") continue;
    input[key] = value;
  }
  for (const key of NUMBER_PARAMS) {
    const value = params.get(key);
    if (value === null) continue;
    input[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return input;
};

export const handleSearch = async (
  request: Request,
  deps: CatalogServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  const decoded = await Effect.runPromiseExit(
    Schema.decodeUnknownEffect(SearchQuery)(searchParamsToInput(new URL(request.url).searchParams)),
  );
  if (!Exit.isSuccess(decoded)) return json({ error: "invalid_query" }, 400, "no-store", cookies);
  const query = decoded.value;

  if (deps.service === null) {
    warnNoDatabase(deps, "search");
    return json(emptyResultsPayload(query), 200, "no-store", cookies);
  }
  const payload: SearchResultsPayload | null = await execute(
    deps,
    "search",
    deps.service.search(query),
  );
  return payload === null ? unavailable(cookies) : json(payload, 200, "private, no-cache", cookies);
};
