import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  type ECDH,
  hkdfSync,
  verify,
} from "node:crypto";
import {
  InvalidWebhookUrlError,
  NotificationDeliveryError,
  PushSubscriptionGoneError,
} from "@pokevault/domain";
import { Effect, type Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AlertNotification,
  buildDiscordEmbed,
  buildWebPushMessage,
  encryptWebPushPayload,
  formatEuroCents,
  generateVapidKeys,
  makeNotificationServiceFake,
  NotificationService,
  NotificationServiceFake,
  NotificationServiceLive,
  type PushTarget,
  signVapidJwt,
  VAPID_JWT_TTL_SECONDS,
  type VapidConfig,
} from "./notification-service.ts";

const NOTIFICATION: AlertNotification = {
  alertId: "bbbbbbbb-0000-4000-8000-000000000001",
  cardId: "sv03.5-198",
  cardName: "Florizarre-ex",
  setName: "151",
  cardNumber: "198",
  priceField: "low_fr",
  observedPriceCents: 4690,
  thresholdCents: 5000,
  imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/198/low.webp",
  cardmarketUrl: "https://www.cardmarket.com/fr/Pokemon/Products/Singles/151/Venusaur-ex",
};

const APP_URL = "https://pokevault.example/";
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(30)}`;
const DISCORD_USER = "223456789012345678";

const b64u = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

/** Navigateur simulé : paire ECDH P-256 + secret d'authentification. */
const makeBrowser = (): {
  readonly ecdh: ECDH;
  readonly authSecret: Buffer;
  target: PushTarget;
} => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = Buffer.from("0123456789abcdef");
  return {
    ecdh,
    authSecret,
    target: {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      p256dh: b64u(ecdh.getPublicKey()),
      auth: b64u(authSecret),
    },
  };
};

/** Déchiffrement côté navigateur (RFC 8291 §4 + RFC 8188). */
const decryptAsBrowser = (body: Buffer, ecdh: ECDH, authSecret: Buffer): Buffer => {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const uaPublic = ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(
    hkdfSync("sha256", ecdh.computeSecret(asPublic), authSecret, keyInfo, 32),
  );
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  const delimiter = plain.lastIndexOf(0x02);
  return plain.subarray(0, delimiter);
};

const verifyJwt = (jwt: string, vapid: VapidConfig) => {
  const [header, claims, signature] = jwt.split(".");
  if (header === undefined || claims === undefined || signature === undefined) {
    throw new Error("malformed jwt");
  }
  const publicBytes = Buffer.from(vapid.publicKey, "base64url");
  const publicKey = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64u(publicBytes.subarray(1, 33)),
      y: b64u(publicBytes.subarray(33, 65)),
    },
    format: "jwk",
  });
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  return {
    valid,
    signatureLength: Buffer.from(signature, "base64url").length,
    header: JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>,
  };
};

const vapid = (): VapidConfig => ({
  ...generateVapidKeys(),
  subject: "mailto:ops@pokevault.example",
});

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

const stubFetch = (
  respond: (call: FetchCall, index: number) => Response | Promise<Response>,
): { readonly calls: Array<FetchCall>; readonly mock: ReturnType<typeof vi.fn> } => {
  const calls: Array<FetchCall> = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, NotificationService>,
  layer: Layer.Layer<NotificationService>,
) => Effect.runPromise(Effect.provide(effect, layer));

const flip = <A, E>(
  effect: Effect.Effect<A, E, NotificationService>,
  layer: Layer.Layer<NotificationService>,
) => Effect.runPromise(Effect.provide(Effect.flip(effect), layer));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chiffrement Web Push aes128gcm (RFC 8291)", () => {
  it("reproduit le vecteur de test de l'Annexe A de la RFC 8291", () => {
    const asEcdh = createECDH("prime256v1");
    asEcdh.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
    const body = encryptWebPushPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), ephemeral: asEcdh },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("chiffre puis déchiffre côté navigateur (en-tête RFC 8188 : rs 4096, keyid = clé éphémère)", () => {
    const browser = makeBrowser();
    const payload = Buffer.from(JSON.stringify({ title: "Florizarre-ex #198 · 46,90 €" }));
    const body = encryptWebPushPayload(payload, browser.target);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.readUInt8(21)).toBe(0x04);
    expect(decryptAsBrowser(body, browser.ecdh, browser.authSecret).toString()).toBe(
      payload.toString(),
    );
    // Sel + clé éphémère aléatoires : deux chiffrements du même clair diffèrent.
    expect(encryptWebPushPayload(payload, browser.target).equals(body)).toBe(false);
  });

  it("refuse un payload trop gros, une clé p256dh ou un secret auth invalides", () => {
    const browser = makeBrowser();
    expect(() => encryptWebPushPayload(Buffer.alloc(5000), browser.target)).toThrow();
    expect(() =>
      encryptWebPushPayload(Buffer.from("x"), { p256dh: "AAAA", auth: browser.target.auth }),
    ).toThrow();
    expect(() =>
      encryptWebPushPayload(Buffer.from("x"), { p256dh: browser.target.p256dh, auth: "AAAA" }),
    ).toThrow();
  });
});

describe("signature VAPID ES256 (RFC 8292)", () => {
  it("signe un JWT ES256 ieee-p1363 (64 octets) valide, aud = origine, exp <= now + 12 h", () => {
    const config = vapid();
    const nowMs = Date.parse("2026-01-01T10:00:00.000Z");
    const { jwt, exp } = signVapidJwt(config, "https://fcm.googleapis.com", nowMs);
    const parsed = verifyJwt(jwt, config);
    expect(parsed.valid).toBe(true);
    expect(parsed.signatureLength).toBe(64);
    expect(parsed.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(parsed.claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp,
      sub: "mailto:ops@pokevault.example",
    });
    expect(exp).toBeLessThanOrEqual(Math.floor(nowMs / 1000) + 12 * 3600);
    expect(exp).toBe(Math.floor(nowMs / 1000) + VAPID_JWT_TTL_SECONDS);
  });

  it("rejette des clés VAPID mal formées", () => {
    expect(() =>
      signVapidJwt(
        { publicKey: "AAAA", privateKey: "AAAA", subject: "mailto:a@b.c" },
        "https://x",
        0,
      ),
    ).toThrow();
  });
});

describe("mise en forme", () => {
  it("formate les montants en EUR fr-FR et le message push", () => {
    expect(formatEuroCents(4690).replace(/\s/g, " ")).toBe("46,90 €");
    const message = buildWebPushMessage(NOTIFICATION, APP_URL);
    expect(message.title.replace(/\s/g, " ")).toBe("Florizarre-ex #198 · 46,90 €");
    expect(message.body.replace(/\s/g, " ")).toBe(
      "Passée sous ton seuil de 50,00 € sur Cardmarket",
    );
    expect(message.url).toBe("https://pokevault.example/alerts");
    expect(message.cardId).toBe("sv03.5-198");
    expect(message.alertId).toBe(NOTIFICATION.alertId);
  });

  it("n'embarque la miniature que si HTTPS et le lien Cardmarket que s'il est sûr", () => {
    const embed = buildDiscordEmbed(NOTIFICATION, APP_URL, 0) as {
      url?: string;
      thumbnail?: { url: string };
      description: string;
    };
    expect(embed.url).toBe(NOTIFICATION.cardmarketUrl);
    expect(embed.thumbnail?.url).toBe(NOTIFICATION.imageUrl);
    expect(embed.description).toContain("https://pokevault.example/alerts");
    const unsafe = buildDiscordEmbed(
      {
        ...NOTIFICATION,
        imageUrl: "http://insecure/x.webp",
        cardmarketUrl: "https://evil.example/x",
      },
      APP_URL,
      0,
    ) as { url?: string; thumbnail?: unknown; description: string };
    expect(unsafe.url).toBeUndefined();
    expect(unsafe.thumbnail).toBeUndefined();
    expect(unsafe.description).not.toContain("evil.example");
  });
});

describe("NotificationServiceLive.sendWebPush", () => {
  it("chiffre, signe VAPID et POST sans suivre les redirections ; le navigateur déchiffre le JSON", async () => {
    const config = vapid();
    const browser = makeBrowser();
    const { calls } = stubFetch(() => new Response(null, { status: 201 }));
    const layer = NotificationServiceLive({ appUrl: APP_URL, vapid: config });
    await run(
      Effect.flatMap(NotificationService, (s) => s.sendWebPush(browser.target, NOTIFICATION)),
      layer,
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(browser.target.endpoint);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers["ttl"]).toBe("86400");
    const authorization = headers["authorization"] ?? "";
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
    expect(match?.[2]).toBe(config.publicKey);
    const jwt = verifyJwt(match?.[1] ?? "", config);
    expect(jwt.valid).toBe(true);
    expect(jwt.claims["aud"]).toBe("https://fcm.googleapis.com");
    const body = call?.init.body;
    expect(body).toBeInstanceOf(Uint8Array);
    const decrypted = JSON.parse(
      decryptAsBrowser(
        Buffer.from(body as Uint8Array),
        browser.ecdh,
        browser.authSecret,
      ).toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(decrypted).sort()).toEqual(["alertId", "body", "cardId", "title", "url"]);
    expect(decrypted["cardId"]).toBe("sv03.5-198");
    expect(decrypted["alertId"]).toBe(NOTIFICATION.alertId);
    expect(decrypted["url"]).toBe("https://pokevault.example/alerts");
  });

  it("rejette un endpoint SSRF AVANT tout appel réseau", async () => {
    const { mock } = stubFetch(() => new Response(null, { status: 201 }));
    const layer = NotificationServiceLive({ appUrl: APP_URL, vapid: vapid() });
    const browser = makeBrowser();
    for (const endpoint of [
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest",
      "http://fcm.googleapis.com/x",
      "https://localhost/x",
      "https://[::1]/x",
    ]) {
      const error = await flip(
        Effect.flatMap(NotificationService, (s) =>
          s.sendWebPush({ ...browser.target, endpoint }, NOTIFICATION),
        ),
        layer,
      );
      expect(error).toBeInstanceOf(NotificationDeliveryError);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("échoue proprement sans clés VAPID, sans appel réseau", async () => {
    const { mock } = stubFetch(() => new Response(null, { status: 201 }));
    const error = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendWebPush(makeBrowser().target, NOTIFICATION)),
      NotificationServiceLive({ appUrl: APP_URL }),
    );
    expect(error).toBeInstanceOf(NotificationDeliveryError);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([404, 410] as const)(
    "HTTP %i ⇒ PushSubscriptionGoneError (abonnement à purger) et body annulé",
    async (status) => {
      const cancel = vi.fn(async () => undefined);
      stubFetch(() => {
        const response = new Response("gone", { status });
        Object.defineProperty(response, "body", { value: { cancel } });
        return response;
      });
      const browser = makeBrowser();
      const error = await flip(
        Effect.flatMap(NotificationService, (s) => s.sendWebPush(browser.target, NOTIFICATION)),
        NotificationServiceLive({ appUrl: APP_URL, vapid: vapid() }),
      );
      expect(error).toBeInstanceOf(PushSubscriptionGoneError);
      expect(error).toMatchObject({ endpoint: browser.target.endpoint, status });
      expect(cancel).toHaveBeenCalled();
    },
  );

  it("HTTP 500, 429 et redirection 302 ⇒ NotificationDeliveryError avec le statut", async () => {
    const browser = makeBrowser();
    const layer = NotificationServiceLive({ appUrl: APP_URL, vapid: vapid() });
    for (const status of [500, 429, 302]) {
      stubFetch(() => new Response(null, { status }));
      const error = await flip(
        Effect.flatMap(NotificationService, (s) => s.sendWebPush(browser.target, NOTIFICATION)),
        layer,
      );
      expect(error).toBeInstanceOf(NotificationDeliveryError);
      expect(error).toMatchObject({ channel: "push", status });
    }
  });

  it("erreur réseau ⇒ NotificationDeliveryError", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendWebPush(makeBrowser().target, NOTIFICATION)),
      NotificationServiceLive({ appUrl: APP_URL, vapid: vapid() }),
    );
    expect(error).toBeInstanceOf(NotificationDeliveryError);
  });

  it("interrompt l'appel au timeout (signal abortable)", async () => {
    stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          (call.init.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const error = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendWebPush(makeBrowser().target, NOTIFICATION)),
      NotificationServiceLive({ appUrl: APP_URL, vapid: vapid(), timeoutMs: 20 }),
    );
    expect(error).toBeInstanceOf(NotificationDeliveryError);
  });
});

describe("NotificationServiceLive.sendDiscordWebhook", () => {
  const layer = NotificationServiceLive({ appUrl: APP_URL });

  it("poste un embed riche sans suivre les redirections et sans query ni fragment hérités", async () => {
    const { calls } = stubFetch(() => new Response(null, { status: 204 }));
    await run(
      Effect.flatMap(NotificationService, (s) =>
        s.sendDiscordWebhook(`${WEBHOOK}?wait=true&thread_id=1#frag`, NOTIFICATION),
      ),
      layer,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.method).toBe("POST");
    const payload = JSON.parse(String(calls[0]?.init.body)) as {
      allowed_mentions: { parse: Array<string> };
      embeds: Array<{
        title: string;
        url: string;
        thumbnail: { url: string };
        fields: Array<{ name: string; value: string }>;
        description: string;
      }>;
    };
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const embed = payload.embeds[0];
    expect(embed?.title).toBe("Florizarre-ex #198");
    expect(embed?.url).toBe(NOTIFICATION.cardmarketUrl);
    expect(embed?.thumbnail.url).toBe(NOTIFICATION.imageUrl);
    const fields = Object.fromEntries((embed?.fields ?? []).map((f) => [f.name, f.value]));
    expect(String(fields["Prix constaté"]).replace(/\s/g, " ")).toBe("46,90 €");
    expect(String(fields["Seuil"]).replace(/\s/g, " ")).toBe("50,00 €");
    expect(fields["Extension"]).toBe("151 · 198");
    expect(embed?.description).toContain("Voir sur Cardmarket");
    expect(embed?.description).toContain("https://pokevault.example/alerts");
  });

  it("rejette toute URL hors webhook Discord (InvalidWebhookUrlError) sans appel réseau", async () => {
    const { mock } = stubFetch(() => new Response(null, { status: 204 }));
    for (const url of [
      "http://discord.com/api/webhooks/123456789012345678/" + "a".repeat(30),
      "https://evil.example/api/webhooks/123456789012345678/" + "a".repeat(30),
      "https://discord.com.evil.example/api/webhooks/123456789012345678/" + "a".repeat(30),
      "https://169.254.169.254/latest/meta-data",
      "https://discord.com/api/webhooks/1/short",
    ]) {
      const error = await flip(
        Effect.flatMap(NotificationService, (s) => s.sendDiscordWebhook(url, NOTIFICATION)),
        layer,
      );
      expect(error).toBeInstanceOf(InvalidWebhookUrlError);
      expect(String((error as Error).message)).not.toContain("a".repeat(30));
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("HTTP 404 / 429 ⇒ NotificationDeliveryError (jeton absent du message)", async () => {
    for (const status of [404, 429]) {
      stubFetch(() => new Response(null, { status }));
      const error = await flip(
        Effect.flatMap(NotificationService, (s) => s.sendDiscordWebhook(WEBHOOK, NOTIFICATION)),
        layer,
      );
      expect(error).toBeInstanceOf(NotificationDeliveryError);
      expect(error).toMatchObject({ channel: "discord", status });
      expect((error as Error).message).not.toContain("a".repeat(30));
    }
  });
});

describe("NotificationServiceLive.sendDiscordDm (bot)", () => {
  it("échoue sans jeton de bot ou avec un identifiant invalide, sans appel réseau", async () => {
    const { mock } = stubFetch(() => new Response(null, { status: 200 }));
    const withoutToken = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendDiscordDm(DISCORD_USER, NOTIFICATION)),
      NotificationServiceLive({ appUrl: APP_URL }),
    );
    expect(withoutToken).toBeInstanceOf(NotificationDeliveryError);
    const invalid = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendDiscordDm("../channels/1", NOTIFICATION)),
      NotificationServiceLive({ appUrl: APP_URL, discordBotToken: "bot-token" }),
    );
    expect(invalid).toBeInstanceOf(NotificationDeliveryError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("ouvre le canal DM puis envoie l'embed, uniquement vers discord.com/api/v10", async () => {
    const { calls } = stubFetch((_call, index) =>
      index === 0
        ? new Response(JSON.stringify({ id: "323456789012345678" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
    await run(
      Effect.flatMap(NotificationService, (s) => s.sendDiscordDm(DISCORD_USER, NOTIFICATION)),
      NotificationServiceLive({ appUrl: APP_URL, discordBotToken: "bot-token" }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://discord.com/api/v10/users/@me/channels",
      "https://discord.com/api/v10/channels/323456789012345678/messages",
    ]);
    for (const call of calls) {
      expect(call.init.redirect).toBe("manual");
      expect((call.init.headers as Record<string, string>)["authorization"]).toBe("Bot bot-token");
    }
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ recipient_id: DISCORD_USER });
    expect(JSON.parse(String(calls[1]?.init.body)).embeds).toHaveLength(1);
  });

  it("rejette un channel id piégé renvoyé par l'API (pas d'SSRF par chemin) et les échecs HTTP", async () => {
    const layer = NotificationServiceLive({ appUrl: APP_URL, discordBotToken: "bot-token" });
    const { calls } = stubFetch(
      () => new Response(JSON.stringify({ id: "../../evil" }), { status: 200 }),
    );
    const trapped = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendDiscordDm(DISCORD_USER, NOTIFICATION)),
      layer,
    );
    expect(trapped).toBeInstanceOf(NotificationDeliveryError);
    expect(calls).toHaveLength(1);

    stubFetch(() => new Response(null, { status: 403 }));
    const forbidden = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendDiscordDm(DISCORD_USER, NOTIFICATION)),
      layer,
    );
    expect(forbidden).toMatchObject({ _tag: "NotificationDeliveryError", status: 403 });
  });
});

describe("NotificationServiceFake", () => {
  it("réussit par défaut et enregistre chaque tentative", async () => {
    const fake = makeNotificationServiceFake();
    const target = makeBrowser().target;
    await run(
      Effect.gen(function* () {
        const service = yield* NotificationService;
        yield* service.sendWebPush(target, NOTIFICATION);
        yield* service.sendDiscordWebhook(WEBHOOK, NOTIFICATION);
        yield* service.sendDiscordDm(DISCORD_USER, NOTIFICATION);
      }),
      fake.layer,
    );
    expect(fake.calls.map((c) => c.kind)).toEqual(["push", "discord_webhook", "discord_dm"]);
  });

  it("injecte des échecs typés par canal", async () => {
    const layer = NotificationServiceFake({
      push: (target) =>
        Effect.fail(
          new PushSubscriptionGoneError({
            endpoint: target.endpoint,
            status: 410,
            message: "gone",
          }),
        ),
    });
    const error = await flip(
      Effect.flatMap(NotificationService, (s) => s.sendWebPush(makeBrowser().target, NOTIFICATION)),
      layer,
    );
    expect(error).toBeInstanceOf(PushSubscriptionGoneError);
  });
});
