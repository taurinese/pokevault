import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardPayload } from "../lib/dashboard-client.ts";
import {
  DashboardScreen,
  DashboardView,
  type DashboardViewActions,
  type DashboardViewState,
  formatDashboardAge,
} from "./DashboardScreen.tsx";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const isoAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
// fr-FR : séparateurs = espaces insécables fines (\s les couvre).
const NBSP = "\\s";

const featuredCard = {
  cardId: "sv03.5-199",
  name: "Dracaufeu ex",
  setCode: "SV03.5",
  setName: "151",
  localId: "199",
  imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  quantity: 2,
  language: "FR" as const,
  variant: "holo" as const,
  unitPriceCents: 77100,
  delta30dPercent: 10.1,
  priceSource: "cardmarket" as const,
  priceFetchedAt: isoAgo(5),
  priceExpiresAt: isoAgo(-10),
};

const setBinder = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "151",
  kind: "set" as const,
  setCode: "SV03.5",
  coverType: "card" as const,
  coverLogoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo",
  coverCardImageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
  coverCustomUrl: null,
  ownedCount: 58,
  totalCards: 100,
  completionPercent: 58,
  estimatedValueCents: 154200,
  isShared: true,
};

const customBinder = {
  id: "44444444-4444-4444-8444-444444444444",
  title: "Mes favoris",
  kind: "custom" as const,
  setCode: null,
  coverType: "upload" as const,
  coverLogoUrl: null,
  coverCardImageUrl: null,
  coverCustomUrl: "/api/binders/44444444-4444-4444-8444-444444444444/cover?v=2026-02-28",
  ownedCount: 5,
  totalCards: 12,
  completionPercent: 42,
  estimatedValueCents: 3200,
  isShared: false,
};

const alert = {
  alertId: "55555555-5555-4555-8555-555555555555",
  cardId: "sv03.5-199",
  cardName: "Dracaufeu ex",
  triggeredPriceCents: 77100,
  thresholdCents: 80000,
  triggeredAt: isoAgo(120),
};

const fullPayload = (): DashboardPayload => ({
  summary: {
    totalValueCents: 154200,
    delta30dPercent: 10.1,
    globalFreshness: "fresh",
    priceFetchedAt: isoAgo(5),
    ownedCardsCount: 3,
    globalCompletionPercent: 58,
  },
  featuredCards: [featuredCard],
  binders: [setBinder, customBinder],
  latestAlert: alert,
});

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

const noopActions: DashboardViewActions = {
  onRetry: () => {},
  onOpenCard: () => {},
  onCloseCard: () => {},
};

const renderView = (state: Partial<DashboardViewState> = {}): string =>
  renderToStaticMarkup(
    h(DashboardView, {
      state: {
        data: { status: "ready", data: fullPayload() },
        nowMs: NOW,
        sheetCardId: null,
        sheetCardName: null,
        ...state,
      },
      actions: noopActions,
    }),
  );

/** Extrait la balise ouvrante portant un `data-testid` donné. */
const tagOf = (html: string, testId: string): string => {
  const match = new RegExp(`<([a-z0-9]+)([^>]*data-testid="${testId}"[^>]*)>`).exec(html);
  return match === null ? "" : match[0];
};

// ---------------------------------------------------------------------------
// Rendu SSR de la vue
// ---------------------------------------------------------------------------

