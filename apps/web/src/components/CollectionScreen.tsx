import {
  BINDER_TITLE_MAX_LENGTH,
  type BinderSummary,
  type SeriesOverviewEntry,
  tcgdexSetLogoUrl,
} from "@pokevault/domain";
import {
  CircleAlert,
  FolderPlus,
  LibraryBig,
  Plus,
  Search,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import { loginRedirectTo } from "../lib/auth-shared.ts";
import {
  applyCollectionFiltersAndSort,
  type BindersPayload,
  type CatalogSetEntry,
  COLLECTION_PATH,
  type CollectionFilters,
  type CreateBinderResult,
  countActiveCollectionFilters,
  DEFAULT_COLLECTION_FILTERS,
  fetchBinders,
  filterTrackableSets,
  followSet,
  type SubmitFolderResult,
  submitCustomFolder,
  trackedSetIdsOf,
} from "../lib/binders-client.ts";
import { BinderCard } from "./BinderCard.tsx";
import { type BinderSettingsChange, BinderSettingsSheet } from "./BinderSettingsSheet.tsx";
import { BottomSheet } from "./BottomSheet.tsx";
import { CollectionFilterSheet } from "./CollectionFilterSheet.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** État d'un chargement asynchrone. */
export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly data: T };

/** `sets` = `02` (Extensions) · `custom` = `02B` (Dossiers perso). */
export type CollectionTab = "sets" | "custom";

export type CreateFolderError = "empty" | "too_long" | "invalid" | "conflict" | "generic" | null;

export interface FollowSheetState {
  readonly open: boolean;
  readonly query: string;
  /** Extension en cours d'ajout (ligne désactivée). */
  readonly pendingSetId: string | null;
  readonly error: boolean;
}

export interface CreateSheetState {
  readonly open: boolean;
  readonly title: string;
  readonly pinned: boolean;
  readonly submitting: boolean;
  readonly error: CreateFolderError;
}

export interface CollectionViewState {
  readonly tab: CollectionTab;
  readonly data: Loadable<BindersPayload>;
  /** Bloc sélectionné (`null` = Tous). */
  readonly seriesId: string | null;
  /** Filtres & tri appliqués (bottom sheet `02C`). */
  readonly filters: CollectionFilters;
  readonly filtersOpen: boolean;
  /** Classeur dont les réglages sont ouverts (`null` : feuille fermée). */
  readonly settingsBinderId: string | null;
  readonly follow: FollowSheetState;
  readonly create: CreateSheetState;
  /** Message annoncé aux lecteurs d'écran (région `role="status"`). */
  readonly announcement: string;
}

export interface CollectionViewActions {
  readonly onTabChange: (tab: CollectionTab) => void;
  readonly onSelectSeries: (seriesId: string | null) => void;
  readonly onRetry: () => void;
  readonly onOpenFollow: () => void;
  readonly onCloseFollow: () => void;
  readonly onFollowQueryChange: (query: string) => void;
  readonly onFollowSet: (set: CatalogSetEntry) => void;
  readonly onOpenCreate: () => void;
  readonly onCloseCreate: () => void;
  readonly onCreateTitleChange: (title: string) => void;
  readonly onCreatePinnedChange: (pinned: boolean) => void;
  readonly onSubmitCreate: () => void;
  readonly onOpenFilters: () => void;
  readonly onCloseFilters: () => void;
  readonly onApplyFilters: (filters: CollectionFilters) => void;
  readonly onOpenSettings: (summary: BinderSummary) => void;
  readonly onCloseSettings: () => void;
  readonly onSettingsChanged: (change: BinderSettingsChange) => void;
  readonly onSettingsDeleted: (title: string) => void;
  readonly onUnauthorized: () => void;
}

// ---------------------------------------------------------------------------
// Dérivations pures
// ---------------------------------------------------------------------------

export interface SeriesGroup {
  readonly series: SeriesOverviewEntry;
  /** Extensions du catalogue pour ce bloc (suivies ou non). */
  readonly availableCount: number;
  readonly binders: ReadonlyArray<BinderSummary>;
}

