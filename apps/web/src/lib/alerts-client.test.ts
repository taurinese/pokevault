import { describe, expect, it, vi } from "vitest";
import {
  ALERT_COOLDOWN_OPTIONS,
  ALERTS_UNREAD_EVENT,
  type AlertTriggeredEvent,
  type AlertWatchItem,
  alertApiPath,
  alertChannels,
  buildThresholdPresets,
  computeAlertAge,
  computeThresholdGap,
  countUnreadEvents,
  createAlert,
  currentAlertPriceCents,
  deleteAlert,
  dispatchUnreadAlertsCount,
  emptyAlertsPayload,
  fetchAlerts,
  fetchUnreadAlertsCount,
  formatThresholdInput,
  isProfileDiscordWebhookUrl,
  markAlertEventsRead,
  markEventsReadLocally,
  parseThresholdEuros,
  presetThresholdCents,
  readAlertsPayload,
  readUnreadEventDetail,
  referencePriceCents,
  registerPushSubscription,
  saveDiscordWebhook,
  toPushSubscriptionBody,
  unregisterPushSubscription,
  updateAlert,
  vapidKeyToBytes,
} from "./alerts-client.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

const watch = (overrides: Partial<AlertWatchItem> = {}): AlertWatchItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  userId: "11111111-1111-4111-8111-111111111111",
  cardId: "sv03.5-199",
  language: "FR",
  variant: "normal",
  minCondition: "NM",
  priceField: "low_fr",
  thresholdCents: 1000,
  isActive: true,
  notifyPush: true,
  notifyDiscord: false,
  cooldownHours: 24,
  lastTriggeredAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  cardName: "Dracaufeu ex",
  setCode: "SV03.5",
  setName: "151",
  localId: "199",
  imageUrl: null,
  cardmarketUrl: null,
  trendCents: 1300,
  lowFrCents: 1200,
  priceSource: "cardmarket",
  priceFetchedAt: "2026-03-01T11:59:00.000Z",
  ...overrides,
});

const event = (overrides: Partial<AlertTriggeredEvent> = {}): AlertTriggeredEvent => ({
  id: "00000000-0000-4000-8000-0000000000e1",
  alertId: "00000000-0000-4000-8000-000000000001",
  cardId: "sv03.5-199",
  cardName: "Dracaufeu ex",
  setCode: "SV03.5",
  setName: "151",
  localId: "199",
  language: "FR",
  variant: "normal",
  imageUrl: null,
  cardmarketUrl: null,
  observedPriceCents: 900,
  thresholdCents: 1000,
  channelsSent: ["push"],
  readAt: null,
  triggeredAt: "2026-03-01T11:00:00.000Z",
  ...overrides,
});

