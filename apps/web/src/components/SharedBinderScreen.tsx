import {
  CardAspectRatio,
  type CardLanguage,
  type CardVariant,
  type SharedBinderCard,
  type SharedBinderPayload,
  tcgdexCardImageUrl,
  tcgdexSetLogoUrl,
} from "@pokevault/domain";
import { Link } from "@tanstack/react-router";
import { Eye, ImageOff, LinkIcon, SearchX, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type TranslationKey, t } from "../i18n/index.ts";
import {
  countSharedFilter,
  fetchSharedBinder,
  filterSharedCards,
  SHARED_BINDER_FILTERS,
  type SharedBinderFilter,
  sharedBinderCoverPath,
  sharedCardBadge,
  sharedCompletionPercent,
} from "../lib/share-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";
import { CardTile, type CardTileOwnership } from "./CardTile.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** État du chargement `GET /api/shared/$token` (aucune session requise). */
export type SharedBinderLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "not-found" }
  | { readonly status: "ready"; readonly payload: SharedBinderPayload };

export interface SharedBinderViewState {
  readonly token: string;
  readonly load: SharedBinderLoad;
  readonly filter: SharedBinderFilter;
  /** Carte ouverte dans le Bottom Sheet lecture seule (`null` : fermé). */
  readonly selectedCardId: string | null;
}

export interface SharedBinderViewActions {
  readonly onFilterChange: (filter: SharedBinderFilter) => void;
  readonly onSelectCard: (cardId: string | null) => void;
  readonly onRetry: () => void;
}

export interface SharedBinderViewProps {
  readonly state: SharedBinderViewState;
  readonly actions: SharedBinderViewActions;
}

// ---------------------------------------------------------------------------
// Constantes d'affichage
// ---------------------------------------------------------------------------

const FILTER_LABELS: Readonly<Record<SharedBinderFilter, TranslationKey>> = {
  all: "share.public.filter.all",
  duplicates: "share.public.filter.duplicates",
  missing: "share.public.filter.missing",
};

const LANGUAGE_LABELS: Readonly<Record<CardLanguage, TranslationKey>> = {
  FR: "binderGrid.language.FR",
  EN: "binderGrid.language.EN",
  JP: "binderGrid.language.JP",
  ZH: "binderGrid.language.ZH",
};

const VARIANT_LABELS: Readonly<Record<CardVariant, TranslationKey>> = {
  normal: "binderGrid.variant.normal",
  reverse: "binderGrid.variant.reverse",
  holo: "binderGrid.variant.holo",
  promo: "binderGrid.variant.promo",
  pokeball: "binderGrid.variant.pokeball",
  masterball: "binderGrid.variant.masterball",
};

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const pillClass = (active: boolean): string =>
  `inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border px-3.5 text-sm font-semibold transition-colors ${focusRing} ${
    active
      ? "border-gold bg-gold-soft text-gold"
      : "border-line bg-surface-1 text-secondary hover:text-primary"
  }`;

const goldButtonClass = `inline-flex min-h-11 items-center justify-center rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`;

/** `priority` (chargement eager) sur les 9 premières cartes de la grille. */
const PRIORITY_CARD_COUNT = 9;

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------

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
      role="status"
      className="flex flex-col items-center gap-3 rounded-sheet border border-line bg-surface-1 px-6 py-10 text-center shadow-card"
    >
      <span aria-hidden="true" className="text-muted">
        {icon}
      </span>
      <h1 className="text-base font-bold text-primary">{title}</h1>
      <p className="max-w-xs text-sm text-secondary">{description}</p>
      {children}
    </div>
  </div>
);

const SkeletonGrid = () => (
  <div role="status" data-testid="shared-loading" aria-label={t("share.public.loading")}>
    <span className="sr-only">{t("share.public.loading")}</span>
    <div className="grid grid-cols-3 gap-2.5">
      {Array.from({ length: 9 }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
          key={index}
          aria-hidden="true"
          className="w-full animate-pulse rounded-card border border-line bg-surface-2 motion-reduce:animate-none"
          style={{ aspectRatio: CardAspectRatio }}
        />
      ))}
    </div>
  </div>
);

