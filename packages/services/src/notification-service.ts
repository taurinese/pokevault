import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  type ECDH,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  type AlertPriceField,
  InvalidWebhookUrlError,
  isAllowedDiscordWebhookUrl,
  isSafePushEndpointUrl,
  isValidDiscordUserId,
  NotificationDeliveryError,
  PushSubscriptionGoneError,
} from "@pokevault/domain";
import { Clock, Context, Effect, Layer } from "effect";
import { isAllowedCardmarketUrl } from "./cardmarket-price-service.ts";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Timeout par défaut de chaque appel réseau sortant (push service, Discord). */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10_000;

/** Durée de validité du JWT VAPID : RFC 8292 impose `exp <= now + 24 h`, on vise 12 h. */
export const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;

/** `TTL` du message push : le push service le conserve 24 h si l'appareil est hors ligne. */
export const WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;

/** Taille d'enregistrement `aes128gcm` (RFC 8188) : un seul enregistrement suffit (payload < 4 Kio). */
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 16 - 1; // tag GCM (16) + délimiteur (1)

export const DISCORD_API_BASE = "https://discord.com/api/v10";

const DISCORD_EMBED_COLOR = 0x2ecc71;
const SNOWFLAKE = /^\d{17,22}$/;

// ---------------------------------------------------------------------------
// Contrat du service
// ---------------------------------------------------------------------------

/** Contenu factuel d'une alerte déclenchée, indépendant du canal. */
export interface AlertNotification {
  readonly alertId: string;
  readonly cardId: string;
  readonly cardName: string;
  readonly setName: string | null;
  /** Numéro dans l'extension (`local_id`). */
  readonly cardNumber: string | null;
  readonly priceField: AlertPriceField;
  readonly observedPriceCents: number;
  readonly thresholdCents: number;
  /** Miniature TCGdex (utilisée seulement si HTTPS). */
  readonly imageUrl: string | null;
  /** Page produit Cardmarket (utilisée seulement si elle passe la garde SSRF). */
  readonly cardmarketUrl: string | null;
}

/** Abonnement Web Push du navigateur (`push_subscriptions`). */
export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type PushDeliveryError = PushSubscriptionGoneError | NotificationDeliveryError;
export type DiscordWebhookDeliveryError = InvalidWebhookUrlError | NotificationDeliveryError;

export interface NotificationServiceShape {
  /**
   * Envoie une notification Web Push chiffrée (RFC 8291) signée VAPID (RFC 8292).
   * `404` / `410` du push service ⇒ `PushSubscriptionGoneError` (l'appelant purge l'abonnement).
   */
  readonly sendWebPush: (
    target: PushTarget,
    notification: AlertNotification,
  ) => Effect.Effect<void, PushDeliveryError>;
  /** Poste un embed sur un webhook Discord (URL validée anti-SSRF avant tout appel réseau). */
  readonly sendDiscordWebhook: (
    webhookUrl: string,
    notification: AlertNotification,
  ) => Effect.Effect<void, DiscordWebhookDeliveryError>;
  /** DM Discord via le bot (`discordBotToken` requis), uniquement vers `discord.com/api/v10`. */
  readonly sendDiscordDm: (
    discordUserId: string,
    notification: AlertNotification,
  ) => Effect.Effect<void, NotificationDeliveryError>;
}

/** Effect-TS service key of the notification service. */
export class NotificationService extends Context.Service<
  NotificationService,
  NotificationServiceShape
>()("@pokevault/services/NotificationService") {}

// ---------------------------------------------------------------------------
// Mise en forme du message (pure)
// ---------------------------------------------------------------------------

const euroFormatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

/** `4690` → `46,90 €` (locale `fr-FR`). */
export const formatEuroCents = (cents: number): string => euroFormatter.format(cents / 100);

