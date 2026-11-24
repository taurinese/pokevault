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
  BinderNotFoundError,
  type BinderSummary,
  buildCollectionOverview,
  CatalogItemNotFoundError,
  COVER_MAX_BYTES,
  type CompletionOptions,
  type CreateCustomBinderInput,
  type CreateSetBinderInput,
  InvalidCoverImageError,
  isBinderCoverStoragePathOf,
  isUuid,
  type SetBinderCoverInput,
  StorageServiceError,
  UnauthorizedBinderAccess,
  type UpdateBinderInput,
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
  Database,
  DatabaseError,
  DatabaseLive,
} from "@pokevault/services";
// ⚠️ Sous-chemin dédié (hors `index.ts`) : `sharp` (addon natif) ne doit exister que dans le
// bundle SERVEUR de l'app web — jamais côté client ni dans le worker.
import { CoverImageProcessorSharp } from "@pokevault/services/cover-image-sharp";
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
 * Services Postgres (pool `postgres.js` paresseux, rôle `authenticated` à
 * moindre privilège : RLS). Mis en cache sur `globalThis` pour survivre au HMR
 * Vite sans fuiter de pools ; une promesse rejetée est immédiatement purgée du
 * cache.
 */
const getLiveServices = (
  databaseUrl: string,
  auth: AuthDeps,
  storageApiBase: string,
): Promise<LiveServices> => {
  const existing = readCachedRuntime();
  const cacheKey = `${databaseUrl}\u0000${storageApiBase}`;
  if (existing !== undefined && existing.url === cacheKey) return existing.services;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const layer = Layer.mergeAll(BinderServiceLive, CollectionServiceLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        // Même base que le proxy `GET .../cover` : Storage interne Docker (`http://storage:5000`,
        // sans `/storage/v1`) ou `<SUPABASE_PUBLIC_URL>/storage/v1` en dev.
        BinderCoverStorageLive({ storageUrl: storageApiBase, anonKey: auth.config.anonKey }),
        CoverImageProcessorSharp,
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
  writeCachedRuntime({ url: cacheKey, runtime, services });
  return services;
};

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/**
 * Base de l'API Storage (sans slash final), préfixe de `/object/binder-covers/...` :
 * - `SUPABASE_INTERNAL_STORAGE_URL` (Docker : `http://storage:5000`) sert `/object/...`
 *   **directement à la racine** (le `/storage/v1` est retiré par Caddy `handle_path`) ;
 * - sinon l'URL publique (dev : `http://localhost:54321`) + `/storage/v1`.
 */
export const resolveStorageApiBase = (
  publicUrl: string,
  internalStorageUrl: string | undefined,
): string => {
  const internal = internalStorageUrl?.trim();
  return internal === undefined || internal === ""
    ? `${stripTrailingSlashes(publicUrl)}/storage/v1`
    : stripTrailingSlashes(internal);
};

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`) + Storage Supabase. */
export const defaultBindersDeps = async (): Promise<BindersServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  const storageApiBase = resolveStorageApiBase(
    auth.config.publicUrl,
    process.env["SUPABASE_INTERNAL_STORAGE_URL"],
  );
  return {
    auth,
    services:
      databaseUrl === undefined || databaseUrl === ""
        ? null
        : await getLiveServices(databaseUrl, auth, storageApiBase),
    storage: {
      baseUrl: storageApiBase,
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

/**
 * `?extras=0` : exclut les cartes secrètes et les exemplaires promo du calcul de complétion
 * (option « Inclure les cartes promos / secrètes » désactivée du bottom sheet 02C).
 */
const completionOptionsOf = (request: Request): CompletionOptions | undefined => {
  const extras = new URL(request.url).searchParams.get("extras");
  return extras === "0" ? { includeSecrets: false, includePromos: false } : undefined;
};

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
  const options = completionOptionsOf(request);

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const [list, overview, catalogSets] = yield* Effect.all(
        [
          options === undefined
            ? binders.listBinders(userId)
            : binders.listBinders(userId, options),
          options === undefined
            ? collection.getCollectionOverview(userId)
            : collection.getCollectionOverview(userId, options),
          catalog.listSets(),
        ],
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
  // Le délai ne couvre que l'attente des en-têtes : un `AbortSignal.timeout` resterait armé
  // pendant la lecture du corps et couperait en plein flux le streaming d'un client lent.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS);
  try {
    upstream = await deps.storage.fetch(`${deps.storage.baseUrl}/object/binder-covers/${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${session.accessToken}`, apikey: deps.storage.anonKey },
      signal: controller.signal,
    });
  } catch (error) {
    deps.log("binders.cover_fetch_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "cover_unavailable" }, 502, "no-store", cookies);
  } finally {
    clearTimeout(timer);
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

// ---------------------------------------------------------------------------
// Mutations d'un classeur : PATCH / DELETE /api/binders/$id · PUT /api/binders/$id/cover
// ---------------------------------------------------------------------------

/** Enveloppe multipart tolérée au-delà des 2 Mio d'image (frontières, en-têtes de partie). */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

/** Type de média des images de cover acceptées en corps binaire brut. */
const RAW_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

type CappedBody =
  | { readonly kind: "ok"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "too_large" };

/**
 * Lit le corps en le plafonnant : le `Content-Length` déclaré est vérifié d'abord, puis le flux
 * est interrompu dès que le cumul dépasse `maxBytes` (jamais un corps géant en mémoire).
 */
const readCappedBody = async (request: Request, maxBytes: number): Promise<CappedBody> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too_large" };
  if (request.body === null) return { kind: "ok", bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      return { kind: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
};

/** Corps JSON plafonné (`MAX_BODY_BYTES`) → valeur, ou `undefined` (400). */
const readJsonRecord = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (body.kind !== "ok") return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body.bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

interface HttpFailure {
  readonly status: number;
  readonly error: string;
}

/** Erreur typée du `BinderService` → réponse HTTP, ou `null` si elle doit rester une 503 loguée. */
const failureToHttp = (failure: unknown): HttpFailure | null => {
  if (failure instanceof InvalidCoverImageError) {
    switch (failure.reason) {
      case "too_large":
        return { status: 413, error: "image_too_large" };
      case "svg_not_allowed":
        return { status: 415, error: "svg_not_allowed" };
      case "unsupported_format":
        return { status: 415, error: "unsupported_format" };
      default:
        return { status: 400, error: "invalid_image" };
    }
  }
  if (failure instanceof ValidationError) return { status: 400, error: "invalid_input" };
  // Classeur absent ou d'un autre utilisateur : indiscernables (jamais de 403).
  if (
    failure instanceof BinderNotFoundError ||
    failure instanceof CatalogItemNotFoundError ||
    failure instanceof UnauthorizedBinderAccess
  ) {
    return { status: 404, error: "not_found" };
  }
  if (failure instanceof StorageServiceError) return { status: 502, error: "storage_unavailable" };
  return null;
};

/** Garde commune des mutations : CSRF → session → identifiant → base disponible. */
type MutationContext =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly accessToken: string;
      readonly cookies: ReadonlyArray<string>;
      readonly binders: BinderServiceShape;
    }
  | { readonly ok: false; readonly response: Response };

const prepareBinderMutation = async (
  request: Request,
  binderId: string,
  deps: BindersServerDeps,
  operation: string,
): Promise<MutationContext> => {
  // CSRF : une mutation n'est acceptée que depuis l'origine de l'application.
  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return { ok: false, response: json({ error: "forbidden_origin" }, 403, "no-store") };
  }
  const session = await getServerSession(request, deps.auth);
  if (session === null) return { ok: false, response: unauthorized() };
  const cookies = session.refreshedCookies ?? [];
  // Un identifiant non UUID ne peut désigner aucun classeur.
  if (!isUuid(binderId)) return { ok: false, response: notFound(cookies) };
  if (deps.services === null) {
    warnNoDatabase(deps, operation);
    return { ok: false, response: unavailable(cookies) };
  }
  return {
    ok: true,
    userId: session.user.id,
    accessToken: session.accessToken,
    cookies,
    binders: deps.services.binders,
  };
};

const failureResponse = (
  exit: Exit.Failure<unknown, unknown>,
  deps: BindersServerDeps,
  operation: string,
  cookies: ReadonlyArray<string>,
): Response => {
  const mapped = failureToHttp(Cause.squash(exit.cause));
  if (mapped !== null) return json({ error: mapped.error }, mapped.status, "no-store", cookies);
  deps.log("binders.query_failed", { operation, ...extractErrorMeta(exit.cause) });
  return unavailable(cookies);
};

/** Corps JSON → patch (`title`, `isPinned`, `sortOrder` uniquement ; validé par le domaine). */
const parseUpdateBody = (body: Record<string, unknown>): UpdateBinderInput =>
  ({
    ...(body["title"] === undefined ? {} : { title: body["title"] }),
    ...(body["isPinned"] === undefined ? {} : { isPinned: body["isPinned"] }),
    ...(body["sortOrder"] === undefined ? {} : { sortOrder: body["sortOrder"] }),
  }) as UpdateBinderInput;

export const handleUpdateBinder = async (
  request: Request,
  binderId: string,
  deps: BindersServerDeps,
): Promise<Response> => {
  const ctx = await prepareBinderMutation(request, binderId, deps, "update");
  if (!ctx.ok) return ctx.response;
  const body = await readJsonRecord(request);
  if (body === undefined) return json({ error: "invalid_input" }, 400, "no-store", ctx.cookies);

  const exit = await Effect.runPromiseExit(
    ctx.binders.updateBinder(ctx.userId, binderId, parseUpdateBody(body)),
  );
  if (!Exit.isSuccess(exit)) return failureResponse(exit, deps, "update", ctx.cookies);
  const summary: BinderSummary = exit.value;
  return json(summary, 200, "no-store", ctx.cookies);
};

export const handleDeleteBinder = async (
  request: Request,
  binderId: string,
  deps: BindersServerDeps,
): Promise<Response> => {
  const ctx = await prepareBinderMutation(request, binderId, deps, "delete");
  if (!ctx.ok) return ctx.response;

  // Le service supprime aussi l'objet Storage de la cover uploadée (best-effort).
  const exit = await Effect.runPromiseExit(
    ctx.binders.deleteBinder(ctx.userId, binderId, ctx.accessToken),
  );
  if (!Exit.isSuccess(exit)) return failureResponse(exit, deps, "delete", ctx.cookies);
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of ctx.cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
};

type CoverInput =
  | { readonly kind: "ok"; readonly input: SetBinderCoverInput }
  | { readonly kind: "error"; readonly status: number; readonly error: string };

const coverError = (status: number, error: string): CoverInput => ({
  kind: "error",
  status,
  error,
});

const parseCoverJson = async (request: Request): Promise<CoverInput> => {
  const body = await readJsonRecord(request);
  if (body === undefined) return coverError(400, "invalid_input");
  if (body["type"] === "set_logo") return { kind: "ok", input: { type: "set_logo" } };
  if (body["type"] === "card" && typeof body["cardId"] === "string") {
    return { kind: "ok", input: { type: "card", cardId: body["cardId"] } };
  }
  return coverError(400, "invalid_input");
};

const parseCoverMultipart = async (request: Request, contentType: string): Promise<CoverInput> => {
  const body = await readCappedBody(request, COVER_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
  if (body.kind !== "ok") return coverError(413, "image_too_large");
  let form: FormData;
  try {
    form = await new Response(body.bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return coverError(400, "invalid_input");
  }
  const image = form.get("image");
  if (!(image instanceof File)) return coverError(400, "invalid_input");
  if (image.size > COVER_MAX_BYTES) return coverError(413, "image_too_large");
  return {
    kind: "ok",
    input: { type: "upload", image: new Uint8Array(await image.arrayBuffer()) },
  };
};

const parseCoverRaw = async (request: Request): Promise<CoverInput> => {
  const body = await readCappedBody(request, COVER_MAX_BYTES);
  if (body.kind !== "ok") return coverError(413, "image_too_large");
  return { kind: "ok", input: { type: "upload", image: body.bytes } };
};

/**
 * Corps de `PUT /api/binders/$id/cover` : JSON (`set_logo` / `card`), `multipart/form-data`
 * (champ `image`) ou image binaire brute (`image/jpeg|png|webp`). Le format réel est de toute
 * façon contrôlé par les magic bytes dans le service (jamais le `Content-Type` déclaré).
 */
const parseCoverRequest = (request: Request): Promise<CoverInput> => {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "application/json") return parseCoverJson(request);
  if (mediaType === "multipart/form-data") return parseCoverMultipart(request, contentType);
  if (RAW_IMAGE_TYPES.has(mediaType)) return parseCoverRaw(request);
  if (mediaType === "image/svg+xml") return Promise.resolve(coverError(415, "svg_not_allowed"));
  return Promise.resolve(coverError(415, "unsupported_media_type"));
};

export const handleSetBinderCover = async (
  request: Request,
  binderId: string,
  deps: BindersServerDeps,
): Promise<Response> => {
  const ctx = await prepareBinderMutation(request, binderId, deps, "set_cover");
  if (!ctx.ok) return ctx.response;
  const parsed = await parseCoverRequest(request);
  if (parsed.kind === "error") {
    return json({ error: parsed.error }, parsed.status, "no-store", ctx.cookies);
  }

  const exit = await Effect.runPromiseExit(
    ctx.binders.setBinderCover(ctx.userId, binderId, parsed.input, ctx.accessToken),
  );
  if (!Exit.isSuccess(exit)) return failureResponse(exit, deps, "set_cover", ctx.cookies);
  const summary: BinderSummary = exit.value;
  return json(summary, 200, "no-store", ctx.cookies);
};
