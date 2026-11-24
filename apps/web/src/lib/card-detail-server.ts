/**
 * Accès serveur de la Bottom Sheet `04 · Fiche Carte` : handlers
 * `Request → Response` des routes `/api/cards/*`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par les routes
 * `routes/api/cards/*` (handlers `server`, retirés du bundle client) — jamais
 * par un composant ou un module client (le client passe par `card-detail-client.ts`).
 *
 * Sécurité : toutes les routes exigent une session SSR valide (`getServerSession`,
 * 401 sinon, cookies rafraîchis propagés via `Set-Cookie` + `Cache-Control: no-store`) ;
 * les mutations (POST/PATCH/DELETE) vérifient en plus l'origine (CSRF,
 * `isRequestSameOrigin`, 403) et plafonnent le corps JSON (8 KiB → 413 ; 4 KiB pour `price-refresh`).
 * Lecture/écriture dans la transaction `withUserRls` (rôle `authenticated`,
 * `auth.uid() = userId`) avec filtre explicite `user_id` partout. Erreur SQL →
 * 503 sans aucun détail. Réf. : docs/01 §5.2, docs/02, docs/06 §1–§2.
 */

import {
  BinderConflictError,
  BinderNotFoundError,
  CardCopyConflictError,
  CardCopyNotFoundError,
  CardLanguage,
  CardVariant,
  CatalogItemNotFoundError,
  InvalidCoverImageError,
  isUuid,
  PriceCircuitOpenError,
  PriceRefreshCooldownError,
  type PriceRefreshTarget,
  type PriceSnapshot,
  UnauthorizedBinderAccess,
  type UpsertCardCopyInput,
  ValidationError,
} from "@pokevault/domain";
import {
  BinderCoverStorageLive,
  BinderService,
  BinderServiceLive,
  type BinderServiceShape,
  CardmarketFetcherLive,
  CardmarketPriceService,
  CardmarketPriceServiceLive,
  type CardmarketPriceServiceShape,
  CollectionService,
  CollectionServiceLive,
  type CollectionServiceShape,
  CoverImageProcessor,
  Database,
  DatabaseLive,
  PriceSnapshotStoreLive,
  type Sql,
  TcgdexPriceFallbackLive,
  withUserRls,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import type {
  CardDetailBinder,
  CardDetailCard,
  CardDetailPayload,
  CardDetailPrice,
} from "./card-detail-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type CardDetailLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface CardDetailServerDeps {
  readonly auth: AuthDeps;
  /**
   * Services Postgres + pool SQL, ou `null` quand aucune base n'est configurée
   * (`DATABASE_URL` absent en dev/test) : les routes répondent alors 503.
   */
  readonly services: {
    readonly collection: CollectionServiceShape;
    readonly binders: BinderServiceShape;
    readonly sql: Sql;
  } | null;
  readonly log: CardDetailLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: CardDetailLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

// ---------------------------------------------------------------------------
// Pool Postgres live, mis en cache sur globalThis (pattern `binders-server.ts`)
// ---------------------------------------------------------------------------

type LiveServices = NonNullable<CardDetailServerDeps["services"]>;

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    BinderService | CollectionService | Database,
    never
  >;
  readonly services: Promise<LiveServices>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultCardDetailRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

/**
 * Le processeur `sharp` (binaire natif) reste hors de cette route : aucun upload
 * de cover n'est possible ici.
 */
const CoverUploadDisabled = Layer.succeed(CoverImageProcessor, {
  process: () =>
    Effect.fail(
      new InvalidCoverImageError({
        reason: "unsupported_format",
        message: "cover upload is not enabled on /api/cards",
      }),
    ),
});

/**
 * Pool `postgres.js` paresseux (`role: "authenticated"` : RLS à moindre
 * privilège) + `CollectionServiceLive` + `BinderServiceLive`, mis en cache sur
 * `globalThis` pour survivre au HMR Vite sans fuiter de pools ; une promesse
 * rejetée est immédiatement purgée du cache et le runtime éliminé.
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
        const collection = yield* CollectionService;
        const binders = yield* BinderService;
        const { sql } = yield* Database;
        return { collection, binders, sql };
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
export const defaultCardDetailDeps = async (): Promise<CardDetailServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth,
    services:
      databaseUrl === undefined || databaseUrl === ""
        ? null
        : await getLiveServices(databaseUrl, auth),
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

const noContent = (cookies: ReadonlyArray<string>): Response => {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
};

const unauthorized = (): Response => json({ error: "unauthorized" }, 401, "no-store");

const forbiddenOrigin = (): Response => json({ error: "forbidden_origin" }, 403, "no-store");

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "card_detail_unavailable" }, 503, "no-store", cookies);

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

export interface ReadJsonBodyOptions {
  /** Plafond du corps en octets (défaut : {@link MAX_BODY_BYTES}). */
  readonly maxBytes?: number | undefined;
  /** Un corps totalement vide est accepté (`body: undefined`) au lieu de 400. */
  readonly allowEmpty?: boolean | undefined;
}

