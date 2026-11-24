import { readFileSync } from "node:fs";
import { type BurstImportReport, CardAspectRatio } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import type {
  ApiResult,
  BurstCatalogCard,
  BurstSetCardsPayload,
  BurstSetupConfig,
} from "../lib/burst-client.ts";
import {
  type BurstScreenAction,
  type BurstScreenState,
  BurstSessionView,
  type BurstSessionViewActions,
  burstScreenReducer,
  initialBurstScreenState,
  requestBurstExit,
  submitBurstLot,
} from "./BurstSessionScreen.tsx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BINDER_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const config: BurstSetupConfig = {
  setId: "sv03.5",
  language: "FR",
  variant: "normal",
  condition: "NM",
  removeFromWishlist: true,
  mode: "grid",
};

const card = (overrides: Partial<BurstCatalogCard> = {}): BurstCatalogCard => ({
  id: "sv03.5-25",
  localId: "025",
  localIdNumeric: 25,
  nameFr: "Pikachu",
  rarity: "Commune",
  imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/025",
  availableVariants: ["normal", "reverse"],
  holoEffect: "none",
  ownedQuantity: 0,
  ...overrides,
});

const payload = (overrides: Partial<BurstSetCardsPayload> = {}): BurstSetCardsPayload => ({
  set: {
    id: "sv03.5",
    code: "MEV",
    nameFr: "Évolution à Méga-Éclat",
    officialCount: 198,
    totalCount: 207,
    logoUrl: null,
  },
  cards: [
    card({
      id: "sv03.5-1",
      localId: "001",
      localIdNumeric: 1,
      nameFr: "Bulbizarre",
      ownedQuantity: 2,
    }),
    card(),
    card({
      id: "sv03.5-100",
      localId: "100",
      localIdNumeric: 100,
      nameFr: "Évoli",
      rarity: "Rare Holo",
      availableVariants: ["holo"],
      holoEffect: "holo",
    }),
    card({
      id: "sv03.5-GG01",
      localId: "GG01",
      localIdNumeric: null,
      nameFr: "Galerie Mewtwo",
      availableVariants: ["normal", "holo", "pokeball"],
      ownedQuantity: 998,
    }),
  ],
  binderId: BINDER_ID,
  ...overrides,
});

const loaded = (overrides: Partial<BurstScreenState> = {}): BurstScreenState => ({
  ...initialBurstScreenState(config),
  load: { status: "ready", payload: payload() },
  ...overrides,
});

const reduce = (state: BurstScreenState, ...actions: Array<BurstScreenAction>): BurstScreenState =>
  actions.reduce(burstScreenReducer, state);

const noop = () => {};
const actions = (overrides: Partial<BurstSessionViewActions> = {}): BurstSessionViewActions => ({
  onBack: noop,
  onOpenParam: noop,
  onCloseParam: noop,
  onLanguageChange: noop,
  onVariantChange: noop,
  onConditionChange: noop,
  onModeChange: noop,
  onAddCard: noop,
  onRemoveCard: noop,
  onRemoveLine: noop,
  onUndo: noop,
  onKeypadChar: noop,
  onKeypadBackspace: noop,
  onKeypadClear: noop,
  onKeypadVariant: noop,
  onKeypadAdd: noop,
  onValidate: noop,
  onRetryLoad: noop,
  onStay: noop,
  onConfirmLeave: noop,
  onRestart: noop,
  onOpenBinder: noop,
  onOpenCollection: noop,
  ...overrides,
});

const render = (state: BurstScreenState): string =>
  renderToStaticMarkup(h(BurstSessionView, { state, actions: actions() }));

