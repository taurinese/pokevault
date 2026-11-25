import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ALERT_THRESHOLD_PRESETS,
  AlertEvaluationBatchReport,
  AlertEvent,
  AlertNotFoundError,
  AlertPriceField,
  type AlertPriceSnapshot,
  AlertValidationError,
  CreatePriceAlertInput,
  DEFAULT_ALERT_COOLDOWN_HOURS,
  decodeCreatePriceAlertInput,
  decodeRegisterPushSubscriptionInput,
  decodeUpdatePriceAlertInput,
  type EvaluableAlert,
  evaluatePriceAlert,
  InvalidWebhookUrlError,
  isAllowedDiscordWebhookUrl,
  isSafePushEndpointUrl,
  isValidDiscordUserId,
  MAX_ALERT_COOLDOWN_HOURS,
  MIN_ALERT_COOLDOWN_HOURS,
  NotificationChannel,
  NotificationDeliveryError,
  PriceAlert,
  PushSubscription,
  PushSubscriptionGoneError,
  RegisterPushSubscriptionInput,
  selectObservedPriceCents,
  UpdatePriceAlertInput,
} from "./index.ts";

const USER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ALERT = "bbbbbbbb-0000-4000-8000-000000000001";
const NOW = "2026-01-01T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 3_600_000;

describe("constantes", () => {
  it("expose le cooldown par défaut / bornes et les presets de seuil", () => {
    expect(DEFAULT_ALERT_COOLDOWN_HOURS).toBe(24);
    expect(MIN_ALERT_COOLDOWN_HOURS).toBe(1);
    expect(MAX_ALERT_COOLDOWN_HOURS).toBe(168);
    expect([...ALERT_THRESHOLD_PRESETS]).toEqual([-5, -12, -20]);
  });
});

describe("schémas", () => {
  const validAlert = {
    id: ALERT,
    userId: USER,
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
    createdAt: NOW,
    updatedAt: NOW,
  } as const;

  it("valide une alerte, un champ de prix et un canal", () => {
    expect(Schema.decodeUnknownSync(PriceAlert)(validAlert)).toEqual(validAlert);
    expect(Schema.decodeUnknownSync(AlertPriceField)("trend")).toBe("trend");
    expect(Schema.decodeUnknownSync(NotificationChannel)("discord")).toBe("discord");
    expect(() => Schema.decodeUnknownSync(AlertPriceField)("avg30")).toThrow();
    expect(() => Schema.decodeUnknownSync(NotificationChannel)("sms")).toThrow();
  });

  it("refuse un seuil <= 0, non entier, ou un cooldown hors 1..168", () => {
    for (const thresholdCents of [0, -1, 1.5]) {
      expect(() =>
        Schema.decodeUnknownSync(CreatePriceAlertInput)({ cardId: "sv08-001", thresholdCents }),
      ).toThrow();
    }
    for (const cooldownHours of [0, 169, 2.5]) {
      expect(() =>
        Schema.decodeUnknownSync(CreatePriceAlertInput)({
          cardId: "sv08-001",
          thresholdCents: 100,
          cooldownHours,
        }),
      ).toThrow();
    }
    expect(
      Schema.decodeUnknownSync(CreatePriceAlertInput)({
        cardId: "sv08-001",
        thresholdCents: 100,
        cooldownHours: 168,
      }).cooldownHours,
    ).toBe(168);
  });

  it("exige au moins un champ dans le patch et rejette les décodages invalides (AlertValidationError)", async () => {
    expect(() => Schema.decodeUnknownSync(UpdatePriceAlertInput)({})).toThrow();
    expect(Schema.decodeUnknownSync(UpdatePriceAlertInput)({ isActive: false })).toEqual({
      isActive: false,
    });
    const failure = await Effect.runPromise(
      Effect.flip(decodeCreatePriceAlertInput({ cardId: "", thresholdCents: 0 })),
    );
    expect(failure).toBeInstanceOf(AlertValidationError);
    const patchFailure = await Effect.runPromise(Effect.flip(decodeUpdatePriceAlertInput({})));
    expect(patchFailure._tag).toBe("AlertValidationError");
  });

  it("valide un évènement et un rapport de lot", () => {
    const event = {
      id: ALERT,
      alertId: ALERT,
      userId: USER,
      observedPriceCents: 4690,
      thresholdCents: 5000,
      channelsSent: ["push"],
      readAt: null,
      triggeredAt: NOW,
    };
    expect(Schema.decodeUnknownSync(AlertEvent)(event).channelsSent).toEqual(["push"]);
    expect(() =>
      Schema.decodeUnknownSync(AlertEvent)({ ...event, channelsSent: ["email"] }),
    ).toThrow();
    const report = {
      evaluated: 3,
      triggered: 1,
      skippedCooldown: 1,
      skippedAboveThreshold: 1,
      skippedNoPrice: 0,
      pushSent: 2,
      pushExpiredRemoved: 0,
      discordSent: 1,
      deliveryFailed: 0,
      durationMs: 12,
    };
    expect(Schema.decodeUnknownSync(AlertEvaluationBatchReport)(report)).toEqual(report);
  });

  it("valide un abonnement push et refuse un endpoint privé à l'enregistrement", async () => {
    expect(
      Schema.decodeUnknownSync(PushSubscription)({
        id: ALERT,
        userId: USER,
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        p256dh: "p",
        auth: "a",
        userAgent: null,
        createdAt: NOW,
        lastSeenAt: NOW,
      }).endpoint,
    ).toContain("fcm");
    const p256dh = "B".repeat(87);
    const auth = "a".repeat(22);
    const ok = await Effect.runPromise(
      decodeRegisterPushSubscriptionInput({
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
        p256dh,
        auth,
      }),
    );
    expect(ok.auth).toBe(auth);
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "nope"]) {
      const failure = await Effect.runPromise(
        Effect.flip(decodeRegisterPushSubscriptionInput({ endpoint, p256dh, auth })),
      );
      expect(failure._tag).toBe("AlertValidationError");
    }
    expect(() =>
      Schema.decodeUnknownSync(RegisterPushSubscriptionInput)({
        endpoint: "https://fcm.googleapis.com/x",
        p256dh: "not base64 !",
        auth,
      }),
    ).toThrow();
  });
});