/**
 * Lit un corps JSON borné en octets réels :
 * - vérifie d'abord `content-length` déclaré (> plafond → 413) ;
 * - lit le flux chunk par chunk et interrompt dès que le cumul dépasse
 *   `MAX_BODY_BYTES` (jamais un corps illimité en mémoire, y compris chunked
 *   sans `content-length`) ;
 * - erreur de lecture du flux ou JSON illisible → 400 (jamais 500).
 */
export const readJsonBody = async (
  request: Request,
  options: ReadJsonBodyOptions = {},
): Promise<ParsedBody> => {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
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
        if (total > maxBytes) {
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
  if (options.allowEmpty === true && text.trim() === "") return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Traduit une erreur typée du domaine en réponse HTTP (jamais de détail SQL en
 * 503). `ValidationError` → 400, introuvable → 404, conflit → 409, refus RLS → 403.
 */
const failureResponse = (
  failure: unknown,
  cause: Cause.Cause<unknown>,
  cookies: ReadonlyArray<string>,
  deps: CardDetailServerDeps,
  operation: string,
  extra?: Readonly<Record<string, unknown>>,
): Response => {
  if (failure instanceof ValidationError) {
    return json({ error: "invalid_input" }, 400, "no-store", cookies);
  }
  if (
    failure instanceof CardCopyNotFoundError ||
    failure instanceof BinderNotFoundError ||
    failure instanceof CatalogItemNotFoundError
  ) {
    return json({ error: "not_found" }, 404, "no-store", cookies);
  }
  if (failure instanceof CardCopyConflictError || failure instanceof BinderConflictError) {
    return json({ error: "conflict" }, 409, "no-store", cookies);
  }
  if (failure instanceof UnauthorizedBinderAccess) {
    return json({ error: "forbidden" }, 403, "no-store", cookies);
  }
  deps.log("cardDetail.query_failed", { operation, ...extra, ...extractErrorMeta(cause) });
  return unavailable(cookies);
};

/** Mutations : CSRF (403 cross-origin) puis session (401). */
const checkMutation = async (
  request: Request,
  deps: CardDetailServerDeps,
): Promise<{ readonly cookies: ReadonlyArray<string>; readonly userId: string } | Response> => {
  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return forbiddenOrigin();
  }
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  return { cookies: session.refreshedCookies ?? [], userId: session.user.id };
};

// ---------------------------------------------------------------------------
// Chargement RLS (transaction)
// ---------------------------------------------------------------------------

interface CatalogCardRow {
  readonly id: string;
  readonly set_id: string;
  readonly local_id: string;
  readonly name_fr: string;
  readonly name_en: string | null;
  readonly rarity: string | null;
  readonly holo_effect: string;
  readonly category: string;
  readonly types: ReadonlyArray<string>;
  readonly hp: number | null;
  readonly illustrator: string | null;
  readonly image_base_url: string | null;
  readonly available_variants: ReadonlyArray<string>;
  readonly cardmarket_url: string | null;
  readonly set_name_fr: string;
  readonly set_code: string | null;
  readonly set_official_count: number;
  readonly set_total_count: number;
  /** Colonnes de la jointure latérale `card_latest_prices` (absentes / `null` sans snapshot). */
  readonly price_source?: string | null;
  readonly price_trend_cents?: number | null;
  readonly price_low_fr_cents?: number | null;
  readonly price_avg30_cents?: number | null;
  readonly price_fetched_at?: Date | string | null;
  readonly price_expires_at?: Date | string | null;
  readonly price_is_fresh?: boolean | null;
}

interface CustomBinderRow {
  readonly id: string;
  readonly title: string;
  readonly contains_card: boolean;
}

const isoOf = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Convertit un snapshot de `card_latest_prices` en prix du payload (`null` sans snapshot). */
export const toCardDetailPrice = (
  row: Pick<
    CatalogCardRow,
    | "price_source"
    | "price_trend_cents"
    | "price_low_fr_cents"
    | "price_avg30_cents"
    | "price_fetched_at"
    | "price_expires_at"
    | "price_is_fresh"
  >,
): CardDetailPrice | null => {
  const source = row.price_source;
  const fetchedAt = row.price_fetched_at;
  const expiresAt = row.price_expires_at;
  if (
    (source !== "cardmarket" && source !== "tcgdex_fallback") ||
    fetchedAt === null ||
    fetchedAt === undefined ||
    expiresAt === null ||
    expiresAt === undefined
  ) {
    return null;
  }
  return {
    trendCents: row.price_trend_cents ?? null,
    lowFrCents: row.price_low_fr_cents ?? null,
    avg30Cents: row.price_avg30_cents ?? null,
    source,
    fetchedAt: isoOf(fetchedAt),
    expiresAt: isoOf(expiresAt),
    isFresh: row.price_is_fresh ?? false,
  };
};

/**
 * Carte du catalogue + extension + dernier prix, ou `null` si inconnue.
 *
 * `card_latest_prices` est jointe en `LEFT JOIN LATERAL (… LIMIT 1)` : le `LIMIT 1`
 * pousse `card_id` dans la vue `DISTINCT ON` (Index Scan sur
 * `idx_price_snapshots_lookup`, jamais un balayage de `price_snapshots`). Le
 * snapshot `(FR, normal)` est préféré, sinon le plus récent de la carte.
 */
const loadCard = async (
  tx: Sql,
  cardId: string,
): Promise<Pick<CardDetailPayload, "card" | "price"> | null> => {
  const rows = await tx<CatalogCardRow[]>`
    select c.id, c.set_id, c.local_id, c.name_fr, c.name_en, c.rarity, c.holo_effect,
           c.category, c.types, c.hp, c.illustrator, c.image_base_url,
           c.available_variants, c.cardmarket_url,
           s.name_fr as set_name_fr, s.code as set_code,
           s.official_count as set_official_count, s.total_count as set_total_count,
           p.source as price_source, p.trend_cents as price_trend_cents,
           p.low_fr_cents as price_low_fr_cents, p.avg30_cents as price_avg30_cents,
           p.fetched_at as price_fetched_at, p.expires_at as price_expires_at,
           p.is_fresh as price_is_fresh
      from public.catalog_cards c
      join public.catalog_sets s on s.id = c.set_id
      left join lateral (
        select lp.source, lp.trend_cents, lp.low_fr_cents, lp.avg30_cents,
               lp.fetched_at, lp.expires_at, lp.is_fresh
          from public.card_latest_prices lp
         where lp.card_id = c.id
         order by (lp.language = 'FR' and lp.variant = 'normal') desc,
                  lp.fetched_at desc, lp.id desc
         limit 1
      ) p on true
     where c.id = ${cardId}`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    card: {
      id: row.id,
      setId: row.set_id,
      setNameFr: row.set_name_fr,
      setCode: row.set_code,
      officialCount: row.set_official_count,
      totalCount: row.set_total_count,
      localId: row.local_id,
      nameFr: row.name_fr,
      nameEn: row.name_en,
      rarity: row.rarity,
      holoEffect: row.holo_effect,
      category: row.category,
      types: row.types,
      hp: row.hp,
      illustrator: row.illustrator,
      imageBaseUrl: row.image_base_url,
      availableVariants: row.available_variants as CardDetailCard["availableVariants"],
      cardmarketUrl: row.cardmarket_url,
    },
    price: toCardDetailPrice(row),
  };
};

