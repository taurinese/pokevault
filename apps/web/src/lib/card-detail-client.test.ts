import { describe, expect, it, vi } from "vitest";
import {
  addCardCopy,
  adjustCardCopyQuantity,
  cardBindersApiPath,
  cardCopiesApiPath,
  cardCopyApiPath,
  cardDetailApiPath,
  cardPriceRefreshApiPath,
  computePriceAge,
  cooldownMinutes,
  defaultVariantFor,
  deleteCardCopy,
  type FetchLike,
  fetchCardDetail,
  formatIsoDate,
  formatPriceCents,
  isSafeHttpsUrl,
  parsePurchasePriceEuros,
  purchasePriceEurosToCents,
  readCardDetailPrice,
  refreshCardPrice,
  setCardInBinder,
  tilePriceCents,
  updateCardCopy,
} from "./card-detail-client.ts";

const CARD_ID = "sv03.5-199";
const COPY_ID = "55555555-5555-4555-8555-555555555555";

// ---------------------------------------------------------------------------
// Helpers purs — prix euros → centimes
// ---------------------------------------------------------------------------

describe("purchasePriceEurosToCents", () => {
  it("converts euros to integer cents with Math.round", () => {
    expect(purchasePriceEurosToCents(12.5)).toBe(1250);
    expect(purchasePriceEurosToCents(0)).toBe(0);
    expect(purchasePriceEurosToCents(19.999)).toBe(2000);
    expect(purchasePriceEurosToCents(3.333)).toBe(333);
    expect(Number.isInteger(purchasePriceEurosToCents(1234.56))).toBe(true);
  });
});

describe("parsePurchasePriceEuros", () => {
  it("accepts the French decimal comma and trims spaces", () => {
    expect(parsePurchasePriceEuros("12,50")).toEqual({ ok: true, cents: 1250 });
    expect(parsePurchasePriceEuros("  7,99  ")).toEqual({ ok: true, cents: 799 });
    expect(parsePurchasePriceEuros("42")).toEqual({ ok: true, cents: 4200 });
    expect(parsePurchasePriceEuros("0,01")).toEqual({ ok: true, cents: 1 });
  });

  it("treats an empty field as no price (null cents)", () => {
    expect(parsePurchasePriceEuros("")).toEqual({ ok: true, cents: null });
    expect(parsePurchasePriceEuros("   ")).toEqual({ ok: true, cents: null });
  });

  it("rejects invalid input", () => {
    expect(parsePurchasePriceEuros("abc")).toEqual({ ok: false });
    expect(parsePurchasePriceEuros("12,505")).toEqual({ ok: false });
    expect(parsePurchasePriceEuros("-3")).toEqual({ ok: false });
    expect(parsePurchasePriceEuros("1.000.000")).toEqual({ ok: false });
    expect(parsePurchasePriceEuros("2000000")).toEqual({ ok: false });
  });
});

