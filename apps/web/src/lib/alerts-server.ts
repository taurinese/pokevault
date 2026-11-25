/**
 * Accès serveur des écrans `07A–07C` (Alertes Prix) : handlers `Request → Response` des
 * routes `/api/alerts/*` et `/api/push-subscriptions`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc `postgres` /
 * `node:*`). Il ne doit être importé que par les routes `routes/api/alerts/*` et
 * `routes/api/push-subscriptions.ts` (handlers `server`, retirés du bundle client) — jamais
 * par un composant ou un module client (le client passe par `alerts-client.ts`).
 *
 * Sécurité : toutes les routes exigent une session SSR valide (`getServerSession`, 401
 * sinon, cookies rafraîchis propagés via `Set-Cookie` + `Cache-Control: no-store`) ; les
 * mutations (POST/PATCH/DELETE) vérifient en plus l'origine (CSRF, `isRequestSameOrigin`,
 * 403) et plafonnent le corps JSON (8 KiB réels, lecture streamée → 413). Lecture/écriture
 * dans la transaction `withUserRls` (rôle `authenticated`, `auth.uid() = user_id`) avec
 * filtre explicite `user_id` partout. Erreur SQL → 503 sans aucun détail. Aucun secret ne
 * sort : l'URL du webhook Discord n'est JAMAIS lue pour la réponse (booléen SQL
 * `is not null`), seule la clé VAPID PUBLIQUE est exposée. Réf. : docs/01 §9, docs/04 §4,
 * docs/06 §1–§4.
 */

import {
  AlertNotFoundError,
  AlertValidationError,
  type CreatePriceAlertInput,
  isUuid,
  tcgdexCardImageUrl,
  type UpdatePriceAlertInput,
  ValidationError,
} from "@pokevault/domain";
import {
  AlertService,
  AlertServiceLive,
  type AlertServiceShape,
  Database,
  DatabaseLive,
  type Sql,
  withUserRls,
} from "@pokevault/services";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import {
  type AlertChannelsStatus,
  type AlertPriceSource,
  type AlertsPayload,
  type AlertTriggeredEvent,
  type AlertWatchItem,
  emptyAlertsPayload,
  isProfileDiscordWebhookUrl,
} from "./alerts-client.ts";
import { isRequestSameOrigin, resolveAppOrigin } from "./auth.ts";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import { isSafeHttpsUrl } from "./card-detail-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type AlertsLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/** Configuration publique des canaux (variables d'environnement du serveur web). */
export interface AlertsEnv {
  /** Clé VAPID PUBLIQUE (base64url) ; `null` si absente ou mal formée. */
  readonly vapidPublicKey: string | null;
  /** Webhook Discord par défaut de l'instance configuré (valeur jamais exposée). */
  readonly discordDefaultConfigured: boolean;
}

export interface AlertsServerDeps {
  readonly auth: AuthDeps;
  /**
   * Service Postgres + pool SQL, ou `null` quand aucune base n'est configurée
   * (`DATABASE_URL` absent en dev/test) : GET renvoie un payload vide, les mutations 503.
   */
  readonly services: {
    readonly alerts: AlertServiceShape;
    readonly sql: Sql;
  } | null;
  readonly env: AlertsEnv;
  readonly log: AlertsLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: AlertsLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

const VAPID_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,100}$/;

/** Lit la configuration publique des canaux ; ne lit JAMAIS `VAPID_PRIVATE_KEY`. */
export const readAlertsEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): AlertsEnv => {
  const vapid = env["VAPID_PUBLIC_KEY"]?.trim() ?? "";
  const defaultWebhook = env["DISCORD_DEFAULT_WEBHOOK_URL"]?.trim() ?? "";
  return {
    vapidPublicKey: VAPID_PUBLIC_KEY_PATTERN.test(vapid) ? vapid : null,
    discordDefaultConfigured: isProfileDiscordWebhookUrl(defaultWebhook),
  };
};