/** Dossiers perso de l'utilisateur avec flag `containsCard` (jointure `binder_cards`). */
const loadCustomBinders = async (
  tx: Sql,
  userId: string,
  cardId: string,
): Promise<ReadonlyArray<CardDetailBinder>> => {
  const rows = await tx<CustomBinderRow[]>`
    select b.id, b.title, (bc.card_id is not null) as contains_card
      from public.binders b
      left join public.binder_cards bc on bc.binder_id = b.id and bc.card_id = ${cardId}
     where b.user_id = ${userId} and b.kind = 'custom'
     order by b.is_pinned desc, b.sort_order asc, b.created_at desc, b.id asc`;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    containsCard: row.contains_card,
  }));
};

// ---------------------------------------------------------------------------
// GET /api/cards/$cardId
// ---------------------------------------------------------------------------

/**
 * Handler `GET /api/cards/$cardId` :
 * - 401 sans session SSR valide (cookies rafraîchis propagés sinon) ;
 * - 404 si la carte est inconnue du catalogue ;
 * - 200 + `CardDetailPayload` (métadonnées TCGdex, exemplaires, dossiers perso
 *   avec `containsCard`) ; `Cache-Control: no-store` ;
 * - 503 sans détail SQL en cas d'échec Postgres (ou sans `DATABASE_URL`).
 */
