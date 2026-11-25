import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreateShareLinkInput,
  decodeCreateShareLinkInput,
  decodeSharedBinderPayload,
  isValidShareToken,
  SHARE_TOKEN_BYTES,
  SHARE_TOKEN_MAX_LENGTH,
  SHARE_TOKEN_MIN_LENGTH,
  SHARE_TOKEN_REGEX,
  SharedBinderCard,
  SharedBinderCopy,
  SharedBinderMeta,
  SharedBinderOwner,
  SharedBinderPayload,
  ShareLink,
  ShareLinkForbiddenError,
  ShareLinkNotFoundError,
  ShareToken,
  type ValidationError,
} from "./index.ts";

const USER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BINDER = "bbbbbbbb-0000-4000-8000-000000000b01";
const LINK = "cccccccc-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const NOW = "2026-01-01T10:00:00.000Z";

const validLink = {
  id: LINK,
  userId: USER,
  binderId: BINDER,
  token: TOKEN,
  isActive: true,
  showQuantities: true,
  createdAt: NOW,
  revokedAt: null,
} as const;

const validPayload = {
  owner: { displayName: "Alice", avatarInitials: "AL" },
  binder: {
    id: BINDER,
    kind: "set",
    title: "Écarlate et Violet",
    setId: "sv01",
    setCode: "SVI",
    setName: "Écarlate et Violet",
    coverType: "set_logo",
    coverLogoUrl: "https://assets.tcgdex.net/fr/sv/sv01/logo",
    coverCardImageUrl: null,
    hasUploadedCover: false,
    showQuantities: true,
    ownedCount: 1,
    totalCards: 2,
  },
  cards: [
    {
      cardId: "sv01-001",
      localId: "001",
      localIdNumeric: 1,
      nameFr: "Poussacha",
      setCode: "SVI",
      rarity: "Commune",
      holoEffect: "none",
      imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv01/001",
      owned: true,
      quantity: 3,
      copies: [{ language: "FR", variant: "normal", quantity: 3 }],
    },
    {
      cardId: "sv01-SV1",
      localId: "SV1",
      localIdNumeric: null,
      nameFr: "Mew",
      setCode: null,
      rarity: null,
      holoEffect: "sir",
      imageBaseUrl: null,
      owned: false,
      quantity: 0,
      copies: [],
    },
  ],
} as const;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url sans padding (équivalent de `Buffer#toString("base64url")`, sans types Node). */
const base64url = (bytes: Uint8Array): string => {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let index = 0; index < bits.length; index += 6) {
    out += BASE64URL.charAt(Number.parseInt(bits.slice(index, index + 6).padEnd(6, "0"), 2));
  }
  return out;
};

const is = (schema: Schema.Codec<unknown, unknown>, value: unknown): boolean =>
  Schema.decodeUnknownExit(schema)(value)._tag === "Success";

const flip = <A>(effect: Effect.Effect<A, ValidationError>) =>
  Effect.runPromise(Effect.flip(effect));

describe("constantes & isValidShareToken", () => {
  it("32 octets en base64url = 43 caractères, alignés sur le CHECK SQL", () => {
    expect(SHARE_TOKEN_BYTES).toBe(32);
    expect(SHARE_TOKEN_MIN_LENGTH).toBe(43);
    expect(SHARE_TOKEN_MAX_LENGTH).toBe(128);
    expect(base64url(new Uint8Array(SHARE_TOKEN_BYTES).fill(255))).toHaveLength(
      SHARE_TOKEN_MIN_LENGTH,
    );
    expect(SHARE_TOKEN_REGEX.source).toBe("^[A-Za-z0-9_-]{43,128}$");
  });

  it("accepte 43..128 caractères base64url", () => {
    expect(isValidShareToken("A".repeat(43))).toBe(true);
    expect(isValidShareToken("a".repeat(128))).toBe(true);
    expect(isValidShareToken(`${"-_".repeat(30)}Az09`)).toBe(true);
    expect(isValidShareToken(base64url(new Uint8Array(32).fill(251)))).toBe(true);
  });

  it("refuse longueur hors bornes, alphabet non base64url et chaîne vide", () => {
    expect(isValidShareToken("")).toBe(false);
    expect(isValidShareToken("A".repeat(42))).toBe(false);
    expect(isValidShareToken("A".repeat(129))).toBe(false);
    for (const bad of ["+", "/", "=", " ", "\n", "é", "%", "'", ".", "\u0000"]) {
      expect(isValidShareToken(`${"A".repeat(42)}${bad}`)).toBe(false);
    }
    // `$` JS ne tolère pas le saut de ligne final : jamais accepté (comme `~ '^…$'` côté SQL).
    expect(isValidShareToken(`${"A".repeat(43)}\n`)).toBe(false);
  });
});

