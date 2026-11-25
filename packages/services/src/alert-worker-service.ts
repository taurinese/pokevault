import {
  type AlertEvaluationBatchReport,
  evaluatePriceAlert,
  isAllowedDiscordWebhookUrl,
  isValidDiscordUserId,
  type NotificationChannel,
  type PushSubscription,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { type AlertEvaluationCandidate, AlertService, AlertServiceLive } from "./alert-service.ts";
import { type DatabaseError, DatabaseLive } from "./db.ts";
import {
  type AlertNotification,
  NotificationService,
  NotificationServiceLive,
  type VapidConfig,
} from "./notification-service.ts";

// ---------------------------------------------------------------------------
// Contrat
// ---------------------------------------------------------------------------

export interface AlertWorkerServiceShape {
  /**
   * Un passage complet : lit les alertes actives (avec dernier prix et coordonnées du
   * propriétaire), les évalue (moteur pur), notifie les canaux demandés, puis enregistre
   * `alert_events` + `last_triggered_at`.
   *
   * Règle de persistance (anti-spam) : l'évènement et `last_triggered_at` ne sont écrits QUE si
   * au moins un canal a réellement livré (`channels_sent` = canaux livrés avec succès). Si tous
   * les canaux échouent, rien n'est écrit : l'alerte reste éligible et sera retentée au passage
   * suivant (aucun faux évènement « envoyé », aucun cooldown consommé). Si un canal réussit et
   * un autre échoue, l'évènement est écrit avec le seul canal réussi (le cooldown s'applique
   * ensuite à toute l'alerte : l'échec partiel n'est pas rejoué).
   */
  readonly evaluateAndNotify: () => Effect.Effect<AlertEvaluationBatchReport, DatabaseError>;
}

/** Effect-TS service key of the alert evaluation worker. */
export class AlertWorkerService extends Context.Service<
  AlertWorkerService,
  AlertWorkerServiceShape
>()("@pokevault/services/AlertWorkerService") {}

export interface AlertWorkerConfig {
  /** Webhook Discord par défaut de l'instance (utilisé en dernier recours). */
  readonly defaultDiscordWebhookUrl?: string | undefined;
  /** `true` si un jeton de bot Discord est configuré : active l'envoi en DM. */
  readonly discordBotEnabled?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Implémentation
// ---------------------------------------------------------------------------

interface Counters {
  evaluated: number;
  triggered: number;
  skippedCooldown: number;
  skippedAboveThreshold: number;
  skippedNoPrice: number;
  pushSent: number;
  pushExpiredRemoved: number;
  discordSent: number;
  deliveryFailed: number;
}

type Attempt<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

/** Transforme un échec typé en valeur (l'interruption, elle, est toujours propagée). */
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Attempt<A, E>, never, R> =>
  effect.pipe(
    Effect.map((value): Attempt<A, E> => ({ ok: true, value })),
    Effect.catch((error) => Effect.succeed<Attempt<A, E>>({ ok: false, error })),
  );

/** Message d'erreur sûr à journaliser : jamais d'URL (jetons de webhook), seulement tag + statut. */
const errorSummary = (error: unknown): Record<string, unknown> => {
  if (typeof error === "object" && error !== null) {
    const record = error as { readonly _tag?: unknown; readonly status?: unknown };
    return {
      errorTag: typeof record._tag === "string" ? record._tag : "unknown",
      ...(typeof record.status === "number" ? { status: record.status } : {}),
    };
  }
  return { errorTag: "unknown" };
};

const toNotification = (candidate: AlertEvaluationCandidate, observedPriceCents: number) =>
  ({
    alertId: candidate.alert.id,
    cardId: candidate.alert.cardId,
    cardName: candidate.card.name,
    setName: candidate.card.setName,
    cardNumber: candidate.card.number,
    priceField: candidate.alert.priceField,
    observedPriceCents,
    thresholdCents: candidate.alert.thresholdCents,
    imageUrl: candidate.card.imageUrl,
    cardmarketUrl: candidate.card.cardmarketUrl,
  }) satisfies AlertNotification;

/**
 * Orchestration évaluation → envoi → persistance. Dépend uniquement des ports
 * `AlertService` et `NotificationService` : testable à 100 % hors ligne (Memory + Fake).
 */
export const AlertWorkerServiceLive = (
  config?: AlertWorkerConfig,
): Layer.Layer<AlertWorkerService, never, AlertService | NotificationService> =>
  Layer.effect(
    AlertWorkerService,
    Effect.gen(function* () {
      const alerts = yield* AlertService;
      const notifications = yield* NotificationService;
      const defaultWebhook = config?.defaultDiscordWebhookUrl?.trim();
      const discordBotEnabled = config?.discordBotEnabled ?? false;

      /** Web Push sur tous les appareils ; purge 404/410 ; renvoie le nombre de livraisons réussies. */
      const deliverPush = (
        candidate: AlertEvaluationCandidate,
        notification: AlertNotification,
        subscriptionsOf: (userId: string) => Effect.Effect<ReadonlyArray<PushSubscription>>,
        counters: Counters,
      ): Effect.Effect<number> =>
        Effect.gen(function* () {
          const subscriptions = yield* subscriptionsOf(candidate.alert.userId);
          if (subscriptions.length === 0) {
            yield* Effect.logInfo("worker.alert.no_push_subscription").pipe(
              Effect.annotateLogs({ alertId: candidate.alert.id }),
            );
            return 0;
          }
          let delivered = 0;
          for (const subscription of subscriptions) {
            const result = yield* attempt(notifications.sendWebPush(subscription, notification));
            if (result.ok) {
              delivered += 1;
              counters.pushSent += 1;
              continue;
            }
            if (result.error._tag === "PushSubscriptionGoneError") {
              const purge = yield* attempt(
                alerts.deleteExpiredPushSubscription(subscription.endpoint),
              );
              if (purge.ok) {
                if (purge.value) counters.pushExpiredRemoved += 1;
              } else {
                counters.deliveryFailed += 1;
                yield* Effect.logWarning("worker.alert.push_purge_failed").pipe(
                  Effect.annotateLogs({ alertId: candidate.alert.id }),
                );
              }
              yield* Effect.logInfo("worker.alert.push_subscription_expired").pipe(
                Effect.annotateLogs({
                  alertId: candidate.alert.id,
                  status: result.error.status,
                }),
              );
              continue;
            }
            counters.deliveryFailed += 1;
            yield* Effect.logWarning("worker.alert.push_failed").pipe(
              Effect.annotateLogs({ alertId: candidate.alert.id, ...errorSummary(result.error) }),
            );
          }
          return delivered;
        });

      /**
       * Discord : webhook perso → DM bot (si activé et compte lié) → webhook par défaut de
       * l'instance ; le premier succès gagne. Renvoie `true` si une destination a livré.
       */
      const deliverDiscord = (
        candidate: AlertEvaluationCandidate,
        notification: AlertNotification,
        counters: Counters,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          type Destination =
            | { readonly kind: "webhook"; readonly url: string }
            | { readonly kind: "dm"; readonly userId: string };
          const destinations: Array<Destination> = [];
          const personal = candidate.owner.discordWebhookUrl;
          if (personal !== null && personal.trim().length > 0) {
            if (isAllowedDiscordWebhookUrl(personal.trim())) {
              destinations.push({ kind: "webhook", url: personal.trim() });
            } else {
              yield* Effect.logWarning("worker.alert.discord_invalid_webhook").pipe(
                Effect.annotateLogs({ alertId: candidate.alert.id }),
              );
            }
          }
          if (discordBotEnabled && isValidDiscordUserId(candidate.owner.discordUserId)) {
            destinations.push({ kind: "dm", userId: candidate.owner.discordUserId });
          }
          if (defaultWebhook !== undefined && isAllowedDiscordWebhookUrl(defaultWebhook)) {
            destinations.push({ kind: "webhook", url: defaultWebhook });
          }
          if (destinations.length === 0) {
            yield* Effect.logInfo("worker.alert.no_discord_destination").pipe(
              Effect.annotateLogs({ alertId: candidate.alert.id }),
            );
            return false;
          }
          for (const destination of destinations) {
            const result = yield* attempt(
              destination.kind === "webhook"
                ? notifications.sendDiscordWebhook(destination.url, notification)
                : notifications.sendDiscordDm(destination.userId, notification),
            );
            if (result.ok) {
              counters.discordSent += 1;
              return true;
            }
            yield* Effect.logWarning("worker.alert.discord_failed").pipe(
              Effect.annotateLogs({
                alertId: candidate.alert.id,
                destination: destination.kind,
                ...errorSummary(result.error),
              }),
            );
          }
          counters.deliveryFailed += 1;
          return false;
        });

      const evaluateAndNotify: AlertWorkerServiceShape["evaluateAndNotify"] = () =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const candidates = yield* alerts.listActiveAlertsForEvaluation();
          const counters: Counters = {
            evaluated: 0,
            triggered: 0,
            skippedCooldown: 0,
            skippedAboveThreshold: 0,
            skippedNoPrice: 0,
            pushSent: 0,
            pushExpiredRemoved: 0,
            discordSent: 0,
            deliveryFailed: 0,
          };

          // Abonnements push lus une seule fois par utilisateur et par passage.
          const subscriptionCache = new Map<string, ReadonlyArray<PushSubscription>>();
          const subscriptionsOf = (
            userId: string,
          ): Effect.Effect<ReadonlyArray<PushSubscription>> =>
            Effect.gen(function* () {
              const cached = subscriptionCache.get(userId);
              if (cached !== undefined) return cached;
              const result = yield* attempt(alerts.listPushSubscriptions(userId));
              if (!result.ok) {
                counters.deliveryFailed += 1;
                yield* Effect.logWarning("worker.alert.push_subscriptions_failed").pipe(
                  Effect.annotateLogs(errorSummary(result.error)),
                );
                return [];
              }
              subscriptionCache.set(userId, result.value);
              return result.value;
            });

          for (const candidate of candidates) {
            counters.evaluated += 1;
            const evaluation = evaluatePriceAlert(candidate.alert, candidate.snapshot, startedAt);
            if (evaluation.decision === "skip") {
              switch (evaluation.reason) {
                case "cooldown":
                  counters.skippedCooldown += 1;
                  break;
                case "above_threshold":
                  counters.skippedAboveThreshold += 1;
                  break;
                case "no_price":
                case "fallback_only":
                case "field_missing":
                  counters.skippedNoPrice += 1;
                  break;
                case "inactive":
                case "no_channels":
                  break;
              }
              continue;
            }

            counters.triggered += 1;
            const notification = toNotification(candidate, evaluation.observedPriceCents);
            const channelsSent: Array<NotificationChannel> = [];
            if (evaluation.channels.includes("push")) {
              const delivered = yield* deliverPush(
                candidate,
                notification,
                subscriptionsOf,
                counters,
              );
              if (delivered > 0) channelsSent.push("push");
            }
            if (evaluation.channels.includes("discord")) {
              if (yield* deliverDiscord(candidate, notification, counters)) {
                channelsSent.push("discord");
              }
            }

            if (channelsSent.length === 0) {
              yield* Effect.logWarning("worker.alert.not_delivered").pipe(
                Effect.annotateLogs({
                  alertId: candidate.alert.id,
                  channels: evaluation.channels.join(","),
                }),
              );
              continue;
            }
            const recorded = yield* attempt(
              alerts.recordTriggeredEvent({
                alertId: candidate.alert.id,
                userId: candidate.alert.userId,
                observedPriceCents: evaluation.observedPriceCents,
                thresholdCents: evaluation.thresholdCents,
                channelsSent,
              }),
            );
            if (!recorded.ok) {
              // Notifié mais non enregistré : sera réévalué au prochain passage.
              counters.deliveryFailed += 1;
              yield* Effect.logError("worker.alert.record_failed").pipe(
                Effect.annotateLogs({
                  alertId: candidate.alert.id,
                  ...errorSummary(recorded.error),
                }),
              );
            }
          }

          const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
          const report: AlertEvaluationBatchReport = { ...counters, durationMs };
          yield* Effect.logInfo("alerts.batch.completed").pipe(Effect.annotateLogs({ ...report }));
          return report;
        });

      return { evaluateAndNotify } satisfies AlertWorkerServiceShape;
    }),
  );