describe("isAllowedDiscordWebhookUrl (anti-SSRF)", () => {
  const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF_-0123";
  const ID = "123456789012345678";
  const valid = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

  it("accepte les webhooks Discord officiels (discord.com, discordapp.com, version d'API)", () => {
    expect(isAllowedDiscordWebhookUrl(valid)).toBe(true);
    expect(isAllowedDiscordWebhookUrl(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`)).toBe(
      true,
    );
    expect(isAllowedDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`)).toBe(
      true,
    );
    expect(isAllowedDiscordWebhookUrl(`${valid}?wait=true`)).toBe(true);
  });

  it("rejette http, port, credentials, autres hôtes, sous-domaines piégés et chemins invalides", () => {
    const rejected = [
      null,
      "",
      "not a url",
      `http://discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`,
      `https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://evil.com/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com.evil.com/api/webhooks/${ID}/${TOKEN}`,
      `https://evildiscord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://cdn.discord.com/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com@evil.com/api/webhooks/${ID}/${TOKEN}`,
      `https://127.0.0.1/api/webhooks/${ID}/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}/${TOKEN}/extra`,
      `https://discord.com/api/webhooks/abc/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}/short`,
      `https://discord.com/api/webhooks/${ID}/../../x/${TOKEN}`,
      `https://discord.com/api/webhooks/${ID}/%2e%2e/${TOKEN}`,
      "https://discord.com/api/channels/1/messages",
    ];
    for (const url of rejected) {
      expect(isAllowedDiscordWebhookUrl(url), String(url)).toBe(false);
    }
  });
});

describe("isValidDiscordUserId", () => {
  it("n'accepte que des snowflakes de 17 à 22 chiffres", () => {
    expect(isValidDiscordUserId("123456789012345678")).toBe(true);
    expect(isValidDiscordUserId("1234567890123456")).toBe(false);
    expect(isValidDiscordUserId("12345678901234567890123")).toBe(false);
    expect(isValidDiscordUserId("12345678901234567a")).toBe(false);
    expect(isValidDiscordUserId("../channels")).toBe(false);
    expect(isValidDiscordUserId(null)).toBe(false);
  });
});

