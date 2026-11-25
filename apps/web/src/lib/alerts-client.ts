/**
 * Client des écrans `07A–07C` (Alertes Prix) : types du payload `GET /api/alerts`, helpers
 * purs (presets de seuil, euros → centimes, écart au seuil, âge relatif, pastille Navbar B)
 * et appels fetch typés vers `/api/alerts/*` et `/api/push-subscriptions`.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de `@pokevault/domain`
 * (jamais `@pokevault/services`, `postgres` ni `node:*` — l'accès base vit dans
 * `alerts-server.ts`, module serveur uniquement).
 */

import {
  ALERT_THRESHOLD_PRESETS,
  type AlertPriceField,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  isAllowedDiscordWebhookUrl,
  MAX_PRICE_CENTS,
  type NotificationChannel,
  type PriceAlert,
} from "@pokevault/domain";
import { computePriceAge, type FetchLike, type MutationResult } from "./card-detail-client.ts";

// ---------------------------------------------------------------------------
// Chemins & évènements
// ---------------------------------------------------------------------------

export const ALERTS_PATH = "/alerts";
export const ALERTS_API_PATH = "/api/alerts";
export const ALERTS_UNREAD_COUNT_API_PATH = "/api/alerts/unread-count";
export const ALERTS_READ_API_PATH = "/api/alerts/events/read";
export const ALERTS_CHANNELS_API_PATH = "/api/alerts/channels";
export const PUSH_SUBSCRIPTIONS_API_PATH = "/api/push-subscriptions";

export const alertApiPath = (alertId: string): string =>
  `${ALERTS_API_PATH}/${encodeURIComponent(alertId)}`;

/** Évènement client (`CustomEvent<number>`) : nouvelle valeur de la pastille verte Navbar B. */
export const ALERTS_UNREAD_EVENT = "pokevault:alerts-unread";

/** Cibles d'écoute minimales (fenêtre navigateur) : permet de tester sans DOM. */
export interface UnreadEventTarget {
  readonly dispatchEvent: (event: Event) => boolean;
}

/**
 * Publie le nombre d'alertes non lues : la Navbar B (`__root.tsx`) se met à jour sans
 * rechargement. Sans `window` (SSR) ou avec une valeur invalide, ne fait rien.
 */
export const dispatchUnreadAlertsCount = (
  count: number,
  target: UnreadEventTarget | undefined = typeof window === "undefined" ? undefined : window,
): void => {
  if (target === undefined || !Number.isFinite(count)) return;
  target.dispatchEvent(
    new CustomEvent<number>(ALERTS_UNREAD_EVENT, { detail: Math.max(0, Math.trunc(count)) }),
  );
};

/** Lit le détail d'un évènement `pokevault:alerts-unread` (`null` si invalide). */
export const readUnreadEventDetail = (event: Event): number | null => {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  return typeof detail === "number" && Number.isFinite(detail) && detail >= 0
    ? Math.trunc(detail)
    : null;
};

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * État des canaux de notification. AUCUN secret : ni URL de webhook (booléen seul), ni clé
 * VAPID privée ; seule la clé VAPID PUBLIQUE est exposée (nécessaire à `pushManager.subscribe`).
 */
export interface AlertChannelsStatus {
  readonly pushSubscriptionsCount: number;
  /** `VAPID_PUBLIC_KEY` configurée côté serveur. */
  readonly pushConfigured: boolean;
  readonly vapidPublicKey: string | null;
  /** `profiles.discord_user_id` renseigné (liaison OAuth Discord). */
  readonly discordLinked: boolean;
  /** Webhook Discord personnel enregistré (booléen : l'URL n'est jamais renvoyée). */
  readonly discordWebhookConfigured: boolean;
  /** Webhook Discord par défaut de l'instance configuré. */
  readonly discordDefaultConfigured: boolean;
}

