/**
 * Accès serveur au partage lecture seule (écrans `09C–09D`) : handlers `Request → Response` des
 * routes publiques `/api/shared/$token[/cover]` et des routes privées `/api/share-links[/$id]`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc `postgres` / `node:*`).
 * Il ne doit être importé que par les routes `routes/api/shared/*` et `routes/api/share-links*`
 * (handlers `server`, retirés du bundle client) — jamais par un composant ou un module client
 * (le client passe par `share-client.ts`).
 *
 * Deux surfaces aux garanties opposées :
 * - **Publique** (`/api/shared/$token`, `/api/shared/$token/cover`) : AUCUNE session. La lecture
 *   passe EXCLUSIVEMENT par `ShareService.getSharedBinder(token)` (`public.get_shared_binder`,
 *   ADR-008) sur un pool Postgres `anon` : jamais de lecture directe de `binders`,
 *   `user_card_copies`, `profiles` ni `share_links`. Jeton mal formé / inconnu / révoqué → `404`
 *   uniforme. Réponses `no-store` (révocation immédiate) + `X-Robots-Tag: noindex, nofollow`.
 *   Le jeton (secret) n'est jamais loggé.
 * - **Privée** (`/api/share-links*`) : session SSR (401), CSRF (403), corps plafonné (413),
 *   UUID stricts, `ShareServiceLive` sur le pool `authenticated` (RLS).
 *
 * Réf. : docs/01 §2.2 / §5.1 / §10, docs/06 §2, ADR-008.
 */

import {
  BinderNotFoundError,
  isUuid,
  isValidShareToken,
  type ShareLink,
  ShareLinkForbiddenError,
  ShareLinkNotFoundError,
  ValidationError,
} from "@pokevault/domain";
import {
  Database,
  DatabaseError,
  DatabaseLive,
  ShareService,
  ShareServiceLive,
  type ShareServiceShape,
  withUserRls,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import { logWarning, resolveStorageApiBase } from "./binders-server.ts";
import type { FetchLike, ShareLinkEntry, ShareLinksPayload } from "./share-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type ShareLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** Opérations du propriétaire (pool `authenticated`, RLS) + titres des classeurs partagés. */
export interface ShareOwnerServices {
  readonly share: Pick<
    ShareServiceShape,
    "createLink" | "listLinks" | "revokeLink" | "updateShowQuantities"
  >;
  /** Titres des classeurs DU PROPRIÉTAIRE (RLS) par identifiant ; absent = classeur disparu. */
  readonly binderTitles: (
    userId: string,
    binderIds: ReadonlyArray<string>,
  ) => Effect.Effect<Readonly<Record<string, string>>, DatabaseError | ValidationError>;
}

/** Lecture publique : UNIQUEMENT `get_shared_binder(token)` (pool `anon`). */
export type SharePublicServices = Pick<ShareServiceShape, "getSharedBinder">;

/** Chemin Storage de la cover uploadée d'un lien actif (RPC réservée au `service_role`). */
export type ShareCoverPathResolver = (token: string) => Effect.Effect<string | null, DatabaseError>;

export interface ShareStorageConfig {
  /** Base de l'API Storage, sans slash final (ex. `http://storage:5000`). */
  readonly baseUrl: string;
  /** Clé publique (`anon`) : header `apikey`. */
  readonly anonKey: string;
  /**
   * JWT `service_role` (`SUPABASE_SERVICE_ROLE_KEY`, optionnel) pour lire l'objet du bucket
   * privé sans session. Absent : l'objet n'est pas lisible et la cover répond `404`.
   */
  readonly serviceKey?: string | undefined;
  readonly fetch: FetchLike;
}

export interface ShareServerDeps {
  readonly auth: AuthDeps;
  /** `null` quand `DATABASE_URL` est absent (dev/test sans base). */
  readonly owner: ShareOwnerServices | null;
  /** `null` quand `DATABASE_URL` est absent. */
  readonly publicBinder: SharePublicServices | null;
  /** `null` quand `DATABASE_URL` est absent. */
  readonly coverPath: ShareCoverPathResolver | null;
  readonly storage: ShareStorageConfig;
  readonly log: ShareLogger;
}

// ---------------------------------------------------------------------------
// Pools Postgres (un par rôle, mis en cache sur `globalThis` : survit au HMR sans fuite)
// ---------------------------------------------------------------------------

interface CachedPool<T> {
  readonly key: string;
  readonly runtime: { readonly dispose: () => Promise<void> };
  readonly value: Promise<T>;
}

const readSlot = <T>(slot: string): CachedPool<T> | undefined =>
  (globalThis as Record<string, unknown>)[slot] as CachedPool<T> | undefined;

const writeSlot = <T>(slot: string, entry: CachedPool<T> | undefined): void => {
  (globalThis as Record<string, unknown>)[slot] = entry;
};

const cachedPool = <T, ROut>(
  slot: string,
  key: string,
  layer: Layer.Layer<ROut>,
  read: Effect.Effect<T, never, ROut>,
): Promise<T> => {
  const existing = readSlot<T>(slot);
  if (existing !== undefined && existing.key === key) return existing.value;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeSlot(slot, undefined);
  }
  const runtime = ManagedRuntime.make(layer);
  const value = runtime.runPromise(read).catch((error: unknown) => {
    if (readSlot<T>(slot)?.runtime === runtime) writeSlot(slot, undefined);
    void runtime.dispose();
    throw error;
  });
  writeSlot<T>(slot, { key, runtime, value });
  return value;
};

