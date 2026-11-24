import { describe, expect, it, vi } from "vitest";
import {
  BINDER_GRID_COLUMNS,
  type BinderGridCard,
  binderGridApiPath,
  burstPathForSetId,
  cardTileStateFor,
  chunkIntoRows,
  countBinderGridQuickFilter,
  emptyBinderGridPayload,
  extractBinderFilterFacets,
  fetchBinderGrid,
  filterBinderGridCards,
  hasActiveAdvancedFilters,
} from "./binder-grid-client.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const card = (overrides: Partial<BinderGridCard> & { readonly id: string }): BinderGridCard => ({
  setId: "sv03.5",
  localId: "1",
  localIdNumeric: 1,
  nameFr: overrides.id,
  rarity: null,
  types: [],
  imageBaseUrl: `https://assets.tcgdex.net/fr/sv/sv03.5/${overrides.id}`,
  inWishlist: false,
  totalQuantity: 0,
  languages: [],
  variants: [],
  copies: [],
  ...overrides,
});

const cards: ReadonlyArray<BinderGridCard> = [
  card({
    id: "sv03.5-1",
    localId: "1",
    localIdNumeric: 1,
    nameFr: "Bulbizarre",
    rarity: "Commune",
    types: ["Plante"],
    totalQuantity: 1,
    languages: ["FR"],
    variants: ["normal"],
    copies: [
      {
        id: "c1",
        language: "FR",
        variant: "normal",
        condition: "NM",
        quantity: 1,
        gradingCompany: null,
        gradingScore: null,
      },
    ],
  }),
  card({
    id: "sv03.5-4",
    localId: "4",
    localIdNumeric: 4,
    nameFr: "Salamèche",
    rarity: "Rare",
    types: ["Feu"],
    totalQuantity: 3,
    languages: ["FR", "EN"],
    variants: ["normal", "holo"],
    inWishlist: true,
  }),
  card({
    id: "sv03.5-25",
    localId: "25",
    localIdNumeric: 25,
    nameFr: "Pikachu",
    rarity: "Commune",
    types: ["Électrik"],
    totalQuantity: 0,
    inWishlist: true,
  }),
  card({
    id: "sv03.5-150",
    localId: "150",
    localIdNumeric: 150,
    nameFr: "Mewtwo",
    rarity: "Rare Holo",
    types: ["Psy"],
    totalQuantity: 0,
  }),
  card({
    id: "sv03.5-TG01",
    localId: "TG01",
    localIdNumeric: null,
    nameFr: "Dresseur",
    rarity: null,
    types: ["Dresseur"],
    totalQuantity: 2,
    languages: ["JP"],
    variants: ["promo"],
  }),
];

// ---------------------------------------------------------------------------
// Filtres rapides
// ---------------------------------------------------------------------------