// ---------------------------------------------------------------------------
// Pool Postgres live, mis en cache sur globalThis (pattern `wishlist-server.ts`)
// ---------------------------------------------------------------------------

type LiveServices = NonNullable<AlertsServerDeps["services"]>;

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<AlertService | Database, never>;
  readonly services: Promise<LiveServices>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultAlertsRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

/**
 * Pool `postgres.js` paresseux (`role: "authenticated"` : RLS à moindre privilège) +
 * `AlertServiceLive`, mis en cache sur `globalThis` pour survivre au HMR Vite sans fuiter de
 * pools ; une promesse rejetée est immédiatement purgée du cache.
 */
const getLiveServices = (databaseUrl: string): Promise<LiveServices> => {
  const existing = readCachedRuntime();
  if (existing !== undefined && existing.url === databaseUrl) return existing.services;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const layer = AlertServiceLive.pipe(
    Layer.provideMerge(
      DatabaseLive({ connectionString: databaseUrl, maxConnections: 5, role: "authenticated" }),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const services = runtime
    .runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertService;
        const { sql } = yield* Database;
        return { alerts, sql };
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

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`) + config publique. */
export const defaultAlertsDeps = async (): Promise<AlertsServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth,
    services:
      databaseUrl === undefined || databaseUrl === "" ? null : await getLiveServices(databaseUrl),
    env: readAlertsEnv(),
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

const forbiddenOrigin = (): Response => json({ error: "forbidden_origin" }, 403);

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "alerts_unavailable" }, 503, cookies);

/** Métadonnées d'erreur sûres à journaliser (jamais de message SQL ni d'URL de webhook). */
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
 * Lit un corps JSON borné en octets réels : `content-length` déclaré d'abord (> plafond →
 * 413), puis lecture streamée interrompue (`reader.cancel()`) dès que le cumul dépasse
 * `MAX_BODY_BYTES` (y compris chunked sans `content-length`) ; flux ou JSON illisible → 400.
 * `allowEmpty` : un corps vide (ou blanc) vaut `{}`.
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

/** Message d'`AlertValidationError` quand l'endpoint push appartient à un autre compte. */
const FOREIGN_ENDPOINT_MESSAGE = "this endpoint is registered by another account";

/**
 * Traduit une erreur typée du domaine en réponse HTTP (jamais de détail SQL en 503) :
 * validation → 400, introuvable → 404, endpoint push d'un autre compte → 409.
 */
const failureResponse = (
  failure: unknown,
  cause: Cause.Cause<unknown>,
  cookies: ReadonlyArray<string>,
  deps: AlertsServerDeps,
  operation: string,
  extra?: Readonly<Record<string, unknown>>,
): Response => {
  if (failure instanceof AlertValidationError) {
    if (failure.message === FOREIGN_ENDPOINT_MESSAGE)
      return json({ error: "conflict" }, 409, cookies);
    return json({ error: "invalid_input" }, 400, cookies);
  }
  if (failure instanceof ValidationError) return json({ error: "invalid_input" }, 400, cookies);
  if (failure instanceof AlertNotFoundError) return json({ error: "not_found" }, 404, cookies);
  deps.log("alerts.query_failed", { operation, ...extra, ...extractErrorMeta(cause) });
  return unavailable(cookies);
};

interface Guard {
  readonly cookies: ReadonlyArray<string>;
  readonly userId: string;
}

/** Lecture : session (401). */
const checkRead = async (request: Request, deps: AlertsServerDeps): Promise<Guard | Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  return { cookies: session.refreshedCookies ?? [], userId: session.user.id };
};

/** Mutations : CSRF (403 cross-origin) puis session (401). */
const checkMutation = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Guard | Response> => {
  if (!isRequestSameOrigin(request, resolveAppOrigin(deps.auth.config, request.url))) {
    return forbiddenOrigin();
  }
  return checkRead(request, deps);
};

const bodyErrorResponse = (status: 400 | 413, cookies: ReadonlyArray<string>): Response =>
  json({ error: status === 413 ? "payload_too_large" : "invalid_input" }, status, cookies);

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

/** Lien Cardmarket : uniquement `https:` (jamais d'URL arbitraire vers le client). */
const safeCardmarketUrl = (url: string | null): string | null => (isSafeHttpsUrl(url) ? url : null);

// ---------------------------------------------------------------------------
// GET /api/alerts
// ---------------------------------------------------------------------------

interface ProfileChannelsRow {
  readonly discord_linked: boolean;
  readonly discord_webhook_configured: boolean;
}

interface EventRow {
  readonly id: string;
  readonly alert_id: string;
  readonly observed_price_cents: number;
  readonly threshold_cents: number;
  readonly channels_sent: AlertTriggeredEvent["channelsSent"];
  readonly read_at: Date | string | null;
  readonly triggered_at: Date | string;
  readonly card_id: string;
  readonly language: AlertTriggeredEvent["language"];
  readonly variant: AlertTriggeredEvent["variant"];
  readonly local_id: string;
  readonly card_name: string;
  readonly image_base_url: string | null;
  readonly cardmarket_url: string | null;
  readonly set_code: string | null;
  readonly set_name: string;
}

interface AlertRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly language: AlertWatchItem["language"];
  readonly variant: AlertWatchItem["variant"];
  readonly min_condition: AlertWatchItem["minCondition"];
  readonly price_field: AlertWatchItem["priceField"];
  readonly threshold_cents: number;
  readonly is_active: boolean;
  readonly notify_push: boolean;
  readonly notify_discord: boolean;
  readonly cooldown_hours: number;
  readonly last_triggered_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly local_id: string;
  readonly card_name: string;
  readonly image_base_url: string | null;
  readonly cardmarket_url: string | null;
  readonly set_code: string | null;
  readonly set_name: string;
  readonly trend_cents: number | null;
  readonly low_fr_cents: number | null;
  readonly price_source: AlertPriceSource | null;
  readonly price_fetched_at: Date | string | null;
}

const toEvent = (row: EventRow): AlertTriggeredEvent => ({
  id: row.id,
  alertId: row.alert_id,
  cardId: row.card_id,
  cardName: row.card_name,
  setCode: row.set_code,
  setName: row.set_name,
  localId: row.local_id,
  language: row.language,
  variant: row.variant,
  imageUrl: tcgdexCardImageUrl(row.image_base_url, "low") ?? null,
  cardmarketUrl: safeCardmarketUrl(row.cardmarket_url),
  observedPriceCents: row.observed_price_cents,
  thresholdCents: row.threshold_cents,
  channelsSent: [...row.channels_sent],
  readAt: isoOrNull(row.read_at),
  triggeredAt: iso(row.triggered_at),
});

const toWatchItem = (row: AlertRow): AlertWatchItem => ({
  id: row.id,
  userId: row.user_id,
  cardId: row.card_id,
  language: row.language,
  variant: row.variant,
  minCondition: row.min_condition,
  priceField: row.price_field,
  thresholdCents: row.threshold_cents,
  isActive: row.is_active,
  notifyPush: row.notify_push,
  notifyDiscord: row.notify_discord,
  cooldownHours: row.cooldown_hours,
  lastTriggeredAt: isoOrNull(row.last_triggered_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  cardName: row.card_name,
  setCode: row.set_code,
  setName: row.set_name,
  localId: row.local_id,
  imageUrl: tcgdexCardImageUrl(row.image_base_url, "low") ?? null,
  cardmarketUrl: safeCardmarketUrl(row.cardmarket_url),
  trendCents: row.trend_cents,
  lowFrCents: row.low_fr_cents,
  priceSource: row.price_source,
  priceFetchedAt: isoOrNull(row.price_fetched_at),
});

/** Nombre d'évènements récents renvoyés dans « Déclenchées récemment ». */
export const TRIGGERED_EVENTS_LIMIT = 20;

const countUnread = async (tx: Sql, userId: string): Promise<number> => {
  const [row] = await tx<Array<{ unread: number | string }>>`
    select count(*)::int as unread
      from public.alert_events
     where user_id = ${userId} and read_at is null`;
  return Number(row?.unread ?? 0);
};

/**
 * Charge le payload de l'écran dans UNE transaction RLS :
 * - profil : booleans uniquement (`discord_user_id is not null`, `discord_webhook_url is not
 *   null`) — l'URL du webhook (secret) n'est jamais sélectionnée ;
 * - évènements récents ⨝ alerte ⨝ carte ⨝ extension ;
 * - alertes ⨝ carte ⨝ extension, avec `card_latest_prices` en `LEFT JOIN LATERAL (… LIMIT 1)` :
 *   le `LIMIT 1` pousse `(card_id, language, variant)` dans la vue `DISTINCT ON` (Index Scan
 *   O(1) par alerte sur `idx_price_snapshots_lookup`, jamais un balayage de `price_snapshots`).
 */
const loadAlerts = async (
  tx: Sql,
  userId: string,
): Promise<Omit<AlertsPayload, "channels"> & { readonly channels: ChannelsFromDb }> => {
  const [profile] = await tx<ProfileChannelsRow[]>`
    select (discord_user_id is not null) as discord_linked,
           (discord_webhook_url is not null) as discord_webhook_configured
      from public.profiles
     where id = ${userId}`;
  const [subscriptions] = await tx<Array<{ total: number | string }>>`
    select count(*)::int as total
      from public.push_subscriptions
     where user_id = ${userId}`;
  const eventRows = await tx<EventRow[]>`
    select e.id, e.alert_id, e.observed_price_cents, e.threshold_cents, e.channels_sent,
           e.read_at, e.triggered_at,
           a.card_id, a.language, a.variant,
           c.local_id, c.name_fr as card_name, c.image_base_url, c.cardmarket_url,
           s.code as set_code, s.name_fr as set_name
      from public.alert_events e
      join public.price_alerts a on a.id = e.alert_id and a.user_id = e.user_id
      join public.catalog_cards c on c.id = a.card_id
      join public.catalog_sets s on s.id = c.set_id
     where e.user_id = ${userId}
     order by e.triggered_at desc, e.id desc
     limit ${TRIGGERED_EVENTS_LIMIT}`;
  const alertRows = await tx<AlertRow[]>`
    select a.id, a.user_id, a.card_id, a.language, a.variant, a.min_condition, a.price_field,
           a.threshold_cents, a.is_active, a.notify_push, a.notify_discord, a.cooldown_hours,
           a.last_triggered_at, a.created_at, a.updated_at,
           c.local_id, c.name_fr as card_name, c.image_base_url, c.cardmarket_url,
           s.code as set_code, s.name_fr as set_name,
           p.trend_cents, p.low_fr_cents, p.source as price_source,
           p.fetched_at as price_fetched_at
      from public.price_alerts a
      join public.catalog_cards c on c.id = a.card_id
      join public.catalog_sets s on s.id = c.set_id
      left join lateral (
        select lp.trend_cents, lp.low_fr_cents, lp.source, lp.fetched_at
          from public.card_latest_prices lp
         where lp.card_id = a.card_id and lp.language = a.language and lp.variant = a.variant
         limit 1
      ) p on true
     where a.user_id = ${userId}
     order by a.is_active desc, a.updated_at desc, a.id desc`;
  const unreadCount = await countUnread(tx, userId);
  return {
    available: true,
    channels: {
      pushSubscriptionsCount: Number(subscriptions?.total ?? 0),
      discordLinked: profile?.discord_linked === true,
      discordWebhookConfigured: profile?.discord_webhook_configured === true,
    },
    triggeredEvents: eventRows.map(toEvent),
    alerts: alertRows.map(toWatchItem),
    unreadCount,
  };
};

type ChannelsFromDb = Pick<
  AlertChannelsStatus,
  "pushSubscriptionsCount" | "discordLinked" | "discordWebhookConfigured"
>;

const publicChannels = (
  env: AlertsEnv,
): Pick<AlertChannelsStatus, "pushConfigured" | "vapidPublicKey" | "discordDefaultConfigured"> => ({
  pushConfigured: env.vapidPublicKey !== null,
  vapidPublicKey: env.vapidPublicKey,
  discordDefaultConfigured: env.discordDefaultConfigured,
});

/**
 * Handler `GET /api/alerts` : 401 sans session ; 200 + `{ available, channels,
 * triggeredEvents, alerts, unreadCount }` ; `Cache-Control: private, no-store` ; sans
 * `DATABASE_URL` : 200 + payload vide (`available: false`) ; 503 sans détail SQL.
 */
export const handleListAlerts = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkRead(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "list" });
    const empty = emptyAlertsPayload(publicChannels(deps.env), false);
    return json(empty, 200, cookies);
  }
  const exit = await Effect.runPromiseExit(
    withUserRls(deps.services.sql, userId, (tx) => loadAlerts(tx, userId)),
  );
  if (Exit.isFailure(exit)) {
    deps.log("alerts.query_failed", { operation: "list", ...extractErrorMeta(exit.cause) });
    return unavailable(cookies);
  }
  const loaded = exit.value;
  const payload: AlertsPayload = {
    ...loaded,
    channels: { ...loaded.channels, ...publicChannels(deps.env) },
  };
  return json(payload, 200, cookies);
};

// ---------------------------------------------------------------------------
// GET /api/alerts/unread-count
// ---------------------------------------------------------------------------

/**
 * Handler `GET /api/alerts/unread-count` (pastille Navbar B) : 401 sans session ; 200 +
 * `{ unreadCount }` (`0` sans `DATABASE_URL`) ; 503 sans détail SQL — jamais 500.
 */
export const handleUnreadCount = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkRead(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  if (deps.services === null) return json({ unreadCount: 0 }, 200, cookies);
  const exit = await Effect.runPromiseExit(deps.services.alerts.countUnreadEvents(userId));
  if (Exit.isFailure(exit)) {
    deps.log("alerts.query_failed", { operation: "unread_count", ...extractErrorMeta(exit.cause) });
    return unavailable(cookies);
  }
  return json({ unreadCount: exit.value }, 200, cookies);
};

// ---------------------------------------------------------------------------
// POST /api/alerts
// ---------------------------------------------------------------------------

const catalogCardExists = (sql: Sql, userId: string, cardId: string) =>
  withUserRls(sql, userId, async (tx) => {
    const rows = await tx<Array<{ id: string }>>`
      select id from public.catalog_cards where id = ${cardId} limit 1`;
    return rows.length > 0;
  });

/**
 * Handler `POST /api/alerts` via `AlertService.createAlert` : 403 CSRF, 401, 413, 400
 * (`CreatePriceAlertInput` invalide), 404 (carte absente du catalogue), 503, 201 + `PriceAlert`.
 */
export const handleCreateAlert = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "create" });
    return unavailable(cookies);
  }
  const { alerts, sql } = deps.services;
  const cardId = parsed.body["cardId"];
  if (typeof cardId !== "string" || cardId === "" || cardId.length > 64) {
    return json({ error: "invalid_input" }, 400, cookies);
  }

  const existsExit = await Effect.runPromiseExit(catalogCardExists(sql, userId, cardId));
  if (Exit.isFailure(existsExit)) {
    return failureResponse(
      Cause.squash(existsExit.cause),
      existsExit.cause,
      cookies,
      deps,
      "create",
    );
  }
  if (!existsExit.value) return json({ error: "not_found" }, 404, cookies);

  // Le service décode/valide via `decodeCreatePriceAlertInput` (AlertValidationError → 400).
  const exit = await Effect.runPromiseExit(
    alerts.createAlert(userId, parsed.body as unknown as CreatePriceAlertInput),
  );
  if (Exit.isSuccess(exit)) return json(exit.value, 201, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "create");
};

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/alerts/$id
// ---------------------------------------------------------------------------

/**
 * Handler `PATCH /api/alerts/$id` via `AlertService.updateAlert` : 403 CSRF, 401, 413, 400,
 * 404 (introuvable / autre utilisateur / id non UUID), 503, 200 + `PriceAlert`.
 */
export const handleUpdateAlert = async (
  request: Request,
  alertId: string,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  if (!isUuid(alertId)) return json({ error: "not_found" }, 404, cookies);
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "update", alertId });
    return unavailable(cookies);
  }

  const exit = await Effect.runPromiseExit(
    deps.services.alerts.updateAlert(
      userId,
      alertId,
      parsed.body as unknown as UpdatePriceAlertInput,
    ),
  );
  if (Exit.isSuccess(exit)) return json(exit.value, 200, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "update", {
    alertId,
  });
};

/** Handler `DELETE /api/alerts/$id` via `AlertService.deleteAlert` : 403, 401, 404, 503, 200 `{ ok: true }`. */
export const handleDeleteAlert = async (
  request: Request,
  alertId: string,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  if (!isUuid(alertId)) return json({ error: "not_found" }, 404, cookies);
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "delete", alertId });
    return unavailable(cookies);
  }
  const exit = await Effect.runPromiseExit(deps.services.alerts.deleteAlert(userId, alertId));
  if (Exit.isSuccess(exit)) return json({ ok: true }, 200, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "delete", {
    alertId,
  });
};

// ---------------------------------------------------------------------------
// POST /api/alerts/events/read
// ---------------------------------------------------------------------------

/**
 * Handler `POST /api/alerts/events/read` : `{ eventId?: string }` (corps optionnel). Un
 * `eventId` marque UN évènement lu (404 si introuvable / non UUID) ; sans `eventId`, tous
 * les évènements non lus. 403, 401, 413, 400, 503, 200 + `{ unreadCount }`.
 */
export const handleMarkEventsRead = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request, { allowEmpty: true });
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  const eventId = parsed.body["eventId"];
  if (eventId !== undefined && typeof eventId !== "string") {
    return json({ error: "invalid_input" }, 400, cookies);
  }
  if (typeof eventId === "string" && !isUuid(eventId)) {
    return json({ error: "not_found" }, 404, cookies);
  }
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "mark_read" });
    return unavailable(cookies);
  }
  const { alerts } = deps.services;

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      if (typeof eventId === "string") yield* alerts.markEventRead(userId, eventId);
      else yield* alerts.markAllEventsRead(userId);
      return yield* alerts.countUnreadEvents(userId);
    }),
  );
  if (Exit.isSuccess(exit)) return json({ unreadCount: exit.value }, 200, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "mark_read");
};

// ---------------------------------------------------------------------------
// PATCH /api/alerts/channels (webhook Discord)
// ---------------------------------------------------------------------------

/**
 * Handler `PATCH /api/alerts/channels` : `{ discordWebhookUrl: string | null }`. Une URL non
 * nulle doit être `https://discord.com/api/webhooks/<chiffres>/<jeton>` (garde anti-SSRF du
 * domaine + motif du `CHECK` SQL de `profiles`) sinon 400. Met à jour `profiles` sous RLS ;
 * la réponse ne contient qu'un booléen (`discordWebhookConfigured`) — jamais l'URL.
 */
export const handleUpdateChannels = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body) || !("discordWebhookUrl" in parsed.body)) {
    return json({ error: "invalid_input" }, 400, cookies);
  }
  const raw = parsed.body["discordWebhookUrl"];
  let webhookUrl: string | null;
  if (raw === null) {
    webhookUrl = null;
  } else if (typeof raw === "string" && isProfileDiscordWebhookUrl(raw.trim())) {
    webhookUrl = raw.trim();
  } else {
    return json({ error: "invalid_webhook_url" }, 400, cookies);
  }
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "channels" });
    return unavailable(cookies);
  }

  const exit = await Effect.runPromiseExit(
    withUserRls(deps.services.sql, userId, async (tx) => {
      // Alertes Discord actives si un webhook est posé OU si le compte Discord est lié (DM).
      const rows = await tx<Array<{ configured: boolean }>>`
        update public.profiles
           set discord_webhook_url = ${webhookUrl}::text,
               discord_alerts_enabled = (${webhookUrl}::text is not null or discord_user_id is not null)
         where id = ${userId}
        returning (discord_webhook_url is not null) as configured`;
      return rows[0];
    }),
  );
  if (Exit.isFailure(exit)) {
    deps.log("alerts.query_failed", { operation: "channels", ...extractErrorMeta(exit.cause) });
    return unavailable(cookies);
  }
  if (exit.value === undefined) return json({ error: "not_found" }, 404, cookies);
  return json({ discordWebhookConfigured: exit.value.configured }, 200, cookies);
};

