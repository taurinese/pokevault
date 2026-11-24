import type { CardLanguage } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import type { BurstInputMode, BurstSetOption, BurstSetupConfig } from "../lib/burst-client.ts";
import {
  type BurstSetupAction,
  type BurstSetupState,
  BurstSetupView,
  burstSetupConfig,
  burstSetupReducer,
  initialBurstSetupState,
  startBurstSetup,
} from "./BurstSetupScreen.tsx";

const set = (overrides: Partial<BurstSetOption> = {}): BurstSetOption => ({
  id: "sv03.5",
  code: "MEV",
  nameFr: "Évolution à Méga-Éclat",
  seriesNameFr: "Écarlate & Violet",
  logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
  officialCount: 198,
  totalCount: 207,
  releaseDate: "2024-01-19",
  ...overrides,
});

const sets = (): ReadonlyArray<BurstSetOption> => [
  set(),
  set({ id: "swsh12", code: "PAF", nameFr: "Défaite Parlante", logoUrl: null }),
];

const readyState = (overrides: Partial<BurstSetupState> = {}): BurstSetupState => ({
  ...initialBurstSetupState(),
  status: "ready",
  sets: sets(),
  ...overrides,
});

const reduce = (state: BurstSetupState, actions: Array<BurstSetupAction>): BurstSetupState =>
  actions.reduce(burstSetupReducer, state);

const render = (state: BurstSetupState, start?: () => void): string =>
  renderToStaticMarkup(
    h(BurstSetupView, {
      state,
      actions: {
        onFilterChange: () => {},
        onSelectSet: () => {},
        onLanguageChange: () => {},
        onVariantChange: () => {},
        onConditionChange: () => {},
        onToggleWishlist: () => {},
        onModeChange: () => {},
        onStart: start ?? (() => {}),
        onEditLot: () => {},
        onRetry: () => {},
        onBack: () => {},
      },
    }),
  );

describe("BurstSetupScreen (08A) · en-tête & étape", () => {
  it("affiche titre, badge d'étape 1/2 et bouton retour de 44px", () => {
    const html = render(readyState());
    expect(html).toContain(fr["burst.title"]);
    expect(html).toContain('data-testid="burst-back"');
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("min-w-[44px]");
    expect(html).toMatch(/Étape 1\/2/);
  });

  it("pré-sélectionne l'extension avec une bordure dorée", () => {
    const html = render(readyState({ selectedSetId: "swsh12" }));
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="burst-set-swsh12"/);
    expect(html).toContain("border-gold bg-gold-soft");
    expect(html).toContain(fr["burst.sets.cards_other"].replace("{count}", "207"));
  });

  it("retombe sur un bloc code quand le logo est absent", () => {
    const html = render(readyState({ selectedSetId: "swsh12" }));
    expect(html).toContain("PAF");
  });

  it("gère chargement, erreur et liste vide", () => {
    expect(render(initialBurstSetupState())).toContain('data-testid="burst-sets-loading"');
    const error = render(readyState({ status: "error" }));
    expect(error).toContain('data-testid="burst-sets-error"');
    expect(error).toContain(fr["burst.sets.retry"]);
    expect(render(readyState({ filter: "zzz" }))).toContain('data-testid="burst-sets-empty"');
  });
});

describe("BurstSetupScreen (08A) · pills langue / variante / état", () => {
  it("affiche les 4 langues avec aria-pressed, FR actif par défaut", () => {
    const html = render(readyState());
    for (const language of ["FR", "EN", "JP", "ZH"] as const) {
      expect(html).toContain(`data-testid="burst-language-${language}"`);
    }
    expect(html.match(/aria-pressed="true"/g)).not.toBeNull();
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="burst-language-FR"/);
  });

  it("sélectionne la variante au clic (aria-pressed) et mentionne l'ajustement auto", () => {
    const state = reduce(readyState(), [
      { type: "set_selected", setId: "sv03.5" },
      { type: "variant_changed", variant: "holo" },
    ]);
    expect(burstSetupConfig(state)?.variant).toBe("holo");
    const html = render(state);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="burst-variant-holo"/);
    // React échappe les apostrophes en entités HTML dans le rendu statique.
    expect(html).toContain(fr["burst.variant.autoHint"].replace(/'/g, "&#x27;"));
  });

  it("sélectionne l'état (NM par défaut, M/EX/GD disponibles)", () => {
    const html = render(readyState());
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="burst-condition-NM"/);
    for (const condition of ["M", "EX", "GD"] as const) {
      expect(html).toContain(`data-testid="burst-condition-${condition}"`);
    }
    const state = reduce(readyState(), [
      { type: "set_selected", setId: "sv03.5" },
      { type: "condition_changed", condition: "GD" },
    ]);
    expect(burstSetupConfig(state)?.condition).toBe("GD");
  });
});