/** Évènement de déclenchement + carte (jointure `price_alerts` ⨝ `catalog_cards` ⨝ `catalog_sets`). */
export interface AlertTriggeredEvent {
  readonly id: string;
  readonly alertId: string;
  readonly cardId: string;
  readonly cardName: string;
  readonly setCode: string | null;
  readonly setName: string;
  readonly localId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  /** URL TCGdex `low.webp` (ou `null`). */
  readonly imageUrl: string | null;
  readonly cardmarketUrl: string | null;
  readonly observedPriceCents: number;
  readonly thresholdCents: number;
  readonly channelsSent: ReadonlyArray<NotificationChannel>;
  readonly readAt: string | null;
  readonly triggeredAt: string;
}

/** Source du dernier prix connu (`price_snapshots.source`). */
export type AlertPriceSource = "cardmarket" | "tcgdex_fallback";

/** Alerte surveillée + carte + dernier prix du slot `(carte, langue, variante)`. */
export interface AlertWatchItem extends PriceAlert {
  readonly cardName: string;
  readonly setCode: string | null;
  readonly setName: string;
  readonly localId: string;
  readonly imageUrl: string | null;
  readonly cardmarketUrl: string | null;
  readonly trendCents: number | null;
  readonly lowFrCents: number | null;
  readonly priceSource: AlertPriceSource | null;
  readonly priceFetchedAt: string | null;
}

/** Réponse de `GET /api/alerts`. */
export interface AlertsPayload {
  /** `false` : base non configurée (payload vide documenté, aucune mutation possible). */
  readonly available: boolean;
  readonly channels: AlertChannelsStatus;
  readonly triggeredEvents: ReadonlyArray<AlertTriggeredEvent>;
  readonly alerts: ReadonlyArray<AlertWatchItem>;
  readonly unreadCount: number;
}

/** Payload vide renvoyé sans `DATABASE_URL` (200, jamais 500). */
export const emptyAlertsPayload = (
  channels: Partial<AlertChannelsStatus> = {},
  available = false,
): AlertsPayload => ({
  available,
  channels: {
    pushSubscriptionsCount: 0,
    pushConfigured: false,
    vapidPublicKey: null,
    discordLinked: false,
    discordWebhookConfigured: false,
    discordDefaultConfigured: false,
    ...channels,
  },
  triggeredEvents: [],
  alerts: [],
  unreadCount: 0,
});

// ---------------------------------------------------------------------------
// Constantes d'UI (`07C`)
// ---------------------------------------------------------------------------

export const ALERT_PRICE_FIELDS: ReadonlyArray<AlertPriceField> = ["low_fr", "trend"];
export const ALERT_CONDITIONS: ReadonlyArray<CardCondition> = [
  "M",
  "NM",
  "EX",
  "GD",
  "LP",
  "PL",
  "PO",
];
export const ALERT_LANGUAGES: ReadonlyArray<CardLanguage> = ["FR", "EN", "JP", "ZH"];
export const ALERT_VARIANTS: ReadonlyArray<CardVariant> = [
  "normal",
  "reverse",
  "holo",
  "promo",
  "pokeball",
  "masterball",
];
/** Cooldowns anti-spam proposés (`1..168 h` accepté par l'API ; ces valeurs couvrent l'usage courant). */
export const ALERT_COOLDOWN_OPTIONS: ReadonlyArray<number> = [6, 12, 24, 48, 72];

// ---------------------------------------------------------------------------
// Helpers purs — prix
// ---------------------------------------------------------------------------

/** Prix de référence selon le champ surveillé (`null` si non coté). Aucun repli croisé. */
export const referencePriceCents = (
  price: { readonly trendCents: number | null; readonly lowFrCents: number | null } | null,
  priceField: AlertPriceField,
): number | null => {
  if (price === null) return null;
  return priceField === "low_fr" ? price.lowFrCents : price.trendCents;
};

/**
 * Prix courant Cardmarket d'une alerte (même champ que le moteur d'évaluation). Un prix
 * indicatif TCGdex (`tcgdex_fallback`) est ignoré : le moteur n'alerte jamais dessus.
 */
export const currentAlertPriceCents = (
  alert: Pick<AlertWatchItem, "priceField" | "trendCents" | "lowFrCents" | "priceSource">,
): number | null =>
  alert.priceSource === "cardmarket" ? referencePriceCents(alert, alert.priceField) : null;

