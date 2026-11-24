import { CardAspectRatio } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardTile, cardTilePriceLabel } from "./CardTile.tsx";

describe("CardTile", () => {
  it("renders a lazy/async image inside the strict 63/88 ratio with 8px corners", () => {
    const html = renderToStaticMarkup(
      h(CardTile, {
        name: "Dracaufeu ex",
        imageUrl: "https://example.test/card.webp",
        state: "owned",
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="https://example.test/card.webp"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).toContain("rounded-card");
    expect(html).toContain("Carte possédée : Dracaufeu ex");
  });

  it('does not put role="img" on the outer container (future interactive tile)', () => {
    const html = renderToStaticMarkup(h(CardTile, { name: "Dracaufeu ex" }));
    expect(html).not.toContain('role="img"');
  });

  it("shows a ×N badge in monospace tabular-nums for the duplicate state", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", state: "duplicate", count: 4 }),
    );
    expect(html).toContain("×4");
    expect(html).toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("Carte en 4 exemplaires : Pikachu");
  });

  it("treats a duplicate with count < 2 as a single owned copy (no badge)", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", state: "duplicate", count: 1 }),
    );
    expect(html).not.toContain("×1");
    expect(html).toContain("Carte possédée : Pikachu");
  });

  it("dims and desaturates the missing state with a subtle border", () => {
    const html = renderToStaticMarkup(h(CardTile, { name: "Mew", state: "missing" }));
    expect(html).toContain("saturate-0");
    expect(html).toContain("opacity-30");
    expect(html).toContain("border-line");
    expect(html).toContain("Carte manquante : Mew");
  });

  it("shows a gold badge when burstCount is set (saisie rafale)", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "Évoli", state: "owned", burstCount: 12 }),
    );
    expect(html).toContain("+12");
    expect(html).toContain("bg-gold-soft");
    expect(html).toContain("text-gold");
    expect(html).toContain("+12 en saisie rafale");
  });

  it("renders no price pill when no price prop is given (existing callers unchanged)", () => {
    const html = renderToStaticMarkup(h(CardTile, { name: "Pikachu", state: "owned" }));
    expect(html).not.toContain("card-tile-price");
    expect(html).not.toContain("Prix Cardmarket");
    const nullPrice = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", priceCents: null, priceFreshness: "fresh" }),
    );
    expect(nullPrice).not.toContain("card-tile-price");
  });

  it("renders a monospace tabular-nums price pill with a green dot for a fresh price", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", priceCents: 1234, priceFreshness: "fresh" }),
    );
    const pill = html.match(/data-testid="card-tile-price"[^>]*>/)?.[0] ?? "";
    expect(pill).toContain('data-freshness="fresh"');
    expect(html).toContain("12,34");
    expect(html).toContain("font-mono tabular-nums");
    expect(html).toContain("bg-success");
    expect(html).toContain("bottom-1");
    expect(html).toContain("Prix Cardmarket : 12,34");
    expect(html).toContain("À jour");
  });

  it("uses an amber dot for aging and a neutral dot for stale / default freshness", () => {
    const aging = renderToStaticMarkup(
      h(CardTile, { name: "A", priceCents: 500, priceFreshness: "aging" }),
    );
    expect(aging).toContain("bg-warning");
    const stale = renderToStaticMarkup(
      h(CardTile, { name: "A", priceCents: 500, priceFreshness: "stale" }),
    );
    expect(stale).toContain("bg-muted");
    expect(stale).not.toContain("bg-success");
    const fallback = renderToStaticMarkup(h(CardTile, { name: "A", priceCents: 500 }));
    expect(fallback).toContain("bg-muted");
    expect(fallback).toContain('data-freshness="stale"');
  });

  it("supports a price of 0 cents and keeps the strict 63/88 ratio with no raw hex colour", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "A", priceCents: 0, priceFreshness: "fresh" }),
    );
    expect(html).toContain("0,00");
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("exposes the price in the accessible label, with an explicit priceLabel override", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", state: "owned", priceCents: 250, priceFreshness: "aging" }),
    );
    expect(html).toContain("Carte possédée : Pikachu — Prix Cardmarket : 2,50");
    const custom = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", priceCents: 250, priceLabel: "Valeur 2,50 euros" }),
    );
    expect(custom).toContain("Valeur 2,50 euros");
    expect(cardTilePriceLabel(null, "fresh")).toBeNull();
    expect(cardTilePriceLabel(250, "fresh", "X")).toBe("X");
  });

  it("renders a clean visual fallback when imageUrl is absent", () => {
    const html = renderToStaticMarkup(h(CardTile, { name: "Missingno" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("Visuel indisponible");
    expect(html).toContain("bg-surface-2");
  });
});

// Garde-fous de typage : les combinaisons invalides ne compilent pas (vérifié par `pnpm typecheck`).
export const typeChecks = (): void => {
  // @ts-expect-error `duplicate` exige un `count`.
  h(CardTile, { name: "A", state: "duplicate" });
  // @ts-expect-error `missing` n'accepte pas de `count`.
  h(CardTile, { name: "A", state: "missing", count: 3 });
  // @ts-expect-error `owned` n'accepte pas de `count`.
  h(CardTile, { name: "A", state: "owned", count: 3 });
};