/**
 * Regroupe les classeurs d'extension par bloc, dans l'ordre de
 * `overview.series` (blocs récents d'abord). Seuls les blocs comportant au
 * moins un classeur suivi sont retournés.
 */
export const buildSeriesGroups = (
  data: BindersPayload,
  filters: CollectionFilters = DEFAULT_COLLECTION_FILTERS,
): ReadonlyArray<SeriesGroup> => {
  const setBinders = applyCollectionFiltersAndSort(
    data.binders.filter(({ binder }) => binder.kind === "set"),
    filters,
  );
  return data.overview.series.flatMap((series) => {
    const binders = setBinders.filter(({ set }) => set?.seriesId === series.seriesId);
    if (binders.length === 0) return [];
    const catalogCount = data.catalogSets.filter((set) => set.seriesId === series.seriesId).length;
    return [
      {
        series,
        availableCount: Math.max(catalogCount, series.completion.setCount, binders.length),
        binders,
      },
    ];
  });
};

export const customBinders = (
  data: BindersPayload,
  filters: CollectionFilters = DEFAULT_COLLECTION_FILTERS,
): ReadonlyArray<BinderSummary> =>
  applyCollectionFiltersAndSort(
    data.binders.filter(({ binder }) => binder.kind === "custom"),
    filters,
  );

/** Blocs proposés par le filtre « Bloc / Série » : ceux qui comptent au moins un classeur suivi. */
export const filterSeriesOptions = (
  data: BindersPayload,
): ReadonlyArray<{ readonly id: string; readonly name: string }> =>
  buildSeriesGroups(data).map((group) => ({
    id: group.series.seriesId,
    name: group.series.nameFr,
  }));

const CREATE_ERROR_KEYS: Readonly<Record<Exclude<CreateFolderError, null>, TranslationKey>> = {
  empty: "collection.create.error.empty",
  too_long: "collection.create.error.tooLong",
  invalid: "collection.create.error.invalid",
  conflict: "collection.create.error.conflict",
  generic: "collection.create.error.generic",
};

/** Résultat d'une soumission de dossier → erreur affichable (`null` : succès / à gérer ailleurs). */
export const createErrorOf = (result: SubmitFolderResult): CreateFolderError => {
  switch (result.kind) {
    case "invalid_title":
      return result.reason;
    case "invalid":
      return "invalid";
    case "conflict":
      return "conflict";
    case "ok":
    case "unauthorized":
      return null;
    default:
      return "generic";
  }
};

/** Un ajout d'extension est réussi, y compris quand elle était déjà suivie (`409`). */
export const isFollowSuccess = (result: CreateBinderResult): boolean =>
  result.kind === "ok" || result.kind === "conflict";

// ---------------------------------------------------------------------------
// Briques visuelles
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;

const GRID = "grid grid-cols-2 gap-3";