/**
 * Seuil proposé par un preset : `référence × (1 + pct/100)` arrondi au centime, jamais
 * inférieur à 1 c. `null` sans prix de référence exploitable (preset désactivé).
 */
export const presetThresholdCents = (
  referenceCents: number | null,
  presetPercent: number,
): number | null => {
  if (referenceCents === null || !Number.isInteger(referenceCents) || referenceCents <= 0) {
    return null;
  }
  const raw = Math.round((referenceCents * (100 + presetPercent)) / 100);
  return Math.min(MAX_PRICE_CENTS, Math.max(1, raw));
};

export interface AlertThresholdPreset {
  readonly percent: number;
  readonly thresholdCents: number | null;
}

/** Presets `-5 % / -12 % / -20 %` (`ALERT_THRESHOLD_PRESETS`) calculés sur la référence. */
export const buildThresholdPresets = (
  referenceCents: number | null,
): ReadonlyArray<AlertThresholdPreset> =>
  ALERT_THRESHOLD_PRESETS.map((percent) => ({
    percent,
    thresholdCents: presetThresholdCents(referenceCents, percent),
  }));

export type ParsedThreshold =
  | { readonly ok: true; readonly cents: number }
  | { readonly ok: false };

/**
 * Champ « prix cible (€) » → centimes ENTIERS, strictement positifs (`> 0`, `<= MAX_PRICE_CENTS`).
 * Arithmétique sur chaînes (aucun flottant) ; accepte la virgule, les espaces (fines
 * insécables comprises) et au plus 2 décimales. Vide, nul, négatif ou trop grand → invalide.
 */
export const parseThresholdEuros = (raw: string): ParsedThreshold => {
  const normalized = raw
    .trim()
    .replace(/[\s  ]/g, "")
    .replace(",", ".");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (match === null) return { ok: false };
  const euros = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = euros * 100 + fraction;
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_PRICE_CENTS) return { ok: false };
  return { ok: true, cents };
};

/** Centimes → saisie `12,50` (virgule décimale, deux décimales, sans symbole). */
export const formatThresholdInput = (cents: number): string => {
  const whole = Math.trunc(cents / 100);
  const fraction = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole},${fraction}`;
};

export type ThresholdGap =
  | { readonly kind: "unknown" }
  | { readonly kind: "reached"; readonly cents: number }
  | { readonly kind: "remaining"; readonly cents: number; readonly percent: number };

/**
 * Écart restant vers le seuil : `remaining` (prix courant au-dessus du seuil : `cents` à
 * perdre et `percent` du prix courant), `reached` (prix courant `<=` seuil ; `cents` = marge),
 * `unknown` sans prix courant.
 */
export const computeThresholdGap = (
  currentCents: number | null,
  thresholdCents: number,
): ThresholdGap => {
  if (currentCents === null) return { kind: "unknown" };
  if (currentCents <= thresholdCents) {
    return { kind: "reached", cents: thresholdCents - currentCents };
  }
  const cents = currentCents - thresholdCents;
  return { kind: "remaining", cents, percent: Math.round((cents / currentCents) * 100) };
};

// ---------------------------------------------------------------------------
// Helpers purs — âge relatif, évènements
// ---------------------------------------------------------------------------

/** Âge réel d'un déclenchement (`À l'instant`, minutes, heures, jours) ; `null` si illisible. */
export const computeAlertAge = (triggeredAt: string, nowMs: number) =>
  computePriceAge(triggeredAt, nowMs);

export const countUnreadEvents = (
  events: ReadonlyArray<Pick<AlertTriggeredEvent, "readAt">>,
): number => events.filter((event) => event.readAt === null).length;

/** Marque tous les évènements lus localement (avant confirmation serveur : UI optimiste). */
export const markEventsReadLocally = (
  events: ReadonlyArray<AlertTriggeredEvent>,
  readAtIso: string,
  eventId: string | null = null,
): ReadonlyArray<AlertTriggeredEvent> =>
  events.map((event) =>
    event.readAt === null && (eventId === null || event.id === eventId)
      ? { ...event, readAt: readAtIso }
      : event,
  );

