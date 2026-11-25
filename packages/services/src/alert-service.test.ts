import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AlertService,
  type AlertServiceShape,
  makeAlertServiceMemory,
  mapAlertError,
} from "./alert-service.ts";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);

const run = <A>(
  body: (
    service: AlertServiceShape,
    handle: ReturnType<typeof makeAlertServiceMemory>,
  ) => Effect.Effect<A, unknown>,
  options?: Parameters<typeof makeAlertServiceMemory>[0],
): Promise<A> => {
  const handle = makeAlertServiceMemory(options);
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* AlertService, handle);
    }).pipe(Effect.provide(handle.layer)),
  );
};

const failureOf = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<E, A> => Effect.flip(effect);

describe("AlertService (Memory) — alertes", () => {
  it("crée une alerte avec les défauts SQL (FR / normal / NM / low_fr / actif / push / 24 h)", () =>
    run((service) =>
      Effect.gen(function* () {
        const alert = yield* service.createAlert(ALICE, {
          cardId: "sv08-001",
          thresholdCents: 5000,
        });
        expect(alert).toMatchObject({
          userId: ALICE,
          cardId: "sv08-001",
          language: "FR",
          variant: "normal",
          minCondition: "NM",
          priceField: "low_fr",
          thresholdCents: 5000,
          isActive: true,
          notifyPush: true,
          notifyDiscord: false,
          cooldownHours: 24,
          lastTriggeredAt: null,
        });
        expect(yield* service.listAlerts(ALICE)).toEqual([alert]);
      }),
    ));

  it("valide les entrées (seuil, cooldown, patch vide) avec AlertValidationError", () =>
    run((service) =>
      Effect.gen(function* () {
        const create = yield* failureOf(
          service.createAlert(ALICE, { cardId: "sv08-001", thresholdCents: 0 }),
        );
        expect(create).toMatchObject({ _tag: "AlertValidationError" });
        const alert = yield* service.createAlert(ALICE, {
          cardId: "sv08-001",
          thresholdCents: 100,
        });
        const emptyPatch = yield* failureOf(service.updateAlert(ALICE, alert.id, {}));
        expect(emptyPatch).toMatchObject({ _tag: "AlertValidationError" });
        const badCooldown = yield* failureOf(
          service.updateAlert(ALICE, alert.id, { cooldownHours: 200 }),
        );
        expect(badCooldown).toMatchObject({ _tag: "AlertValidationError" });
        const badUser = yield* failureOf(
          service.createAlert("not-a-uuid", { cardId: "sv08-001", thresholdCents: 100 }),
        );
        expect(badUser).toMatchObject({ _tag: "ValidationError" });
      }),
    ));

  it("refuse une carte hors catalogue quand le catalogue est fourni (FK)", () =>
    run(
      (service) =>
        Effect.gen(function* () {
          const error = yield* failureOf(
            service.createAlert(ALICE, { cardId: "unknown-1", thresholdCents: 100 }),
          );
          expect(error).toMatchObject({ _tag: "AlertValidationError" });
          yield* service.createAlert(ALICE, { cardId: "sv08-001", thresholdCents: 100 });
        }),
      { knownCardIds: new Set(["sv08-001"]) },
    ));

  it("met à jour partiellement et ne touche pas aux autres champs", () =>
    run((service) =>
      Effect.gen(function* () {
        const alert = yield* service.createAlert(ALICE, {
          cardId: "sv08-001",
          thresholdCents: 5000,
          notifyDiscord: true,
        });
        const updated = yield* service.updateAlert(ALICE, alert.id, {
          thresholdCents: 4000,
          isActive: false,
          cooldownHours: 48,
        });
        expect(updated).toMatchObject({
          thresholdCents: 4000,
          isActive: false,
          cooldownHours: 48,
          notifyDiscord: true,
          notifyPush: true,
          cardId: "sv08-001",
        });
      }),
    ));

  it("isole les utilisateurs : alerte d'un autre ⇒ AlertNotFoundError (lecture, patch, suppression)", () =>
    run((service) =>
      Effect.gen(function* () {
        const alert = yield* service.createAlert(ALICE, {
          cardId: "sv08-001",
          thresholdCents: 100,
        });
        expect(yield* service.listAlerts(BOB)).toEqual([]);
        const patch = yield* failureOf(service.updateAlert(BOB, alert.id, { isActive: false }));
        expect(patch).toMatchObject({ _tag: "AlertNotFoundError", alertId: alert.id });
        const remove = yield* failureOf(service.deleteAlert(BOB, alert.id));
        expect(remove).toMatchObject({ _tag: "AlertNotFoundError" });
        const unknown = yield* failureOf(service.deleteAlert(ALICE, "not-a-uuid"));
        expect(unknown).toMatchObject({ _tag: "AlertNotFoundError" });
        yield* service.deleteAlert(ALICE, alert.id);
        expect(yield* service.listAlerts(ALICE)).toEqual([]);
      }),
    ));
});

