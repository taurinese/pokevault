import { describe, expect, it } from "vitest";
import {
  AGING_MAX_AGE_MS,
  computeDelta30dPercent,
  computePriceFreshness,
  computeRelativeAge,
  type DashboardPayload,
  FRESH_MAX_AGE_MS,
  fetchDashboard,
  formatCount,
  formatDeltaPercent,
  formatPercent,
  formatPriceCents,
  isDashboardEmpty,
} from "./dashboard-client.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const isoAgo = (ms: number): string => new Date(NOW - ms).toISOString();

// ---------------------------------------------------------------------------
// Fraîcheur
// ---------------------------------------------------------------------------

describe("computePriceFreshness", () => {
  it("returns missing when no card has a price", () => {
    expect(computePriceFreshness({ hasPrice: false, source: null, fetchedAt: null }, NOW)).toBe(
      "missing",
    );
  });

  it("returns stale for a fallback source or an unreadable date, even with a price", () => {
    expect(
      computePriceFreshness(
        { hasPrice: true, source: "tcgdex_fallback", fetchedAt: isoAgo(1000) },
        NOW,
      ),
    ).toBe("stale");
    expect(
      computePriceFreshness({ hasPrice: true, source: "cardmarket", fetchedAt: null }, NOW),
    ).toBe("stale");
    expect(
      computePriceFreshness({ hasPrice: true, source: "cardmarket", fetchedAt: "not-a-date" }, NOW),
    ).toBe("stale");
  });

  it("returns fresh under 15 min, aging until 6 h, stale beyond", () => {
    const cardmarket = (msAgo: number) =>
      computePriceFreshness(
        { hasPrice: true, source: "cardmarket", fetchedAt: isoAgo(msAgo) },
        NOW,
      );
    expect(cardmarket(0)).toBe("fresh");
    expect(cardmarket(FRESH_MAX_AGE_MS - 1)).toBe("fresh");
    expect(cardmarket(FRESH_MAX_AGE_MS)).toBe("aging");
    expect(cardmarket(AGING_MAX_AGE_MS)).toBe("aging");
    expect(cardmarket(AGING_MAX_AGE_MS + 1)).toBe("stale");
  });

  it("never reports a negative age as fresh-by-clamping", () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(
      computePriceFreshness({ hasPrice: true, source: "cardmarket", fetchedAt: future }, NOW),
    ).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// Variation 30 j
// ---------------------------------------------------------------------------

describe("computeDelta30dPercent", () => {
  it("returns null without a current price or without an avg30 base > 0", () => {
    expect(computeDelta30dPercent(null, 1000)).toBeNull();
    expect(computeDelta30dPercent(1000, null)).toBeNull();
    expect(computeDelta30dPercent(1000, 0)).toBeNull();
  });

  it("computes Math.round(((current - avg30) / avg30) * 1000) / 10", () => {
    expect(computeDelta30dPercent(1100, 1000)).toBe(10);
    expect(computeDelta30dPercent(900, 1000)).toBe(-10);
    expect(computeDelta30dPercent(1042, 1000)).toBe(4.2);
    expect(computeDelta30dPercent(1000, 1000)).toBe(0);
    // 1 centime d'écart sur 1000 = 0,1 % ; un écart de 1/3 % est arrondi à 0,3.
    expect(computeDelta30dPercent(1003, 1000)).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Âge relatif
// ---------------------------------------------------------------------------

describe("computeRelativeAge", () => {
  it("returns null for a missing or unreadable ISO date", () => {
    expect(computeRelativeAge(null, NOW)).toBeNull();
    expect(computeRelativeAge("nope", NOW)).toBeNull();
  });

  it("buckets just_now / minutes / hours / days", () => {
    expect(computeRelativeAge(isoAgo(30_000), NOW)).toEqual({ kind: "just_now" });
    expect(computeRelativeAge(isoAgo(60_000), NOW)).toEqual({ kind: "minutes", count: 1 });
    expect(computeRelativeAge(isoAgo(59 * 60_000), NOW)).toEqual({ kind: "minutes", count: 59 });
    expect(computeRelativeAge(isoAgo(60 * 60_000), NOW)).toEqual({ kind: "hours", count: 1 });
    expect(computeRelativeAge(isoAgo(23 * 60 * 60_000), NOW)).toEqual({ kind: "hours", count: 23 });
    expect(computeRelativeAge(isoAgo(24 * 60 * 60_000), NOW)).toEqual({ kind: "days", count: 1 });
    expect(computeRelativeAge(isoAgo(5 * 24 * 60 * 60_000), NOW)).toEqual({
      kind: "days",
      count: 5,
    });
  });

  it("clamps a future date to just_now", () => {
    expect(computeRelativeAge(new Date(NOW + 5000).toISOString(), NOW)).toEqual({
      kind: "just_now",
    });
  });
});

// ---------------------------------------------------------------------------
// Formatage fr-FR
// ---------------------------------------------------------------------------

describe("formatage fr-FR", () => {
  // fr-FR : séparateur de groupe et espace avant % / € sont des espaces insécables (\s les couvre).
  const norm = (value: string): string => value.replace(/\s/g, " ");
  it("formats a delta percent with sign and one decimal", () => {
    expect(norm(formatDeltaPercent(4.2) ?? "")).toBe("+4,2 %");
    expect(norm(formatDeltaPercent(-1.25) ?? "")).toBe("-1,3 %");
    expect(norm(formatDeltaPercent(0) ?? "")).toBe("0,0 %");
    expect(formatDeltaPercent(null)).toBeNull();
  });

  it("formats counts with fr-FR grouping", () => {
    expect(norm(formatCount(1248))).toBe("1 248");
    expect(formatCount(0)).toBe("0");
  });

  it("formats an integer percent", () => {
    expect(norm(formatPercent(58))).toBe("58 %");
    expect(norm(formatPercent(0))).toBe("0 %");
  });

  it("formats price cents as euros", () => {
    expect(norm(formatPriceCents(140000) ?? "")).toBe("1 400,00 €");
    expect(formatPriceCents(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// État vide
// ---------------------------------------------------------------------------

const emptyPayload = (): DashboardPayload => ({
  summary: {
    totalValueCents: 0,
    delta30dPercent: null,
    globalFreshness: "missing",
    priceFetchedAt: null,
    ownedCardsCount: 0,
    globalCompletionPercent: 0,
  },
  featuredCards: [],
  binders: [],
  latestAlert: null,
});

describe("isDashboardEmpty", () => {
  it("is true only when nothing is owned and nothing is displayed", () => {
    expect(isDashboardEmpty(emptyPayload())).toBe(true);
    expect(
      isDashboardEmpty({
        ...emptyPayload(),
        summary: { ...emptyPayload().summary, ownedCardsCount: 3 },
      }),
    ).toBe(false);
    expect(
      isDashboardEmpty({
        ...emptyPayload(),
        binders: [
          {
            id: "b1",
            title: "Dossier",
            kind: "custom",
            setCode: null,
            coverType: "set_logo",
            coverLogoUrl: null,
            coverCardImageUrl: null,
            coverCustomUrl: null,
            ownedCount: 0,
            totalCards: 0,
            completionPercent: 0,
            estimatedValueCents: 0,
            isShared: false,
          },
        ],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard
// ---------------------------------------------------------------------------

describe("fetchDashboard", () => {
  const fetchOk = async (body: unknown, status = 200): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("returns ok with the payload on 200", async () => {
    const result = await fetchDashboard(undefined, async () => fetchOk(emptyPayload()));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.payload.summary.globalFreshness).toBe("missing");
  });

  it("returns unauthorized on 401", async () => {
    const result = await fetchDashboard(undefined, async () => fetchOk({}, 401));
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("returns error on 503 and on a malformed body", async () => {
    expect((await fetchDashboard(undefined, async () => fetchOk({}, 503))).kind).toBe("error");
    expect((await fetchDashboard(undefined, async () => fetchOk({ nope: true }))).kind).toBe(
      "error",
    );
  });

  it("returns error on a network failure and rethrows an abort", async () => {
    expect(
      (await fetchDashboard(undefined, async () => Promise.reject(new Error("down")))).kind,
    ).toBe("error");
    const abort = new DOMException("aborted", "AbortError");
    await expect(fetchDashboard(undefined, async () => Promise.reject(abort))).rejects.toBe(abort);
  });
});