const StateNotice = ({
  testId,
  icon,
  title,
  description,
  action,
}: {
  readonly testId: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) => (
  <div
    data-testid={testId}
    className="flex flex-col items-center gap-3 rounded-sheet border border-line bg-surface-1 px-6 py-10 text-center shadow-card"
  >
    <span aria-hidden="true" className="text-muted">
      {icon}
    </span>
    <h2 className="text-base font-bold text-primary">{title}</h2>
    <p className="max-w-xs text-sm text-secondary">{description}</p>
    {action === undefined ? null : (
      <button
        type="button"
        onClick={action.onClick}
        style={touchTarget}
        className={`rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
      >
        {action.label}
      </button>
    )}
  </div>
);

const SkeletonGrid = () => (
  <div
    role="status"
    aria-label={t("collection.loading")}
    data-testid="collection-skeleton"
    className={`${GRID} motion-reduce:animate-none`}
  >
    {Array.from({ length: 4 }, (_, index) => (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
        key={index}
        aria-hidden="true"
        className="aspect-3/4 animate-pulse rounded-sheet border border-line bg-surface-2"
      />
    ))}
  </div>
);

const ProgressBar = ({ percent, label }: { readonly percent: number; readonly label: string }) => (
  <div
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
    className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-2"
  >
    <div className="h-full rounded-pill bg-gold-bar" style={{ width: `${percent}%` }} />
  </div>
);

// ---------------------------------------------------------------------------
// En-tête
// ---------------------------------------------------------------------------

const CollectionHeader = ({
  data,
  filters,
  onOpenFilters,
}: {
  readonly data: Loadable<BindersPayload>;
  readonly filters: CollectionFilters;
  readonly onOpenFilters: () => void;
}) => {
  const activeFilters = countActiveCollectionFilters(filters);
  const global = data.status === "ready" ? data.data.overview.global : null;
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-bold text-primary">{t("collection.heading")}</h1>
          {global === null ? null : (
            <p
              data-testid="collection-summary"
              className="flex flex-wrap items-baseline gap-x-2 text-sm text-secondary"
            >
              <span className="font-mono font-semibold tabular-nums text-gold">
                {t("collection.summary.percent", { percent: global.percent })}
              </span>
              <span className="font-mono tabular-nums">
                {tPlural("collection.summary.copies", global.totalCopies)}
              </span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href="/burst"
            aria-label={t("collection.burst.aria")}
            style={touchTarget}
            className={`flex items-center gap-1.5 rounded-pill border border-gold bg-gold-soft px-3 text-sm font-semibold text-gold ${focusRing}`}
          >
            <Zap size={16} aria-hidden="true" />
            {t("collection.burst")}
          </a>
          <button
            type="button"
            onClick={onOpenFilters}
            aria-label={t("collection.filters.aria")}
            data-testid="filters-button"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            className={`relative flex items-center justify-center rounded-pill border bg-surface-1 transition-colors hover:text-primary ${focusRing} ${
              activeFilters > 0 ? "border-gold text-gold" : "border-line text-secondary"
            }`}
          >
            <SlidersHorizontal size={18} aria-hidden="true" />
            <span className="sr-only">{t("collection.filters")}</span>
            {activeFilters > 0 ? (
              <>
                <span
                  aria-hidden="true"
                  data-testid="filters-badge"
                  className="absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-pill border border-gold bg-surface-1 px-1 font-mono text-xs font-bold tabular-nums text-gold"
                >
                  {activeFilters}
                </span>
                <span className="sr-only">
                  {tPlural("collection.filters.active", activeFilters)}
                </span>
              </>
            ) : null}
          </button>
        </div>
      </div>
    </header>
  );
};

// ---------------------------------------------------------------------------
// Contrôle segmenté
// ---------------------------------------------------------------------------

const TABS: ReadonlyArray<{ readonly id: CollectionTab; readonly labelKey: TranslationKey }> = [
  { id: "sets", labelKey: "collection.tab.sets" },
  { id: "custom", labelKey: "collection.tab.custom" },
];

const tabId = (id: CollectionTab): string => `collection-tab-${id}`;
const panelId = (id: CollectionTab): string => `collection-panel-${id}`;

const SegmentedTabs = ({
  tab,
  onTabChange,
}: {
  readonly tab: CollectionTab;
  readonly onTabChange: (tab: CollectionTab) => void;
}) => {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    const target = next === null ? undefined : TABS[next];
    if (target === undefined) return;
    event.preventDefault();
    onTabChange(target.id);
    document.getElementById(tabId(target.id))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t("collection.tabs.label")}
      className="grid grid-cols-2 gap-1 rounded-pill border border-line bg-surface-1 p-1"
    >
      {TABS.map((entry) => {
        const selected = entry.id === tab;
        return (
          <button
            key={entry.id}
            id={tabId(entry.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId(entry.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onTabChange(entry.id)}
            onKeyDown={onKeyDown}
            style={touchTarget}
            className={`rounded-pill px-3 text-sm font-semibold transition-colors ${focusRing} ${
              selected ? "bg-gold-soft text-gold" : "text-secondary hover:text-primary"
            }`}
          >
            {t(entry.labelKey)}
          </button>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Onglet Extensions (02)
// ---------------------------------------------------------------------------

const SeriesPills = ({
  groups,
  seriesId,
  onSelectSeries,
}: {
  readonly groups: ReadonlyArray<SeriesGroup>;
  readonly seriesId: string | null;
  readonly onSelectSeries: (seriesId: string | null) => void;
}) => {
  const pills: ReadonlyArray<{ readonly id: string | null; readonly label: string }> = [
    { id: null, label: t("collection.series.all") },
    ...groups.map((group) => ({ id: group.series.seriesId, label: group.series.nameFr })),
  ];
  return (
    <fieldset className="-mx-4 flex min-w-0 gap-2 overflow-x-auto border-0 p-0 px-4 pb-1">
      <legend className="sr-only">{t("collection.series.label")}</legend>
      {pills.map((pill) => {
        const active = pill.id === seriesId;
        return (
          <button
            key={pill.id ?? "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onSelectSeries(pill.id)}
            style={touchTarget}
            className={`shrink-0 rounded-pill border px-4 text-sm font-semibold whitespace-nowrap transition-colors ${focusRing} ${
              active
                ? "border-accent-blue bg-surface-2 text-accent-blue"
                : "border-line bg-surface-1 text-secondary hover:text-primary"
            }`}
          >
            {pill.label}
          </button>
        );
      })}
    </fieldset>
  );
};

const SeriesSection = ({
  group,
  coverCardImageById,
  onOpenSettings,
  priorityFirst,
}: {
  readonly group: SeriesGroup;
  readonly coverCardImageById: BindersPayload["coverCardImageById"];
  readonly onOpenSettings: (summary: BinderSummary) => void;
  readonly priorityFirst: boolean;
}) => {
  const { series } = group;
  const headingId = `series-${series.seriesId}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="series-section"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={headingId} className="min-w-0 truncate text-base font-bold text-primary">
            {series.nameFr}
          </h2>
          <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-gold">
            {t("binderCard.percent", { percent: series.completion.percent })}
          </span>
        </div>
        <ProgressBar
          percent={series.completion.percent}
          label={t("collection.series.progress", { name: series.nameFr })}
        />
        <p className="font-mono text-xs tabular-nums text-secondary">
          {t("collection.series.tracked", {
            tracked: group.binders.length,
            available: group.availableCount,
          })}
        </p>
      </div>
      <div className={GRID}>
        {group.binders.map((summary, index) => (
          <BinderCard
            key={summary.binder.id}
            summary={summary}
            coverCardImageBaseUrl={
              summary.binder.coverCardId === null
                ? null
                : (coverCardImageById[summary.binder.coverCardId] ?? null)
            }
            priority={priorityFirst && index < 2}
            onOpenSettings={onOpenSettings}
          />
        ))}
      </div>
    </section>
  );
};

const FollowButton = ({ onClick }: { readonly onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid="follow-cta"
    style={touchTarget}
    className={`flex w-full items-center justify-center gap-2 rounded-pill border border-dashed border-gold px-4 text-sm font-semibold text-gold ${focusRing}`}
  >
    <Plus size={16} aria-hidden="true" />
    {t("collection.follow.cta")}
  </button>
);

const FilteredEmpty = ({ onReset }: { readonly onReset: () => void }) => (
  <StateNotice
    testId="filtered-empty"
    icon={<SlidersHorizontal size={32} strokeWidth={1.5} />}
    title={t("collection.filtered.empty.title")}
    description={t("collection.filtered.empty.description")}
    action={{ label: t("collection.filtered.empty.reset"), onClick: onReset }}
  />
);

const SetsPanel = ({
  state,
  data,
  actions,
}: {
  readonly state: CollectionViewState;
  readonly data: BindersPayload;
  readonly actions: CollectionViewActions;
}) => {
  // Les pills de bloc restent celles de la collection entière : un filtre ne les fait pas disparaître.
  const allGroups = buildSeriesGroups(data);
  const groups = buildSeriesGroups(data, state.filters);
  // Un bloc sélectionné qui n'existe plus (suppression…) retombe sur « Tous ».
  const activeSeriesId = allGroups.some((group) => group.series.seriesId === state.seriesId)
    ? state.seriesId
    : null;
  const visible = groups.filter(
    (group) => activeSeriesId === null || group.series.seriesId === activeSeriesId,
  );

  if (allGroups.length === 0) {
    return (
      <StateNotice
        testId="sets-empty"
        icon={<LibraryBig size={32} strokeWidth={1.5} />}
        title={t("collection.sets.empty.title")}
        description={t("collection.sets.empty.description")}
        action={{ label: t("collection.follow.cta"), onClick: actions.onOpenFollow }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SeriesPills
        groups={allGroups}
        seriesId={activeSeriesId}
        onSelectSeries={actions.onSelectSeries}
      />
      {visible.length === 0 ? (
        <FilteredEmpty onReset={() => actions.onApplyFilters(DEFAULT_COLLECTION_FILTERS)} />
      ) : null}
      {visible.map((group, index) => (
        <SeriesSection
          key={group.series.seriesId}
          group={group}
          coverCardImageById={data.coverCardImageById}
          onOpenSettings={actions.onOpenSettings}
          priorityFirst={index === 0}
        />
      ))}
      <FollowButton onClick={actions.onOpenFollow} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Onglet Dossiers perso (02B)
// ---------------------------------------------------------------------------

const NewFolderCard = ({ onClick }: { readonly onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid="new-folder-card"
    className={`flex aspect-3/4 flex-col items-center justify-center gap-2 rounded-sheet border-2 border-dashed border-line bg-surface-1 p-3 text-center text-secondary transition-colors hover:border-gold hover:text-gold ${focusRing}`}
  >
    <FolderPlus size={28} strokeWidth={1.5} aria-hidden="true" />
    <span className="text-sm font-semibold">
      <span aria-hidden="true">+ </span>
      {t("collection.custom.new")}
    </span>
  </button>
);

const CustomPanel = ({
  data,
  filters,
  actions,
}: {
  readonly data: BindersPayload;
  readonly filters: CollectionFilters;
  readonly actions: CollectionViewActions;
}) => {
  const folders = customBinders(data, filters);
  const hasFolders = customBinders(data).length > 0;
  return (
    <div className="flex flex-col gap-4">
      {hasFolders && folders.length === 0 ? (
        <FilteredEmpty onReset={() => actions.onApplyFilters(DEFAULT_COLLECTION_FILTERS)} />
      ) : null}
      {!hasFolders ? (
        <div data-testid="custom-empty" className="flex flex-col gap-1">
          <h2 className="text-base font-bold text-primary">{t("collection.custom.empty.title")}</h2>
          <p className="text-sm text-secondary">{t("collection.custom.empty.description")}</p>
        </div>
      ) : null}
      <div className={GRID}>
        {folders.map((summary, index) => (
          <BinderCard
            key={summary.binder.id}
            summary={summary}
            coverCardImageBaseUrl={
              summary.binder.coverCardId === null
                ? null
                : (data.coverCardImageById[summary.binder.coverCardId] ?? null)
            }
            priority={index < 2}
            onOpenSettings={actions.onOpenSettings}
          />
        ))}
        <NewFolderCard onClick={actions.onOpenCreate} />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Feuilles : suivre une extension · nouveau dossier
// ---------------------------------------------------------------------------

const SetLogo = ({ set }: { readonly set: CatalogSetEntry }) => {
  const src = tcgdexSetLogoUrl(set.logoUrl);
  return src === undefined ? (
    <span
      aria-hidden="true"
      className="flex h-10 w-14 shrink-0 items-center justify-center rounded-md bg-surface-2 font-mono text-xs font-bold tabular-nums text-secondary"
    >
      {set.code ?? set.id}
    </span>
  ) : (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-10 w-14 shrink-0 rounded-md bg-surface-2 object-contain p-1"
    />
  );
};

/** Plafond de lignes rendues (le filtre rapide réduit la liste). */
const MAX_FOLLOW_ROWS = 100;

const FollowSheet = ({
  state,
  data,
  actions,
}: {
  readonly state: FollowSheetState;
  readonly data: BindersPayload | null;
  readonly actions: CollectionViewActions;
}) => {
  const candidates = useMemo(
    () =>
      data === null
        ? []
        : filterTrackableSets(data.catalogSets, trackedSetIdsOf(data.binders), state.query),
    [data, state.query],
  );
  const shown = candidates.slice(0, MAX_FOLLOW_ROWS);
  const emptyMessage =
    data === null || data.catalogSets.length === 0
      ? t("collection.follow.noCatalog")
      : state.query.trim() !== ""
        ? t("collection.follow.noResult", { query: state.query.trim() })
        : t("collection.follow.allTracked");

  return (
    <BottomSheet
      open={state.open}
      onClose={actions.onCloseFollow}
      title={t("collection.follow.title")}
    >
      <div className="flex flex-col gap-3" data-testid="follow-sheet">
        <label className="relative block">
          <span className="sr-only">{t("collection.follow.search.label")}</span>
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={state.query}
            onChange={(event) => actions.onFollowQueryChange(event.target.value)}
            placeholder={t("collection.follow.search.placeholder")}
            autoComplete="off"
            style={touchTarget}
            className={`w-full rounded-pill border border-line bg-surface-2 pr-4 pl-9 text-sm text-primary placeholder:text-muted ${focusRing}`}
          />
        </label>
        {state.error ? (
          <p
            role="alert"
            data-testid="follow-error"
            className="flex items-center gap-2 text-sm text-danger"
          >
            <CircleAlert size={16} aria-hidden="true" />
            {t("collection.follow.error")}
          </p>
        ) : null}
        {shown.length === 0 ? (
          <p data-testid="follow-empty" className="py-6 text-center text-sm text-secondary">
            {emptyMessage}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {shown.map((set) => {
              const pending = state.pendingSetId === set.id;
              return (
                <li key={set.id}>
                  <button
                    type="button"
                    onClick={() => actions.onFollowSet(set)}
                    disabled={state.pendingSetId !== null}
                    aria-label={t("collection.follow.row", { name: set.nameFr })}
                    style={{ minHeight: "var(--touch-target-min)" }}
                    className={`flex w-full items-center gap-3 rounded-sheet border border-line bg-surface-1 px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-60 ${focusRing}`}
                  >
                    <SetLogo set={set} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-semibold text-primary">
                        {set.nameFr}
                      </span>
                      <span className="truncate text-xs text-secondary">{set.seriesNameFr}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                      {pending
                        ? t("collection.follow.pending")
                        : tPlural("collection.follow.cardCount", set.totalCount)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
};

const CreateSheet = ({
  state,
  actions,
}: {
  readonly state: CreateSheetState;
  readonly actions: CollectionViewActions;
}) => {
  const errorId = "create-folder-error";
  const length = state.title.length;
  return (
    <BottomSheet
      open={state.open}
      onClose={actions.onCloseCreate}
      title={t("collection.create.title")}
    >
      <form
        data-testid="create-sheet"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          actions.onSubmitCreate();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="create-folder-title" className="text-sm font-semibold text-primary">
            {t("collection.create.name.label")}
          </label>
          <input
            id="create-folder-title"
            type="text"
            value={state.title}
            maxLength={BINDER_TITLE_MAX_LENGTH}
            onChange={(event) => actions.onCreateTitleChange(event.target.value)}
            placeholder={t("collection.create.name.placeholder")}
            autoComplete="off"
            aria-invalid={state.error !== null}
            aria-describedby={state.error === null ? undefined : errorId}
            style={touchTarget}
            className={`w-full rounded-pill border bg-surface-2 px-4 text-sm text-primary placeholder:text-muted ${focusRing} ${
              state.error === null ? "border-line" : "border-danger"
            }`}
          />
          <div className="flex items-start justify-between gap-3">
            {state.error === null ? (
              <span />
            ) : (
              <p
                id={errorId}
                role="alert"
                data-testid="create-error"
                className="text-sm text-danger"
              >
                {t(CREATE_ERROR_KEYS[state.error], { max: BINDER_TITLE_MAX_LENGTH })}
              </p>
            )}
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
              {t("collection.create.counter", { count: length, max: BINDER_TITLE_MAX_LENGTH })}
            </span>
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm text-primary">
          <input
            type="checkbox"
            checked={state.pinned}
            onChange={(event) => actions.onCreatePinnedChange(event.target.checked)}
            className={`size-5 accent-gold ${focusRing}`}
          />
          {t("collection.create.pin")}
        </label>
        <button
          type="submit"
          disabled={state.submitting}
          style={touchTarget}
          className={`rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold disabled:opacity-60 ${focusRing}`}
        >
          {state.submitting ? t("collection.create.submitting") : t("collection.create.submit")}
        </button>
      </form>
    </BottomSheet>
  );
};

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

export interface CollectionViewProps {
  readonly state: CollectionViewState;
  readonly actions: CollectionViewActions;
}

export const CollectionView = ({ state, actions }: CollectionViewProps) => {
  const ready = state.data.status === "ready" ? state.data.data : null;
  const settingsSummary =
    ready === null || state.settingsBinderId === null
      ? null
      : (ready.binders.find(({ binder }) => binder.id === state.settingsBinderId) ?? null);
  // Compteur live de la feuille Filtres : classeurs de l'onglet affiché.
  const tabKind = state.tab === "sets" ? "set" : "custom";
  const tabBinders = ready?.binders.filter(({ binder }) => binder.kind === tabKind) ?? [];
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 pt-10 pb-40">
      <CollectionHeader
        data={state.data}
        filters={state.filters}
        onOpenFilters={actions.onOpenFilters}
      />
      <SegmentedTabs tab={state.tab} onTabChange={actions.onTabChange} />
      <div
        role="tabpanel"
        id={panelId(state.tab)}
        aria-labelledby={tabId(state.tab)}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: le panneau d'onglet doit être atteignable au clavier (pattern ARIA tabs)
        tabIndex={0}
        className="flex flex-col gap-4 outline-none"
      >
        {state.data.status === "loading" ? <SkeletonGrid /> : null}
        {state.data.status === "error" ? (
          <StateNotice
            testId="collection-error"
            icon={<CircleAlert size={32} strokeWidth={1.5} />}
            title={t("collection.error.title")}
            description={t("collection.error.description")}
            action={{ label: t("collection.error.retry"), onClick: actions.onRetry }}
          />
        ) : null}
        {ready !== null && state.tab === "sets" ? (
          <SetsPanel state={state} data={ready} actions={actions} />
        ) : null}
        {ready !== null && state.tab === "custom" ? (
          <CustomPanel data={ready} filters={state.filters} actions={actions} />
        ) : null}
      </div>
      <p role="status" aria-live="polite" data-testid="collection-announcer" className="sr-only">
        {state.announcement}
      </p>
      <FollowSheet state={state.follow} data={ready} actions={actions} />
      <CreateSheet state={state.create} actions={actions} />
      <CollectionFilterSheet
        open={state.filtersOpen && ready !== null}
        filters={state.filters}
        series={ready === null ? [] : filterSeriesOptions(ready)}
        binders={tabBinders}
        onApply={actions.onApplyFilters}
        onClose={actions.onCloseFilters}
      />
      <BinderSettingsSheet
        summary={settingsSummary}
        onClose={actions.onCloseSettings}
        onChanged={actions.onSettingsChanged}
        onDeleted={actions.onSettingsDeleted}
        onUnauthorized={actions.onUnauthorized}
      />
    </main>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : chargement, mutations, rafraîchissement
// ---------------------------------------------------------------------------

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const redirectToLogin = (): void => {
  window.location.assign(loginRedirectTo(COLLECTION_PATH));
};

const CLOSED_FOLLOW: FollowSheetState = {
  open: false,
  query: "",
  pendingSetId: null,
  error: false,
};

const CLOSED_CREATE: CreateSheetState = {
  open: false,
  title: "",
  pinned: false,
  submitting: false,
  error: null,
};

export const CollectionScreen = () => {
  const [tab, setTab] = useState<CollectionTab>("sets");
  const [data, setData] = useState<Loadable<BindersPayload>>({ status: "loading" });
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionFilters>(DEFAULT_COLLECTION_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsBinderId, setSettingsBinderId] = useState<string | null>(null);
  const [follow, setFollow] = useState<FollowSheetState>(CLOSED_FOLLOW);
  const [create, setCreate] = useState<CreateSheetState>(CLOSED_CREATE);
  const [announcement, setAnnouncement] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  // Les rechargements après mutation gardent l'écran affiché (pas de retour au squelette).
  const [silentReload, setSilentReload] = useState(false);

  // « Inclure les cartes promos / secrètes » est un paramètre de calcul serveur : le changer recharge.
  const includeExtras = filters.includeSecretsAndPromos;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    if (!silentReload) setData({ status: "loading" });
    fetchBinders(controller.signal, undefined, { includeSecretsAndPromos: includeExtras })
      .then((result) => {
        if (result.kind === "ok") setData({ status: "ready", data: result.data });
        else if (result.kind === "unauthorized") redirectToLogin();
        else
          setData((current) =>
            silentReload && current.status === "ready" ? current : { status: "error" },
          );
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setData({ status: "error" });
      });
    return () => controller.abort();
  }, [reloadToken, includeExtras]);

  const reload = (silent: boolean): void => {
    setSilentReload(silent);
    setReloadToken((token) => token + 1);
  };

  const actions: CollectionViewActions = {
    onTabChange: setTab,
    onSelectSeries: setSeriesId,
    onRetry: () => reload(false),
    onOpenFollow: () => setFollow({ ...CLOSED_FOLLOW, open: true }),
    onCloseFollow: () => setFollow(CLOSED_FOLLOW),
    onFollowQueryChange: (query) => setFollow((current) => ({ ...current, query })),
    onFollowSet: (set) => {
      if (follow.pendingSetId !== null) return;
      setFollow((current) => ({ ...current, pendingSetId: set.id, error: false }));
      void followSet(set.id).then((result) => {
        if (result.kind === "unauthorized") return redirectToLogin();
        if (isFollowSuccess(result)) {
          setFollow(CLOSED_FOLLOW);
          setSeriesId(null);
          setAnnouncement(t("collection.follow.announce", { name: set.nameFr }));
          reload(true);
        } else {
          setFollow((current) => ({ ...current, pendingSetId: null, error: true }));
        }
      });
    },
    onOpenCreate: () => setCreate({ ...CLOSED_CREATE, open: true }),
    onCloseCreate: () => setCreate(CLOSED_CREATE),
    onOpenFilters: () => setFiltersOpen(true),
    onCloseFilters: () => setFiltersOpen(false),
    onApplyFilters: (next) => {
      setFilters(next);
      setFiltersOpen(false);
      // Un changement d'« extras » relance le chargement (silencieux) via `includeExtras`.
      if (next.includeSecretsAndPromos !== includeExtras) setSilentReload(true);
      if (data.status === "ready") {
        const tabKind = tab === "sets" ? "set" : "custom";
        const count = applyCollectionFiltersAndSort(
          data.data.binders.filter(({ binder }) => binder.kind === tabKind),
          next,
        ).length;
        setAnnouncement(tPlural("collection.filtered.announce", count));
      }
    },
    onOpenSettings: (summary) => setSettingsBinderId(summary.binder.id),
    onCloseSettings: () => setSettingsBinderId(null),
    onSettingsChanged: (change) => {
      setAnnouncement(
        t(
          change.kind === "cover"
            ? "collection.settings.announce.cover"
            : "collection.settings.announce.saved",
          { title: change.title },
        ),
      );
      reload(true);
    },
    onSettingsDeleted: (title) => {
      setSettingsBinderId(null);
      setAnnouncement(t("collection.settings.announce.deleted", { title }));
      reload(true);
    },
    onUnauthorized: redirectToLogin,
    onCreateTitleChange: (title) => setCreate((current) => ({ ...current, title, error: null })),
    onCreatePinnedChange: (pinned) => setCreate((current) => ({ ...current, pinned })),
    onSubmitCreate: () => {
      if (create.submitting) return;
      setCreate((current) => ({ ...current, submitting: true, error: null }));
      void submitCustomFolder(create.title, create.pinned).then((result) => {
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok") {
          setCreate(CLOSED_CREATE);
          setTab("custom");
          setAnnouncement(t("collection.create.announce", { title: result.summary.binder.title }));
          reload(true);
        } else {
          setCreate((current) => ({ ...current, submitting: false, error: createErrorOf(result) }));
        }
      });
    },
  };

  return (
    <CollectionView
      state={{
        tab,
        data,
        seriesId,
        filters,
        filtersOpen,
        settingsBinderId,
        follow,
        create,
        announcement,
      }}
      actions={actions}
    />
  );
};