describe("AlertService (Memory) — évènements", () => {
  const seedEvents = (service: AlertServiceShape) =>
    Effect.gen(function* () {
      const alert = yield* service.createAlert(ALICE, { cardId: "sv08-001", thresholdCents: 5000 });
      const first = yield* service.recordTriggeredEvent({
        alertId: alert.id,
        userId: ALICE,
        observedPriceCents: 4700,
        thresholdCents: 5000,
        channelsSent: ["push"],
      });
      const second = yield* service.recordTriggeredEvent({
        alertId: alert.id,
        userId: ALICE,
        observedPriceCents: 4600,
        thresholdCents: 5000,
        channelsSent: ["push", "discord"],
      });
      return { alert, first, second };
    });

  it("recordTriggeredEvent écrit l'évènement ET last_triggered_at ensemble", () =>
    run((service) =>
      Effect.gen(function* () {
        const { alert, first } = yield* seedEvents(service);
        expect(first).toMatchObject({ readAt: null, channelsSent: ["push"] });
        const [stored] = yield* service.listAlerts(ALICE);
        expect(stored?.id).toBe(alert.id);
        expect(stored?.lastTriggeredAt).not.toBeNull();
      }),
    ));

  it("refuse un évènement dont le user_id n'est pas le propriétaire (trigger SQL miroir)", () =>
    run((service) =>
      Effect.gen(function* () {
        const alert = yield* service.createAlert(ALICE, {
          cardId: "sv08-001",
          thresholdCents: 100,
        });
        const error = yield* failureOf(
          service.recordTriggeredEvent({
            alertId: alert.id,
            userId: BOB,
            observedPriceCents: 1,
            thresholdCents: 100,
            channelsSent: ["push"],
          }),
        );
        expect(error._tag).toBe("DatabaseError");
      }),
    ));

  it("liste, compte les non lus, marque lu (idempotent) et tout lire", () =>
    run((service) =>
      Effect.gen(function* () {
        const { first } = yield* seedEvents(service);
        expect((yield* service.listEvents(ALICE)).length).toBe(2);
        expect((yield* service.listEvents(ALICE, 1)).length).toBe(1);
        expect(yield* service.countUnreadEvents(ALICE)).toBe(2);
        expect(yield* service.countUnreadEvents(BOB)).toBe(0);

        const read = yield* service.markEventRead(ALICE, first.id);
        expect(read.readAt).not.toBeNull();
        const again = yield* service.markEventRead(ALICE, first.id);
        expect(again.readAt).toBe(read.readAt);
        expect(yield* service.countUnreadEvents(ALICE)).toBe(1);

        const foreign = yield* failureOf(service.markEventRead(BOB, first.id));
        expect(foreign).toMatchObject({ _tag: "AlertNotFoundError" });
        expect(yield* service.markAllEventsRead(BOB)).toBe(0);
        expect(yield* service.markAllEventsRead(ALICE)).toBe(1);
        expect(yield* service.countUnreadEvents(ALICE)).toBe(0);
      }),
    ));

  it("supprimer l'alerte supprime son historique (ON DELETE CASCADE)", () =>
    run((service) =>
      Effect.gen(function* () {
        const { alert } = yield* seedEvents(service);
        yield* service.deleteAlert(ALICE, alert.id);
        expect(yield* service.listEvents(ALICE)).toEqual([]);
      }),
    ));
});