describe("formatPriceCents / formatIsoDate", () => {
  it("formats cents as fr-FR euros", () => {
    expect(formatPriceCents(1250)).toBe("12,50 €");
    expect(formatPriceCents(0)).toBe("0,00 €");
    expect(formatPriceCents(null)).toBeNull();
  });

  it("formats an ISO date in fr-FR and tolerates null/invalid", () => {
    expect(formatIsoDate(null)).toBeNull();
    expect(formatIsoDate("not-a-date")).toBeNull();
    const formatted = formatIsoDate("2026-01-15T10:00:00.000Z");
    expect(formatted).toMatch(/2026/);
    // Date SQL sans heure (YYYY-MM-DD) : jamais décalée d'un jour quel que soit le fuseau.
    expect(formatIsoDate("2025-12-31")).toMatch(/31.*2025/);
  });

  it("only allows https: URLs in isSafeHttpsUrl", () => {
    expect(isSafeHttpsUrl("https://www.cardmarket.com/fr/Pokemon/Products/123")).toBe(true);
    expect(isSafeHttpsUrl("http://www.cardmarket.com/fr/Pokemon/Products/123")).toBe(false);
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("not-a-url")).toBe(false);
    expect(isSafeHttpsUrl(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Variante par défaut intelligente
// ---------------------------------------------------------------------------

describe("defaultVariantFor", () => {
  it("prefers normal when available", () => {
    expect(defaultVariantFor(["holo", "normal", "reverse"])).toBe("normal");
  });

  it("falls back to the first available variant in canonical order", () => {
    expect(defaultVariantFor(["holo", "reverse"])).toBe("reverse");
    expect(defaultVariantFor(["masterball", "promo"])).toBe("promo");
    expect(defaultVariantFor(["pokeball"])).toBe("pokeball");
  });

  it("defaults to normal when no variant is available", () => {
    expect(defaultVariantFor([])).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// Chemins d'API
// ---------------------------------------------------------------------------

describe("API paths", () => {
  it("builds escaped paths", () => {
    expect(cardDetailApiPath(CARD_ID)).toBe("/api/cards/sv03.5-199");
    expect(cardCopiesApiPath(CARD_ID)).toBe("/api/cards/sv03.5-199/copies");
    expect(cardCopyApiPath(COPY_ID)).toBe(`/api/cards/copies/${COPY_ID}`);
    expect(cardBindersApiPath(CARD_ID)).toBe("/api/cards/sv03.5-199/binders");
    expect(cardDetailApiPath("a b")).toBe("/api/cards/a%20b");
  });
});

// ---------------------------------------------------------------------------
// Fetch typé
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const payload = { card: { id: CARD_ID }, copies: [], customBinders: [] };

/** Extrait l'appel `index` d'un mock fetch avec une vérification explicite. */
const callAt = (
  mock: ReturnType<typeof vi.fn>,
  index: number,
): { readonly input: string; readonly init: RequestInit } => {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`expected fetch call #${index}`);
  return { input: String(call[0]), init: (call[1] ?? {}) as RequestInit };
};

const asMock = (fetchImpl: FetchLike): ReturnType<typeof vi.fn> =>
  fetchImpl as unknown as ReturnType<typeof vi.fn>;

describe("fetchCardDetail", () => {
  it("maps 200 / 401 / 404 / 500 to result kinds and sends credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(payload)) as unknown as FetchLike;
    const ok = await fetchCardDetail(CARD_ID, undefined, fetchImpl);
    expect(ok).toEqual({ kind: "ok", payload });

    const first = callAt(asMock(fetchImpl), 0);
    expect(first.input).toBe(`/api/cards/${CARD_ID}`);
    expect(first.init.credentials).toBe("same-origin");

    const unauthorized = (async () => jsonResponse({}, 401)) as FetchLike;
    expect(await fetchCardDetail(CARD_ID, undefined, unauthorized)).toEqual({
      kind: "unauthorized",
    });
    const notFound = (async () => jsonResponse({}, 404)) as FetchLike;
    expect(await fetchCardDetail(CARD_ID, undefined, notFound)).toEqual({ kind: "not-found" });
    const error = (async () => jsonResponse({}, 503)) as FetchLike;
    expect(await fetchCardDetail(CARD_ID, undefined, error)).toEqual({ kind: "error" });
    const network = (async () => {
      throw new Error("down");
    }) as FetchLike;
    expect(await fetchCardDetail(CARD_ID, undefined, network)).toEqual({ kind: "error" });
  });
});

describe("mutations", () => {
  it("addCardCopy POSTs the body and maps statuses", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      return jsonResponse({ id: COPY_ID, quantity: 1 }, 201);
    });
    const result = await addCardCopy(
      CARD_ID,
      { language: "FR", variant: "holo", condition: "NM", quantity: 1, purchasePriceCents: 1250 },
      fetchImpl as unknown as FetchLike,
    );
    expect(result.kind).toBe("ok");
    const first = callAt(asMock(fetchImpl), 0);
    expect(first.input).toBe(`/api/cards/${CARD_ID}/copies`);
    expect(JSON.parse(String(first.init.body))).toEqual({
      language: "FR",
      variant: "holo",
      condition: "NM",
      quantity: 1,
      purchasePriceCents: 1250,
    });

    const forbidden = (async () => jsonResponse({}, 403)) as FetchLike;
    expect(
      (
        await addCardCopy(
          CARD_ID,
          { language: "FR", variant: "normal", condition: "NM", quantity: 1 },
          forbidden,
        )
      ).kind,
    ).toBe("forbidden");
    const invalid = (async () => jsonResponse({}, 400)) as FetchLike;
    expect(
      (
        await addCardCopy(
          CARD_ID,
          { language: "FR", variant: "normal", condition: "NM", quantity: 1 },
          invalid,
        )
      ).kind,
    ).toBe("invalid");
    const tooLarge = (async () => jsonResponse({}, 413)) as FetchLike;
    expect(
      (
        await addCardCopy(
          CARD_ID,
          { language: "FR", variant: "normal", condition: "NM", quantity: 1 },
          tooLarge,
        )
      ).kind,
    ).toBe("too-large");
  });

  it("adjustCardCopyQuantity sends { delta } to PATCH /api/cards/copies/$copyId", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.method).toBe("PATCH");
      return jsonResponse({ copy: { id: COPY_ID, quantity: 1 }, deleted: false });
    });
    const result = await adjustCardCopyQuantity(COPY_ID, -1, fetchImpl as unknown as FetchLike);
    expect(result).toEqual({
      kind: "ok",
      body: { copy: { id: COPY_ID, quantity: 1 }, deleted: false },
    });
    const first = callAt(asMock(fetchImpl), 0);
    expect(first.input).toBe(`/api/cards/copies/${COPY_ID}`);
    expect(JSON.parse(String(first.init.body))).toEqual({ delta: -1 });

    const deleted = (async () => jsonResponse({ copy: null, deleted: true })) as FetchLike;
    expect(await adjustCardCopyQuantity(COPY_ID, -1, deleted)).toEqual({
      kind: "ok",
      body: { copy: null, deleted: true },
    });
  });

  it("updateCardCopy sends the patch fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ copy: { id: COPY_ID } }));
    const result = await updateCardCopy(
      COPY_ID,
      { condition: "EX" },
      fetchImpl as unknown as FetchLike,
    );
    expect(result.kind).toBe("ok");
    expect(JSON.parse(String(callAt(asMock(fetchImpl), 0).init.body))).toEqual({
      condition: "EX",
    });
    const conflict = (async () => jsonResponse({}, 409)) as FetchLike;
    expect((await updateCardCopy(COPY_ID, { condition: "EX" }, conflict)).kind).toBe("conflict");
  });

  it("deleteCardCopy maps 204 to ok and 404 to not-found", async () => {
    const noContent = (async () => new Response(null, { status: 204 })) as FetchLike;
    const result = await deleteCardCopy(COPY_ID, noContent);
    expect(result).toEqual({ kind: "ok", body: null });
    const notFound = (async () => jsonResponse({}, 404)) as FetchLike;
    expect((await deleteCardCopy(COPY_ID, notFound)).kind).toBe("not-found");
  });

  it("setCardInBinder uses POST for add and DELETE for remove", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ binderId: "b", cardId: CARD_ID }, 201)
        : new Response(null, { status: 204 }),
    );
    const added = await setCardInBinder(CARD_ID, "b", true, fetchImpl as unknown as FetchLike);
    expect(added.kind).toBe("ok");
    const removed = await setCardInBinder(CARD_ID, "b", false, fetchImpl as unknown as FetchLike);
    expect(removed).toEqual({ kind: "ok", body: null });
    const mock = asMock(fetchImpl);
    expect(callAt(mock, 0).input).toBe(`/api/cards/${CARD_ID}/binders`);
    expect(callAt(mock, 0).init.method).toBe("POST");
    expect(callAt(mock, 1).init.method).toBe("DELETE");
    expect(JSON.parse(String(callAt(mock, 1).init.body))).toEqual({ binderId: "b" });
  });
});