export const handleCardDetail = async (
  request: Request,
  cardId: string,
  deps: CardDetailServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  if (cardId.trim() === "" || /\s/.test(cardId)) {
    return json({ error: "not_found" }, 404, "no-store", cookies);
  }
  if (deps.services === null) {
    deps.log("cardDetail.database_url_missing", { operation: "detail", cardId });
    return unavailable(cookies);
  }
  const { collection, sql } = deps.services;
  const userId = session.user.id;

  const exit = await Effect.runPromiseExit(
    Effect.all(
      [
        withUserRls(sql, userId, async (tx) => {
          const loadedCard = await loadCard(tx, cardId);
          if (loadedCard === null) return null;
          const customBinders = await loadCustomBinders(tx, userId, cardId);
          return { ...loadedCard, customBinders } satisfies Pick<
            CardDetailPayload,
            "card" | "customBinders" | "price"
          >;
        }),
        collection.listCardCopies(userId, { cardId }),
      ],
      { concurrency: "unbounded" },
    ),
  );
  if (Exit.isFailure(exit)) {
    deps.log("cardDetail.query_failed", {
      operation: "detail",
      cardId,
      ...extractErrorMeta(exit.cause),
    });
    return unavailable(cookies);
  }
  const [loaded, copies] = exit.value;
  if (loaded === null) {
    return json({ error: "not_found" }, 404, "no-store", cookies);
  }
  const payload: CardDetailPayload = { ...loaded, copies };
  return json(payload, 200, "no-store", cookies);
};

// ---------------------------------------------------------------------------
// POST /api/cards/$cardId/copies
// ---------------------------------------------------------------------------

/**
 * Handler `POST /api/cards/$cardId/copies` : ajout / incrément d'un exemplaire
 * via `CollectionService.upsertCardCopy`. 403 CSRF, 401, 413 (> 8 KiB), 400
 * (`ValidationError`), 404 (`CatalogItemNotFoundError`), 201 + `UserCardCopy`.
 */
export const handleAddCardCopy = async (
  request: Request,
  cardId: string,
  deps: CardDetailServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return json(
      { error: parsed.status === 413 ? "payload_too_large" : "invalid_input" },
      parsed.status,
      "no-store",
      cookies,
    );
  }
  if (!isRecord(parsed.body)) {
    return json({ error: "invalid_input" }, 400, "no-store", cookies);
  }
  if (deps.services === null) {
    deps.log("cardDetail.database_url_missing", { operation: "add-copy", cardId });
    return unavailable(cookies);
  }

  // Le service décode/valide via `decodeUpsertCardCopyInput` (ValidationError → 400).
  // Le `cardId` de l'URL prime toujours sur un éventuel champ `cardId` du corps.
  const input = { ...parsed.body, cardId } as UpsertCardCopyInput;
  const exit = await Effect.runPromiseExit(deps.services.collection.upsertCardCopy(userId, input));
  if (Exit.isSuccess(exit)) {
    return json(exit.value, 201, "no-store", cookies);
  }
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "add-copy", {
    cardId,
  });
};

// ---------------------------------------------------------------------------
// PATCH /api/cards/copies/$copyId
// ---------------------------------------------------------------------------

