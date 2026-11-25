import { Data, Effect, Schema } from "effect";
import { CardCondition, CardId, CardLanguage, CardVariant } from "./card.ts";
import { Uuid } from "./collection.ts";
import { MAX_PRICE_CENTS, type PriceSource } from "./pricing.ts";

// ---------------------------------------------------------------------------
// Constants (docs/02 §4 `price_alerts`, supabase/migrations/007_price_alerts.sql)
// ---------------------------------------------------------------------------

/** Délai minimal entre deux déclenchements d'une même alerte, par défaut (24 h). */
export const DEFAULT_ALERT_COOLDOWN_HOURS = 24;
/** Bornes du cooldown (`CHECK (cooldown_hours BETWEEN 1 AND 168)`). */
export const MIN_ALERT_COOLDOWN_HOURS = 1;
export const MAX_ALERT_COOLDOWN_HOURS = 168;

/** Presets de seuil proposés par l'UI (variation en % par rapport au prix courant). */
export const ALERT_THRESHOLD_PRESETS = [-5, -12, -20] as const;

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Champ de prix surveillé : `low_fr` (prix le plus bas FR) ou `trend` (tendance Cardmarket). */
export const AlertPriceField = Schema.Literals(["low_fr", "trend"]);
export type AlertPriceField = typeof AlertPriceField.Type;

/** Canal de notification d'un déclenchement. */
export const NotificationChannel = Schema.Literals(["push", "discord"]);
export type NotificationChannel = typeof NotificationChannel.Type;

/** `price_alerts.threshold_cents` : centimes EUR, entier strictement positif. */
export const AlertThresholdCents = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_PRICE_CENTS),
);

/** `price_alerts.cooldown_hours` : entier `1..168`. */
export const AlertCooldownHours = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_ALERT_COOLDOWN_HOURS),
  Schema.isLessThanOrEqualTo(MAX_ALERT_COOLDOWN_HOURS),
);

const hasAnyKey =
  (keys: ReadonlyArray<string>) =>
  (value: object): true | string =>
    keys.some((key) => (value as Record<string, unknown>)[key] !== undefined)
      ? true
      : `at least one of ${keys.join(", ")} is required`;

/** Ligne `price_alerts` (dates ISO 8601, sérialisables vers le client). */
export const PriceAlert = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  cardId: CardId,
  language: CardLanguage,
  variant: CardVariant,
  minCondition: CardCondition,
  priceField: AlertPriceField,
  thresholdCents: AlertThresholdCents,
  isActive: Schema.Boolean,
  notifyPush: Schema.Boolean,
  notifyDiscord: Schema.Boolean,
  cooldownHours: AlertCooldownHours,
  lastTriggeredAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PriceAlert = typeof PriceAlert.Type;

/**
 * Création d'une alerte. Défauts SQL : langue `FR`, variante `normal`, état minimum `NM`,
 * champ `low_fr`, active, push seul, cooldown 24 h.
 */
export const CreatePriceAlertInput = Schema.Struct({
  cardId: CardId,
  language: Schema.optionalKey(CardLanguage),
  variant: Schema.optionalKey(CardVariant),
  minCondition: Schema.optionalKey(CardCondition),
  priceField: Schema.optionalKey(AlertPriceField),
  thresholdCents: AlertThresholdCents,
  isActive: Schema.optionalKey(Schema.Boolean),
  notifyPush: Schema.optionalKey(Schema.Boolean),
  notifyDiscord: Schema.optionalKey(Schema.Boolean),
  cooldownHours: Schema.optionalKey(AlertCooldownHours),
});
export type CreatePriceAlertInput = typeof CreatePriceAlertInput.Type;

