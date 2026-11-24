import { CardAspectRatio } from "@pokevault/domain";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BinderGridCard, BinderGridPayload } from "../lib/binder-grid-client.ts";
import {
  BinderGridView,
  type BinderGridViewActions,
  type BinderGridViewState,
} from "./BinderGridScreen.tsx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeCard = (index: number, overrides: Partial<BinderGridCard> = {}): BinderGridCard => ({
  id: `sv03.5-${index}`,
  setId: "sv03.5",
  localId: String(index),
  localIdNumeric: index,
  nameFr: `Carte ${index}`,
  rarity: index % 2 === 0 ? "Commune" : "Rare",
  types: index % 3 === 0 ? ["Feu"] : ["Plante"],
  imageBaseUrl: `https://assets.tcgdex.net/fr/sv/sv03.5/${index}`,
  inWishlist: false,
  totalQuantity: 0,
  languages: [],
  variants: [],
  copies: [],
  ...overrides,
});

const cards: ReadonlyArray<BinderGridCard> = Array.from({ length: 20 }, (_, i) =>
  makeCard(i + 1),
).map((card, index) =>
  index === 0
    ? { ...card, totalQuantity: 1, languages: ["FR" as const], variants: ["normal" as const] }
    : index === 1
      ? {
          ...card,
          totalQuantity: 3,
          languages: ["FR" as const, "EN" as const],
          variants: ["normal" as const, "holo" as const],
          inWishlist: true,
        }
      : index === 2
        ? { ...card, inWishlist: true }
        : card,
);

const setPayload: BinderGridPayload = {
  binder: {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    title: "Prisme Évolutif",
    kind: "set",
    setId: "sv03.5",
    setCode: "SV03.5",
    setNameFr: "Prismatic Evolutions",
    stats: { cardCount: 20, ownedCount: 2, percent: 10, totalCopies: 4, duplicateCardCount: 1 },
  },
  cards,
};

const customPayload: BinderGridPayload = {
  binder: {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    title: "Doublons d'échange",
    kind: "custom",
    setId: null,
    setCode: null,
    setNameFr: null,
    stats: { cardCount: 20, ownedCount: 2, percent: 10, totalCopies: 4, duplicateCardCount: 1 },
  },
  cards,
};

const makeState = (overrides: Partial<BinderGridViewState> = {}): BinderGridViewState => ({
  load: { status: "ready", payload: setPayload },
  quickFilter: "all",
  advanced: {},
  advancedOpen: false,
  ...overrides,
});

const makeActions = (overrides: Partial<BinderGridViewActions> = {}): BinderGridViewActions => ({
  onQuickFilterChange: vi.fn(),
  onAdvancedChange: vi.fn(),
  onResetFilters: vi.fn(),
  onToggleAdvanced: vi.fn(),
  onSelectCard: vi.fn(),
  onRetry: vi.fn(),
  ...overrides,
});