/**
 * Handler `PATCH /api/cards/copies/$copyId` :
 * - corps `{ delta: number }` → `CollectionService.adjustCardCopyQuantity`,
 *   200 `{ copy, deleted }` (`copy: null` + `deleted: true` quand la quantité
 *   tombe à 0 et la ligne est supprimée) ;
 * - sinon → `CollectionService.updateCardCopy`, 200 `{ copy }`.
 * 403 CSRF, 401, 413, 400 (`ValidationError`), 404 (`CardCopyNotFoundError`),
 * 409 (`CardCopyConflictError`).
 */
export const handlePatchCardCopy = async (
  request: Request,
  copyId: string,
  deps: CardDetailServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return json(
      { error: parsed.status === 413 ? "payload_too_large" : "invalid_input" },
      parsed.status,
      "no-store",
      cookies,
    );
  }
  if (!isRecord(parsed.body)) {
    return json({ error: "invalid_input" }, 400, "no-store", cookies);
  }
  if (deps.services === null) {
    deps.log("cardDetail.database_url_missing", { operation: "patch-copy", copyId });
    return unavailable(cookies);
  }
  const { collection } = deps.services;

  const body = parsed.body;
  if (typeof body["delta"] === "number") {
    const exit = await Effect.runPromiseExit(
      collection.adjustCardCopyQuantity(userId, copyId, body["delta"]),
    );
    if (Exit.isSuccess(exit)) {
      const copy = exit.value;
      return json({ copy, deleted: copy === null }, 200, "no-store", cookies);
    }
    return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "adjust-copy", {
      copyId,
    });
  }

  const exit = await Effect.runPromiseExit(collection.updateCardCopy(userId, copyId, body));
  if (Exit.isSuccess(exit)) {
    return json({ copy: exit.value }, 200, "no-store", cookies);
  }
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "patch-copy", {
    copyId,
  });
};

// ---------------------------------------------------------------------------
// DELETE /api/cards/copies/$copyId
// ---------------------------------------------------------------------------

/**
 * Handler `DELETE /api/cards/copies/$copyId` via `CollectionService.deleteCardCopy` :
 * 403 CSRF, 401, 404 (`CardCopyNotFoundError`), 204 en cas de succès.
 */
export const handleDeleteCardCopy = async (
  request: Request,
  copyId: string,
  deps: CardDetailServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  if (deps.services === null) {
    deps.log("cardDetail.database_url_missing", { operation: "delete-copy", copyId });
    return unavailable(cookies);
  }
  const exit = await Effect.runPromiseExit(deps.services.collection.deleteCardCopy(userId, copyId));
  if (Exit.isSuccess(exit)) return noContent(cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "delete-copy", {
    copyId,
  });
};

// ---------------------------------------------------------------------------
// POST / DELETE /api/cards/$cardId/binders
// ---------------------------------------------------------------------------

/**
 * Handler `POST` / `DELETE /api/cards/$cardId/binders` avec `{ binderId }` :
 * ajout (`BinderService.addCardToCustomBinder`, 201) ou retrait
 * (`removeCardFromCustomBinder`, 204) d'un dossier perso.
 * 403 CSRF, 401, 413, 400 (corps invalide ou classeur non `custom`), 404
 * (classeur introuvable ou d'un autre utilisateur, carte inconnue).
 */
export const handleCardBinder = async (
  request: Request,
  cardId: string,
  deps: CardDetailServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return json(
      { error: parsed.status === 413 ? "payload_too_large" : "invalid_input" },
      parsed.status,
      "no-store",
      cookies,
    );
  }
  const binderId = isRecord(parsed.body) ? parsed.body["binderId"] : undefined;
  if (typeof binderId !== "string" || !isUuid(binderId)) {
    return json({ error: "invalid_input" }, 400, "no-store", cookies);
  }
  if (deps.services === null) {
    deps.log("cardDetail.database_url_missing", { operation: "card-binder", cardId });
    return unavailable(cookies);
  }
  const { binders } = deps.services;

  const isAdd = request.method === "POST";
  const exit = await Effect.runPromiseExit(
    isAdd
      ? binders.addCardToCustomBinder(userId, binderId, cardId)
      : Effect.as(binders.removeCardFromCustomBinder(userId, binderId, cardId), null),
  );
  if (Exit.isSuccess(exit)) {
    return isAdd ? json(exit.value, 201, "no-store", cookies) : noContent(cookies);
  }
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "card-binder", {
    cardId,
    binderId,
  });
};

