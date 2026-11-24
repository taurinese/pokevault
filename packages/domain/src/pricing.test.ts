import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CardmarketBlockedError,
  CardmarketNetworkError,
  CardmarketParseError,
  computePriceFreshness,
  MAX_PRICE_CENTS,
  PRICE_MANUAL_COOLDOWN_MS,
  PRICE_REFRESH_PRIORITY_RANK,
  PRICE_STALE_AMBER_MS,
  PRICE_TTL_MS,
  PriceBatchReport,
  PriceCircuitOpenError,
  PriceFreshness,
  PriceRefreshCooldownError,
  PriceRefreshPriority,
  PriceRefreshTarget,
  PriceSnapshot,
  PriceSource,
  TcgdexFallbackPrices,
} from "./pricing.ts";

describe("pricing constants", () => {
  it("exposes the TTL / amber / cooldown windows of docs/04 §2.1", () => {
    expect(PRICE_TTL_MS).toBe(15 * 60 * 1000);
    expect(PRICE_STALE_AMBER_MS).toBe(6 * 60 * 60 * 1000);
    expect(PRICE_MANUAL_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});

describe("literal schemas", () => {
  it("decode valid values and reject invalid ones", () => {
    expect(Schema.decodeUnknownSync(PriceSource)("cardmarket")).toBe("cardmarket");
    expect(Schema.decodeUnknownSync(PriceSource)("tcgdex_fallback")).toBe("tcgdex_fallback");
    expect(() => Schema.decodeUnknownSync(PriceSource)("ebay")).toThrow();

    expect(Schema.decodeUnknownSync(PriceFreshness)("fresh")).toBe("fresh");
    expect(Schema.decodeUnknownSync(PriceFreshness)("aging")).toBe("aging");
    expect(Schema.decodeUnknownSync(PriceFreshness)("stale")).toBe("stale");
    expect(Schema.decodeUnknownSync(PriceFreshness)("missing")).toBe("missing");
    expect(() => Schema.decodeUnknownSync(PriceFreshness)("rotten")).toThrow();

    expect(Schema.decodeUnknownSync(PriceRefreshPriority)("active_alert")).toBe("active_alert");
    expect(Schema.decodeUnknownSync(PriceRefreshPriority)("wishlist")).toBe("wishlist");
    expect(Schema.decodeUnknownSync(PriceRefreshPriority)("featured")).toBe("featured");
    expect(() => Schema.decodeUnknownSync(PriceRefreshPriority)("random")).toThrow();
  });

  it("decodes a full PriceSnapshot and a PriceRefreshTarget", () => {
    const snapshot = Schema.decodeUnknownSync(PriceSnapshot)({
      id: 42,
      cardId: "sv03.5-199",
      language: "FR",
      variant: "holo",
      source: "cardmarket",
      trendCents: 12490,
      lowFrCents: 125050,
      avg30Cents: null,
      fetchedAt: "2026-01-01T10:00:00.000Z",
      expiresAt: "2026-01-01T10:15:00.000Z",
      isFresh: true,
    });
    expect(snapshot.trendCents).toBe(12490);
    expect(snapshot.avg30Cents).toBeNull();

    const target = Schema.decodeUnknownSync(PriceRefreshTarget)({
      cardId: "sv03.5-199",
      language: "FR",
      variant: "normal",
      cardmarketUrl: "https://www.cardmarket.com/en/Pokemon/Products/Singles/x",
      priority: "wishlist",
      tcgdexFallback: { trendCents: 100, avg30Cents: null, lowFrCents: 90 },
    });
    expect(target.tcgdexFallback?.trendCents).toBe(100);
    expect(
      Schema.decodeUnknownSync(PriceRefreshTarget)({
        cardId: "sv03.5-199",
        language: "FR",
        variant: "normal",
        cardmarketUrl: null,
        priority: "featured",
      }).tcgdexFallback,
    ).toBeUndefined();

    expect(() =>
      Schema.decodeUnknownSync(PriceSnapshot)({
        id: 1,
        cardId: "x",
        language: "FR",
        variant: "normal",
        source: "cardmarket",
        trendCents: -1,
        lowFrCents: null,
        avg30Cents: null,
        fetchedAt: "2026-01-01T10:00:00.000Z",
        expiresAt: "2026-01-01T10:15:00.000Z",
        isFresh: true,
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(PriceSnapshot)({
        id: 1,
        cardId: "x",
        language: "FR",
        variant: "normal",
        source: "cardmarket",
        trendCents: MAX_PRICE_CENTS + 1,
        lowFrCents: null,
        avg30Cents: null,
        fetchedAt: "2026-01-01T10:00:00.000Z",
        expiresAt: "2026-01-01T10:15:00.000Z",
        isFresh: true,
      }),
    ).toThrow();

    expect(
      Schema.decodeUnknownSync(PriceSnapshot)({
        id: 1,
        cardId: "x",
        language: "FR",
        variant: "normal",
        source: "cardmarket",
        trendCents: MAX_PRICE_CENTS,
        lowFrCents: null,
        avg30Cents: null,
        fetchedAt: "2026-01-01T10:00:00.000Z",
        expiresAt: "2026-01-01T10:15:00.000Z",
        isFresh: true,
      }).trendCents,
    ).toBe(MAX_PRICE_CENTS);
  });

  it("decodes a PriceBatchReport and TcgdexFallbackPrices", () => {
    const report = Schema.decodeUnknownSync(PriceBatchReport)({
      attempted: 30,
      refreshedCardmarket: 20,
      refreshedFallback: 5,
      skippedFresh: 2,
      skippedCooldown: 1,
      skippedCircuitOpen: 0,
      failed: 2,
      circuitOpenUntil: null,
      durationMs: 1234,
    });
    expect(report.attempted).toBe(30);
    expect(
      Schema.decodeUnknownSync(TcgdexFallbackPrices)({
        trendCents: null,
        avg30Cents: 5,
        lowFrCents: 4,
      }),
    ).toEqual({
      trendCents: null,
      avg30Cents: 5,
      lowFrCents: 4,
    });
  });

  it("ranks priorities active_alert < wishlist < featured", () => {
    expect(PRICE_REFRESH_PRIORITY_RANK.active_alert).toBeLessThan(
      PRICE_REFRESH_PRIORITY_RANK.wishlist,
    );
    expect(PRICE_REFRESH_PRIORITY_RANK.wishlist).toBeLessThan(PRICE_REFRESH_PRIORITY_RANK.featured);
  });
});

describe("computePriceFreshness", () => {
  const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const snapshotAt = (ageMs: number, source: "cardmarket" | "tcgdex_fallback" = "cardmarket") => ({
    fetchedAt: iso(nowMs - ageMs),
    expiresAt: iso(nowMs - ageMs + PRICE_TTL_MS),
    source,
  });

  it("returns missing for a null snapshot", () => {
    expect(computePriceFreshness(null, nowMs)).toBe("missing");
  });

  it("returns stale for any tcgdex_fallback source, whatever the age", () => {
    expect(computePriceFreshness(snapshotAt(60_000, "tcgdex_fallback"), nowMs)).toBe("stale");
    expect(computePriceFreshness(snapshotAt(0, "tcgdex_fallback"), nowMs)).toBe("stale");
  });

  it("returns fresh below the 15 min TTL (green dot)", () => {
    expect(computePriceFreshness(snapshotAt(6 * 60_000), nowMs)).toBe("fresh");
    expect(computePriceFreshness(snapshotAt(0), nowMs)).toBe("fresh");
    expect(computePriceFreshness(snapshotAt(PRICE_TTL_MS - 1), nowMs)).toBe("fresh");
  });

  it("returns aging between 15 min and 6 h (amber dot)", () => {
    expect(computePriceFreshness(snapshotAt(PRICE_TTL_MS), nowMs)).toBe("aging");
    expect(computePriceFreshness(snapshotAt(2 * 60 * 60_000), nowMs)).toBe("aging");
    expect(computePriceFreshness(snapshotAt(PRICE_STALE_AMBER_MS), nowMs)).toBe("aging");
  });

  it("returns stale above 6 h (neutral dot)", () => {
    expect(computePriceFreshness(snapshotAt(PRICE_STALE_AMBER_MS + 1), nowMs)).toBe("stale");
    expect(computePriceFreshness(snapshotAt(24 * 60 * 60_000), nowMs)).toBe("stale");
  });

  it("does not report fresh when now reached expiresAt even below the TTL age (clock skew)", () => {
    const skewed = {
      fetchedAt: iso(nowMs - 60_000),
      expiresAt: iso(nowMs - 30_000), // already expired although age < TTL
      source: "cardmarket" as const,
    };
    expect(computePriceFreshness(skewed, nowMs)).toBe("aging");
  });

  it("returns stale on unparseable dates", () => {
    expect(
      computePriceFreshness(
        { fetchedAt: "not-a-date", expiresAt: "nope", source: "cardmarket" },
        nowMs,
      ),
    ).toBe("stale");
  });
});

describe("typed errors", () => {
  it("carry their structured fields", () => {
    const blocked = new CardmarketBlockedError({
      status: 429,
      retryAfterMs: 60_000,
      message: "slow down",
    });
    expect(blocked._tag).toBe("CardmarketBlockedError");
    expect(blocked.status).toBe(429);
    expect(blocked.retryAfterMs).toBe(60_000);

    const parse = new CardmarketParseError({
      cardId: "c1",
      url: "https://www.cardmarket.com/x",
      message: "no price",
    });
    expect(parse._tag).toBe("CardmarketParseError");
    expect(parse.cardId).toBe("c1");

    const network = new CardmarketNetworkError({
      url: "u",
      message: "boom",
      cause: new Error("x"),
    });
    expect(network._tag).toBe("CardmarketNetworkError");

    const cooldown = new PriceRefreshCooldownError({
      cardId: "c1",
      retryAfterMs: 1000,
      nextAllowedAt: "2026-01-01T12:05:00.000Z",
      message: "cooldown",
    });
    expect(cooldown.retryAfterMs).toBe(1000);

    const circuit = new PriceCircuitOpenError({
      openUntil: "2026-01-01T12:15:00.000Z",
      consecutiveBlocks: 2,
      message: "open",
    });
    expect(circuit.consecutiveBlocks).toBe(2);
  });
});
