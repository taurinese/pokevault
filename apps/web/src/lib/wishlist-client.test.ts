import { generateCardmarketAddCardList, generateCardmarketCsv } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  AGING_MAX_AGE_MS,
  acquireWishlistItem,
  addWishlistItem,
  computeWishlistFreshness,
  countWishlistTabs,
  DEFAULT_EXPORT_OPTIONS,
  deleteWishlistItem,
  effectiveWishlistPriceCents,
  FRESH_MAX_AGE_MS,
  fetchWishlist,
  filterWishlistItems,
  isWishlistBelowThreshold,
  summarizeWishlist,
  toCardmarketExportEntries,
  toExportFilters,
  updateWishlistItem,
  WISHLIST_API_PATH,
  type WishlistEnrichedItem,
  wishlistAcquireApiPath,
  wishlistItemApiPath,
  wishlistSetOptions,
} from "./wishlist-client.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

let counter = 0;
const item = (overrides: Partial<WishlistEnrichedItem> = {}): WishlistEnrichedItem => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    userId: "11111111-1111-4111-8111-111111111111",
    cardId: `sv03.5-${counter}`,
    language: "FR",
    variant: "normal",
    minCondition: "NM",
    priority: "normal",
    targetPriceCents: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    localId: String(counter),
    nameFr: `Carte ${counter}`,
    nameEn: `Card ${counter}`,
    rarity: null,
    imageBaseUrl: null,
    setId: "sv03.5",
    setCode: "SV03.5",
    cardmarketSetCode: "MEW",
    setNameFr: "151",
    trendCents: null,
    lowFrCents: null,
    avg30Cents: null,
    priceSource: null,
    priceFetchedAt: null,
    priceExpiresAt: null,
    priceIsFresh: null,
    ...overrides,
  };
};

const priced = (cents: number, overrides: Partial<WishlistEnrichedItem> = {}) =>
  item({
    lowFrCents: cents,
    priceSource: "cardmarket",
    priceFetchedAt: minutesAgo(1),
    priceIsFresh: true,
    ...overrides,
  });

describe("effectiveWishlistPriceCents", () => {
  it("prefers the lowest FR price, then the trend, then the 30-day average", () => {
    expect(
      effectiveWishlistPriceCents(item({ lowFrCents: 100, trendCents: 200, avg30Cents: 300 })),
    ).toBe(100);
    expect(effectiveWishlistPriceCents(item({ trendCents: 200, avg30Cents: 300 }))).toBe(200);
    expect(effectiveWishlistPriceCents(item({ avg30Cents: 300 }))).toBe(300);
    expect(effectiveWishlistPriceCents(item())).toBeNull();
  });

  it("keeps a legitimate 0 cent price instead of falling through (nullish, not falsy)", () => {
    expect(effectiveWishlistPriceCents(item({ lowFrCents: 0, trendCents: 200 }))).toBe(0);
  });
});

describe("isWishlistBelowThreshold", () => {
  it("is true when the current price is at or under the target", () => {
    expect(isWishlistBelowThreshold(priced(1200, { targetPriceCents: 1500 }))).toBe(true);
    expect(isWishlistBelowThreshold(priced(1500, { targetPriceCents: 1500 }))).toBe(true);
  });

  it("is false above the target, without a target or without a price", () => {
    expect(isWishlistBelowThreshold(priced(1501, { targetPriceCents: 1500 }))).toBe(false);
    expect(isWishlistBelowThreshold(priced(100))).toBe(false);
    expect(isWishlistBelowThreshold(item({ targetPriceCents: 1500 }))).toBe(false);
  });

  it("treats a 0 cent target as a real target", () => {
    expect(isWishlistBelowThreshold(priced(0, { targetPriceCents: 0 }))).toBe(true);
    expect(isWishlistBelowThreshold(priced(1, { targetPriceCents: 0 }))).toBe(false);
  });
});

describe("computeWishlistFreshness", () => {
  it("is `missing` without any price", () => {
    expect(computeWishlistFreshness(item(), NOW)).toBe("missing");
    expect(
      computeWishlistFreshness(
        item({ priceSource: "cardmarket", priceFetchedAt: minutesAgo(1) }),
        NOW,
      ),
    ).toBe("missing");
  });

  it("is `fresh` under 15 minutes for the Cardmarket source", () => {
    expect(computeWishlistFreshness(priced(100), NOW)).toBe("fresh");
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: minutesAgo(14.9) }), NOW)).toBe(
      "fresh",
    );
  });

  it("is `aging` from 15 minutes up to 6 hours (boundaries included)", () => {
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: minutesAgo(15) }), NOW)).toBe(
      "aging",
    );
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: minutesAgo(120) }), NOW)).toBe(
      "aging",
    );
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: minutesAgo(360) }), NOW)).toBe(
      "aging",
    );
    expect(FRESH_MAX_AGE_MS).toBe(15 * 60_000);
    expect(AGING_MAX_AGE_MS).toBe(6 * 60 * 60_000);
  });

  it("is `stale` beyond 6 hours", () => {
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: minutesAgo(361) }), NOW)).toBe(
      "stale",
    );
  });

  it("is always `stale` (indicative) for the TCGdex fallback, even when recent", () => {
    expect(
      computeWishlistFreshness(
        priced(100, { priceSource: "tcgdex_fallback", priceFetchedAt: minutesAgo(1) }),
        NOW,
      ),
    ).toBe("stale");
  });

  it("is `stale` for an unreadable date and ignores a clock skew into the future", () => {
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: "nope" }), NOW)).toBe("stale");
    expect(computeWishlistFreshness(priced(100, { priceFetchedAt: minutesAgo(-5) }), NOW)).toBe(
      "fresh",
    );
  });
});

