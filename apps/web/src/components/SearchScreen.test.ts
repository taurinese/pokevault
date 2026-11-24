import { readFileSync } from "node:fs";
import type {
  CardSearchHit,
  SearchDiscoveryPayload,
  SearchQuery,
  SearchResultsPayload,
  SearchSuggestionsPayload,
  SetSearchHit,
} from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type Loadable,
  SearchScreen,
  SearchView,
  type SearchViewActions,
  type SearchViewState,
} from "./SearchScreen.tsx";

const set = (overrides: Partial<SetSearchHit> = {}): SetSearchHit => ({
  id: "sv03.5",
  code: "151",
  nameFr: "151",
  logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
  releaseDate: "2023-09-22",
  officialCount: 165,
  totalCount: 207,
  ...overrides,
});

const card = (overrides: Partial<CardSearchHit> = {}): CardSearchHit => ({
  id: "sv03.5-199",
  setId: "sv03.5",
  setName: "151",
  setCode: "151",
  localId: "199",
  localIdNumeric: 199,
  nameFr: "Dracaufeu ex",
  rarity: "Illustration spéciale rare",
  holoEffect: "sir",
  illustrator: "5ban Graphics",
  imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199/low.webp",
  ...overrides,
});

const discovery: SearchDiscoveryPayload = {
  popularSets: [
    set(),
    set({
      id: "sv08",
      code: "SSP",
      nameFr: "Étincelles Déferlantes",
      totalCount: 252,
      logoUrl: null,
    }),
  ],
  featuredCards: [card(), card({ id: "sv08-238", nameFr: "Pikachu ex", localId: "238" })],
};

const ready = <T>(data: T): Loadable<T> => ({ status: "ready", data });
const query: SearchQuery = {
  q: "dracaufeu",
  scope: "all",
  sort: "relevance",
  limit: 24,
  offset: 0,
};
const resultsPayload = (overrides: Partial<SearchResultsPayload> = {}): SearchResultsPayload => ({
  query,
  totalCards: 2,
  totalSets: 0,
  cards: [card(), card({ id: "sv03.5-006", nameFr: "Dracaufeu", localId: "006", rarity: null })],
  sets: [],
  ...overrides,
});

const noop = (): void => undefined;
const actions: SearchViewActions = {
  onInputChange: noop,
  onSubmit: noop,
  onClearInput: noop,
  onFocus: noop,
  onBlur: noop,
  onEscape: noop,
  onScopeChange: noop,
  onSortChange: noop,
  onViewModeChange: noop,
  onToggleQuickAccess: noop,
  onSelectSet: noop,
  onClearSet: noop,
  onPickRecent: noop,
  onRemoveRecent: noop,
  onClearRecents: noop,
  onPickSuggestedCard: noop,
  onSeeAll: noop,
  onLoadMore: noop,
  onRetry: noop,
  onReset: noop,
  onToggleWishlist: noop,
  onQuickAdd: noop,
};

const baseState: SearchViewState = {
  mode: "neutral",
  input: "",
  scope: "all",
  sort: "relevance",
  viewMode: "grid",
  quickAccess: undefined,
  activeSet: null,
  recents: [],
  discovery: ready(discovery),
  suggestions: { status: "idle" },
  results: { status: "idle" },
  loadingMore: false,
  wishlistIds: new Set(),
  announcement: "",
};

const render = (state: Partial<SearchViewState> = {}): string =>
  renderToStaticMarkup(h(SearchView, { state: { ...baseState, ...state }, actions }));

