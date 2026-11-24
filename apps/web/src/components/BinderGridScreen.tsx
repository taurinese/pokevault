import { type CardLanguage, type CardVariant, tcgdexCardImageUrl } from "@pokevault/domain";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Heart,
  SearchX,
  Settings,
  Share2,
  SlidersHorizontal,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import { loginRedirectTo } from "../lib/auth-shared.ts";
import {
  BINDER_GRID_COLUMNS,
  type BinderGridAdvancedFilters,
  type BinderGridCard,
  type BinderGridPayload,
  type BinderGridQuickFilter,
  burstPathForSetId,
  cardTileStateFor,
  chunkIntoRows,
  countBinderGridQuickFilter,
  extractBinderFilterFacets,
  fetchBinderGrid,
  filterBinderGridCards,
  hasActiveAdvancedFilters,
} from "../lib/binder-grid-client.ts";
import { CardTile } from "./CardTile.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** État du chargement `GET /api/binder-grid/$id`. */
export type BinderGridLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "not-found" }
  | { readonly status: "ready"; readonly payload: BinderGridPayload };

export interface BinderGridViewState {
  readonly load: BinderGridLoad;
  readonly quickFilter: BinderGridQuickFilter;
  readonly advanced: BinderGridAdvancedFilters;
  readonly advancedOpen: boolean;
}

export interface BinderGridViewActions {
  readonly onQuickFilterChange: (filter: BinderGridQuickFilter) => void;
  readonly onAdvancedChange: (patch: BinderGridAdvancedFilters) => void;
  readonly onResetFilters: () => void;
  readonly onToggleAdvanced: () => void;
  /** Prêt pour le Bottom Sheet `04 · Fiche Carte` (T4.2). */
  readonly onSelectCard: (card: BinderGridCard) => void;
  readonly onRetry: () => void;
  /** Hook prêt pour T3.4 (réglages du classeur). */
  readonly onOpenSettings?: (() => void) | undefined;
  /** Hook prêt pour M4 (partage lecture seule) ; bouton désactivé sans callback. */
  readonly onOpenShare?: (() => void) | undefined;
}

export interface BinderGridViewProps {
  readonly state: BinderGridViewState;
  readonly actions: BinderGridViewActions;
}

// ---------------------------------------------------------------------------
// Constantes d'affichage
// ---------------------------------------------------------------------------

const QUICK_FILTERS: ReadonlyArray<{
  readonly id: BinderGridQuickFilter;
  readonly labelKey: TranslationKey;
}> = [
  { id: "all", labelKey: "binderGrid.filter.all" },
  { id: "owned", labelKey: "binderGrid.filter.owned" },
  { id: "missing", labelKey: "binderGrid.filter.missing" },
  { id: "duplicates", labelKey: "binderGrid.filter.duplicates" },
  { id: "wishlist", labelKey: "binderGrid.filter.wishlist" },
];

const LANGUAGES: ReadonlyArray<CardLanguage> = ["FR", "EN", "JP", "ZH"];
const LANGUAGE_LABELS: Record<CardLanguage, TranslationKey> = {
  FR: "binderGrid.language.FR",
  EN: "binderGrid.language.EN",
  JP: "binderGrid.language.JP",
  ZH: "binderGrid.language.ZH",
};
const VARIANTS: ReadonlyArray<CardVariant> = [
  "normal",
  "reverse",
  "holo",
  "promo",
  "pokeball",
  "masterball",
];
const VARIANT_LABELS: Record<CardVariant, TranslationKey> = {
  normal: "binderGrid.variant.normal",
  reverse: "binderGrid.variant.reverse",
  holo: "binderGrid.variant.holo",
  promo: "binderGrid.variant.promo",
  pokeball: "binderGrid.variant.pokeball",
  masterball: "binderGrid.variant.masterball",
};

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/** Pastille de filtre rapide : cible tactile ≥ 44px de haut, défilement horizontal. */
const quickPillClass = (active: boolean): string =>
  `inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border px-3.5 text-sm font-semibold transition-colors ${focusRing} ${
    active
      ? "border-gold bg-gold-soft text-gold"
      : "border-line bg-surface-1 text-secondary hover:text-primary"
  }`;

/** Bouton d'icône du header : cible tactile ≥ 44×44px. */
const headerIconButtonClass = (extra = ""): string =>
  `grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded-pill border border-line bg-surface-1 text-secondary transition-colors hover:text-primary disabled:opacity-40 ${focusRing} ${extra}`;

