/**
 * Accès serveur des écrans `06A–06C` (Wishlist & Export Cardmarket) : handlers
 * `Request → Response` des routes `/api/wishlist/*`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par les routes
 * `routes/api/wishlist/*` (handlers `server`, retirés du bundle client) — jamais
 * par un composant ou un module client (le client passe par `wishlist-client.ts`).
 *
 * Sécurité : toutes les routes exigent une session SSR valide (`getServerSession`,
 * 401 sinon, cookies rafraîchis propagés via `Set-Cookie` sur TOUTES les réponses +
 * `Cache-Control: no-store`) ; les mutations (POST/PATCH/DELETE) vérifient en plus
 * l'origine (CSRF, `isRequestSameOrigin`, 403) et plafonnent le corps JSON
 * (8 KiB réels, lecture streamée → 413). Lecture/écriture dans la transaction
 * `withUserRls` (rôle `authenticated`, `auth.uid() = user_id`) avec filtre explicite
 * `user_id` partout. Erreur SQL → 503 sans aucun détail. Réf. : docs/01 §8,
 * docs/04 §2.1–§2.2, docs/06 §1–§2.
 */

import {
  type AddWishlistItemInput,
  CatalogItemNotFoundError,
  isUuid,
  type MarkWishlistAcquiredInput,
  type UpdateWishlistItemInput,
  ValidationError,
  type WishlistItem,
  WishlistItemConflictError,
  WishlistItemNotFoundError,
  WishlistQuantityOverflowError,
} from "@pokevault/domain";
import {
  Database,
  DatabaseLive,
  type Sql,
  WishlistService,
  WishlistServiceLive,
  type WishlistServiceShape,
  withUserRls,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import type {
  WishlistEnrichedItem,
  WishlistPayload,
  WishlistPriceSource,
} from "./wishlist-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type WishlistLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface WishlistServerDeps {
  readonly auth: AuthDeps;
  /**
   * Service Postgres + pool SQL, ou `null` quand aucune base n'est configurée
   * (`DATABASE_URL` absent en dev/test) : les routes répondent alors 503.
   */
  readonly services: {
    readonly wishlist: WishlistServiceShape;
    readonly sql: Sql;
  } | null;
  readonly log: WishlistLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: WishlistLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

// ---------------------------------------------------------------------------
// Pool Postgres live, mis en cache sur globalThis (pattern `card-detail-server.ts`)
// ---------------------------------------------------------------------------

type LiveServices = NonNullable<WishlistServerDeps["services"]>;

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WishlistService | Database, never>;
  readonly services: Promise<LiveServices>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultWishlistRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

/**
 * Pool `postgres.js` paresseux (`role: "authenticated"` : RLS à moindre privilège) +
 * `WishlistServiceLive`, mis en cache sur `globalThis` pour survivre au HMR Vite sans
 * fuiter de pools ; une promesse rejetée est immédiatement purgée du cache.
 */
const getLiveServices = (databaseUrl: string): Promise<LiveServices> => {
  const existing = readCachedRuntime();
  if (existing !== undefined && existing.url === databaseUrl) return existing.services;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const layer = WishlistServiceLive.pipe(
    Layer.provideMerge(
      DatabaseLive({ connectionString: databaseUrl, maxConnections: 5, role: "authenticated" }),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const services = runtime
    .runPromise(
      Effect.gen(function* () {
        const wishlist = yield* WishlistService;
        const { sql } = yield* Database;
        return { wishlist, sql };
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

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`). */
export const defaultWishlistDeps = async (): Promise<WishlistServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth,
    services:
      databaseUrl === undefined || databaseUrl === "" ? null : await getLiveServices(databaseUrl),
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

/** Liste : `private, no-store` (donnée personnelle, jamais mise en cache partagée). */
const jsonPrivate = (body: unknown, cookies: ReadonlyArray<string>): Response => {
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status: 200, headers });
};

const noContent = (cookies: ReadonlyArray<string>): Response => {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
};

const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

const forbiddenOrigin = (): Response => json({ error: "forbidden_origin" }, 403);

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "wishlist_unavailable" }, 503, cookies);

/** Métadonnées d'erreur sûres à journaliser (jamais de message SQL). */
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

/** Plafond du corps JSON des mutations (8 KiB → 413 au-delà). */
export const MAX_BODY_BYTES = 8192;

export type ParsedBody =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: 400 | 413 };

/**
 * Lit un corps JSON borné en octets réels :
 * - vérifie d'abord `content-length` déclaré (> plafond → 413) ;
 * - lit le flux chunk par chunk et interrompt (`reader.cancel()`) dès que le cumul
 *   dépasse `MAX_BODY_BYTES` (jamais un corps illimité en mémoire, y compris chunked
 *   sans `content-length`) ;
 * - erreur de lecture du flux ou JSON illisible → 400 (jamais 500) ;
 * - `allowEmpty` : un corps vide (ou blanc) vaut `{}` (corps optionnel).
 */
export const readJsonBody = async (
  request: Request,
  options: { readonly allowEmpty?: boolean } = {},
): Promise<ParsedBody> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  let bytes: Uint8Array;
  if (request.body === null) {
    bytes = new Uint8Array(0);
  } else {
    const reader = request.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return { ok: false, status: 413 };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, status: 400 };
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (options.allowEmpty === true && text.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Traduit une erreur typée du domaine en réponse HTTP (jamais de détail SQL en 503).
 * `ValidationError` → 400, introuvable → 404, conflit / dépassement de quantité → 409.
 */
const failureResponse = (
  failure: unknown,
  cause: Cause.Cause<unknown>,
  cookies: ReadonlyArray<string>,
  deps: WishlistServerDeps,
  operation: string,
  extra?: Readonly<Record<string, unknown>>,
): Response => {
  if (failure instanceof ValidationError) return json({ error: "invalid_input" }, 400, cookies);
  if (failure instanceof WishlistItemNotFoundError || failure instanceof CatalogItemNotFoundError) {
    return json({ error: "not_found" }, 404, cookies);
  }
  if (
    failure instanceof WishlistItemConflictError ||
    failure instanceof WishlistQuantityOverflowError
  ) {
    return json({ error: "conflict" }, 409, cookies);
  }
  deps.log("wishlist.query_failed", { operation, ...extra, ...extractErrorMeta(cause) });
  return unavailable(cookies);
};

interface Guard {
  readonly cookies: ReadonlyArray<string>;
  readonly userId: string;
}

/** Lecture : session (401). */
const checkRead = async (request: Request, deps: WishlistServerDeps): Promise<Guard | Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  return { cookies: session.refreshedCookies ?? [], userId: session.user.id };
};

/** Mutations : CSRF (403 cross-origin) puis session (401). */
const checkMutation = async (
  request: Request,
  deps: WishlistServerDeps,
): Promise<Guard | Response> => {
  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return forbiddenOrigin();
  }
  return checkRead(request, deps);
};

const bodyErrorResponse = (status: 400 | 413, cookies: ReadonlyArray<string>): Response =>
  json({ error: status === 413 ? "payload_too_large" : "invalid_input" }, status, cookies);

// ---------------------------------------------------------------------------
// GET /api/wishlist
// ---------------------------------------------------------------------------

interface WishlistEnrichedRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly language: WishlistItem["language"];
  readonly variant: WishlistItem["variant"];
  readonly min_condition: WishlistItem["minCondition"];
  readonly priority: WishlistItem["priority"];
  readonly target_price_cents: number | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly local_id: string;
  readonly name_fr: string;
  readonly name_en: string | null;
  readonly rarity: string | null;
  readonly image_base_url: string | null;
  readonly set_id: string;
  readonly set_code: string | null;
  readonly cardmarket_set_code: string | null;
  readonly set_name_fr: string;
  readonly trend_cents: number | null;
  readonly low_fr_cents: number | null;
  readonly avg30_cents: number | null;
  readonly price_source: WishlistPriceSource | null;
  readonly price_fetched_at: Date | string | null;
  readonly price_expires_at: Date | string | null;
  readonly price_is_fresh: boolean | null;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

const toEnrichedItem = (row: WishlistEnrichedRow): WishlistEnrichedItem => ({
  id: row.id,
  userId: row.user_id,
  cardId: row.card_id,
  language: row.language,
  variant: row.variant,
  minCondition: row.min_condition,
  priority: row.priority,
  targetPriceCents: row.target_price_cents,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  localId: row.local_id,
  nameFr: row.name_fr,
  nameEn: row.name_en,
  rarity: row.rarity,
  imageBaseUrl: row.image_base_url,
  setId: row.set_id,
  setCode: row.set_code,
  cardmarketSetCode: row.cardmarket_set_code,
  setNameFr: row.set_name_fr,
  trendCents: row.trend_cents,
  lowFrCents: row.low_fr_cents,
  avg30Cents: row.avg30_cents,
  priceSource: row.price_source,
  priceFetchedAt: isoOrNull(row.price_fetched_at),
  priceExpiresAt: isoOrNull(row.price_expires_at),
  priceIsFresh: row.price_is_fresh,
});

/**
 * Souhaits de l'utilisateur + carte + extension + dernier prix. `card_latest_prices` est
 * jointe en `LEFT JOIN LATERAL (... LIMIT 1)` : le `LIMIT 1` empêche Postgres de remonter la
 * sous-requête latérale et pousse `(card_id, language, variant)` dans la vue `DISTINCT ON`
 * (Index Scan O(1) par souhait sur `idx_price_snapshots_lookup`, jamais un balayage complet
 * de `price_snapshots`) ; sans snapshot, tous les champs prix valent `null`.
 * Tri `priority ASC` (`high` < `normal`) puis récents d'abord : `idx_wishlist_items_user_priority`.
 */
const loadWishlist = async (
  tx: Sql,
  userId: string,
): Promise<ReadonlyArray<WishlistEnrichedItem>> => {
  const rows = await tx<WishlistEnrichedRow[]>`
    select w.id, w.user_id, w.card_id, w.language, w.variant, w.min_condition,
           w.priority, w.target_price_cents, w.created_at, w.updated_at,
           c.local_id, c.name_fr, c.name_en, c.rarity, c.image_base_url,
           s.id as set_id, s.code as set_code, s.cardmarket_code as cardmarket_set_code,
           s.name_fr as set_name_fr,
           p.trend_cents, p.low_fr_cents, p.avg30_cents, p.source as price_source,
           p.fetched_at as price_fetched_at, p.expires_at as price_expires_at,
           p.is_fresh as price_is_fresh
      from public.wishlist_items w
      join public.catalog_cards c on c.id = w.card_id
      join public.catalog_sets s on s.id = c.set_id
      left join lateral (
        select lp.trend_cents, lp.low_fr_cents, lp.avg30_cents, lp.source,
               lp.fetched_at, lp.expires_at, lp.is_fresh
          from public.card_latest_prices lp
         where lp.card_id = w.card_id and lp.language = w.language and lp.variant = w.variant
         limit 1
      ) p on true
     where w.user_id = ${userId}
     order by w.priority asc, w.created_at desc, w.id desc`;
  return rows.map(toEnrichedItem);
};

/**
 * Handler `GET /api/wishlist` : 401 sans session ; 200 + `{ items }` (souhaits enrichis
 * des métadonnées carte / extension et du dernier prix) ; `Cache-Control: private,
 * no-store` ; 503 sans détail SQL (ou sans `DATABASE_URL`).
 */
export const handleListWishlist = async (
  request: Request,
  deps: WishlistServerDeps,
): Promise<Response> => {
  const guard = await checkRead(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  if (deps.services === null) {
    deps.log("wishlist.database_url_missing", { operation: "list" });
    return unavailable(cookies);
  }
  const exit = await Effect.runPromiseExit(
    withUserRls(deps.services.sql, userId, (tx) => loadWishlist(tx, userId)),
  );
  if (Exit.isFailure(exit)) {
    deps.log("wishlist.query_failed", { operation: "list", ...extractErrorMeta(exit.cause) });
    return unavailable(cookies);
  }
  const payload: WishlistPayload = { items: exit.value };
  return jsonPrivate(payload, cookies);
};

// ---------------------------------------------------------------------------
// POST /api/wishlist
// ---------------------------------------------------------------------------

/**
 * Handler `POST /api/wishlist` via `WishlistService.addWishlistItem` : 403 CSRF, 401,
 * 413 (> 8 KiB), 400 (`ValidationError`), 404 (`CatalogItemNotFoundError`), 409
 * (`WishlistItemConflictError`), 201 + `WishlistItem`.
 */
export const handleAddWishlistItem = async (
  request: Request,
  deps: WishlistServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  if (deps.services === null) {
    deps.log("wishlist.database_url_missing", { operation: "add" });
    return unavailable(cookies);
  }

  // Le service décode/valide via `decodeAddWishlistItemInput` (ValidationError → 400).
  const exit = await Effect.runPromiseExit(
    deps.services.wishlist.addWishlistItem(userId, parsed.body as AddWishlistItemInput),
  );
  if (Exit.isSuccess(exit)) return json(exit.value, 201, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "add");
};

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/wishlist/$id
// ---------------------------------------------------------------------------

/**
 * Handler `PATCH /api/wishlist/$id` via `WishlistService.updateWishlistItem` : 403 CSRF,
 * 401, 413, 400, 404 (`WishlistItemNotFoundError`, id non UUID inclus), 409, 200 +
 * `WishlistItem`.
 */
export const handleUpdateWishlistItem = async (
  request: Request,
  itemId: string,
  deps: WishlistServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  if (!isUuid(itemId)) return json({ error: "not_found" }, 404, cookies);
  if (deps.services === null) {
    deps.log("wishlist.database_url_missing", { operation: "update", itemId });
    return unavailable(cookies);
  }

  const exit = await Effect.runPromiseExit(
    deps.services.wishlist.updateWishlistItem(
      userId,
      itemId,
      parsed.body as UpdateWishlistItemInput,
    ),
  );
  if (Exit.isSuccess(exit)) return json(exit.value, 200, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "update", {
    itemId,
  });
};

/**
 * Handler `DELETE /api/wishlist/$id` via `WishlistService.removeWishlistItem` : 403 CSRF,
 * 401, 404 (`WishlistItemNotFoundError`), 204.
 */
export const handleDeleteWishlistItem = async (
  request: Request,
  itemId: string,
  deps: WishlistServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  if (!isUuid(itemId)) return json({ error: "not_found" }, 404, cookies);
  if (deps.services === null) {
    deps.log("wishlist.database_url_missing", { operation: "delete", itemId });
    return unavailable(cookies);
  }
  const exit = await Effect.runPromiseExit(
    deps.services.wishlist.removeWishlistItem(userId, itemId),
  );
  if (Exit.isSuccess(exit)) return noContent(cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "delete", {
    itemId,
  });
};

// ---------------------------------------------------------------------------
// POST /api/wishlist/$id/acquire
// ---------------------------------------------------------------------------

/**
 * Handler `POST /api/wishlist/$id/acquire` (bascule 1-tap « ✓ Acquise ») via
 * `WishlistService.markAcquired` : corps JSON optionnel (`{}` ou vide) ; 403 CSRF, 401,
 * 413, 400, 404 (`WishlistItemNotFoundError`), 409 (`WishlistQuantityOverflowError`),
 * 200 + `{ removedWishlistItemId, copy, setBinderId }`.
 */
export const handleAcquireWishlistItem = async (
  request: Request,
  itemId: string,
  deps: WishlistServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request, { allowEmpty: true });
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  if (!isUuid(itemId)) return json({ error: "not_found" }, 404, cookies);
  if (deps.services === null) {
    deps.log("wishlist.database_url_missing", { operation: "acquire", itemId });
    return unavailable(cookies);
  }

  // L'identifiant de l'URL prime toujours sur un éventuel `wishlistItemId` du corps.
  const input = { ...parsed.body, wishlistItemId: itemId };
  const exit = await Effect.runPromiseExit(
    deps.services.wishlist.markAcquired(userId, input as MarkWishlistAcquiredInput),
  );
  if (Exit.isSuccess(exit)) return json(exit.value, 200, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "acquire", {
    itemId,
  });
};