describe("BurstSetupScreen (08A) · switch Wishlist", () => {
  it("est activé par défaut (role=switch, aria-checked=true, nom et description accessibles)", () => {
    const html = render(readyState());
    expect(html).toContain('role="switch"');
    expect(html).toContain('data-testid="burst-wishlist-switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-labelledby="burst-wishlist-label"');
    expect(html).toContain('aria-describedby="burst-wishlist-hint"');
    expect(html).toContain('id="burst-wishlist-label"');
    expect(html).toContain('id="burst-wishlist-hint"');
    expect(html).toContain("min-h-[44px]");
  });

  it("efface un ?setId= inconnu lorsque la liste d'extensions charge", () => {
    const initial = initialBurstSetupState("unknown-set");
    expect(initial.selectedSetId).toBe("unknown-set");
    const loaded = burstSetupReducer(initial, { type: "sets_loaded", sets: sets() });
    expect(loaded.selectedSetId).toBeNull();
    expect(burstSetupConfig(loaded)).toBeNull();
    const known = burstSetupReducer(initialBurstSetupState("sv03.5"), {
      type: "sets_loaded",
      sets: sets(),
    });
    expect(known.selectedSetId).toBe("sv03.5");
  });

  it("bascule OFF au clic et met à jour la config", () => {
    const state = reduce(readyState(), [
      { type: "set_selected", setId: "sv03.5" },
      { type: "wishlist_toggled" },
    ]);
    expect(burstSetupConfig(state)?.removeFromWishlist).toBe(false);
    expect(render(state)).toContain('aria-checked="false"');
  });

  it("précise que seuls les souhaits du triplet langue/variante sont retirés", () => {
    expect(render(readyState())).toContain(fr["burst.wishlist.hint"]);
  });
});

describe("BurstSetupScreen (08A) · mode de saisie", () => {
  it("affiche deux grandes cartes radio, grille par défaut", () => {
    const html = render(readyState());
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="burst-mode-grid"/);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="burst-mode-keypad"/);
    expect(html).toContain(fr["burst.mode.grid.hint"]);
    expect(html).toContain(fr["burst.mode.keypad.hint"]);
  });

  it("sélectionne le pavé # au clic", () => {
    const state = reduce(readyState(), [
      { type: "set_selected", setId: "sv03.5" },
      { type: "mode_changed", mode: "keypad" },
    ]);
    expect(burstSetupConfig(state)?.mode).toBe("keypad");
    expect(render(state)).toMatch(/aria-checked="true"[^>]*data-testid="burst-mode-keypad"/);
  });
});

describe("BurstSetupScreen (08A) · CTA Démarrer la saisie", () => {
  it("est désactivé tant qu'aucune extension n'est sélectionnée", () => {
    const html = render(readyState());
    expect(html).toContain('data-testid="burst-start"');
    expect(html).toContain("disabled=");
    expect(burstSetupConfig(readyState())).toBeNull();
  });

  it("est activé une fois l'extension choisie", () => {
    const state = reduce(readyState(), [{ type: "set_selected", setId: "sv03.5" }]);
    const html = render(state);
    expect(html).not.toContain("disabled");
    expect(burstSetupConfig(state)).toEqual({
      setId: "sv03.5",
      language: "FR",
      variant: "normal",
      condition: "NM",
      removeFromWishlist: true,
      mode: "grid",
    });
  });

  it("appelle onStart avec la configuration exacte au démarrage", () => {
    const onStart = vi.fn();
    const state = reduce(readyState(), [
      { type: "set_selected", setId: "sv03.5" },
      { type: "language_changed", language: "EN" as CardLanguage },
      { type: "variant_changed", variant: "reverse" },
      { type: "condition_changed", condition: "EX" },
      { type: "wishlist_toggled" },
      { type: "mode_changed", mode: "keypad" as BurstInputMode },
    ]);
    startBurstSetup(state, onStart);
    const config: BurstSetupConfig = {
      setId: "sv03.5",
      language: "EN",
      variant: "reverse",
      condition: "EX",
      removeFromWishlist: false,
      mode: "keypad",
    };
    expect(onStart).toHaveBeenCalledExactlyOnceWith(config);
  });

  it("n'appelle pas onStart sans extension sélectionnée", () => {
    const onStart = vi.fn();
    startBurstSetup(readyState(), onStart);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("affiche les réglages courants dans la barre d'action (FR · Normal · NM)", () => {
    const html = render(readyState());
    expect(html).toMatch(/FR · Normal · NM/);
  });

  it("affiche l'étape 2 (récapitulatif + Modifier le lot) après démarrage", () => {
    const state = reduce(readyState(), [
      { type: "set_selected", setId: "sv03.5" },
      { type: "started" },
    ]);
    const html = render(state);
    expect(html).toContain('data-testid="burst-step2"');
    expect(html).toContain('data-testid="burst-edit"');
    expect(html).toContain(fr["burst.step2.edit"]);
    expect(html).toContain(fr["burst.step2.placeholder"]);
  });
});