// ---------------------------------------------------------------------------
// Prix Cardmarket : helpers purs
// ---------------------------------------------------------------------------

describe("tilePriceCents", () => {
  it("prefers the trend, then the 30-day average, then the lowest FR price", () => {
    expect(tilePriceCents({ trendCents: 500, lowFrCents: 100, avg30Cents: 300 })).toBe(500);
    expect(tilePriceCents({ trendCents: null, lowFrCents: 100, avg30Cents: 300 })).toBe(300);
    expect(tilePriceCents({ trendCents: null, lowFrCents: 100, avg30Cents: null })).toBe(100);
  });

  it("keeps a legitimate 0-cent price and returns null when nothing is quoted", () => {
    expect(tilePriceCents({ trendCents: 0, lowFrCents: 100, avg30Cents: null })).toBe(0);
    expect(tilePriceCents({ trendCents: null, lowFrCents: null, avg30Cents: null })).toBeNull();
    expect(tilePriceCents(null)).toBeNull();
    expect(tilePriceCents(undefined)).toBeNull();
  });
});

describe("computePriceAge", () => {
  const NOW = Date.parse("2026-06-01T12:00:00.000Z");
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it("returns a real, structured relative age", () => {
    expect(computePriceAge(ago(0), NOW)).toEqual({ kind: "just_now" });
    expect(computePriceAge(ago(59_999), NOW)).toEqual({ kind: "just_now" });
    expect(computePriceAge(ago(60_000), NOW)).toEqual({ kind: "minutes", count: 1 });
    expect(computePriceAge(ago(6 * 60_000), NOW)).toEqual({ kind: "minutes", count: 6 });
    expect(computePriceAge(ago(59 * 60_000), NOW)).toEqual({ kind: "minutes", count: 59 });
    expect(computePriceAge(ago(2 * 3_600_000 + 5 * 60_000), NOW)).toEqual({
      kind: "hours",
      count: 2,
    });
    expect(computePriceAge(ago(24 * 3_600_000), NOW)).toEqual({ kind: "days", count: 1 });
    expect(computePriceAge(ago(3 * 24 * 3_600_000 + 1), NOW)).toEqual({ kind: "days", count: 3 });
  });

  it("never goes negative on clock skew and rejects unreadable dates", () => {
    expect(computePriceAge(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toEqual({
      kind: "just_now",
    });
    expect(computePriceAge("pas une date", NOW)).toBeNull();
  });
});

describe("cooldownMinutes", () => {
  it("rounds up and never shows less than 1 minute", () => {
    expect(cooldownMinutes(300_000)).toBe(5);
    expect(cooldownMinutes(240_001)).toBe(5);
    expect(cooldownMinutes(61_000)).toBe(2);
    expect(cooldownMinutes(1)).toBe(1);
    expect(cooldownMinutes(0)).toBe(1);
    expect(cooldownMinutes(-5)).toBe(1);
  });
});

const priceJson = {
  trendCents: 1234,
  lowFrCents: 950,
  avg30Cents: null,
  source: "cardmarket",
  fetchedAt: "2026-06-01T12:00:00.000Z",
  expiresAt: "2026-06-01T12:15:00.000Z",
  isFresh: true,
};

describe("readCardDetailPrice", () => {
  it("decodes a valid price and rejects malformed ones", () => {
    expect(readCardDetailPrice(priceJson)).toEqual(priceJson);
    expect(readCardDetailPrice(null)).toBeNull();
    expect(readCardDetailPrice([])).toBeNull();
    expect(readCardDetailPrice({ ...priceJson, source: "other" })).toBeNull();
    expect(readCardDetailPrice({ ...priceJson, trendCents: "12" })).toBeNull();
    expect(readCardDetailPrice({ ...priceJson, fetchedAt: 3 })).toBeNull();
    expect(readCardDetailPrice({ ...priceJson, isFresh: "yes" })).toBeNull();
  });
});

describe("refreshCardPrice", () => {
  it("POSTs to /api/cards/$cardId/price-refresh with a JSON body and same-origin credentials", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ kind: "refreshed_cardmarket", price: priceJson }),
    );
    const result = await refreshCardPrice(
      CARD_ID,
      { language: "EN", variant: "holo" },
      fetchImpl as unknown as FetchLike,
    );
    expect(result).toEqual({ kind: "ok", refresh: "refreshed_cardmarket", price: priceJson });
    expect(cardPriceRefreshApiPath(CARD_ID)).toBe(`/api/cards/${CARD_ID}/price-refresh`);
    const call = callAt(asMock(fetchImpl), 0);
    expect(call.input).toBe(`/api/cards/${CARD_ID}/price-refresh`);
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(call.init.body))).toEqual({ language: "EN", variant: "holo" });
  });

  it("maps 429 to a cooldown with retryAfterMs / nextAllowedAt from the body", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: "cooldown", retryAfterMs: 125_000, nextAllowedAt: "2026-06-01T12:05:00.000Z" },
        429,
      )) as FetchLike;
    expect(await refreshCardPrice(CARD_ID, {}, fetchImpl)).toEqual({
      kind: "cooldown",
      retryAfterMs: 125_000,
      nextAllowedAt: "2026-06-01T12:05:00.000Z",
    });
  });

  it("falls back to the Retry-After header (seconds) when the 429 body is unreadable", async () => {
    const fetchImpl = (async () =>
      new Response("oops", { status: 429, headers: { "Retry-After": "90" } })) as FetchLike;
    expect(await refreshCardPrice(CARD_ID, {}, fetchImpl)).toEqual({
      kind: "cooldown",
      retryAfterMs: 90_000,
      nextAllowedAt: null,
    });
  });

  it("maps 503 to unavailable and the other statuses to dedicated kinds", async () => {
    const statusKind = async (status: number): Promise<string> =>
      (await refreshCardPrice(CARD_ID, {}, (async () => jsonResponse({}, status)) as FetchLike))
        .kind;
    expect(await statusKind(503)).toBe("unavailable");
    expect(await statusKind(401)).toBe("unauthorized");
    expect(await statusKind(403)).toBe("forbidden");
    expect(await statusKind(404)).toBe("not-found");
    expect(await statusKind(400)).toBe("invalid");
    expect(await statusKind(413)).toBe("invalid");
    expect(await statusKind(500)).toBe("error");
  });

  it("reports an error on network failure and on a malformed 200 body (never throws)", async () => {
    const failing = (async () => {
      throw new TypeError("network down");
    }) as FetchLike;
    expect((await refreshCardPrice(CARD_ID, {}, failing)).kind).toBe("error");
    const badKind = (async () => jsonResponse({ kind: "weird", price: priceJson })) as FetchLike;
    expect((await refreshCardPrice(CARD_ID, {}, badKind)).kind).toBe("error");
    const badPrice = (async () =>
      jsonResponse({ kind: "degraded", price: { nope: true } })) as FetchLike;
    expect((await refreshCardPrice(CARD_ID, {}, badPrice)).kind).toBe("error");
  });

  it("keeps the degraded outcome (last known price served)", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ kind: "degraded", price: priceJson })) as FetchLike;
    const result = await refreshCardPrice(CARD_ID, {}, fetchImpl);
    expect(result).toEqual({ kind: "ok", refresh: "degraded", price: priceJson });
  });
});
