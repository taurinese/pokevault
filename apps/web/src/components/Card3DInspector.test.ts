import { readFileSync } from "node:fs";
import { CardAspectRatio, type HoloEffect } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fr } from "../i18n/fr.ts";
import { HOLO_PRESETS } from "../lib/card-3d-physics.ts";
import { Card3DInspector, type Card3DInspectorCard } from "./Card3DInspector.tsx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noop = () => undefined;

const baseCard: Card3DInspectorCard = {
  cardId: "sv03.5-199",
  name: "Dracaufeu ex",
  setLabel: "SV03.5",
  numberLabel: "199/165",
  rarity: "Illustration Spéciale Rare",
  holoEffect: "sir",
  types: ["Feu"],
  imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
};

const PRESET_EXPECTED_LABELS: Readonly<Record<HoloEffect, string>> = {
  none: fr["inspector3d.preset.none"],
  holo: fr["inspector3d.preset.holo"],
  reverse: fr["inspector3d.preset.reverse"],
  ex: fr["inspector3d.preset.ex"],
  sir: fr["inspector3d.preset.sir"],
  tera: fr["inspector3d.preset.tera"],
  gold: fr["inspector3d.preset.gold"],
};

// ---------------------------------------------------------------------------
// Tests SSR (`renderToStaticMarkup`)
// ---------------------------------------------------------------------------

describe("Card3DInspector", () => {
  it("ne rend rien lorsque open = false", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, { open: false, card: baseCard, onClose: noop }),
    );
    expect(html).toBe("");
  });

  it("rend une modale plein écran accessible avec image high.webp et ratio 63/88", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, { open: true, card: baseCard, onClose: noop }),
    );

    expect(html).toContain("<dialog ");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Inspecteur 3D de Dracaufeu ex"');
    expect(html).toContain('data-halo-tone="fire"');
    expect(html).toContain("Dracaufeu ex");
    expect(html).toContain("SV03.5 · 199/165");

    // Haute résolution TCGdex (~300 Ko)
    expect(html).toContain('src="https://assets.tcgdex.net/fr/sv/sv03.5/199/high.webp"');

    // Ratio officiel strict 63/88
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);

    // Bouton Fermer avec cible tactile >= 44x44
    expect(html).toContain('data-testid="card3d-close"');
    expect(html).toContain('aria-label="Fermer l&#x27;inspecteur 3D"');
    expect(html).toContain("min-width:var(--touch-target-min)");
    expect(html).toContain("min-height:var(--touch-target-min)");

    // Verso SVG intégré sans asset réseau externe
    expect(html).toContain('data-testid="card3d-back-svg"');
    expect(html).toContain('aria-label="Verso officiel de la carte Pokémon"');
  });

  it("affiche un fallback propre lorsque imageBaseUrl est null", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: { ...baseCard, imageBaseUrl: null },
        onClose: noop,
      }),
    );
    expect(html).toContain('data-testid="card3d-image-fallback"');
    expect(html).toContain(fr["inspector3d.card.fallback"]);
    expect(html).not.toContain("/high.webp");
  });

  it.each(HOLO_PRESETS)("rend correctement le preset foil '%s' et son libellé FR", (preset) => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: { ...baseCard, holoEffect: preset },
        onClose: noop,
      }),
    );
    expect(html).toContain(`data-holo-preset="${preset}"`);
    expect(html).toContain(`data-holo-enabled="true"`);
    expect(html).toContain(PRESET_EXPECTED_LABELS[preset]);
  });

  it("supporte le toggle Holo désactivé pour inspecter l'artwork brut", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: baseCard,
        onClose: noop,
        initialHoloEnabled: false,
      }),
    );
    expect(html).toContain('data-holo-enabled="false"');
    const holoBtn = html.match(/<button[^>]*data-testid="card3d-toggle-holo"[^>]*>/)?.[0] ?? "";
    expect(holoBtn).toContain('aria-pressed="false"');
    expect(holoBtn).toContain('data-active="false"');
  });

  it("supporte l'état retourné (flipped = true)", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: baseCard,
        onClose: noop,
        initialFlipped: true,
      }),
    );
    expect(html).toContain('data-flipped="true"');
    const flipBtn = html.match(/<button[^>]*data-testid="card3d-toggle-flip"[^>]*>/)?.[0] ?? "";
    expect(flipBtn).toContain('aria-pressed="true"');
    expect(flipBtn).toContain('data-active="true"');
  });

  it("respecte reducedMotion = true (attributs + indice adapté)", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: baseCard,
        onClose: noop,
        reducedMotion: true,
      }),
    );
    expect(html).toContain('data-reduced-motion="true"');
    expect(html).toContain(fr["inspector3d.hint.reducedMotion"]);
  });

  it("rend controlsSlot dans la barre de contrôles (prêt pour le bouton Gyroscope de T10.2)", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: baseCard,
        onClose: noop,
        controlsSlot: h(
          "button",
          { type: "button", "data-testid": "card3d-gyro-slot" },
          "Gyroscope",
        ),
      }),
    );
    expect(html).toContain('data-testid="card3d-gyro-slot"');
    expect(html).toContain("Gyroscope");
  });

  it("adapte le halo radial au preset foil lorsqu'aucun type Pokémon n'est présent", () => {
    const html = renderToStaticMarkup(
      h(Card3DInspector, {
        open: true,
        card: { ...baseCard, types: [], holoEffect: "tera" },
        onClose: noop,
      }),
    );
    expect(html).toContain('data-halo-tone="tera"');
  });
});

