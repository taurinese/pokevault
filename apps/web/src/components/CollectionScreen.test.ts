import { readFileSync } from "node:fs";
import {
  type Binder,
  type BinderSummary,
  buildCollectionOverview,
  type OverviewCopy,
} from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type BindersPayload,
  type CatalogSetEntry,
  DEFAULT_COLLECTION_FILTERS,
} from "../lib/binders-client.ts";
import {
  buildSeriesGroups,
  CollectionScreen,
  CollectionView,
  type CollectionViewActions,
  type CollectionViewState,
  createErrorOf,
  customBinders,
  isFollowSuccess,
} from "./CollectionScreen.tsx";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const catalogSet = (overrides: Partial<CatalogSetEntry> = {}): CatalogSetEntry => ({
  id: "sv08",
  code: "SSP",
  nameFr: "Étincelles Déferlantes",
  logoUrl: "https://assets.tcgdex.net/fr/sv/sv08/logo",
  seriesId: "sv",
  seriesNameFr: "Écarlate et Violet",
  seriesReleaseOrder: 20,
  releaseDate: "2024-11-08",
  officialCount: 191,
  totalCount: 252,
  ...overrides,
});

const CATALOG: ReadonlyArray<CatalogSetEntry> = [
  catalogSet(),
  catalogSet({
    id: "sv03.5",
    code: "151",
    nameFr: "151",
    releaseDate: "2023-09-22",
    totalCount: 207,
  }),
  catalogSet({ id: "sv01", code: "SVI", nameFr: "Écarlate et Violet", releaseDate: "2023-03-31" }),
  catalogSet({
    id: "swsh12",
    code: "SIT",
    nameFr: "Tempête Argentée",
    seriesId: "swsh",
    seriesNameFr: "Épée et Bouclier",
    seriesReleaseOrder: 19,
    releaseDate: "2022-11-11",
    totalCount: 245,
  }),
];