describe("summarizeWishlist", () => {
  it("sums the effective prices, counts unpriced items and below-threshold items", () => {
    const summary = summarizeWishlist([
      priced(1000, { targetPriceCents: 1500 }),
      item({ trendCents: 250 }),
      item(),
      priced(5000, { targetPriceCents: 100 }),
    ]);
    expect(summary).toEqual({
      totalCount: 4,
      pricedCount: 3,
      unpricedCount: 1,
      estimatedTotalCents: 6250,
      belowThresholdCount: 1,
    });
  });

  it("handles an empty wishlist", () => {
    expect(summarizeWishlist([])).toEqual({
      totalCount: 0,
      pricedCount: 0,
      unpricedCount: 0,
      estimatedTotalCents: 0,
      belowThresholdCount: 0,
    });
  });
});

describe("filters", () => {
  const a = priced(1000, {
    targetPriceCents: 1500,
    priority: "high",
    setId: "sv03.5",
    setNameFr: "151",
  });
  const b = priced(2000, {
    targetPriceCents: 1500,
    setId: "sv08",
    setNameFr: "Étincelles Déferlantes",
  });
  const c = item({ priority: "high", setId: "sv08", setNameFr: "Étincelles Déferlantes" });
  const all = [a, b, c];

  it("filters by tab", () => {
    expect(filterWishlistItems(all, { tab: "all", setId: null })).toEqual(all);
    expect(filterWishlistItems(all, { tab: "below_threshold", setId: null })).toEqual([a]);
    expect(filterWishlistItems(all, { tab: "high_priority", setId: null })).toEqual([a, c]);
  });

  it("combines tab and set filters", () => {
    expect(filterWishlistItems(all, { tab: "high_priority", setId: "sv08" })).toEqual([c]);
    expect(filterWishlistItems(all, { tab: "below_threshold", setId: "sv08" })).toEqual([]);
    expect(filterWishlistItems(all, { tab: "all", setId: "sv08" })).toEqual([b, c]);
  });

  it("counts the tab badges independently of the active filter", () => {
    expect(countWishlistTabs(all)).toEqual({ all: 3, below_threshold: 1, high_priority: 2 });
  });

  it("lists the present sets sorted by French name with their item count", () => {
    expect(wishlistSetOptions(all)).toEqual([
      { id: "sv03.5", nameFr: "151", count: 1 },
      { id: "sv08", nameFr: "Étincelles Déferlantes", count: 2 },
    ]);
    expect(wishlistSetOptions([])).toEqual([]);
  });
});

describe("toCardmarketExportEntries (wishlist → @pokevault/domain generators)", () => {
  const dracaufeu = priced(1400, {
    cardId: "sv03.5-199",
    localId: "199",
    nameFr: "Dracaufeu ex",
    nameEn: "Charizard ex",
    variant: "holo",
    language: "EN",
    minCondition: "EX",
    targetPriceCents: 1500,
    priority: "high",
    trendCents: 1700,
  });

  it("maps every export field, with currentPriceCents = effective price", () => {
    expect(toCardmarketExportEntries([dracaufeu])).toEqual([
      {
        cardId: "sv03.5-199",
        localId: "199",
        nameFr: "Dracaufeu ex",
        nameEn: "Charizard ex",
        setId: "sv03.5",
        setCode: "SV03.5",
        cardmarketSetCode: "MEW",
        setNameFr: "151",
        language: "EN",
        variant: "holo",
        minCondition: "EX",
        priority: "high",
        targetPriceCents: 1500,
        currentPriceCents: 1400,
      },
    ]);
    expect(toCardmarketExportEntries([item()])[0]?.currentPriceCents).toBeNull();
  });

  it("feeds the CSV and Add Card List generators", () => {
    const entries = toCardmarketExportEntries([dracaufeu]);
    const csv = generateCardmarketCsv(entries, undefined, new Date("2026-03-01T00:00:00Z"));
    expect(csv.rowCount).toBe(1);
    expect(csv.content).toBe(
      "qty,name,set_code,number,language,min_condition,foil_only\r\n1,Charizard ex,MEW,199,EN,EX,true\r\n",
    );
    expect(generateCardmarketAddCardList(entries).content).toBe("1 Charizard ex (MEW 199)\n");
  });

  it("honours the below-threshold scope through the converted current price", () => {
    const entries = toCardmarketExportEntries([dracaufeu, priced(9000, { targetPriceCents: 100 })]);
    expect(generateCardmarketCsv(entries, { scope: "below_threshold" }).rowCount).toBe(1);
  });
});

