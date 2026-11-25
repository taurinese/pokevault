import {
  CARD_COPY_NOTES_MAX_LENGTH,
  CardAspectRatio,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  computePriceFreshness,
  MAX_CARD_COPY_QUANTITY,
  type PriceFreshness,
  tcgdexCardImageUrl,
  type UserCardCopy,
} from "@pokevault/domain";
import {
  BellPlus,
  ExternalLink,
  FolderPlus,
  Heart,
  ImageOff,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import {
  type AddCardCopyBody,
  addCardCopy,
  adjustCardCopyQuantity,
  type CardDetailBinder,
  type CardDetailCard,
  type CardDetailPayload,
  type CardDetailPrice,
  computePriceAge,
  cooldownMinutes,
  defaultVariantFor,
  fetchCardDetail,
  formatIsoDate,
  formatPriceCents,
  isSafeHttpsUrl,
  parsePurchasePriceEuros,
  refreshCardPrice,
  setCardInBinder,
} from "../lib/card-detail-client.ts";
import {
  AlertFormSheet,
  type AlertFormTarget,
  alertCardSubtitle,
  createAlertTarget,
} from "./AlertFormSheet.tsx";
import { BottomSheet } from "./BottomSheet.tsx";
import { Card3DInspector, type Card3DInspectorCard } from "./Card3DInspector.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** État du chargement `GET /api/cards/$cardId`. */
export type CardDetailLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly payload: CardDetailPayload };

/** Formulaire « + Ajouter un exemplaire ». */
export interface AddCopyFormState {
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly quantity: number;
  readonly priceRaw: string;
  readonly notes: string;
}

export type AddCopyFormError = "price" | "generic" | null;

/**
 * État du rafraîchissement manuel du prix :
 * - `loading` : requête en cours (bouton désactivé, icône qui tourne) ;
 * - `cooldown` : 429, prochain rafraîchissement possible à `nextAllowedAtMs` ;
 * - `unavailable` : 503, Cardmarket indisponible (erreur non bloquante) ;
 * - `degraded` : 200 mais Cardmarket KO, dernier prix connu servi ;
 * - `error` : autre échec (réseau, session…).
 */
export type PriceRefreshState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "cooldown"; readonly nextAllowedAtMs: number }
  | { readonly status: "unavailable" }
  | { readonly status: "degraded" }
  | { readonly status: "error" };

export interface CardDetailViewState {
  readonly load: CardDetailLoad;
  readonly wishlisted: boolean;
  readonly bindersOpen: boolean;
  readonly addFormOpen: boolean;
  readonly pendingCopyId: string | null;
  readonly pendingBinderId: string | null;
  readonly submittingAdd: boolean;
  readonly actionError: boolean;
  readonly statusMessage?: string | undefined;
  readonly form: AddCopyFormState;
  readonly formError: AddCopyFormError;
  /** Instant de référence (ms) du calcul de fraîcheur / d'âge du prix (horloge injectable). */
  readonly nowMs: number;
  readonly priceRefresh: PriceRefreshState;
}

export interface CardDetailViewActions {
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onToggleWishlist: () => void;
  /** Hook prêt pour M5 (Inspecteur 3D Holo). */
  readonly onOpenViewer3D?: (() => void) | undefined;
  readonly onToggleBinders: () => void;
  readonly onToggleBinder: (binder: CardDetailBinder) => void;
  readonly onToggleAddForm: () => void;
  readonly onFormChange: (patch: Partial<AddCopyFormState>) => void;
  readonly onSubmitAdd: () => void;
  readonly onStepper: (copy: UserCardCopy, delta: -1 | 1) => void;
  /** Rafraîchissement manuel du prix Cardmarket (`POST /api/cards/$cardId/price-refresh`). */
  readonly onRefreshPrice: () => void;
  /** Ouvre la Bottom Sheet `07C` (alerte de prix pré-remplie avec la carte et son prix courant). */
  readonly onOpenAlert?: (() => void) | undefined;
}

export interface CardDetailViewProps {
  readonly open: boolean;
  /** Titre de la feuille (nom de la carte, ou repli). */
  readonly title: string;
  readonly state: CardDetailViewState;
  readonly actions: CardDetailViewActions;
}

// ---------------------------------------------------------------------------
// Constantes d'affichage
// ---------------------------------------------------------------------------

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
const CONDITIONS: ReadonlyArray<CardCondition> = ["M", "NM", "EX", "GD", "LP", "PL", "PO"];
const CONDITION_LABELS: Record<CardCondition, TranslationKey> = {
  M: "cardDetail.condition.M",
  NM: "cardDetail.condition.NM",
  EX: "cardDetail.condition.EX",
  GD: "cardDetail.condition.GD",
  LP: "cardDetail.condition.LP",
  PL: "cardDetail.condition.PL",
  PO: "cardDetail.condition.PO",
};

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const badgeClass =
  "inline-flex items-center rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-secondary";

const sectionHeadingClass = "text-xs font-semibold tracking-wide text-muted uppercase";

const actionButtonClass = (active: boolean): string =>
  `inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-pill border px-3 text-sm font-semibold transition-colors disabled:opacity-40 ${focusRing} ${
    active
      ? "border-accent-blue bg-surface-2 text-accent-blue"
      : "border-line bg-surface-1 text-secondary hover:text-primary"
  }`;

const stepperButtonClass = `grid min-h-[44px] min-w-[44px] place-items-center rounded-pill border border-line bg-surface-2 text-secondary transition-colors hover:text-primary disabled:opacity-40 ${focusRing}`;

const selectClass = `min-h-11 w-full rounded-card border border-line bg-surface-2 px-2 text-sm text-primary ${focusRing}`;

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------