// ---------------------------------------------------------------------------
// Vérifications d'hygiène statique (conventions AGENTS.md)
// ---------------------------------------------------------------------------

describe("Card3DInspector — hygiène statique & CSS", () => {
  const componentSource = readFileSync(new URL("./Card3DInspector.tsx", import.meta.url), "utf8");
  const physicsSource = readFileSync(new URL("../lib/card-3d-physics.ts", import.meta.url), "utf8");
  const cssSource = readFileSync(new URL("../styles/card-3d.css", import.meta.url), "utf8");

  it("ne contient aucune couleur hex brute dans Card3DInspector.tsx ni dans le HTML rendu", () => {
    expect(componentSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const html = renderToStaticMarkup(
      h(Card3DInspector, { open: true, card: baseCard, onClose: noop }),
    );
    // Ignore les entités HTML numériques (ex. &#x27;).
    const htmlWithoutEntities = html.replace(/&#x[0-9a-fA-F]+;/g, "");
    expect(htmlWithoutEntities).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("ne contient aucun @ts-ignore, any explicite ni assertion non-nulle '!'", () => {
    for (const source of [componentSource, physicsSource]) {
      expect(source).not.toMatch(/@ts-ignore|@ts-expect-error/);
      expect(source).not.toMatch(/\b(?:as|:)\s*any\b/);
      // Vérifie l'absence d'assertion non-nulle TypeScript (ex. `foo!.bar`, `foo!`, `ref.current!`).
      expect(source).not.toMatch(/[)\w]!\s*(?:\.|\[|;|,|\)|$)/m);
    }
  });

  it("définit les 7 presets foil, la 3D matérielle, le flip 180° et prefers-reduced-motion dans card-3d.css", () => {
    expect(cssSource).toContain("perspective: 1000px");
    expect(cssSource).toContain("transform-style: preserve-3d");
    expect(cssSource).toContain("backface-visibility: hidden");
    expect(cssSource).toContain("rotateY(180deg)");
    expect(cssSource).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssSource).toContain('data-holo-enabled="false"');
    for (const preset of HOLO_PRESETS) {
      expect(cssSource).toContain(`data-holo-preset="${preset}"`);
    }
  });
});
