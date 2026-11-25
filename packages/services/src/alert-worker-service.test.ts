import {
  type AlertPriceSnapshot,
  NotificationDeliveryError,
  PushSubscriptionGoneError,
} from "@pokevault/domain";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  AlertService,
  type AlertServiceMemoryHandle,
  makeAlertServiceMemory,
} from "./alert-service.ts";
import { AlertWorkerService, AlertWorkerServiceLive } from "./alert-worker-service.ts";
import {
  makeNotificationServiceFake,
  type NotificationServiceFakeHandlers,
  type NotificationServiceRecorder,
} from "./notification-service.ts";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);
const HOUR = 3_600_000;
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(30)}`;
const DEFAULT_WEBHOOK = `https://discord.com/api/webhooks/223456789012345678/${"b".repeat(30)}`;
const DISCORD_USER = "323456789012345678";

const CHEAP: AlertPriceSnapshot = { source: "cardmarket", lowFrCents: 4690, trendCents: 5100 };

interface Scenario {
  readonly handle: AlertServiceMemoryHandle;
  readonly notifier: NotificationServiceRecorder;
}

const run = <A>(
  options: {
    readonly handlers?: NotificationServiceFakeHandlers;
    readonly config?: Parameters<typeof AlertWorkerServiceLive>[0];
  },
  body: (scenario: Scenario) => Effect.Effect<A, unknown, AlertWorkerService | AlertService>,
): Promise<A> => {
  const handle = makeAlertServiceMemory();
  const notifier = makeNotificationServiceFake(options.handlers);
  const layer = AlertWorkerServiceLive(options.config).pipe(
    Layer.provideMerge(Layer.mergeAll(handle.layer, notifier.layer)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({ handle, notifier });
    }).pipe(Effect.provide(layer)),
  );
};

const evaluate = Effect.flatMap(AlertWorkerService, (s) => s.evaluateAndNotify());

