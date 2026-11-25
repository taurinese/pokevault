import { type CardVariant, tcgdexCardImageUrl } from "@pokevault/domain";
import { Link } from "@tanstack/react-router";
import { Check, CircleAlert, Download, Heart, Pencil, Star, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import { loginRedirectTo } from "../lib/auth-shared.ts";
import {
  adjustCardCopyQuantity,
  formatPriceCents,
  parsePurchasePriceEuros,
} from "../lib/card-detail-client.ts";
import {
  type AddWishlistBody,
  acquireWishlistItem,
  addWishlistItem,
  computeWishlistFreshness,
  computeWishlistPriceAge,
  countWishlistTabs,
  DEFAULT_WISHLIST_FILTERS,
  deleteWishlistItem,
  effectiveWishlistPriceCents,
  fetchWishlist,
  filterWishlistItems,
  isWishlistBelowThreshold,
  resolveEffectiveWishlistSetId,
  summarizeWishlist,
  updateWishlistItem,
  WISHLIST_PATH,
  type WishlistEnrichedItem,
  type WishlistFilters,
  type WishlistFilterTab,
  type WishlistFreshness,
  wishlistSetOptions,
} from "../lib/wishlist-client.ts";
import { CardmarketExportSheet } from "./CardmarketExportSheet.tsx";
import { CardTile } from "./CardTile.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly data: T };

/** Édition inline du prix cible d'un souhait (champ vide = retirer le seuil). */
export interface TargetEditState {
  readonly itemId: string;
  readonly draft: string;
  readonly invalid: boolean;
}

/** Toast flottant (`role="status"`) ; `canUndo` affiche le bouton « Annuler ». */
export interface WishlistToastState {
  readonly id: number;
  readonly tone: "success" | "error";
  readonly message: string;
  readonly canUndo: boolean;
  readonly undoing: boolean;
}

export interface WishlistViewState {
  readonly data: Loadable<ReadonlyArray<WishlistEnrichedItem>>;
  readonly filters: WishlistFilters;
  readonly exportOpen: boolean;
  /** Souhaits dont une requête est en cours (boutons désactivés). */
  readonly pendingIds: ReadonlySet<string>;
  readonly editing: TargetEditState | null;
  readonly toast: WishlistToastState | null;
  readonly announcement: string;
  /** Horloge de référence de la pastille de fraîcheur (ms). */
  readonly nowMs: number;
}

export interface WishlistViewActions {
  readonly onRetry: () => void;
  readonly onTabChange: (tab: WishlistFilterTab) => void;
  readonly onSetChange: (setId: string | null) => void;
  readonly onResetFilters: () => void;
  readonly onOpenExport: () => void;
  readonly onCloseExport: () => void;
  readonly onTogglePriority: (item: WishlistEnrichedItem) => void;
  readonly onStartEditTarget: (item: WishlistEnrichedItem) => void;
  readonly onTargetDraftChange: (draft: string) => void;
  readonly onSubmitTarget: (item: WishlistEnrichedItem) => void;
  readonly onCancelEditTarget: () => void;
  readonly onDelete: (item: WishlistEnrichedItem) => void;
  readonly onAcquire: (item: WishlistEnrichedItem) => void;
  readonly onUndo: () => void;
  readonly onDismissToast: () => void;
}

/** Libellé affiché d'un souhait : nom français de la carte. */
const itemName = (item: WishlistEnrichedItem): string => item.nameFr;

// ---------------------------------------------------------------------------
// Briques visuelles
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;
const touchSquare = {
  minWidth: "var(--touch-target-min)",
  minHeight: "var(--touch-target-min)",
} as const;

const VARIANT_KEYS: Readonly<Record<CardVariant, TranslationKey>> = {
  normal: "wishlist.variant.normal",
  reverse: "wishlist.variant.reverse",
  holo: "wishlist.variant.holo",
  promo: "wishlist.variant.promo",
  pokeball: "wishlist.variant.pokeball",
  masterball: "wishlist.variant.masterball",
};

const TABS: ReadonlyArray<{ readonly id: WishlistFilterTab; readonly labelKey: TranslationKey }> = [
  { id: "all", labelKey: "wishlist.tab.all" },
  { id: "below_threshold", labelKey: "wishlist.tab.below_threshold" },
  { id: "high_priority", labelKey: "wishlist.tab.high_priority" },
];

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
  readonly action?: ReactNode;
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
    {action}
  </div>
);

