import { CardAspectRatio, tcgdexCardImageUrl, tcgdexSetLogoUrl } from "@pokevault/domain";
import {
  BellOff,
  BellRing,
  CircleAlert,
  FolderHeart,
  ImageOff,
  LibraryBig,
  Lock,
  Share2,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import { ACCOUNT_PATH, loginRedirectTo, SEARCH_PATH } from "../lib/auth-shared.ts";
import { COLLECTION_PATH } from "../lib/binders-client.ts";
import {
  ALERTS_PATH,
  computePriceFreshness,
  computeRelativeAge,
  DASHBOARD_PATH,
  type DashboardAge,
  type DashboardBinder,
  type DashboardFeaturedCard,
  type DashboardFreshness,
  type DashboardPayload,
  type DashboardSummary,
  fetchDashboard,
  formatCount,
  formatDeltaPercent,
  formatPercent,
  formatPriceCents,
} from "../lib/dashboard-client.ts";
import { CardDetailSheet } from "./CardDetailSheet.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** État d'un chargement asynchrone. */
export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly data: T };

export interface DashboardViewState {
  readonly data: Loadable<DashboardPayload>;
  /** Horloge de référence (fraîcheur / âges relatifs), fixée par le conteneur. */
  readonly nowMs: number;
  /** Carte dont la fiche (bottom sheet `04`) est ouverte (`null` : fermée). */
  readonly sheetCardId: string | null;
  readonly sheetCardName: string | null;
}

export interface DashboardViewActions {
  readonly onRetry: () => void;
  readonly onOpenCard: (cardId: string, cardName: string) => void;
  readonly onCloseCard: () => void;
}

export interface DashboardViewProps {
  readonly state: DashboardViewState;
  readonly actions: DashboardViewActions;
}

// ---------------------------------------------------------------------------
// Constantes d'affichage
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;
const touchSquare = {
  minWidth: "var(--touch-target-min)",
  minHeight: "var(--touch-target-min)",
} as const;

/** Pastille de fraîcheur : verte / ambre / neutre (jamais de hex brut, tokens uniquement). */
const FRESHNESS_DOT: Readonly<Record<DashboardFreshness, string>> = {
  fresh: "bg-success",
  aging: "bg-warning",
  stale: "bg-muted",
  missing: "bg-muted",
};

const FRESHNESS_ARIA: Readonly<Record<DashboardFreshness, TranslationKey>> = {
  fresh: "dashboard.freshness.aria.fresh",
  aging: "dashboard.freshness.aria.aging",
  stale: "dashboard.freshness.aria.stale",
  missing: "dashboard.freshness.aria.missing",
};

/** Libellé d'âge relatif (`À l'instant`, `il y a N min/h/j`). */
export const formatDashboardAge = (age: DashboardAge | null): string | null => {
  if (age === null) return null;
  switch (age.kind) {
    case "just_now":
      return t("dashboard.freshness.justNow");
    case "minutes":
      return t("dashboard.freshness.minutesAgo", { count: age.count });
    case "hours":
      return t("dashboard.freshness.hoursAgo", { count: age.count });
    case "days":
      return tPlural("dashboard.freshness.daysAgo", age.count);
  }
};

/** Teinte du badge de variation 30 j (tokens sémantiques uniquement). */
const deltaTone = (delta: number): string =>
  delta > 0
    ? "border-success/40 text-success-strong"
    : delta < 0
      ? "border-danger/40 text-danger"
      : "border-line text-secondary";

const sectionHeading = "text-xs font-semibold tracking-wide text-muted uppercase";

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
// Briques visuelles
// ---------------------------------------------------------------------------

const DashboardHeader = () => (
  <header className="flex items-start justify-between gap-4">
    <div className="flex min-w-0 flex-col gap-1">
      <h1 className="text-2xl font-bold text-primary">{t("dashboard.heading")}</h1>
      <p className="text-sm text-secondary">{t("dashboard.tagline")}</p>
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <ThemeToggle />
      <a
        href={ACCOUNT_PATH}
        aria-label={t("dashboard.accountLink")}
        data-testid="dashboard-account-link"
        className={`flex items-center justify-center rounded-pill border border-line bg-surface-1 text-secondary shadow-card transition-colors hover:bg-surface-2 hover:text-primary ${focusRing}`}
        style={touchSquare}
      >
        <UserRound size={20} aria-hidden="true" />
      </a>
    </div>
  </header>
);