const OWNER_SLOT = "__pokevaultShareOwnerRuntime" as const;
const PUBLIC_SLOT = "__pokevaultSharePublicRuntime" as const;
const COVER_SLOT = "__pokevaultShareCoverRuntime" as const;

interface BinderTitleRow {
  readonly id: string;
  readonly title: string;
}

/** Pool `authenticated` : `ShareServiceLive` (RLS) + titres des classeurs du propriétaire. */
const getOwnerServices = (databaseUrl: string): Promise<ShareOwnerServices> =>
  cachedPool(
    OWNER_SLOT,
    databaseUrl,
    Layer.provideMerge(
      ShareServiceLive,
      DatabaseLive({ connectionString: databaseUrl, maxConnections: 5, role: "authenticated" }),
    ),
    Effect.gen(function* () {
      const share = yield* ShareService;
      const { sql } = yield* Database;
      const binderTitles: ShareOwnerServices["binderTitles"] = (userId, binderIds) =>
        binderIds.length === 0
          ? Effect.succeed({})
          : withUserRls(sql, userId, async (tx) => {
              const rows = await tx<BinderTitleRow[]>`
                select id, title from public.binders
                 where user_id = ${userId} and id::text in ${tx(binderIds)}`;
              return Object.fromEntries(rows.map((row) => [row.id, row.title]));
            });
      return { share, binderTitles } satisfies ShareOwnerServices;
    }),
  );

/**
 * Pool `anon` (`GRANT EXECUTE ON FUNCTION get_shared_binder TO anon`) : aucun droit sur les
 * tables privées, donc une régression éventuelle ne pourrait de toute façon rien lire d'autre.
 */
const getPublicServices = (databaseUrl: string): Promise<SharePublicServices> =>
  cachedPool(
    PUBLIC_SLOT,
    databaseUrl,
    Layer.provideMerge(
      ShareServiceLive,
      DatabaseLive({ connectionString: databaseUrl, maxConnections: 5, role: "anon" }),
    ),
    Effect.gen(function* () {
      const share = yield* ShareService;
      return { getSharedBinder: share.getSharedBinder } satisfies SharePublicServices;
    }),
  );