describe("AlertService (Memory) — abonnements push", () => {
  const input = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    p256dh: P256DH,
    auth: AUTH,
    userAgent: "Vitest",
  };

  it("upsert par endpoint (même id, clés rafraîchies), liste et suppression scopées", () =>
    run((service) =>
      Effect.gen(function* () {
        const first = yield* service.upsertPushSubscription(ALICE, input);
        const refreshed = yield* service.upsertPushSubscription(ALICE, {
          ...input,
          auth: "b".repeat(22),
        });
        expect(refreshed.id).toBe(first.id);
        expect(refreshed.auth).toBe("b".repeat(22));
        expect(yield* service.listPushSubscriptions(ALICE)).toHaveLength(1);
        expect(yield* service.listPushSubscriptions(BOB)).toHaveLength(0);

        yield* service.deletePushSubscription(BOB, input.endpoint);
        expect(yield* service.listPushSubscriptions(ALICE)).toHaveLength(1);
        yield* service.deletePushSubscription(ALICE, input.endpoint);
        expect(yield* service.listPushSubscriptions(ALICE)).toHaveLength(0);
      }),
    ));

  it("refuse un endpoint privé (SSRF) et le vol d'un endpoint d'un autre compte", () =>
    run((service) =>
      Effect.gen(function* () {
        const ssrf = yield* failureOf(
          service.upsertPushSubscription(ALICE, { ...input, endpoint: "https://127.0.0.1/x" }),
        );
        expect(ssrf).toMatchObject({ _tag: "AlertValidationError" });
        yield* service.upsertPushSubscription(ALICE, input);
        const stolen = yield* failureOf(service.upsertPushSubscription(BOB, input));
        expect(stolen).toMatchObject({ _tag: "AlertValidationError" });
        expect((yield* service.listPushSubscriptions(ALICE))[0]?.userId).toBe(ALICE);
      }),
    ));

  it("deleteExpiredPushSubscription (worker) purge sans scope utilisateur", () =>
    run((service) =>
      Effect.gen(function* () {
        yield* service.upsertPushSubscription(ALICE, input);
        expect(yield* service.deleteExpiredPushSubscription(input.endpoint)).toBe(true);
        expect(yield* service.deleteExpiredPushSubscription(input.endpoint)).toBe(false);
      }),
    ));
});

describe("AlertService (Memory) — lecture worker", () => {
  it("n'expose que les alertes actives avec leur contexte (carte, propriétaire, dernier prix)", () =>
    run((service, handle) =>
      Effect.gen(function* () {
        const active = yield* service.createAlert(ALICE, {
          cardId: "sv08-001",
          thresholdCents: 5000,
        });
        const inactive = yield* service.createAlert(BOB, {
          cardId: "sv08-002",
          thresholdCents: 5000,
          isActive: false,
        });
        handle.contexts.set(active.id, {
          card: {
            name: "Florizarre-ex",
            setName: "151",
            number: "198",
            imageUrl: null,
            cardmarketUrl: null,
          },
          owner: { discordUserId: "123456789012345678", discordWebhookUrl: null },
          snapshot: { source: "cardmarket", lowFrCents: 4690, trendCents: 5100 },
        });
        const candidates = yield* service.listActiveAlertsForEvaluation();
        expect(candidates.map((c) => c.alert.id)).toEqual([active.id]);
        expect(candidates[0]?.card.name).toBe("Florizarre-ex");
        expect(candidates[0]?.snapshot?.lowFrCents).toBe(4690);
        expect(candidates.some((c) => c.alert.id === inactive.id)).toBe(false);
      }),
    ));
});

describe("mapAlertError", () => {
  it("convertit les codes SQLSTATE connus et laisse le reste en DatabaseError", () => {
    expect(mapAlertError({ code: "23503" })).toMatchObject({ _tag: "AlertValidationError" });
    expect(mapAlertError({ code: "23514" })).toMatchObject({ _tag: "AlertValidationError" });
    expect(mapAlertError({ code: "22P02" })).toMatchObject({ _tag: "AlertValidationError" });
    expect(mapAlertError({ code: "42501" })).toMatchObject({ _tag: "AlertValidationError" });
    expect(mapAlertError({ code: "XX000" })).toBeUndefined();
    expect(mapAlertError(new Error("boom"))).toBeUndefined();
    const tagged = { _tag: "AlertNotFoundError", alertId: "x", message: "m" };
    expect(mapAlertError(tagged)).toBe(tagged);
  });
});