/** Barre synthèse 1 ligne : pastille fraîcheur + âge, valeur, variation 30 j, jauge + compteur. */
const SummaryBar = ({
  summary,
  nowMs,
}: {
  readonly summary: DashboardSummary;
  readonly nowMs: number;
}) => {
  const age = computeRelativeAge(summary.priceFetchedAt, nowMs);
  const ageText = formatDashboardAge(age);
  const stale = summary.globalFreshness === "stale";
  const delta = formatDeltaPercent(summary.delta30dPercent);
  return (
    <section
      aria-label={t("dashboard.summary.label")}
      data-testid="dashboard-summary"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-sheet border border-line bg-surface-1 px-3 py-2.5 shadow-card"
    >
      <span
        data-testid="dashboard-freshness-dot"
        data-freshness={summary.globalFreshness}
        role="img"
        aria-label={t(FRESHNESS_ARIA[summary.globalFreshness])}
        className={`h-2 w-2 shrink-0 rounded-pill ${FRESHNESS_DOT[summary.globalFreshness]}`}
      />
      {ageText === null ? null : (
        <span
          data-testid="dashboard-freshness-age"
          className="text-xs whitespace-nowrap text-secondary"
        >
          {ageText}
          {stale ? (
            <span className="text-muted"> {t("dashboard.freshness.indicative")}</span>
          ) : null}
        </span>
      )}
      <span
        data-testid="dashboard-total-value"
        title={t("dashboard.summary.totalValue")}
        className="font-mono text-sm font-bold tabular-nums text-gold"
      >
        {formatPriceCents(summary.totalValueCents)}
      </span>
      {delta === null ? null : (
        <span
          data-testid="dashboard-delta"
          className={`rounded-pill border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${deltaTone(summary.delta30dPercent ?? 0)}`}
        >
          <span className="sr-only">{t("dashboard.summary.deltaLabel")} </span>
          {delta}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        <span
          data-testid="dashboard-completion"
          title={t("dashboard.summary.completion")}
          className="font-mono text-xs font-bold tabular-nums text-primary"
        >
          {formatPercent(summary.globalCompletionPercent)}
        </span>
        <span className="w-14">
          <ProgressBar
            percent={summary.globalCompletionPercent}
            label={t("dashboard.summary.completion")}
          />
        </span>
        <span
          data-testid="dashboard-owned-count"
          className="font-mono text-xs tabular-nums text-secondary"
        >
          {formatCount(summary.ownedCardsCount)}
        </span>
      </span>
    </section>
  );
};

/** Visuel de carte phare avec repli propre si l'image TCGdex ne charge pas. */
const FeaturedCardImage = ({ card }: { readonly card: DashboardFeaturedCard }) => {
  const [failed, setFailed] = useState(false);
  const imageUrl = tcgdexCardImageUrl(card.imageUrl, "low");
  if (imageUrl === undefined || failed) {
    return (
      <div
        aria-hidden="true"
        data-testid="dashboard-featured-image-fallback"
        className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted"
      >
        <ImageOff size={20} strokeWidth={1.5} />
        <span className="px-1 text-center font-mono text-[10px] tabular-nums">
          {card.setCode ?? card.setName}
        </span>
      </div>
    );
  }
  return (
    <img
      src={imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  );
};

/** Carte phare : carte officielle 63/88, badge quantité, code set/numéro, prix + variation 30 j. */
const FeaturedCardTile = ({
  card,
  nowMs,
  onOpen,
}: {
  readonly card: DashboardFeaturedCard;
  readonly nowMs: number;
  readonly onOpen: (cardId: string, cardName: string) => void;
}) => {
  const freshness = computePriceFreshness(
    {
      hasPrice: card.unitPriceCents !== null,
      source: card.priceSource,
      fetchedAt: card.priceFetchedAt,
    },
    nowMs,
  );
  const delta = formatDeltaPercent(card.delta30dPercent);
  return (
    <button
      type="button"
      onClick={() => onOpen(card.cardId, card.name)}
      aria-label={t("dashboard.featured.open", { name: card.name })}
      data-testid="dashboard-featured-card"
      data-card-id={card.cardId}
      className={`flex flex-col text-left ${focusRing}`}
    >
      <div
        className="relative w-full overflow-hidden rounded-card border border-line bg-surface-2"
        style={{ aspectRatio: CardAspectRatio }}
        data-ratio="63/88"
      >
        <FeaturedCardImage card={card} />
        <span
          data-testid="dashboard-featured-quantity"
          className="absolute top-1 right-1 rounded-pill border border-line bg-surface-1/90 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-gold"
        >
          {t("dashboard.featured.quantity", { count: card.quantity })}
        </span>
        <span
          aria-hidden="true"
          className={`absolute bottom-1 left-1 h-1.5 w-1.5 rounded-pill ${FRESHNESS_DOT[freshness]}`}
        />
      </div>
      <div className="mt-1 flex min-w-0 flex-col">
        <span className="truncate text-xs font-semibold text-primary">{card.name}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {t("dashboard.featured.setNumber", {
            set: card.setCode ?? card.setName,
            number: card.localId,
          })}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span
            data-testid="dashboard-featured-price"
            className="font-mono text-xs font-bold tabular-nums text-gold"
          >
            {formatPriceCents(card.unitPriceCents) ?? "—"}
          </span>
          {delta === null ? null : (
            <span
              data-testid="dashboard-featured-delta"
              className={`font-mono text-[10px] tabular-nums ${deltaTone(card.delta30dPercent ?? 0)}`}
            >
              {delta}
            </span>
          )}
        </span>
      </div>
    </button>
  );
};

const FeaturedEmpty = () => (
  <div
    data-testid="dashboard-featured-empty"
    className="flex flex-col items-center gap-2 rounded-sheet border border-line bg-surface-1 px-6 py-8 text-center shadow-card"
  >
    <Sparkles size={28} strokeWidth={1.5} aria-hidden="true" className="text-muted" />
    <h3 className="text-sm font-bold text-primary">{t("dashboard.featured.empty.title")}</h3>
    <p className="max-w-xs text-xs text-secondary">{t("dashboard.featured.empty.description")}</p>
    <div className="mt-1 flex flex-wrap justify-center gap-2">
      <a
        href={SEARCH_PATH}
        style={touchTarget}
        className={`flex items-center rounded-pill border border-gold bg-gold-soft px-4 text-xs font-semibold text-gold ${focusRing}`}
      >
        {t("dashboard.featured.empty.ctaSearch")}
      </a>
      <a
        href={COLLECTION_PATH}
        style={touchTarget}
        className={`flex items-center rounded-pill border border-line bg-surface-2 px-4 text-xs font-semibold text-secondary transition-colors hover:text-primary ${focusRing}`}
      >
        {t("dashboard.featured.empty.ctaCollection")}
      </a>
    </div>
  </div>
);

const FeaturedSection = ({
  featuredCards,
  nowMs,
  onOpenCard,
}: {
  readonly featuredCards: ReadonlyArray<DashboardFeaturedCard>;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string, cardName: string) => void;
}) => (
  <section aria-labelledby="dashboard-featured-heading" className="flex flex-col gap-2">
    <h2 id="dashboard-featured-heading" className={sectionHeading}>
      {t("dashboard.featured.heading")}
    </h2>
    {featuredCards.length === 0 ? (
      <FeaturedEmpty />
    ) : (
      <div data-testid="dashboard-featured-grid" className="grid grid-cols-3 gap-3">
        {featuredCards.map((card) => (
          <FeaturedCardTile
            key={`${card.cardId}:${card.language}:${card.variant}`}
            card={card}
            nowMs={nowMs}
            onOpen={onOpenCard}
          />
        ))}
      </div>
    )}
  </section>
);

// ---------------------------------------------------------------------------
// Mes classeurs — grandes cards cover 1 image
// ---------------------------------------------------------------------------

/** Lien vers la grille du classeur. */
const binderHref = (binderId: string): string => `/binder/${binderId}`;

const pill =
  "inline-flex items-center gap-1 rounded-pill border border-line bg-surface-1/90 px-2 py-0.5 text-xs font-semibold text-primary";

/** Cover 1 image : logo extension / carte 63/88 / image uploadée, avec repli propre. */
const BinderCover = ({ binder }: { readonly binder: DashboardBinder }) => {
  const [failed, setFailed] = useState(false);
  let src: string | undefined;
  if (binder.coverType === "upload") src = binder.coverCustomUrl ?? undefined;
  else if (binder.coverType === "card") src = tcgdexCardImageUrl(binder.coverCardImageUrl, "low");
  else src = tcgdexSetLogoUrl(binder.coverLogoUrl);

  if (src === undefined || failed) {
    return (
      <div
        aria-hidden="true"
        data-testid="dashboard-binder-cover-fallback"
        className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted"
      >
        {binder.kind === "set" ? (
          <span className="font-mono text-2xl font-bold tabular-nums text-secondary">
            {binder.setCode ?? "—"}
          </span>
        ) : (
          <FolderHeart size={32} strokeWidth={1.5} />
        )}
      </div>
    );
  }
  if (binder.coverType === "card") {
    return (
      <div className="flex h-full w-full items-center justify-center py-3">
        <div className="h-full" style={{ aspectRatio: CardAspectRatio }} data-ratio="63/88">
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-full w-full rounded-card border border-line object-cover shadow-card"
          />
        </div>
      </div>
    );
  }
  return (
    <>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={
          binder.coverType === "upload"
            ? "h-full w-full object-cover"
            : "h-full w-full object-contain p-5"
        }
      />
      {binder.coverType === "upload" ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-b from-canvas/50 via-transparent to-canvas/40"
        />
      ) : null}
    </>
  );
};

const DashboardBinderCard = ({ binder }: { readonly binder: DashboardBinder }) => (
  <article
    data-testid="dashboard-binder-card"
    data-kind={binder.kind}
    data-cover={binder.coverType}
    className="relative flex flex-col overflow-hidden rounded-sheet border border-line bg-surface-1 shadow-card"
  >
    <a
      href={binderHref(binder.id)}
      aria-label={t("dashboard.binders.open", { title: binder.title })}
      className={`flex flex-col ${focusRing}`}
    >
      <div className="relative aspect-4/3 w-full overflow-hidden bg-surface-2">
        <BinderCover binder={binder} />
        <div className="absolute top-2 left-2 flex max-w-[70%] flex-wrap gap-1">
          {binder.kind === "set" ? (
            <span className={`${pill} font-mono tabular-nums`}>
              {binder.setCode ?? binder.title}
            </span>
          ) : (
            <span className={pill}>
              <Lock size={12} aria-hidden="true" />
              {t("dashboard.binders.private")}
            </span>
          )}
          {binder.isShared ? (
            <span className={pill} data-testid="dashboard-binder-shared">
              <Share2 size={12} aria-hidden="true" />
              {t("dashboard.binders.shared")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <h3 className="truncate text-sm font-bold text-primary">{binder.title}</h3>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-sm font-bold tabular-nums text-primary">
            {formatPercent(binder.completionPercent)}
          </span>
          <span aria-hidden="true" className="font-mono text-xs tabular-nums text-secondary">
            {binder.ownedCount}/{binder.totalCards}
          </span>
          <span className="sr-only">
            {t("dashboard.binders.ratio", { owned: binder.ownedCount, total: binder.totalCards })}
          </span>
        </div>
        <ProgressBar
          percent={binder.completionPercent}
          label={t("dashboard.binders.progress", { title: binder.title })}
        />
        <span
          data-testid="dashboard-binder-value"
          title={t("dashboard.binders.value")}
          className="font-mono text-xs tabular-nums text-gold"
        >
          {formatPriceCents(binder.estimatedValueCents)}
        </span>
      </div>
    </a>
  </article>
);

const BindersEmpty = () => (
  <div
    data-testid="dashboard-binders-empty"
    className="flex flex-col items-center gap-2 rounded-sheet border border-line bg-surface-1 px-6 py-8 text-center shadow-card"
  >
    <LibraryBig size={28} strokeWidth={1.5} aria-hidden="true" className="text-muted" />
    <h3 className="text-sm font-bold text-primary">{t("dashboard.binders.empty.title")}</h3>
    <p className="max-w-xs text-xs text-secondary">{t("dashboard.binders.empty.description")}</p>
    <a
      href={COLLECTION_PATH}
      style={touchTarget}
      className={`mt-1 flex items-center rounded-pill border border-gold bg-gold-soft px-4 text-xs font-semibold text-gold ${focusRing}`}
    >
      {t("dashboard.binders.empty.cta")}
    </a>
  </div>
);

const BindersSection = ({ binders }: { readonly binders: ReadonlyArray<DashboardBinder> }) => (
  <section aria-labelledby="dashboard-binders-heading" className="flex flex-col gap-2">
    <div className="flex items-baseline justify-between gap-3">
      <h2 id="dashboard-binders-heading" className={sectionHeading}>
        {t("dashboard.binders.heading")}
      </h2>
      <a
        href={COLLECTION_PATH}
        data-testid="dashboard-binders-see-all"
        className={`text-xs font-semibold text-accent-blue ${focusRing}`}
      >
        {t("dashboard.binders.seeAll")}
      </a>
    </div>
    {binders.length === 0 ? (
      <BindersEmpty />
    ) : (
      <div data-testid="dashboard-binders-grid" className="grid grid-cols-2 gap-3">
        {binders.map((binder) => (
          <DashboardBinderCard key={binder.id} binder={binder} />
        ))}
      </div>
    )}
  </section>
);

// ---------------------------------------------------------------------------
// Bandeau dernière alerte
// ---------------------------------------------------------------------------

const AlertBanner = ({
  alert,
  nowMs,
  onOpenCard,
}: {
  readonly alert: DashboardPayload["latestAlert"];
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string, cardName: string) => void;
}) => {
  if (alert === null) {
    return (
      <section
        aria-labelledby="dashboard-alert-heading"
        data-testid="dashboard-alert-empty"
        className="flex items-center gap-3 rounded-sheet border border-line bg-surface-1 px-3 py-2.5"
      >
        <h2 id="dashboard-alert-heading" className="sr-only">
          {t("dashboard.alert.heading")}
        </h2>
        <BellOff size={18} aria-hidden="true" className="shrink-0 text-muted" />
        <p className="flex-1 text-xs text-secondary">{t("dashboard.alert.empty")}</p>
        <a
          href={ALERTS_PATH}
          className={`shrink-0 text-xs font-semibold text-accent-blue ${focusRing}`}
        >
          {t("dashboard.alert.emptyCta")}
        </a>
      </section>
    );
  }
  const ageText = formatDashboardAge(computeRelativeAge(alert.triggeredAt, nowMs));
  return (
    <section
      aria-labelledby="dashboard-alert-heading"
      data-testid="dashboard-alert"
      className="flex items-center gap-3 rounded-sheet border border-success/40 bg-success/10 px-3 py-2.5"
    >
      <h2 id="dashboard-alert-heading" className="sr-only">
        {t("dashboard.alert.heading")}
      </h2>
      <BellRing size={18} aria-hidden="true" className="shrink-0 text-success-strong" />
      <button
        type="button"
        onClick={() => onOpenCard(alert.cardId, alert.cardName)}
        data-testid="dashboard-alert-open-card"
        className={`flex min-w-0 flex-1 flex-col items-start text-left ${focusRing}`}
      >
        <span className="w-full truncate text-xs font-bold text-primary">
          {t("dashboard.alert.triggered", { name: alert.cardName })}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-secondary">
          {t("dashboard.alert.detail", {
            price: formatPriceCents(alert.triggeredPriceCents) ?? "—",
            threshold: formatPriceCents(alert.thresholdCents) ?? "—",
          })}
          {ageText === null ? null : ` · ${t("dashboard.alert.age", { age: ageText })}`}
        </span>
      </button>
      <a
        href={ALERTS_PATH}
        className={`shrink-0 text-xs font-semibold text-accent-blue ${focusRing}`}
      >
        {t("dashboard.alert.seeAlerts")}
      </a>
    </section>
  );
};

// ---------------------------------------------------------------------------
// États de chargement / erreur
// ---------------------------------------------------------------------------

const Skeleton = () => (
  <div
    role="status"
    aria-label={t("dashboard.loading")}
    data-testid="dashboard-skeleton"
    className="flex flex-col gap-4 motion-reduce:animate-none"
  >
    <div aria-hidden="true" className="h-11 animate-pulse rounded-sheet bg-surface-2" />
    <div aria-hidden="true" className="grid grid-cols-3 gap-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
          key={index}
          className="animate-pulse rounded-card border border-line bg-surface-2"
          style={{ aspectRatio: CardAspectRatio }}
          data-ratio="63/88"
        />
      ))}
    </div>
    <div aria-hidden="true" className="grid grid-cols-2 gap-3">
      {Array.from({ length: 2 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
        <div key={index} className="aspect-4/3 animate-pulse rounded-sheet bg-surface-2" />
      ))}
    </div>
  </div>
);

