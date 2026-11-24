/**
 * Accès serveur aux classeurs (écrans `02` & `02B` · Collection) : handlers
 * `Request → Response` des routes `/api/binders/*`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par les routes
 * `routes/api/binders/*` (handlers `server`, retirés du bundle client) — jamais
 * par un composant ou un module client (le client passe par `binders-client.ts`).
 *
 * Toutes les routes exigent une session SSR valide (`getServerSession`, 401
 * sinon) ; les cookies rafraîchis par la session sont propagés via `Set-Cookie`.
 * Les mutations vérifient en plus l'origine (CSRF, `isRequestSameOrigin`).
 * Réf. : docs/01 §4, docs/03, docs/06 §1–§3.
 */

import {
  BinderConflictError,
  type BinderSummary,
  buildCollectionOverview,
  CatalogItemNotFoundError,
  type CreateCustomBinderInput,
  type CreateSetBinderInput,
  InvalidCoverImageError,
  isBinderCoverStoragePathOf,
  isUuid,
  UnauthorizedBinderAccess,
  ValidationError,
} from "@pokevault/domain";
import {
  BinderCoverStorageLive,
  BinderService,
  BinderServiceLive,
  type BinderServiceShape,
  CollectionService,
  CollectionServiceLive,
  type CollectionServiceShape,
  CoverImageProcessor,
  Database,
  DatabaseError,
  DatabaseLive,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import type { BindersPayload, CatalogSetEntry, FetchLike } from "./binders-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type BindersLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** Lectures du catalogue propres à l'écran Collection (covers « carte », extensions à suivre). */
export interface BindersCatalogShape {
  /** `image_base_url` par identifiant de carte (`null` : carte sans image ; absente : inconnue). */
  readonly coverCardImages: (
    cardIds: ReadonlyArray<string>,
  ) => Effect.Effect<Record<string, string | null>, DatabaseError>;
  /** Toutes les extensions du catalogue, séries et extensions récentes d'abord. */
  readonly listSets: () => Effect.Effect<ReadonlyArray<CatalogSetEntry>, DatabaseError>;
}

/** Accès au Storage privé (`binder-covers`) pour le proxy de cover. */
export interface BindersStorageConfig {
  /** Base de l'API Storage, sans slash final (ex. `http://storage:5000`). */
  readonly baseUrl: string;
  /** Clé publique (`anon`) : header `apikey`. */
  readonly anonKey: string;
  readonly fetch: FetchLike;
}

export interface BindersServerDeps {
  readonly auth: AuthDeps;
  /**
   * Services Postgres, ou `null` quand aucune base n'est configurée
   * (`DATABASE_URL` absent en dev/test) : les routes répondent alors un payload
   * vide plutôt qu'une 500.
   */
  readonly services: {
    readonly binders: BinderServiceShape;
    readonly collection: CollectionServiceShape;
    readonly catalog: BindersCatalogShape;
  } | null;
  readonly storage: BindersStorageConfig;
  readonly log: BindersLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: BindersLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

type LiveServices = NonNullable<BindersServerDeps["services"]>;

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    BinderService | CollectionService | Database,
    never
  >;
  readonly services: Promise<LiveServices>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultBindersRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

interface CatalogSetRow {
  readonly id: string;
  readonly code: string | null;
  readonly name_fr: string;
  readonly logo_url: string | null;
  readonly series_id: string;
  readonly series_name_fr: string;
  readonly series_release_order: number;
  readonly release_date: string | null;
  readonly official_count: number;
  readonly total_count: number;
}

const makeCatalog = (sql: Database["Service"]["sql"]): BindersCatalogShape => ({
  coverCardImages: (cardIds) =>
    cardIds.length === 0
      ? Effect.succeed({})
      : Effect.tryPromise({
          try: async () => {
            const rows = await sql<Array<{ id: string; image_base_url: string | null }>>`
              select id, image_base_url from public.catalog_cards where id in ${sql(cardIds)}`;
            return Object.fromEntries(rows.map((row) => [row.id, row.image_base_url]));
          },
          catch: (cause) => new DatabaseError({ message: "cover cards query failed", cause }),
        }),
  listSets: () =>
    Effect.tryPromise({
      try: async () => {
        const rows = await sql<CatalogSetRow[]>`
          select s.id, s.code, s.name_fr, s.logo_url, s.series_id,
                 r.name_fr as series_name_fr, r.release_order as series_release_order,
                 s.release_date::text as release_date, s.official_count, s.total_count
            from public.catalog_sets s
            join public.catalog_series r on r.id = s.series_id
           order by r.release_order desc, s.release_date desc nulls last, s.name_fr asc`;
        return rows.map(
          (row): CatalogSetEntry => ({
            id: row.id,
            code: row.code,
            nameFr: row.name_fr,
            logoUrl: row.logo_url,
            seriesId: row.series_id,
            seriesNameFr: row.series_name_fr,
            seriesReleaseOrder: row.series_release_order,
            releaseDate: row.release_date,
            officialCount: row.official_count,
            totalCount: row.total_count,
          }),
        );
      },
      catch: (cause) => new DatabaseError({ message: "catalog sets query failed", cause }),
    }),
});

/**
 * Le téléversement de cover (T3.4) n'est pas branché sur cette route : le
 * processeur `sharp` (binaire natif) reste hors du bundle de l'écran Collection.
 */
const CoverUploadDisabled = Layer.succeed(CoverImageProcessor, {
  process: () =>
    Effect.fail(
      new InvalidCoverImageError({
        reason: "unsupported_format",
        message: "cover upload is not enabled on /api/binders",
      }),
    ),
});

/**
 * Services Postgres (pool `postgres.js` paresseux, rôle `authenticated` à
 * moindre privilège : RLS). Mis en cache sur `globalThis` pour survivre au HMR
 * Vite sans fuiter de pools ; une promesse rejetée est immédiatement purgée du
 * cache.
 */
const getLiveServices = (databaseUrl: string, auth: AuthDeps): Promise<LiveServices> => {
  const existing = readCachedRuntime();
  if (existing !== undefined && existing.url === databaseUrl) return existing.services;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const layer = Layer.mergeAll(BinderServiceLive, CollectionServiceLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        BinderCoverStorageLive({
          supabaseUrl: auth.config.publicUrl,
          anonKey: auth.config.anonKey,
        }),
        CoverUploadDisabled,
      ),
    ),
    Layer.provideMerge(
      DatabaseLive({ connectionString: databaseUrl, maxConnections: 5, role: "authenticated" }),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const services = runtime
    .runPromise(
      Effect.gen(function* () {
        const binders = yield* BinderService;
        const collection = yield* CollectionService;
        const { sql } = yield* Database;
        return { binders, collection, catalog: makeCatalog(sql) };
      }),
    )
    .catch((error: unknown) => {
      if (readCachedRuntime()?.runtime === runtime) writeCachedRuntime(undefined);
      void runtime.dispose();
      throw error;
    });
  writeCachedRuntime({ url: databaseUrl, runtime, services });
  return services;
};

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`) + Storage Supabase. */
export const defaultBindersDeps = async (): Promise<BindersServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  const internalStorage = process.env["SUPABASE_INTERNAL_STORAGE_URL"]?.trim();
  return {
    auth,
    services:
      databaseUrl === undefined || databaseUrl === ""
        ? null
        : await getLiveServices(databaseUrl, auth),
    storage: {
      baseUrl:
        internalStorage === undefined || internalStorage === ""
          ? `${auth.config.publicUrl}/storage/v1`
          : stripTrailingSlashes(internalStorage),
      anonKey: auth.config.anonKey,
      fetch: (input, init) => fetch(input, init),
    },
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

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "binders_unavailable" }, 503, "no-store", cookies);

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

const warnNoDatabase = (deps: BindersServerDeps, operation: string): void =>
  deps.log("binders.database_url_missing", {
    operation,
    hint: "DATABASE_URL is not set: serving an empty collection payload",
  });

// ---------------------------------------------------------------------------
// GET /api/binders
// ---------------------------------------------------------------------------

const emptyPayload = (): BindersPayload => ({
  binders: [],
  overview: buildCollectionOverview({
    series: [],
    sets: [],
    copies: [],
    trackedSetIds: new Set(),
  }),
  coverCardImageById: {},
  catalogSets: [],
});

export const handleListBinders = async (
  request: Request,
  deps: BindersServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  if (deps.services === null) {
    warnNoDatabase(deps, "list");
    return json(emptyPayload(), 200, "no-store", cookies);
  }
  const { binders, collection, catalog } = deps.services;
  const userId = session.user.id;

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const [list, overview, catalogSets] = yield* Effect.all(
        [binders.listBinders(userId), collection.getCollectionOverview(userId), catalog.listSets()],
        { concurrency: "unbounded" },
      );
      const coverCardIds = [
        ...new Set(
          list.flatMap(({ binder }) =>
            binder.coverType === "card" && binder.coverCardId !== null ? [binder.coverCardId] : [],
          ),
        ),
      ];
      const coverCardImageById = yield* catalog.coverCardImages(coverCardIds);
      return { binders: list, overview, coverCardImageById, catalogSets } satisfies BindersPayload;
    }),
  );
  if (!Exit.isSuccess(exit)) {
    deps.log("binders.query_failed", { operation: "list", ...extractErrorMeta(exit.cause) });
    return unavailable(cookies);
  }
  return json(exit.value, 200, "no-store", cookies);
};

// ---------------------------------------------------------------------------
// POST /api/binders
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Corps JSON → entrée du service, ou `null` (400). Champs inconnus ignorés. */
const parseCreateBody = (
  body: unknown,
):
  | { readonly kind: "set"; readonly input: CreateSetBinderInput }
  | { readonly kind: "custom"; readonly input: CreateCustomBinderInput }
  | null => {
  if (!isRecord(body)) return null;
  if (body["kind"] === "set") {
    return {
      kind: "set",
      input: {
        setId: body["setId"] as string,
        // Suivre deux fois la même extension → 409 (jamais de classeur dupliqué silencieux).
        ifExists: "fail",
        ...(body["title"] === undefined ? {} : { title: body["title"] as string }),
      },
    };
  }
  if (body["kind"] === "custom") {
    return {
      kind: "custom",
      input: {
        title: body["title"] as string,
        ...(body["isPinned"] === undefined ? {} : { isPinned: body["isPinned"] as boolean }),
      },
    };
  }
  return null;
};

const readJsonBody = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const handleCreateBinder = async (
  request: Request,
  deps: BindersServerDeps,
): Promise<Response> => {
  // CSRF : une mutation n'est acceptée que depuis l'origine de l'application.
  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return json({ error: "forbidden_origin" }, 403, "no-store");
  }
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  const parsed = parseCreateBody(await readJsonBody(request));
  if (parsed === null) return json({ error: "invalid_input" }, 400, "no-store", cookies);

  if (deps.services === null) {
    warnNoDatabase(deps, "create");
    return unavailable(cookies);
  }
  const { binders } = deps.services;
  const userId = session.user.id;

  const exit = await Effect.runPromiseExit(
    parsed.kind === "set"
      ? binders.createSetBinder(userId, parsed.input)
      : binders.createCustomBinder(userId, parsed.input),
  );
  if (Exit.isSuccess(exit)) {
    const summary: BinderSummary = exit.value;
    return json(summary, 201, "no-store", cookies);
  }

  const failure = Cause.squash(exit.cause);
  if (failure instanceof ValidationError) {
    return json({ error: "invalid_input" }, 400, "no-store", cookies);
  }
  if (failure instanceof CatalogItemNotFoundError) {
    return json({ error: "not_found" }, 404, "no-store", cookies);
  }
  if (failure instanceof BinderConflictError) {
    return json({ error: "binder_exists" }, 409, "no-store", cookies);
  }
  if (failure instanceof UnauthorizedBinderAccess) {
    return json({ error: "forbidden" }, 403, "no-store", cookies);
  }
  deps.log("binders.query_failed", { operation: "create", ...extractErrorMeta(exit.cause) });
  return unavailable(cookies);
};

// ---------------------------------------------------------------------------
// GET /api/binders/$id/cover — proxy sécurisé de la cover uploadée (bucket privé)
// ---------------------------------------------------------------------------

const COVER_FETCH_TIMEOUT_MS = 15_000;
/** Plafond défensif (docs/06 §3 : 2 Mo max) sur la réponse du Storage. */
const COVER_MAX_PROXY_BYTES = 2 * 1024 * 1024;

const notFound = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "not_found" }, 404, "no-store", cookies);

export const handleBinderCover = async (
  request: Request,
  binderId: string,
  deps: BindersServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];
  const userId = session.user.id;

  // Un identifiant non UUID ne peut désigner aucun classeur (et jamais un chemin Storage).
  if (!isUuid(binderId)) return notFound(cookies);
  if (deps.services === null) {
    warnNoDatabase(deps, "cover");
    return notFound(cookies);
  }

  const lookup = await Effect.runPromiseExit(deps.services.binders.getBinder(userId, binderId));
  if (!Exit.isSuccess(lookup)) {
    const failure = Cause.squash(lookup.cause);
    // Classeur absent ou d'un autre utilisateur : indiscernables (jamais de 403).
    if (
      typeof failure === "object" &&
      failure !== null &&
      "_tag" in failure &&
      (failure._tag === "BinderNotFoundError" || failure._tag === "UnauthorizedBinderAccess")
    ) {
      return notFound(cookies);
    }
    deps.log("binders.query_failed", { operation: "cover", ...extractErrorMeta(lookup.cause) });
    return unavailable(cookies);
  }

  const { binder } = lookup.value;
  const path = binder.coverStoragePath;
  if (
    binder.userId.toLowerCase() !== userId.toLowerCase() ||
    binder.coverType !== "upload" ||
    path === null ||
    !isBinderCoverStoragePathOf(path, userId, binderId)
  ) {
    return notFound(cookies);
  }

  let upstream: Response;
  try {
    upstream = await deps.storage.fetch(`${deps.storage.baseUrl}/object/binder-covers/${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${session.accessToken}`, apikey: deps.storage.anonKey },
      signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    deps.log("binders.cover_fetch_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "cover_unavailable" }, 502, "no-store", cookies);
  }

  if (!upstream.ok || upstream.body === null) {
    void upstream.body?.cancel().catch(() => {});
    // Le Storage répond 400/404 pour un objet absent : l'image est simplement introuvable.
    if (upstream.status === 400 || upstream.status === 404) return notFound(cookies);
    deps.log("binders.cover_fetch_failed", { status: upstream.status });
    return json({ error: "cover_unavailable" }, 502, "no-store", cookies);
  }
  const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > COVER_MAX_PROXY_BYTES) {
    void upstream.body.cancel().catch(() => {});
    deps.log("binders.cover_too_large", { declaredLength });
    return json({ error: "cover_unavailable" }, 502, "no-store", cookies);
  }

  const headers = new Headers({
    // Le type est imposé (pipeline de recompression : toujours du WebP), jamais relayé.
    "Content-Type": "image/webp",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cookies.length > 0 ? "no-store" : "private, max-age=3600",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(upstream.body, { status: 200, headers });
};
