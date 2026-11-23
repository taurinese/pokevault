import { CardAspectRatio } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardTile } from "./CardTile.tsx";

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
    expect(html).toContain('aria-label="Carte possédée : Dracaufeu ex"');
  });

  it("shows a ×N badge in monospace tabular-nums for the duplicate state", () => {
    const html = renderToStaticMarkup(
      h(CardTile, { name: "Pikachu", state: "duplicate", count: 4 }),
    );
    expect(html).toContain("×4");
    expect(html).toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toContain('aria-label="Carte en 4 exemplaires : Pikachu"');
  });

  it("dims and desaturates the missing state with a subtle border", () => {
    const html = renderToStaticMarkup(h(CardTile, { name: "Mew", state: "missing" }));
    expect(html).toContain("saturate-0");
    expect(html).toContain("opacity-30");
    expect(html).toContain("border-line");
    expect(html).toContain('aria-label="Carte manquante : Mew"');
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

  it("renders a clean visual fallback when imageUrl is absent", () => {
    const html = renderToStaticMarkup(h(CardTile, { name: "Missingno" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("Visuel indisponible");
    expect(html).toContain("bg-surface-2");
  });
});