/** Patch d'une alerte (la carte est immuable) ; au moins un champ est requis. */
export const UpdatePriceAlertInput = Schema.Struct({
  language: Schema.optionalKey(CardLanguage),
  variant: Schema.optionalKey(CardVariant),
  minCondition: Schema.optionalKey(CardCondition),
  priceField: Schema.optionalKey(AlertPriceField),
  thresholdCents: Schema.optionalKey(AlertThresholdCents),
  isActive: Schema.optionalKey(Schema.Boolean),
  notifyPush: Schema.optionalKey(Schema.Boolean),
  notifyDiscord: Schema.optionalKey(Schema.Boolean),
  cooldownHours: Schema.optionalKey(AlertCooldownHours),
}).check(
  Schema.makeFilter(
    hasAnyKey([
      "language",
      "variant",
      "minCondition",
      "priceField",
      "thresholdCents",
      "isActive",
      "notifyPush",
      "notifyDiscord",
      "cooldownHours",
    ]),
  ),
);
export type UpdatePriceAlertInput = typeof UpdatePriceAlertInput.Type;

/** Ligne `alert_events` : historique d'un déclenchement (`readAt = null` ⇒ non lu). */
export const AlertEvent = Schema.Struct({
  id: Uuid,
  alertId: Uuid,
  userId: Uuid,
  observedPriceCents: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_PRICE_CENTS),
  ),
  thresholdCents: AlertThresholdCents,
  channelsSent: Schema.Array(NotificationChannel),
  readAt: Schema.NullOr(Schema.String),
  triggeredAt: Schema.String,
});
export type AlertEvent = typeof AlertEvent.Type;

// ---------------------------------------------------------------------------
// Anti-SSRF validators (docs/06 §4) — pures, utilisables côté client et serveur
// ---------------------------------------------------------------------------

/**
 * Sous-ensemble de la classe WHATWG `URL` utilisé ici : le domaine compile avec `lib: ES2023`
 * seul (ni DOM ni Node), mais `URL` existe à l'exécution (navigateur, Node, worker).
 */
interface ParsedUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
}
declare const URL: new (input: string) => ParsedUrl;

const parseUrl = (value: string | null): ParsedUrl | null => {
  if (value === null) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const DISCORD_WEBHOOK_PATH = /^\/api\/(?:v\d+\/)?webhooks\/\d{17,22}\/[A-Za-z0-9_-]{20,}$/;
const DISCORD_HOSTS: ReadonlySet<string> = new Set(["discord.com", "discordapp.com"]);

/**
 * URL de webhook Discord autorisée : `https:` sur le port par défaut, sans credentials, hôte
 * `discord.com` / `discordapp.com`, chemin `/api[/vN]/webhooks/<id>/<token>` strict, sans `..`.
 * Toute autre URL (dont une redirection ou un autre hôte) est refusée : prévention SSRF.
 */
export const isAllowedDiscordWebhookUrl = (url: string | null): url is string => {
  if (url === null || url.includes("..")) return false;
  const parsed = parseUrl(url);
  if (parsed === null) return false;
  if (parsed.protocol !== "https:") return false;
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return false;
  if (!DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  return DISCORD_WEBHOOK_PATH.test(parsed.pathname);
};

/** Snowflake Discord (identifiant utilisateur) : 17 à 22 chiffres. */
export const isValidDiscordUserId = (id: string | null): id is string =>
  id !== null && /^\d{17,22}$/.test(id);

const isPrivateIpv4 = (host: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
};

const isPrivateIpv6 = (host: string): boolean => {
  // `URL.hostname` conserve les crochets : `[::1]`, `[fe80::1]`…
  if (!host.startsWith("[")) return false;
  const inner = host.slice(1, -1).toLowerCase();
  if (inner === "::" || inner === "::1") return true;
  if (inner.startsWith("::ffff:") || inner.startsWith("64:ff9b:")) return true; // IPv4 mappée
  if (/^fe[89ab]/.test(inner)) return true; // fe80::/10 link-local
  return inner.startsWith("fc") || inner.startsWith("fd"); // fc00::/7 unique-local
};

/**
 * Endpoint Web Push sûr à appeler depuis le worker : `https:`, port par défaut, sans
 * credentials, hors `localhost`, `*.local`, `*.internal` et hors adresses IP privées /
 * loopback / link-local (IPv4 et IPv6). Un endpoint rejeté n'est JAMAIS contacté.
 */
export const isSafePushEndpointUrl = (url: string | null): url is string => {
  const parsed = parseUrl(url);
  if (parsed === null) return false;
  if (parsed.protocol !== "https:") return false;
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return false;
  return true;
};

/** Abonnement Web Push navigateur (`PushSubscription.toJSON()` aplati). */
export const PushSubscription = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  userAgent: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastSeenAt: Schema.String,
});
export type PushSubscription = typeof PushSubscription.Type;