const PRICE_FIELD_LABEL: Record<AlertPriceField, string> = {
  low_fr: "Prix le plus bas FR",
  trend: "Tendance",
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const cardLabel = (n: AlertNotification): string =>
  n.cardNumber === null ? n.cardName : `${n.cardName} #${n.cardNumber}`;

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** Lien d'ouverture dans l'app (écran Alertes). */
export const buildAppUrl = (appUrl: string): string => `${trimSlash(appUrl)}/alerts`;

export interface WebPushMessage {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly cardId: string;
  readonly alertId: string;
}

/** Payload JSON du Web Push : `Florizarre-ex #198 · 46,90 €` / `Passée sous ton seuil de 50,00 €…`. */
export const buildWebPushMessage = (n: AlertNotification, appUrl: string): WebPushMessage => ({
  title: truncate(`${cardLabel(n)} · ${formatEuroCents(n.observedPriceCents)}`, 120),
  body: `Passée sous ton seuil de ${formatEuroCents(n.thresholdCents)} sur Cardmarket`,
  url: buildAppUrl(appUrl),
  cardId: n.cardId,
  alertId: n.alertId,
});

const isHttpsUrl = (value: string | null): value is string => {
  if (value === null) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
};

/** Embed Discord riche : carte, prix constaté vs seuil, miniature, liens Cardmarket + app. */
export const buildDiscordEmbed = (
  n: AlertNotification,
  appUrl: string,
  nowMs: number,
): Record<string, unknown> => {
  const cardmarketUrl = isAllowedCardmarketUrl(n.cardmarketUrl) ? n.cardmarketUrl : null;
  const links = [
    ...(cardmarketUrl === null ? [] : [`[Voir sur Cardmarket](${cardmarketUrl})`]),
    `[Ouvrir PokéVault](${buildAppUrl(appUrl)})`,
  ].join(" · ");
  const setLine =
    n.setName === null
      ? null
      : truncate(n.cardNumber === null ? n.setName : `${n.setName} · ${n.cardNumber}`, 1024);
  return {
    title: truncate(cardLabel(n), 256),
    ...(cardmarketUrl === null ? {} : { url: cardmarketUrl }),
    description: `Passée sous ton seuil de ${formatEuroCents(n.thresholdCents)} sur Cardmarket\n${links}`,
    color: DISCORD_EMBED_COLOR,
    fields: [
      { name: "Prix constaté", value: formatEuroCents(n.observedPriceCents), inline: true },
      { name: "Seuil", value: formatEuroCents(n.thresholdCents), inline: true },
      { name: "Champ surveillé", value: PRICE_FIELD_LABEL[n.priceField], inline: true },
      ...(setLine === null ? [] : [{ name: "Extension", value: setLine, inline: false }]),
    ],
    ...(isHttpsUrl(n.imageUrl) ? { thumbnail: { url: n.imageUrl } } : {}),
    footer: { text: "PokéVault · alerte de prix" },
    timestamp: new Date(nowMs).toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Web Push : VAPID (RFC 8292, ES256) + chiffrement aes128gcm (RFC 8291) en pur node:crypto
// ---------------------------------------------------------------------------

export interface VapidConfig {
  /** Clé publique P-256 non compressée (65 octets) en base64url — `applicationServerKey`. */
  readonly publicKey: string;
  /** Scalaire privé P-256 (32 octets) en base64url. */
  readonly privateKey: string;
  /** `mailto:…` ou `https://…` : contact de l'opérateur pour le push service. */
  readonly subject: string;
}

/** Génère une paire VAPID (`pnpm`/node REPL : `generateVapidKeys()`), 100 % gratuite et locale. */
export const generateVapidKeys = (): Pick<VapidConfig, "publicKey" | "privateKey"> => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
};

const b64url = (data: Uint8Array | string): string => Buffer.from(data).toString("base64url");

/** Signe le JWT VAPID (`ES256`, signature `ieee-p1363` r‖s) pour l'origine du push service. */
export const signVapidJwt = (
  config: VapidConfig,
  audience: string,
  nowMs: number,
): { readonly jwt: string; readonly exp: number } => {
  const publicKey = Buffer.from(config.publicKey, "base64url");
  const privateScalar = Buffer.from(config.privateKey, "base64url");
  if (publicKey.length !== 65 || publicKey[0] !== 0x04 || privateScalar.length !== 32) {
    throw new Error(
      "VAPID keys must be a 65-byte uncompressed P-256 public key and 32-byte scalar",
    );
  }
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64url(privateScalar),
      x: b64url(publicKey.subarray(1, 33)),
      y: b64url(publicKey.subarray(33, 65)),
    },
    format: "jwk",
  });
  const exp = Math.floor(nowMs / 1000) + VAPID_JWT_TTL_SECONDS;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: audience, exp, sub: config.subject }));
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return { jwt: `${signingInput}.${b64url(signature)}`, exp };
};