describe("SearchScreen · en-tête sticky", () => {
  it("rend un champ type=search i18n, une icône, la portée et des pills aria-pressed", () => {
    const html = render();
    expect(html).toContain('data-testid="search-header"');
    expect(html).toContain("sticky top-0");
    expect(html).toContain('type="search"');
    expect(html).toContain('placeholder="Nom, #numéro, extension, illustrateur…"');
    for (const label of ["Tout", "Cartes", "Extensions", "Illustrateurs"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*>Tout</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Cartes</);
  });

  it("n'affiche le bouton effacer (≥ 44px) que si le champ est rempli", () => {
    expect(render()).not.toContain('data-testid="search-clear"');
    const html = render({ input: "pika" });
    expect(html).toContain('data-testid="search-clear"');
    expect(html).toContain('aria-label="Effacer la recherche"');
    expect(html).toContain("size-11");
  });

  it("réserve la place de la pilule flottante et de la safe-area en bas de page", () => {
    const html = render();
    expect(html).toContain("var(--navbar-pill-height)");
    expect(html).toContain("var(--safe-area-inset-bottom)");
  });
});

describe("SearchScreen · 05A état neutre", () => {
  it("affiche extensions populaires, accès rapides et découverte", () => {
    const html = render();
    expect(html).toContain('data-mode="neutral"');
    expect(html).toContain('data-testid="search-neutral"');
    expect(html).toContain("Extensions populaires");
    expect(html).toContain("Accès rapides");
    expect(html).toContain("Découverte");
    expect(html).toContain("Étincelles Déferlantes");
    expect(html).toContain("https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp");
    expect(html).toContain("object-contain");
    for (const label of [
      "SIR / Secrètes",
      "Illustration Rare",
      "Cartes ex",
      "Téracristal",
      "Promos",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("affiche le compteur de cartes d'une extension en monospace tabular-nums", () => {
    const html = render();
    expect(html).toMatch(/<span class="font-mono tabular-nums">207<\/span> cartes/);
  });

  it("replie sur le code de l'extension quand le logo est absent", () => {
    const html = render({
      discovery: ready({ popularSets: [set({ logoUrl: null })], featuredCards: [] }),
    });
    expect(html).toContain("font-bold tabular-nums");
  });

  it("rend les cartes phares en grille 3 colonnes au ratio 63/88", () => {
    const html = render();
    expect(html).toContain("grid-cols-3");
    expect(html).toContain(`aspect-ratio:${63 / 88}`);
    expect(html).toContain("Pikachu ex");
  });

  it("gère chargement, erreur et catalogue vide", () => {
    expect(render({ discovery: { status: "loading" } })).toContain('data-testid="search-skeleton"');
    const error = render({ discovery: { status: "error" } });
    expect(error).toContain('data-testid="discovery-error"');
    expect(error).toContain("Réessayer");
    const empty = render({ discovery: ready({ popularSets: [], featuredCards: [] }) });
    expect(empty).toContain('data-testid="catalog-empty"');
    expect(empty).toContain("Le catalogue est encore vide");
  });

  it("marque l'accès rapide actif avec aria-pressed", () => {
    const html = render({ quickAccess: "sir" });
    expect(html).toMatch(/aria-pressed="true"[^>]*>SIR \/ Secrètes</);
  });
});

describe("SearchScreen · 05B saisie, récentes & suggestions", () => {
  it("liste les recherches récentes, supprimables une à une, avec « Effacer tout »", () => {
    const html = render({ mode: "suggest", recents: ["Dracaufeu", "#199"] });
    expect(html).toContain('data-mode="suggest"');
    expect(html).toContain("Recherches récentes");
    expect(html.match(/data-testid="recent-item"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Retirer « Dracaufeu » de l&#x27;historique"');
    expect(html).toContain("Effacer tout");
  });

  it("affiche un état vide des récentes sans bouton « Effacer tout »", () => {
    const html = render({ mode: "suggest", recents: [] });
    expect(html).toContain("Vos recherches récentes apparaîtront ici.");
    expect(html).not.toContain('data-testid="recents-clear-all"');
  });

  it("regroupe les suggestions en Extensions et Cartes (miniature, #numéro, extension, rareté)", () => {
    const suggestions: SearchSuggestionsPayload = {
      query: "drac",
      cards: [card()],
      sets: [set()],
    };
    const html = render({ mode: "suggest", input: "drac", suggestions: ready(suggestions) });
    expect(html).not.toContain("Recherches récentes");
    expect(html).toContain(">Extensions<");
    expect(html).toContain(">Cartes<");
    expect(html).toContain('data-testid="suggestion-card"');
    expect(html).toContain('data-testid="suggestion-set"');
    expect(html).toContain("Dracaufeu ex");
    expect(html).toContain("Illustration spéciale rare");
    expect(html).toMatch(/<span class="font-mono tabular-nums">#199<\/span>/);
    expect(html).toContain(`aspect-ratio:${63 / 88}`);
    expect(html).toContain("Voir tous les résultats pour « drac »");
  });

  it("gère chargement, absence de suggestion et erreur", () => {
    const loading = render({ mode: "suggest", input: "d", suggestions: { status: "loading" } });
    expect(loading).toContain('data-testid="suggest-loading"');
    const none = render({
      mode: "suggest",
      input: "zzz",
      suggestions: ready({ query: "zzz", cards: [], sets: [] }),
    });
    expect(none).toContain("Aucune suggestion pour « zzz ».");
    expect(render({ mode: "suggest", input: "d", suggestions: { status: "error" } })).toContain(
      'data-testid="suggest-error"',
    );
  });
});

describe("SearchScreen · 05C résultats en liste", () => {
  const html = render({ mode: "results", viewMode: "list", results: ready(resultsPayload()) });

  it("rend des lignes riches : miniature 63/88, nom, extension, numéro et rareté", () => {
    expect(html).toContain('data-view="list"');
    expect(html).toContain('data-testid="results-list"');
    expect(html.match(/data-testid="result-card"/g)).toHaveLength(2);
    expect(html).toContain("Dracaufeu ex");
    expect(html).toContain("151 · 151");
    expect(html).toMatch(/<span class="font-mono tabular-nums">#199<\/span>/);
    expect(html).toContain("Illustration spéciale rare");
    expect(html).toContain(`aspect-ratio:${63 / 88}`);
    expect(html).not.toContain("results-grid");
  });

  it("affiche le compteur pluralisé, le tri rapide et le switcher Grille / Liste", () => {
    expect(html).toMatch(/<span class="font-mono tabular-nums">2<\/span> résultats/);
    for (const label of ["Pertinence", "Numéro", "Nom"])
      expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Pertinence</);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="view-list"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="view-grid"/);
    expect(html).toContain('aria-label="Grille"');
    expect(html).toContain('aria-label="Liste"');
  });

  it("utilise le singulier pour 1 résultat", () => {
    const one = render({
      mode: "results",
      results: ready(resultsPayload({ totalCards: 1, cards: [card()] })),
    });
    expect(one).toMatch(/<span class="font-mono tabular-nums">1<\/span> résultat</);
  });

  it("offre ♥ Wishlist et + Ajout rapide accessibles sur chaque carte", () => {
    expect(html.match(/data-testid="card-wishlist"/g)).toHaveLength(2);
    expect(html.match(/data-testid="card-quick-add"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Ajouter Dracaufeu ex à la wishlist"');
    expect(html).toContain('aria-label="Ajout rapide de Dracaufeu ex"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("reflète une carte déjà en wishlist (aria-pressed + libellé) et annonce les actions", () => {
    const pressed = render({
      mode: "results",
      viewMode: "list",
      results: ready(resultsPayload()),
      wishlistIds: new Set(["sv03.5-199"]),
      announcement: "Dracaufeu ex ajoutée à la wishlist",
    });
    expect(pressed).toContain('aria-label="Retirer Dracaufeu ex de la wishlist"');
    expect(pressed).toMatch(
      /role="status" aria-live="polite"[^>]*>Dracaufeu ex ajoutée à la wishlist</,
    );
  });
});

describe("SearchScreen · 05D résultats en grille", () => {
  const html = render({ mode: "results", viewMode: "grid", results: ready(resultsPayload()) });

  it("rend une grille 3 colonnes de CardTile au ratio 63/88", () => {
    expect(html).toContain('data-view="grid"');
    expect(html).toContain('data-testid="results-grid"');
    expect(html).toContain("grid-cols-3");
    expect(html).toContain(`aspect-ratio:${63 / 88}`);
    expect(html).not.toContain("results-list");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="view-grid"/);
  });

  it("garde les actions rapides en surimpression avec zone tactile étendue", () => {
    expect(html).toContain("after:-inset-1.5");
    expect(html.match(/data-testid="card-wishlist"/g)).toHaveLength(2);
  });

  it("affiche numéros en monospace et propose « Afficher plus » quand la page est incomplète", () => {
    expect(html).toMatch(/font-mono[^>]*tabular-nums[^>]*>#199</);
    expect(html).not.toContain('data-testid="load-more"');
    const partial = render({
      mode: "results",
      results: ready(resultsPayload({ totalCards: 50 })),
    });
    expect(partial).toContain('data-testid="load-more"');
    expect(partial).toContain("Afficher plus de cartes");
  });

  it("liste les extensions correspondantes au-dessus des cartes", () => {
    const withSets = render({
      mode: "results",
      results: ready(resultsPayload({ totalSets: 1, sets: [set()] })),
    });
    expect(withSets).toContain('data-testid="result-set"');
    expect(withSets).toMatch(/<span class="font-mono tabular-nums">3<\/span> résultats/);
  });
});

// ---------------------------------------------------------------------------
// Prix Cardmarket & fraîcheur sur les tuiles / lignes de résultats
// ---------------------------------------------------------------------------

const PRICE_NOW = Date.parse("2026-06-01T12:00:00.000Z");

const searchPrice = (
  minutes: number,
  overrides: Partial<NonNullable<CardSearchHit["price"]>> = {},
): NonNullable<CardSearchHit["price"]> => ({
  trendCents: 1234,
  lowFrCents: 900,
  avg30Cents: 1100,
  source: "cardmarket",
  fetchedAt: new Date(PRICE_NOW - minutes * 60_000).toISOString(),
  expiresAt: new Date(PRICE_NOW - minutes * 60_000 + 15 * 60_000).toISOString(),
  isFresh: minutes < 15,
  ...overrides,
});

const priceResults = (cards: ReadonlyArray<CardSearchHit>): Loadable<SearchResultsPayload> =>
  ready(resultsPayload({ cards, totalCards: cards.length }));

describe("SearchScreen · prix & fraîcheur", () => {
  it("grille 05D : micro-pill prix + pastille verte / ambre / neutre sur chaque tuile", () => {
    const html = render({
      mode: "results",
      viewMode: "grid",
      nowMs: PRICE_NOW,
      results: priceResults([
        card({ id: "a", price: searchPrice(3) }),
        card({ id: "b", price: searchPrice(120) }),
        card({ id: "c", price: searchPrice(60 * 24) }),
      ]),
    });
    expect(html.split('data-testid="card-tile-price"').length - 1).toBe(3);
    expect(html).toContain('data-freshness="fresh"');
    expect(html).toContain('data-freshness="aging"');
    expect(html).toContain('data-freshness="stale"');
    expect(html).toContain("bg-success");
    expect(html).toContain("bg-warning");
    expect(html).toContain("12,34");
    expect(html).toContain("font-mono tabular-nums");
    expect(html).toContain(`aspect-ratio:${63 / 88}`);
  });

  it("n'affiche aucune pill pour une carte sans prix (price null ou absent)", () => {
    const html = render({
      mode: "results",
      viewMode: "grid",
      nowMs: PRICE_NOW,
      results: priceResults([card({ id: "a", price: null }), card({ id: "b" })]),
    });
    expect(html).not.toContain("card-tile-price");
    expect(html).not.toContain("result-price");
  });

  it("liste 05C : prix + pastille en ligne (vignette 56 px trop étroite pour la pill)", () => {
    const html = render({
      mode: "results",
      viewMode: "list",
      nowMs: PRICE_NOW,
      results: priceResults([card({ id: "a", price: searchPrice(3) })]),
    });
    expect(html).toContain('data-testid="result-price"');
    expect(html).toContain('data-freshness="fresh"');
    expect(html).toContain('data-testid="result-price-dot"');
    expect(html).toContain("bg-success");
    expect(html).toContain("12,34");
    expect(html).toContain("Prix Cardmarket : 12,34");
    // La vignette de la liste ne porte pas de pill (pas de doublon visuel).
    expect(html).not.toContain('data-testid="card-tile-price"');
  });

  it("repli TCGdex : pastille neutre même pour un prix récent", () => {
    const html = render({
      mode: "results",
      viewMode: "list",
      nowMs: PRICE_NOW,
      results: priceResults([
        card({ id: "a", price: searchPrice(1, { source: "tcgdex_fallback" }) }),
      ]),
    });
    expect(html).toContain('data-freshness="stale"');
    expect(html).not.toContain("bg-success");
  });

  it("prix absent de la tendance : retombe sur la moyenne 30 j puis le plus bas FR", () => {
    const html = render({
      mode: "results",
      viewMode: "list",
      nowMs: PRICE_NOW,
      results: priceResults([
        card({ id: "a", price: searchPrice(1, { trendCents: null, avg30Cents: 777 }) }),
      ]),
    });
    expect(html).toContain("7,77");
  });

  it("cartes phares du mode neutre : prix aussi branchés", () => {
    const html = render({
      nowMs: PRICE_NOW,
      discovery: ready({
        popularSets: [],
        featuredCards: [card({ id: "a", price: searchPrice(2) })],
      }),
    });
    expect(html).toContain('data-testid="card-tile-price"');
    expect(html).toContain("12,34");
  });

  it("conserve les actions wishlist / ajout rapide avec une tuile pricée", () => {
    const html = render({
      mode: "results",
      viewMode: "grid",
      nowMs: PRICE_NOW,
      results: priceResults([card({ id: "a", price: searchPrice(2) })]),
    });
    expect(html).toContain('data-testid="card-wishlist"');
    expect(html).toContain('data-testid="card-quick-add"');
  });
});

describe("SearchScreen · états de résultats", () => {
  it("affiche un état vide soigné (0 résultat) avec réinitialisation", () => {
    const html = render({
      mode: "results",
      results: ready(resultsPayload({ totalCards: 0, cards: [] })),
    });
    expect(html).toContain('data-testid="results-empty"');
    expect(html).toContain("Aucun résultat");
    expect(html).toContain("Réinitialiser la recherche");
  });

  it("affiche un squelette de chargement accessible", () => {
    const html = render({ mode: "results", results: { status: "loading" } });
    expect(html).toContain('data-testid="results-loading"');
    expect(html).toContain("Chargement des résultats");
    expect(html).toContain('data-testid="search-skeleton"');
    expect(render({ mode: "results", results: { status: "idle" } })).toContain("results-loading");
  });

  it("affiche une erreur avec réessai", () => {
    const html = render({ mode: "results", results: { status: "error" } });
    expect(html).toContain('data-testid="results-error"');
    expect(html).toContain("Recherche indisponible");
    expect(html).toContain("Réessayer");
  });

  it("affiche les filtres actifs (extension, accès rapide) retirables", () => {
    const html = render({
      mode: "results",
      activeSet: { id: "sv03.5", name: "151" },
      quickAccess: "sir",
      results: ready(resultsPayload()),
    });
    expect(html.match(/data-testid="filter-chip"/g)).toHaveLength(2);
    expect(html).toContain("Extension : 151");
    expect(html).toContain('aria-label="Retirer le filtre Extension : 151"');
    expect(html).toContain("SIR / Secrètes");
  });
});

describe("SearchScreen · conteneur", () => {
  it("rend l'état neutre en squelette pendant le rendu serveur (aucun fetch, aucun stockage)", () => {
    const html = renderToStaticMarkup(h(SearchScreen, {}));
    expect(html).toContain('data-mode="neutral"');
    expect(html).toContain('data-testid="search-skeleton"');
    expect(html).toContain("Extensions populaires");
  });
});

describe("SearchScreen · design system", () => {
  const source = readFileSync(new URL("./SearchScreen.tsx", import.meta.url), "utf8");

  it("n'utilise aucune couleur hex brute (source et styles inline rendus)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/);
    const html = [
      render(),
      render({ mode: "suggest", recents: ["a"] }),
      render({ mode: "results", results: ready(resultsPayload()) }),
    ].join("");
    for (const style of html.match(/style="[^"]*"/g) ?? []) expect(style).not.toContain("#");
    expect(html).not.toMatch(/(?:fill|stroke|color)="#/);
  });

  it("n'importe ni @pokevault/services, ni postgres, ni node:* côté client", () => {
    expect(source).not.toContain("@pokevault/services");
    expect(source).not.toMatch(/from "(postgres|node:[^"]+)"/);
  });
});