const renderView = async (
  state: BinderGridViewState,
  actions: BinderGridViewActions = makeActions(),
): Promise<string> => {
  const rootRoute = createRootRoute({
    component: () => h(BinderGridView, { state, actions }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/collection",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

const countOccurrences = (html: string, needle: string): number => html.split(needle).length - 1;

// ---------------------------------------------------------------------------
// Écran 03 · Grille Classeur
// ---------------------------------------------------------------------------

describe("BinderGridScreen (03) — en-tête & progression", () => {
  it("top bar dédiée : retour /collection 44px, titre, badge code font-mono, compteur, actions", async () => {
    const html = await renderView(makeState());
    // Bouton retour vers /collection, cible tactile 44×44.
    expect(html).toContain('data-testid="binder-back"');
    expect(html).toContain('href="/collection"');
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("min-w-[44px]");
    expect(html).toContain('aria-label="Retour à la collection"');
    // Titre + badge code extension + nombre de cartes.
    expect(html).toContain("Prisme Évolutif");
    expect(html).toContain('data-testid="binder-set-code"');
    expect(html).toContain("SV03.5");
    expect(html).toContain("font-mono");
    expect(html).toContain("20 cartes");
    // Actions du header : saisie rafale (classeur set), réglages, partage.
    expect(html).toContain('data-testid="binder-burst-link"');
    expect(html).toContain('href="/burst?setId=sv03.5"');
    expect(html).toContain('data-testid="binder-settings"');
    expect(html).toContain('data-testid="binder-share"');
    // Sans callback de partage → bouton désactivé (état discret prêt pour M4).
    expect(html).toMatch(/data-testid="binder-share"[^>]*disabled/);
  });

  it("pas de lien saisie rafale pour un dossier perso (kind custom)", async () => {
    const html = await renderView(makeState({ load: { status: "ready", payload: customPayload } }));
    expect(html).toContain("Doublons d&#x27;échange");
    expect(html).not.toContain('data-testid="binder-burst-link"');
    expect(html).not.toContain('data-testid="binder-set-code"');
  });

  it("barre de progression compacte 1 ligne : % mono doré, barre dorée, possédées/total, doublons", async () => {
    const html = await renderView(makeState());
    expect(html).toContain('data-testid="binder-progress"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="10"');
    expect(html).toMatch(
      /data-testid="binder-percent"[^>]*class="[^"]*font-mono[^"]*tabular-nums[^"]*text-gold/,
    );
    expect(html).toContain("10 %");
    expect(html).toMatch(/data-testid="binder-progress-bar"[^>]*bg-gold-bar/);
    expect(html).toContain('style="width:10%"');
    expect(html).toMatch(/data-testid="binder-owned-count"[^>]*font-mono[^"]*tabular-nums/);
    expect(html).toContain("2 possédées sur 20");
    expect(html).toMatch(/data-testid="binder-duplicates-count"[^>]*font-mono[^"]*tabular-nums/);
    expect(html).toContain("1 doublon");
  });
});

describe("BinderGridScreen (03) — filtres", () => {
  it("barre de filtres rapides horizontale avec aria-pressed et compteurs mono", async () => {
    const html = await renderView(makeState());
    for (const id of ["all", "owned", "missing", "duplicates", "wishlist"]) {
      expect(html).toContain(`data-testid="quick-filter-${id}"`);
    }
    expect(html).toContain('data-testid="quick-filter-all" aria-pressed="true"');
    expect(html).toContain('data-testid="quick-filter-missing" aria-pressed="false"');
    // Compteurs discrets en font-mono tabular-nums : 20 / 2 / 18 / 1 / 2.
    expect(html).toContain("Toutes");
    expect(html).toContain("Possédées");
    expect(html).toContain("Manquantes");
    expect(html).toContain("Doublons");
    expect(html).toContain("Wishlist");
    expect(html).toContain('data-testid="advanced-toggle"');
    expect(html).toContain('aria-expanded="false"');
    // 20 cartes au total, 2 possédées, 18 manquantes, 1 doublon, 2 wishlist.
    const pills = html.match(/data-testid="quick-filter-[a-z]+"[\s\S]*?<\/button>/g) ?? [];
    expect(pills[0]).toContain(">20</span>");
    expect(pills[1]).toContain(">2</span>");
    expect(pills[2]).toContain(">18</span>");
    expect(pills[3]).toContain(">1</span>");
    expect(pills[4]).toContain(">2</span>");
  });

  it("filtres avancés ouverts : 4 selects (raretés/types du classeur, langues, variantes) + reset", async () => {
    const html = await renderView(makeState({ advancedOpen: true }));
    expect(html).toContain('data-testid="advanced-filters"');
    expect(html).toContain('data-testid="advanced-toggle" aria-expanded="true"');
    for (const id of [
      "advanced-rarity",
      "advanced-type",
      "advanced-language",
      "advanced-variant",
    ]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // Facettes extraites du classeur.
    expect(html).toContain('<option value="Commune">Commune</option>');
    expect(html).toContain('<option value="Rare">Rare</option>');
    expect(html).toContain('<option value="Feu">Feu</option>');
    expect(html).toContain('<option value="Plante">Plante</option>');
    expect(html).toContain('<option value="FR">Français (FR)</option>');
    expect(html).toContain('<option value="masterball">Master Ball</option>');
    expect(html).toContain('data-testid="advanced-reset"');
    expect(html).toContain("Réinitialiser les filtres");
  });

  it("filtre rapide « owned » : cartes possédées (totalQuantity >= 1, doublons inclus)", async () => {
    const html = await renderView(makeState({ quickFilter: "owned" }));
    // 1 exemplaire unique (×1) + 1 carte en 3 exemplaires (×3 doré).
    expect(countOccurrences(html, 'data-testid="binder-card"')).toBe(2);
    expect(html).toContain('data-state="owned"');
    expect(html).toContain('data-testid="badge-owned"');
    expect(html).toContain('data-state="duplicate"');
    expect(html).toContain('data-testid="badge-duplicate"');
  });

  it("filtre rapide « duplicates » : badge ×N doré", async () => {
    const html = await renderView(makeState({ quickFilter: "duplicates" }));
    expect(countOccurrences(html, 'data-testid="binder-card"')).toBe(1);
    expect(html).toContain('data-state="duplicate"');
    expect(html).toMatch(/data-testid="badge-duplicate"[^>]*bg-gold-soft[^"]*text-gold/);
    expect(html).toContain("×3");
  });

  it("état vide filtré avec bouton « Réinitialiser les filtres »", async () => {
    const noWishlist = {
      ...setPayload,
      cards: cards.map((card) => ({ ...card, inWishlist: false })),
    };
    const html = await renderView(
      makeState({ load: { status: "ready", payload: noWishlist }, quickFilter: "wishlist" }),
    );
    expect(html).toContain('data-testid="binder-grid-empty"');
    expect(html).toContain("Aucune carte à afficher");
    expect(html).toContain('data-testid="empty-reset"');
    expect(html).toContain("Réinitialiser les filtres");
    expect(countOccurrences(html, 'data-testid="binder-card"')).toBe(0);
  });
});

describe("BinderGridScreen (03) — grille virtualisée 3 colonnes", () => {
  it("repli SSR propre : 6 rangées × 3 = 18 premières cartes sans erreur d'hydratation", async () => {
    const html = await renderView(makeState());
    expect(html).toContain('data-testid="binder-grid"');
    expect(html).toContain('data-testid="binder-grid-scroll"');
    expect(countOccurrences(html, 'data-testid="binder-card"')).toBe(18);
    expect(countOccurrences(html, "grid grid-cols-3")).toBe(6);
  });

  it("chaque carte est un <button> accessible avec ratio 63/88 et vignette low.webp", async () => {
    const html = await renderView(makeState());
    expect(html).toContain("<button");
    expect(html).toContain('data-testid="binder-card"');
    expect(html).toContain('aria-label="Ouvrir la fiche de Carte 1 (n° 1)"');
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).toContain('src="https://assets.tcgdex.net/fr/sv/sv03.5/1/low.webp"');
    // Pied de tuile : #localId en font-mono tabular-nums + nom tronqué 1 ligne.
    expect(html).toMatch(/font-mono text-\[11px\] tabular-nums[^"]*"[^>]*>#1</);
    expect(html).toContain("truncate text-xs font-semibold text-primary");
  });

  it("priority sur les 9 premières cartes (eager), lazy ensuite", async () => {
    const html = await renderView(makeState());
    expect(countOccurrences(html, 'loading="eager"')).toBe(9);
    expect(countOccurrences(html, 'loading="lazy"')).toBe(9);
  });

  it("distinction possédée (×1 discret) / doublon (×N doré) / manquante (atténuée, cadre pointillé)", async () => {
    const html = await renderView(makeState());
    // Possédée : badge ×1 discret.
    expect(html).toMatch(
      /data-testid="badge-owned"[^>]*border-line[^"]*bg-surface-1\/90[^"]*text-secondary/,
    );
    expect(html).toContain("×1");
    // Doublon : badge ×3 doré.
    expect(html).toMatch(/data-testid="badge-duplicate"[^>]*bg-gold-soft[^"]*text-gold/);
    expect(html).toContain("×3");
    // Manquante : atténuée + cadre pointillé discret.
    expect(html).toContain('data-state="missing"');
    expect(html).toContain("opacity-30");
    expect(html).toContain("saturate-0");
    expect(html).toContain("border-dashed");
    // Manquante + wishlist : cœur bleu.
    expect(html).toMatch(/data-testid="badge-wishlist"[^>]*text-accent-blue/);
    expect(html).toContain("Carte en wishlist");
  });

  it("filtre rapide « missing » : 18 cartes manquantes rendues (repli SSR 6 rangées)", async () => {
    const html = await renderView(makeState({ quickFilter: "missing" }));
    expect(countOccurrences(html, 'data-testid="binder-card"')).toBe(18);
    expect(countOccurrences(html, 'data-state="missing"')).toBe(18);
  });
});

describe("BinderGridScreen (03) — états & tokens Dark/Light", () => {
  it("chargement : squelette 3 colonnes 63/88", async () => {
    const html = await renderView(makeState({ load: { status: "loading" } }));
    expect(html).toContain('data-testid="binder-grid-loading"');
    expect(html).toContain('role="status"');
    expect(countOccurrences(html, "aspect-ratio:63 / 88")).toBe(9);
    expect(html).toContain("grid grid-cols-3");
  });

  it("introuvable (404) : notice + retour /collection", async () => {
    const html = await renderView(makeState({ load: { status: "not-found" } }));
    expect(html).toContain('data-testid="binder-grid-not-found"');
    expect(html).toContain("Classeur introuvable");
    expect(html).toContain('data-testid="not-found-back"');
    expect(html).toContain('href="/collection"');
  });

  it("erreur : notice + bouton Réessayer", async () => {
    const html = await renderView(makeState({ load: { status: "error" } }));
    expect(html).toContain('data-testid="binder-grid-error"');
    expect(html).toContain("Classeur indisponible");
    expect(html).toContain('data-testid="binder-retry"');
    expect(html).toContain("Réessayer");
  });

  it("zéro couleur hex brute : uniquement des tokens Dark/Light (bg-canvas, surfaces, lignes, or)", async () => {
    const html = await renderView(makeState({ advancedOpen: true }));
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const token of [
      "bg-canvas",
      "bg-surface-1",
      "bg-surface-2",
      "border-line",
      "text-primary",
      "text-secondary",
      "text-muted",
      "bg-gold-bar",
      "text-gold",
      "bg-gold-soft",
      "text-accent-blue",
    ]) {
      expect(html).toContain(token);
    }
  });
});
