import {
  addRecentSearch,
  type CardSearchHit,
  clearRecentSearches,
  removeRecentSearch,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_QUERY_LENGTH,
  type SearchDiscoveryPayload,
  type SearchQuery,
  type SearchQuickAccess,
  type SearchResultsPayload,
  type SearchScope,
  type SearchSort,
  type SearchSuggestionsPayload,
  type SearchViewMode,
  type SetSearchHit,
} from "@pokevault/domain";
import { Heart, LayoutGrid, List, Plus, Search, SearchX, TriangleAlert, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import { loginRedirectTo, SEARCH_PATH } from "../lib/auth-shared.ts";
import {
  type ApiResult,
  fetchDiscovery,
  fetchResults,
  fetchSuggestions,
  loadRecentSearches,
  saveRecentSearches,
} from "../lib/search-client.ts";
import { CardTile } from "./CardTile.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** État d'un chargement asynchrone. */
export type Loadable<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly data: T };

/** `neutral` = 05A · `suggest` = 05B · `results` = 05C (liste) / 05D (grille). */
export type SearchMode = "neutral" | "suggest" | "results";

export interface ActiveSetFilter {
  readonly id: string;
  readonly name: string;
}

export interface SearchViewState {
  readonly mode: SearchMode;
  readonly input: string;
  readonly scope: SearchScope;
  readonly sort: SearchSort;
  readonly viewMode: SearchViewMode;
  readonly quickAccess?: SearchQuickAccess | undefined;
  readonly activeSet: ActiveSetFilter | null;
  readonly recents: ReadonlyArray<string>;
  readonly discovery: Loadable<SearchDiscoveryPayload>;
  readonly suggestions: Loadable<SearchSuggestionsPayload>;
  readonly results: Loadable<SearchResultsPayload>;
  readonly loadingMore: boolean;
  readonly wishlistIds: ReadonlySet<string>;
  /** Message annoncé aux lecteurs d'écran (région `role="status"`). */
  readonly announcement: string;
}

export interface SearchViewActions {
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClearInput: () => void;
  readonly onFocus: () => void;
  readonly onBlur: (relatedTarget: EventTarget | null) => void;
  readonly onEscape: () => void;
  readonly onScopeChange: (scope: SearchScope) => void;
  readonly onSortChange: (sort: SearchSort) => void;
  readonly onViewModeChange: (viewMode: SearchViewMode) => void;
  readonly onToggleQuickAccess: (quickAccess: SearchQuickAccess) => void;
  readonly onSelectSet: (set: SetSearchHit) => void;
  readonly onClearSet: () => void;
  readonly onPickRecent: (query: string) => void;
  readonly onRemoveRecent: (query: string) => void;
  readonly onClearRecents: () => void;
  readonly onPickSuggestedCard: (card: CardSearchHit) => void;
  readonly onSeeAll: () => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onReset: () => void;
  readonly onToggleWishlist: (card: CardSearchHit) => void;
  readonly onQuickAdd: (card: CardSearchHit) => void;
}

// ---------------------------------------------------------------------------
// Constantes d'affichage
// ---------------------------------------------------------------------------

const SCOPES: ReadonlyArray<{ readonly id: SearchScope; readonly labelKey: TranslationKey }> = [
  { id: "all", labelKey: "search.scope.all" },
  { id: "cards", labelKey: "search.scope.cards" },
  { id: "sets", labelKey: "search.scope.sets" },
  { id: "illustrators", labelKey: "search.scope.illustrators" },
];

const QUICK_ACCESSES: ReadonlyArray<{
  readonly id: SearchQuickAccess;
  readonly labelKey: TranslationKey;
}> = [
  { id: "sir", labelKey: "search.quick.sir" },
  { id: "ar", labelKey: "search.quick.ar" },
  { id: "ex", labelKey: "search.quick.ex" },
  { id: "tera", labelKey: "search.quick.tera" },
  { id: "promos", labelKey: "search.quick.promos" },
];

const SORTS: ReadonlyArray<{ readonly id: SearchSort; readonly labelKey: TranslationKey }> = [
  { id: "relevance", labelKey: "search.results.sort.relevance" },
  { id: "number", labelKey: "search.results.sort.number" },
  { id: "name", labelKey: "search.results.sort.name" },
];

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/** Pastille ≥ 44px de haut (cible tactile). */
const pillClass = (active: boolean): string =>
  `inline-flex min-h-11 shrink-0 items-center justify-center rounded-pill border px-4 text-sm font-semibold transition-colors ${focusRing} ${
    active
      ? "border-gold bg-gold-soft text-gold"
      : "border-line bg-surface-1 text-secondary hover:text-primary"
  }`;

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------

/** Enveloppe en `font-mono tabular-nums` le nombre `value` d'un libellé déjà traduit. */
const NumberedText = ({ text, value }: { readonly text: string; readonly value: number }) => {
  const needle = String(value);
  const index = text.indexOf(needle);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <span className="font-mono tabular-nums">{needle}</span>
      {text.slice(index + needle.length)}
    </>
  );
};