const ErrorNotice = ({ onRetry }: { readonly onRetry: () => void }) => (
  <div
    data-testid="dashboard-error"
    className="flex flex-col items-center gap-3 rounded-sheet border border-line bg-surface-1 px-6 py-10 text-center shadow-card"
  >
    <CircleAlert size={32} strokeWidth={1.5} aria-hidden="true" className="text-muted" />
    <h2 className="text-base font-bold text-primary">{t("dashboard.error.title")}</h2>
    <p className="max-w-xs text-sm text-secondary">{t("dashboard.error.description")}</p>
    <button
      type="button"
      onClick={onRetry}
      style={touchTarget}
      className={`rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
    >
      {t("dashboard.error.retry")}
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

/**
 * `V2b · Accueil / Dashboard` : header compact (identité + thème + compte),
 * barre synthèse 1 ligne, cartes phares (top 3, ratio 63/88), mes classeurs
 * (grandes cards cover 1 image) et bandeau dernière alerte. 100 % tokens
 * Dark & Light (`tokens.css`), nombres en `font-mono tabular-nums`.
 */
export const DashboardView = ({ state, actions }: DashboardViewProps) => {
  const ready = state.data.status === "ready" ? state.data.data : null;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 pt-10 pb-40">
      <DashboardHeader />
      {state.data.status === "loading" ? <Skeleton /> : null}
      {state.data.status === "error" ? <ErrorNotice onRetry={actions.onRetry} /> : null}
      {ready === null ? null : (
        <>
          <SummaryBar summary={ready.summary} nowMs={state.nowMs} />
          <FeaturedSection
            featuredCards={ready.featuredCards}
            nowMs={state.nowMs}
            onOpenCard={actions.onOpenCard}
          />
          <BindersSection binders={ready.binders} />
          <AlertBanner
            alert={ready.latestAlert}
            nowMs={state.nowMs}
            onOpenCard={actions.onOpenCard}
          />
        </>
      )}
      <CardDetailSheet
        cardId={state.sheetCardId}
        cardName={state.sheetCardName ?? undefined}
        onClose={actions.onCloseCard}
      />
    </main>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : chargement `GET /api/dashboard`
// ---------------------------------------------------------------------------

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export const DashboardScreen = () => {
  const [data, setData] = useState<Loadable<DashboardPayload>>({ status: "loading" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sheetCard, setSheetCard] = useState<{ cardId: string; cardName: string } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    setNowMs(Date.now());
    fetchDashboard(controller.signal)
      .then((result) => {
        if (result.kind === "ok") setData({ status: "ready", data: result.payload });
        else if (result.kind === "unauthorized") {
          window.location.assign(loginRedirectTo(DASHBOARD_PATH));
        } else setData({ status: "error" });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setData({ status: "error" });
      });
    return () => controller.abort();
  }, [reloadToken]);

  const actions: DashboardViewActions = {
    onRetry: () => setReloadToken((token) => token + 1),
    onOpenCard: (cardId, cardName) => setSheetCard({ cardId, cardName }),
    onCloseCard: () => setSheetCard(null),
  };

  return (
    <DashboardView
      state={{
        data,
        nowMs,
        sheetCardId: sheetCard?.cardId ?? null,
        sheetCardName: sheetCard?.cardName ?? null,
      }}
      actions={actions}
    />
  );
};
