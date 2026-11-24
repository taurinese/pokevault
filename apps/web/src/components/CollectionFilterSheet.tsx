import type { BinderSummary } from "@pokevault/domain";
import { useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import {
  applyCollectionFiltersAndSort,
  COLLECTION_SORTS,
  type CollectionFilters,
  type CollectionSort,
  DEFAULT_COLLECTION_FILTERS,
  PROGRESS_FILTERS,
  type ProgressFilter,
  toggleInSelection,
  VALUE_SORT_AVAILABLE,
} from "../lib/binders-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";

/** Bloc proposé dans le filtre « Bloc / Série » (issu de `overview.series`). */
export interface FilterSeriesOption {
  readonly id: string;
  readonly name: string;
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;

const SORT_KEYS: Readonly<Record<CollectionSort, TranslationKey>> = {
  completion_desc: "collectionFilters.sort.completion_desc",
  value_desc: "collectionFilters.sort.value_desc",
  release_date_desc: "collectionFilters.sort.release_date_desc",
  name_asc: "collectionFilters.sort.name_asc",
};

const PROGRESS_KEYS: Readonly<Record<ProgressFilter, TranslationKey>> = {
  in_progress: "collectionFilters.progress.in_progress",
  completed: "collectionFilters.progress.completed",
  not_started: "collectionFilters.progress.not_started",
};

/** Nombre de classeurs affichés si ces filtres étaient appliqués (compteur live du bouton). */
export const countFilteredBinders = (
  binders: ReadonlyArray<BinderSummary>,
  filters: CollectionFilters,
): number => applyCollectionFiltersAndSort(binders, filters).length;

const sectionTitle = "text-sm font-semibold text-primary";

const pillClass = (active: boolean): string =>
  `rounded-pill border px-4 text-sm font-semibold whitespace-nowrap transition-colors ${focusRing} ${
    active
      ? "border-accent-blue bg-surface-2 text-accent-blue"
      : "border-line bg-surface-1 text-secondary hover:text-primary"
  }`;

const Switch = ({
  checked,
  onChange,
  label,
  hint,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly testId: string;
}) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex min-w-0 flex-col">
      <span className="text-sm text-primary">{label}</span>
      {hint === undefined ? null : <span className="text-xs text-muted">{hint}</span>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
      className={`flex shrink-0 items-center justify-center ${focusRing}`}
    >
      <span
        aria-hidden="true"
        className={`flex h-6 w-11 items-center rounded-pill border p-0.5 transition-colors ${
          checked
            ? "justify-end border-gold bg-gold-soft"
            : "justify-start border-line bg-surface-2"
        }`}
      >
        <span className={`size-4.5 rounded-pill ${checked ? "bg-gold" : "bg-muted"}`} />
      </span>
    </button>
  </div>
);

export interface CollectionFilterFormProps {
  readonly draft: CollectionFilters;
  readonly series: ReadonlyArray<FilterSeriesOption>;
  /** Résultats si `draft` était appliqué. */
  readonly resultCount: number;
  readonly onChange: (next: CollectionFilters) => void;
  readonly onReset: () => void;
  readonly onApply: () => void;
}

/** Contenu du bottom sheet `02C` — pur, piloté par `draft` (testable sans état React). */
export const CollectionFilterForm = ({
  draft,
  series,
  resultCount,
  onChange,
  onReset,
  onApply,
}: CollectionFilterFormProps) => (
  <div className="flex flex-col gap-5" data-testid="filter-sheet">
    <section className="flex flex-col gap-2" aria-labelledby="filter-sort-title">
      <h3 id="filter-sort-title" className={sectionTitle}>
        {t("collectionFilters.sort.label")}
      </h3>
      <div className="grid grid-cols-2 gap-2" data-testid="filter-sort-grid">
        {COLLECTION_SORTS.map((sort) => {
          const active = draft.sort === sort;
          return (
            <button
              key={sort}
              type="button"
              aria-pressed={active}
              data-testid={`filter-sort-${sort}`}
              onClick={() => onChange({ ...draft, sort })}
              style={touchTarget}
              className={pillClass(active)}
            >
              {t(SORT_KEYS[sort])}
            </button>
          );
        })}
      </div>
      {draft.sort === "value_desc" && !VALUE_SORT_AVAILABLE ? (
        <p data-testid="filter-value-hint" className="text-xs text-muted">
          {t("collectionFilters.sort.valueHint")}
        </p>
      ) : null}
    </section>

    <section className="flex flex-col gap-2" aria-labelledby="filter-progress-title">
      <h3 id="filter-progress-title" className={sectionTitle}>
        {t("collectionFilters.progress.label")}
      </h3>
      <div className="flex flex-wrap gap-2">
        {PROGRESS_FILTERS.map((progress) => {
          const active = draft.progress.includes(progress);
          return (
            <button
              key={progress}
              type="button"
              aria-pressed={active}
              data-testid={`filter-progress-${progress}`}
              onClick={() =>
                onChange({ ...draft, progress: toggleInSelection(draft.progress, progress) })
              }
              style={touchTarget}
              className={pillClass(active)}
            >
              {t(PROGRESS_KEYS[progress])}
            </button>
          );
        })}
      </div>
    </section>

    <section className="flex flex-col gap-2" aria-labelledby="filter-series-title">
      <h3 id="filter-series-title" className={sectionTitle}>
        {t("collectionFilters.series.label")}
      </h3>
      {series.length === 0 ? (
        <p className="text-sm text-muted">{t("collectionFilters.series.empty")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {series.map((entry) => {
            const active = draft.seriesIds.includes(entry.id);
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={active}
                data-testid={`filter-series-${entry.id}`}
                onClick={() =>
                  onChange({ ...draft, seriesIds: toggleInSelection(draft.seriesIds, entry.id) })
                }
                style={touchTarget}
                className={pillClass(active)}
              >
                {entry.name}
              </button>
            );
          })}
        </div>
      )}
    </section>

    <section className="flex flex-col gap-1" aria-labelledby="filter-options-title">
      <h3 id="filter-options-title" className={sectionTitle}>
        {t("collectionFilters.options.label")}
      </h3>
      <Switch
        testId="filter-hide-empty"
        checked={draft.hideEmptySets}
        onChange={(hideEmptySets) => onChange({ ...draft, hideEmptySets })}
        label={t("collectionFilters.options.hideEmpty")}
      />
      <Switch
        testId="filter-include-extras"
        checked={draft.includeSecretsAndPromos}
        onChange={(includeSecretsAndPromos) => onChange({ ...draft, includeSecretsAndPromos })}
        label={t("collectionFilters.options.includeExtras")}
        hint={
          draft.includeSecretsAndPromos
            ? undefined
            : t("collectionFilters.options.includeExtrasHint")
        }
      />
    </section>

    <div className="grid grid-cols-[auto_1fr] gap-3">
      <button
        type="button"
        onClick={onReset}
        data-testid="filter-reset"
        style={touchTarget}
        className={`rounded-pill border border-line bg-surface-1 px-5 text-sm font-semibold text-secondary hover:text-primary ${focusRing}`}
      >
        {t("collectionFilters.reset")}
      </button>
      <button
        type="button"
        onClick={onApply}
        data-testid="filter-apply"
        style={touchTarget}
        className={`flex items-center justify-center gap-2 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
      >
        {t("collectionFilters.apply")}
        <span
          data-testid="filter-apply-count"
          aria-live="polite"
          className="font-mono tabular-nums"
        >
          {tPlural("collectionFilters.apply.count", resultCount)}
        </span>
      </button>
    </div>
  </div>
);

export interface CollectionFilterSheetProps {
  readonly open: boolean;
  /** Filtres actuellement appliqués : point de départ du brouillon à chaque ouverture. */
  readonly filters: CollectionFilters;
  readonly series: ReadonlyArray<FilterSeriesOption>;
  /** Classeurs de l'onglet affiché, pour le compteur de résultats en direct. */
  readonly binders: ReadonlyArray<BinderSummary>;
  readonly onApply: (filters: CollectionFilters) => void;
  readonly onClose: () => void;
}

const FilterSheetBody = ({
  filters,
  series,
  binders,
  onApply,
}: Pick<CollectionFilterSheetProps, "filters" | "series" | "binders" | "onApply">) => {
  const [draft, setDraft] = useState<CollectionFilters>(filters);
  return (
    <CollectionFilterForm
      draft={draft}
      series={series}
      resultCount={countFilteredBinders(binders, draft)}
      onChange={setDraft}
      onReset={() => setDraft(DEFAULT_COLLECTION_FILTERS)}
      onApply={() => onApply(draft)}
    />
  );
};

/**
 * Bottom sheet `02C · Filtres & Tri` (docs/01 §4.3) : tri 2×2, avancement, blocs
 * (multi-sélection), options (`role="switch"`), Réinitialiser + Appliquer avec compteur live.
 * Le brouillon vit dans le corps de la feuille (démonté à la fermeture) : annuler = fermer.
 */
export const CollectionFilterSheet = ({
  open,
  filters,
  series,
  binders,
  onApply,
  onClose,
}: CollectionFilterSheetProps) => (
  <BottomSheet open={open} onClose={onClose} title={t("collectionFilters.title")}>
    <FilterSheetBody filters={filters} series={series} binders={binders} onApply={onApply} />
  </BottomSheet>
);
