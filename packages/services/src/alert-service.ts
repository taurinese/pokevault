import {
  type AlertEvent,
  AlertNotFoundError,
  type AlertPriceSnapshot,
  AlertValidationError,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  type CreatePriceAlertInput,
  DEFAULT_ALERT_COOLDOWN_HOURS,
  decodeCreatePriceAlertInput,
  decodeRegisterPushSubscriptionInput,
  decodeUpdatePriceAlertInput,
  isUuid,
  type NotificationChannel,
  type PriceAlert,
  type PriceSource,
  type PushSubscription,
  type RegisterPushSubscriptionInput,
  tcgdexCardImageUrl,
  type UpdatePriceAlertInput,
  ValidationError,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { Database, DatabaseError, type Sql } from "./db.ts";
import { pgErrorCode, withUserRls } from "./rls.ts";

// ---------------------------------------------------------------------------
// Types & contrat
// ---------------------------------------------------------------------------

/** Erreurs typées des opérations « utilisateur » d'{@link AlertService}. */
export type AlertServiceError =
  | DatabaseError
  | ValidationError
  | AlertValidationError
  | AlertNotFoundError;

/** Carte surveillée, telle qu'affichée dans la notification. */
export interface AlertCardInfo {
  readonly name: string;
  readonly setName: string | null;
  /** Numéro dans l'extension (`catalog_cards.local_id`). */
  readonly number: string | null;
  readonly imageUrl: string | null;
  readonly cardmarketUrl: string | null;
}

/** Coordonnées Discord du propriétaire de l'alerte (`profiles`). */
export interface AlertOwnerInfo {
  readonly discordUserId: string | null;
  readonly discordWebhookUrl: string | null;
}

/** Une alerte active + tout ce qu'il faut pour l'évaluer et notifier (lecture worker). */
export interface AlertEvaluationCandidate {
  readonly alert: PriceAlert;
  readonly card: AlertCardInfo;
  readonly owner: AlertOwnerInfo;
  /** Dernier snapshot connu de `(carte, langue, variante)` ; `null` si jamais collecté. */
  readonly snapshot: AlertPriceSnapshot | null;
}

/** Évènement à persister après l'envoi d'une alerte (au moins un canal a réussi). */
export interface RecordTriggeredEventInput {
  readonly alertId: string;
  readonly userId: string;
  readonly observedPriceCents: number;
  readonly thresholdCents: number;
  readonly channelsSent: ReadonlyArray<NotificationChannel>;
}

export const DEFAULT_ALERT_EVENTS_LIMIT = 50;
export const MAX_ALERT_EVENTS_LIMIT = 200;

/**
 * Alertes de prix, évènements et abonnements Web Push.
 *
 * - Méthodes « utilisateur » : toujours scopées par `userId` et exécutées sous RLS
 *   (`withUserRls`) ; l'objet d'un autre utilisateur est `AlertNotFoundError`.
 * - Méthodes « worker » (`listActiveAlertsForEvaluation`, `recordTriggeredEvent`,
 *   `deleteExpiredPushSubscription`) : connexion `service_role`, hors RLS (l'insertion dans
 *   `alert_events` est réservée au worker, voir migration 007).
 */
export interface AlertServiceShape {
  readonly listAlerts: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<PriceAlert>, AlertServiceError>;
  readonly createAlert: (
    userId: string,
    input: CreatePriceAlertInput,
  ) => Effect.Effect<PriceAlert, AlertServiceError>;
  readonly updateAlert: (
    userId: string,
    alertId: string,
    patch: UpdatePriceAlertInput,
  ) => Effect.Effect<PriceAlert, AlertServiceError>;
  readonly deleteAlert: (userId: string, alertId: string) => Effect.Effect<void, AlertServiceError>;
  /** Historique récent (plus récent d'abord), `limit` borné à `1..200` (défaut 50). */
  readonly listEvents: (
    userId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AlertEvent>, AlertServiceError>;
  /** Nombre d'évènements non lus (pastille verte de la Navbar). */
  readonly countUnreadEvents: (userId: string) => Effect.Effect<number, AlertServiceError>;
  readonly markEventRead: (
    userId: string,
    eventId: string,
  ) => Effect.Effect<AlertEvent, AlertServiceError>;
  /** Marque tous les évènements lus ; renvoie le nombre d'évènements modifiés. */
  readonly markAllEventsRead: (userId: string) => Effect.Effect<number, AlertServiceError>;
  /** Enregistre (ou rafraîchit) l'abonnement d'un navigateur ; `endpoint` unique. */
  readonly upsertPushSubscription: (
    userId: string,
    input: RegisterPushSubscriptionInput,
  ) => Effect.Effect<PushSubscription, AlertServiceError>;
  readonly deletePushSubscription: (
    userId: string,
    endpoint: string,
  ) => Effect.Effect<void, AlertServiceError>;
  readonly listPushSubscriptions: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<PushSubscription>, AlertServiceError>;

  /** Worker : alertes actives + carte + propriétaire + dernier prix (`LEFT JOIN LATERAL … LIMIT 1`). */
  readonly listActiveAlertsForEvaluation: () => Effect.Effect<
    ReadonlyArray<AlertEvaluationCandidate>,
    DatabaseError
  >;
  /**
   * Worker : insère l'évènement ET pose `price_alerts.last_triggered_at = now()` dans une même
   * transaction (jamais l'un sans l'autre ⇒ pas de spam ni d'évènement orphelin).
   */
  readonly recordTriggeredEvent: (
    input: RecordTriggeredEventInput,
  ) => Effect.Effect<AlertEvent, DatabaseError>;
  /** Worker : purge un abonnement expiré (404/410) ; `true` si une ligne a été supprimée. */
  readonly deleteExpiredPushSubscription: (
    endpoint: string,
  ) => Effect.Effect<boolean, DatabaseError>;
}

/** Effect-TS service key of the alert service. */
export class AlertService extends Context.Service<AlertService, AlertServiceShape>()(
  "@pokevault/services/AlertService",
) {}

// ---------------------------------------------------------------------------
// Helpers communs
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: ReadonlySet<string> = new Set([
  "ValidationError",
  "AlertValidationError",
  "AlertNotFoundError",
]);

/** Convertit une erreur de transaction en erreur typée (`undefined` ⇒ `DatabaseError`). */
export const mapAlertError = (cause: unknown): AlertServiceError | undefined => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    DOMAIN_TAGS.has(cause._tag)
  ) {
    return cause as AlertServiceError;
  }
  switch (pgErrorCode(cause)) {
    case "23503":
      return new AlertValidationError({ message: "unknown card", cause });
    case "23514":
    case "22P02":
    case "22003":
      return new AlertValidationError({ message: "invalid alert data", cause });
    case "42501":
      return new AlertValidationError({
        message: "this endpoint is registered by another account",
        cause,
      });
    default:
      return undefined;
  }
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

const alertNotFound = (alertId: string): AlertNotFoundError =>
  new AlertNotFoundError({ alertId, message: `price alert ${alertId} not found` });

const eventNotFound = (eventId: string): AlertNotFoundError =>
  new AlertNotFoundError({ alertId: eventId, message: `alert event ${eventId} not found` });

const clampLimit = (limit: number | undefined): number => {
  const value = Math.trunc(limit ?? DEFAULT_ALERT_EVENTS_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_ALERT_EVENTS_LIMIT;
  return Math.min(MAX_ALERT_EVENTS_LIMIT, Math.max(1, value));
};

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface AlertRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly min_condition: CardCondition;
  readonly price_field: PriceAlert["priceField"];
  readonly threshold_cents: number;
  readonly is_active: boolean;
  readonly notify_push: boolean;
  readonly notify_discord: boolean;
  readonly cooldown_hours: number;
  readonly last_triggered_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface EventRow {
  readonly id: string;
  readonly alert_id: string;
  readonly user_id: string;
  readonly observed_price_cents: number;
  readonly threshold_cents: number;
  readonly channels_sent: ReadonlyArray<NotificationChannel>;
  readonly read_at: Date | string | null;
  readonly triggered_at: Date | string;
}

interface SubscriptionRow {
  readonly id: string;
  readonly user_id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly user_agent: string | null;
  readonly created_at: Date | string;
  readonly last_seen_at: Date | string;
}

interface CandidateRow extends AlertRow {
  readonly card_name: string;
  readonly card_number: string | null;
  readonly image_base_url: string | null;
  readonly cardmarket_url: string | null;
  readonly set_name: string | null;
  readonly discord_user_id: string | null;
  readonly discord_webhook_url: string | null;
  readonly price_source: PriceSource | null;
  readonly trend_cents: number | null;
  readonly low_fr_cents: number | null;
}

const toAlert = (row: AlertRow): PriceAlert => ({
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
});

const toEvent = (row: EventRow): AlertEvent => ({
  id: row.id,
  alertId: row.alert_id,
  userId: row.user_id,
  observedPriceCents: row.observed_price_cents,
  thresholdCents: row.threshold_cents,
  channelsSent: [...row.channels_sent],
  readAt: isoOrNull(row.read_at),
  triggeredAt: iso(row.triggered_at),
});

const toSubscription = (row: SubscriptionRow): PushSubscription => ({
  id: row.id,
  userId: row.user_id,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  userAgent: row.user_agent,
  createdAt: iso(row.created_at),
  lastSeenAt: iso(row.last_seen_at),
});

const toCandidate = (row: CandidateRow): AlertEvaluationCandidate => ({
  alert: toAlert(row),
  card: {
    name: row.card_name,
    setName: row.set_name,
    number: row.card_number,
    imageUrl: tcgdexCardImageUrl(row.image_base_url, "low") ?? null,
    cardmarketUrl: row.cardmarket_url,
  },
  owner: { discordUserId: row.discord_user_id, discordWebhookUrl: row.discord_webhook_url },
  snapshot:
    row.price_source === null
      ? null
      : { source: row.price_source, trendCents: row.trend_cents, lowFrCents: row.low_fr_cents },
});

const ALERT_COLUMNS = `id, user_id, card_id, language, variant, min_condition, price_field,
  threshold_cents, is_active, notify_push, notify_discord, cooldown_hours, last_triggered_at,
  created_at, updated_at`;

/**
 * Live {@link AlertService} : RLS transactionnelle pour les méthodes utilisateur (+ filtre
 * explicite par `user_id`, défense en profondeur), SQL direct (`service_role`) pour le worker.
 */
export const AlertServiceLive: Layer.Layer<AlertService, never, Database> = Layer.effect(
  AlertService,
  Effect.gen(function* () {
    const { sql } = yield* Database;
    const rls = <A>(userId: string, fn: (tx: Sql) => Promise<A>) =>
      withUserRls<A, AlertServiceError>(sql, userId, fn, { mapError: mapAlertError });
    const direct = <A>(fn: (db: Sql) => Promise<A>): Effect.Effect<A, DatabaseError> =>
      Effect.tryPromise({
        try: () => fn(sql),
        catch: (cause) => new DatabaseError({ message: "postgres query failed", cause }),
      });

    const service: AlertServiceShape = {
      listAlerts: (userId) =>
        rls(userId, async (tx) => {
          const rows = await tx<AlertRow[]>`
            select ${tx.unsafe(ALERT_COLUMNS)}
              from public.price_alerts
             where user_id = ${userId}
             order by updated_at desc, id desc`;
          return rows.map(toAlert);
        }),

      createAlert: (userId, input) =>
        decodeCreatePriceAlertInput(input).pipe(
          Effect.flatMap((v) =>
            rls(userId, async (tx) => {
              const [row] = await tx<AlertRow[]>`
                insert into public.price_alerts
                  (user_id, card_id, language, variant, min_condition, price_field,
                   threshold_cents, is_active, notify_push, notify_discord, cooldown_hours)
                values
                  (${userId}::uuid, ${v.cardId}, ${v.language ?? "FR"}, ${v.variant ?? "normal"},
                   ${v.minCondition ?? "NM"}, ${v.priceField ?? "low_fr"}, ${v.thresholdCents},
                   ${v.isActive ?? true}, ${v.notifyPush ?? true}, ${v.notifyDiscord ?? false},
                   ${v.cooldownHours ?? DEFAULT_ALERT_COOLDOWN_HOURS})
                returning ${tx.unsafe(ALERT_COLUMNS)}`;
              if (row === undefined) throw new Error("INSERT INTO price_alerts returned no row");
              return toAlert(row);
            }),
          ),
        ),

      updateAlert: (userId, alertId, patch) =>
        decodeUpdatePriceAlertInput(patch).pipe(
          Effect.flatMap((v) =>
            rls(userId, async (tx) => {
              if (!isUuid(alertId)) throw alertNotFound(alertId);
              // `coalesce(param, colonne)` : un champ absent du patch conserve sa valeur.
              const [row] = await tx<AlertRow[]>`
                update public.price_alerts
                   set language        = coalesce(${v.language ?? null}::text, language),
                       variant         = coalesce(${v.variant ?? null}::text, variant),
                       min_condition   = coalesce(${v.minCondition ?? null}::text, min_condition),
                       price_field     = coalesce(${v.priceField ?? null}::text, price_field),
                       threshold_cents = coalesce(${v.thresholdCents ?? null}::integer, threshold_cents),
                       is_active       = coalesce(${v.isActive ?? null}::boolean, is_active),
                       notify_push     = coalesce(${v.notifyPush ?? null}::boolean, notify_push),
                       notify_discord  = coalesce(${v.notifyDiscord ?? null}::boolean, notify_discord),
                       cooldown_hours  = coalesce(${v.cooldownHours ?? null}::integer, cooldown_hours)
                 where id = ${alertId} and user_id = ${userId}
                returning ${tx.unsafe(ALERT_COLUMNS)}`;
              if (row === undefined) throw alertNotFound(alertId);
              return toAlert(row);
            }),
          ),
        ),

      deleteAlert: (userId, alertId) =>
        rls(userId, async (tx) => {
          if (!isUuid(alertId)) throw alertNotFound(alertId);
          const rows = await tx<Array<{ id: string }>>`
            delete from public.price_alerts
             where id = ${alertId} and user_id = ${userId}
            returning id`;
          if (rows.length === 0) throw alertNotFound(alertId);
        }),

      listEvents: (userId, limit) =>
        rls(userId, async (tx) => {
          const rows = await tx<EventRow[]>`
            select id, alert_id, user_id, observed_price_cents, threshold_cents, channels_sent,
                   read_at, triggered_at
              from public.alert_events
             where user_id = ${userId}
             order by triggered_at desc, id desc
             limit ${clampLimit(limit)}`;
          return rows.map(toEvent);
        }),

      countUnreadEvents: (userId) =>
        rls(userId, async (tx) => {
          const [row] = await tx<Array<{ unread: number | string }>>`
            select count(*)::int as unread
              from public.alert_events
             where user_id = ${userId} and read_at is null`;
          return Number(row?.unread ?? 0);
        }),

      markEventRead: (userId, eventId) =>
        rls(userId, async (tx) => {
          if (!isUuid(eventId)) throw eventNotFound(eventId);
          const [row] = await tx<EventRow[]>`
            update public.alert_events
               set read_at = coalesce(read_at, now())
             where id = ${eventId} and user_id = ${userId}
            returning id, alert_id, user_id, observed_price_cents, threshold_cents, channels_sent,
                      read_at, triggered_at`;
          if (row === undefined) throw eventNotFound(eventId);
          return toEvent(row);
        }),

      markAllEventsRead: (userId) =>
        rls(userId, async (tx) => {
          const rows = await tx<Array<{ id: string }>>`
            update public.alert_events
               set read_at = now()
             where user_id = ${userId} and read_at is null
            returning id`;
          return rows.length;
        }),

      upsertPushSubscription: (userId, input) =>
        decodeRegisterPushSubscriptionInput(input).pipe(
          Effect.flatMap((v) =>
            rls(userId, async (tx) => {
              // Le `where` protège l'abonnement d'un autre compte (même endpoint) : jamais écrasé.
              const [row] = await tx<SubscriptionRow[]>`
                insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
                values (${userId}::uuid, ${v.endpoint}, ${v.p256dh}, ${v.auth}, ${v.userAgent ?? null})
                on conflict (endpoint) do update
                   set p256dh = excluded.p256dh,
                       auth = excluded.auth,
                       user_agent = excluded.user_agent,
                       last_seen_at = now()
                 where public.push_subscriptions.user_id = excluded.user_id
                returning id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at`;
              if (row === undefined) {
                throw new AlertValidationError({
                  message: "this endpoint is registered by another account",
                });
              }
              return toSubscription(row);
            }),
          ),
        ),

      deletePushSubscription: (userId, endpoint) =>
        rls(userId, async (tx) => {
          await tx`
            delete from public.push_subscriptions
             where user_id = ${userId} and endpoint = ${endpoint}`;
        }),

      listPushSubscriptions: (userId) =>
        rls(userId, async (tx) => {
          const rows = await tx<SubscriptionRow[]>`
            select id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at
              from public.push_subscriptions
             where user_id = ${userId}
             order by created_at asc, id asc`;
          return rows.map(toSubscription);
        }),

      listActiveAlertsForEvaluation: () =>
        direct(async (db) => {
          const rows = await db<CandidateRow[]>`
            select pa.id, pa.user_id, pa.card_id, pa.language, pa.variant, pa.min_condition,
                   pa.price_field, pa.threshold_cents, pa.is_active, pa.notify_push,
                   pa.notify_discord, pa.cooldown_hours, pa.last_triggered_at, pa.created_at,
                   pa.updated_at,
                   c.name_fr as card_name, c.local_id as card_number, c.image_base_url,
                   c.cardmarket_url, s.name_fr as set_name,
                   p.discord_user_id, p.discord_webhook_url,
                   lp.source as price_source, lp.trend_cents, lp.low_fr_cents
              from public.price_alerts pa
              join public.catalog_cards c on c.id = pa.card_id
              join public.catalog_sets s on s.id = c.set_id
              join public.profiles p on p.id = pa.user_id
              left join lateral (
                select l.source, l.trend_cents, l.low_fr_cents
                  from public.card_latest_prices l
                 where l.card_id = pa.card_id
                   and l.language = pa.language
                   and l.variant = pa.variant
                 limit 1
              ) lp on true
             where pa.is_active
             order by pa.card_id, pa.id`;
          return rows.map(toCandidate);
        }),

      recordTriggeredEvent: (input) =>
        direct(async (db) => {
          const channels = [...input.channelsSent];
          const event = await db.begin(async (tx) => {
            const [inserted] = await tx<EventRow[]>`
              insert into public.alert_events
                (alert_id, user_id, observed_price_cents, threshold_cents, channels_sent)
              values
                (${input.alertId}::uuid, ${input.userId}::uuid, ${input.observedPriceCents},
                 ${input.thresholdCents}, ${channels}::text[])
              returning id, alert_id, user_id, observed_price_cents, threshold_cents,
                        channels_sent, read_at, triggered_at`;
            if (inserted === undefined) throw new Error("INSERT INTO alert_events returned no row");
            // Même transaction ⇒ `now()` identique : `last_triggered_at` = `triggered_at`.
            await tx`
              update public.price_alerts
                 set last_triggered_at = now()
               where id = ${input.alertId}`;
            return inserted;
          });
          return toEvent(event as unknown as EventRow);
        }),

      deleteExpiredPushSubscription: (endpoint) =>
        direct(async (db) => {
          const rows = await db<Array<{ id: string }>>`
            delete from public.push_subscriptions where endpoint = ${endpoint} returning id`;
          return rows.length > 0;
        }),
    };
    return service;
  }),
);

// ---------------------------------------------------------------------------
// Memory (tests unitaires 100 % offline)
// ---------------------------------------------------------------------------

export interface AlertMemoryContext {
  readonly card: AlertCardInfo;
  readonly owner: AlertOwnerInfo;
  readonly snapshot: AlertPriceSnapshot | null;
}

export interface AlertServiceMemoryHandle {
  readonly layer: Layer.Layer<AlertService>;
  readonly alerts: Map<string, PriceAlert>;
  readonly events: Array<AlertEvent>;
  readonly subscriptions: Map<string, PushSubscription>;
  /** Carte / propriétaire / dernier prix par `alertId`, lus par `listActiveAlertsForEvaluation`. */
  readonly contexts: Map<string, AlertMemoryContext>;
}

export interface AlertServiceMemoryOptions {
  /** Si fourni, `createAlert` sur une carte hors de cet ensemble échoue (FK du catalogue). */
  readonly knownCardIds?: ReadonlySet<string> | undefined;
}

const DEFAULT_MEMORY_CONTEXT = (alert: PriceAlert): AlertMemoryContext => ({
  card: {
    name: alert.cardId,
    setName: null,
    number: null,
    imageUrl: null,
    cardmarketUrl: null,
  },
  owner: { discordUserId: null, discordWebhookUrl: null },
  snapshot: null,
});

/** {@link AlertService} en mémoire : mêmes règles d'isolation par utilisateur, aucune I/O. */
export const makeAlertServiceMemory = (
  options?: AlertServiceMemoryOptions,
): AlertServiceMemoryHandle => {
  const alerts = new Map<string, PriceAlert>();
  const events: Array<AlertEvent> = [];
  const subscriptions = new Map<string, PushSubscription>();
  const contexts = new Map<string, AlertMemoryContext>();
  let sequence = 0;
  const nextId = (): string => {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  };
  const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

  const requireUser = (userId: string): Effect.Effect<string, ValidationError> =>
    isUuid(userId)
      ? Effect.succeed(userId.toLowerCase())
      : Effect.fail(new ValidationError({ message: "userId must be a valid UUID" }));

  const ownAlert = (
    uid: string,
    alertId: string,
  ): Effect.Effect<PriceAlert, AlertNotFoundError> => {
    const alert = alerts.get(alertId.toLowerCase());
    return alert !== undefined && alert.userId.toLowerCase() === uid
      ? Effect.succeed(alert)
      : Effect.fail(alertNotFound(alertId));
  };

  const ownEventIndex = (uid: string, eventId: string): number =>
    events.findIndex((e) => e.id === eventId.toLowerCase() && e.userId.toLowerCase() === uid);

  const impl: AlertServiceShape = {
    listAlerts: (userId) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        return [...alerts.values()]
          .filter((a) => a.userId.toLowerCase() === uid)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      }),

    createAlert: (userId, input) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const v = yield* decodeCreatePriceAlertInput(input);
        if (options?.knownCardIds !== undefined && !options.knownCardIds.has(v.cardId)) {
          return yield* Effect.fail(new AlertValidationError({ message: "unknown card" }));
        }
        const now = yield* nowIso;
        const alert: PriceAlert = {
          id: nextId(),
          userId: uid,
          cardId: v.cardId,
          language: v.language ?? "FR",
          variant: v.variant ?? "normal",
          minCondition: v.minCondition ?? "NM",
          priceField: v.priceField ?? "low_fr",
          thresholdCents: v.thresholdCents,
          isActive: v.isActive ?? true,
          notifyPush: v.notifyPush ?? true,
          notifyDiscord: v.notifyDiscord ?? false,
          cooldownHours: v.cooldownHours ?? DEFAULT_ALERT_COOLDOWN_HOURS,
          lastTriggeredAt: null,
          createdAt: now,
          updatedAt: now,
        };
        alerts.set(alert.id, alert);
        return alert;
      }),

    updateAlert: (userId, alertId, patch) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const v = yield* decodeUpdatePriceAlertInput(patch);
        const current = yield* ownAlert(uid, alertId);
        const now = yield* nowIso;
        const updated: PriceAlert = {
          ...current,
          language: v.language ?? current.language,
          variant: v.variant ?? current.variant,
          minCondition: v.minCondition ?? current.minCondition,
          priceField: v.priceField ?? current.priceField,
          thresholdCents: v.thresholdCents ?? current.thresholdCents,
          isActive: v.isActive ?? current.isActive,
          notifyPush: v.notifyPush ?? current.notifyPush,
          notifyDiscord: v.notifyDiscord ?? current.notifyDiscord,
          cooldownHours: v.cooldownHours ?? current.cooldownHours,
          updatedAt: now,
        };
        alerts.set(updated.id, updated);
        return updated;
      }),

    deleteAlert: (userId, alertId) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const alert = yield* ownAlert(uid, alertId);
        alerts.delete(alert.id);
        contexts.delete(alert.id);
        // ON DELETE CASCADE : l'historique de l'alerte disparaît avec elle.
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]?.alertId === alert.id) events.splice(i, 1);
        }
      }),

    listEvents: (userId, limit) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        return events
          .filter((e) => e.userId.toLowerCase() === uid)
          .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt) || b.id.localeCompare(a.id))
          .slice(0, clampLimit(limit));
      }),

    countUnreadEvents: (userId) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        return events.filter((e) => e.userId.toLowerCase() === uid && e.readAt === null).length;
      }),

    markEventRead: (userId, eventId) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const index = ownEventIndex(uid, eventId);
        const current = events[index];
        if (current === undefined) return yield* Effect.fail(eventNotFound(eventId));
        const now = yield* nowIso;
        const updated: AlertEvent = { ...current, readAt: current.readAt ?? now };
        events[index] = updated;
        return updated;
      }),

    markAllEventsRead: (userId) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const now = yield* nowIso;
        let count = 0;
        events.forEach((event, index) => {
          if (event.userId.toLowerCase() === uid && event.readAt === null) {
            events[index] = { ...event, readAt: now };
            count += 1;
          }
        });
        return count;
      }),

    upsertPushSubscription: (userId, input) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const v = yield* decodeRegisterPushSubscriptionInput(input);
        const now = yield* nowIso;
        const existing = subscriptions.get(v.endpoint);
        if (existing !== undefined && existing.userId.toLowerCase() !== uid) {
          return yield* Effect.fail(
            new AlertValidationError({ message: "this endpoint is registered by another account" }),
          );
        }
        const subscription: PushSubscription = {
          id: existing?.id ?? nextId(),
          userId: uid,
          endpoint: v.endpoint,
          p256dh: v.p256dh,
          auth: v.auth,
          userAgent: v.userAgent ?? null,
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
        };
        subscriptions.set(subscription.endpoint, subscription);
        return subscription;
      }),

    deletePushSubscription: (userId, endpoint) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        const existing = subscriptions.get(endpoint);
        if (existing !== undefined && existing.userId.toLowerCase() === uid) {
          subscriptions.delete(endpoint);
        }
      }),

    listPushSubscriptions: (userId) =>
      Effect.gen(function* () {
        const uid = yield* requireUser(userId);
        return [...subscriptions.values()]
          .filter((s) => s.userId.toLowerCase() === uid)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      }),

    listActiveAlertsForEvaluation: () =>
      Effect.sync(() =>
        [...alerts.values()]
          .filter((alert) => alert.isActive)
          .map((alert): AlertEvaluationCandidate => {
            const context = contexts.get(alert.id) ?? DEFAULT_MEMORY_CONTEXT(alert);
            return { alert, ...context };
          }),
      ),

    recordTriggeredEvent: (input) =>
      Effect.gen(function* () {
        const alert = alerts.get(input.alertId);
        if (alert === undefined || alert.userId !== input.userId) {
          return yield* Effect.fail(
            new DatabaseError({ message: "alert_events.user_id must match the alert owner" }),
          );
        }
        const now = yield* nowIso;
        const event: AlertEvent = {
          id: nextId(),
          alertId: input.alertId,
          userId: input.userId,
          observedPriceCents: input.observedPriceCents,
          thresholdCents: input.thresholdCents,
          channelsSent: [...input.channelsSent],
          readAt: null,
          triggeredAt: now,
        };
        events.push(event);
        alerts.set(alert.id, { ...alert, lastTriggeredAt: now });
        return event;
      }),

    deleteExpiredPushSubscription: (endpoint) => Effect.sync(() => subscriptions.delete(endpoint)),
  };

  return { layer: Layer.succeed(AlertService, impl), alerts, events, subscriptions, contexts };
};

/** Layer {@link AlertService} en mémoire sans accès à l'état (voir {@link makeAlertServiceMemory}). */
export const AlertServiceMemory: Layer.Layer<AlertService> = Layer.suspend(
  () => makeAlertServiceMemory().layer,
);