const goldButtonClass = `inline-flex min-h-11 items-center justify-center rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`;

/** Hauteur estimée d'une rangée (carte 63/88 + pied) avant mesure réelle. */
const ESTIMATED_ROW_HEIGHT_PX = 210;
/** Rangées rendues en flux normal côté serveur / avant montage (repli SSR propre). */
const SSR_FALLBACK_ROWS = 6;
/** `priority` (chargement eager) sur les 9 premières cartes de la grille. */
const PRIORITY_CARD_COUNT = 9;

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------

const SkeletonTile = () => (
  <div
    aria-hidden="true"
    className="w-full animate-pulse rounded-card border border-line bg-surface-2 motion-reduce:animate-none"
    style={{ aspectRatio: "63 / 88" }}
  />
);

const SkeletonGrid = () => (
  <div role="status" data-testid="binder-grid-loading" aria-label={t("binderGrid.loading")}>
    <span className="sr-only">{t("binderGrid.loading")}</span>
    <div className="grid grid-cols-3 gap-2.5">
      {Array.from({ length: 9 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
        <SkeletonTile key={index} />
      ))}
    </div>
  </div>
);

const CenteredNotice = ({
  testId,
  icon,
  title,
  description,
  children,
}: {
  readonly testId: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode | undefined;
}) => (
  <div className="flex flex-1 items-center justify-center px-6 py-10">
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-3 rounded-sheet border border-line bg-surface-1 px-6 py-10 text-center shadow-card"
    >
      <span aria-hidden="true" className="text-muted">
        {icon}
      </span>
      <h2 className="text-base font-bold text-primary">{title}</h2>
      <p className="max-w-xs text-sm text-secondary">{description}</p>
      {children}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// En-tête dédié (sticky) : retour, titre + code, actions, progression 1 ligne
// ---------------------------------------------------------------------------

const BinderHeader = ({
  state,
  actions,
}: {
  readonly state: BinderGridViewState;
  readonly actions: BinderGridViewActions;
}) => {
  const load = state.load;
  const binder = load.status === "ready" ? load.payload.binder : null;
  const stats = binder?.stats;
  return (
    <header
      data-testid="binder-header"
      className="sticky top-0 z-20 shrink-0 border-b border-line bg-canvas/95 px-4 pb-3 backdrop-blur"
      style={{ paddingTop: "calc(0.75rem + var(--safe-area-inset-top))" }}
    >
      {binder === null ? <h1 className="sr-only">{t("binderGrid.heading")}</h1> : null}
      <div className="flex items-center gap-2">
        <Link
          to="/collection"
          aria-label={t("binderGrid.back")}
          data-testid="binder-back"
          className={headerIconButtonClass()}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1">
          {binder === null ? (
            <div
              aria-hidden="true"
              className="h-5 w-40 animate-pulse rounded-pill bg-surface-2 motion-reduce:animate-none"
            />
          ) : (
            <>
              <h1 data-testid="binder-title" className="truncate text-base font-bold text-primary">
                {binder.title}
              </h1>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                {binder.setCode === null ? null : (
                  <span
                    data-testid="binder-set-code"
                    className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-secondary"
                  >
                    {binder.setCode}
                  </span>
                )}
                <span data-testid="binder-card-count">
                  {tPlural("binderGrid.cardCount", stats?.cardCount ?? 0)}
                </span>
              </p>
            </>
          )}
        </div>
        {binder !== null && binder.kind === "set" && binder.setId !== null ? (
          <a
            href={burstPathForSetId(binder.setId)}
            aria-label={t("binderGrid.burst")}
            data-testid="binder-burst-link"
            className={headerIconButtonClass("text-gold")}
          >
            <Zap size={18} aria-hidden="true" />
          </a>
        ) : null}
        <button
          type="button"
          aria-label={t("binderGrid.settings")}
          data-testid="binder-settings"
          disabled={binder === null || actions.onOpenSettings === undefined}
          onClick={() => actions.onOpenSettings?.()}
          className={headerIconButtonClass()}
        >
          <Settings size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("binderGrid.share")}
          data-testid="binder-share"
          disabled={binder === null || actions.onOpenShare === undefined}
          onClick={() => actions.onOpenShare?.()}
          className={headerIconButtonClass()}
        >
          <Share2 size={18} aria-hidden="true" />
        </button>
      </div>
      {binder === null || stats === undefined ? null : (
        <div
          data-testid="binder-progress"
          role="progressbar"
          aria-label={t("binderGrid.progress.label")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={stats.percent}
          className="mt-2.5 flex items-center gap-2"
        >
          <span
            data-testid="binder-percent"
            className="shrink-0 font-mono text-sm font-bold tabular-nums text-gold"
          >
            {`${stats.percent} %`}
          </span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-pill bg-surface-2">
            <div
              data-testid="binder-progress-bar"
              className="h-full rounded-pill bg-gold-bar"
              style={{ width: `${stats.percent}%` }}
            />
          </div>
          <span
            data-testid="binder-owned-count"
            className="shrink-0 font-mono text-[11px] tabular-nums text-secondary"
          >
            {t("binderGrid.progress.owned", { owned: stats.ownedCount, total: stats.cardCount })}
          </span>
          <span
            data-testid="binder-duplicates-count"
            className="shrink-0 font-mono text-[11px] tabular-nums text-muted"
          >
            {tPlural("binderGrid.progress.duplicates", stats.duplicateCardCount)}
          </span>
        </div>
      )}
    </header>
  );
};

// ---------------------------------------------------------------------------
// Filtres rapides + avancés
// ---------------------------------------------------------------------------

const FilterSelect = ({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string) => void;
}) => (
  <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-secondary">
    {label}
    <select
      id={id}
      data-testid={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`h-10 w-full rounded-card border border-line bg-surface-2 px-2 text-sm text-primary ${focusRing}`}
    >
      <option value="">{t("binderGrid.advanced.any")}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

const FiltersBar = ({
  state,
  actions,
  cards,
  facets,
}: {
  readonly state: BinderGridViewState;
  readonly actions: BinderGridViewActions;
  readonly cards: ReadonlyArray<BinderGridCard>;
  readonly facets: {
    readonly rarities: ReadonlyArray<string>;
    readonly types: ReadonlyArray<string>;
  };
}) => {
  const counts = useMemo(
    () =>
      Object.fromEntries(
        QUICK_FILTERS.map((filter) => [filter.id, countBinderGridQuickFilter(cards, filter.id)]),
      ) as Record<BinderGridQuickFilter, number>,
    [cards],
  );
  return (
    <>
      <fieldset className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 py-2.5">
        <legend className="sr-only">{t("binderGrid.filters.label")}</legend>
        {QUICK_FILTERS.map((filter) => {
          const active = state.quickFilter === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              data-testid={`quick-filter-${filter.id}`}
              aria-pressed={active}
              onClick={() => actions.onQuickFilterChange(filter.id)}
              className={quickPillClass(active)}
            >
              {t(filter.labelKey)}
              <span className="font-mono text-xs tabular-nums opacity-70">{counts[filter.id]}</span>
            </button>
          );
        })}
        <button
          type="button"
          data-testid="advanced-toggle"
          aria-expanded={state.advancedOpen}
          aria-controls="binder-advanced-filters"
          onClick={actions.onToggleAdvanced}
          className={quickPillClass(state.advancedOpen)}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t("binderGrid.advanced.toggle")}
        </button>
      </fieldset>
      {state.advancedOpen ? (
        <section
          id="binder-advanced-filters"
          data-testid="advanced-filters"
          aria-label={t("binderGrid.advanced.heading")}
          className="mx-4 mb-2 flex shrink-0 flex-col gap-3 rounded-sheet border border-line bg-surface-1 p-3 shadow-card"
        >
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("binderGrid.advanced.heading")}
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <FilterSelect
              id="advanced-rarity"
              label={t("binderGrid.advanced.rarity")}
              value={state.advanced.rarity ?? ""}
              options={facets.rarities.map((rarity) => ({ value: rarity, label: rarity }))}
              onChange={(value) =>
                actions.onAdvancedChange({
                  ...state.advanced,
                  rarity: value === "" ? null : value,
                })
              }
            />
            <FilterSelect
              id="advanced-type"
              label={t("binderGrid.advanced.type")}
              value={state.advanced.type ?? ""}
              options={facets.types.map((type) => ({ value: type, label: type }))}
              onChange={(value) =>
                actions.onAdvancedChange({ ...state.advanced, type: value === "" ? null : value })
              }
            />
            <FilterSelect
              id="advanced-language"
              label={t("binderGrid.advanced.language")}
              value={state.advanced.language ?? ""}
              options={LANGUAGES.map((language) => ({
                value: language,
                label: t(LANGUAGE_LABELS[language]),
              }))}
              onChange={(value) =>
                actions.onAdvancedChange({
                  ...state.advanced,
                  language: value === "" ? null : (value as CardLanguage),
                })
              }
            />
            <FilterSelect
              id="advanced-variant"
              label={t("binderGrid.advanced.variant")}
              value={state.advanced.variant ?? ""}
              options={VARIANTS.map((variant) => ({
                value: variant,
                label: t(VARIANT_LABELS[variant]),
              }))}
              onChange={(value) =>
                actions.onAdvancedChange({
                  ...state.advanced,
                  variant: value === "" ? null : (value as CardVariant),
                })
              }
            />
          </div>
          <button
            type="button"
            data-testid="advanced-reset"
            onClick={actions.onResetFilters}
            className={`self-start text-sm font-semibold text-gold ${focusRing} min-h-11 rounded-pill px-3`}
          >
            {t("binderGrid.advanced.reset")}
          </button>
        </section>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------
// Tuile de la grille (bouton accessible 63/88 → `onSelectCard`, prêt T4.2)
// ---------------------------------------------------------------------------

const GridCard = ({
  card,
  priority,
  onSelectCard,
}: {
  readonly card: BinderGridCard;
  readonly priority: boolean;
  readonly onSelectCard: (card: BinderGridCard) => void;
}) => {
  const tile = cardTileStateFor(card.totalQuantity);
  const missing = tile.state === "missing";
  const duplicateCount = tile.state === "duplicate" ? tile.count : 0;
  const ownershipLabel =
    tile.state === "duplicate"
      ? tPlural("cardTile.duplicate", duplicateCount, { name: card.nameFr })
      : missing
        ? t("cardTile.missing", { name: card.nameFr })
        : t("cardTile.owned", { name: card.nameFr });
  const baseAriaLabel = `${t("binderGrid.card.open", { name: card.nameFr, localId: card.localId })} — ${ownershipLabel}`;
  const ariaLabel =
    missing && card.inWishlist
      ? `${baseAriaLabel} — ${t("binderGrid.card.wishlist")}`
      : baseAriaLabel;
  return (
    <button
      type="button"
      data-testid="binder-card"
      data-card-id={card.id}
      data-state={tile.state}
      aria-label={ariaLabel}
      onClick={() => onSelectCard(card)}
      className={`flex min-w-0 flex-col gap-1 rounded-card text-left ${
        missing ? "border border-dashed border-line" : "border border-transparent"
      } ${focusRing}`}
    >
      <span className="relative block w-full">
        <CardTile
          name={card.nameFr}
          label={
            tile.state === "duplicate"
              ? tPlural("cardTile.duplicate", duplicateCount, { name: card.nameFr })
              : undefined
          }
          imageUrl={tcgdexCardImageUrl(card.imageBaseUrl, "low")}
          state={tile.state === "duplicate" ? "owned" : tile.state}
          priority={priority}
        />
        {tile.state === "owned" ? (
          <span
            aria-hidden="true"
            data-testid="badge-owned"
            className="absolute top-1.5 right-1.5 rounded-md border border-line bg-surface-1/90 px-1.5 py-0.5 font-mono text-xs tabular-nums text-secondary"
          >
            ×1
          </span>
        ) : null}
        {tile.state === "duplicate" ? (
          <span
            aria-hidden="true"
            data-testid="badge-duplicate"
            className="absolute top-1.5 right-1.5 rounded-md bg-gold-soft px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-gold"
          >
            ×{duplicateCount}
          </span>
        ) : null}
        {missing && card.inWishlist ? (
          <span
            aria-hidden="true"
            data-testid="badge-wishlist"
            className="absolute bottom-1.5 right-1.5 grid size-6 place-items-center rounded-pill bg-surface-1/90 text-accent-blue"
          >
            <Heart size={14} fill="currentColor" />
          </span>
        ) : null}
      </span>
      <span className="truncate font-mono text-[11px] tabular-nums text-muted">
        #{card.localId}
      </span>
      <span className="truncate text-xs font-semibold text-primary">{card.nameFr}</span>
    </button>
  );
};

// ---------------------------------------------------------------------------
// Grille 3 colonnes virtualisée par rangée (`@tanstack/react-virtual`)
// ---------------------------------------------------------------------------

const GridBody = ({
  cards,
  onSelectCard,
}: {
  readonly cards: ReadonlyArray<BinderGridCard>;
  readonly onSelectCard: (card: BinderGridCard) => void;
}) => {
  const scrollRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => chunkIntoRows(cards, BINDER_GRID_COLUMNS), [cards]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    // Cohérent avec `gap-2.5` (10 px) entre les colonnes et dans le repli SSR.
    gap: 10,
    overscan: 4,
  });
  const virtualRows = virtualizer.getVirtualItems();
  // Repli SSR / avant montage : les premières rangées en flux normal. Le premier
  // rendu client produit exactement le même HTML (virtualItems vide) → pas d'erreur
  // d'hydratation ; la virtualisation prend le relais après le montage.
  const useFallback = virtualRows.length === 0;

  return (
    <section
      ref={scrollRef}
      data-testid="binder-grid-scroll"
      aria-label={t("binderGrid.grid.label")}
      className="min-h-0 flex-1 overflow-y-auto px-4"
      style={{ paddingBottom: "calc(2.5rem + var(--safe-area-inset-bottom))" }}
    >
      {useFallback ? (
        <div data-testid="binder-grid" className="flex flex-col gap-2.5">
          {rows.slice(0, SSR_FALLBACK_ROWS).map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: repli SSR statique, rangées stables
            <div key={rowIndex} className="grid grid-cols-3 gap-2.5">
              {row.map((card, cardIndex) => (
                <GridCard
                  key={card.id}
                  card={card}
                  priority={rowIndex * BINDER_GRID_COLUMNS + cardIndex < PRIORITY_CARD_COUNT}
                  onSelectCard={onSelectCard}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div
          data-testid="binder-grid"
          style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
        >
          {virtualRows.map((virtualRow) => (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="grid grid-cols-3 gap-2.5"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {rows[virtualRow.index]?.map((card, cardIndex) => (
                <GridCard
                  key={card.id}
                  card={card}
                  priority={
                    virtualRow.index * BINDER_GRID_COLUMNS + cardIndex < PRIORITY_CARD_COUNT
                  }
                  onSelectCard={onSelectCard}
                />
              )) ?? null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Vue pure
// ---------------------------------------------------------------------------

/**
 * Écran `03 · Grille Classeur` : top bar dédiée (retour, titre + code extension,
 * actions saisie rafale / réglages / partage), barre de progression 1 ligne,
 * filtres rapides horizontaux + filtres avancés, et grille 3 colonnes virtualisée
 * par rangée (`overscan: 4`, vignettes `low.webp`, ratio `63/88`, repli SSR sur
 * les premières rangées). Zéro couleur hex brute : uniquement des tokens Dark/Light.
 */
export const BinderGridView = ({ state, actions }: BinderGridViewProps) => {
  const load = state.load;
  const payload = load.status === "ready" ? load.payload : null;
  const binder = payload?.binder ?? null;
  const allCards = useMemo(() => payload?.cards ?? [], [payload]);
  const facets = useMemo(() => extractBinderFilterFacets(allCards), [allCards]);
  const filtered = useMemo(
    () =>
      payload === null ? [] : filterBinderGridCards(allCards, state.quickFilter, state.advanced),
    [payload, allCards, state.quickFilter, state.advanced],
  );
  const filtersActive = state.quickFilter !== "all" || hasActiveAdvancedFilters(state.advanced);

  return (
    <main
      data-testid="binder-grid-screen"
      className="mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-canvas"
    >
      <BinderHeader state={state} actions={actions} />
      {load.status === "ready" && binder !== null ? (
        <>
          <FiltersBar state={state} actions={actions} cards={allCards} facets={facets} />
          {filtered.length === 0 ? (
            <CenteredNotice
              testId="binder-grid-empty"
              icon={<SearchX size={28} />}
              title={
                allCards.length === 0
                  ? t("binderGrid.empty.binderTitle")
                  : t("binderGrid.empty.title")
              }
              description={
                allCards.length === 0
                  ? t("binderGrid.empty.binderDescription")
                  : t("binderGrid.empty.description")
              }
            >
              {filtersActive ? (
                <button
                  type="button"
                  data-testid="empty-reset"
                  onClick={actions.onResetFilters}
                  className={goldButtonClass}
                >
                  {t("binderGrid.empty.reset")}
                </button>
              ) : null}
            </CenteredNotice>
          ) : (
            <GridBody cards={filtered} onSelectCard={actions.onSelectCard} />
          )}
        </>
      ) : load.status === "loading" ? (
        <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
          <SkeletonGrid />
        </div>
      ) : load.status === "not-found" ? (
        <CenteredNotice
          testId="binder-grid-not-found"
          icon={<SearchX size={28} />}
          title={t("binderGrid.notFound.title")}
          description={t("binderGrid.notFound.description")}
        >
          <Link to="/collection" data-testid="not-found-back" className={goldButtonClass}>
            {t("binderGrid.notFound.back")}
          </Link>
        </CenteredNotice>
      ) : (
        <CenteredNotice
          testId="binder-grid-error"
          icon={<TriangleAlert size={28} />}
          title={t("binderGrid.error.title")}
          description={t("binderGrid.error.description")}
        >
          <button
            type="button"
            data-testid="binder-retry"
            onClick={actions.onRetry}
            className={goldButtonClass}
          >
            {t("binderGrid.error.retry")}
          </button>
        </CenteredNotice>
      )}
    </main>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : fetch `/api/binder-grid/$id`, état, retry
// ---------------------------------------------------------------------------

export interface BinderGridScreenProps {
  readonly binderId: string;
  /** Prêt pour le branchement direct du Bottom Sheet `04 · Fiche Carte` (T4.2). */
  readonly onSelectCard?: ((card: BinderGridCard) => void) | undefined;
  /**
   * Jeton de rechargement silencieux (T4.2) : quand il change, la grille est
   * rechargée sans repasser par l'état `loading` ni perdre les filtres actifs
   * (badges `×N` et barre de complétion mis à jour en direct après une
   * mutation dans la Fiche Carte).
   */
  readonly reloadToken?: number | undefined;
  /** Hook prêt pour T3.4 (réglages du classeur). */
  readonly onOpenSettings?: (() => void) | undefined;
  /** Hook prêt pour M4 (partage lecture seule). */
  readonly onOpenShare?: (() => void) | undefined;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/**
 * Écran `03` complet : charge le payload du classeur puis pilote la vue pure.
 * 401 → redirection `/login?redirect=/binder/$id` (la route est aussi protégée SSR).
 */
export const BinderGridScreen = ({
  binderId,
  onSelectCard,
  reloadToken = 0,
  onOpenSettings,
  onOpenShare,
}: BinderGridScreenProps) => {
  const [load, setLoad] = useState<BinderGridLoad>({ status: "loading" });
  const [quickFilter, setQuickFilter] = useState<BinderGridQuickFilter>("all");
  const [advanced, setAdvanced] = useState<BinderGridAdvancedFilters>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // Identifiant du classeur actuellement chargé : les rechargements suivants
  // sur le MÊME classeur (`reloadToken`, mutations Fiche Carte T4.2) sont
  // silencieux ; un changement de `binderId` repasse proprement en `loading`.
  const loadedBinderIdRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryToken`/`reloadToken` relancent volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    const silent = loadedBinderIdRef.current === binderId;
    if (!silent) {
      loadedBinderIdRef.current = null;
      setLoad({ status: "loading" });
    }
    fetchBinderGrid(binderId, controller.signal)
      .then((result) => {
        if (result.kind === "ok") {
          loadedBinderIdRef.current = result.payload.binder === null ? null : binderId;
          setLoad(
            result.payload.binder === null
              ? { status: "not-found" }
              : { status: "ready", payload: result.payload },
          );
        } else if (result.kind === "not-found") {
          loadedBinderIdRef.current = null;
          setLoad({ status: "not-found" });
        } else if (result.kind === "unauthorized") {
          window.location.assign(loginRedirectTo(`/binder/${encodeURIComponent(binderId)}`));
        } else {
          loadedBinderIdRef.current = null;
          setLoad({ status: "error" });
        }
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          loadedBinderIdRef.current = null;
          setLoad({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [binderId, retryToken, reloadToken]);

  const actions: BinderGridViewActions = {
    onQuickFilterChange: setQuickFilter,
    onAdvancedChange: (patch) => setAdvanced((current) => ({ ...current, ...patch })),
    onResetFilters: () => {
      setQuickFilter("all");
      setAdvanced({});
    },
    onToggleAdvanced: () => setAdvancedOpen((open) => !open),
    onSelectCard: (card) => onSelectCard?.(card),
    onRetry: () => {
      loadedBinderIdRef.current = null;
      setRetryToken((token) => token + 1);
    },
    ...(onOpenSettings === undefined ? {} : { onOpenSettings }),
    ...(onOpenShare === undefined ? {} : { onOpenShare }),
  };

  return <BinderGridView state={{ load, quickFilter, advanced, advancedOpen }} actions={actions} />;
};