const binderOf = (id: number, overrides: Partial<Binder>): Binder => ({
  id: uuid(id),
  userId: USER_ID,
  kind: "set",
  setId: null,
  title: "T",
  coverType: "set_logo",
  coverCardId: null,
  coverStoragePath: null,
  isPinned: false,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const overviewInput = (
  trackedSetIds: ReadonlyArray<string>,
  copies: ReadonlyArray<OverviewCopy> = [],
) =>
  buildCollectionOverview({
    series: [
      { id: "sv", nameFr: "Écarlate et Violet", releaseOrder: 20 },
      { id: "swsh", nameFr: "Épée et Bouclier", releaseOrder: 19 },
    ],
    sets: CATALOG.map((set) => ({
      id: set.id,
      seriesId: set.seriesId,
      nameFr: set.nameFr,
      code: set.code,
      logoUrl: set.logoUrl,
      releaseDate: set.releaseDate,
      officialCount: set.officialCount,
      totalCount: set.totalCount,
    })),
    copies,
    trackedSetIds: new Set(trackedSetIds),
  });

const setBinder = (id: number, setId: string, overrides: Partial<Binder> = {}): BinderSummary => {
  const entry = CATALOG.find((set) => set.id === setId);
  if (entry === undefined) throw new Error(`unknown set ${setId}`);
  const overview = overviewInput([setId]);
  const stats = overview.sets.find((set) => set.setId === setId);
  return {
    binder: binderOf(id, { kind: "set", setId, title: entry.nameFr, ...overrides }),
    set: {
      id: entry.id,
      nameFr: entry.nameFr,
      code: entry.code,
      logoUrl: entry.logoUrl,
      seriesId: entry.seriesId,
      releaseDate: entry.releaseDate,
      officialCount: entry.officialCount,
      totalCount: entry.totalCount,
    },
    completion: stats?.completion ?? null,
    cardCount: entry.totalCount,
    ownedCount: 0,
  };
};

const folder = (id: number, title: string, overrides: Partial<Binder> = {}): BinderSummary => ({
  binder: binderOf(id, { kind: "custom", title, ...overrides }),
  set: null,
  completion: null,
  cardCount: 5,
  ownedCount: 2,
});

const payload = (
  binders: ReadonlyArray<BinderSummary>,
  copies: ReadonlyArray<OverviewCopy> = [],
): BindersPayload => ({
  binders,
  overview: overviewInput(
    binders.flatMap(({ binder }) => (binder.setId === null ? [] : [binder.setId])),
    copies,
  ),
  coverCardImageById: {},
  catalogSets: CATALOG,
});

const FULL = payload([
  setBinder(1, "sv08"),
  setBinder(2, "sv03.5", { isPinned: true }),
  setBinder(3, "swsh12"),
  folder(4, "Évolitions Favs"),
  folder(5, "Doublons Échange", { isPinned: true }),
]);

const noop = (): void => undefined;
const actions: CollectionViewActions = {
  onTabChange: noop,
  onSelectSeries: noop,
  onRetry: noop,
  onOpenFollow: noop,
  onCloseFollow: noop,
  onFollowQueryChange: noop,
  onFollowSet: noop,
  onOpenCreate: noop,
  onCloseCreate: noop,
  onCreateTitleChange: noop,
  onCreatePinnedChange: noop,
  onSubmitCreate: noop,
  onOpenFilters: noop,
  onCloseFilters: noop,
  onApplyFilters: noop,
  onOpenSettings: noop,
  onCloseSettings: noop,
  onSettingsChanged: noop,
  onSettingsDeleted: noop,
  onUnauthorized: noop,
};

const baseState: CollectionViewState = {
  tab: "sets",
  data: { status: "ready", data: FULL },
  seriesId: null,
  filters: DEFAULT_COLLECTION_FILTERS,
  filtersOpen: false,
  settingsBinderId: null,
  follow: { open: false, query: "", pendingSetId: null, error: false },
  create: { open: false, title: "", pinned: false, submitting: false, error: null },
  announcement: "",
};

const render = (
  state: Partial<CollectionViewState> = {},
  overrides: Partial<CollectionViewActions> = {},
): string =>
  renderToStaticMarkup(
    h(CollectionView, {
      state: { ...baseState, ...state },
      actions: { ...actions, ...overrides },
    }),
  );

describe("CollectionView — en-tête & contrôle segmenté", () => {
  it("shows the title, the compact summary in tabular monospace, and the burst link", () => {
    const html = render();
    expect(html).toContain("<h1");
    expect(html).toContain("Collection");
    expect(html).toContain('data-testid="collection-summary"');
    expect(html).toContain("% complété");
    expect(html).toContain("exemplaire");
    expect(html).toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toContain('href="/burst"');
    expect(html).toContain("Saisie rafale");
  });

  it("always enables the Filters button (T3.4) with no badge by default", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-label="Ouvrir les filtres et le tri"/);
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Ouvrir les filtres et le tri"/,
    );
    expect(html).not.toContain('data-testid="filters-badge"');
  });

  it("shows the active-filter count on the Filters button (badge + screen-reader text)", () => {
    const html = render({
      filters: { ...DEFAULT_COLLECTION_FILTERS, hideEmptySets: true, progress: ["completed"] },
    });
    expect(html).toMatch(/data-testid="filters-badge"[^>]*>2</);
    expect(html).toContain("2 filtres actifs");
    expect(html).toContain("tabular-nums");
  });

  it("renders a tablist with Extensions and Dossiers perso, selection exposed via ARIA", () => {
    const sets = render({ tab: "sets" });
    expect(sets).toContain('role="tablist"');
    expect(sets).toContain("Extensions");
    expect(sets).toContain("Dossiers perso");
    expect(sets).toMatch(/id="collection-tab-sets"[^>]*aria-selected="true"/);
    expect(sets).toMatch(/id="collection-tab-custom"[^>]*aria-selected="false"/);
    expect(sets).toContain('role="tabpanel"');
    expect(sets).toContain('aria-labelledby="collection-tab-sets"');

    const custom = render({ tab: "custom" });
    expect(custom).toMatch(/id="collection-tab-custom"[^>]*aria-selected="true"/);
    expect(custom).toContain('aria-labelledby="collection-tab-custom"');
  });

  it("keeps only the selected tab in the tab order (roving tabindex)", () => {
    const html = render({ tab: "sets" });
    expect(html).toMatch(/id="collection-tab-sets"[^>]*tabindex="0"/);
    expect(html).toMatch(/id="collection-tab-custom"[^>]*tabindex="-1"/);
  });
});