/** En-tête public : badge « lecture seule » (aucun retour : le visiteur n'a pas d'app) + thème. */
const PublicHeader = () => (
  <header
    data-testid="shared-header"
    className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2"
    style={{ paddingTop: "calc(0.75rem + var(--safe-area-inset-top))" }}
  >
    <span
      data-testid="shared-readonly-badge"
      className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-line bg-surface-1 px-3 text-xs font-semibold text-secondary"
    >
      <Eye size={14} aria-hidden="true" className="text-gold" />
      {t("share.public.badge")}
    </span>
    <ThemeToggle />
  </header>
);

/** Cover : image uploadée (proxy public), carte, ou logo de l'extension ; repli neutre. */
const SharedCover = ({
  binder,
  token,
}: {
  readonly binder: SharedBinderPayload["binder"];
  readonly token: string;
}) => {
  const src = binder.hasUploadedCover
    ? sharedBinderCoverPath(token)
    : binder.coverType === "card"
      ? tcgdexCardImageUrl(binder.coverCardImageUrl, "low")
      : tcgdexSetLogoUrl(binder.coverLogoUrl);
  const isLogo = !binder.hasUploadedCover && binder.coverType !== "card";
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const showImage = src !== undefined && failedSrc !== src;
  return (
    <div
      data-testid="shared-cover"
      role="img"
      aria-label={t("share.public.cover.label", { title: binder.title })}
      className="relative w-16 shrink-0 overflow-hidden rounded-card border border-line bg-surface-2 shadow-card"
      style={{ aspectRatio: CardAspectRatio }}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          decoding="async"
          onError={() => setFailedSrc(src)}
          className={`h-full w-full ${isLogo ? "object-contain p-1.5" : "object-cover"}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted">
          <ImageOff size={20} aria-hidden="true" />
        </div>
      )}
    </div>
  );
};

const BinderIdentity = ({
  payload,
  token,
}: {
  readonly payload: SharedBinderPayload;
  readonly token: string;
}) => {
  const { owner, binder } = payload;
  const percent = sharedCompletionPercent(binder.ownedCount, binder.totalCards);
  const ownerName =
    owner.displayName.trim() === "" ? t("share.public.ownerFallback") : owner.displayName;
  return (
    <section data-testid="shared-identity" className="flex flex-col gap-3 px-4 pb-3">
      <div className="flex items-center gap-3">
        <SharedCover binder={binder} token={token} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex items-center gap-2 text-xs text-secondary">
            <span
              data-testid="shared-owner-avatar"
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-pill bg-gold-soft text-[10px] font-bold text-gold"
            >
              {owner.avatarInitials}
            </span>
            <span data-testid="shared-owner-name" className="truncate">
              {t("share.public.owner", { name: ownerName })}
            </span>
          </p>
          <h1 data-testid="shared-title" className="truncate text-lg font-bold text-primary">
            {binder.title}
          </h1>
          {binder.setCode === null ? null : (
            <p>
              <span
                data-testid="shared-set-code"
                className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-secondary"
              >
                {binder.setCode}
              </span>
            </p>
          )}
        </div>
      </div>
      <div
        data-testid="shared-progress"
        role="progressbar"
        aria-label={t("share.public.progress.label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="flex items-center gap-2"
      >
        <span
          data-testid="shared-percent"
          className="shrink-0 font-mono text-sm font-bold tabular-nums text-gold"
        >
          {`${percent} %`}
        </span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-pill bg-surface-2">
          <div
            data-testid="shared-progress-bar"
            className="h-full rounded-pill bg-gold-bar"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span
          data-testid="shared-owned-count"
          className="shrink-0 font-mono text-[11px] tabular-nums text-secondary"
        >
          {t("share.public.progress.owned", {
            owned: binder.ownedCount,
            total: binder.totalCards,
          })}
        </span>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Filtres (docs/01 §10 : Toutes · Doublons · Manquantes)
// ---------------------------------------------------------------------------

const FiltersBar = ({
  cards,
  showQuantities,
  filter,
  onFilterChange,
}: {
  readonly cards: ReadonlyArray<SharedBinderCard>;
  readonly showQuantities: boolean;
  readonly filter: SharedBinderFilter;
  readonly onFilterChange: (filter: SharedBinderFilter) => void;
}) => {
  // « Doublons » suppose des quantités visibles : sinon le filtre n'a aucun sens (et ne fuite rien).
  const filters = SHARED_BINDER_FILTERS.filter(
    (candidate) => candidate !== "duplicates" || showQuantities,
  );
  return (
    <fieldset className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 py-2.5">
      <legend className="sr-only">{t("share.public.filters.label")}</legend>
      {filters.map((candidate) => {
        const active = filter === candidate;
        return (
          <button
            key={candidate}
            type="button"
            data-testid={`shared-filter-${candidate}`}
            aria-pressed={active}
            onClick={() => onFilterChange(candidate)}
            className={pillClass(active)}
          >
            {t(FILTER_LABELS[candidate])}
            <span className="font-mono text-xs tabular-nums opacity-70">
              {countSharedFilter(cards, candidate, showQuantities)}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
};

// ---------------------------------------------------------------------------
// Grille 3 colonnes (63/88 strict via `CardTile`)
// ---------------------------------------------------------------------------

const SharedGridCard = ({
  card,
  showQuantities,
  priority,
  onSelect,
}: {
  readonly card: SharedBinderCard;
  readonly showQuantities: boolean;
  readonly priority: boolean;
  readonly onSelect: (cardId: string) => void;
}) => {
  const badge = sharedCardBadge(card, showQuantities);
  const ownership: CardTileOwnership = !card.owned
    ? { state: "missing" }
    : badge !== null
      ? { state: "duplicate", count: badge }
      : { state: "owned" };
  return (
    <button
      type="button"
      data-testid="shared-card"
      data-card-id={card.cardId}
      data-state={ownership.state ?? "owned"}
      aria-label={t("share.public.card.open", { name: card.nameFr, localId: card.localId })}
      onClick={() => onSelect(card.cardId)}
      className={`flex min-w-0 flex-col gap-1 rounded-card text-left ${
        card.owned ? "border border-transparent" : "border border-dashed border-line"
      } ${focusRing}`}
    >
      <CardTile
        name={card.nameFr}
        imageUrl={tcgdexCardImageUrl(card.imageBaseUrl, "low")}
        priority={priority}
        {...ownership}
      />
      <span className="truncate font-mono text-[11px] tabular-nums text-muted">
        #{card.localId}
      </span>
      <span className="truncate text-xs font-semibold text-primary">{card.nameFr}</span>
    </button>
  );
};

// ---------------------------------------------------------------------------
// Bottom Sheet lecture seule d'une carte (jamais d'édition ni de donnée privée)
// ---------------------------------------------------------------------------

const SharedCardSheet = ({
  card,
  showQuantities,
  onClose,
}: {
  readonly card: SharedBinderCard | null;
  readonly showQuantities: boolean;
  readonly onClose: () => void;
}) => {
  const imageUrl = card === null ? undefined : tcgdexCardImageUrl(card.imageBaseUrl, "high");
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  return (
    <BottomSheet
      open={card !== null}
      onClose={onClose}
      ariaLabel={card === null ? t("share.public.grid.label") : card.nameFr}
      {...(card === null ? {} : { title: card.nameFr })}
    >
      {card === null ? null : (
        <div data-testid="shared-card-sheet" className="flex flex-col gap-4">
          {/* Emplacement de l'Inspecteur 3D Holo (M5) : l'effet est déjà porté par `data-holo-effect`. */}
          <div
            data-testid="shared-card-holo-slot"
            data-holo-effect={card.holoEffect}
            className="relative mx-auto w-56 max-w-full overflow-hidden rounded-card border border-line bg-surface-2 shadow-card"
            style={{ aspectRatio: CardAspectRatio }}
          >
            {imageUrl !== undefined && failedUrl !== imageUrl ? (
              <img
                src={imageUrl}
                alt={t("share.detail.imageAlt", { name: card.nameFr })}
                decoding="async"
                onError={() => setFailedUrl(imageUrl)}
                className={`h-full w-full object-cover ${card.owned ? "" : "saturate-0 opacity-60"}`}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
                <ImageOff size={28} aria-hidden="true" />
                <span className="text-xs">{t("share.detail.imageFallback")}</span>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <p
                data-testid="shared-card-number"
                className="font-mono text-sm font-semibold tabular-nums text-primary"
              >
                {t("share.detail.number", { localId: card.localId })}
              </p>
              {card.setCode === null ? null : (
                <p className="font-mono text-xs tabular-nums text-muted">
                  {t("share.detail.set", { code: card.setCode })}
                </p>
              )}
            </div>
            <p data-testid="shared-card-rarity" className="text-secondary">
              {card.rarity === null
                ? t("share.detail.rarityUnknown")
                : t("share.detail.rarity", { rarity: card.rarity })}
            </p>
          </div>
          <section
            data-testid="shared-card-copies"
            aria-label={t("share.detail.copies.heading")}
            className="flex flex-col gap-2 rounded-card border border-line bg-surface-2 p-3"
          >
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("share.detail.copies.heading")}
            </h3>
            <p
              data-testid="shared-card-ownership"
              className={`text-sm font-semibold ${card.owned ? "text-success" : "text-secondary"}`}
            >
              {card.owned ? t("share.detail.owned") : t("share.detail.missing")}
            </p>
            {card.copies.length === 0 ? null : (
              <ul className="flex flex-col gap-1.5">
                {card.copies.map((copy) => (
                  <li
                    key={`${copy.language}-${copy.variant}`}
                    data-testid="shared-card-copy"
                    className="flex items-center justify-between gap-3 text-sm text-primary"
                  >
                    <span>
                      {t("share.detail.copies.line", {
                        language: t(LANGUAGE_LABELS[copy.language]),
                        variant: t(VARIANT_LABELS[copy.variant]),
                      })}
                    </span>
                    {showQuantities && copy.quantity !== null ? (
                      <span className="font-mono tabular-nums text-gold">
                        {t("share.detail.copies.quantity", { count: copy.quantity })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {showQuantities || !card.owned ? null : (
              <p data-testid="shared-quantities-hidden" className="text-xs text-muted">
                {t("share.detail.quantitiesHidden")}
              </p>
            )}
          </section>
        </div>
      )}
    </BottomSheet>
  );
};

// ---------------------------------------------------------------------------
// Vue pure
// ---------------------------------------------------------------------------

/**
 * Écrans `09C–09D · Vue Publique Partagée` : strictement lecture seule, sans compte.
 * Header (badge lecture seule + thème visiteur), identité du classeur (propriétaire, titre,
 * code, cover, complétion), filtres Toutes / Doublons / Manquantes, grille 3 colonnes `63/88`
 * et Bottom Sheet d'une carte — aucun bouton d'édition, prix d'achat, note ni wishlist.
 * 100 % tokens Dark/Light (zéro hex brut).
 */
export const SharedBinderView = ({ state, actions }: SharedBinderViewProps) => {
  const { load, filter, token } = state;
  const payload = load.status === "ready" ? load.payload : null;
  const showQuantities = payload?.binder.showQuantities ?? false;
  const allCards = useMemo(() => payload?.cards ?? [], [payload]);
  // Un filtre « Doublons » reste inactif si les quantités sont masquées (jamais de fuite).
  const effectiveFilter: SharedBinderFilter =
    filter === "duplicates" && !showQuantities ? "all" : filter;
  const visible = useMemo(
    () => filterSharedCards(allCards, effectiveFilter, showQuantities),
    [allCards, effectiveFilter, showQuantities],
  );
  const selected =
    state.selectedCardId === null
      ? null
      : (allCards.find((card) => card.cardId === state.selectedCardId) ?? null);

  return (
    <main
      data-testid="shared-binder-screen"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-canvas"
    >
      <PublicHeader />
      {payload !== null ? (
        <>
          <BinderIdentity payload={payload} token={token} />
          <FiltersBar
            cards={allCards}
            showQuantities={showQuantities}
            filter={effectiveFilter}
            onFilterChange={actions.onFilterChange}
          />
          {visible.length === 0 ? (
            <CenteredNotice
              testId="shared-empty"
              icon={<SearchX size={28} />}
              title={t(
                effectiveFilter === "duplicates"
                  ? "share.public.empty.duplicates.title"
                  : effectiveFilter === "missing"
                    ? "share.public.empty.missing.title"
                    : "share.public.empty.all.title",
              )}
              description={t(
                effectiveFilter === "duplicates"
                  ? "share.public.empty.duplicates.description"
                  : effectiveFilter === "missing"
                    ? "share.public.empty.missing.description"
                    : "share.public.empty.all.description",
              )}
            >
              {effectiveFilter === "all" ? null : (
                <button
                  type="button"
                  data-testid="shared-empty-reset"
                  onClick={() => actions.onFilterChange("all")}
                  className={goldButtonClass}
                >
                  {t("share.public.empty.reset")}
                </button>
              )}
            </CenteredNotice>
          ) : (
            <section
              data-testid="shared-grid"
              aria-label={t("share.public.grid.label")}
              className="grid grid-cols-3 gap-2.5 px-4"
            >
              {visible.map((card, index) => (
                <SharedGridCard
                  key={card.cardId}
                  card={card}
                  showQuantities={showQuantities}
                  priority={index < PRIORITY_CARD_COUNT}
                  onSelect={actions.onSelectCard}
                />
              ))}
            </section>
          )}
          <p
            data-testid="shared-footer"
            className="px-6 pt-6 text-center text-xs text-muted"
            style={{ paddingBottom: "calc(2rem + var(--safe-area-inset-bottom))" }}
          >
            {t("share.public.footer")}
          </p>
          <SharedCardSheet
            // Remonte le Bottom Sheet à chaque carte : l'état d'image en échec ne fuit pas.
            key={selected?.cardId ?? "none"}
            card={selected}
            showQuantities={showQuantities}
            onClose={() => actions.onSelectCard(null)}
          />
        </>
      ) : load.status === "loading" ? (
        <div className="min-h-0 flex-1 px-4 pt-2">
          <SkeletonGrid />
        </div>
      ) : load.status === "not-found" ? (
        <CenteredNotice
          testId="shared-not-found"
          icon={<LinkIcon size={28} />}
          title={t("share.public.notFound.title")}
          description={t("share.public.notFound.description")}
        >
          <Link to="/" data-testid="shared-not-found-cta" className={goldButtonClass}>
            {t("share.public.notFound.cta")}
          </Link>
        </CenteredNotice>
      ) : (
        <CenteredNotice
          testId="shared-error"
          icon={<TriangleAlert size={28} />}
          title={t("share.public.error.title")}
          description={t("share.public.error.description")}
        >
          <button
            type="button"
            data-testid="shared-retry"
            onClick={actions.onRetry}
            className={goldButtonClass}
          >
            {t("share.public.error.retry")}
          </button>
        </CenteredNotice>
      )}
    </main>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : fetch `/api/shared/$token` (sans session), filtre, carte ouverte, retry
// ---------------------------------------------------------------------------

export interface SharedBinderScreenProps {
  readonly token: string;
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export const SharedBinderScreen = ({ token }: SharedBinderScreenProps) => {
  const [load, setLoad] = useState<SharedBinderLoad>({ status: "loading" });
  const [filter, setFilter] = useState<SharedBinderFilter>("all");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    setSelectedCardId(null);
    fetchSharedBinder(token, controller.signal)
      .then((result) => {
        setLoad(
          result.kind === "ok"
            ? { status: "ready", payload: result.payload }
            : { status: result.kind },
        );
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setLoad({ status: "error" });
      });
    return () => controller.abort();
  }, [token, retryToken]);

  return (
    <SharedBinderView
      state={{ token, load, filter, selectedCardId }}
      actions={{
        onFilterChange: setFilter,
        onSelectCard: setSelectedCardId,
        onRetry: () => setRetryToken((value) => value + 1),
      }}
    />
  );
};