/** Pool `service_role` utilisé UNIQUEMENT pour `get_shared_binder_cover_path(token)`. */
const getCoverPathResolver = (databaseUrl: string): Promise<ShareCoverPathResolver> =>
  cachedPool(
    COVER_SLOT,
    databaseUrl,
    DatabaseLive({ connectionString: databaseUrl, maxConnections: 2, role: "service_role" }),
    Effect.gen(function* () {
      const { sql } = yield* Database;
      const resolver: ShareCoverPathResolver = (token) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await sql<Array<{ path: string | null }>>`
              select public.get_shared_binder_cover_path(${token}::text) as path`;
            return rows[0]?.path ?? null;
          },
          // Pas de `cause` : l'erreur postgres pourrait citer le jeton.
          catch: () => new DatabaseError({ message: "get_shared_binder_cover_path failed" }),
        });
      return resolver;
    }),
  );

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`) + Storage Supabase. */
export const defaultShareDeps = async (): Promise<ShareServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  const hasDatabase = databaseUrl !== undefined && databaseUrl !== "";
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  return {
    auth,
    owner: hasDatabase ? await getOwnerServices(databaseUrl) : null,
    publicBinder: hasDatabase ? await getPublicServices(databaseUrl) : null,
    coverPath: hasDatabase ? await getCoverPathResolver(databaseUrl) : null,
    storage: {
      baseUrl: resolveStorageApiBase(
        auth.config.publicUrl,
        process.env["SUPABASE_INTERNAL_STORAGE_URL"],
      ),
      anonKey: auth.config.anonKey,
      ...(serviceKey === undefined || serviceKey === "" ? {} : { serviceKey }),
      fetch: (input, init) => fetch(input, init),
    },
    log: logWarning,
  };
};

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

const NO_STORE = "no-store";

/** En-têtes de toute réponse PUBLIQUE : jamais en cache (révocation) ni indexée (jeton en URL). */
const publicHeaders = (extra: Record<string, string> = {}): Headers =>
  new Headers({
    "Cache-Control": NO_STORE,
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    // Le jeton est dans l'URL de la page : aucun `Referer` ne doit le relayer à un tiers.
    "Referrer-Policy": "no-referrer",
    ...extra,
  });

const publicJson = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: publicHeaders() });

const publicNotFound = (): Response => publicJson({ error: "not_found" }, 404);

const privateJson = (
  body: unknown,
  status: number,
  cookies: ReadonlyArray<string> = [],
): Response => {
  const headers = new Headers({ "Cache-Control": NO_STORE });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
};

const unauthorized = (): Response => privateJson({ error: "unauthorized" }, 401);

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  privateJson({ error: "share_unavailable" }, 503, cookies);

/** Métadonnées d'erreur loggables : étiquette + code SQLSTATE, jamais le message (jeton possible). */
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

const failureTag = (cause: Cause.Cause<unknown>): string | undefined => {
  const failure = Cause.squash(cause);
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
    ? failure._tag
    : undefined;
};

// ---------------------------------------------------------------------------
// GET /api/shared/$token — projection publique (aucune session)
// ---------------------------------------------------------------------------

export const handleGetSharedBinder = async (
  token: string,
  deps: ShareServerDeps,
): Promise<Response> => {
  // Format invalide : 404 sans toucher la base (même réponse qu'un jeton inconnu / révoqué).
  if (!isValidShareToken(token)) return publicNotFound();
  if (deps.publicBinder === null) {
    deps.log("share.database_url_missing", { operation: "public_read" });
    return publicJson({ error: "shared_unavailable" }, 503);
  }
  const exit = await Effect.runPromiseExit(deps.publicBinder.getSharedBinder(token));
  if (Exit.isSuccess(exit)) return publicJson(exit.value, 200);
  if (failureTag(exit.cause) === "ShareLinkNotFoundError") return publicNotFound();
  deps.log("share.query_failed", { operation: "public_read", ...extractErrorMeta(exit.cause) });
  return publicJson({ error: "shared_unavailable" }, 503);
};

// ---------------------------------------------------------------------------
// GET /api/shared/$token/cover — proxy de la cover uploadée (bucket privé)
// ---------------------------------------------------------------------------

const COVER_FETCH_TIMEOUT_MS = 15_000;
/** Plafond défensif (docs/06 §3 : 2 Mo max) sur la réponse du Storage. */
const COVER_MAX_PROXY_BYTES = 2 * 1024 * 1024;

/** `<user_uuid>/<binder_uuid>.webp` : tout autre chemin n'est JAMAIS demandé au Storage. */
const isCoverStoragePath = (path: string): boolean => {
  const match = /^([^/]+)\/([^/]+)\.webp$/.exec(path);
  return match !== null && isUuid(match[1] ?? "") && isUuid(match[2] ?? "");
};

export const handleGetSharedBinderCover = async (
  token: string,
  deps: ShareServerDeps,
): Promise<Response> => {
  if (!isValidShareToken(token)) return publicNotFound();
  if (deps.coverPath === null) {
    deps.log("share.database_url_missing", { operation: "public_cover" });
    return publicNotFound();
  }
  const lookup = await Effect.runPromiseExit(deps.coverPath(token));
  if (!Exit.isSuccess(lookup)) {
    deps.log("share.query_failed", {
      operation: "public_cover",
      ...extractErrorMeta(lookup.cause),
    });
    return publicJson({ error: "shared_unavailable" }, 503);
  }
  // Jeton inconnu / révoqué / cover non uploadée : indiscernables (même 404).
  const path = lookup.value;
  if (path === null || !isCoverStoragePath(path)) return publicNotFound();

  let upstream: Response;
  // Le délai ne couvre que l'attente des en-têtes : un `AbortSignal.timeout` couperait en plein
  // flux le streaming d'un client lent.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS);
  try {
    upstream = await deps.storage.fetch(`${deps.storage.baseUrl}/object/binder-covers/${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${deps.storage.serviceKey ?? deps.storage.anonKey}`,
        apikey: deps.storage.anonKey,
      },
      signal: controller.signal,
    });
  } catch (error) {
    deps.log("share.cover_fetch_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return publicJson({ error: "cover_unavailable" }, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok || upstream.body === null) {
    void upstream.body?.cancel().catch(() => {});
    // Le Storage répond 400/401/403/404 pour un objet absent ou illisible : pas d'image à servir.
    if ([400, 401, 403, 404].includes(upstream.status)) return publicNotFound();
    deps.log("share.cover_fetch_failed", { status: upstream.status });
    return publicJson({ error: "cover_unavailable" }, 502);
  }
  const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > COVER_MAX_PROXY_BYTES) {
    void upstream.body.cancel().catch(() => {});
    deps.log("share.cover_too_large", { declaredLength });
    return publicJson({ error: "cover_unavailable" }, 502);
  }
  // Le type est imposé (pipeline de recompression : toujours du WebP), jamais relayé ; le chemin
  // Storage (qui embarque le `user_id`) n'apparaît dans AUCUN en-tête de réponse.
  return new Response(upstream.body, {
    status: 200,
    headers: publicHeaders({ "Content-Type": "image/webp" }),
  });
};

// ---------------------------------------------------------------------------
// Routes privées : session, CSRF, corps plafonné
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type JsonBody =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> }
  | { readonly kind: "too_large" }
  | { readonly kind: "invalid" };

/** Lit le corps en le plafonnant (`Content-Length` déclaré puis flux interrompu au-delà). */
const readJsonRecord = async (request: Request): Promise<JsonBody> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { kind: "too_large" };
  if (request.body === null) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
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
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? { kind: "ok", body: parsed } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
};

/** Garde commune : (CSRF des mutations) → session → base disponible. */
type PrivateContext =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly displayName: string | null;
      readonly cookies: ReadonlyArray<string>;
      readonly owner: ShareOwnerServices;
    }
  | { readonly ok: false; readonly response: Response };

const preparePrivate = async (
  request: Request,
  deps: ShareServerDeps,
  operation: string,
  options: { readonly mutation: boolean; readonly emptyWithoutDatabase?: boolean },
): Promise<PrivateContext> => {
  // CSRF : une mutation n'est acceptée que depuis l'origine de l'application.
  if (
    options.mutation &&
    !isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))
  ) {
    return { ok: false, response: privateJson({ error: "forbidden_origin" }, 403) };
  }
  const session = await getServerSession(request, deps.auth);
  if (session === null) return { ok: false, response: unauthorized() };
  const cookies = session.refreshedCookies ?? [];
  if (deps.owner === null) {
    deps.log("share.database_url_missing", { operation });
    return {
      ok: false,
      response:
        options.emptyWithoutDatabase === true
          ? privateJson(
              {
                links: [],
                owner: { displayName: session.user.displayName },
              } satisfies ShareLinksPayload,
              200,
              cookies,
            )
          : unavailable(cookies),
    };
  }
  return {
    ok: true,
    userId: session.user.id,
    displayName: session.user.displayName,
    cookies,
    owner: deps.owner,
  };
};

/** Lien du service → forme exposée au propriétaire (sans `userId`) + titre du classeur. */
const toEntry = (link: ShareLink, titles: Readonly<Record<string, string>>): ShareLinkEntry => {
  const { userId: _userId, ...rest } = link;
  return { ...rest, binderTitle: titles[link.binderId] ?? null };
};

/** Titres des classeurs ; un échec n'empêche jamais la réponse (titre `null`). */
const enrich = async (
  ctx: Extract<PrivateContext, { ok: true }>,
  links: ReadonlyArray<ShareLink>,
  deps: ShareServerDeps,
): Promise<ReadonlyArray<ShareLinkEntry>> => {
  const ids = [...new Set(links.map((link) => link.binderId))];
  const exit = await Effect.runPromiseExit(ctx.owner.binderTitles(ctx.userId, ids));
  if (!Exit.isSuccess(exit)) {
    deps.log("share.query_failed", { operation: "titles", ...extractErrorMeta(exit.cause) });
    return links.map((link) => toEntry(link, {}));
  }
  return links.map((link) => toEntry(link, exit.value));
};

interface HttpFailure {
  readonly status: number;
  readonly error: string;
}

/** Erreur typée du `ShareService` → réponse HTTP, ou `null` si elle doit rester une 503 loguée. */
const failureToHttp = (cause: Cause.Cause<unknown>): HttpFailure | null => {
  const failure = Cause.squash(cause);
  if (failure instanceof ValidationError) return { status: 400, error: "invalid_input" };
  // Lien / classeur absent ou d'un autre utilisateur : indiscernables (jamais de 403 d'existence).
  if (failure instanceof BinderNotFoundError || failure instanceof ShareLinkNotFoundError) {
    return { status: 404, error: "not_found" };
  }
  if (failure instanceof ShareLinkForbiddenError) return { status: 403, error: "forbidden" };
  return null;
};

const failureResponse = (
  cause: Cause.Cause<unknown>,
  deps: ShareServerDeps,
  operation: string,
  cookies: ReadonlyArray<string>,
): Response => {
  const mapped = failureToHttp(cause);
  if (mapped !== null) return privateJson({ error: mapped.error }, mapped.status, cookies);
  deps.log("share.query_failed", { operation, ...extractErrorMeta(cause) });
  return unavailable(cookies);
};

const bodyError = (body: JsonBody, cookies: ReadonlyArray<string>): Response | null => {
  if (body.kind === "too_large") return privateJson({ error: "payload_too_large" }, 413, cookies);
  if (body.kind === "invalid") return privateJson({ error: "invalid_input" }, 400, cookies);
  return null;
};

// ---------------------------------------------------------------------------
// GET /api/share-links[?binderId=...]
// ---------------------------------------------------------------------------

export const handleListShareLinks = async (
  request: Request,
  deps: ShareServerDeps,
): Promise<Response> => {
  const ctx = await preparePrivate(request, deps, "list", {
    mutation: false,
    emptyWithoutDatabase: true,
  });
  if (!ctx.ok) return ctx.response;

  const binderId = new URL(request.url).searchParams.get("binderId");
  if (binderId !== null && !isUuid(binderId)) {
    return privateJson({ error: "invalid_input" }, 400, ctx.cookies);
  }
  const exit = await Effect.runPromiseExit(
    ctx.owner.share.listLinks(ctx.userId, binderId === null ? {} : { binderId }),
  );
  if (!Exit.isSuccess(exit)) return failureResponse(exit.cause, deps, "list", ctx.cookies);
  // Défense en profondeur : seuls les liens de l'utilisateur courant sont jamais renvoyés.
  const own = exit.value.filter((link) => link.userId.toLowerCase() === ctx.userId.toLowerCase());
  const payload: ShareLinksPayload = {
    links: await enrich(ctx, own, deps),
    owner: { displayName: ctx.displayName },
  };
  return privateJson(payload, 200, ctx.cookies);
};

// ---------------------------------------------------------------------------
// POST /api/share-links
// ---------------------------------------------------------------------------

export const handleCreateShareLink = async (
  request: Request,
  deps: ShareServerDeps,
): Promise<Response> => {
  const ctx = await preparePrivate(request, deps, "create", { mutation: true });
  if (!ctx.ok) return ctx.response;

  const body = await readJsonRecord(request);
  const invalid = bodyError(body, ctx.cookies);
  if (invalid !== null) return invalid;
  if (body.kind !== "ok") return privateJson({ error: "invalid_input" }, 400, ctx.cookies);

  const binderId = body.body["binderId"];
  const showQuantities = body.body["showQuantities"];
  if (
    typeof binderId !== "string" ||
    !isUuid(binderId) ||
    (showQuantities !== undefined && typeof showQuantities !== "boolean")
  ) {
    return privateJson({ error: "invalid_input" }, 400, ctx.cookies);
  }

  const exit = await Effect.runPromiseExit(
    ctx.owner.share.createLink(ctx.userId, {
      binderId,
      ...(showQuantities === undefined ? {} : { showQuantities }),
    }),
  );
  if (!Exit.isSuccess(exit)) return failureResponse(exit.cause, deps, "create", ctx.cookies);
  const [link] = await enrich(ctx, [exit.value], deps);
  return privateJson({ link }, 201, ctx.cookies);
};

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/share-links/$id
// ---------------------------------------------------------------------------

export const handleUpdateShareLink = async (
  request: Request,
  linkId: string,
  deps: ShareServerDeps,
): Promise<Response> => {
  const ctx = await preparePrivate(request, deps, "update", { mutation: true });
  if (!ctx.ok) return ctx.response;
  // Un identifiant non UUID ne peut désigner aucun lien.
  if (!isUuid(linkId)) return privateJson({ error: "not_found" }, 404, ctx.cookies);

  const body = await readJsonRecord(request);
  const invalid = bodyError(body, ctx.cookies);
  if (invalid !== null) return invalid;
  if (body.kind !== "ok") return privateJson({ error: "invalid_input" }, 400, ctx.cookies);
  const showQuantities = body.body["showQuantities"];
  if (typeof showQuantities !== "boolean") {
    return privateJson({ error: "invalid_input" }, 400, ctx.cookies);
  }

  const exit = await Effect.runPromiseExit(
    ctx.owner.share.updateShowQuantities(ctx.userId, linkId, showQuantities),
  );
  if (!Exit.isSuccess(exit)) return failureResponse(exit.cause, deps, "update", ctx.cookies);
  const [link] = await enrich(ctx, [exit.value], deps);
  return privateJson({ link }, 200, ctx.cookies);
};

export const handleRevokeShareLink = async (
  request: Request,
  linkId: string,
  deps: ShareServerDeps,
): Promise<Response> => {
  const ctx = await preparePrivate(request, deps, "revoke", { mutation: true });
  if (!ctx.ok) return ctx.response;
  if (!isUuid(linkId)) return privateJson({ error: "not_found" }, 404, ctx.cookies);

  const exit = await Effect.runPromiseExit(ctx.owner.share.revokeLink(ctx.userId, linkId));
  if (!Exit.isSuccess(exit)) return failureResponse(exit.cause, deps, "revoke", ctx.cookies);
  const [link] = await enrich(ctx, [exit.value], deps);
  return privateJson({ link }, 200, ctx.cookies);
};
