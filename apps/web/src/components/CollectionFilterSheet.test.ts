import { readFileSync } from "node:fs";
import type { BinderSummary, SetCompletionStats } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type CollectionFilters, DEFAULT_COLLECTION_FILTERS } from "../lib/binders-client.ts";
import {
  CollectionFilterForm,
  type CollectionFilterFormProps,
  CollectionFilterSheet,
  countFilteredBinders,
} from "./CollectionFilterSheet.tsx";

const SERIES = [
  { id: "sv", name: "Écarlate et Violet" },
  { id: "swsh", name: "Épée et Bouclier" },
] as const;

const stats = (
  setId: string,
  percent: number,
  ownedDistinct: number,
  status: SetCompletionStats["status"],
): SetCompletionStats => ({
  setId,
  officialCount: 100,
  totalCount: 120,
  targetCount: 120,
  ownedDistinct,
  missingCount: 120 - ownedDistinct,
  percent,
  totalCopies: ownedDistinct,
  duplicateCount: 0,
  duplicateCardCount: 0,
  status,
});

const binder = (n: number, seriesId: string, completion: SetCompletionStats): BinderSummary => ({
  binder: {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    userId: "11111111-1111-4111-8111-111111111111",
    kind: "set",
    setId: completion.setId,
    title: `Set ${n}`,
    coverType: "set_logo",
    coverCardId: null,
    coverStoragePath: null,
    isPinned: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  set: {
    id: completion.setId,
    nameFr: `Set ${n}`,
    code: null,
    logoUrl: null,
    seriesId,
    releaseDate: "2024-01-01",
    officialCount: 100,
    totalCount: 120,
  },
  completion,
  cardCount: 120,
  ownedCount: completion.ownedDistinct,
});

const BINDERS = [
  binder(1, "sv", stats("a", 50, 60, "in_progress")),
  binder(2, "sv", stats("b", 100, 120, "completed")),
  binder(3, "swsh", stats("c", 0, 0, "not_started")),
];

const noop = (): void => undefined;

const renderForm = (
  draft: Partial<CollectionFilters> = {},
  props: Partial<CollectionFilterFormProps> = {},
): string =>
  renderToStaticMarkup(
    h(CollectionFilterForm, {
      draft: { ...DEFAULT_COLLECTION_FILTERS, ...draft },
      series: SERIES,
      resultCount: 3,
      onChange: noop,
      onReset: noop,
      onApply: noop,
      ...props,
    }),
  );

describe("CollectionFilterForm (02C)", () => {
  it("renders the 2×2 sort grid with the four sorts, the active one pressed", () => {
    const html = renderForm();
    expect(html).toContain('data-testid="filter-sort-grid"');
    expect(html).toMatch(
      /class="grid grid-cols-2[^"]*"[^>]*data-testid="filter-sort-grid"|data-testid="filter-sort-grid"[^>]*class="grid grid-cols-2/,
    );
    for (const label of ["Complétion ↓", "Valeur ↓", "Date de sortie", "Nom A–Z"]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-sort-completion_desc"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="filter-sort-name_asc"/);
  });

  it("explains discreetly that value ↓ falls back to completion until prices exist", () => {
    expect(renderForm()).not.toContain('data-testid="filter-value-hint"');
    const html = renderForm({ sort: "value_desc" });
    expect(html).toContain('data-testid="filter-value-hint"');
    expect(html).toContain("milestone M3");
  });

  it("renders the progress pills (multi-selection) with aria-pressed", () => {
    const html = renderForm({ progress: ["in_progress", "completed"] });
    for (const label of ["En cours", "Complets", "Non commencés"]) expect(html).toContain(label);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-progress-in_progress"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-progress-completed"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="filter-progress-not_started"/);
  });

  it("renders one pill per block, several selectable at once", () => {
    const html = renderForm({ seriesIds: ["sv", "swsh"] });
    expect(html).toContain("Écarlate et Violet");
    expect(html).toContain("Épée et Bouclier");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-series-sv"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-series-swsh"/);
    expect(renderForm({}, { series: [] })).toContain("Aucun bloc suivi pour le moment.");
  });

  it("renders the two options as role=switch with aria-checked", () => {
    const html = renderForm();
    expect(html).toContain('role="switch"');
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="filter-hide-empty"/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="filter-include-extras"/);
    expect(html).toContain("Masquer les sets à 0 carte");
    expect(html).toContain("Inclure les cartes promos / secrètes");
    const off = renderForm({ hideEmptySets: true, includeSecretsAndPromos: false });
    expect(off).toMatch(/aria-checked="true"[^>]*data-testid="filter-hide-empty"/);
    expect(off).toMatch(/aria-checked="false"[^>]*data-testid="filter-include-extras"/);
    expect(off).toContain("la complétion ignore les cartes secrètes");
  });

  it("shows Réinitialiser and a gold Appliquer with the live result count in tabular mono", () => {
    const html = renderForm({}, { resultCount: 12 });
    expect(html).toContain("Réinitialiser");
    expect(html).toContain("Appliquer");
    expect(html).toMatch(
      /data-testid="filter-apply-count"[^>]*class="font-mono tabular-nums"|class="font-mono tabular-nums"[^>]*data-testid="filter-apply-count"/,
    );
    expect(html).toContain("12 résultats");
    expect(html).toContain("border-gold");
    expect(renderForm({}, { resultCount: 1 })).toContain("1 résultat<");
    expect(renderForm({}, { resultCount: 0 })).toContain("0 résultat<");
  });

  it("keeps touch targets on every control", () => {
    const html = renderForm();
    expect(html.match(/min-height:var\(--touch-target-min\)/g)?.length ?? 0).toBeGreaterThanOrEqual(
      10,
    );
  });
});

describe("CollectionFilterSheet", () => {
  const base = {
    filters: DEFAULT_COLLECTION_FILTERS,
    series: SERIES,
    binders: BINDERS,
    onApply: vi.fn(),
    onClose: vi.fn(),
  };

  it("is not rendered while closed", () => {
    expect(renderToStaticMarkup(h(CollectionFilterSheet, { ...base, open: false }))).toBe("");
  });

  it("renders a titled dialog starting from the applied filters, with the live count", () => {
    const html = renderToStaticMarkup(
      h(CollectionFilterSheet, {
        ...base,
        open: true,
        filters: { ...DEFAULT_COLLECTION_FILTERS, progress: ["completed"] },
      }),
    );
    expect(html).toContain("<dialog");
    expect(html).toContain("Filtres &amp; tri");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-progress-completed"/);
    // Un seul classeur complet.
    expect(html).toContain("1 résultat");
  });

  it("counts results live for a draft", () => {
    expect(countFilteredBinders(BINDERS, DEFAULT_COLLECTION_FILTERS)).toBe(3);
    expect(
      countFilteredBinders(BINDERS, { ...DEFAULT_COLLECTION_FILTERS, hideEmptySets: true }),
    ).toBe(2);
    expect(
      countFilteredBinders(BINDERS, { ...DEFAULT_COLLECTION_FILTERS, seriesIds: ["swsh"] }),
    ).toBe(1);
    expect(
      countFilteredBinders(BINDERS, {
        ...DEFAULT_COLLECTION_FILTERS,
        seriesIds: ["swsh"],
        progress: ["completed"],
      }),
    ).toBe(0);
  });
});

describe("Dark & Light via tokens only, zero hard-coded UI string", () => {
  const source = readFileSync(new URL("./CollectionFilterSheet.tsx", import.meta.url), "utf8");

  it("uses only token utilities", () => {
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
