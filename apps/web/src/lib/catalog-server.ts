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
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
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

let liveService: Promise<CatalogSearchServiceShape> | undefined;
let liveServiceUrl: string | undefined;

/**
 * Service Postgres (pool `postgres.js` paresseux : aucune connexion avant la
 * première requête), construit une seule fois par processus et par URL.
 */
const getLiveService = (databaseUrl: string): Promise<CatalogSearchServiceShape> => {
  if (liveService === undefined || liveServiceUrl !== databaseUrl) {
    const layer = CatalogSearchServiceLive.pipe(
      Layer.provide(DatabaseLive({ connectionString: databaseUrl, maxConnections: 5 })),
    );
    liveServiceUrl = databaseUrl;
    liveService = ManagedRuntime.make(layer).runPromise(
      Effect.gen(function* () {
        return yield* CatalogSearchService;
      }),
    );
  }
  return liveService;
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

/** Exécute une opération du service ; `null` en cas d'échec (journalisé, jamais de fuite SQL). */
const execute = async <A, E>(
  deps: CatalogServerDeps,
  operation: string,
  effect: Effect.Effect<A, E>,
): Promise<A | null> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  deps.log("catalog.query_failed", { operation });
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
    : json(payload, 200, "private, max-age=60", cookies);
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