describe("CollectionView — onglet Extensions (02)", () => {
  it("lists Tous + each series as pills, 'Tous' pressed by default", () => {
    const html = render();
    expect(html).toContain("Filtrer par bloc");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Tous</);
    expect(html).toContain(">Écarlate et Violet<");
    expect(html).toContain(">Épée et Bouclier<");
  });

  it("shows one block header per series with tracked/available count and aggregate completion", () => {
    const html = render();
    expect(html.match(/data-testid="series-section"/g)).toHaveLength(2);
    // 2 suivies (sv08, sv03.5) sur 3 du catalogue pour « Écarlate et Violet ».
    expect(html).toContain("2 sur 3 extensions suivies");
    expect(html).toContain("1 sur 1 extensions suivies");
    expect(html).toContain("Complétion du bloc Écarlate et Violet");
    expect(html).toContain("bg-gold-bar");
  });

  it("renders the tracked sets as a 2-column grid of binder cards", () => {
    const html = render();
    expect(html).toContain("grid-cols-2");
    expect(html.match(/data-testid="binder-card"/g)).toHaveLength(3);
    expect(html).not.toContain("Doublons Échange");
  });

  it("orders blocks by overview.series (most recent first)", () => {
    const html = render();
    expect(html.indexOf("series-sv")).toBeLessThan(html.indexOf("series-swsh"));
  });

  it("filters to one block when a series pill is selected", () => {
    const html = render({ seriesId: "swsh" });
    expect(html.match(/data-testid="series-section"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Épée et Bouclier</);
    expect(html).toContain("Tempête Argentée");
    expect(html).not.toContain("Étincelles Déferlantes");
  });

  it("falls back to 'Tous' when the selected block no longer exists", () => {
    const html = render({ seriesId: "gone" });
    expect(html.match(/data-testid="series-section"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Tous</);
  });

  it("offers the 'Suivre une extension' action alongside the grids", () => {
    const html = render();
    expect(html).toContain('data-testid="follow-cta"');
    expect(html).toContain("Suivre une extension");
  });

  it("is fully usable on day 1: empty state with a follow CTA", () => {
    const html = render({ data: { status: "ready", data: payload([]) } });
    expect(html).toContain('data-testid="sets-empty"');
    expect(html).toContain("Aucune extension suivie");
    expect(html).toContain("Suivre une extension");
    expect(html).not.toContain("series-section");
  });

  it("ignores custom folders in the Extensions tab and vice-versa", () => {
    expect(buildSeriesGroups(FULL).flatMap((group) => group.binders)).toHaveLength(3);
    // Tri par défaut (complétion ↓, titre) : le dossier épinglé passe en tête.
    expect(customBinders(FULL).map(({ binder }) => binder.title)).toEqual([
      "Doublons Échange",
      "Évolitions Favs",
    ]);
  });
});

describe("CollectionView — onglet Dossiers perso (02B)", () => {
  it("shows the folders in a 2-column grid with the dashed '+ Nouveau dossier' card", () => {
    const html = render({ tab: "custom" });
    expect(html).toContain("grid-cols-2");
    expect(html.match(/data-testid="binder-card"/g)).toHaveLength(2);
    expect(html).toContain("Évolitions Favs");
    expect(html).toContain("Privé");
    expect(html).toContain('data-testid="new-folder-card"');
    expect(html).toContain("border-dashed");
    expect(html).toContain("Nouveau dossier personnalisé");
    expect(html).not.toContain("Tempête Argentée");
    expect(html).not.toContain('data-testid="custom-empty"');
  });

  it("shows an empty message but keeps the creation card when there is no folder", () => {
    const html = render({
      tab: "custom",
      data: { status: "ready", data: payload([setBinder(1, "sv08")]) },
    });
    expect(html).toContain('data-testid="custom-empty"');
    expect(html).toContain("Aucun dossier personnalisé");
    expect(html).toContain('data-testid="new-folder-card"');
  });
});

describe("CollectionView — feuille « Suivre une extension »", () => {
  const open = { open: true, query: "", pendingSetId: null, error: false };

  it("lists only untracked catalogue sets, with their series", () => {
    const html = render({ follow: open });
    expect(html).toContain('data-testid="follow-sheet"');
    // sv01 est la seule extension du catalogue pas encore suivie.
    expect(html).toContain("Suivre l&#x27;extension Écarlate et Violet");
    expect(html).not.toContain("Suivre l&#x27;extension Étincelles Déferlantes");
    expect(html).not.toContain("Suivre l&#x27;extension Tempête Argentée");
  });

  it("filters the list with the quick filter and explains an empty result", () => {
    const sparse = payload([setBinder(1, "sv08")]);
    const filtered = render({
      follow: { ...open, query: "tempete" },
      data: { status: "ready", data: sparse },
    });
    expect(filtered).toContain("Suivre l&#x27;extension Tempête Argentée");
    expect(filtered).not.toContain("Suivre l&#x27;extension 151");

    const none = render({
      follow: { ...open, query: "zzz" },
      data: { status: "ready", data: sparse },
    });
    expect(none).toContain('data-testid="follow-empty"');
    expect(none).toContain("Aucune extension ne correspond à « zzz ».");
  });

  it("says so when every extension is already followed or the catalogue is empty", () => {
    const all = payload(CATALOG.map((set, index) => setBinder(index + 1, set.id)));
    expect(render({ follow: open, data: { status: "ready", data: all } })).toContain(
      "Vous suivez déjà toutes les extensions du catalogue.",
    );
    const empty = { ...payload([]), catalogSets: [] };
    expect(render({ follow: open, data: { status: "ready", data: empty } })).toContain(
      "Le catalogue est vide",
    );
  });

  it("disables rows and shows progress while an extension is being added", () => {
    const html = render({ follow: { ...open, pendingSetId: "sv01" } });
    expect(html).toContain("Ajout en cours…");
    expect(html).toContain("disabled");
  });

  it("surfaces a failure as an alert", () => {
    const html = render({ follow: { ...open, error: true } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Impossible de suivre cette extension");
  });

  it("is not rendered while closed", () => {
    expect(render()).not.toContain('data-testid="follow-sheet"');
  });
});

describe("CollectionView — feuille de création de dossier", () => {
  const open = { open: true, title: "", pinned: false, submitting: false, error: null } as const;

  it("renders the title field (max 80), the pin checkbox and the submit button", () => {
    const html = render({ tab: "custom", create: open });
    expect(html).toContain('data-testid="create-sheet"');
    expect(html).toContain("Nom du dossier");
    expect(html).toContain('maxLength="80"');
    expect(html).toContain("Épingler en haut");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Créer le dossier");
    expect(html).toContain("0 / 80");
    expect(html).not.toContain('data-testid="create-error"');
  });

  it("reflects the typed title, the counter and the pin state", () => {
    const html = render({ create: { ...open, title: "Favs", pinned: true } });
    expect(html).toContain('value="Favs"');
    expect(html).toContain("4 / 80");
    expect(html).toContain('checked=""');
  });

  it.each([
    ["empty", "Donnez un nom à votre dossier."],
    ["too_long", "Le nom ne peut pas dépasser 80 caractères."],
    ["invalid", "Ce nom n&#x27;est pas valide."],
    ["conflict", "Un dossier identique existe déjà."],
    ["generic", "La création a échoué. Veuillez réessayer."],
  ] as const)("shows the %s error accessibly", (error, message) => {
    const html = render({ create: { ...open, error } });
    expect(html).toContain('data-testid="create-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="create-folder-error"');
  });

  it("disables the submit button while submitting", () => {
    const html = render({ create: { ...open, title: "Favs", submitting: true } });
    expect(html).toContain("Création…");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/,
    );
  });
});

describe("CollectionView — filtres & tri (02C) et réglages (T3.4)", () => {
  const sectionTitles = (html: string): ReadonlyArray<string> =>
    [...html.matchAll(/<h3 class="truncate text-sm font-bold text-primary">([^<]*)</g)].map(
      (match) => match[1] ?? "",
    );

  it("applies the sort inside each block (name A–Z) and keeps pinned binders first", () => {
    const html = render({
      data: {
        status: "ready",
        data: payload([
          setBinder(1, "sv08"),
          setBinder(2, "sv03.5"),
          setBinder(3, "sv01", { isPinned: true }),
        ]),
      },
      filters: { ...DEFAULT_COLLECTION_FILTERS, sort: "name_asc" },
    });
    expect(sectionTitles(html)).toEqual(["Écarlate et Violet", "151", "Étincelles Déferlantes"]);
  });

  it("filters the grid by block while keeping every block pill available", () => {
    const html = render({
      filters: { ...DEFAULT_COLLECTION_FILTERS, seriesIds: ["swsh"] },
    });
    expect(html.match(/data-testid="series-section"/g)).toHaveLength(1);
    expect(sectionTitles(html)).toEqual(["Tempête Argentée"]);
    // Les pills restent celles de toute la collection.
    expect(html).toContain("Écarlate et Violet");
    expect(html).toContain("Épée et Bouclier");
  });

  it("hides sets with 0 owned cards and explains an empty result with a reset action", () => {
    const html = render({ filters: { ...DEFAULT_COLLECTION_FILTERS, hideEmptySets: true } });
    expect(html).toContain('data-testid="filtered-empty"');
    expect(html).toContain("Aucun classeur ne correspond");
    expect(html).toContain("Réinitialiser les filtres");
    expect(html).not.toContain('data-testid="binder-card"');
    // Sans filtre, pas de message.
    expect(render()).not.toContain('data-testid="filtered-empty"');
  });

  it("filters the custom folders tab too (hide empty folders)", () => {
    const withEmpty = payload([
      folder(4, "Plein"),
      { ...folder(5, "Vide"), cardCount: 0, ownedCount: 0 },
    ]);
    const html = render({
      tab: "custom",
      data: { status: "ready", data: withEmpty },
      filters: { ...DEFAULT_COLLECTION_FILTERS, hideEmptySets: true },
    });
    expect(html).toContain("Plein");
    expect(html).not.toContain("Vide");
    // La card « + Nouveau dossier » reste toujours disponible.
    expect(html).toContain('data-testid="new-folder-card"');
  });

  it("renders the filter sheet only when opened and data is ready", () => {
    expect(render()).not.toContain('data-testid="filter-sheet"');
    const open = render({ filtersOpen: true });
    expect(open).toContain('data-testid="filter-sheet"');
    expect(open).toContain("Filtres &amp; tri");
    // Les blocs proposés viennent de overview.series (blocs suivis).
    expect(open).toContain('data-testid="filter-series-sv"');
    expect(open).toContain('data-testid="filter-series-swsh"');
    expect(render({ filtersOpen: true, data: { status: "loading" } })).not.toContain(
      'data-testid="filter-sheet"',
    );
  });

  it("opens the settings sheet for the selected binder, with its current data", () => {
    expect(render()).not.toContain('data-testid="binder-settings"');
    const html = render({ settingsBinderId: uuid(1) });
    expect(html).toContain('data-testid="binder-settings"');
    expect(html).toContain("Réglages du classeur");
    expect(html).toContain('value="Étincelles Déferlantes"');
  });

  it("closes the settings sheet when its binder disappeared (deleted)", () => {
    expect(render({ settingsBinderId: uuid(999) })).not.toContain('data-testid="binder-settings"');
  });

  it("shows a settings button on every binder card (sets and folders)", () => {
    const sets = render();
    expect(sets.match(/aria-label="Réglages du classeur /g)).toHaveLength(3);
    const custom = render({ tab: "custom" });
    expect(custom.match(/aria-label="Réglages du classeur /g)).toHaveLength(2);
  });
});

describe("CollectionView — états chargement, erreur & annonces", () => {
  it("renders skeletons (not the tabs content) while loading", () => {
    const html = render({ data: { status: "loading" } });
    expect(html).toContain('data-testid="collection-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain('data-testid="collection-summary"');
    expect(html).not.toContain('data-testid="binder-card"');
  });

  it("renders an error state with a retry button wired to onRetry", () => {
    const onRetry = vi.fn();
    const html = render({ data: { status: "error" } }, { onRetry });
    expect(html).toContain('data-testid="collection-error"');
    expect(html).toContain("Collection indisponible");
    expect(html).toContain("Réessayer");
    expect(html).not.toContain('data-testid="binder-card"');
  });

  it("exposes the announcement in a polite live region", () => {
    const html = render({ announcement: "Dossier « Favs » créé" });
    expect(html).toMatch(
      /<p[^>]*role="status"[^>]*aria-live="polite"[^>]*>Dossier « Favs » créé<\/p>/,
    );
  });

  it("keeps room for the floating navbar and stays mobile-first", () => {
    const html = render();
    expect(html).toContain("max-w-md");
    expect(html).toContain("pb-40");
  });
});

describe("CollectionScreen container", () => {
  it("server-renders the loading skeleton first (data is fetched after hydration)", () => {
    const html = renderToStaticMarkup(h(CollectionScreen, {}));
    expect(html).toContain('data-testid="collection-skeleton"');
    expect(html).toContain('role="tablist"');
  });
});

describe("pure helpers", () => {
  it("maps submit results to a displayable error", () => {
    expect(createErrorOf({ kind: "invalid_title", reason: "empty" })).toBe("empty");
    expect(createErrorOf({ kind: "invalid_title", reason: "too_long" })).toBe("too_long");
    expect(createErrorOf({ kind: "invalid" })).toBe("invalid");
    expect(createErrorOf({ kind: "conflict" })).toBe("conflict");
    expect(createErrorOf({ kind: "error" })).toBe("generic");
    expect(createErrorOf({ kind: "not_found" })).toBe("generic");
    expect(createErrorOf({ kind: "unauthorized" })).toBeNull();
  });

  it("treats an already followed extension (409) as a success", () => {
    expect(isFollowSuccess({ kind: "conflict" })).toBe(true);
    expect(isFollowSuccess({ kind: "ok", summary: setBinder(1, "sv08") })).toBe(true);
    expect(isFollowSuccess({ kind: "error" })).toBe(false);
    expect(isFollowSuccess({ kind: "not_found" })).toBe(false);
  });

  it("derives block availability from the catalogue", () => {
    const groups = buildSeriesGroups(FULL);
    expect(
      groups.map((group) => [group.series.seriesId, group.binders.length, group.availableCount]),
    ).toEqual([
      ["sv", 2, 3],
      ["swsh", 1, 1],
    ]);
  });
});

describe("Dark & Light via tokens only, zero hard-coded UI string", () => {
  const source = readFileSync(new URL("./CollectionScreen.tsx", import.meta.url), "utf8");

  it("uses only token utilities (no raw colours, no dark: variants)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bdark:/);
  });

  it("routes every user-facing label through the i18n dictionary", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const jsxText = code.match(/>[ \t]*[A-Za-zÀ-ÿ][^<>{}\n;()=]*[ \t]*</g) ?? [];
    expect(jsxText).toEqual([]);
  });
});