describe("toExportFilters", () => {
  it("maps the defaults to a neutral filter set (no override, no set)", () => {
    expect(toExportFilters(DEFAULT_EXPORT_OPTIONS)).toEqual({
      scope: "all",
      language: "ALL",
      foilOnly: false,
    });
  });

  it("only carries setId for the `set` scope and the override when chosen", () => {
    expect(
      toExportFilters({
        scope: "set",
        setId: "sv08",
        language: "FR",
        minConditionOverride: "LP",
        foilOnly: true,
      }),
    ).toEqual({
      scope: "set",
      setId: "sv08",
      language: "FR",
      minConditionOverride: "LP",
      foilOnly: true,
    });
    expect(
      toExportFilters({ ...DEFAULT_EXPORT_OPTIONS, scope: "high_priority", setId: "sv08" }),
    ).not.toHaveProperty("setId");
  });
});

// ---------------------------------------------------------------------------
// Fetch typé
// ---------------------------------------------------------------------------

const respond = (status: number, body?: unknown): Response =>
  new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("paths", () => {
  it("builds encoded item paths", () => {
    expect(WISHLIST_API_PATH).toBe("/api/wishlist");
    expect(wishlistItemApiPath("a b")).toBe("/api/wishlist/a%20b");
    expect(wishlistAcquireApiPath("abc")).toBe("/api/wishlist/abc/acquire");
  });
});

describe("fetchWishlist", () => {
  it("returns the items on 200", async () => {
    const items = [item()];
    const fetchImpl = vi.fn(async () => respond(200, { items }));
    const result = await fetchWishlist(undefined, fetchImpl);
    expect(result).toEqual({ kind: "ok", items });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/wishlist",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("maps 401 to unauthorized, other statuses and malformed payloads to error", async () => {
    expect(await fetchWishlist(undefined, async () => respond(401, {}))).toEqual({
      kind: "unauthorized",
    });
    expect(await fetchWishlist(undefined, async () => respond(503, {}))).toEqual({ kind: "error" });
    expect(await fetchWishlist(undefined, async () => respond(200, { nope: 1 }))).toEqual({
      kind: "error",
    });
    expect(
      await fetchWishlist(undefined, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ kind: "error" });
  });

  it("rethrows an aborted request so callers can ignore it", async () => {
    await expect(
      fetchWishlist(undefined, async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("mutations", () => {
  it("addWishlistItem POSTs JSON and returns the item on 201", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => respond(201, { id: "x" }));
    const result = await addWishlistItem({ cardId: "sv03.5-199", priority: "high" }, fetchImpl);
    expect(result).toEqual({ kind: "ok", body: { id: "x" } });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/wishlist");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ cardId: "sv03.5-199", priority: "high" });
  });

  it("maps error statuses to typed results", async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [400, "invalid"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [413, "too-large"],
      [500, "error"],
    ];
    for (const [status, kind] of cases) {
      expect(await addWishlistItem({ cardId: "x" }, async () => respond(status, {}))).toEqual({
        kind,
      });
    }
    expect(
      await addWishlistItem({ cardId: "x" }, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ kind: "error" });
  });

  it("updateWishlistItem PATCHes the item path", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { id: "i1" }),
    );
    const result = await updateWishlistItem("i1", { targetPriceCents: null }, fetchImpl);
    expect(result.kind).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/wishlist/i1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ targetPriceCents: null });
  });

  it("deleteWishlistItem accepts 204 and surfaces 404", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => respond(204));
    expect(await deleteWishlistItem("i1", fetchImpl)).toEqual({ kind: "ok", body: null });
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(await deleteWishlistItem("i1", async () => respond(404, {}))).toEqual({
      kind: "not-found",
    });
  });

  it("acquireWishlistItem POSTs an (optionally empty) body to /acquire", async () => {
    const payload = { removedWishlistItemId: "i1", copy: { id: "c1" }, setBinderId: null };
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, payload));
    const result = await acquireWishlistItem("i1", undefined, fetchImpl);
    expect(result).toEqual({ kind: "ok", body: payload });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/wishlist/i1/acquire");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(await acquireWishlistItem("i1", {}, async () => respond(409, {}))).toEqual({
      kind: "conflict",
    });
  });
});