const SectionTitle = ({ id, children }: { readonly id: string; readonly children: ReactNode }) => (
  <h2 id={id} className="text-xs font-semibold tracking-wide text-muted uppercase">
    {children}
  </h2>
);

const cardCountLabel = (count: number): string => tPlural("search.popularSets.cardCount", count);

const SetLogo = ({ set, className }: { readonly set: SetSearchHit; readonly className: string }) =>
  set.logoUrl === null ? (
    <span
      aria-hidden="true"
      className={`${className} flex items-center justify-center font-mono text-sm font-bold tabular-nums text-secondary`}
    >
      {set.code ?? set.id}
    </span>
  ) : (
    <img
      src={set.logoUrl}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className} object-contain`}
    />
  );

const SkeletonCard = () => (
  <div
    aria-hidden="true"
    className="w-full animate-pulse rounded-card border border-line bg-surface-2"
    style={{ aspectRatio: "63 / 88" }}
  />
);

const CardGridSkeleton = ({ count }: { readonly count: number }) => (
  <ul
    aria-hidden="true"
    data-testid="search-skeleton"
    className="grid grid-cols-3 gap-2.5 motion-reduce:animate-none"
  >
    {Array.from({ length: count }, (_, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
      <li key={index}>
        <SkeletonCard />
      </li>
    ))}
  </ul>
);

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
        className={`min-h-11 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
      >
        {action.label}
      </button>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Actions rapides sur une carte (♥ wishlist · + ajout rapide)
// ---------------------------------------------------------------------------

type ActionsLayout = "overlay" | "inline";