const Base64UrlKey = (minLength: number, maxLength: number) =>
  Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_-]+={0,2}$/),
    Schema.isMinLength(minLength),
    Schema.isMaxLength(maxLength),
  );

/** Enregistrement / rafraîchissement d'un abonnement (endpoint HTTPS public uniquement). */
export const RegisterPushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String.check(
    Schema.isMaxLength(2048),
    Schema.makeFilter((value: string) =>
      isSafePushEndpointUrl(value) ? true : "endpoint must be a public https URL",
    ),
  ),
  /** Clé publique ECDH P-256 du navigateur (65 octets non compressés en base64url). */
  p256dh: Base64UrlKey(80, 120),
  /** Secret d'authentification (16 octets en base64url). */
  auth: Base64UrlKey(16, 40),
  userAgent: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(512)))),
});
export type RegisterPushSubscriptionInput = typeof RegisterPushSubscriptionInput.Type;

/** Compteurs d'un passage d'évaluation des alertes. */
export const AlertEvaluationBatchReport = Schema.Struct({
  evaluated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  triggered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedCooldown: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedAboveThreshold: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedNoPrice: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pushSent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pushExpiredRemoved: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  discordSent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deliveryFailed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AlertEvaluationBatchReport = typeof AlertEvaluationBatchReport.Type;

// ---------------------------------------------------------------------------
// Typed domain errors
// ---------------------------------------------------------------------------

/** Alerte (ou évènement) inexistante, ou appartenant à un autre utilisateur (RLS : invisible). */
export class AlertNotFoundError extends Data.TaggedError("AlertNotFoundError")<{
  readonly alertId: string;
  readonly message: string;
}> {}

/** Entrée d'alerte / d'abonnement invalide (schéma ou contrainte `CHECK`). */
export class AlertValidationError extends Data.TaggedError("AlertValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** URL de webhook Discord refusée par la garde anti-SSRF (l'URL n'est jamais journalisée : jeton). */
export class InvalidWebhookUrlError extends Data.TaggedError("InvalidWebhookUrlError")<{
  readonly message: string;
}> {}

/** Échec d'envoi d'une notification (réseau, HTTP non 2xx, configuration manquante). */
export class NotificationDeliveryError extends Data.TaggedError("NotificationDeliveryError")<{
  readonly channel: NotificationChannel;
  readonly message: string;
  readonly status?: number | undefined;
  readonly cause?: unknown;
}> {}

/** Le service push a répondu `404` / `410` : l'abonnement est expiré et doit être supprimé. */
export class PushSubscriptionGoneError extends Data.TaggedError("PushSubscriptionGoneError")<{
  readonly endpoint: string;
  readonly status: 404 | 410;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const decodeWith =
  <T, E>(schema: Schema.Codec<T, E>) =>
  (input: unknown): Effect.Effect<T, AlertValidationError> =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(
        (error) => new AlertValidationError({ message: error.message, cause: error }),
      ),
    );

export const decodeCreatePriceAlertInput = decodeWith(CreatePriceAlertInput);
export const decodeUpdatePriceAlertInput = decodeWith(UpdatePriceAlertInput);
export const decodeRegisterPushSubscriptionInput = decodeWith(RegisterPushSubscriptionInput);

// ---------------------------------------------------------------------------
// Moteur d'évaluation pur
// ---------------------------------------------------------------------------

/** Sous-ensemble d'un `PriceSnapshot` utile à l'évaluation. */
export interface AlertPriceSnapshot {
  readonly source: PriceSource;
  readonly trendCents: number | null;
  readonly lowFrCents: number | null;
}

/** Sous-ensemble d'une `PriceAlert` utile à l'évaluation. */
export interface EvaluableAlert {
  readonly isActive: boolean;
  readonly priceField: AlertPriceField;
  readonly thresholdCents: number;
  readonly cooldownHours: number;
  readonly lastTriggeredAt: string | null;
  readonly notifyPush: boolean;
  readonly notifyDiscord: boolean;
}

export type AlertSkipReason =
  | "inactive"
  | "no_price"
  | "fallback_only"
  | "field_missing"
  | "above_threshold"
  | "cooldown"
  | "no_channels";

/** Décision du moteur : déclencher (avec les canaux demandés) ou ignorer (avec la raison). */
export type AlertEvaluation =
  | {
      readonly decision: "skip";
      readonly reason: "inactive" | "no_price" | "fallback_only" | "field_missing" | "no_channels";
    }
  | {
      readonly decision: "skip";
      readonly reason: "above_threshold";
      readonly observedPriceCents: number;
    }
  | {
      readonly decision: "skip";
      readonly reason: "cooldown";
      readonly observedPriceCents: number;
      /** ISO 8601 : premier instant où l'alerte pourra de nouveau se déclencher. */
      readonly nextEligibleAt: string;
    }
  | {
      readonly decision: "trigger";
      readonly observedPriceCents: number;
      readonly thresholdCents: number;
      readonly channels: ReadonlyArray<NotificationChannel>;
    };

/** Prix observé selon le champ surveillé (`null` si absent du snapshot). */
export const selectObservedPriceCents = (
  priceField: AlertPriceField,
  snapshot: Pick<AlertPriceSnapshot, "trendCents" | "lowFrCents">,
): number | null => (priceField === "low_fr" ? snapshot.lowFrCents : snapshot.trendCents);

/**
 * Évalue une alerte face au dernier snapshot de prix (fonction pure, aucune I/O).
 *
 * Ordre des garde-fous : inactive → pas de prix → prix indicatif TCGdex seul (jamais de fausse
 * alerte « Cardmarket ») → champ absent → au-dessus du seuil (égalité = déclenchement) →
 * cooldown anti-spam (référence `lastTriggeredAt`) → aucun canal → déclenchement.
 */
export const evaluatePriceAlert = (
  alert: EvaluableAlert,
  snapshot: AlertPriceSnapshot | null,
  nowMs: number,
): AlertEvaluation => {
  if (!alert.isActive) return { decision: "skip", reason: "inactive" };
  if (snapshot === null) return { decision: "skip", reason: "no_price" };
  if (snapshot.source === "tcgdex_fallback") return { decision: "skip", reason: "fallback_only" };

  const observedPriceCents = selectObservedPriceCents(alert.priceField, snapshot);
  if (observedPriceCents === null) return { decision: "skip", reason: "field_missing" };
  if (observedPriceCents > alert.thresholdCents) {
    return { decision: "skip", reason: "above_threshold", observedPriceCents };
  }

  if (alert.lastTriggeredAt !== null) {
    const lastMs = Date.parse(alert.lastTriggeredAt);
    const cooldownMs = alert.cooldownHours * HOUR_MS;
    if (!Number.isNaN(lastMs) && nowMs - lastMs < cooldownMs) {
      return {
        decision: "skip",
        reason: "cooldown",
        observedPriceCents,
        nextEligibleAt: new Date(lastMs + cooldownMs).toISOString(),
      };
    }
  }

  const channels: Array<NotificationChannel> = [];
  if (alert.notifyPush) channels.push("push");
  if (alert.notifyDiscord) channels.push("discord");
  if (channels.length === 0) return { decision: "skip", reason: "no_channels" };

  return {
    decision: "trigger",
    observedPriceCents,
    thresholdCents: alert.thresholdCents,
    channels,
  };
};