/** React échappe les apostrophes en `&#x27;` dans le rendu statique. */
const esc = (text: string): string => text.replace(/'/g, "&#x27;");

const lineOf = (state: BurstScreenState, key: string) =>
  state.session.lines.find((line) => line.key === key);

const report = (overrides: Partial<BurstImportReport> = {}): BurstImportReport => ({
  totalAddedQuantity: 3,
  distinctCardsCount: 2,
  newCardsCount: 1,
  duplicateCardsCount: 1,
  wishlistRemovedCount: 0,
  adjustedVariantsCount: 0,
  items: [
    {
      cardId: "sv03.5-25",
      language: "FR",
      resolvedVariant: "normal",
      variantAdjusted: false,
      condition: "NM",
      addedQuantity: 2,
      newTotalQuantity: 2,
      wasNewCard: true,
      removedFromWishlist: false,
    },
    {
      cardId: "sv03.5-1",
      language: "FR",
      resolvedVariant: "normal",
      variantAdjusted: false,
      condition: "NM",
      addedQuantity: 1,
      newTotalQuantity: 3,
      wasNewCard: false,
      removedFromWishlist: false,
    },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mode Grille : 1 tap = +1, −, Undo, statuts
// ---------------------------------------------------------------------------

describe("BurstSessionScreen · Grille (08B/08D) : 1 tap = +1", () => {
  it("ajoute 1 exemplaire avec la langue / variante / état courants", () => {
    const state = reduce(loaded(), { type: "card_added", cardId: "sv03.5-25" });
    expect(lineOf(state, "sv03.5-25 FR normal NM")).toMatchObject({ quantity: 1, explicit: false });
    const twice = reduce(state, { type: "card_added", cardId: "sv03.5-25" });
    expect(lineOf(twice, "sv03.5-25 FR normal NM")?.quantity).toBe(2);
    expect(state.session.history).toHaveLength(1);
  });

  it("ignore une carte inconnue ou un catalogue non chargé", () => {
    const unknown = reduce(loaded(), { type: "card_added", cardId: "nope" });
    expect(unknown.session.lines).toEqual([]);
    const loading = reduce(initialBurstScreenState(config), {
      type: "card_added",
      cardId: "sv03.5-25",
    });
    expect(loading.session.lines).toEqual([]);
  });

  it("ajuste automatiquement la variante absente de la carte et préserve la variante demandée pour le commit serveur", () => {
    const state = reduce(loaded(), { type: "card_added", cardId: "sv03.5-100" });
    expect(state.session.lines[0]).toMatchObject({
      key: "sv03.5-100 FR holo NM",
      variant: "holo",
      requestedVariant: "normal",
      explicit: false,
    });
  });

  it("plafonne à 999 (possédé inclus) et signale la limite sans toucher au lot ni à l'Undo", () => {
    // GG01 : 998 déjà possédés → un seul ajout possible.
    const once = reduce(loaded(), { type: "card_added", cardId: "sv03.5-GG01" });
    expect(once.session.lines[0]?.quantity).toBe(1);
    expect(once.notice).toBeNull();
    const twice = reduce(once, { type: "card_added", cardId: "sv03.5-GG01" });
    expect(twice.session).toBe(once.session);
    expect(twice.notice).toBe("cap");
    expect(render(twice)).toContain(fr["burst.session.notice.cap"]);
    // Un ajout réussi efface la notice.
    expect(reduce(twice, { type: "card_added", cardId: "sv03.5-25" }).notice).toBeNull();
  });

  it("le bouton − retire le dernier ajout de la carte ; Undo annule exactement", () => {
    let state = reduce(
      loaded(),
      { type: "card_added", cardId: "sv03.5-25" },
      { type: "variant_changed", variant: "reverse" },
      { type: "card_added", cardId: "sv03.5-25" },
    );
    expect(state.session.lines.map((line) => line.variant)).toEqual(["normal", "reverse"]);
    state = reduce(state, { type: "card_removed", cardId: "sv03.5-25" });
    expect(state.session.lines.map((line) => line.variant)).toEqual(["normal"]);
    state = reduce(state, { type: "undo" });
    expect(state.session.lines.map((line) => line.variant)).toEqual(["normal", "reverse"]);
    state = reduce(state, { type: "undo" }, { type: "undo" });
    expect(state.session.lines).toEqual([]);
    expect(reduce(state, { type: "undo" })).toEqual(state);
  });

  it("rend les tuiles : 3 colonnes, ratio 63/88, low.webp lazy, aucun − tant que le lot est vide", () => {
    const html = render(loaded());
    expect(html).toContain('data-testid="burst-grid-scroll"');
    expect(html).toContain("grid-cols-3");
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).toContain("https://assets.tcgdex.net/fr/sv/sv03.5/025/low.webp");
    expect(html).toContain('decoding="async"');
    expect(html).toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html.match(/data-testid="burst-card"/g)).toHaveLength(4);
    expect(html).not.toContain('data-testid="burst-card-minus"');
    expect(html).toContain(
      fr["burst.grid.card.add"].replace("{name}", "Pikachu").replace("{localId}", "025"),
    );
  });

  it("charge les miniatures sous la ligne de flottaison en lazy (gros set de 250 cartes)", () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      card({
        id: `sv03.5-${index + 1}`,
        localId: String(index + 1).padStart(3, "0"),
        localIdNumeric: index + 1,
        nameFr: `Carte ${index + 1}`,
        imageBaseUrl: `https://assets.tcgdex.net/fr/sv/sv03.5/${index + 1}`,
      }),
    );
    const html = render(loaded({ load: { status: "ready", payload: payload({ cards: many }) } }));
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('loading="eager"');
    // Virtualisation : seules les premières rangées sont rendues, jamais les 250 tuiles.
    expect(html.match(/data-testid="burst-card"/g)?.length).toBeLessThan(40);
  });

  it("nouvelle carte : bordure verte, badge Nouvelle, +N et bouton − accessible", () => {
    const state = reduce(
      loaded(),
      { type: "card_added", cardId: "sv03.5-25" },
      { type: "card_added", cardId: "sv03.5-25" },
    );
    const html = render(state);
    expect(html).toMatch(/data-card-id="sv03.5-25" data-status="new"/);
    expect(html).toContain("border-success");
    expect(html).toContain('data-testid="burst-badge-new"');
    expect(html).toContain(fr["burst.grid.card.new"]);
    expect(html).toMatch(/data-testid="burst-badge-count"[^>]*>\+(?:<!-- -->)?2</);
    expect(html).toContain('data-testid="burst-card-minus"');
    expect(html).toContain(fr["burst.grid.card.minus"].replace("{name}", "Pikachu"));
    expect(html).toContain("min-h-11");
    expect(html).toContain("min-w-11");
  });

  it("doublon : bordure or, badge +N, sans badge Nouvelle", () => {
    const state = reduce(loaded(), { type: "card_added", cardId: "sv03.5-1" });
    const html = render(state);
    expect(html).toMatch(/data-card-id="sv03.5-1" data-status="duplicate"/);
    expect(html).toContain("border-gold");
    expect(html).toContain("bg-gold text-canvas");
    expect(html).not.toContain('data-testid="burst-badge-new"');
  });

  it("signale discrètement l'ajustement automatique de variante sur la tuile", () => {
    const html = render(loaded());
    expect(html).toContain('data-testid="burst-badge-auto"'); // Évoli : normal → Holo
    expect(html).toContain(
      fr["burst.grid.card.autoVariant"].replace("{variant}", fr["burst.variant.holo"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Paramètres à la volée et bascule de mode
// ---------------------------------------------------------------------------

describe("BurstSessionScreen · paramètres à la volée", () => {
  it("affiche les pills Langue ▾ / Variante ▾ / État ▾ avec les valeurs courantes", () => {
    const html = render(loaded());
    for (const param of ["language", "variant", "condition"]) {
      expect(html).toContain(`data-testid="burst-param-${param}"`);
    }
    expect(html).toContain(
      fr["burst.session.param.aria"]
        .replace("{label}", fr["burst.language.label"])
        .replace("{value}", "FR"),
    );
    expect(html).toContain(
      fr["burst.session.param.aria"]
        .replace("{label}", fr["burst.variant.label"])
        .replace("{value}", "Normal"),
    );
    expect(html).toContain(
      fr["burst.session.param.aria"]
        .replace("{label}", fr["burst.condition.label"])
        .replace("{value}", "NM"),
    );
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("change un paramètre sans effacer les items déjà dans le lot (Undo conservé)", () => {
    const before = reduce(loaded(), { type: "card_added", cardId: "sv03.5-25" });
    const after = reduce(
      before,
      { type: "param_sheet_opened", param: "language" },
      { type: "language_changed", language: "EN" },
      { type: "variant_changed", variant: "reverse" },
      { type: "condition_changed", condition: "EX" },
    );
    expect(after.session).toBe(before.session);
    expect(after.paramSheet).toBeNull();
    expect([after.language, after.variant, after.condition]).toEqual(["EN", "reverse", "EX"]);
    const next = reduce(after, { type: "card_added", cardId: "sv03.5-25" });
    expect(next.session.lines.map((line) => line.key)).toEqual([
      "sv03.5-25 FR normal NM",
      "sv03.5-25 EN reverse EX",
    ]);
  });

  it("ouvre la feuille de choix avec les 4 langues / 6 variantes / 7 états", () => {
    const language = render(loaded({ paramSheet: "language" }));
    for (const value of ["FR", "EN", "JP", "ZH"]) {
      expect(language).toContain(`data-testid="burst-option-language-${value}"`);
    }
    const variant = render(loaded({ paramSheet: "variant", variant: "holo" }));
    for (const value of ["normal", "reverse", "holo", "promo", "pokeball", "masterball"]) {
      expect(variant).toContain(`data-testid="burst-option-variant-${value}"`);
    }
    expect(variant).toMatch(/aria-pressed="true"[^>]*data-testid="burst-option-variant-holo"/);
    expect(variant).toContain(fr["burst.variant.pokeball"]);
    expect(variant).toContain(fr["burst.variant.masterball"]);
    const condition = render(loaded({ paramSheet: "condition" }));
    for (const value of ["M", "NM", "EX", "GD", "LP", "PL", "PO"]) {
      expect(condition).toContain(`data-testid="burst-option-condition-${value}"`);
    }
  });
});

describe("BurstSessionScreen · bascule Grille ↔ Pavé #", () => {
  it("préserve intégralement le lot (items, quantités, variantes/langues/états, Undo)", () => {
    const grid = reduce(
      loaded(),
      { type: "card_added", cardId: "sv03.5-25" },
      { type: "language_changed", language: "JP" },
      { type: "variant_changed", variant: "reverse" },
      { type: "condition_changed", condition: "GD" },
      { type: "card_added", cardId: "sv03.5-1" },
    );
    const keypad = reduce(grid, { type: "mode_changed", mode: "keypad" });
    expect(keypad.mode).toBe("keypad");
    expect(keypad.session).toBe(grid.session);
    const back = reduce(keypad, { type: "mode_changed", mode: "grid" });
    expect(back.session).toBe(grid.session);
    expect(back.session.history).toHaveLength(2);
    expect(back.session.lines.map((line) => line.key)).toEqual([
      "sv03.5-25 FR normal NM",
      "sv03.5-1 JP reverse GD",
    ]);
    // Le lot saisi en grille apparaît dans le ruban du pavé #.
    const html = render(keypad);
    expect(html).toContain('data-testid="burst-keypad"');
    expect(html.match(/data-testid="burst-ribbon-chip"/g)).toHaveLength(2);
  });

  it("affiche le toggle (Grille / Pavé #) avec aria-pressed", () => {
    const grid = render(loaded());
    expect(grid).toMatch(/aria-pressed="true"[^>]*data-testid="burst-mode-toggle-grid"/);
    expect(grid).toMatch(/aria-pressed="false"[^>]*data-testid="burst-mode-toggle-keypad"/);
    expect(grid).toContain(fr["burst.session.mode.grid"]);
    expect(grid).toContain(fr["burst.session.mode.keypad"]);
    const keypad = render(loaded({ mode: "keypad" }));
    expect(keypad).toMatch(/aria-pressed="true"[^>]*data-testid="burst-mode-toggle-keypad"/);
    expect(keypad).not.toContain('data-testid="burst-grid-scroll"');
  });

  it("démarre dans le mode choisi à l'étape 1", () => {
    expect(initialBurstScreenState({ ...config, mode: "keypad" }).mode).toBe("keypad");
  });
});

// ---------------------------------------------------------------------------
// Mode Pavé numéros # (08C)
// ---------------------------------------------------------------------------

const typed = (state: BurstScreenState, text: string): BurstScreenState =>
  [...text].reduce(
    (current, char) => burstScreenReducer(current, { type: "keypad_char", char }),
    state,
  );

describe("BurstSessionScreen · Pavé # (08C)", () => {
  const keypad = (overrides: Partial<BurstScreenState> = {}) =>
    loaded({ mode: "keypad", ...overrides });

  it("affiche l'afficheur (#025) et le pavé 1–9, Effacer, 0, ⌫", () => {
    const html = render(typed(keypad(), "025"));
    expect(html).toMatch(/<output[^>]*data-testid="burst-keypad-display"[^>]*>#025<\/output>/);
    expect(html).toContain('data-testid="burst-keypad-preview" aria-live="polite"');
    expect(html).toContain("tabular-nums");
    for (const digit of "0123456789") expect(html).toContain(`data-testid="burst-key-${digit}"`);
    expect(html).toContain(fr["burst.keypad.key.clear"]);
    expect(html).toContain(fr["burst.keypad.key.backspaceSymbol"]);
    expect(html).toContain(`aria-label="${fr["burst.keypad.key.backspace"]}"`);
    expect(html).toContain("min-h-14");
  });

  it("invite à saisir un numéro quand le champ est vide", () => {
    const html = render(keypad());
    expect(html).toContain(fr["burst.keypad.display.empty"]);
    expect(html).toContain(fr["burst.keypad.preview.hint"]);
    expect(html).toMatch(
      /data-testid="burst-keypad-add"[^>]*disabled|disabled=""[^>]*data-testid="burst-keypad-add"/,
    );
  });

  it("aperçu instantané : miniature 63/88, nom, numéro, rareté, statut Nouvelle", () => {
    const html = render(typed(keypad(), "25"));
    expect(html).toContain('data-testid="burst-keypad-thumb"');
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).toContain("Pikachu");
    expect(html).toContain(fr["burst.keypad.preview.number"].replace("{localId}", "025"));
    expect(html).toContain("Commune");
    expect(html).toMatch(/data-status="new"/);
    expect(html).toContain(fr["burst.keypad.preview.new"]);
  });

  it("statut Déjà ×K pour une carte possédée, + quantité déjà dans le lot", () => {
    let state = typed(keypad(), "1");
    expect(render(state)).toContain(fr["burst.keypad.preview.owned"].replace("{count}", "2"));
    state = reduce(state, { type: "keypad_added", quantity: 1 }, ...[]);
    state = typed(state, "001");
    const html = render(state);
    expect(html).toContain(fr["burst.keypad.preview.inBatch"].replace("{count}", "1"));
  });

  it("message clair quand aucune carte ne correspond", () => {
    const html = render(typed(keypad(), "999"));
    expect(html).toContain(fr["burst.keypad.preview.none"].replace("{number}", "999"));
    expect(html).not.toContain('data-testid="burst-keypad-variants"');
  });

  it("matching tolérant : 25 ou 025, et identifiants de promo en lettres (casse ignorée)", () => {
    expect(render(typed(keypad(), "025"))).toContain("Pikachu");
    expect(render(typed(keypad(), "gg01"))).toContain("Galerie Mewtwo");
    expect(render(typed(keypad(), "#25"))).toContain("Pikachu");
  });

  it("plafonne la saisie à 10 caractères, ⌫ et Effacer remettent à zéro", () => {
    let state = typed(keypad(), "123456789012");
    expect(state.keypadInput).toBe("1234567890");
    state = reduce(state, { type: "keypad_backspace" });
    expect(state.keypadInput).toBe("123456789");
    state = reduce(state, { type: "keypad_clear" });
    expect(state.keypadInput).toBe("");
  });

  it("override de variante : pills filtrées sur availableVariants, variante du lot inchangée", () => {
    let state = typed(keypad(), "GG01");
    let html = render(state);
    for (const variant of ["normal", "holo", "pokeball"]) {
      expect(html).toContain(`data-testid="burst-keypad-variant-${variant}"`);
    }
    expect(html).not.toContain('data-testid="burst-keypad-variant-reverse"');
    state = reduce(state, { type: "keypad_variant", variant: "pokeball" });
    html = render(state);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="burst-keypad-variant-pokeball"/);
    expect(state.variant).toBe("normal"); // variante par défaut du lot intacte
    state = reduce(state, { type: "keypad_added", quantity: 1 });
    expect(state.session.lines[0]).toMatchObject({
      key: "sv03.5-GG01 FR pokeball NM",
      explicit: true,
    });
    expect(state.variant).toBe("normal");
  });

  it("présélectionne la variante résolue (ajustement auto) et l'override est réinitialisé au changement de numéro", () => {
    let state = typed(keypad(), "100");
    expect(render(state)).toMatch(
      /aria-pressed="true"[^>]*data-testid="burst-keypad-variant-holo"/,
    );
    state = reduce(state, { type: "keypad_variant", variant: "holo" });
    expect(state.variantOverride).toBe("holo");
    state = typed(state, "1");
    expect(state.variantOverride).toBeNull();
  });

  it("+1 et ×2 ajoutent au lot puis réinitialisent le champ pour enchaîner", () => {
    let state = typed(keypad(), "25");
    state = reduce(state, { type: "keypad_added", quantity: 1 });
    expect(state.keypadInput).toBe("");
    expect(state.variantOverride).toBeNull();
    state = typed(state, "25");
    state = reduce(state, { type: "keypad_added", quantity: 2 });
    expect(lineOf(state, "sv03.5-25 FR normal NM")).toMatchObject({ quantity: 3, explicit: false });
    expect(state.keypadInput).toBe("");
    expect(state.session.history).toHaveLength(2);
  });

  it("n'ajoute rien (et garde le numéro) sans carte correspondante ou au plafond 999", () => {
    const none = reduce(typed(keypad(), "999"), { type: "keypad_added", quantity: 1 });
    expect(none.session.lines).toEqual([]);
    expect(none.keypadInput).toBe("999");
    let capped = typed(keypad(), "GG01");
    capped = reduce(capped, { type: "keypad_added", quantity: 2 }); // 998 + 1 seulement
    expect(capped.session.lines[0]?.quantity).toBe(1);
    expect(capped.notice).toBe("cap");
    capped = typed(capped, "GG01");
    const refused = reduce(capped, { type: "keypad_added", quantity: 1 });
    expect(refused.session).toBe(capped.session);
    expect(refused.keypadInput).toBe("GG01");
  });

  it("expose +1 et ×2 avec libellés accessibles", () => {
    const html = render(typed(keypad(), "25"));
    expect(html).toContain(fr["burst.keypad.add.label"].replace("{name}", "Pikachu"));
    expect(html).toContain(fr["burst.keypad.double.label"].replace("{name}", "Pikachu"));
    expect(html).toContain(">+1<");
    expect(html).toContain(">×2<");
  });

  it("ruban horizontal des derniers ajouts, du plus récent au plus ancien, avec × accessible", () => {
    let state = keypad();
    state = reduce(state, { type: "card_added", cardId: "sv03.5-25" });
    state = reduce(
      state,
      { type: "variant_changed", variant: "reverse" },
      { type: "card_added", cardId: "sv03.5-1" },
    );
    const html = render(state);
    expect(html).toContain(fr["burst.ribbon.label"]);
    expect(html.indexOf("#001 ×1 · Reverse")).toBeGreaterThan(-1);
    expect(html.indexOf("#001 ×1 · Reverse")).toBeLessThan(html.indexOf("#025 ×1 · Normal"));
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain(
      fr["burst.ribbon.remove"]
        .replace("{name}", "Pikachu")
        .replace("{localId}", "025")
        .replace("{variant}", "Normal"),
    );
    const removed = reduce(state, { type: "line_removed", key: "sv03.5-1 FR reverse NM" });
    expect(removed.session.lines.map((line) => line.cardId)).toEqual(["sv03.5-25"]);
    expect(render(keypad())).toContain(esc(fr["burst.ribbon.empty"]));
  });

  it("n'affiche pas le ruban en mode Grille", () => {
    expect(render(loaded())).not.toContain('data-testid="burst-ribbon"');
  });
});

// ---------------------------------------------------------------------------
// Barre de validation, validation POST et confirmation
// ---------------------------------------------------------------------------

describe("BurstSessionScreen · barre de validation flottante", () => {
  it("désactive Undo et Valider tant que le lot est vide (résumé +0 carte · 0 nouvelle)", () => {
    const html = render(loaded());
    expect(html).toMatch(
      /disabled=""[^>]*data-testid="burst-undo"|data-testid="burst-undo"[^>]*disabled/,
    );
    expect(html).toMatch(
      /data-testid="burst-validate"[^>]*disabled|disabled=""[^>]*data-testid="burst-validate"/,
    );
    expect(html).toContain("+0 carte · 0 nouvelle");
    expect(html).toContain(`aria-label="${fr["burst.bar.undo"]}"`);
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  it("résume en direct avec pluriels français : +N cartes · M nouvelles", () => {
    let state = loaded();
    state = reduce(state, { type: "card_added", cardId: "sv03.5-25" });
    expect(render(state)).toContain("+1 carte · 1 nouvelle");
    state = reduce(
      state,
      { type: "card_added", cardId: "sv03.5-25" },
      { type: "card_added", cardId: "sv03.5-1" }, // doublon (déjà possédée)
      { type: "card_added", cardId: "sv03.5-100" },
    );
    const html = render(state);
    expect(html).toContain("+4 cartes · 2 nouvelles");
    expect(html).toMatch(
      /data-testid="burst-summary"[^>]*font-mono|font-mono[^>]*data-testid="burst-summary"/,
    );
    expect(html).not.toMatch(/data-testid="burst-validate"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-testid="burst-undo"[^>]*disabled=""/);
  });

  it("gèle le lot pendant l'envoi : Valider et Undo désactivés, aucun ajout accepté", () => {
    const base = reduce(loaded(), { type: "card_added", cardId: "sv03.5-25" });
    const submitting = reduce(base, { type: "commit_started" });
    expect(render(submitting)).toContain(fr["burst.bar.validating"]);
    expect(render(submitting)).toMatch(/aria-busy="true"/);
    for (const action of [
      { type: "card_added", cardId: "sv03.5-1" },
      { type: "card_removed", cardId: "sv03.5-25" },
      { type: "line_removed", key: "sv03.5-25 FR normal NM" },
      { type: "undo" },
      { type: "keypad_added", quantity: 1 },
    ] as const) {
      expect(burstScreenReducer(submitting, action)).toBe(submitting);
    }
  });
});

describe("BurstSessionScreen · validation POST /api/burst/commit", () => {
  const ok = (data: BurstImportReport): ApiResult<BurstImportReport> => ({ kind: "ok", data });

  const filled = () =>
    reduce(
      loaded({ removeFromWishlist: false }),
      { type: "card_added", cardId: "sv03.5-25" },
      { type: "card_added", cardId: "sv03.5-25" },
      { type: "language_changed", language: "EN" },
      { type: "variant_changed", variant: "reverse" },
      { type: "card_added", cardId: "sv03.5-1" },
    );

  const run = async (
    state: BurstScreenState,
    commit: Parameters<typeof submitBurstLot>[1],
  ): Promise<BurstScreenState> => {
    let current = state;
    await submitBurstLot(state, commit, (action) => {
      current = burstScreenReducer(current, action);
    });
    return current;
  };

  it("poste setId, items et autoRemoveFromWishlist puis affiche la confirmation (lot vidé)", async () => {
    const commit = vi.fn(async () => ok(report()));
    const final = await run(filled(), commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith({
      defaults: {
        setId: "sv03.5",
        language: "EN",
        variant: "reverse",
        condition: "NM",
        removeFromWishlist: false,
      },
      items: [
        {
          cardId: "sv03.5-25",
          quantity: 2,
          language: "FR",
          variant: "normal",
          condition: "NM",
          variantExplicit: false,
        },
        {
          cardId: "sv03.5-1",
          quantity: 1,
          language: "EN",
          variant: "reverse",
          condition: "NM",
          variantExplicit: false,
        },
      ],
    });
    expect(final.commit).toEqual({ status: "done", report: report() });
    expect(final.session.lines).toEqual([]);
    expect(final.session.history).toEqual([]);
  });

  it("conserve le lot (et l'Undo) après une erreur réseau, session expirée ou rejet", async () => {
    const state = filled();
    for (const [commit, reason] of [
      [async () => ({ kind: "error" }) as const, "generic"],
      [async () => ({ kind: "unauthorized" }) as const, "session"],
      [
        async () => {
          throw new TypeError("network");
        },
        "generic",
      ],
    ] as const) {
      const final = await run(state, commit);
      expect(final.commit).toEqual({ status: "error", reason });
      expect(final.session).toBe(state.session);
      const html = render(final);
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        fr[reason === "session" ? "burst.commit.error.session" : "burst.commit.error.generic"],
      );
      expect(html).not.toMatch(/data-testid="burst-validate"[^>]*disabled=""/);
    }
  });

  it("permet de réessayer après une erreur", async () => {
    const failed = await run(filled(), async () => ({ kind: "error" }));
    const commit = vi.fn(async () => ok(report()));
    const final = await run(failed, commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(final.commit.status).toBe("done");
  });

  it("n'envoie rien pour un lot vide ni pendant un envoi déjà en cours", async () => {
    const commit = vi.fn(async () => ok(report()));
    await run(loaded(), commit);
    await run(reduce(filled(), { type: "commit_started" }), commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("met à jour la possession locale après validation (nouvelle saisie : doublons corrects)", async () => {
    const final = await run(filled(), async () => ok(report()));
    const restarted = reduce(final, { type: "lot_restarted" });
    expect(restarted.commit).toEqual({ status: "idle" });
    expect(restarted.session.lines).toEqual([]);
    // Pikachu possédé ×2 désormais → un nouvel ajout est un doublon, pas une nouvelle carte.
    const next = reduce(restarted, { type: "card_added", cardId: "sv03.5-25" });
    const html = render(next);
    expect(html).toMatch(/data-card-id="sv03.5-25" data-status="duplicate"/);
    expect(html).toContain("+1 carte · 0 nouvelle");
  });

  it("rafraîchit silencieusement le catalogue sans toucher au lot", () => {
    const state = reduce(loaded(), { type: "card_added", cardId: "sv03.5-25" });
    const refreshed = reduce(state, {
      type: "cards_refreshed",
      payload: payload({ binderId: "other" }),
    });
    expect(refreshed.session).toBe(state.session);
    expect(refreshed.load.status === "ready" && refreshed.load.payload.binderId).toBe("other");
    expect(
      reduce(initialBurstScreenState(config), { type: "cards_refreshed", payload: payload() }).load
        .status,
    ).toBe("loading");
  });
});

describe("BurstSessionScreen · panneau de confirmation", () => {
  const done = (r: BurstImportReport, p: BurstSetCardsPayload = payload()) =>
    loaded({ load: { status: "ready", payload: p }, commit: { status: "done", report: r } });

  it("résume cartes ajoutées, nouvelles et doublons (pluriels), avec les actions de sortie", () => {
    const html = render(done(report()));
    expect(html).toContain('data-testid="burst-done"');
    expect(html).toContain(fr["burst.done.title"]);
    expect(html).toContain("3 exemplaires ajoutés");
    expect(html).toContain("1 nouvelle carte");
    expect(html).toContain("1 doublon");
    expect(html).not.toContain('data-testid="burst-done-wishlist"');
    expect(html).not.toContain('data-testid="burst-done-adjusted"');
    expect(html).toContain(fr["burst.done.again"]);
    expect(html).toContain(fr["burst.done.openBinder"]);
    expect(html).not.toContain('data-testid="burst-validate"');
  });

  it("liste les variantes ajustées automatiquement et les retraits de Wishlist", () => {
    const html = render(
      done(
        report({
          wishlistRemovedCount: 2,
          adjustedVariantsCount: 1,
          items: [
            {
              cardId: "sv03.5-100",
              language: "FR",
              resolvedVariant: "holo",
              variantAdjusted: true,
              condition: "NM",
              addedQuantity: 1,
              newTotalQuantity: 1,
              wasNewCard: true,
              removedFromWishlist: true,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('data-testid="burst-done-adjusted"');
    expect(html).toContain("1 variante ajustée automatiquement");
    expect(html).toContain("Évoli, n° 100 → Holo");
    expect(html).toContain("2 cartes retirées de la Wishlist");
  });

  it("propose « Voir ma collection » quand aucun classeur n'existe encore", () => {
    const html = render(done(report(), payload({ binderId: null })));
    expect(html).toContain('data-testid="burst-done-collection"');
    expect(html).toContain(fr["burst.done.openCollection"]);
    expect(html).not.toContain('data-testid="burst-done-binder"');
  });
});

// ---------------------------------------------------------------------------
// Chargement, erreurs, sortie, accessibilité
// ---------------------------------------------------------------------------

describe("BurstSessionScreen · états et navigation", () => {
  it("gère chargement, erreur (réessayer), extension introuvable et extension vide", () => {
    const loading = render(initialBurstScreenState(config));
    expect(loading).toContain('data-testid="burst-session-loading"');
    expect(loading).not.toContain('data-testid="burst-validate"');
    const failed = render(
      burstScreenReducer(initialBurstScreenState(config), {
        type: "cards_failed",
        reason: "error",
      }),
    );
    expect(failed).toContain('data-testid="burst-session-error"');
    expect(failed).toContain(fr["burst.session.error"]);
    expect(failed).toContain('data-testid="burst-session-retry"');
    const missing = render(
      burstScreenReducer(initialBurstScreenState(config), {
        type: "cards_failed",
        reason: "not-found",
      }),
    );
    expect(missing).toContain(fr["burst.session.notFound"]);
    const empty = render(loaded({ load: { status: "ready", payload: payload({ cards: [] }) } }));
    expect(empty).toContain(fr["burst.session.empty"]);
    const retry = burstScreenReducer(
      burstScreenReducer(initialBurstScreenState(config), {
        type: "cards_failed",
        reason: "error",
      }),
      { type: "cards_loading" },
    );
    expect(retry.load.status).toBe("loading");
  });

  it("quitte directement avec un lot vide, demande confirmation sinon", () => {
    expect(requestBurstExit(loaded())).toBe("exit");
    const filled = reduce(loaded(), { type: "card_added", cardId: "sv03.5-25" });
    expect(requestBurstExit(filled)).toBe("confirm");
    const prompt = reduce(filled, { type: "leave_prompt_opened" });
    const html = render(prompt);
    expect(html).toContain(fr["burst.leave.title"]);
    expect(html).toContain(esc(fr["burst.leave.body_one"].replace("{count}", "1")));
    expect(html).toContain(fr["burst.leave.stay"]);
    expect(html).toContain(fr["burst.leave.confirm"]);
    expect(reduce(prompt, { type: "leave_prompt_closed" }).leavePrompt).toBe(false);
    expect(reduce(prompt, { type: "leave_prompt_closed" }).session).toBe(filled.session);
  });

  it("barre supérieure : bouton retour 44px, titre = extension, compteur discret", () => {
    const html = render(loaded());
    expect(html).toContain("sticky top-0");
    expect(html).toContain('data-testid="burst-session-back"');
    expect(html).toContain(`aria-label="${fr["burst.session.back"]}"`);
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("Évolution à Méga-Éclat");
    expect(html).toContain("MEV · ");
    expect(html).toContain("207 cartes");
    expect(html).toContain("<h1");
  });

  it("n'emploie que des tokens de design (aucune couleur hex brute dans les composants)", () => {
    for (const file of ["BurstSessionScreen.tsx", "BurstGridMode.tsx", "BurstKeypadMode.tsx"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/(?<![\w&$])#[0-9a-fA-F]{3,8}\b(?!\w)/);
      expect(code).not.toMatch(/(?:bg|text|border)-\[#/);
      expect(code).not.toMatch(/\brgba?\(/);
    }
  });
});