describe("filterBinderGridCards — filtres rapides", () => {
  it('"all" conserve toutes les cartes dans l’ordre', () => {
    expect(filterBinderGridCards(cards, "all").map((c) => c.id)).toEqual([
      "sv03.5-1",
      "sv03.5-4",
      "sv03.5-25",
      "sv03.5-150",
      "sv03.5-TG01",
    ]);
  });

  it('"owned" ne garde que totalQuantity >= 1', () => {
    expect(filterBinderGridCards(cards, "owned").map((c) => c.id)).toEqual([
      "sv03.5-1",
      "sv03.5-4",
      "sv03.5-TG01",
    ]);
  });

  it('"missing" ne garde que totalQuantity === 0', () => {
    expect(filterBinderGridCards(cards, "missing").map((c) => c.id)).toEqual([
      "sv03.5-25",
      "sv03.5-150",
    ]);
  });

  it('"duplicates" ne garde que totalQuantity >= 2', () => {
    expect(filterBinderGridCards(cards, "duplicates").map((c) => c.id)).toEqual([
      "sv03.5-4",
      "sv03.5-TG01",
    ]);
  });

  it('"wishlist" ne garde que inWishlist === true', () => {
    expect(filterBinderGridCards(cards, "wishlist").map((c) => c.id)).toEqual([
      "sv03.5-4",
      "sv03.5-25",
    ]);
  });

  it("compteurs par filtre rapide", () => {
    expect(countBinderGridQuickFilter(cards, "all")).toBe(5);
    expect(countBinderGridQuickFilter(cards, "owned")).toBe(3);
    expect(countBinderGridQuickFilter(cards, "missing")).toBe(2);
    expect(countBinderGridQuickFilter(cards, "duplicates")).toBe(2);
    expect(countBinderGridQuickFilter(cards, "wishlist")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Filtres avancés
// ---------------------------------------------------------------------------

describe("filterBinderGridCards — filtres avancés", () => {
  it("filtre par rareté exacte (null exclu)", () => {
    expect(filterBinderGridCards(cards, "all", { rarity: "Commune" }).map((c) => c.id)).toEqual([
      "sv03.5-1",
      "sv03.5-25",
    ]);
    expect(filterBinderGridCards(cards, "all", { rarity: "Rare" }).map((c) => c.id)).toEqual([
      "sv03.5-4",
    ]);
  });

  it("filtre par type contenu dans la carte", () => {
    expect(filterBinderGridCards(cards, "all", { type: "Feu" }).map((c) => c.id)).toEqual([
      "sv03.5-4",
    ]);
  });

  it("filtre par langue possédée", () => {
    expect(filterBinderGridCards(cards, "all", { language: "EN" }).map((c) => c.id)).toEqual([
      "sv03.5-4",
    ]);
    expect(filterBinderGridCards(cards, "all", { language: "JP" }).map((c) => c.id)).toEqual([
      "sv03.5-TG01",
    ]);
  });

  it("filtre par variante possédée", () => {
    expect(filterBinderGridCards(cards, "all", { variant: "holo" }).map((c) => c.id)).toEqual([
      "sv03.5-4",
    ]);
    expect(filterBinderGridCards(cards, "all", { variant: "promo" }).map((c) => c.id)).toEqual([
      "sv03.5-TG01",
    ]);
  });

  it("combine filtre rapide + avancés (ET)", () => {
    expect(
      filterBinderGridCards(cards, "missing", { rarity: "Commune", type: "Électrik" }).map(
        (c) => c.id,
      ),
    ).toEqual(["sv03.5-25"]);
    expect(
      filterBinderGridCards(cards, "owned", { language: "FR", variant: "holo" }).map((c) => c.id),
    ).toEqual(["sv03.5-4"]);
    expect(
      filterBinderGridCards(cards, "wishlist", { rarity: "Commune" }).map((c) => c.id),
    ).toEqual(["sv03.5-25"]);
  });

  it("hasActiveAdvancedFilters", () => {
    expect(hasActiveAdvancedFilters({})).toBe(false);
    expect(hasActiveAdvancedFilters({ rarity: null, type: null })).toBe(false);
    expect(hasActiveAdvancedFilters({ variant: "holo" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Facettes
// ---------------------------------------------------------------------------

describe("extractBinderFilterFacets", () => {
  it("extrait raretés et types triés, dédupliqués, sans null", () => {
    const facets = extractBinderFilterFacets(cards);
    expect(facets.rarities).toEqual(["Commune", "Rare", "Rare Holo"]);
    expect(facets.types).toEqual(["Dresseur", "Électrik", "Feu", "Plante", "Psy"]);
  });

  it("liste vide sur classeur vide", () => {
    expect(extractBinderFilterFacets([])).toEqual({ rarities: [], types: [] });
  });
});

// ---------------------------------------------------------------------------
// Chunking 3 colonnes
// ---------------------------------------------------------------------------

describe("chunkIntoRows", () => {
  it("découpe en rangées de 3 (dernière rangée incomplète)", () => {
    const rows = chunkIntoRows([1, 2, 3, 4, 5, 6, 7]);
    expect(rows).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(BINDER_GRID_COLUMNS).toBe(3);
  });

  it("liste vide → aucune rangée ; rangée pleine exacte", () => {
    expect(chunkIntoRows([])).toEqual([]);
    expect(chunkIntoRows(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("columns explicite et garde-fou", () => {
    expect(chunkIntoRows([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunkIntoRows([1, 2], 0)).toEqual([[1], [2]]);
  });
});

// ---------------------------------------------------------------------------
// cardTileStateFor
// ---------------------------------------------------------------------------

describe("cardTileStateFor", () => {
  it("0 (et négatif) → missing, 1 → owned, >= 2 → duplicate avec compteur", () => {
    expect(cardTileStateFor(0)).toEqual({ state: "missing" });
    expect(cardTileStateFor(-3)).toEqual({ state: "missing" });
    expect(cardTileStateFor(1)).toEqual({ state: "owned" });
    expect(cardTileStateFor(2)).toEqual({ state: "duplicate", count: 2 });
    expect(cardTileStateFor(7)).toEqual({ state: "duplicate", count: 7 });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe("paths & payload vide", () => {
  it("binderGridApiPath échappe l’id", () => {
    expect(binderGridApiPath("abc-123")).toBe("/api/binder-grid/abc-123");
    expect(binderGridApiPath("a/b?c")).toBe("/api/binder-grid/a%2Fb%3Fc");
  });

  it("burstPathForSetId", () => {
    expect(burstPathForSetId("sv03.5")).toBe("/burst?setId=sv03.5");
  });

  it("emptyBinderGridPayload documenté", () => {
    expect(emptyBinderGridPayload).toEqual({ binder: null, cards: [] });
  });
});

describe("fetchBinderGrid", () => {
  const payload = { binder: null, cards: [] };

  it("200 → ok avec le payload décodé", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload, { status: 200 }));
    const result = await fetchBinderGrid("b1", undefined, fetchImpl);
    expect(result).toEqual({ kind: "ok", payload });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/binder-grid/b1",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("401 → unauthorized, 404 → not-found, 503 → error", async () => {
    expect(
      await fetchBinderGrid("b", undefined, async () => new Response("x", { status: 401 })),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await fetchBinderGrid("b", undefined, async () => new Response("x", { status: 404 })),
    ).toEqual({ kind: "not-found" });
    expect(
      await fetchBinderGrid("b", undefined, async () => new Response("x", { status: 503 })),
    ).toEqual({ kind: "error" });
  });

  it("erreur réseau → error ; AbortError relancé", async () => {
    expect(
      await fetchBinderGrid("b", undefined, async () => {
        throw new Error("network down");
      }),
    ).toEqual({ kind: "error" });
    const abort = new DOMException("aborted", "AbortError");
    await expect(
      fetchBinderGrid("b", undefined, async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
  });

  it("passe le signal d’annulation", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json(payload, { status: 200 });
    });
    await fetchBinderGrid("b", controller.signal, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