describe("DashboardView (renderToStaticMarkup)", () => {
  it("renders the compact header with theme toggle and 44px account link", () => {
    const html = renderView();
    expect(html).toContain('data-testid="dashboard-account-link"');
    expect(html).toContain('href="/account"');
    const accountTag = tagOf(html, "dashboard-account-link");
    expect(accountTag).toContain("min-width:var(--touch-target-min)");
    expect(accountTag).toContain("min-height:var(--touch-target-min)");
    expect(html).toContain("Accueil");
  });

  it("renders loading skeleton and error notice states", () => {
    const loading = renderView({ data: { status: "loading" } });
    expect(loading).toContain('data-testid="dashboard-skeleton"');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('data-ratio="63/88"');

    const error = renderView({ data: { status: "error" } });
    expect(error).toContain('data-testid="dashboard-error"');
    expect(error).toContain("Réessayer");
  });

  it("renders the 1-line summary bar: freshness dot, real relative age, value, delta, gauge, count", () => {
    const html = renderView();
    expect(tagOf(html, "dashboard-freshness-dot")).toContain('data-freshness="fresh"');
    expect(html).toMatch(/data-testid="dashboard-freshness-age"[^>]*>\s*il y a 5 min/);
    const valueTag = tagOf(html, "dashboard-total-value");
    expect(valueTag).toContain("tabular-nums");
    expect(html).toMatch(
      new RegExp(`data-testid="dashboard-total-value"[^>]*>1${NBSP}542,00${NBSP}€`),
    );
    expect(tagOf(html, "dashboard-delta")).not.toBe("");
    expect(html).toMatch(new RegExp(`\\+10,1${NBSP}%`));
    expect(html).toMatch(new RegExp(`data-testid="dashboard-completion"[^>]*>58${NBSP}%`));
    expect(html).toMatch(/data-testid="dashboard-owned-count"[^>]*>.*?3.*?3 cartes possédées/);
    expect(html).toContain('role="progressbar"');
  });

  it("marks stale/fallback freshness as indicatif", () => {
    const html = renderView({
      data: {
        status: "ready",
        data: {
          ...fullPayload(),
          summary: {
            ...fullPayload().summary,
            globalFreshness: "stale",
            priceFetchedAt: isoAgo(120),
          },
        },
      },
    });
    expect(tagOf(html, "dashboard-freshness-dot")).toContain('data-freshness="stale"');
    expect(html).toContain("il y a 2 h");
    expect(html).toContain("· indicatif");
    expect(html).not.toContain("+ · indicatif");
  });

  it("renders featured cards at strict 63/88 ratio with quantity badge, set/number, price and delta", () => {
    const html = renderView();
    const cardTag = tagOf(html, "dashboard-featured-card");
    expect(cardTag).toContain('data-card-id="sv03.5-199"');
    expect(html).toContain('data-ratio="63/88"');
    expect(html).toMatch(/style="[^"]*aspect-ratio:/);
    expect(html).toMatch(/data-testid="dashboard-featured-quantity"[^>]*>×2</);
    expect(html).toContain("SV03.5 · 199");
    expect(html).toMatch(new RegExp(`data-testid="dashboard-featured-price"[^>]*>771,00${NBSP}€`));
    expect(html).toMatch(new RegExp(`data-testid="dashboard-featured-delta"[^>]*>\\+10,1${NBSP}%`));
    expect(html).toContain("https://assets.tcgdex.net/fr/sv/sv03.5/199/low.webp");
    // Chiffres en font-mono tabular-nums.
    for (const id of ["dashboard-featured-price", "dashboard-featured-quantity"]) {
      expect(tagOf(html, id)).toContain("tabular-nums");
    }
  });

  it("renders an elegant empty state for featured cards with CTAs to /search and /collection", () => {
    const html = renderView({
      data: { status: "ready", data: { ...fullPayload(), featuredCards: [] } },
    });
    expect(html).toContain('data-testid="dashboard-featured-empty"');
    expect(html).toContain('href="/search"');
    expect(html).toContain('href="/collection"');
  });

  it("renders binder cards (cover 1 image) with code, percent, gauge, value and /binder/$id links", () => {
    const html = renderView();
    expect(html).toContain('data-testid="dashboard-binders-grid"');
    expect(html).toContain(`href="/binder/${setBinder.id}"`);
    expect(html).toContain(`href="/binder/${customBinder.id}"`);
    expect(html).toMatch(/58\/100/);
    expect(html).toMatch(/5\/12/);
    expect(html).toMatch(
      new RegExp(`data-testid="dashboard-binder-value"[^>]*>1${NBSP}542,00${NBSP}€`),
    );
    expect(html).toContain("SV03.5");
    expect(html).toContain('data-testid="dashboard-binder-shared"');
    expect(html).toContain("Partagé");
    expect(html).toContain("Privé");
    // Cover uploadée résolue via le proxy + cover carte en ratio 63/88.
    expect(html).toContain(encodeURI(customBinder.coverCustomUrl ?? ""));
    expect(html).toContain("https://assets.tcgdex.net/fr/sv/sv03.5/199/low.webp");
    expect(html).toContain('data-ratio="63/88"');
    expect(html).toContain('href="/collection"');
  });

  it("renders an empty binders state with a CTA to /collection", () => {
    const html = renderView({ data: { status: "ready", data: { ...fullPayload(), binders: [] } } });
    expect(html).toContain('data-testid="dashboard-binders-empty"');
    expect(html).toContain('href="/collection"');
  });

  it("renders the triggered alert banner (emerald tokens) with price vs threshold and relative age", () => {
    const html = renderView();
    const bannerTag = tagOf(html, "dashboard-alert");
    expect(bannerTag).toContain("border-success/40");
    expect(bannerTag).toContain("bg-success/10");
    expect(html).toMatch(/Alerte déclenchée sur Dracaufeu ex/);
    expect(html).toMatch(new RegExp(`771,00${NBSP}€ constaté · seuil 800,00${NBSP}€`));
    expect(html).toContain("Déclenchée il y a 2 h");
    expect(html).toContain('data-testid="dashboard-alert-open-card"');
    expect(html).toContain('href="/alerts"');
  });

  it("renders a discreet invite banner when no alert was triggered (never a false claim)", () => {
    const html = renderView({
      data: { status: "ready", data: { ...fullPayload(), latestAlert: null } },
    });
    expect(html).toContain('data-testid="dashboard-alert-empty"');
    expect(html).toContain("Aucune alerte prix déclenchée pour le moment.");
    expect(html).toContain('href="/alerts"');
    expect(html).not.toContain('data-testid="dashboard-alert"');
  });

  it("opens the existing CardDetailSheet when a featured card is selected", () => {
    const html = renderView({ sheetCardId: featuredCard.cardId, sheetCardName: featuredCard.name });
    expect(html).toMatch(/<h2[^>]*>Dracaufeu ex<\/h2>/);
  });

  it("renders the full empty dashboard (missing prices, no cards, no binders, no alert)", () => {
    const html = renderView({ data: { status: "ready", data: emptyPayload() } });
    expect(tagOf(html, "dashboard-freshness-dot")).toContain('data-freshness="missing"');
    expect(html).toMatch(new RegExp(`data-testid="dashboard-total-value"[^>]*>0,00${NBSP}€`));
    expect(html).not.toContain('data-testid="dashboard-delta"');
    expect(html).toContain('data-testid="dashboard-featured-empty"');
    expect(html).toContain('data-testid="dashboard-binders-empty"');
    expect(html).toContain('data-testid="dashboard-alert-empty"');
  });

  it("DashboardScreen renders the loading shell without crashing (SSR)", () => {
    const html = renderToStaticMarkup(h(DashboardScreen));
    expect(html).toContain('data-testid="dashboard-skeleton"');
    expect(html).toContain("max-w-md");
    expect(html).toContain("pb-40");
  });
});