/** Canaux effectifs d'une alerte (ordre `push`, `discord`). */
export const alertChannels = (
  alert: Pick<PriceAlert, "notifyPush" | "notifyDiscord">,
): ReadonlyArray<NotificationChannel> => [
  ...(alert.notifyPush ? (["push"] as const) : []),
  ...(alert.notifyDiscord ? (["discord"] as const) : []),
];

// ---------------------------------------------------------------------------
// Webhook Discord (aligné sur `profiles.discord_webhook_url`, docs/06 §4)
// ---------------------------------------------------------------------------

const PROFILE_WEBHOOK_PATTERN = /^https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

/**
 * URL de webhook acceptée à l'enregistrement : garde anti-SSRF du domaine
 * (`isAllowedDiscordWebhookUrl`) ET motif exact du `CHECK` SQL de `profiles`
 * (`https://discord.com/api/webhooks/<chiffres>/<jeton>`, sans `/vN/`, sans `discordapp.com`).
 */
export const isProfileDiscordWebhookUrl = (value: string | null): value is string =>
  value !== null && isAllowedDiscordWebhookUrl(value) && PROFILE_WEBHOOK_PATTERN.test(value);

// ---------------------------------------------------------------------------
// Web Push (navigateur)
// ---------------------------------------------------------------------------

/** Clé VAPID publique base64url → `Uint8Array` (`applicationServerKey`). */
export const vapidKeyToBytes = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Corps de `POST /api/push-subscriptions` (`PushSubscription.toJSON()` aplati). */
export interface PushSubscriptionBody {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent?: string | null | undefined;
}

/** Aplati un `PushSubscriptionJSON` ; `null` si l'abonnement est incomplet. */
export const toPushSubscriptionBody = (
  json: {
    readonly endpoint?: string | undefined;
    readonly keys?: Readonly<Record<string, string>> | undefined;
  },
  userAgent?: string,
): PushSubscriptionBody | null => {
  const p256dh = json.keys?.["p256dh"];
  const auth = json.keys?.["auth"];
  if (json.endpoint === undefined || p256dh === undefined || auth === undefined) return null;
  return {
    endpoint: json.endpoint,
    p256dh,
    auth,
    ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
  };
};

export type PushSupport = "supported" | "unsupported" | "denied";

/** Support Web Push du navigateur courant (`denied` : permission refusée par l'utilisateur). */
export const detectPushSupport = (): PushSupport => {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission === "denied" ? "denied" : "supported";
};

// ---------------------------------------------------------------------------
// Fetch typé
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export type AlertsFetchResult =
  | { readonly kind: "ok"; readonly payload: AlertsPayload }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

/** Validation légère du payload (forme des 4 blocs) avant de l'exposer à l'UI. */
export const readAlertsPayload = (value: unknown): AlertsPayload | null => {
  if (!isRecord(value)) return null;
  const channels = value["channels"];
  if (
    !isRecord(channels) ||
    !Array.isArray(value["alerts"]) ||
    !Array.isArray(value["triggeredEvents"]) ||
    typeof value["unreadCount"] !== "number"
  ) {
    return null;
  }
  return value as unknown as AlertsPayload;
};

