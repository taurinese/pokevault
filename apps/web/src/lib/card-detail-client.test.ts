import { describe, expect, it, vi } from "vitest";
import {
  addCardCopy,
  adjustCardCopyQuantity,
  cardBindersApiPath,
  cardCopiesApiPath,
  cardCopyApiPath,
  cardDetailApiPath,
  defaultVariantFor,
  deleteCardCopy,
  type FetchLike,
  fetchCardDetail,
  formatIsoDate,
  formatPriceCents,
  isSafeHttpsUrl,
  parsePurchasePriceEuros,
  purchasePriceEurosToCents,
  setCardInBinder,
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