/** Grand visuel `high.webp` (ratio 63/88, coins 12px) tappable pour ouvrir l'Inspecteur 3D. */
const DetailImage = ({
  imageUrl,
  name,
  onOpenViewer3D,
}: {
  readonly imageUrl: string | undefined;
  readonly name: string;
  readonly onOpenViewer3D?: (() => void) | undefined;
}) => {
  const [failed, setFailed] = useState(false);
  const showImage = imageUrl !== undefined && !failed;
  const zoomDisabled = onOpenViewer3D === undefined;
  return (
    <div className="relative mx-auto w-full max-w-60">
      <button
        type="button"
        data-testid="card-detail-image"
        aria-label={t("cardDetail.image.zoom", { name })}
        disabled={zoomDisabled}
        onClick={() => onOpenViewer3D?.()}
        className={`relative block w-full overflow-hidden border border-line bg-surface-2 p-0 text-left shadow-card transition-transform enabled:cursor-pointer enabled:active:scale-[0.99] disabled:cursor-default ${focusRing}`}
        style={{ aspectRatio: CardAspectRatio, borderRadius: "12px" }}
      >
        {showImage ? (
          <img
            src={imageUrl}
            alt={name}
            loading="eager"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-muted"
          >
            <ImageOff size={24} />
            <span className="px-2 text-center text-[10px] leading-tight">
              {t("cardTile.imageFallback")}
            </span>
          </div>
        )}
      </button>
      <button
        type="button"
        data-testid="card-detail-zoom"
        aria-label={t("cardDetail.image.zoom", { name })}
        disabled={zoomDisabled}
        onClick={() => onOpenViewer3D?.()}
        className={`absolute top-2 right-2 grid min-h-[44px] min-w-[44px] place-items-center rounded-pill border border-line bg-surface-1/90 text-secondary backdrop-blur transition-colors hover:text-primary disabled:opacity-40 ${focusRing}`}
      >
        <Maximize2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
};

/** Ligne métadonnée (libellé discret + valeur). */
const MetaRow = ({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean | undefined;
}) => (
  <div className="flex min-w-0 items-baseline justify-between gap-3">
    <span className="shrink-0 text-xs text-muted">{label}</span>
    <span
      className={`min-w-0 truncate text-sm font-semibold text-primary ${
        mono ? "font-mono tabular-nums" : ""
      }`}
    >
      {value}
    </span>
  </div>
);

/** Sélecteur de formulaire (label + select). */
const FormSelect = <T extends string>({
  id,
  label,
  value,
  options,
  labels,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<T>;
  readonly labels: Record<T, TranslationKey>;
  readonly onChange: (value: T) => void;
}) => (
  <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-secondary">
    {label}
    <select
      id={id}
      data-testid={id}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={selectClass}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {t(labels[option])}
        </option>
      ))}
    </select>
  </label>
);

// ---------------------------------------------------------------------------
// Bloc prix Cardmarket (fraîcheur, âge réel, indicateurs, rafraîchissement)
// ---------------------------------------------------------------------------

/**
 * Âge relatif RÉEL d'un prix (`À l'instant`, `il y a 6 min`, `il y a 2 h`,
 * `il y a 3 j`), suivi de `· indicatif` quand le prix est `stale` (> 6 h ou repli
 * TCGdex). Jamais de texte figé : toujours calculé depuis `fetchedAt` et `nowMs`.
 */
export const formatPriceAgeLabel = (price: CardDetailPrice, nowMs: number): string => {
  const age = computePriceAge(price.fetchedAt, nowMs);
  const ageText =
    age === null
      ? t("price.age.unknown")
      : age.kind === "just_now"
        ? t("price.age.justNow")
        : age.kind === "minutes"
          ? t("price.age.minutesAgo", { count: age.count })
          : age.kind === "hours"
            ? t("price.age.hoursAgo", { count: age.count })
            : tPlural("price.age.daysAgo", age.count);
  return computePriceFreshness(price, nowMs) === "stale"
    ? t("price.age.indicative", { age: ageText })
    : ageText;
};

const FRESHNESS_STYLE: Readonly<
  Record<
    PriceFreshness,
    { readonly tone: string; readonly dot: string; readonly hint: TranslationKey }
  >
> = {
  fresh: {
    tone: "border-success text-success-strong",
    dot: "bg-success",
    hint: "price.freshness.fresh.hint",
  },
  aging: {
    tone: "border-warning text-warning",
    dot: "bg-warning",
    hint: "price.freshness.aging.hint",
  },
  stale: { tone: "border-line text-muted", dot: "bg-muted", hint: "price.freshness.stale.hint" },
  missing: {
    tone: "border-line text-muted",
    dot: "bg-muted",
    hint: "price.freshness.missing.hint",
  },
};