export interface EncryptWebPushOptions {
  /** Sel `aes128gcm` de 16 octets (tests déterministes ; aléatoire sinon). */
  readonly salt?: Buffer | undefined;
  /** Paire ECDH éphémère de l'application server (tests déterministes ; aléatoire sinon). */
  readonly ephemeral?: ECDH | undefined;
}

/**
 * Chiffre un payload selon RFC 8291 (`Content-Encoding: aes128gcm`) :
 * ECDH P-256 (éphémère ↔ `p256dh`) → HKDF-SHA256 avec le secret `auth` → CEK AES-128 + nonce →
 * AES-128-GCM sur `payload ‖ 0x02` (enregistrement unique). Corps = en-tête RFC 8188
 * (`salt ‖ rs ‖ idlen ‖ keyid = clé publique éphémère`) ‖ chiffré ‖ tag.
 */
export const encryptWebPushPayload = (
  payload: Uint8Array,
  target: Pick<PushTarget, "p256dh" | "auth">,
  options?: EncryptWebPushOptions,
): Buffer => {
  if (payload.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`push payload exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  const uaPublic = Buffer.from(target.p256dh, "base64url");
  const authSecret = Buffer.from(target.auth, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error("p256dh must be a 65-byte uncompressed P-256 public key");
  }
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");

  const ephemeral = options?.ephemeral ?? createECDH("prime256v1");
  if (options?.ephemeral === undefined) ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const ecdhSecret = ephemeral.computeSecret(uaPublic);
  const salt = options?.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  // IKM = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info\0" ‖ ua ‖ as, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
};

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export interface NotificationServiceConfig {
  /** URL publique de l'app (liens des notifications), ex. `https://pokevault.example`. */
  readonly appUrl: string;
  readonly vapid?: VapidConfig | undefined;
  /** Jeton du bot Discord (DM) ; sans lui `sendDiscordDm` échoue proprement. */
  readonly discordBotToken?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/** `fetch` sortant : jamais de redirection suivie, annulable, timeout borné. */
const guardedFetch = (
  signal: AbortSignal,
  timeoutMs: number,
  url: string,
  init: Omit<RequestInit, "redirect" | "signal">,
): Promise<Response> =>
  fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });

const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // body déjà consommé / fermé : rien à libérer
  }
};

const httpFailure = (
  channel: "push" | "discord",
  response: Response,
  what: string,
): NotificationDeliveryError =>
  new NotificationDeliveryError({
    channel,
    status: response.status,
    message: `${what} failed with HTTP ${response.status}`,
  });

const asDelivery =
  (channel: "push" | "discord", what: string) =>
  (cause: unknown): NotificationDeliveryError =>
    cause instanceof NotificationDeliveryError
      ? cause
      : new NotificationDeliveryError({ channel, message: `${what} request failed`, cause });

/**
 * Service live : Web Push natif (`node:crypto`, aucune dépendance npm), webhook Discord et DM
 * via bot. Toutes les destinations sont validées AVANT l'appel réseau (SSRF) ; les redirections
 * ne sont jamais suivies ; chaque appel est annulable et soumis à un timeout.
 */