describe("isSafePushEndpointUrl (anti-SSRF)", () => {
  it("accepte les push services publics en HTTPS", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://8.8.8.8/push",
    ]) {
      expect(isSafePushEndpointUrl(url), url).toBe(true);
    }
  });

  it("rejette localhost, .local, .internal, IP privées/loopback/link-local et schémas/ports/credentials", () => {
    for (const url of [
      null,
      "",
      "garbage",
      "http://fcm.googleapis.com/x",
      "ftp://fcm.googleapis.com/x",
      "https://fcm.googleapis.com:444/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://localhost/x",
      "https://foo.localhost/x",
      "https://printer.local/x",
      "https://db.internal/x",
      "https://127.0.0.1/x",
      "https://127.1/x",
      "https://0x7f.0.0.1/x",
      "https://2130706433/x",
      "https://10.0.0.5/x",
      "https://172.16.0.1/x",
      "https://172.31.255.255/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/x",
      "https://100.64.0.1/x",
      "https://[::1]/x",
      "https://[::]/x",
      "https://[fe80::1]/x",
      "https://[fc00::1]/x",
      "https://[fd12:3456::1]/x",
      "https://[::ffff:127.0.0.1]/x",
    ]) {
      expect(isSafePushEndpointUrl(url), String(url)).toBe(false);
    }
    expect(isSafePushEndpointUrl("https://172.32.0.1/x")).toBe(true);
    expect(isSafePushEndpointUrl("https://172.15.0.1/x")).toBe(true);
  });
});