describe("presets de seuil (-5 % / -12 % / -20 %)", () => {
  it("calcule les trois raccourcis à partir du prix de référence, arrondis au centime", () => {
    expect(presetThresholdCents(1000, -5)).toBe(950);
    expect(presetThresholdCents(1000, -12)).toBe(880);
    expect(presetThresholdCents(1000, -20)).toBe(800);
    // 333 × 0,88 = 293,04 → 293 ; 199 × 0,95 = 189,05 → 189
    expect(presetThresholdCents(333, -12)).toBe(293);
    expect(presetThresholdCents(199, -5)).toBe(189);
  });

  it("ne descend jamais sous 1 centime", () => {
    expect(presetThresholdCents(1, -20)).toBe(1);
  });

  it("est indisponible sans prix de référence exploitable", () => {
    expect(presetThresholdCents(null, -5)).toBeNull();
    expect(presetThresholdCents(0, -5)).toBeNull();
    expect(presetThresholdCents(-100, -5)).toBeNull();
    expect(presetThresholdCents(10.5, -5)).toBeNull();
  });

  it("expose les presets du domaine dans l'ordre -5, -12, -20", () => {
    expect(buildThresholdPresets(2000)).toEqual([
      { percent: -5, thresholdCents: 1900 },
      { percent: -12, thresholdCents: 1760 },
      { percent: -20, thresholdCents: 1600 },
    ]);
    expect(buildThresholdPresets(null).map((preset) => preset.thresholdCents)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe("parseThresholdEuros (euros → centimes entiers)", () => {
  it.each([
    ["12,50", 1250],
    ["12.5", 1250],
    ["12", 1200],
    ["0,07", 7],
    ["0.29", 29],
    ["1,15", 115],
    [" 1 234,5 ", 123450],
    ["21474836,47", 2147483647],
  ])("accepte %j → %i centimes", (raw, cents) => {
    expect(parseThresholdEuros(raw)).toEqual({ ok: true, cents });
  });

  it.each([
    "",
    "   ",
    "0",
    "0,00",
    "-5",
    "abc",
    "1,234",
    "1,2,3",
    "12 €",
    "NaN",
    "1e3",
    "21474836,48",
    "999999999",
    "1234567890",
  ])("refuse %j", (raw) => {
    expect(parseThresholdEuros(raw)).toEqual({ ok: false });
  });

  it("formate des centimes en saisie à virgule (aller-retour exact)", () => {
    expect(formatThresholdInput(1250)).toBe("12,50");
    expect(formatThresholdInput(7)).toBe("0,07");
    expect(formatThresholdInput(100)).toBe("1,00");
    for (const cents of [1, 99, 100, 1234, 987654]) {
      expect(parseThresholdEuros(formatThresholdInput(cents))).toEqual({ ok: true, cents });
    }
  });
});

describe("écart au seuil", () => {
  it("renvoie l'écart restant en centimes et en pourcentage du prix courant", () => {
    expect(computeThresholdGap(1200, 1000)).toEqual({
      kind: "remaining",
      cents: 200,
      percent: 17,
    });
  });

  it("signale un seuil atteint (égalité comprise) avec la marge", () => {
    expect(computeThresholdGap(1000, 1000)).toEqual({ kind: "reached", cents: 0 });
    expect(computeThresholdGap(850, 1000)).toEqual({ kind: "reached", cents: 150 });
  });

  it("est inconnu sans prix courant", () => {
    expect(computeThresholdGap(null, 1000)).toEqual({ kind: "unknown" });
  });
});

describe("prix courant d'une alerte", () => {
  it("lit le champ surveillé (plus bas FR ou tendance), sans repli croisé", () => {
    expect(currentAlertPriceCents(watch({ priceField: "low_fr" }))).toBe(1200);
    expect(currentAlertPriceCents(watch({ priceField: "trend" }))).toBe(1300);
    expect(currentAlertPriceCents(watch({ priceField: "low_fr", lowFrCents: null }))).toBeNull();
  });

  it("ignore un prix indicatif TCGdex (le moteur n'alerte jamais dessus)", () => {
    expect(currentAlertPriceCents(watch({ priceSource: "tcgdex_fallback" }))).toBeNull();
    expect(currentAlertPriceCents(watch({ priceSource: null }))).toBeNull();
  });

  it("référence : champ sélectionné d'un slot, null sans prix", () => {
    expect(referencePriceCents({ trendCents: 500, lowFrCents: 400 }, "trend")).toBe(500);
    expect(referencePriceCents({ trendCents: 500, lowFrCents: 400 }, "low_fr")).toBe(400);
    expect(referencePriceCents(null, "trend")).toBeNull();
  });
});

describe("âge relatif des déclenchements", () => {
  it("renvoie l'âge réel (à l'instant, minutes, heures, jours)", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(computeAlertAge(at(10_000), NOW)).toEqual({ kind: "just_now" });
    expect(computeAlertAge(at(6 * 60_000), NOW)).toEqual({ kind: "minutes", count: 6 });
    expect(computeAlertAge(at(2 * 3_600_000), NOW)).toEqual({ kind: "hours", count: 2 });
    expect(computeAlertAge(at(3 * 86_400_000), NOW)).toEqual({ kind: "days", count: 3 });
    expect(computeAlertAge("pas une date", NOW)).toBeNull();
  });
});

describe("évènements non lus & canaux", () => {
  it("compte et marque les évènements lus localement (un seul ou tous)", () => {
    const events = [event({ id: "a" }), event({ id: "b" }), event({ id: "c", readAt: "x" })];
    expect(countUnreadEvents(events)).toBe(2);
    const one = markEventsReadLocally(events, "2026-03-01T12:00:00.000Z", "a");
    expect(one.map((e) => e.readAt)).toEqual(["2026-03-01T12:00:00.000Z", null, "x"]);
    const all = markEventsReadLocally(events, "2026-03-01T12:00:00.000Z");
    expect(countUnreadEvents(all)).toBe(0);
    // Un évènement déjà lu garde son horodatage d'origine.
    expect(all[2]?.readAt).toBe("x");
  });

  it("liste les canaux effectifs d'une alerte dans l'ordre push, discord", () => {
    expect(alertChannels({ notifyPush: true, notifyDiscord: true })).toEqual(["push", "discord"]);
    expect(alertChannels({ notifyPush: false, notifyDiscord: true })).toEqual(["discord"]);
    expect(alertChannels({ notifyPush: false, notifyDiscord: false })).toEqual([]);
  });

  it("propose les cooldowns 6, 12, 24, 48 et 72 h", () => {
    expect(ALERT_COOLDOWN_OPTIONS).toEqual([6, 12, 24, 48, 72]);
  });
});

describe("pastille Navbar B (évènement client)", () => {
  it("publie un CustomEvent<number> normalisé", () => {
    const dispatched: Event[] = [];
    const target = {
      dispatchEvent: (e: Event) => {
        dispatched.push(e);
        return true;
      },
    };
    dispatchUnreadAlertsCount(0, target);
    dispatchUnreadAlertsCount(3.9, target);
    dispatchUnreadAlertsCount(-4, target);
    dispatchUnreadAlertsCount(Number.NaN, target);
    expect(dispatched).toHaveLength(3);
    expect(dispatched.every((e) => e.type === ALERTS_UNREAD_EVENT)).toBe(true);
    expect(dispatched.map(readUnreadEventDetail)).toEqual([0, 3, 0]);
  });

  it("ignore un évènement invalide et ne plante pas sans window", () => {
    expect(readUnreadEventDetail(new Event(ALERTS_UNREAD_EVENT))).toBeNull();
    expect(readUnreadEventDetail(new CustomEvent(ALERTS_UNREAD_EVENT, { detail: "3" }))).toBeNull();
    expect(readUnreadEventDetail(new CustomEvent(ALERTS_UNREAD_EVENT, { detail: -1 }))).toBeNull();
    expect(() => dispatchUnreadAlertsCount(2)).not.toThrow();
  });

  it("utilise le nom d'évènement convenu", () => {
    expect(ALERTS_UNREAD_EVENT).toBe("pokevault:alerts-unread");
  });
});

describe("webhook Discord du profil", () => {
  const TOKEN = "abcdefghijklmnopqrstuvwxyz_-0123456789";
  const valid = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;

  it("accepte uniquement https://discord.com/api/webhooks/<chiffres>/<jeton>", () => {
    expect(isProfileDiscordWebhookUrl(valid)).toBe(true);
  });

  it.each([
    null,
    "",
    `http://discord.com/api/webhooks/123456789012345678/${TOKEN}`,
    `https://discordapp.com/api/webhooks/123456789012345678/${TOKEN}`,
    `https://discord.com/api/v10/webhooks/123456789012345678/${TOKEN}`,
    `https://discord.com.evil.test/api/webhooks/123456789012345678/${TOKEN}`,
    `https://evil.test/api/webhooks/123456789012345678/${TOKEN}`,
    `https://user:pw@discord.com/api/webhooks/123456789012345678/${TOKEN}`,
    `https://discord.com:8443/api/webhooks/123456789012345678/${TOKEN}`,
    `${valid}?wait=true`,
    `${valid}#frag`,
    "https://127.0.0.1/api/webhooks/123456789012345678/abcdefghijklmnopqrstu",
    `https://discord.com/api/webhooks/../../x/${TOKEN}`,
    "javascript:alert(1)",
  ])("refuse %j", (url) => {
    expect(isProfileDiscordWebhookUrl(url)).toBe(false);
  });
});

describe("Web Push navigateur", () => {
  it("décode la clé VAPID base64url en octets", () => {
    expect([...vapidKeyToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...vapidKeyToBytes("-_-_")]).toEqual([0xfb, 0xff, 0xbf]);
    // Sans padding `=`.
    expect([...vapidKeyToBytes("AQI")]).toEqual([1, 2]);
  });

  it("aplatit un abonnement et refuse un abonnement incomplet", () => {
    expect(
      toPushSubscriptionBody(
        { endpoint: "https://push.example/abc", keys: { p256dh: "P", auth: "A" } },
        "UA",
      ),
    ).toEqual({ endpoint: "https://push.example/abc", p256dh: "P", auth: "A", userAgent: "UA" });
    expect(toPushSubscriptionBody({ endpoint: "https://push.example/abc", keys: {} })).toBeNull();
    expect(toPushSubscriptionBody({ keys: { p256dh: "P", auth: "A" } })).toBeNull();
    const long = toPushSubscriptionBody(
      { endpoint: "https://push.example/abc", keys: { p256dh: "P", auth: "A" } },
      "x".repeat(900),
    );
    expect(long?.userAgent).toHaveLength(512);
  });
});

describe("payload", () => {
  it("fournit un payload vide documenté", () => {
    expect(emptyAlertsPayload()).toEqual({
      available: false,
      channels: {
        pushSubscriptionsCount: 0,
        pushConfigured: false,
        vapidPublicKey: null,
        discordLinked: false,
        discordWebhookConfigured: false,
        discordDefaultConfigured: false,
      },
      triggeredEvents: [],
      alerts: [],
      unreadCount: 0,
    });
    expect(emptyAlertsPayload({ pushConfigured: true }, true)).toMatchObject({
      available: true,
      channels: { pushConfigured: true },
    });
  });

  it("valide la forme du payload", () => {
    expect(readAlertsPayload(emptyAlertsPayload())).not.toBeNull();
    expect(readAlertsPayload(null)).toBeNull();
    expect(readAlertsPayload({ alerts: [] })).toBeNull();
    expect(readAlertsPayload({ ...emptyAlertsPayload(), unreadCount: "3" })).toBeNull();
  });
});

const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("fetch typé", () => {
  it("fetchAlerts : 200 → payload, 401 → unauthorized, 500 / JSON invalide → error", async () => {
    const payload = emptyAlertsPayload({}, true);
    const ok = vi.fn(async () => respond(payload));
    expect(await fetchAlerts(undefined, ok)).toEqual({ kind: "ok", payload });
    expect(ok).toHaveBeenCalledWith(
      "/api/alerts",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(await fetchAlerts(undefined, async () => respond({}, 401))).toEqual({
      kind: "unauthorized",
    });
    expect(await fetchAlerts(undefined, async () => respond({}, 500))).toEqual({ kind: "error" });
    expect(await fetchAlerts(undefined, async () => respond({ nope: true }))).toEqual({
      kind: "error",
    });
    expect(
      await fetchAlerts(undefined, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ kind: "error" });
  });

  it("fetchUnreadAlertsCount : valeur du serveur, sinon null (silencieux)", async () => {
    expect(await fetchUnreadAlertsCount(undefined, async () => respond({ unreadCount: 4 }))).toBe(
      4,
    );
    expect(await fetchUnreadAlertsCount(undefined, async () => respond({}, 401))).toBeNull();
    expect(await fetchUnreadAlertsCount(undefined, async () => respond({}, 503))).toBeNull();
    expect(
      await fetchUnreadAlertsCount(undefined, async () => respond({ unreadCount: -2 })),
    ).toBeNull();
    expect(
      await fetchUnreadAlertsCount(undefined, async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  it("createAlert / updateAlert / deleteAlert utilisent les bonnes routes et verbes", async () => {
    const fetchImpl = vi.fn(async () => respond({ id: "x" }));
    expect(await createAlert({ cardId: "sv03.5-199", thresholdCents: 900 }, fetchImpl)).toEqual({
      kind: "ok",
      body: { id: "x" },
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cardId: "sv03.5-199", thresholdCents: 900 }),
      }),
    );
    await updateAlert("a/b", { isActive: false }, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts/a%2Fb",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ isActive: false }) }),
    );
    await deleteAlert("abc", fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts/abc",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(alertApiPath("a b")).toBe("/api/alerts/a%20b");
  });

  it("traduit les statuts HTTP d'erreur en résultats typés", async () => {
    const kinds = new Map<number, string>([
      [400, "invalid"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [413, "too-large"],
      [503, "error"],
    ]);
    for (const [status, kind] of kinds) {
      const result = await updateAlert("a", { isActive: true }, async () => respond({}, status));
      expect(result.kind).toBe(kind);
    }
    expect(
      (
        await updateAlert("a", { isActive: true }, async () => {
          throw new Error("offline");
        })
      ).kind,
    ).toBe("error");
  });

  it("markAlertEventsRead : corps vide pour « tout », { eventId } pour un seul ; lit unreadCount", async () => {
    const fetchImpl = vi.fn(async () => respond({ unreadCount: 2 }));
    expect(await markAlertEventsRead(undefined, fetchImpl)).toEqual({ kind: "ok", body: 2 });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts/events/read",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    await markAlertEventsRead("evt-1", fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts/events/read",
      expect.objectContaining({ body: JSON.stringify({ eventId: "evt-1" }) }),
    );
  });

  it("saveDiscordWebhook envoie l'URL (ou null) et ne lit qu'un booléen en retour", async () => {
    const fetchImpl = vi.fn(async () => respond({ discordWebhookConfigured: true }));
    expect(await saveDiscordWebhook("https://discord.com/x", fetchImpl)).toEqual({
      kind: "ok",
      body: { discordWebhookConfigured: true },
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts/channels",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ discordWebhookUrl: "https://discord.com/x" }),
      }),
    );
    await saveDiscordWebhook(null, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/alerts/channels",
      expect.objectContaining({ body: JSON.stringify({ discordWebhookUrl: null }) }),
    );
  });

  it("enregistre et retire un abonnement push", async () => {
    const fetchImpl = vi.fn(async () => respond({ registered: true }, 201));
    const body = { endpoint: "https://push.example/abc", p256dh: "P", auth: "A" };
    expect(await registerPushSubscription(body, fetchImpl)).toEqual({ kind: "ok", body: null });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/push-subscriptions",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    await unregisterPushSubscription("https://push.example/abc", fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/push-subscriptions",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ endpoint: "https://push.example/abc" }),
      }),
    );
  });
});