// ---------------------------------------------------------------------------
// Composition prête à l'emploi (bootstrap du worker)
// ---------------------------------------------------------------------------

export interface AlertWorkerLayerOptions {
  readonly databaseUrl: string;
  /** URL publique de l'app (liens des notifications). */
  readonly appUrl: string;
  readonly vapid?: VapidConfig | undefined;
  readonly discordBotToken?: string | undefined;
  readonly defaultDiscordWebhookUrl?: string | undefined;
  readonly notificationTimeoutMs?: number | undefined;
}

/**
 * Layer complet : `AlertWorkerService` sur le service d'alertes Postgres et les notifications
 * live. Le pool Postgres est lié au scope de construction (arrêt du worker).
 */
export const AlertWorkerLayer = (
  options: AlertWorkerLayerOptions,
): Layer.Layer<AlertWorkerService> =>
  AlertWorkerServiceLive({
    defaultDiscordWebhookUrl: options.defaultDiscordWebhookUrl,
    discordBotEnabled:
      options.discordBotToken !== undefined && options.discordBotToken.trim().length > 0,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        AlertServiceLive.pipe(
          Layer.provide(DatabaseLive({ connectionString: options.databaseUrl })),
        ),
        NotificationServiceLive({
          appUrl: options.appUrl,
          vapid: options.vapid,
          discordBotToken: options.discordBotToken,
          timeoutMs: options.notificationTimeoutMs,
        }),
      ),
    ),
  );