// ---------------------------------------------------------------------------
// Hygiène design : zéro couleur brute, 100 % tokens Dark & Light
// ---------------------------------------------------------------------------

describe("DashboardScreen — source", () => {
  const source = readFileSync(new URL("./DashboardScreen.tsx", import.meta.url), "utf-8");

  it("contains no raw hex color, no rgb()/hsl(), no dark: variant", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bhsla?\(/);
    expect(source).not.toMatch(/\bdark:/);
  });

  it("uses only design-token utilities (Dark & Light via tokens.css)", () => {
    for (const tokenClass of [
      "bg-surface-1",
      "bg-surface-2",
      "border-line",
      "text-primary",
      "text-secondary",
      "text-muted",
      "text-gold",
      "bg-gold-bar",
      "rounded-sheet",
      "rounded-card",
      "rounded-pill",
      "shadow-card",
    ]) {
      expect(source).toContain(tokenClass);
    }
  });

  it("uses tabular-nums on numeric displays and the strict 63/88 ratio", () => {
    expect(source).toContain("tabular-nums");
    expect(source).toContain("CardAspectRatio");
    expect(source).toContain('data-ratio="63/88"');
  });
});

// ---------------------------------------------------------------------------
// Âge relatif formaté
// ---------------------------------------------------------------------------

describe("formatDashboardAge", () => {
  it("maps structured ages to French labels", () => {
    expect(formatDashboardAge(null)).toBeNull();
    expect(formatDashboardAge({ kind: "just_now" })).toBe("À l'instant");
    expect(formatDashboardAge({ kind: "minutes", count: 5 })).toBe("il y a 5 min");
    expect(formatDashboardAge({ kind: "hours", count: 2 })).toBe("il y a 2 h");
    expect(formatDashboardAge({ kind: "days", count: 1 })).toBe("il y a 1 j");
    expect(formatDashboardAge({ kind: "days", count: 4 })).toBe("il y a 4 j");
  });
});
