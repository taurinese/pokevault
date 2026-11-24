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
 * `isRequestSameOrigin`, 403) et plafonnent le corps JSON (8 KiB → 413).
 * Lecture/écriture dans la transaction `withUserRls` (rôle `authenticated`,
 * `auth.uid() = userId`) avec filtre explicite `user_id` partout. Erreur SQL →
 * 503 sans aucun détail. Réf. : docs/01 §5.2, docs/02, docs/06 §1–§2.
 */

import {
  BinderConflictError,
  BinderNotFoundError,
  CardCopyConflictError,
  CardCopyNotFoundError,
  CatalogItemNotFoundError,
  InvalidCoverImageError,
  isUuid,
  UnauthorizedBinderAccess,
  type UpsertCardCopyInput,
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
  DatabaseLive,
  type Sql,
  withUserRls,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import type { CardDetailBinder, CardDetailCard, CardDetailPayload } from "./card-detail-client.ts";

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

/**
 * Lit un corps JSON borné : `content-length` déclaré > plafond ou texte trop
 * long → 413 ; JSON illisible → 400.
 */
export const readJsonBody = async (request: Request): Promise<ParsedBody> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413 };
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
}

interface CustomBinderRow {
  readonly id: string;
  readonly title: string;
  readonly contains_card: boolean;
}

/** Carte du catalogue + extension, ou `null` si inconnue. */
const loadCard = async (tx: Sql, cardId: string): Promise<CardDetailCard | null> => {
  const rows = await tx<CatalogCardRow[]>`
    select c.id, c.set_id, c.local_id, c.name_fr, c.name_en, c.rarity, c.holo_effect,
           c.category, c.types, c.hp, c.illustrator, c.image_base_url,
           c.available_variants, c.cardmarket_url,
           s.name_fr as set_name_fr, s.code as set_code,
           s.official_count as set_official_count, s.total_count as set_total_count
      from public.catalog_cards c
      join public.catalog_sets s on s.id = c.set_id
     where c.id = ${cardId}`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
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
          const card = await loadCard(tx, cardId);
          if (card === null) return null;
          const customBinders = await loadCustomBinders(tx, userId, cardId);
          return { card, customBinders } satisfies Pick<
            CardDetailPayload,
            "card" | "customBinders"
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
  const input = { cardId, ...parsed.body } as UpsertCardCopyInput;
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