// ---------------------------------------------------------------------------
// POST /api/cards/$cardId/price-refresh
// ---------------------------------------------------------------------------

/** Plafond du corps JSON du rafraîchissement manuel (4 KiB → 413 au-delà). */
export const PRICE_REFRESH_MAX_BODY_BYTES = 4096;

export interface CardPriceRefreshDeps {
  readonly auth: AuthDeps;
  /** Pool `authenticated` (lecture du catalogue uniquement), ou `null` sans `DATABASE_URL`. */
  readonly sql: Sql | null;
  /**
   * `CardmarketPriceService` adossé à un pool `service_role` DÉDIÉ (l'`INSERT` dans
   * `price_snapshots` lui est réservé, RLS 005), ou `null` sans `DATABASE_URL`.
   */
  readonly prices: CardmarketPriceServiceShape | null;
  readonly log: CardDetailLogger;
}

interface LivePriceEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<CardmarketPriceService, never>;
  readonly service: Promise<CardmarketPriceServiceShape>;
}

const GLOBAL_PRICE_RUNTIME_KEY = "__pokevaultCardPriceRuntime" as const;

const readCachedPriceRuntime = (): LivePriceEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_PRICE_RUNTIME_KEY] as LivePriceEntry | undefined;

const writeCachedPriceRuntime = (entry: LivePriceEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_PRICE_RUNTIME_KEY] = entry;
};

/**
 * `CardmarketPriceService` live (store Postgres `service_role` + fetcher Cardmarket
 * SSRF-gardé + repli TCGdex), mis en cache sur `globalThis` : le runtime préserve
 * ainsi le `Semaphore` (concurrence Cardmarket 1) et le circuit breaker (`Ref`)
 * entre les requêtes ET les rechargements HMR. Ce pool `service_role` (2
 * connexions) n'est utilisé QUE par ce service : jamais pour les tables utilisateur.
 */
const getLivePriceService = (databaseUrl: string): Promise<CardmarketPriceServiceShape> => {
  const existing = readCachedPriceRuntime();
  if (existing !== undefined && existing.url === databaseUrl) return existing.service;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedPriceRuntime(undefined);
  }
  const layer = CardmarketPriceServiceLive().pipe(
    Layer.provide(
      Layer.mergeAll(
        PriceSnapshotStoreLive.pipe(
          Layer.provide(
            DatabaseLive({
              connectionString: databaseUrl,
              maxConnections: 2,
              role: "service_role",
            }),
          ),
        ),
        CardmarketFetcherLive(),
        TcgdexPriceFallbackLive(),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const service = runtime
    .runPromise(
      Effect.gen(function* () {
        return yield* CardmarketPriceService;
      }),
    )
    .catch((error: unknown) => {
      if (readCachedPriceRuntime()?.runtime === runtime) writeCachedPriceRuntime(undefined);
      void runtime.dispose();
      throw error;
    });
  writeCachedPriceRuntime({ url: databaseUrl, runtime, service });
  return service;
};

/** Dépendances de production du rafraîchissement : session GoTrue + 2 pools Postgres. */
export const defaultCardPriceRefreshDeps = async (): Promise<CardPriceRefreshDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    return { auth, sql: null, prices: null, log: logWarning };
  }
  const [live, prices] = await Promise.all([
    getLiveServices(databaseUrl, auth),
    getLivePriceService(databaseUrl),
  ]);
  return { auth, sql: live.sql, prices, log: logWarning };
};

const isLanguage = Schema.is(CardLanguage);
const isVariant = Schema.is(CardVariant);

type RefreshInput =
  | { readonly ok: true; readonly language: CardLanguage; readonly variant: CardVariant }
  | { readonly ok: false };

/**
 * Corps optionnel `{ language?, variant? }` (défaut `FR` / `normal`) : toute clé
 * inconnue, valeur hors énumération ou corps non-objet est rejeté (400).
 */
const parseRefreshInput = (body: unknown): RefreshInput => {
  if (body === undefined) return { ok: true, language: "FR", variant: "normal" };
  if (!isRecord(body)) return { ok: false };
  for (const key of Object.keys(body)) {
    if (key !== "language" && key !== "variant") return { ok: false };
  }
  const language = body["language"] ?? "FR";
  const variant = body["variant"] ?? "normal";
  if (!isLanguage(language) || !isVariant(variant)) return { ok: false };
  return { ok: true, language, variant };
};