// ---------------------------------------------------------------------------
// POST / DELETE /api/push-subscriptions
// ---------------------------------------------------------------------------

/**
 * Handler `POST /api/push-subscriptions` via `AlertService.upsertPushSubscription` :
 * `{ endpoint, p256dh, auth, userAgent? }`. 403 CSRF, 401, 413, 400 (endpoint non
 * `isSafePushEndpointUrl`, clés mal formées), 409 (endpoint détenu par un autre compte),
 * 503, 201 `{ registered: true }` (les clés ne sont jamais renvoyées).
 */
export const handleRegisterPushSubscription = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "push_register" });
    return unavailable(cookies);
  }

  // Le service décode/valide (`isSafePushEndpointUrl`, base64url) : AlertValidationError → 400.
  const exit = await Effect.runPromiseExit(
    deps.services.alerts.upsertPushSubscription(
      userId,
      parsed.body as unknown as Parameters<AlertServiceShape["upsertPushSubscription"]>[1],
    ),
  );
  if (Exit.isSuccess(exit)) return json({ registered: true }, 201, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "push_register");
};

/**
 * Handler `DELETE /api/push-subscriptions` : `{ endpoint }` ; idempotent (200 même si
 * l'abonnement n'existe plus). 403, 401, 413, 400, 503, 200 `{ ok: true }`.
 */
export const handleDeletePushSubscription = async (
  request: Request,
  deps: AlertsServerDeps,
): Promise<Response> => {
  const guard = await checkMutation(request, deps);
  if (guard instanceof Response) return guard;
  const { cookies, userId } = guard;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return bodyErrorResponse(parsed.status, cookies);
  if (!isRecord(parsed.body)) return json({ error: "invalid_input" }, 400, cookies);
  const endpoint = parsed.body["endpoint"];
  if (typeof endpoint !== "string" || endpoint === "" || endpoint.length > 2048) {
    return json({ error: "invalid_input" }, 400, cookies);
  }
  if (deps.services === null) {
    deps.log("alerts.database_url_missing", { operation: "push_delete" });
    return unavailable(cookies);
  }
  const exit = await Effect.runPromiseExit(
    deps.services.alerts.deletePushSubscription(userId, endpoint),
  );
  if (Exit.isSuccess(exit)) return json({ ok: true }, 200, cookies);
  return failureResponse(Cause.squash(exit.cause), exit.cause, cookies, deps, "push_delete");
};