/** `GET /api/alerts` : 401 → `unauthorized`, 200 → payload. */
export const fetchAlerts = async (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<AlertsFetchResult> => {
  try {
    const response = await fetchImpl(ALERTS_API_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    const payload = readAlertsPayload(await response.json());
    return payload === null ? { kind: "error" } : { kind: "ok", payload };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { kind: "error" };
  }
};

/**
 * `GET /api/alerts/unread-count` : silencieux (`null` sur 401, erreur réseau ou réponse
 * invalide ; l'appelant conserve alors la valeur précédente / `0`).
 */
export const fetchUnreadAlertsCount = async (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<number | null> => {
  try {
    const response = await fetchImpl(ALERTS_UNREAD_COUNT_API_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const count = body["unreadCount"];
    return typeof count === "number" && Number.isFinite(count) && count >= 0
      ? Math.trunc(count)
      : null;
  } catch {
    return null;
  }
};

const errorKind = (status: number): Exclude<MutationResult<never>["kind"], "ok"> => {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 413:
      return "too-large";
    default:
      return "error";
  }
};

const send = async <T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  read: (json: unknown) => T,
  fetchImpl: FetchLike,
): Promise<MutationResult<T>> => {
  try {
    const response = await fetchImpl(path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (response.status === 204) return { kind: "ok", body: read(null) };
    if (!response.ok) return { kind: errorKind(response.status) };
    return { kind: "ok", body: read(await response.json()) };
  } catch {
    return { kind: "error" };
  }
};

/** Corps de `POST /api/alerts` (miroir de `CreatePriceAlertInput`). */
export interface CreateAlertBody {
  readonly cardId: string;
  readonly language?: CardLanguage | undefined;
  readonly variant?: CardVariant | undefined;
  readonly minCondition?: CardCondition | undefined;
  readonly priceField?: AlertPriceField | undefined;
  readonly thresholdCents: number;
  readonly isActive?: boolean | undefined;
  readonly notifyPush?: boolean | undefined;
  readonly notifyDiscord?: boolean | undefined;
  readonly cooldownHours?: number | undefined;
}

/** Corps de `PATCH /api/alerts/$id` (au moins un champ ; la carte est immuable). */
export interface UpdateAlertBody {
  readonly language?: CardLanguage | undefined;
  readonly variant?: CardVariant | undefined;
  readonly minCondition?: CardCondition | undefined;
  readonly priceField?: AlertPriceField | undefined;
  readonly thresholdCents?: number | undefined;
  readonly isActive?: boolean | undefined;
  readonly notifyPush?: boolean | undefined;
  readonly notifyDiscord?: boolean | undefined;
  readonly cooldownHours?: number | undefined;
}

/** `POST /api/alerts` → 201 + `PriceAlert`. */
export const createAlert = (
  body: CreateAlertBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<PriceAlert>> =>
  send(ALERTS_API_PATH, "POST", body, (json) => json as PriceAlert, fetchImpl);

/** `PATCH /api/alerts/$id` → 200 + `PriceAlert`. */
export const updateAlert = (
  alertId: string,
  patch: UpdateAlertBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<PriceAlert>> =>
  send(alertApiPath(alertId), "PATCH", patch, (json) => json as PriceAlert, fetchImpl);

/** `DELETE /api/alerts/$id` → 200. */
export const deleteAlert = (
  alertId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<null>> =>
  send(alertApiPath(alertId), "DELETE", {}, () => null, fetchImpl);

const readUnreadCount = (json: unknown): number => {
  if (!isRecord(json)) return 0;
  const count = json["unreadCount"];
  return typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
};

/** `POST /api/alerts/events/read` (un évènement, ou tous si `eventId` est omis) → `{ unreadCount }`. */
export const markAlertEventsRead = (
  eventId?: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<number>> =>
  send(
    ALERTS_READ_API_PATH,
    "POST",
    eventId === undefined ? {} : { eventId },
    readUnreadCount,
    fetchImpl,
  );

/** `PATCH /api/alerts/channels` : enregistre (ou retire avec `null`) le webhook Discord. */
export const saveDiscordWebhook = (
  discordWebhookUrl: string | null,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<{ readonly discordWebhookConfigured: boolean }>> =>
  send(
    ALERTS_CHANNELS_API_PATH,
    "PATCH",
    { discordWebhookUrl },
    (json) => ({
      discordWebhookConfigured: isRecord(json) && json["discordWebhookConfigured"] === true,
    }),
    fetchImpl,
  );

/** `POST /api/push-subscriptions` : enregistre l'abonnement Web Push de l'appareil. */
export const registerPushSubscription = (
  body: PushSubscriptionBody,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<null>> =>
  send(PUSH_SUBSCRIPTIONS_API_PATH, "POST", body, () => null, fetchImpl);

/** `DELETE /api/push-subscriptions` : retire l'abonnement (clé : `endpoint`). */
export const unregisterPushSubscription = (
  endpoint: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<MutationResult<null>> =>
  send(PUSH_SUBSCRIPTIONS_API_PATH, "DELETE", { endpoint }, () => null, fetchImpl);