const CardActions = ({
  card,
  wishlisted,
  layout,
  onToggleWishlist,
  onQuickAdd,
}: {
  readonly card: CardSearchHit;
  readonly wishlisted: boolean;
  readonly layout: ActionsLayout;
  readonly onToggleWishlist: (card: CardSearchHit) => void;
  readonly onQuickAdd: (card: CardSearchHit) => void;
}) => {
  // Overlay (grille) : pastille visuelle 32px, zone tactile étendue à 44px.
  const buttonClass =
    layout === "overlay"
      ? `relative grid size-8 place-items-center rounded-pill border border-line bg-surface-1/90 shadow-card after:absolute after:-inset-1.5 after:content-[''] ${focusRing}`
      : `grid size-11 place-items-center rounded-pill border border-line bg-surface-2 ${focusRing}`;
  return (
    <div
      className={
        layout === "overlay"
          ? "pointer-events-none absolute inset-x-1.5 top-1.5 flex justify-between [&>button]:pointer-events-auto"
          : "flex shrink-0 items-center gap-1.5"
      }
    >
      <button
        type="button"
        data-testid="card-wishlist"
        aria-pressed={wishlisted}
        aria-label={t(wishlisted ? "search.card.wishlistRemove" : "search.card.wishlistAdd", {
          name: card.nameFr,
        })}
        onClick={() => onToggleWishlist(card)}
        className={`${buttonClass} ${wishlisted ? "text-danger" : "text-secondary"}`}
      >
        <Heart size={layout === "overlay" ? 16 : 18} fill={wishlisted ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        data-testid="card-quick-add"
        aria-label={t("search.card.quickAdd", { name: card.nameFr })}
        onClick={() => onQuickAdd(card)}
        className={`${buttonClass} text-primary`}
      >
        <Plus size={layout === "overlay" ? 16 : 18} />
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Carte : grille (05D) et ligne de liste (05C)
// ---------------------------------------------------------------------------

const cardMeta = (card: CardSearchHit): string =>
  [card.setName, card.setCode].filter((part): part is string => part !== null).join(" · ");

const CardGridItem = ({
  card,
  wishlisted,
  actions,
  priority,
}: {
  readonly card: CardSearchHit;
  readonly wishlisted: boolean;
  readonly actions: SearchViewActions;
  readonly priority: boolean;
}) => (
  <li data-testid="result-card" className="flex min-w-0 flex-col gap-1.5">
    <div className="relative">
      <CardTile
        name={card.nameFr}
        label={card.nameFr}
        imageUrl={card.imageUrl ?? undefined}
        priority={priority}
      />
      <CardActions
        card={card}
        wishlisted={wishlisted}
        layout="overlay"
        onToggleWishlist={actions.onToggleWishlist}
        onQuickAdd={actions.onQuickAdd}
      />
    </div>
    <p className="truncate text-xs font-semibold text-primary">{card.nameFr}</p>
    <p className="truncate font-mono text-[11px] tabular-nums text-muted">#{card.localId}</p>
  </li>
);

const CardListItem = ({
  card,
  wishlisted,
  actions,
  priority,
}: {
  readonly card: CardSearchHit;
  readonly wishlisted: boolean;
  readonly actions: SearchViewActions;
  readonly priority: boolean;
}) => (
  <li
    data-testid="result-card"
    className="flex items-center gap-3 rounded-sheet border border-line bg-surface-1 p-2.5 shadow-card"
  >
    <div className="w-14 shrink-0">
      <CardTile
        name={card.nameFr}
        label={card.nameFr}
        imageUrl={card.imageUrl ?? undefined}
        priority={priority}
      />
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <p className="truncate text-sm font-semibold text-primary">{card.nameFr}</p>
      <p className="truncate text-xs text-secondary">
        {cardMeta(card)}
        {cardMeta(card) === "" ? null : " · "}
        <span className="font-mono tabular-nums">#{card.localId}</span>
      </p>
      {card.rarity === null ? null : <p className="truncate text-xs text-muted">{card.rarity}</p>}
    </div>
    <CardActions
      card={card}
      wishlisted={wishlisted}
      layout="inline"
      onToggleWishlist={actions.onToggleWishlist}
      onQuickAdd={actions.onQuickAdd}
    />
  </li>
);

const CardResults = ({
  cards,
  viewMode,
  wishlistIds,
  actions,
}: {
  readonly cards: ReadonlyArray<CardSearchHit>;
  readonly viewMode: SearchViewMode;
  readonly wishlistIds: ReadonlySet<string>;
  readonly actions: SearchViewActions;
}) =>
  viewMode === "grid" ? (
    <ul data-testid="results-grid" className="grid grid-cols-3 gap-x-2.5 gap-y-3.5">
      {cards.map((card, index) => (
        <CardGridItem
          key={card.id}
          card={card}
          wishlisted={wishlistIds.has(card.id)}
          actions={actions}
          priority={index < 6}
        />
      ))}
    </ul>
  ) : (
    <ul data-testid="results-list" className="flex flex-col gap-2">
      {cards.map((card, index) => (
        <CardListItem
          key={card.id}
          card={card}
          wishlisted={wishlistIds.has(card.id)}
          actions={actions}
          priority={index < 4}
        />
      ))}
    </ul>
  );

// ---------------------------------------------------------------------------
// En-tête sticky : champ de recherche + portées
// ---------------------------------------------------------------------------

const SearchHeader = ({
  state,
  actions,
  inputRef,
}: {
  readonly state: SearchViewState;
  readonly actions: SearchViewActions;
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
}) => (
  <header
    data-testid="search-header"
    className="sticky top-0 z-20 flex flex-col gap-3 border-b border-line bg-canvas/95 px-4 pb-3 backdrop-blur"
    style={{ paddingTop: "calc(1rem + var(--safe-area-inset-top))" }}
  >
    <h1 className="sr-only">{t("search.heading")}</h1>
    <search>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          actions.onSubmit();
        }}
        className="relative"
      >
        <label htmlFor="search-input" className="sr-only">
          {t("search.input.label")}
        </label>
        <Search
          size={18}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted"
        />
        <input
          ref={inputRef}
          id="search-input"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={SEARCH_MAX_QUERY_LENGTH}
          value={state.input}
          placeholder={t("search.input.placeholder")}
          onChange={(event) => actions.onInputChange(event.target.value)}
          onFocus={actions.onFocus}
          onBlur={(event) => actions.onBlur(event.relatedTarget)}
          onKeyDown={(event) => {
            if (event.key === "Escape") actions.onEscape();
          }}
          className={`h-12 w-full rounded-pill border border-line bg-surface-1 pr-14 pl-11 text-base text-primary placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none ${focusRing}`}
        />
        {state.input === "" ? null : (
          <button
            type="button"
            data-testid="search-clear"
            aria-label={t("search.input.clear")}
            onClick={actions.onClearInput}
            className={`absolute top-1/2 right-0.5 grid size-11 -translate-y-1/2 place-items-center rounded-pill text-secondary hover:text-primary ${focusRing}`}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </form>
    </search>
    <fieldset className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4">
      <legend className="sr-only">{t("search.scope.label")}</legend>
      {SCOPES.map((scope) => (
        <button
          key={scope.id}
          type="button"
          aria-pressed={state.scope === scope.id}
          onClick={() => actions.onScopeChange(scope.id)}
          className={pillClass(state.scope === scope.id)}
        >
          {t(scope.labelKey)}
        </button>
      ))}
    </fieldset>
  </header>
);

// ---------------------------------------------------------------------------
// 05A · État neutre
// ---------------------------------------------------------------------------

const QuickAccessPills = ({
  active,
  onToggle,
}: {
  readonly active: SearchQuickAccess | undefined;
  readonly onToggle: (quickAccess: SearchQuickAccess) => void;
}) => (
  <ul className="flex flex-wrap gap-2">
    {QUICK_ACCESSES.map((quick) => (
      <li key={quick.id}>
        <button
          type="button"
          aria-pressed={active === quick.id}
          onClick={() => onToggle(quick.id)}
          className={pillClass(active === quick.id)}
        >
          {t(quick.labelKey)}
        </button>
      </li>
    ))}
  </ul>
);

const PopularSets = ({
  sets,
  onSelect,
}: {
  readonly sets: ReadonlyArray<SetSearchHit>;
  readonly onSelect: (set: SetSearchHit) => void;
}) => (
  <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
    {sets.map((set) => (
      <li key={set.id} className="w-36 shrink-0">
        <button
          type="button"
          data-testid="popular-set"
          aria-label={t("search.popularSets.open", { name: set.nameFr })}
          onClick={() => onSelect(set)}
          className={`flex h-full w-full flex-col gap-2 rounded-sheet border border-line bg-surface-1 p-3 text-left shadow-card ${focusRing}`}
        >
          <SetLogo set={set} className="h-10 w-full" />
          <span className="font-mono text-xs font-semibold tabular-nums text-gold">
            {set.code ?? set.id}
          </span>
          <span className="line-clamp-2 text-sm font-semibold text-primary">{set.nameFr}</span>
          <span className="text-xs text-muted">
            <NumberedText text={cardCountLabel(set.totalCount)} value={set.totalCount} />
          </span>
        </button>
      </li>
    ))}
  </ul>
);

const NeutralState = ({
  state,
  actions,
}: {
  readonly state: SearchViewState;
  readonly actions: SearchViewActions;
}) => {
  const { discovery } = state;
  const discoveryEmpty =
    discovery.status === "ready" &&
    discovery.data.popularSets.length === 0 &&
    discovery.data.featuredCards.length === 0;

  return (
    <div data-testid="search-neutral" className="flex flex-col gap-7">
      <section aria-labelledby="search-popular-sets" className="flex flex-col gap-3">
        <SectionTitle id="search-popular-sets">{t("search.popularSets.heading")}</SectionTitle>
        {discovery.status === "ready" && discovery.data.popularSets.length > 0 ? (
          <PopularSets sets={discovery.data.popularSets} onSelect={actions.onSelectSet} />
        ) : discovery.status === "ready" ? null : discovery.status === "error" ? (
          <StateNotice
            testId="discovery-error"
            icon={<TriangleAlert size={28} />}
            title={t("search.error.title")}
            description={t("search.error.description")}
            action={{ label: t("search.error.retry"), onClick: actions.onRetry }}
          />
        ) : (
          <div aria-hidden="true" className="flex gap-3" data-testid="search-skeleton">
            {[0, 1, 2].map((key) => (
              <div
                key={key}
                className="h-36 w-36 shrink-0 animate-pulse rounded-sheet border border-line bg-surface-2"
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="search-quick-access" className="flex flex-col gap-3">
        <SectionTitle id="search-quick-access">{t("search.quick.heading")}</SectionTitle>
        <QuickAccessPills active={state.quickAccess} onToggle={actions.onToggleQuickAccess} />
      </section>

      {discoveryEmpty ? (
        <StateNotice
          testId="catalog-empty"
          icon={<SearchX size={28} />}
          title={t("search.emptyCatalog.title")}
          description={t("search.emptyCatalog.description")}
        />
      ) : (
        <section aria-labelledby="search-discovery" className="flex flex-col gap-3">
          <SectionTitle id="search-discovery">{t("search.discovery.heading")}</SectionTitle>
          {discovery.status === "ready" ? (
            <CardResults
              cards={discovery.data.featuredCards}
              viewMode="grid"
              wishlistIds={state.wishlistIds}
              actions={actions}
            />
          ) : discovery.status === "loading" ? (
            <CardGridSkeleton count={6} />
          ) : null}
        </section>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 05B · Saisie, récentes & suggestions
// ---------------------------------------------------------------------------

const SuggestionSetRow = ({
  set,
  onSelect,
}: {
  readonly set: SetSearchHit;
  readonly onSelect: (set: SetSearchHit) => void;
}) => (
  <li>
    <button
      type="button"
      data-testid="suggestion-set"
      onClick={() => onSelect(set)}
      className={`flex min-h-14 w-full items-center gap-3 rounded-sheet px-2 py-1.5 text-left hover:bg-surface-1 ${focusRing}`}
    >
      <SetLogo set={set} className="h-9 w-14 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-primary">{set.nameFr}</span>
        <span className="truncate text-xs text-muted">
          <span className="font-mono tabular-nums">{set.code ?? set.id}</span>
          {" · "}
          <NumberedText text={cardCountLabel(set.totalCount)} value={set.totalCount} />
        </span>
      </span>
    </button>
  </li>
);

const SuggestionCardRow = ({
  card,
  onSelect,
}: {
  readonly card: CardSearchHit;
  readonly onSelect: (card: CardSearchHit) => void;
}) => (
  <li>
    <button
      type="button"
      data-testid="suggestion-card"
      onClick={() => onSelect(card)}
      className={`flex min-h-16 w-full items-center gap-3 rounded-sheet px-2 py-1.5 text-left hover:bg-surface-1 ${focusRing}`}
    >
      <span className="w-10 shrink-0">
        <CardTile name={card.nameFr} label={card.nameFr} imageUrl={card.imageUrl ?? undefined} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-primary">{card.nameFr}</span>
        <span className="truncate text-xs text-secondary">
          {card.setName}
          {" · "}
          <span className="font-mono tabular-nums">#{card.localId}</span>
        </span>
        {card.rarity === null ? null : (
          <span className="truncate text-xs text-muted">{card.rarity}</span>
        )}
      </span>
    </button>
  </li>
);

const RecentSearches = ({
  recents,
  actions,
}: {
  readonly recents: ReadonlyArray<string>;
  readonly actions: SearchViewActions;
}) => (
  <section aria-labelledby="search-recents" className="flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <SectionTitle id="search-recents">{t("search.recents.heading")}</SectionTitle>
      {recents.length === 0 ? null : (
        <button
          type="button"
          data-testid="recents-clear-all"
          onClick={actions.onClearRecents}
          className={`min-h-11 rounded-pill px-3 text-sm font-semibold text-gold ${focusRing}`}
        >
          {t("search.recents.clearAll")}
        </button>
      )}
    </div>
    {recents.length === 0 ? (
      <p className="text-sm text-muted">{t("search.recents.empty")}</p>
    ) : (
      <ul className="flex flex-col">
        {recents.map((recent) => (
          <li key={recent} data-testid="recent-item" className="flex items-center">
            <button
              type="button"
              data-testid="recent-pick"
              onClick={() => actions.onPickRecent(recent)}
              className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-pill px-2 text-left text-sm text-primary hover:bg-surface-1 ${focusRing}`}
            >
              <Search size={16} aria-hidden="true" className="shrink-0 text-muted" />
              <span className="truncate">{recent}</span>
            </button>
            <button
              type="button"
              data-testid="recent-remove"
              aria-label={t("search.recents.remove", { query: recent })}
              onClick={() => actions.onRemoveRecent(recent)}
              className={`grid size-11 shrink-0 place-items-center rounded-pill text-muted hover:text-primary ${focusRing}`}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    )}
  </section>
);

const SuggestState = ({
  state,
  actions,
}: {
  readonly state: SearchViewState;
  readonly actions: SearchViewActions;
}) => {
  const query = state.input.trim();
  const { suggestions } = state;
  const hasSuggestions =
    suggestions.status === "ready" &&
    (suggestions.data.cards.length > 0 || suggestions.data.sets.length > 0);

  return (
    <div data-testid="search-suggest" className="flex flex-col gap-6">
      {query === "" ? <RecentSearches recents={state.recents} actions={actions} /> : null}

      {query === "" ? null : (
        <section aria-labelledby="search-suggestions" className="flex flex-col gap-4">
          <h2 id="search-suggestions" className="sr-only">
            {t("search.suggest.heading")}
          </h2>
          {suggestions.status === "loading" || suggestions.status === "idle" ? (
            <div role="status" data-testid="suggest-loading" className="flex flex-col gap-2">
              <span className="sr-only">{t("search.suggest.loading")}</span>
              {[0, 1, 2].map((key) => (
                <div
                  key={key}
                  aria-hidden="true"
                  className="h-14 animate-pulse rounded-sheet bg-surface-2"
                />
              ))}
            </div>
          ) : suggestions.status === "error" ? (
            <StateNotice
              testId="suggest-error"
              icon={<TriangleAlert size={24} />}
              title={t("search.error.title")}
              description={t("search.error.description")}
            />
          ) : hasSuggestions ? (
            <>
              {suggestions.data.sets.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <SectionTitle id="suggest-sets">{t("search.suggest.sets")}</SectionTitle>
                  <ul aria-labelledby="suggest-sets" className="flex flex-col">
                    {suggestions.data.sets.map((set) => (
                      <SuggestionSetRow key={set.id} set={set} onSelect={actions.onSelectSet} />
                    ))}
                  </ul>
                </div>
              )}
              {suggestions.data.cards.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <SectionTitle id="suggest-cards">{t("search.suggest.cards")}</SectionTitle>
                  <ul aria-labelledby="suggest-cards" className="flex flex-col">
                    {suggestions.data.cards.map((card) => (
                      <SuggestionCardRow
                        key={card.id}
                        card={card}
                        onSelect={actions.onPickSuggestedCard}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p data-testid="suggest-empty" className="text-sm text-muted">
              {t("search.suggest.empty", { query })}
            </p>
          )}
          <button
            type="button"
            data-testid="suggest-see-all"
            onClick={actions.onSeeAll}
            className={`flex min-h-11 items-center gap-2 rounded-pill border border-line bg-surface-1 px-4 text-sm font-semibold text-primary ${focusRing}`}
          >
            <Search size={16} aria-hidden="true" />
            <span className="truncate">{t("search.suggest.seeAll", { query })}</span>
          </button>
        </section>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 05C / 05D · Résultats
// ---------------------------------------------------------------------------

const FilterChip = ({
  label,
  onRemove,
}: {
  readonly label: string;
  readonly onRemove: () => void;
}) => (
  <li>
    <button
      type="button"
      data-testid="filter-chip"
      aria-label={t("search.filters.remove", { label })}
      onClick={onRemove}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-gold bg-gold-soft pr-3 pl-4 text-sm font-semibold text-gold ${focusRing}`}
    >
      {label}
      <X size={14} aria-hidden="true" />
    </button>
  </li>
);

const ResultSetRow = ({
  set,
  onSelect,
}: {
  readonly set: SetSearchHit;
  readonly onSelect: (set: SetSearchHit) => void;
}) => (
  <li>
    <button
      type="button"
      data-testid="result-set"
      aria-label={t("search.popularSets.open", { name: set.nameFr })}
      onClick={() => onSelect(set)}
      className={`flex min-h-16 w-full items-center gap-3 rounded-sheet border border-line bg-surface-1 p-2.5 text-left shadow-card ${focusRing}`}
    >
      <SetLogo set={set} className="h-10 w-16 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-primary">{set.nameFr}</span>
        <span className="truncate text-xs text-muted">
          <span className="font-mono tabular-nums">{set.code ?? set.id}</span>
          {" · "}
          <NumberedText text={cardCountLabel(set.totalCount)} value={set.totalCount} />
        </span>
      </span>
    </button>
  </li>
);

const ResultsState = ({
  state,
  actions,
}: {
  readonly state: SearchViewState;
  readonly actions: SearchViewActions;
}) => {
  const { results } = state;
  const filters: Array<{
    readonly key: string;
    readonly label: string;
    readonly clear: () => void;
  }> = [];
  if (state.activeSet !== null) {
    filters.push({
      key: "set",
      label: t("search.filters.set", { name: state.activeSet.name }),
      clear: actions.onClearSet,
    });
  }
  if (state.quickAccess !== undefined) {
    const quick = state.quickAccess;
    const labelKey = QUICK_ACCESSES.find((entry) => entry.id === quick)?.labelKey;
    if (labelKey !== undefined) {
      filters.push({
        key: "quick",
        label: t(labelKey),
        clear: () => actions.onToggleQuickAccess(quick),
      });
    }
  }

  return (
    <div data-testid="search-results" data-view={state.viewMode} className="flex flex-col gap-4">
      {filters.length === 0 ? null : (
        <ul aria-label={t("search.filters.label")} className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <FilterChip key={filter.key} label={filter.label} onRemove={filter.clear} />
          ))}
        </ul>
      )}

      {results.status === "error" ? (
        <StateNotice
          testId="results-error"
          icon={<TriangleAlert size={28} />}
          title={t("search.error.title")}
          description={t("search.error.description")}
          action={{ label: t("search.error.retry"), onClick: actions.onRetry }}
        />
      ) : results.status !== "ready" ? (
        <div role="status" data-testid="results-loading">
          <span className="sr-only">{t("search.results.loading")}</span>
          <CardGridSkeleton count={9} />
        </div>
      ) : (
        <ResultsReady payload={results.data} state={state} actions={actions} />
      )}
    </div>
  );
};

const ResultsReady = ({
  payload,
  state,
  actions,
}: {
  readonly payload: SearchResultsPayload;
  readonly state: SearchViewState;
  readonly actions: SearchViewActions;
}) => {
  const total = payload.totalCards + payload.totalSets;
  if (total === 0) {
    return (
      <StateNotice
        testId="results-empty"
        icon={<SearchX size={28} />}
        title={t("search.empty.title")}
        description={t("search.empty.description")}
        action={{ label: t("search.empty.reset"), onClick: actions.onReset }}
      />
    );
  }
  const canLoadMore = payload.cards.length < payload.totalCards;
  return (
    <>
      <div
        data-testid="results-bar"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
      >
        <p data-testid="results-count" className="text-sm font-semibold text-primary">
          <NumberedText text={tPlural("search.results.count", total)} value={total} />
        </p>
        <fieldset className="flex min-w-0 items-center gap-1 rounded-pill border border-line bg-surface-1 p-1">
          <legend className="sr-only">{t("search.results.view.label")}</legend>
          {(
            [
              { id: "grid", Icon: LayoutGrid, labelKey: "search.results.view.grid" },
              { id: "list", Icon: List, labelKey: "search.results.view.list" },
            ] as const
          ).map(({ id, Icon, labelKey }) => (
            <button
              key={id}
              type="button"
              aria-pressed={state.viewMode === id}
              aria-label={t(labelKey)}
              data-testid={`view-${id}`}
              onClick={() => actions.onViewModeChange(id)}
              className={`grid size-9 place-items-center rounded-pill ${focusRing} ${
                state.viewMode === id ? "bg-gold-soft text-gold" : "text-secondary"
              }`}
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          ))}
        </fieldset>
      </div>

      <fieldset className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4">
        <legend className="sr-only">{t("search.results.sort.label")}</legend>
        {SORTS.map((sort) => (
          <button
            key={sort.id}
            type="button"
            aria-pressed={state.sort === sort.id}
            onClick={() => actions.onSortChange(sort.id)}
            className={pillClass(state.sort === sort.id)}
          >
            {t(sort.labelKey)}
          </button>
        ))}
      </fieldset>

      {payload.sets.length === 0 ? null : (
        <section aria-labelledby="results-sets" className="flex flex-col gap-2">
          <SectionTitle id="results-sets">{t("search.results.sets.heading")}</SectionTitle>
          <ul className="flex flex-col gap-2">
            {payload.sets.map((set) => (
              <ResultSetRow key={set.id} set={set} onSelect={actions.onSelectSet} />
            ))}
          </ul>
        </section>
      )}

      {payload.cards.length === 0 ? null : (
        <section aria-labelledby="results-cards" className="flex flex-col gap-2">
          <SectionTitle id="results-cards">{t("search.results.cards.heading")}</SectionTitle>
          <CardResults
            cards={payload.cards}
            viewMode={state.viewMode}
            wishlistIds={state.wishlistIds}
            actions={actions}
          />
        </section>
      )}

      {canLoadMore ? (
        <button
          type="button"
          data-testid="load-more"
          disabled={state.loadingMore}
          onClick={actions.onLoadMore}
          className={`min-h-11 self-center rounded-pill border border-line bg-surface-1 px-6 text-sm font-semibold text-primary disabled:opacity-50 ${focusRing}`}
        >
          {t("search.results.loadMore")}
        </button>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------
// Vue pure
// ---------------------------------------------------------------------------

export interface SearchViewProps {
  readonly state: SearchViewState;
  readonly actions: SearchViewActions;
  readonly inputRef?: RefObject<HTMLInputElement | null> | undefined;
}

/**
 * Écrans `05A–05D` : rendu pur piloté par `state` / `actions` (testable via
 * `renderToStaticMarkup`). Marge basse = hauteur de la pilule flottante +
 * safe-area, pour que la navbar ne masque jamais le dernier résultat.
 */
export const SearchView = ({ state, actions, inputRef }: SearchViewProps) => (
  <main
    data-testid="search-screen"
    data-mode={state.mode}
    className="mx-auto flex min-h-screen w-full max-w-md flex-col"
  >
    <SearchHeader state={state} actions={actions} inputRef={inputRef} />
    <div
      className="flex flex-1 flex-col gap-4 px-4 pt-5"
      style={{
        paddingBottom: "calc(var(--navbar-pill-height) + 2.5rem + var(--safe-area-inset-bottom))",
      }}
    >
      {state.mode === "neutral" ? (
        <NeutralState state={state} actions={actions} />
      ) : state.mode === "suggest" ? (
        <SuggestState state={state} actions={actions} />
      ) : (
        <ResultsState state={state} actions={actions} />
      )}
    </div>
    <p role="status" aria-live="polite" data-testid="search-announcer" className="sr-only">
      {state.announcement}
    </p>
  </main>
);

// ---------------------------------------------------------------------------
// Conteneur : état, débounce, annulation des requêtes obsolètes, persistance
// ---------------------------------------------------------------------------

/** Délai de débounce des suggestions live. */
export const SUGGEST_DEBOUNCE_MS = 200;

export interface SearchScreenProps {
  /** Branchement futur sur la wishlist (M2/M3) ; sans callback, retour visuel local uniquement. */
  readonly onToggleWishlist?: ((card: CardSearchHit, wishlisted: boolean) => void) | undefined;
  /** Branchement futur sur l'ajout rapide (M2/M3). */
  readonly onQuickAdd?: ((card: CardSearchHit) => void) | undefined;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const redirectToLogin = (): void => {
  window.location.assign(loginRedirectTo(SEARCH_PATH));
};

/** Convertit un résultat d'API en état, ou redirige vers la connexion sur 401. */
const toLoadable = <T,>(result: ApiResult<T>): Loadable<T> => {
  if (result.kind === "ok") return { status: "ready", data: result.data };
  if (result.kind === "unauthorized") redirectToLogin();
  return { status: "error" };
};

export const SearchScreen = ({ onToggleWishlist, onQuickAdd }: SearchScreenProps) => {
  const [input, setInput] = useState("");
  const [committed, setCommitted] = useState("");
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<SearchScope>("all");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [viewMode, setViewMode] = useState<SearchViewMode>("grid");
  const [quickAccess, setQuickAccess] = useState<SearchQuickAccess | undefined>(undefined);
  const [activeSet, setActiveSet] = useState<ActiveSetFilter | null>(null);
  const [recents, setRecents] = useState<ReadonlyArray<string>>([]);
  const [discovery, setDiscovery] = useState<Loadable<SearchDiscoveryPayload>>({
    status: "loading",
  });
  const [suggestions, setSuggestions] = useState<Loadable<SearchSuggestionsPayload>>({
    status: "idle",
  });
  const [results, setResults] = useState<Loadable<SearchResultsPayload>>({ status: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [retryToken, setRetryToken] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasActiveSearch =
    committed.trim() !== "" || quickAccess !== undefined || activeSet !== null;
  const mode: SearchMode = editing ? "suggest" : hasActiveSearch ? "results" : "neutral";
  const trimmedInput = input.trim();

  // Historique local : lu après l'hydratation (jamais pendant le rendu serveur).
  useEffect(() => {
    setRecents(loadRecentSearches());
  }, []);

  const updateRecents = (next: ReadonlyArray<string>): void => {
    setRecents(next);
    saveRecentSearches(next);
  };

  // 05A : extensions populaires + cartes phares.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    setDiscovery({ status: "loading" });
    fetchDiscovery(controller.signal)
      .then((result) => setDiscovery(toLoadable(result)))
      .catch((error: unknown) => {
        if (!isAbort(error)) setDiscovery({ status: "error" });
      });
    return () => controller.abort();
  }, [retryToken]);

  // 05B : suggestions live débouncées, requêtes obsolètes annulées.
  useEffect(() => {
    if (!editing || trimmedInput === "") {
      setSuggestions({ status: "idle" });
      return;
    }
    setSuggestions({ status: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchSuggestions(trimmedInput, controller.signal)
        .then((result) => setSuggestions(toLoadable(result)))
        .catch((error: unknown) => {
          if (!isAbort(error)) setSuggestions({ status: "error" });
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [editing, trimmedInput]);

  const query = useMemo<SearchQuery>(
    () => ({
      q: committed.trim(),
      scope,
      sort,
      limit: SEARCH_DEFAULT_LIMIT,
      offset: 0,
      ...(quickAccess === undefined ? {} : { quickAccess }),
      ...(activeSet === null ? {} : { setId: activeSet.id }),
    }),
    [committed, scope, sort, quickAccess, activeSet],
  );

  const loadMoreControllerRef = useRef<AbortController | null>(null);

  // 05C / 05D : résultats (première page) dès qu'une requête ou un filtre est actif.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryToken` relance volontairement la recherche
  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    if (!hasActiveSearch) {
      setResults({ status: "idle" });
      setLoadingMore(false);
      return;
    }
    const controller = new AbortController();
    setResults({ status: "loading" });
    setLoadingMore(false);
    fetchResults(query, controller.signal)
      .then((result) => setResults(toLoadable(result)))
      .catch((error: unknown) => {
        if (!isAbort(error)) setResults({ status: "error" });
      });
    return () => {
      controller.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    };
  }, [hasActiveSearch, query, retryToken]);

  const commit = (raw: string, options?: { readonly remember?: boolean }): void => {
    const text = raw.trim();
    setInput(text);
    setCommitted(text);
    setEditing(false);
    inputRef.current?.blur();
    if (text !== "" && options?.remember !== false) updateRecents(addRecentSearch(recents, text));
  };

  const announce = (message: string): void => setAnnouncement(message);

  const actions: SearchViewActions = {
    onInputChange: (value) => {
      setInput(value);
      setEditing(true);
    },
    onSubmit: () => commit(input),
    onClearInput: () => {
      setInput("");
      setCommitted("");
      setEditing(true);
      inputRef.current?.focus();
    },
    onFocus: () => setEditing(true),
    onBlur: (relatedTarget) => {
      // Un focus qui reste dans l'écran (pastille, suggestion…) ne ferme pas la saisie.
      if (relatedTarget instanceof Node && rootRef.current?.contains(relatedTarget)) return;
      if (trimmedInput === committed.trim()) setEditing(false);
    },
    onEscape: () => {
      setInput(committed);
      setEditing(false);
      inputRef.current?.blur();
    },
    onScopeChange: setScope,
    onSortChange: setSort,
    onViewModeChange: setViewMode,
    onToggleQuickAccess: (next) => {
      setQuickAccess((current) => (current === next ? undefined : next));
      setEditing(false);
    },
    onSelectSet: (set) => {
      setActiveSet({ id: set.id, name: set.nameFr });
      setInput("");
      setCommitted("");
      setEditing(false);
      inputRef.current?.blur();
    },
    onClearSet: () => setActiveSet(null),
    onPickRecent: (recent) => commit(recent),
    onRemoveRecent: (recent) => updateRecents(removeRecentSearch(recents, recent)),
    onClearRecents: () => updateRecents(clearRecentSearches()),
    onPickSuggestedCard: (card) => commit(card.nameFr),
    onSeeAll: () => commit(input),
    onLoadMore: () => {
      if (results.status !== "ready" || loadingMore) return;
      const loaded = results.data;
      loadMoreControllerRef.current?.abort();
      const controller = new AbortController();
      loadMoreControllerRef.current = controller;
      setLoadingMore(true);
      fetchResults({ ...query, offset: loaded.cards.length }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.kind === "unauthorized") return redirectToLogin();
          if (result.kind === "error") return;
          setResults((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  data: {
                    ...current.data,
                    totalCards: result.data.totalCards,
                    cards: [...current.data.cards, ...result.data.cards],
                  },
                }
              : current,
          );
        })
        .catch(() => undefined)
        .finally(() => {
          if (loadMoreControllerRef.current === controller) {
            loadMoreControllerRef.current = null;
            setLoadingMore(false);
          }
        });
    },
    onRetry: () => setRetryToken((token) => token + 1),
    onReset: () => {
      setInput("");
      setCommitted("");
      setQuickAccess(undefined);
      setActiveSet(null);
      setScope("all");
      setSort("relevance");
      setEditing(false);
    },
    onToggleWishlist: (card) => {
      const next = !wishlistIds.has(card.id);
      setWishlistIds((current) => {
        const updated = new Set(current);
        if (next) updated.add(card.id);
        else updated.delete(card.id);
        return updated;
      });
      announce(
        t(next ? "search.card.announce.wishlistAdded" : "search.card.announce.wishlistRemoved", {
          name: card.nameFr,
        }),
      );
      onToggleWishlist?.(card, next);
    },
    onQuickAdd: (card) => {
      announce(t("search.card.announce.quickAdded", { name: card.nameFr }));
      onQuickAdd?.(card);
    },
  };

  return (
    <div ref={rootRef}>
      <SearchView
        inputRef={inputRef}
        actions={actions}
        state={{
          mode,
          input,
          scope,
          sort,
          viewMode,
          quickAccess,
          activeSet,
          recents,
          discovery,
          suggestions,
          results,
          loadingMore,
          wishlistIds,
          announcement,
        }}
      />
    </div>
  );
};