/** Crée une alerte (+ contexte) et renvoie son id. */
const seedAlert = (
  handle: AlertServiceMemoryHandle,
  input: {
    readonly userId?: string;
    readonly cardId?: string;
    readonly thresholdCents?: number;
    readonly notifyPush?: boolean;
    readonly notifyDiscord?: boolean;
    readonly snapshot?: AlertPriceSnapshot | null;
    readonly discordWebhookUrl?: string | null;
    readonly discordUserId?: string | null;
    readonly cooldownHours?: number;
    readonly isActive?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* AlertService;
    const alert = yield* service.createAlert(input.userId ?? ALICE, {
      cardId: input.cardId ?? "sv03.5-198",
      thresholdCents: input.thresholdCents ?? 5000,
      notifyPush: input.notifyPush ?? true,
      notifyDiscord: input.notifyDiscord ?? false,
      ...(input.cooldownHours === undefined ? {} : { cooldownHours: input.cooldownHours }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    });
    handle.contexts.set(alert.id, {
      card: {
        name: "Florizarre-ex",
        setName: "151",
        number: "198",
        imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/198/low.webp",
        cardmarketUrl: null,
      },
      owner: {
        discordUserId: input.discordUserId ?? null,
        discordWebhookUrl: input.discordWebhookUrl ?? null,
      },
      snapshot: input.snapshot === undefined ? CHEAP : input.snapshot,
    });
    return alert;
  });

const subscribe = (userId: string, endpoint: string) =>
  Effect.flatMap(AlertService, (s) =>
    s.upsertPushSubscription(userId, { endpoint, p256dh: P256DH, auth: AUTH }),
  );

describe("AlertWorkerService — déclenchement", () => {
  it("push : envoie à tous les appareils, enregistre l'évènement et last_triggered_at", () =>
    run({}, ({ handle, notifier }) =>
      Effect.gen(function* () {
        const alert = yield* seedAlert(handle);
        yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/one");
        yield* subscribe(ALICE, "https://updates.push.services.mozilla.com/wpush/v2/two");
        const report = yield* evaluate;
        expect(report).toMatchObject({
          evaluated: 1,
          triggered: 1,
          pushSent: 2,
          pushExpiredRemoved: 0,
          discordSent: 0,
          deliveryFailed: 0,
        });
        expect(notifier.calls.filter((c) => c.kind === "push")).toHaveLength(2);
        const pushed = notifier.calls[0];
        expect(pushed?.notification).toMatchObject({
          alertId: alert.id,
          cardName: "Florizarre-ex",
          observedPriceCents: 4690,
          thresholdCents: 5000,
          priceField: "low_fr",
        });
        expect(handle.events).toHaveLength(1);
        expect(handle.events[0]).toMatchObject({
          alertId: alert.id,
          userId: ALICE,
          observedPriceCents: 4690,
          thresholdCents: 5000,
          channelsSent: ["push"],
          readAt: null,
        });
        expect(handle.alerts.get(alert.id)?.lastTriggeredAt).not.toBeNull();
      }),
    ));

  it("cooldown : un second passage dans la fenêtre n'envoie rien, puis ré-alerte après expiration", () =>
    run({}, ({ handle, notifier }) =>
      Effect.gen(function* () {
        yield* seedAlert(handle, { cooldownHours: 24 });
        yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/one");
        const first = yield* evaluate;
        expect(first.triggered).toBe(1);

        yield* TestClock.adjust(23 * HOUR);
        const second = yield* evaluate;
        expect(second).toMatchObject({ triggered: 0, skippedCooldown: 1, pushSent: 0 });
        expect(notifier.calls).toHaveLength(1);

        yield* TestClock.adjust(2 * HOUR);
        const third = yield* evaluate;
        expect(third).toMatchObject({ triggered: 1, skippedCooldown: 0, pushSent: 1 });
        expect(handle.events).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  it("compte les alertes au-dessus du seuil, sans prix et en prix indicatif TCGdex", () =>
    run({}, ({ handle, notifier }) =>
      Effect.gen(function* () {
        yield* seedAlert(handle, { thresholdCents: 4000 }); // 46,90 € > 40 €
        yield* seedAlert(handle, { snapshot: null });
        yield* seedAlert(handle, { snapshot: { ...CHEAP, source: "tcgdex_fallback" } });
        yield* seedAlert(handle, { snapshot: { ...CHEAP, lowFrCents: null } });
        yield* seedAlert(handle, { isActive: false });
        const report = yield* evaluate;
        expect(report).toMatchObject({
          evaluated: 4,
          triggered: 0,
          skippedAboveThreshold: 1,
          skippedNoPrice: 3,
        });
        expect(notifier.calls).toHaveLength(0);
        expect(handle.events).toHaveLength(0);
      }),
    ));
});

describe("AlertWorkerService — Web Push 404/410", () => {
  it("purge automatiquement les abonnements expirés et livre aux autres", () =>
    run(
      {
        handlers: {
          push: (target) =>
            target.endpoint.endsWith("/gone")
              ? Effect.fail(
                  new PushSubscriptionGoneError({
                    endpoint: target.endpoint,
                    status: 410,
                    message: "gone",
                  }),
                )
              : Effect.void,
        },
      },
      ({ handle }) =>
        Effect.gen(function* () {
          yield* seedAlert(handle);
          yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/gone");
          yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/alive");
          const report = yield* evaluate;
          expect(report).toMatchObject({ pushSent: 1, pushExpiredRemoved: 1, deliveryFailed: 0 });
          expect([...handle.subscriptions.keys()]).toEqual([
            "https://fcm.googleapis.com/fcm/send/alive",
          ]);
          expect(handle.events[0]?.channelsSent).toEqual(["push"]);
        }),
    ));

  it("si le seul abonnement est expiré : purgé, aucun évènement, aucun cooldown consommé", () =>
    run(
      {
        handlers: {
          push: (target) =>
            Effect.fail(
              new PushSubscriptionGoneError({
                endpoint: target.endpoint,
                status: 404,
                message: "gone",
              }),
            ),
        },
      },
      ({ handle }) =>
        Effect.gen(function* () {
          const alert = yield* seedAlert(handle);
          yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/gone");
          const report = yield* evaluate;
          expect(report).toMatchObject({
            triggered: 1,
            pushSent: 0,
            pushExpiredRemoved: 1,
            deliveryFailed: 0,
          });
          expect(handle.subscriptions.size).toBe(0);
          expect(handle.events).toHaveLength(0);
          expect(handle.alerts.get(alert.id)?.lastTriggeredAt).toBeNull();
        }),
    ));
});

describe("AlertWorkerService — échecs de livraison (jamais de faux évènement)", () => {
  it("tous les canaux échouent : deliveryFailed, aucun évènement, alerte retentée au passage suivant", () =>
    run(
      {
        handlers: {
          push: () =>
            Effect.fail(new NotificationDeliveryError({ channel: "push", message: "down" })),
        },
      },
      ({ handle, notifier }) =>
        Effect.gen(function* () {
          const alert = yield* seedAlert(handle);
          yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/one");
          const first = yield* evaluate;
          expect(first).toMatchObject({ triggered: 1, pushSent: 0, deliveryFailed: 1 });
          expect(handle.events).toHaveLength(0);
          expect(handle.alerts.get(alert.id)?.lastTriggeredAt).toBeNull();
          const second = yield* evaluate;
          expect(second.skippedCooldown).toBe(0);
          expect(notifier.calls).toHaveLength(2); // retenté, pas bloqué par un cooldown fantôme
        }),
    ));

  it("succès partiel : l'évènement ne liste que le canal livré", () =>
    run(
      {
        config: { defaultDiscordWebhookUrl: DEFAULT_WEBHOOK },
        handlers: {
          discordWebhook: () =>
            Effect.fail(
              new NotificationDeliveryError({ channel: "discord", message: "429", status: 429 }),
            ),
        },
      },
      ({ handle }) =>
        Effect.gen(function* () {
          yield* seedAlert(handle, { notifyDiscord: true });
          yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/one");
          const report = yield* evaluate;
          expect(report).toMatchObject({ pushSent: 1, discordSent: 0, deliveryFailed: 1 });
          expect(handle.events[0]?.channelsSent).toEqual(["push"]);
        }),
    ));

  it("aucun appareil et aucune destination Discord : rien d'envoyé, rien d'enregistré, pas d'échec", () =>
    run({}, ({ handle, notifier }) =>
      Effect.gen(function* () {
        const alert = yield* seedAlert(handle, { notifyPush: true, notifyDiscord: true });
        const report = yield* evaluate;
        expect(report).toMatchObject({
          triggered: 1,
          deliveryFailed: 0,
          pushSent: 0,
          discordSent: 0,
        });
        expect(notifier.calls).toHaveLength(0);
        expect(handle.events).toHaveLength(0);
        expect(handle.alerts.get(alert.id)?.lastTriggeredAt).toBeNull();
      }),
    ));
});

describe("AlertWorkerService — Discord", () => {
  it("webhook perso prioritaire : un seul envoi, canal discord enregistré", () =>
    run(
      { config: { defaultDiscordWebhookUrl: DEFAULT_WEBHOOK, discordBotEnabled: true } },
      ({ handle, notifier }) =>
        Effect.gen(function* () {
          yield* seedAlert(handle, {
            notifyPush: false,
            notifyDiscord: true,
            discordWebhookUrl: WEBHOOK,
            discordUserId: DISCORD_USER,
          });
          const report = yield* evaluate;
          expect(report).toMatchObject({ triggered: 1, discordSent: 1, deliveryFailed: 0 });
          expect(notifier.calls).toHaveLength(1);
          expect(notifier.calls[0]).toMatchObject({ kind: "discord_webhook", webhookUrl: WEBHOOK });
          expect(handle.events[0]?.channelsSent).toEqual(["discord"]);
        }),
    ));

  it("repli : webhook perso en échec → DM bot → webhook par défaut de l'instance", () =>
    run(
      {
        config: { defaultDiscordWebhookUrl: DEFAULT_WEBHOOK, discordBotEnabled: true },
        handlers: {
          discordWebhook: (url) =>
            url === WEBHOOK
              ? Effect.fail(new NotificationDeliveryError({ channel: "discord", message: "404" }))
              : Effect.void,
          discordDm: () =>
            Effect.fail(new NotificationDeliveryError({ channel: "discord", message: "403" })),
        },
      },
      ({ handle, notifier }) =>
        Effect.gen(function* () {
          yield* seedAlert(handle, {
            notifyPush: false,
            notifyDiscord: true,
            discordWebhookUrl: WEBHOOK,
            discordUserId: DISCORD_USER,
          });
          const report = yield* evaluate;
          expect(report).toMatchObject({ discordSent: 1, deliveryFailed: 0 });
          expect(notifier.calls.map((c) => c.kind)).toEqual([
            "discord_webhook",
            "discord_dm",
            "discord_webhook",
          ]);
          expect(handle.events[0]?.channelsSent).toEqual(["discord"]);
        }),
    ));

  it("ignore un webhook perso invalide (SSRF) sans l'appeler et retombe sur le défaut", () =>
    run({ config: { defaultDiscordWebhookUrl: DEFAULT_WEBHOOK } }, ({ handle, notifier }) =>
      Effect.gen(function* () {
        yield* seedAlert(handle, {
          notifyPush: false,
          notifyDiscord: true,
          discordWebhookUrl: "https://169.254.169.254/latest/meta-data",
        });
        yield* evaluate;
        expect(notifier.calls).toHaveLength(1);
        expect(notifier.calls[0]).toMatchObject({
          kind: "discord_webhook",
          webhookUrl: DEFAULT_WEBHOOK,
        });
      }),
    ));

  it("n'utilise pas le DM si le bot n'est pas configuré", () =>
    run({}, ({ handle, notifier }) =>
      Effect.gen(function* () {
        yield* seedAlert(handle, {
          notifyPush: false,
          notifyDiscord: true,
          discordUserId: DISCORD_USER,
        });
        yield* evaluate;
        expect(notifier.calls).toHaveLength(0);
      }),
    ));
});

describe("AlertWorkerService — isolation multi-utilisateurs", () => {
  it("notifie chaque propriétaire uniquement sur ses propres appareils", () =>
    run({}, ({ handle, notifier }) =>
      Effect.gen(function* () {
        yield* seedAlert(handle, { userId: ALICE });
        yield* seedAlert(handle, { userId: BOB });
        yield* subscribe(ALICE, "https://fcm.googleapis.com/fcm/send/alice");
        yield* subscribe(BOB, "https://fcm.googleapis.com/fcm/send/bob");
        const report = yield* evaluate;
        expect(report).toMatchObject({ evaluated: 2, triggered: 2, pushSent: 2 });
        const byUser = new Map(handle.events.map((e) => [e.userId, e]));
        expect(byUser.get(ALICE)?.channelsSent).toEqual(["push"]);
        expect(byUser.get(BOB)?.channelsSent).toEqual(["push"]);
        const endpoints = notifier.calls.flatMap((c) =>
          c.kind === "push" ? [c.target.endpoint] : [],
        );
        expect(endpoints.sort()).toEqual([
          "https://fcm.googleapis.com/fcm/send/alice",
          "https://fcm.googleapis.com/fcm/send/bob",
        ]);
      }),
    ));
});