const primaryActionClass = `inline-flex items-center justify-center rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`;

const SkeletonList = () => (
  <div
    role="status"
    aria-label={t("wishlist.loading")}
    data-testid="wishlist-skeleton"
    className="flex flex-col gap-3 lg:grid lg:grid-cols-2 motion-reduce:animate-none"
  >
    {Array.from({ length: 3 }, (_, index) => (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
        key={index}
        aria-hidden="true"
        className="h-32 animate-pulse rounded-sheet border border-line bg-surface-2"
      />
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// En-tête & synthèse (06A)
// ---------------------------------------------------------------------------

const WishlistHeader = ({
  exportDisabled,
  onOpenExport,
}: {
  readonly exportDisabled: boolean;
  readonly onOpenExport: () => void;
}) => (
  <header className="flex items-center justify-between gap-3">
    <h1 className="text-2xl font-bold text-primary">{t("wishlist.heading")}</h1>
    <button
      type="button"
      onClick={onOpenExport}
      disabled={exportDisabled}
      aria-label={t("wishlist.export.aria")}
      data-testid="wishlist-export"
      style={touchTarget}
      className={`flex items-center gap-1.5 rounded-pill border border-gold bg-gold-soft px-4 text-sm font-semibold text-gold disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
    >
      <Download size={16} aria-hidden="true" />
      {t("wishlist.export")}
    </button>
  </header>
);

const SummaryBar = ({ items }: { readonly items: ReadonlyArray<WishlistEnrichedItem> }) => {
  const summary = summarizeWishlist(items);
  return (
    <section
      aria-label={t("wishlist.summary.label")}
      data-testid="wishlist-summary"
      className="flex items-center justify-between gap-2 rounded-card border border-line bg-surface-1 px-3 py-2"
    >
      <p className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap">
        <span className="text-xs text-secondary">{t("wishlist.summary.budget")}</span>
        <span
          data-testid="wishlist-budget"
          className="font-mono text-base font-bold tabular-nums text-primary"
        >
          {formatPriceCents(summary.estimatedTotalCents)}
        </span>
        {summary.unpricedCount > 0 ? (
          <span
            data-testid="wishlist-unpriced"
            className="truncate font-mono text-xs tabular-nums text-muted"
          >
            {tPlural("wishlist.summary.unpriced", summary.unpricedCount)}
          </span>
        ) : null}
      </p>
      {summary.belowThresholdCount > 0 ? (
        <span
          data-testid="wishlist-below-badge"
          className="shrink-0 rounded-pill border border-success bg-success/15 px-2.5 py-1 font-mono text-xs font-bold tabular-nums text-success-strong"
        >
          {t("wishlist.summary.belowThreshold", { count: summary.belowThresholdCount })}
        </span>
      ) : null}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

const Filters = ({
  items,
  filters,
  actions,
}: {
  readonly items: ReadonlyArray<WishlistEnrichedItem>;
  readonly filters: WishlistFilters;
  readonly actions: Pick<WishlistViewActions, "onTabChange" | "onSetChange">;
}) => {
  const counts = countWishlistTabs(items);
  const sets = wishlistSetOptions(items);
  const activeSetId = sets.some((set) => set.id === filters.setId) ? filters.setId : null;
  return (
    <div
      className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
      data-testid="wishlist-filters"
    >
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">{t("wishlist.filters.label")}</legend>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {TABS.map((tab) => {
            const active = filters.tab === tab.id;
            const label = t(tab.labelKey);
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={active}
                onClick={() => actions.onTabChange(tab.id)}
                style={touchTarget}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-4 text-sm font-semibold transition-colors ${focusRing} ${
                  active
                    ? "border-gold bg-gold-soft text-gold"
                    : "border-line bg-surface-1 text-secondary hover:text-primary"
                }`}
              >
                {label}
                {tab.id === "all" ? null : (
                  <span className="font-mono text-xs tabular-nums">{counts[tab.id]}</span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>
      {sets.length > 0 ? (
        <select
          aria-label={t("wishlist.set.label")}
          data-testid="wishlist-set-filter"
          value={activeSetId ?? ""}
          onChange={(event) =>
            actions.onSetChange(event.target.value === "" ? null : event.target.value)
          }
          style={touchTarget}
          className={`w-full rounded-card border border-line bg-surface-1 px-3 text-sm text-primary lg:w-72 ${focusRing}`}
        >
          <option value="">{t("wishlist.set.all")}</option>
          {sets.map((set) => (
            <option key={set.id} value={set.id}>
              {t("wishlist.set.option", { name: set.nameFr, count: set.count })}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Prix & fraîcheur (docs/04 §2.1)
// ---------------------------------------------------------------------------

const FRESHNESS: Readonly<
  Record<
    WishlistFreshness,
    {
      readonly hintKey: TranslationKey;
      readonly tone: string;
      readonly dot: string;
    }
  >
> = {
  fresh: {
    hintKey: "wishlist.price.fresh.hint",
    tone: "border-success text-success-strong",
    dot: "bg-success",
  },
  aging: {
    hintKey: "wishlist.price.aging.hint",
    tone: "border-warning text-warning",
    dot: "bg-warning",
  },
  stale: {
    hintKey: "wishlist.price.stale.hint",
    tone: "border-line text-muted",
    dot: "bg-muted",
  },
  missing: {
    hintKey: "wishlist.price.missing.hint",
    tone: "border-line text-muted",
    dot: "bg-muted",
  },
};

/** Libellé d'âge relatif conforme à docs/04 §2.1 (`il y a 6 min`, `il y a 2 h`, `À l'instant`). */
export const formatWishlistFreshnessLabel = (
  freshness: WishlistFreshness,
  fetchedAt: string | null,
  nowMs: number,
): string => {
  if (freshness === "missing") return t("wishlist.price.missing");
  const age = computeWishlistPriceAge(fetchedAt, nowMs);
  const ageText =
    age === null
      ? null
      : age.kind === "just_now"
        ? t("wishlist.price.justNow")
        : age.kind === "minutes"
          ? t("wishlist.price.minutesAgo", { count: age.count })
          : age.kind === "hours"
            ? t("wishlist.price.hoursAgo", { count: age.count })
            : tPlural("wishlist.price.daysAgo", age.count);
  if (freshness === "stale") {
    return ageText === null
      ? t("wishlist.price.stale")
      : t("wishlist.price.staleWithAge", { age: ageText });
  }
  return ageText ?? t("wishlist.price.fresh");
};

const FreshnessPill = ({
  freshness,
  fetchedAt,
  nowMs,
}: {
  readonly freshness: WishlistFreshness;
  readonly fetchedAt: string | null;
  readonly nowMs: number;
}) => {
  const entry = FRESHNESS[freshness];
  return (
    <span
      data-testid="wishlist-freshness"
      data-freshness={freshness}
      title={t(entry.hintKey)}
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[11px] font-semibold ${entry.tone}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-pill ${entry.dot}`} />
      {formatWishlistFreshnessLabel(freshness, fetchedAt, nowMs)}
    </span>
  );
};

const Badge = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <li
    aria-label={label}
    className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-secondary"
  >
    {children}
  </li>
);

// ---------------------------------------------------------------------------
// Édition du prix cible
// ---------------------------------------------------------------------------

const TargetEditor = ({
  item,
  editing,
  disabled,
  actions,
}: {
  readonly item: WishlistEnrichedItem;
  readonly editing: TargetEditState;
  readonly disabled: boolean;
  readonly actions: Pick<
    WishlistViewActions,
    "onTargetDraftChange" | "onSubmitTarget" | "onCancelEditTarget"
  >;
}) => {
  const inputId = `wishlist-target-${item.id}`;
  const errorId = `${inputId}-error`;
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    actions.onSubmitTarget(item);
  };
  return (
    <form
      onSubmit={onSubmit}
      data-testid="wishlist-target-form"
      className="flex flex-col gap-1.5 rounded-card border border-line bg-surface-2 p-2"
    >
      <label htmlFor={inputId} className="text-xs font-semibold text-secondary">
        {t("wishlist.target.label")}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={editing.draft}
          placeholder={t("wishlist.target.placeholder")}
          aria-invalid={editing.invalid}
          aria-describedby={editing.invalid ? errorId : undefined}
          onChange={(event) => actions.onTargetDraftChange(event.target.value)}
          style={touchTarget}
          className={`min-w-0 flex-1 rounded-card border bg-surface-1 px-3 font-mono text-sm tabular-nums text-primary ${focusRing} ${
            editing.invalid ? "border-danger" : "border-line"
          }`}
        />
        <button
          type="submit"
          disabled={disabled}
          style={touchTarget}
          className={`${primaryActionClass} disabled:opacity-40`}
        >
          {t("wishlist.target.save")}
        </button>
        <button
          type="button"
          onClick={actions.onCancelEditTarget}
          aria-label={t("wishlist.target.cancel")}
          style={touchSquare}
          className={`flex items-center justify-center rounded-pill border border-line bg-surface-1 text-secondary ${focusRing}`}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {editing.invalid ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {t("wishlist.target.invalid")}
        </p>
      ) : null}
      {item.targetPriceCents !== null && editing.draft.trim() !== "" ? (
        <button
          type="button"
          onClick={() => actions.onTargetDraftChange("")}
          style={touchTarget}
          className={`self-start rounded-pill px-2 text-xs font-semibold text-secondary underline ${focusRing}`}
        >
          {t("wishlist.target.clear")}
        </button>
      ) : null}
    </form>
  );
};

// ---------------------------------------------------------------------------
// Ligne de souhait (06A)
// ---------------------------------------------------------------------------

const WishlistRow = ({
  item,
  nowMs,
  pending,
  editing,
  actions,
}: {
  readonly item: WishlistEnrichedItem;
  readonly nowMs: number;
  readonly pending: boolean;
  readonly editing: TargetEditState | null;
  readonly actions: WishlistViewActions;
}) => {
  const name = itemName(item);
  const current = effectiveWishlistPriceCents(item);
  const freshness = computeWishlistFreshness(item, nowMs);
  const below = isWishlistBelowThreshold(item);
  const high = item.priority === "high";
  const imageUrl = tcgdexCardImageUrl(item.imageBaseUrl, "low");
  const variant = t(VARIANT_KEYS[item.variant]);
  const iconButton = `flex items-center justify-center rounded-pill border border-line bg-surface-1 text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;

  return (
    <li
      data-testid="wishlist-item"
      data-below-threshold={below ? "true" : "false"}
      className={`flex gap-3 rounded-sheet border bg-surface-1 p-3 shadow-card ${
        below ? "border-success" : "border-line"
      }`}
    >
      <div className="w-16 shrink-0 self-start">
        <CardTile name={name} label={name} {...(imageUrl === undefined ? {} : { imageUrl })} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-primary">{name}</h3>
            <p className="truncate text-xs text-secondary">
              <span className="font-mono tabular-nums">
                {t("wishlist.item.number", { number: item.localId })}
              </span>{" "}
              · {item.setNameFr}
            </p>
          </div>
          <button
            type="button"
            aria-pressed={high}
            aria-label={t("wishlist.priority.toggle", { name })}
            data-testid="wishlist-priority"
            disabled={pending}
            onClick={() => actions.onTogglePriority(item)}
            style={touchSquare}
            className={`-mt-1 -mr-1 flex shrink-0 items-center justify-center rounded-pill transition-colors disabled:opacity-40 ${focusRing} ${
              high ? "text-gold" : "text-muted hover:text-primary"
            }`}
          >
            <Star size={20} aria-hidden="true" className={high ? "fill-current" : ""} />
          </button>
        </div>

        <ul className="flex flex-wrap gap-1.5">
          <Badge label={t("wishlist.item.language", { language: item.language })}>
            {item.language}
          </Badge>
          <Badge label={t("wishlist.item.variant", { variant })}>{variant}</Badge>
          <Badge label={t("wishlist.item.condition", { condition: item.minCondition })}>
            {t("wishlist.item.minCondition", { condition: item.minCondition })}
          </Badge>
        </ul>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {current === null ? null : (
            <span
              data-testid="wishlist-price"
              className="font-mono text-base font-bold tabular-nums text-primary"
            >
              {formatPriceCents(current)}
            </span>
          )}
          <FreshnessPill freshness={freshness} fetchedAt={item.priceFetchedAt} nowMs={nowMs} />
          {item.targetPriceCents === null ? null : (
            <span
              data-testid="wishlist-target"
              className={`font-mono text-xs font-semibold tabular-nums ${
                below
                  ? "rounded-md bg-success/15 px-1.5 py-0.5 text-success-strong"
                  : "text-secondary"
              }`}
            >
              {t("wishlist.price.target", { price: formatPriceCents(item.targetPriceCents) ?? "" })}
              {below ? ` · ${t("wishlist.price.belowThreshold")}` : ""}
            </span>
          )}
        </div>

        {editing === null ? null : (
          <TargetEditor item={item} editing={editing} disabled={pending} actions={actions} />
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t("wishlist.target.edit", { name })}
            data-testid="wishlist-edit-target"
            disabled={pending}
            onClick={() => actions.onStartEditTarget(item)}
            style={touchSquare}
            className={iconButton}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t("wishlist.delete", { name })}
            data-testid="wishlist-delete"
            disabled={pending}
            onClick={() => actions.onDelete(item)}
            style={touchSquare}
            className={iconButton}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t("wishlist.acquire", { name })}
            data-testid="wishlist-acquire"
            disabled={pending}
            onClick={() => actions.onAcquire(item)}
            style={touchSquare}
            className={`ml-auto flex items-center justify-center rounded-pill border border-success bg-success/15 text-success-strong transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            <Check size={20} strokeWidth={3} aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
};

// ---------------------------------------------------------------------------
// Toast « Acquise » / « Retirée » avec Annuler
// ---------------------------------------------------------------------------

const ToastRegion = ({
  toast,
  actions,
}: {
  readonly toast: WishlistToastState | null;
  readonly actions: Pick<WishlistViewActions, "onUndo" | "onDismissToast">;
}) => (
  <div
    role="status"
    aria-live="polite"
    data-testid="wishlist-toast-region"
    className="pointer-events-none fixed inset-x-4 bottom-28 z-40 mx-auto max-w-md lg:right-8 lg:bottom-8 lg:left-60"
  >
    {toast === null ? null : (
      <div
        data-testid="wishlist-toast"
        data-tone={toast.tone}
        className={`pointer-events-auto flex items-center gap-2 rounded-card border bg-surface-1 py-1.5 pr-1.5 pl-4 shadow-sheet ${
          toast.tone === "error" ? "border-danger" : "border-success"
        }`}
      >
        <p className="min-w-0 flex-1 text-sm font-semibold text-primary">{toast.message}</p>
        {toast.canUndo ? (
          <button
            type="button"
            onClick={actions.onUndo}
            disabled={toast.undoing}
            data-testid="wishlist-undo"
            style={touchTarget}
            className={`shrink-0 rounded-pill px-3 text-sm font-bold text-gold disabled:opacity-40 ${focusRing}`}
          >
            {t("wishlist.toast.undo")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={actions.onDismissToast}
          aria-label={t("wishlist.toast.dismiss")}
          style={touchSquare}
          className={`flex shrink-0 items-center justify-center rounded-pill text-secondary hover:text-primary ${focusRing}`}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

export interface WishlistViewProps {
  readonly state: WishlistViewState;
  readonly actions: WishlistViewActions;
}

export const WishlistView = ({ state, actions }: WishlistViewProps) => {
  const items = state.data.status === "ready" ? state.data.data : null;
  const effectiveFilters: WishlistFilters =
    items === null
      ? state.filters
      : { ...state.filters, setId: resolveEffectiveWishlistSetId(items, state.filters.setId) };
  const visible = items === null ? [] : filterWishlistItems(items, effectiveFilters);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 pt-10 pb-40 lg:max-w-5xl lg:gap-5 lg:px-8 lg:pb-12">
      <WishlistHeader
        exportDisabled={items === null || items.length === 0}
        onOpenExport={actions.onOpenExport}
      />
      {items !== null && items.length > 0 ? (
        <>
          <SummaryBar items={items} />
          <Filters items={items} filters={effectiveFilters} actions={actions} />
        </>
      ) : null}

      {state.data.status === "loading" ? <SkeletonList /> : null}
      {state.data.status === "error" ? (
        <StateNotice
          testId="wishlist-error"
          icon={<CircleAlert size={32} strokeWidth={1.5} />}
          title={t("wishlist.error.title")}
          description={t("wishlist.error.description")}
          action={
            <button
              type="button"
              onClick={actions.onRetry}
              style={touchTarget}
              className={primaryActionClass}
            >
              {t("wishlist.error.retry")}
            </button>
          }
        />
      ) : null}
      {items !== null && items.length === 0 ? (
        <StateNotice
          testId="wishlist-empty"
          icon={<Heart size={32} strokeWidth={1.5} />}
          title={t("wishlist.empty.title")}
          description={t("wishlist.empty.description")}
          action={
            <Link to="/search" style={touchTarget} className={primaryActionClass}>
              {t("wishlist.empty.cta")}
            </Link>
          }
        />
      ) : null}
      {items !== null && items.length > 0 && visible.length === 0 ? (
        <StateNotice
          testId="wishlist-filtered-empty"
          icon={<Heart size={32} strokeWidth={1.5} />}
          title={t("wishlist.filtered.title")}
          description={t("wishlist.filtered.description")}
          action={
            <button
              type="button"
              onClick={actions.onResetFilters}
              style={touchTarget}
              className={primaryActionClass}
            >
              {t("wishlist.filtered.reset")}
            </button>
          }
        />
      ) : null}
      {visible.length > 0 ? (
        <ul
          aria-label={t("wishlist.list.label")}
          className="flex flex-col gap-3 lg:grid lg:grid-cols-2"
        >
          {visible.map((item) => (
            <WishlistRow
              key={item.id}
              item={item}
              nowMs={state.nowMs}
              pending={state.pendingIds.has(item.id)}
              editing={state.editing?.itemId === item.id ? state.editing : null}
              actions={actions}
            />
          ))}
        </ul>
      ) : null}

      <p role="status" aria-live="polite" data-testid="wishlist-announcer" className="sr-only">
        {state.announcement}
      </p>
      <ToastRegion toast={state.toast} actions={actions} />
      <CardmarketExportSheet
        open={state.exportOpen && items !== null && items.length > 0}
        onClose={actions.onCloseExport}
        items={items ?? []}
      />
    </main>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : chargement, mutations, annulation
// ---------------------------------------------------------------------------

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const redirectToLogin = (): void => {
  window.location.assign(loginRedirectTo(WISHLIST_PATH));
};

const TOAST_DURATION_MS = 8000;
const CLOCK_TICK_MS = 60_000;

/** Corps de réinscription d'un souhait retiré (même slot, mêmes préférences). */
export const readdBodyOf = (item: WishlistEnrichedItem): AddWishlistBody => ({
  cardId: item.cardId,
  language: item.language,
  variant: item.variant,
  minCondition: item.minCondition,
  priority: item.priority,
  targetPriceCents: item.targetPriceCents,
});

export interface UndoPayload {
  readonly name: string;
  readonly readd: AddWishlistBody;
  /** Exemplaire créé / incrémenté par « Acquise » : à décrémenter à l'annulation. */
  readonly copyId: string | null;
}

export type UndoOutcome =
  | "done"
  | "unauthorized"
  /** Le souhait n'a pas pu être remis : rien n'a été modifié. */
  | "failed"
  /** Souhait remis mais exemplaire non décrémenté : l'écran doit se recharger. */
  | "partial";

export interface UndoApi {
  readonly addWishlistItem: typeof addWishlistItem;
  readonly adjustCardCopyQuantity: typeof adjustCardCopyQuantity;
}

/**
 * Annule une action « Acquise » ou « Retirer » : ré-ajoute le souhait
 * (`POST /api/wishlist`, mêmes carte / langue / variante / état / priorité / seuil) puis, si un
 * exemplaire avait été ajouté, le décrémente (`PATCH /api/cards/copies/$id { delta: -1 }`).
 * Un souhait recréé entre-temps (409) n'empêche pas d'annuler la copie ; une copie déjà
 * supprimée (404) n'est pas une erreur.
 */
export const runWishlistUndo = async (
  payload: UndoPayload,
  api: UndoApi = { addWishlistItem, adjustCardCopyQuantity },
): Promise<UndoOutcome> => {
  const added = await api.addWishlistItem(payload.readd);
  if (added.kind === "unauthorized") return "unauthorized";
  if (added.kind !== "ok" && added.kind !== "conflict") return "failed";
  if (payload.copyId !== null) {
    const adjusted = await api.adjustCardCopyQuantity(payload.copyId, -1);
    if (adjusted.kind === "unauthorized") return "unauthorized";
    if (adjusted.kind !== "ok" && adjusted.kind !== "not-found") return "partial";
  }
  return "done";
};

export const WishlistScreen = () => {
  const [data, setData] = useState<Loadable<ReadonlyArray<WishlistEnrichedItem>>>({
    status: "loading",
  });
  const [filters, setFilters] = useState<WishlistFilters>(DEFAULT_WISHLIST_FILTERS);
  const [exportOpen, setExportOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<TargetEditState | null>(null);
  const [toast, setToast] = useState<WishlistToastState | null>(null);
  const announcement = "";
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  // Les rechargements après mutation gardent l'écran affiché (pas de retour au squelette).
  const [silentReload, setSilentReload] = useState(false);
  const undoRef = useRef<{ readonly toastId: number; readonly payload: UndoPayload } | null>(null);
  const toastSeq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    if (!silentReload) setData({ status: "loading" });
    fetchWishlist(controller.signal)
      .then((result) => {
        if (result.kind === "ok") {
          setData({ status: "ready", data: result.items });
          setNowMs(Date.now());
        } else if (result.kind === "unauthorized") redirectToLogin();
        else
          setData((current) =>
            silentReload && current.status === "ready" ? current : { status: "error" },
          );
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setData({ status: "error" });
      });
    return () => controller.abort();
  }, [reloadToken]);

  // Fait vieillir la pastille de fraîcheur sans recharger la liste.
  useEffect(() => {
    const handle = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(handle);
  }, []);

  // Dismiss automatique du toast (suspendu pendant une annulation en cours).
  useEffect(() => {
    if (toast === null || toast.undoing) return;
    const handle = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, TOAST_DURATION_MS);
    return () => clearTimeout(handle);
  }, [toast]);

  const reload = (silent: boolean): void => {
    setSilentReload(silent);
    setReloadToken((token) => token + 1);
  };

  const showToast = (
    message: string,
    tone: "success" | "error",
    undoPayload: UndoPayload | null = null,
  ): void => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    undoRef.current = undoPayload === null ? null : { toastId: id, payload: undoPayload };
    // `ToastRegion` porte déjà `role="status" aria-live="polite"` : ne pas doubler dans `announcement`.
    setToast({ id, tone, message, canUndo: undoPayload !== null, undoing: false });
  };

  const setPending = (id: string, pending: boolean): void =>
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });

  const removeLocally = (id: string): void =>
    setData((current) =>
      current.status === "ready"
        ? { status: "ready", data: current.data.filter((item) => item.id !== id) }
        : current,
    );

  const actions: WishlistViewActions = {
    onRetry: () => reload(false),
    onTabChange: (tab) => setFilters((current) => ({ ...current, tab })),
    onSetChange: (setId) => setFilters((current) => ({ ...current, setId })),
    onResetFilters: () => setFilters(DEFAULT_WISHLIST_FILTERS),
    onOpenExport: () => setExportOpen(true),
    onCloseExport: () => setExportOpen(false),

    onTogglePriority: (item) => {
      if (pendingIds.has(item.id)) return;
      setPending(item.id, true);
      void updateWishlistItem(item.id, {
        priority: item.priority === "high" ? "normal" : "high",
      }).then((result) => {
        setPending(item.id, false);
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok") return reload(true);
        if (result.kind === "not-found") return reload(true);
        showToast(t("wishlist.error.action"), "error");
      });
    },

    onStartEditTarget: (item) =>
      setEditing({
        itemId: item.id,
        draft:
          item.targetPriceCents === null
            ? ""
            : (item.targetPriceCents / 100).toFixed(2).replace(".", ","),
        invalid: false,
      }),
    onTargetDraftChange: (draft) =>
      setEditing((current) => (current === null ? current : { ...current, draft, invalid: false })),
    onCancelEditTarget: () => setEditing(null),
    onSubmitTarget: (item) => {
      if (editing === null || pendingIds.has(item.id)) return;
      const parsed = parsePurchasePriceEuros(editing.draft);
      if (!parsed.ok) {
        setEditing({ ...editing, invalid: true });
        return;
      }
      setPending(item.id, true);
      void updateWishlistItem(item.id, { targetPriceCents: parsed.cents }).then((result) => {
        setPending(item.id, false);
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok") {
          setEditing(null);
          setData((current) =>
            current.status === "ready"
              ? {
                  status: "ready",
                  data: current.data.map((entry) =>
                    entry.id === item.id
                      ? {
                          ...entry,
                          targetPriceCents: result.body.targetPriceCents,
                          updatedAt: result.body.updatedAt,
                        }
                      : entry,
                  ),
                }
              : current,
          );
          return;
        }
        if (result.kind === "not-found") return reload(true);
        setEditing((current) => (current === null ? current : { ...current, invalid: true }));
        showToast(t("wishlist.error.action"), "error");
      });
    },

    onDelete: (item) => {
      if (pendingIds.has(item.id)) return;
      setPending(item.id, true);
      void deleteWishlistItem(item.id).then((result) => {
        setPending(item.id, false);
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok" || result.kind === "not-found") {
          removeLocally(item.id);
          setEditing((current) => (current?.itemId === item.id ? null : current));
          showToast(t("wishlist.toast.removed", { name: itemName(item) }), "success", {
            name: itemName(item),
            readd: readdBodyOf(item),
            copyId: null,
          });
          return;
        }
        showToast(t("wishlist.error.action"), "error");
      });
    },

    onAcquire: (item) => {
      if (pendingIds.has(item.id)) return;
      setPending(item.id, true);
      void acquireWishlistItem(item.id).then((result) => {
        setPending(item.id, false);
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok") {
          removeLocally(result.body.removedWishlistItemId);
          setEditing((current) => (current?.itemId === item.id ? null : current));
          showToast(t("wishlist.toast.acquired", { name: itemName(item) }), "success", {
            name: itemName(item),
            readd: readdBodyOf(item),
            copyId: result.body.copy.id,
          });
          return;
        }
        if (result.kind === "not-found") return reload(true);
        showToast(
          t(result.kind === "conflict" ? "wishlist.error.overflow" : "wishlist.error.action"),
          "error",
        );
      });
    },

    onUndo: () => {
      const active = undoRef.current;
      if (active === null || toast === null || toast.undoing || active.toastId !== toast.id) return;
      const activeToastId = toast.id;
      setToast({ ...toast, undoing: true });
      void runWishlistUndo(active.payload).then((outcome) => {
        if (outcome === "unauthorized") return redirectToLogin();
        // Si un nouveau toast a remplacé celui-ci entre-temps, ne pas écraser le nouveau toast/undo.
        const stillCurrent = undoRef.current?.toastId === activeToastId;
        if (outcome === "failed") {
          if (stillCurrent) showToast(t("wishlist.error.undo"), "error");
          return;
        }
        reload(true);
        if (!stillCurrent) return;
        if (outcome === "partial") return showToast(t("wishlist.error.undo"), "error");
        showToast(t("wishlist.toast.undone", { name: active.payload.name }), "success");
      });
    },
    onDismissToast: () => setToast(null),
  };

  return (
    <WishlistView
      state={{ data, filters, exportOpen, pendingIds, editing, toast, announcement, nowMs }}
      actions={actions}
    />
  );
};