describe("evaluatePriceAlert (moteur pur)", () => {
  const baseAlert: EvaluableAlert = {
    isActive: true,
    priceField: "low_fr",
    thresholdCents: 5000,
    cooldownHours: 24,
    lastTriggeredAt: null,
    notifyPush: true,
    notifyDiscord: false,
  };
  const snapshot: AlertPriceSnapshot = {
    source: "cardmarket",
    lowFrCents: 4690,
    trendCents: 5200,
  };

  it("sélectionne le prix selon le champ surveillé", () => {
    expect(selectObservedPriceCents("low_fr", snapshot)).toBe(4690);
    expect(selectObservedPriceCents("trend", snapshot)).toBe(5200);
    expect(selectObservedPriceCents("trend", { lowFrCents: 1, trendCents: null })).toBeNull();
  });

  it("ignore une alerte inactive", () => {
    expect(evaluatePriceAlert({ ...baseAlert, isActive: false }, snapshot, NOW_MS)).toEqual({
      decision: "skip",
      reason: "inactive",
    });
  });

  it("ignore l'absence de prix", () => {
    expect(evaluatePriceAlert(baseAlert, null, NOW_MS)).toEqual({
      decision: "skip",
      reason: "no_price",
    });
  });

  it("ne déclenche jamais sur un prix indicatif TCGdex (fallback_only)", () => {
    expect(
      evaluatePriceAlert(baseAlert, { ...snapshot, source: "tcgdex_fallback" }, NOW_MS),
    ).toEqual({ decision: "skip", reason: "fallback_only" });
  });

  it("ignore un snapshot sans le champ surveillé", () => {
    expect(evaluatePriceAlert(baseAlert, { ...snapshot, lowFrCents: null }, NOW_MS)).toEqual({
      decision: "skip",
      reason: "field_missing",
    });
    expect(
      evaluatePriceAlert(
        { ...baseAlert, priceField: "trend" },
        { ...snapshot, trendCents: null },
        NOW_MS,
      ),
    ).toEqual({ decision: "skip", reason: "field_missing" });
  });

  it("ignore un prix strictement au-dessus du seuil, déclenche à l'égalité", () => {
    expect(evaluatePriceAlert(baseAlert, { ...snapshot, lowFrCents: 5001 }, NOW_MS)).toEqual({
      decision: "skip",
      reason: "above_threshold",
      observedPriceCents: 5001,
    });
    expect(evaluatePriceAlert(baseAlert, { ...snapshot, lowFrCents: 5000 }, NOW_MS).decision).toBe(
      "trigger",
    );
  });

  it("déclenche sous le seuil avec les canaux demandés", () => {
    expect(evaluatePriceAlert(baseAlert, snapshot, NOW_MS)).toEqual({
      decision: "trigger",
      observedPriceCents: 4690,
      thresholdCents: 5000,
      channels: ["push"],
    });
    expect(
      evaluatePriceAlert(
        { ...baseAlert, notifyDiscord: true, priceField: "trend", thresholdCents: 6000 },
        snapshot,
        NOW_MS,
      ),
    ).toEqual({
      decision: "trigger",
      observedPriceCents: 5200,
      thresholdCents: 6000,
      channels: ["push", "discord"],
    });
  });

  it("applique le cooldown depuis last_triggered_at et expose nextEligibleAt", () => {
    const last = new Date(NOW_MS - 23 * HOUR).toISOString();
    const result = evaluatePriceAlert({ ...baseAlert, lastTriggeredAt: last }, snapshot, NOW_MS);
    expect(result).toEqual({
      decision: "skip",
      reason: "cooldown",
      observedPriceCents: 4690,
      nextEligibleAt: new Date(NOW_MS + 1 * HOUR).toISOString(),
    });
  });

  it("redéclenche exactement à la fin du cooldown (borne exclusive) et respecte cooldownHours", () => {
    const exact = new Date(NOW_MS - 24 * HOUR).toISOString();
    expect(
      evaluatePriceAlert({ ...baseAlert, lastTriggeredAt: exact }, snapshot, NOW_MS).decision,
    ).toBe("trigger");
    const sixHoursAgo = new Date(NOW_MS - 6 * HOUR).toISOString();
    expect(
      evaluatePriceAlert(
        { ...baseAlert, cooldownHours: 6, lastTriggeredAt: sixHoursAgo },
        snapshot,
        NOW_MS,
      ).decision,
    ).toBe("trigger");
    expect(
      evaluatePriceAlert(
        { ...baseAlert, cooldownHours: 168, lastTriggeredAt: sixHoursAgo },
        snapshot,
        NOW_MS,
      ).decision,
    ).toBe("skip");
  });

  it("ignore un last_triggered_at illisible (pas de cooldown fantôme)", () => {
    expect(
      evaluatePriceAlert({ ...baseAlert, lastTriggeredAt: "garbage" }, snapshot, NOW_MS).decision,
    ).toBe("trigger");
  });

  it("ignore une alerte sans canal", () => {
    expect(evaluatePriceAlert({ ...baseAlert, notifyPush: false }, snapshot, NOW_MS)).toEqual({
      decision: "skip",
      reason: "no_channels",
    });
  });

  it("le cooldown est évalué avant les canaux (above_threshold avant cooldown)", () => {
    const last = new Date(NOW_MS - HOUR).toISOString();
    expect(
      evaluatePriceAlert(
        { ...baseAlert, lastTriggeredAt: last },
        { ...snapshot, lowFrCents: 9999 },
        NOW_MS,
      ).decision,
    ).toBe("skip");
    expect(
      evaluatePriceAlert(
        { ...baseAlert, lastTriggeredAt: last },
        { ...snapshot, lowFrCents: 9999 },
        NOW_MS,
      ),
    ).toMatchObject({ reason: "above_threshold" });
  });
});

describe("erreurs typées", () => {
  it("portent un _tag stable et leurs champs", () => {
    expect(new AlertNotFoundError({ alertId: "x", message: "m" })._tag).toBe("AlertNotFoundError");
    expect(new InvalidWebhookUrlError({ message: "m" })._tag).toBe("InvalidWebhookUrlError");
    expect(new NotificationDeliveryError({ channel: "push", message: "m" })._tag).toBe(
      "NotificationDeliveryError",
    );
    const gone = new PushSubscriptionGoneError({ endpoint: "e", status: 410, message: "m" });
    expect(gone._tag).toBe("PushSubscriptionGoneError");
    expect(gone.status).toBe(410);
  });
});