describe("ShareToken / ShareLink", () => {
  it("valide un jeton et une ligne share_links", () => {
    expect(is(ShareToken, TOKEN)).toBe(true);
    expect(is(ShareToken, "short")).toBe(false);
    expect(is(ShareLink, validLink)).toBe(true);
    expect(
      is(ShareLink, { ...validLink, isActive: false, revokedAt: NOW, showQuantities: false }),
    ).toBe(true);
  });

  it("refuse un jeton, un UUID ou des champs invalides", () => {
    expect(is(ShareLink, { ...validLink, token: "x".repeat(10) })).toBe(false);
    expect(is(ShareLink, { ...validLink, binderId: "nope" })).toBe(false);
    expect(is(ShareLink, { ...validLink, isActive: "yes" })).toBe(false);
    expect(is(ShareLink, { ...validLink, revokedAt: undefined })).toBe(false);
  });
});

describe("CreateShareLinkInput", () => {
  it("binderId requis (UUID), showQuantities optionnel", async () => {
    expect(is(CreateShareLinkInput, { binderId: BINDER })).toBe(true);
    expect(is(CreateShareLinkInput, { binderId: BINDER, showQuantities: false })).toBe(true);
    expect(is(CreateShareLinkInput, {})).toBe(false);
    expect(is(CreateShareLinkInput, { binderId: "not-a-uuid" })).toBe(false);
    expect(is(CreateShareLinkInput, { binderId: BINDER, showQuantities: "no" })).toBe(false);
    expect(await Effect.runPromise(decodeCreateShareLinkInput({ binderId: BINDER }))).toEqual({
      binderId: BINDER,
    });
    expect((await flip(decodeCreateShareLinkInput({ binderId: 1 })))._tag).toBe("ValidationError");
  });
});

describe("projection publique (liste blanche)", () => {
  it("accepte la réponse complète de get_shared_binder", () => {
    expect(is(SharedBinderPayload, validPayload)).toBe(true);
    expect(is(SharedBinderOwner, validPayload.owner)).toBe(true);
    expect(is(SharedBinderMeta, validPayload.binder)).toBe(true);
    for (const card of validPayload.cards) expect(is(SharedBinderCard, card)).toBe(true);
  });

  it("quantités masquées : null accepté ; quantités négatives / nulles refusées", () => {
    const hidden = {
      ...validPayload.cards[0],
      quantity: null,
      copies: [{ language: "FR", variant: "normal", quantity: null }],
    };
    expect(is(SharedBinderCard, hidden)).toBe(true);
    expect(is(SharedBinderCard, { ...validPayload.cards[0], quantity: -1 })).toBe(false);
    expect(is(SharedBinderCopy, { language: "FR", variant: "normal", quantity: 0 })).toBe(false);
    expect(is(SharedBinderCopy, { language: "DE", variant: "normal", quantity: 1 })).toBe(false);
    expect(is(SharedBinderCopy, { language: "FR", variant: "shiny", quantity: 1 })).toBe(false);
  });

  it("refuse les valeurs hors CHECK (kind, cover, holoEffect, compteurs)", () => {
    expect(is(SharedBinderMeta, { ...validPayload.binder, kind: "folder" })).toBe(false);
    expect(is(SharedBinderMeta, { ...validPayload.binder, coverType: "gif" })).toBe(false);
    expect(is(SharedBinderMeta, { ...validPayload.binder, ownedCount: -1 })).toBe(false);
    expect(is(SharedBinderCard, { ...validPayload.cards[0], holoEffect: "rainbow" })).toBe(false);
  });

  it("decodeSharedBinderPayload refuse TOUTE clé inconnue (échec fermé anti-fuite)", async () => {
    const decoded = await Effect.runPromise(decodeSharedBinderPayload(validPayload));
    expect(decoded.owner.displayName).toBe("Alice");

    const leaks: ReadonlyArray<unknown> = [
      { ...validPayload, userId: USER },
      { ...validPayload, owner: { ...validPayload.owner, email: "alice@example.test" } },
      { ...validPayload, binder: { ...validPayload.binder, coverStoragePath: `${USER}/x.webp` } },
      {
        ...validPayload,
        cards: [{ ...validPayload.cards[0], purchasePriceCents: 99999 }],
      },
      {
        ...validPayload,
        cards: [
          {
            ...validPayload.cards[0],
            copies: [{ language: "FR", variant: "normal", quantity: 1, notes: "secret" }],
          },
        ],
      },
    ];
    for (const leak of leaks) {
      expect((await flip(decodeSharedBinderPayload(leak)))._tag).toBe("ValidationError");
    }
    expect((await flip(decodeSharedBinderPayload(null)))._tag).toBe("ValidationError");
  });
});

describe("erreurs typées", () => {
  it("ShareLinkNotFoundError / ShareLinkForbiddenError portent leur _tag et leur message", () => {
    const notFound = new ShareLinkNotFoundError({ linkId: LINK, message: "not found" });
    expect(notFound._tag).toBe("ShareLinkNotFoundError");
    expect(notFound.linkId).toBe(LINK);
    expect(notFound.message).toBe("not found");
    // 404 public : aucun identifiant requis.
    expect(
      new ShareLinkNotFoundError({ message: "shared binder not found" }).linkId,
    ).toBeUndefined();

    const cause = new Error("42501");
    const forbidden = new ShareLinkForbiddenError({ message: "forbidden", cause });
    expect(forbidden._tag).toBe("ShareLinkForbiddenError");
    expect(forbidden.cause).toBe(cause);
  });
});