export const NotificationServiceLive = (
  config: NotificationServiceConfig,
): Layer.Layer<NotificationService> => {
  const timeoutMs = config.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
  const appUrl = config.appUrl;

  const sendWebPush: NotificationServiceShape["sendWebPush"] = (target, notification) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise({
        try: async (signal) => {
          if (!isSafePushEndpointUrl(target.endpoint)) {
            throw new NotificationDeliveryError({
              channel: "push",
              message: "push endpoint rejected by the SSRF guard",
            });
          }
          const vapid = config.vapid;
          if (vapid === undefined) {
            throw new NotificationDeliveryError({
              channel: "push",
              message: "VAPID keys are not configured",
            });
          }
          const endpoint = new URL(target.endpoint);
          const { jwt } = signVapidJwt(vapid, endpoint.origin, nowMs);
          const body = encryptWebPushPayload(
            Buffer.from(JSON.stringify(buildWebPushMessage(notification, appUrl)), "utf8"),
            target,
          );
          const response = await guardedFetch(signal, timeoutMs, target.endpoint, {
            method: "POST",
            headers: {
              authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: String(WEB_PUSH_TTL_SECONDS),
              urgency: "normal",
            },
            // `Uint8Array<ArrayBuffer>` : seul type binaire accepté par `BodyInit` (libs DOM + Node).
            body: new Uint8Array(body),
          });
          await discardBody(response);
          if (response.status === 404 || response.status === 410) {
            throw new PushSubscriptionGoneError({
              endpoint: target.endpoint,
              status: response.status,
              message: `push subscription is gone (HTTP ${response.status})`,
            });
          }
          if (response.status < 200 || response.status >= 300) {
            throw httpFailure("push", response, "web push");
          }
        },
        catch: (cause): PushDeliveryError =>
          cause instanceof PushSubscriptionGoneError
            ? cause
            : asDelivery("push", "web push")(cause),
      });
    });

  const postEmbed = (
    signal: AbortSignal,
    url: string,
    headers: Record<string, string>,
    notification: AlertNotification,
    nowMs: number,
  ): Promise<Response> =>
    guardedFetch(signal, timeoutMs, url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        username: "PokéVault",
        allowed_mentions: { parse: [] },
        embeds: [buildDiscordEmbed(notification, appUrl, nowMs)],
      }),
    });

  const sendDiscordWebhook: NotificationServiceShape["sendDiscordWebhook"] = (
    webhookUrl,
    notification,
  ) =>
    Effect.gen(function* () {
      if (!isAllowedDiscordWebhookUrl(webhookUrl)) {
        return yield* Effect.fail(
          new InvalidWebhookUrlError({
            message: "discord webhook URL rejected: expected https://discord.com/api/webhooks/…",
          }),
        );
      }
      const nowMs = yield* Clock.currentTimeMillis;
      // Requête reconstruite depuis l'origine + chemin validés : ni query, ni fragment hérités.
      const parsed = new URL(webhookUrl);
      const target = `${parsed.origin}${parsed.pathname}`;
      yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await postEmbed(signal, target, {}, notification, nowMs);
          await discardBody(response);
          if (response.status < 200 || response.status >= 300) {
            throw httpFailure("discord", response, "discord webhook");
          }
        },
        catch: asDelivery("discord", "discord webhook"),
      });
    });

  const sendDiscordDm: NotificationServiceShape["sendDiscordDm"] = (discordUserId, notification) =>
    Effect.gen(function* () {
      const token = config.discordBotToken;
      if (token === undefined || token.trim().length === 0) {
        return yield* Effect.fail(
          new NotificationDeliveryError({
            channel: "discord",
            message: "discord bot token is not configured",
          }),
        );
      }
      if (!isValidDiscordUserId(discordUserId)) {
        return yield* Effect.fail(
          new NotificationDeliveryError({
            channel: "discord",
            message: "discord user id is invalid",
          }),
        );
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const headers = { authorization: `Bot ${token.trim()}` };
      yield* Effect.tryPromise({
        try: async (signal) => {
          const opened = await guardedFetch(
            signal,
            timeoutMs,
            `${DISCORD_API_BASE}/users/@me/channels`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
              body: JSON.stringify({ recipient_id: discordUserId }),
            },
          );
          if (opened.status < 200 || opened.status >= 300) {
            await discardBody(opened);
            throw httpFailure("discord", opened, "discord DM channel creation");
          }
          let channelId: unknown;
          try {
            channelId = ((await opened.json()) as { readonly id?: unknown }).id;
          } catch (cause) {
            throw new NotificationDeliveryError({
              channel: "discord",
              message: "discord DM channel response is not valid JSON",
              cause,
            });
          }
          if (typeof channelId !== "string" || !SNOWFLAKE.test(channelId)) {
            throw new NotificationDeliveryError({
              channel: "discord",
              message: "discord DM channel response has no valid channel id",
            });
          }
          const response = await postEmbed(
            signal,
            `${DISCORD_API_BASE}/channels/${channelId}/messages`,
            headers,
            notification,
            nowMs,
          );
          await discardBody(response);
          if (response.status < 200 || response.status >= 300) {
            throw httpFailure("discord", response, "discord DM message");
          }
        },
        catch: asDelivery("discord", "discord DM"),
      });
    });

  return Layer.succeed(NotificationService, { sendWebPush, sendDiscordWebhook, sendDiscordDm });
};