/** Pastille de fraîcheur + âge relatif (ou « Prix indisponible » sans snapshot). */
const FreshnessPill = ({
  price,
  nowMs,
}: {
  readonly price: CardDetailPrice | null;
  readonly nowMs: number;
}) => {
  const freshness = computePriceFreshness(price, nowMs);
  const style = FRESHNESS_STYLE[freshness];
  return (
    <span
      data-testid="card-detail-price-freshness"
      data-freshness={freshness}
      title={t(style.hint)}
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[11px] font-semibold ${style.tone}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-pill ${style.dot}`} />
      {price === null ? t("price.freshness.missing") : formatPriceAgeLabel(price, nowMs)}
    </span>
  );
};

/** Message de retour du rafraîchissement manuel (cooldown, indisponible, repli, erreur). */
const priceRefreshMessage = (
  refresh: PriceRefreshState,
  nowMs: number,
): { readonly key: string; readonly text: string } | null => {
  switch (refresh.status) {
    case "cooldown": {
      const remainingMs = refresh.nextAllowedAtMs - nowMs;
      return remainingMs > 0
        ? {
            key: "cooldown",
            text: t("cardDetail.price.cooldown", { minutes: cooldownMinutes(remainingMs) }),
          }
        : null;
    }
    case "unavailable":
      return { key: "unavailable", text: t("cardDetail.price.unavailable") };
    case "degraded":
      return { key: "degraded", text: t("cardDetail.price.degraded") };
    case "error":
      return { key: "error", text: t("cardDetail.price.error") };
    default:
      return null;
  }
};

const PriceBlock = ({
  name,
  price,
  cardmarketUrl,
  nowMs,
  refresh,
  onRefresh,
  onOpenAlert,
}: {
  readonly name: string;
  readonly price: CardDetailPrice | null;
  readonly cardmarketUrl: string | null;
  readonly nowMs: number;
  readonly refresh: PriceRefreshState;
  readonly onRefresh: () => void;
  readonly onOpenAlert?: (() => void) | undefined;
}) => {
  const message = priceRefreshMessage(refresh, nowMs);
  const loading = refresh.status === "loading";
  const coolingDown = refresh.status === "cooldown" && refresh.nextAllowedAtMs > nowMs;
  const indicators: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly cents: number | null;
  }> = [
    {
      id: "trend",
      label: t("cardDetail.price.trend"),
      cents: price?.trendCents ?? null,
    },
    { id: "low-fr", label: t("cardDetail.price.lowFr"), cents: price?.lowFrCents ?? null },
    { id: "avg30", label: t("cardDetail.price.avg30"), cents: price?.avg30Cents ?? null },
  ];
  return (
    <section
      data-testid="card-detail-price"
      aria-label={t("cardDetail.price.heading")}
      className="flex flex-col gap-2 rounded-sheet border border-line bg-surface-1 p-3 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={sectionHeadingClass}>{t("cardDetail.price.heading")}</h3>
        <FreshnessPill price={price} nowMs={nowMs} />
      </div>
      {price === null ? (
        <p data-testid="card-detail-price-none" className="text-sm text-secondary">
          {t("cardDetail.price.none")}
        </p>
      ) : null}
      <dl data-testid="card-detail-price-values" className="grid grid-cols-3 gap-2">
        {indicators.map((indicator) => (
          <div
            key={indicator.id}
            className="flex min-w-0 flex-col gap-0.5 rounded-card border border-line bg-surface-2 px-2 py-1.5"
          >
            <dt className="truncate text-[11px] text-muted">{indicator.label}</dt>
            <dd
              data-testid={`card-detail-price-${indicator.id}`}
              className="truncate font-mono text-sm font-semibold tabular-nums text-primary"
            >
              {formatPriceCents(indicator.cents) ?? t("cardDetail.price.empty")}
            </dd>
          </div>
        ))}
      </dl>
      <output
        aria-live="polite"
        data-testid="card-detail-price-message"
        data-state={message?.key ?? "none"}
        className={`text-xs ${
          message === null
            ? "sr-only"
            : message.key === "cooldown"
              ? "text-secondary"
              : message.key === "degraded"
                ? "text-warning"
                : "text-danger"
        }`}
      >
        {message?.text ?? ""}
      </output>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="card-detail-price-refresh"
          aria-label={t("cardDetail.price.refresh.aria", { name })}
          aria-busy={loading}
          disabled={loading || coolingDown}
          onClick={onRefresh}
          className={`inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-gold bg-gold-soft px-3 text-sm font-semibold text-gold transition-colors disabled:opacity-40 ${focusRing}`}
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            className={loading ? "animate-spin motion-reduce:animate-none" : ""}
          />
          <span aria-hidden="true">
            {loading ? t("cardDetail.price.refreshing") : t("cardDetail.price.refresh")}
          </span>
        </button>
        {onOpenAlert === undefined ? null : (
          <button
            type="button"
            data-testid="card-detail-price-alert"
            aria-label={t("cardDetail.price.alert.aria", { name })}
            onClick={onOpenAlert}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-success/40 bg-success/10 px-3 text-sm font-semibold text-success-strong transition-colors ${focusRing}`}
          >
            <BellPlus size={14} aria-hidden="true" />
            <span aria-hidden="true">{t("cardDetail.price.alert")}</span>
          </button>
        )}
        {isSafeHttpsUrl(cardmarketUrl) ? (
          <a
            data-testid="card-detail-cardmarket-link"
            href={cardmarketUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("cardDetail.price.link.aria")}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-line bg-surface-2 px-3 text-sm font-semibold text-accent-blue hover:text-primary ${focusRing}`}
          >
            {t("cardDetail.price.link")}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Contenu de la fiche (état « ready »)
// ---------------------------------------------------------------------------

const CardDetailContent = ({
  payload,
  state,
  actions,
}: {
  readonly payload: CardDetailPayload;
  readonly state: CardDetailViewState;
  readonly actions: CardDetailViewActions;
}) => {
  const { card, copies, customBinders } = payload;
  const imageUrl = tcgdexCardImageUrl(card.imageBaseUrl, "high");

  const metaRows: ReadonlyArray<{ label: string; value: string; mono?: boolean }> = [
    {
      label: t("cardDetail.meta.number"),
      value: `${card.localId}/${card.officialCount}`,
      mono: true,
    },
    {
      label: t("cardDetail.meta.set"),
      value: card.setCode === null ? card.setNameFr : `${card.setNameFr} (${card.setCode})`,
    },
    ...(card.illustrator === null
      ? []
      : [{ label: t("cardDetail.meta.illustrator"), value: card.illustrator }]),
    ...(card.types.length === 0
      ? []
      : [{ label: t("cardDetail.meta.types"), value: card.types.join(" · ") }]),
    ...(card.hp === null
      ? []
      : [{ label: t("cardDetail.meta.hp"), value: String(card.hp), mono: true }]),
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="card-detail-content">
      <DetailImage imageUrl={imageUrl} name={card.nameFr} onOpenViewer3D={actions.onOpenViewer3D} />

      {/* Métadonnées TCGdex */}
      <section
        data-testid="card-detail-meta"
        aria-label={card.nameFr}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center justify-center gap-2">
          <h3 className="text-center text-base font-bold text-primary">{card.nameFr}</h3>
          {card.rarity === null ? null : (
            <span data-testid="card-detail-rarity" className={`${badgeClass} text-gold`}>
              {card.rarity}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5 rounded-sheet border border-line bg-surface-1 p-3 shadow-card">
          {metaRows.map((row) => (
            <MetaRow key={row.label} label={row.label} value={row.value} mono={row.mono} />
          ))}
        </div>
      </section>

      {/* Actions rapides : wishlist + dossier perso */}
      <section className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="card-detail-wishlist"
            aria-pressed={state.wishlisted}
            aria-label={t(
              state.wishlisted ? "cardDetail.wishlist.remove" : "cardDetail.wishlist.add",
              { name: card.nameFr },
            )}
            onClick={actions.onToggleWishlist}
            className={actionButtonClass(state.wishlisted)}
          >
            <Heart size={16} aria-hidden="true" fill={state.wishlisted ? "currentColor" : "none"} />
            <span className="sr-only">
              {t(state.wishlisted ? "cardDetail.wishlist.remove" : "cardDetail.wishlist.add", {
                name: card.nameFr,
              })}
            </span>
            <span aria-hidden="true">{t("nav.wishlist")}</span>
          </button>
          <button
            type="button"
            data-testid="card-detail-binders-toggle"
            aria-expanded={state.bindersOpen}
            aria-controls="card-detail-binders-panel"
            aria-label={t("cardDetail.binders.toggle")}
            onClick={actions.onToggleBinders}
            className={actionButtonClass(state.bindersOpen)}
          >
            <FolderPlus size={16} aria-hidden="true" />
            <span aria-hidden="true">{t("cardDetail.binders.toggle")}</span>
          </button>
        </div>
        <p className="px-1 text-[11px] text-muted">{t("cardDetail.wishlist.soon")}</p>
      </section>

      {/* Sélecteur de dossiers perso (inline) */}
      {state.bindersOpen ? (
        <section
          id="card-detail-binders-panel"
          data-testid="card-detail-binders-panel"
          aria-label={t("cardDetail.binders.heading")}
          className="flex flex-col gap-2 rounded-sheet border border-line bg-surface-1 p-3 shadow-card"
        >
          <h3 className={sectionHeadingClass}>{t("cardDetail.binders.heading")}</h3>
          {customBinders.length === 0 ? (
            <p data-testid="card-detail-binders-empty" className="text-sm text-secondary">
              {t("cardDetail.binders.empty")}
            </p>
          ) : (
            customBinders.map((binder) => {
              const pending = state.pendingBinderId === binder.id;
              return (
                <button
                  key={binder.id}
                  type="button"
                  data-testid={`card-detail-binder-${binder.id}`}
                  aria-pressed={binder.containsCard}
                  aria-label={t(
                    binder.containsCard ? "cardDetail.binders.remove" : "cardDetail.binders.add",
                    { name: card.nameFr, title: binder.title },
                  )}
                  disabled={pending}
                  onClick={() => actions.onToggleBinder(binder)}
                  className={`flex min-h-11 items-center justify-between gap-2 rounded-card border px-3 text-sm font-semibold transition-colors disabled:opacity-40 ${focusRing} ${
                    binder.containsCard
                      ? "border-accent-blue bg-surface-2 text-accent-blue"
                      : "border-line bg-surface-2 text-secondary hover:text-primary"
                  }`}
                >
                  <span className="min-w-0 truncate">{binder.title}</span>
                  <span
                    aria-hidden="true"
                    className={`shrink-0 font-mono text-xs tabular-nums ${
                      binder.containsCard ? "text-accent-blue" : "text-muted"
                    }`}
                  >
                    {binder.containsCard ? "✓" : "+"}
                  </span>
                </button>
              );
            })
          )}
        </section>
      ) : null}

      {/* Bloc prix Cardmarket : fraîcheur, âge réel, indicateurs, rafraîchissement manuel */}
      <PriceBlock
        name={card.nameFr}
        price={payload.price}
        cardmarketUrl={card.cardmarketUrl}
        nowMs={state.nowMs}
        refresh={state.priceRefresh}
        onRefresh={actions.onRefreshPrice}
        onOpenAlert={actions.onOpenAlert}
      />

      {/* Mes exemplaires */}
      <section className="flex flex-col gap-2" aria-label={t("cardDetail.copies.heading")}>
        <output aria-live="polite" data-testid="card-detail-live-status" className="sr-only">
          {state.statusMessage ?? ""}
        </output>
        <h3 className={sectionHeadingClass} data-testid="card-detail-copies-heading">
          {t("cardDetail.copies.heading")}
          <span className="ml-1 font-mono tabular-nums">
            {copies.reduce((sum, copy) => sum + copy.quantity, 0)}
          </span>
        </h3>
        {state.actionError ? (
          <p role="alert" data-testid="card-detail-action-error" className="text-xs text-danger">
            {t("cardDetail.error.action")}
          </p>
        ) : null}
        {copies.length === 0 ? (
          <p data-testid="card-detail-copies-empty" className="text-sm text-secondary">
            {t("cardDetail.copies.empty")}
          </p>
        ) : (
          <ul data-testid="card-detail-copies" className="flex flex-col gap-2">
            {copies.map((copy) => {
              const pending = state.pendingCopyId === copy.id;
              const price = formatPriceCents(copy.purchasePriceCents);
              const acquired = formatIsoDate(copy.acquiredAt ?? copy.createdAt);
              return (
                <li
                  key={copy.id}
                  data-testid={`card-detail-copy-${copy.id}`}
                  className="flex flex-col gap-2 rounded-sheet border border-line bg-surface-1 p-3 shadow-card"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={badgeClass}>{t(LANGUAGE_LABELS[copy.language])}</span>
                    <span className={badgeClass}>{t(VARIANT_LABELS[copy.variant])}</span>
                    <span className={badgeClass}>{t(CONDITION_LABELS[copy.condition])}</span>
                    {copy.gradingCompany !== null && copy.gradingScore !== null ? (
                      <span
                        data-testid={`card-detail-grading-${copy.id}`}
                        className={`${badgeClass} text-gold`}
                      >
                        {t("cardDetail.copy.grading", {
                          company: copy.gradingCompany,
                          score: copy.gradingScore,
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-muted">
                    {acquired === null ? null : (
                      <span>{t("cardDetail.copy.addedOn", { date: acquired })}</span>
                    )}
                    {price === null ? null : (
                      <span data-testid={`card-detail-price-${copy.id}`} className="text-secondary">
                        {t("cardDetail.copy.price", { price })}
                      </span>
                    )}
                  </div>
                  {copy.notes === null || copy.notes === "" ? null : (
                    <p className="text-xs text-secondary">{copy.notes}</p>
                  )}
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      data-testid={`card-detail-minus-${copy.id}`}
                      aria-label={t("cardDetail.stepper.minus", { name: card.nameFr })}
                      disabled={pending}
                      onClick={() => actions.onStepper(copy, -1)}
                      className={stepperButtonClass}
                    >
                      <Minus size={16} aria-hidden="true" />
                    </button>
                    <span
                      data-testid={`card-detail-qty-${copy.id}`}
                      className="min-w-8 text-center font-mono text-sm font-semibold tabular-nums text-primary"
                    >
                      <span className="sr-only">
                        {t("cardDetail.stepper.quantity", { count: copy.quantity })}
                      </span>
                      {copy.quantity}
                    </span>
                    <button
                      type="button"
                      data-testid={`card-detail-plus-${copy.id}`}
                      aria-label={t("cardDetail.stepper.plus", { name: card.nameFr })}
                      disabled={pending || copy.quantity >= MAX_CARD_COPY_QUANTITY}
                      onClick={() => actions.onStepper(copy, 1)}
                      className={stepperButtonClass}
                    >
                      <Plus size={16} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Formulaire « + Ajouter un exemplaire » (dépliable inline) */}
      <section className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="card-detail-add-toggle"
          aria-expanded={state.addFormOpen}
          aria-controls="card-detail-add-form"
          onClick={actions.onToggleAddForm}
          className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill border border-gold bg-gold-soft px-4 text-sm font-semibold text-gold ${focusRing}`}
        >
          <Plus size={16} aria-hidden="true" />
          {t("cardDetail.add.toggle")}
        </button>
        {state.addFormOpen ? (
          <form
            id="card-detail-add-form"
            data-testid="card-detail-add-form"
            className="flex flex-col gap-3 rounded-sheet border border-line bg-surface-1 p-3 shadow-card"
            onSubmit={(event) => {
              event.preventDefault();
              actions.onSubmitAdd();
            }}
          >
            <h3 className={sectionHeadingClass}>{t("cardDetail.add.heading")}</h3>
            <div className="grid grid-cols-2 gap-2">
              <FormSelect
                id="card-detail-form-language"
                label={t("cardDetail.add.language")}
                value={state.form.language}
                options={LANGUAGES}
                labels={LANGUAGE_LABELS}
                onChange={(value) => actions.onFormChange({ language: value })}
              />
              <FormSelect
                id="card-detail-form-variant"
                label={t("cardDetail.add.variant")}
                value={state.form.variant}
                options={VARIANTS}
                labels={VARIANT_LABELS}
                onChange={(value) => actions.onFormChange({ variant: value })}
              />
              <FormSelect
                id="card-detail-form-condition"
                label={t("cardDetail.add.condition")}
                value={state.form.condition}
                options={CONDITIONS}
                labels={CONDITION_LABELS}
                onChange={(value) => actions.onFormChange({ condition: value })}
              />
              <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-secondary">
                {t("cardDetail.add.quantity")}
                <input
                  id="card-detail-form-quantity"
                  data-testid="card-detail-form-quantity"
                  type="number"
                  min={1}
                  max={MAX_CARD_COPY_QUANTITY}
                  step={1}
                  value={state.form.quantity}
                  onChange={(event) =>
                    actions.onFormChange({ quantity: Number(event.target.value) })
                  }
                  className={selectClass}
                />
              </label>
            </div>
            <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-secondary">
              {t("cardDetail.add.price")}
              <input
                id="card-detail-form-price"
                data-testid="card-detail-form-price"
                type="text"
                inputMode="decimal"
                placeholder={t("cardDetail.add.price.placeholder")}
                value={state.form.priceRaw}
                onChange={(event) => actions.onFormChange({ priceRaw: event.target.value })}
                aria-invalid={state.formError === "price"}
                className={`${selectClass} font-mono tabular-nums`}
              />
            </label>
            {state.formError === "price" ? (
              <p role="alert" className="text-xs text-danger">
                {t("cardDetail.add.price.invalid")}
              </p>
            ) : null}
            <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-secondary">
              {t("cardDetail.add.notes")}
              <textarea
                id="card-detail-form-notes"
                data-testid="card-detail-form-notes"
                rows={2}
                maxLength={CARD_COPY_NOTES_MAX_LENGTH}
                placeholder={t("cardDetail.add.notes.placeholder")}
                value={state.form.notes}
                onChange={(event) => actions.onFormChange({ notes: event.target.value })}
                className={`w-full rounded-card border border-line bg-surface-2 px-2 py-1.5 text-sm text-primary ${focusRing}`}
              />
            </label>
            {state.formError === "generic" ? (
              <p role="alert" data-testid="card-detail-add-error" className="text-xs text-danger">
                {t("cardDetail.add.error")}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                data-testid="card-detail-add-submit"
                disabled={state.submittingAdd}
                className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-pill border border-gold bg-gold-soft px-4 text-sm font-semibold text-gold disabled:opacity-40 ${focusRing}`}
              >
                {state.submittingAdd ? t("cardDetail.add.submitting") : t("cardDetail.add.submit")}
              </button>
              <button
                type="button"
                data-testid="card-detail-add-cancel"
                onClick={actions.onToggleAddForm}
                className={`inline-flex min-h-11 items-center justify-center rounded-pill border border-line bg-surface-2 px-4 text-sm font-semibold text-secondary ${focusRing}`}
              >
                {t("cardDetail.add.cancel")}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Vue pure (BottomSheet + contenu selon l'état de chargement)
// ---------------------------------------------------------------------------

/**
 * Bottom Sheet `04 · Fiche Carte` (vue pure) : grand visuel `high.webp`
 * (`63/88`, coins 12px, fallback `ImageOff`), métadonnées TCGdex, actions
 * rapides (wishlist, dossier perso), bloc prix Cardmarket (pastille de fraîcheur,
 * âge réel, Tendance / Plus bas FR / Moy. 30 j, rafraîchissement manuel, lien externe
 * sécurisé), et bloc « Mes exemplaires » (stepper `- / qty / +` + formulaire
 * d'ajout). Dark & Light 100 % tokens CSS (zéro hex brut), chiffres en
 * `font-mono tabular-nums`, libellés 100 % i18n (`cardDetail.*`).
 */
export const CardDetailView = ({ open, title, state, actions }: CardDetailViewProps) => (
  <BottomSheet open={open} onClose={actions.onClose} title={title}>
    {state.load.status === "ready" ? (
      <CardDetailContent payload={state.load.payload} state={state} actions={actions} />
    ) : state.load.status === "loading" ? (
      <div
        role="status"
        data-testid="card-detail-loading"
        aria-label={t("cardDetail.loading")}
        className="flex flex-col items-center gap-3 py-10"
      >
        <span className="sr-only">{t("cardDetail.loading")}</span>
        <div
          aria-hidden="true"
          className="w-full max-w-60 animate-pulse rounded-card border border-line bg-surface-2 motion-reduce:animate-none"
          style={{ aspectRatio: CardAspectRatio }}
        />
      </div>
    ) : (
      <div
        data-testid="card-detail-error"
        className="flex flex-col items-center gap-3 py-10 text-center"
      >
        <span aria-hidden="true" className="text-muted">
          <TriangleAlert size={28} />
        </span>
        <h3 className="text-base font-bold text-primary">{t("cardDetail.error.title")}</h3>
        <p className="max-w-xs text-sm text-secondary">{t("cardDetail.error.description")}</p>
        <button
          type="button"
          data-testid="card-detail-retry"
          onClick={actions.onRetry}
          className={`inline-flex min-h-11 items-center justify-center rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
        >
          {t("cardDetail.error.retry")}
        </button>
      </div>
    )}
  </BottomSheet>
);

// ---------------------------------------------------------------------------
// Conteneur : fetch `/api/cards/$cardId`, mutations, rafraîchissement
// ---------------------------------------------------------------------------

export interface CardDetailSheetProps {
  /** `null` → feuille fermée. */
  readonly cardId: string | null;
  /** Nom de la carte (titre de la feuille avant chargement). */
  readonly cardName?: string | undefined;
  /** Wishlist initiale (M3 T7.1) ; état visuel local en attendant. */
  readonly initialWishlisted?: boolean | undefined;
  readonly onClose: () => void;
  /** Notifié après chaque mutation d'exemplaire (rechargement silencieux de la grille). */
  readonly onCopiesChanged?: (() => void) | undefined;
  /** Hook wishlist (M3 T7.1) ; sans callback, retour visuel local uniquement. */
  readonly onToggleWishlist?: ((cardId: string, wishlisted: boolean) => void) | undefined;
  /** Hook Inspecteur 3D (M5). */
  readonly onOpenViewer3D?: ((cardId: string) => void) | undefined;
}

/** Période de mise à jour de l'horloge d'âge / fraîcheur du prix. */
const PRICE_CLOCK_TICK_MS = 30_000;

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const emptyForm = (availableVariants: ReadonlyArray<CardVariant>): AddCopyFormState => ({
  language: "FR",
  variant: defaultVariantFor(availableVariants),
  condition: "NM",
  quantity: 1,
  priceRaw: "",
  notes: "",
});

/**
 * Un rechargement silencieux n'est autorisé que lorsque la fiche actuellement
 * chargée correspond au même `cardId` (jamais après fermeture ou changement de carte).
 */
export const isSilentCardReload = (
  loadedCardId: string | null,
  nextCardId: string | null,
): boolean => nextCardId !== null && loadedCardId === nextCardId;

/** Applique immédiatement le résultat d'un stepper à la liste locale avant rechargement silencieux. */
export const applyStepperResultToPayload = (
  payload: CardDetailPayload,
  copyId: string,
  result: { readonly copy: UserCardCopy | null; readonly deleted: boolean },
): CardDetailPayload => {
  if (result.deleted) {
    return { ...payload, copies: payload.copies.filter((item) => item.id !== copyId) };
  }
  const updated = result.copy;
  if (updated === null) return payload;
  return {
    ...payload,
    copies: payload.copies.map((item) => (item.id === copyId ? updated : item)),
  };
};

/** Projette les métadonnées de la fiche carte vers le contrat de `Card3DInspector`. */
export const toCardDetailInspectorCard = (card: CardDetailCard): Card3DInspectorCard => ({
  cardId: card.id,
  name: card.nameFr,
  setLabel: card.setCode ?? card.setNameFr,
  numberLabel: `${card.localId}/${card.officialCount}`,
  rarity: card.rarity,
  holoEffect: card.holoEffect,
  types: card.types,
  imageBaseUrl: card.imageBaseUrl,
});

/**
 * Bottom Sheet `04 · Fiche Carte` (conteneur) : charge la fiche via
 * `GET /api/cards/$cardId`, applique les mutations (`POST/PATCH/DELETE`) puis
 * recharge la fiche silencieusement et notifie le parent (`onCopiesChanged`)
 * pour que la grille classeur mette à jour badges `×N` et complétion.
 */
export const CardDetailSheet = ({
  cardId,
  cardName,
  initialWishlisted = false,
  onClose,
  onCopiesChanged,
  onToggleWishlist,
  onOpenViewer3D,
}: CardDetailSheetProps) => {
  const [load, setLoad] = useState<CardDetailLoad>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [wishlisted, setWishlisted] = useState(initialWishlisted);
  const [bindersOpen, setBindersOpen] = useState(false);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [pendingCopyId, setPendingCopyId] = useState<string | null>(null);
  const [pendingBinderId, setPendingBinderId] = useState<string | null>(null);
  const [submittingAdd, setSubmittingAdd] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<AddCopyFormState>(() => emptyForm(["normal"]));
  const [formError, setFormError] = useState<AddCopyFormError>(null);
  const [priceRefresh, setPriceRefresh] = useState<PriceRefreshState>({ status: "idle" });
  const [alertTarget, setAlertTarget] = useState<AlertFormTarget | null>(null);
  const [viewer3dCardId, setViewer3dCardId] = useState<string | null>(null);
  // Horloge du calcul de fraîcheur : rafraîchie toutes les 30 s tant que la fiche est ouverte.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Identifiant de la carte actuellement chargée : évite d'afficher les données
  // d'une carte A pendant le chargement de la carte B.
  const loadedCardIdRef = useRef<string | null>(null);
  // Carte actuellement ouverte (résultats asynchrones obsolètes ignorés).
  const activeCardIdRef = useRef<string | null>(cardId);
  activeCardIdRef.current = cardId;

  useEffect(() => {
    if (cardId === null) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), PRICE_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [cardId]);

  useEffect(() => {
    // Reset de l'état visuel local quand on ferme ou ouvre une autre carte.
    if (cardId === null) {
      loadedCardIdRef.current = null;
      setAlertTarget(null);
      setViewer3dCardId(null);
      setPriceRefresh({ status: "idle" });
      setLoad({ status: "loading" });
      setBindersOpen(false);
      setAddFormOpen(false);
      setPendingCopyId(null);
      setPendingBinderId(null);
      setActionError(false);
      setFormError(null);
      setStatusMessage(undefined);
      return;
    }
    setWishlisted(initialWishlisted);
    setActionError(false);
  }, [cardId, initialWishlisted]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` relance volontairement un chargement silencieux
  useEffect(() => {
    if (cardId === null) return;
    const controller = new AbortController();
    const silent = isSilentCardReload(loadedCardIdRef.current, cardId);
    if (!silent) {
      loadedCardIdRef.current = null;
      setAlertTarget(null);
      setPriceRefresh({ status: "idle" });
      setLoad({ status: "loading" });
      setBindersOpen(false);
      setAddFormOpen(false);
      setActionError(false);
      setFormError(null);
      setStatusMessage(undefined);
    }
    fetchCardDetail(cardId, controller.signal)
      .then((result) => {
        if (result.kind === "ok") {
          const isFirstLoadForCard = loadedCardIdRef.current !== cardId;
          loadedCardIdRef.current = cardId;
          setLoad({ status: "ready", payload: result.payload });
          // N'écrase pas une saisie en cours lors d'un rechargement silencieux.
          if (isFirstLoadForCard) {
            setForm(emptyForm(result.payload.card.availableVariants));
          }
        } else {
          loadedCardIdRef.current = null;
          setLoad({ status: "error" });
        }
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          loadedCardIdRef.current = null;
          setLoad({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [cardId, reloadToken]);

  const refresh = () => {
    setActionError(false);
    setReloadToken((token) => token + 1);
  };

  const handleStepper = async (copy: UserCardCopy, delta: -1 | 1) => {
    setPendingCopyId(copy.id);
    const result = await adjustCardCopyQuantity(copy.id, delta);
    setPendingCopyId(null);
    if (result.kind === "ok") {
      const nextCount = result.body.deleted
        ? 0
        : (result.body.copy?.quantity ?? Math.max(0, copy.quantity + delta));
      setLoad((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              payload: applyStepperResultToPayload(current.payload, copy.id, result.body),
            }
          : current,
      );
      setStatusMessage(t("cardDetail.stepper.quantity", { count: nextCount }));
      refresh();
      onCopiesChanged?.();
    } else {
      setActionError(true);
    }
  };

  const handleToggleBinder = async (binder: CardDetailBinder) => {
    if (cardId === null) return;
    setPendingBinderId(binder.id);
    const result = await setCardInBinder(cardId, binder.id, !binder.containsCard);
    setPendingBinderId(null);
    if (result.kind === "ok") {
      refresh();
      onCopiesChanged?.();
    } else {
      setActionError(true);
    }
  };

  const handleSubmitAdd = async () => {
    if (cardId === null) return;
    const price = parsePurchasePriceEuros(form.priceRaw);
    if (!price.ok) {
      setFormError("price");
      return;
    }
    const quantity = Math.min(MAX_CARD_COPY_QUANTITY, Math.max(1, Math.trunc(form.quantity) || 1));
    const notes = form.notes.trim();
    const body: AddCardCopyBody = {
      language: form.language,
      variant: form.variant,
      condition: form.condition,
      quantity,
      purchasePriceCents: price.cents,
      notes: notes === "" ? null : notes,
    };
    setFormError(null);
    setSubmittingAdd(true);
    const result = await addCardCopy(cardId, body);
    setSubmittingAdd(false);
    if (result.kind === "ok") {
      setAddFormOpen(false);
      setForm(emptyForm(readyPayload?.card.availableVariants ?? ["normal"]));
      setStatusMessage(t("cardDetail.stepper.quantity", { count: result.body.quantity }));
      refresh();
      onCopiesChanged?.();
    } else {
      setFormError("generic");
    }
  };

  const handleRefreshPrice = async () => {
    if (cardId === null || priceRefresh.status === "loading") return;
    setPriceRefresh({ status: "loading" });
    const result = await refreshCardPrice(cardId);
    // La fiche a changé (ou s'est fermée) pendant la requête : résultat obsolète.
    if (activeCardIdRef.current !== cardId) return;
    const now = Date.now();
    setNowMs(now);
    switch (result.kind) {
      case "ok":
        setLoad((current) =>
          current.status === "ready"
            ? { status: "ready", payload: { ...current.payload, price: result.price } }
            : current,
        );
        setPriceRefresh(
          result.refresh === "degraded" ? { status: "degraded" } : { status: "idle" },
        );
        setStatusMessage(t("cardDetail.price.updated"));
        return;
      case "cooldown": {
        const fromServer =
          result.nextAllowedAt === null ? Number.NaN : Date.parse(result.nextAllowedAt);
        setPriceRefresh({
          status: "cooldown",
          nextAllowedAtMs: Number.isNaN(fromServer) ? now + result.retryAfterMs : fromServer,
        });
        return;
      }
      case "unavailable":
        setPriceRefresh({ status: "unavailable" });
        return;
      default:
        setPriceRefresh({ status: "error" });
    }
  };

  const handleToggleWishlist = () => {
    if (cardId === null) return;
    const next = !wishlisted;
    setWishlisted(next);
    onToggleWishlist?.(cardId, next);
  };

  const readyPayload = load.status === "ready" ? load.payload : null;

  /** Ouvre `07C` pré-rempli : carte, variante par défaut et prix Cardmarket courant (si coté). */
  const handleOpenAlert = () => {
    if (readyPayload === null) return;
    const { card, price } = readyPayload;
    setAlertTarget(
      createAlertTarget({
        cardId: card.id,
        cardName: card.nameFr,
        subtitle: alertCardSubtitle(card.localId, card.setNameFr),
        imageUrl: tcgdexCardImageUrl(card.imageBaseUrl, "low") ?? null,
        availableVariants: card.availableVariants,
        // Un prix indicatif TCGdex n'alerte jamais : pas de référence pour les raccourcis.
        price: price !== null && price.source === "cardmarket" ? price : null,
      }),
    );
  };

  const title = readyPayload?.card.nameFr ?? cardName ?? t("cardDetail.title");

  const viewer3dOpen =
    cardId !== null &&
    viewer3dCardId === cardId &&
    readyPayload !== null &&
    readyPayload.card.id === cardId;

  const actions: CardDetailViewActions = {
    onClose,
    onRetry: () => {
      loadedCardIdRef.current = null;
      setReloadToken((token) => token + 1);
    },
    onToggleWishlist: handleToggleWishlist,
    ...(cardId === null || readyPayload === null
      ? {}
      : {
          onOpenViewer3D: () => {
            setViewer3dCardId(cardId);
            onOpenViewer3D?.(cardId);
          },
        }),
    onToggleBinders: () => setBindersOpen((open) => !open),
    onToggleBinder: (binder) => void handleToggleBinder(binder),
    onToggleAddForm: () => {
      setFormError(null);
      setAddFormOpen((open) => !open);
    },
    onFormChange: (patch) => setForm((current) => ({ ...current, ...patch })),
    onSubmitAdd: () => void handleSubmitAdd(),
    onStepper: (copy, delta) => void handleStepper(copy, delta),
    onRefreshPrice: () => void handleRefreshPrice(),
    onOpenAlert: handleOpenAlert,
  };

  return (
    <>
      <CardDetailView
        open={cardId !== null}
        title={title}
        state={{
          load,
          wishlisted,
          bindersOpen,
          addFormOpen,
          pendingCopyId,
          pendingBinderId,
          submittingAdd,
          actionError,
          statusMessage,
          form,
          formError,
          nowMs,
          priceRefresh,
        }}
        actions={actions}
      />
      <AlertFormSheet
        target={cardId === null ? null : alertTarget}
        onClose={() => setAlertTarget(null)}
        onSaved={() => {
          setAlertTarget(null);
          setStatusMessage(t("alerts.toast.created", { name: title }));
        }}
      />
      {readyPayload === null ? null : (
        <Card3DInspector
          open={viewer3dOpen}
          card={toCardDetailInspectorCard(readyPayload.card)}
          onClose={() => setViewer3dCardId(null)}
        />
      )}
    </>
  );
};