const toPricePayload = (snapshot: PriceSnapshot): CardDetailPrice => ({
  trendCents: snapshot.trendCents,
  lowFrCents: snapshot.lowFrCents,
  avg30Cents: snapshot.avg30Cents,
  source: snapshot.source,
  fetchedAt: snapshot.fetchedAt,
  expiresAt: snapshot.expiresAt,
  isFresh: snapshot.isFresh,
});

const priceUnavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "price_unavailable" }, 503, "no-store", cookies);

/**
 * Handler `POST /api/cards/$cardId/price-refresh` (rafraîchissement manuel) :
 * 403 CSRF, 401, 413 (> 4 KiB), 400 (corps invalide), 404 (carte inconnue du
 * catalogue), puis `CardmarketPriceService.refreshCardPrice({ manual, force })` :
 * - 200 `{ kind, price }` (`refreshed_cardmarket` | `refreshed_fallback` |
 *   `fresh_cache` | `degraded`) ;
 * - 429 `{ error: "cooldown", retryAfterMs, nextAllowedAt }` + `Retry-After` (s,
 *   arrondi au supérieur) quand le cooldown de 5 min/carte est actif ;
 * - 503 `{ error: "price_unavailable" }` (circuit ouvert sans repli, échec,
 *   base absente) — jamais de détail interne.
 */
export const handleCardPriceRefresh = async (
  request: Request,
  cardId: string,
  deps: CardPriceRefreshDeps,
): Promise<Response> => {
  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return forbiddenOrigin();
  }
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];

  const parsed = await readJsonBody(request, {
    maxBytes: PRICE_REFRESH_MAX_BODY_BYTES,
    allowEmpty: true,
  });
  if (!parsed.ok) {
    return json(
      { error: parsed.status === 413 ? "payload_too_large" : "invalid_input" },
      parsed.status,
      "no-store",
      cookies,
    );
  }
  const input = parseRefreshInput(parsed.body);
  if (!input.ok) return json({ error: "invalid_input" }, 400, "no-store", cookies);

  if (cardId.trim() === "" || /\s/.test(cardId)) {
    return json({ error: "not_found" }, 404, "no-store", cookies);
  }
  if (deps.sql === null || deps.prices === null) {
    deps.log("cardDetail.database_url_missing", { operation: "price-refresh", cardId });
    return priceUnavailable(cookies);
  }
  const sql = deps.sql;
  const prices = deps.prices;

  const lookup = await Effect.runPromiseExit(
    Effect.tryPromise(async () => {
      const rows = await sql<Array<{ id: string; cardmarket_url: string | null }>>`
        select c.id, c.cardmarket_url from public.catalog_cards c where c.id = ${cardId}`;
      return rows[0] ?? null;
    }),
  );
  if (Exit.isFailure(lookup)) {
    deps.log("cardDetail.query_failed", {
      operation: "price-refresh-lookup",
      cardId,
      ...extractErrorMeta(lookup.cause),
    });
    return priceUnavailable(cookies);
  }
  const card = lookup.value;
  if (card === null) return json({ error: "not_found" }, 404, "no-store", cookies);

  const target: PriceRefreshTarget = {
    cardId: card.id,
    language: input.language,
    variant: input.variant,
    cardmarketUrl: card.cardmarket_url,
    priority: "featured",
  };
  const exit = await Effect.runPromiseExit(
    prices.refreshCardPrice(target, { manual: true, force: true }),
  );
  if (Exit.isSuccess(exit)) {
    return json(
      { kind: exit.value.kind, price: toPricePayload(exit.value.snapshot) },
      200,
      "no-store",
      cookies,
    );
  }

  const failure = Cause.squash(exit.cause);
  if (failure instanceof PriceRefreshCooldownError) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Retry-After": String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))),
    });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return Response.json(
      {
        error: "cooldown",
        retryAfterMs: failure.retryAfterMs,
        nextAllowedAt: failure.nextAllowedAt,
      },
      { status: 429, headers },
    );
  }
  deps.log(
    failure instanceof PriceCircuitOpenError
      ? "cardDetail.price_circuit_open"
      : "cardDetail.price_refresh_failed",
    { operation: "price-refresh", cardId, ...extractErrorMeta(exit.cause) },
  );
  return priceUnavailable(cookies);
};