// ---------------------------------------------------------------------------
// Fake (tests 100 % offline)
// ---------------------------------------------------------------------------

export type SentNotification =
  | { readonly kind: "push"; readonly target: PushTarget; readonly notification: AlertNotification }
  | {
      readonly kind: "discord_webhook";
      readonly webhookUrl: string;
      readonly notification: AlertNotification;
    }
  | {
      readonly kind: "discord_dm";
      readonly discordUserId: string;
      readonly notification: AlertNotification;
    };

export interface NotificationServiceFakeHandlers {
  readonly push?: NotificationServiceShape["sendWebPush"] | undefined;
  readonly discordWebhook?: NotificationServiceShape["sendDiscordWebhook"] | undefined;
  readonly discordDm?: NotificationServiceShape["sendDiscordDm"] | undefined;
}

export interface NotificationServiceRecorder {
  readonly layer: Layer.Layer<NotificationService>;
  /** Tentatives d'envoi (réussies ou non) dans l'ordre. */
  readonly calls: Array<SentNotification>;
}

/**
 * Fake enregistreur : réussit par défaut ; chaque canal peut être surchargé pour injecter un
 * échec typé (`PushSubscriptionGoneError`, `NotificationDeliveryError`…). Aucune I/O.
 */
export const makeNotificationServiceFake = (
  handlers?: NotificationServiceFakeHandlers,
): NotificationServiceRecorder => {
  const calls: Array<SentNotification> = [];
  const impl: NotificationServiceShape = {
    sendWebPush: (target, notification) =>
      Effect.suspend(() => {
        calls.push({ kind: "push", target, notification });
        return handlers?.push?.(target, notification) ?? Effect.void;
      }),
    sendDiscordWebhook: (webhookUrl, notification) =>
      Effect.suspend(() => {
        calls.push({ kind: "discord_webhook", webhookUrl, notification });
        return handlers?.discordWebhook?.(webhookUrl, notification) ?? Effect.void;
      }),
    sendDiscordDm: (discordUserId, notification) =>
      Effect.suspend(() => {
        calls.push({ kind: "discord_dm", discordUserId, notification });
        return handlers?.discordDm?.(discordUserId, notification) ?? Effect.void;
      }),
  };
  return { layer: Layer.succeed(NotificationService, impl), calls };
};

/** Layer fake sans enregistreur (voir {@link makeNotificationServiceFake} pour inspecter les appels). */
export const NotificationServiceFake = (
  handlers?: NotificationServiceFakeHandlers,
): Layer.Layer<NotificationService> => makeNotificationServiceFake(handlers).layer;
