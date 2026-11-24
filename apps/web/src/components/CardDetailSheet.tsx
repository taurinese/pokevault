import {
  CARD_COPY_NOTES_MAX_LENGTH,
  CardAspectRatio,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  MAX_CARD_COPY_QUANTITY,
  tcgdexCardImageUrl,
  type UserCardCopy,
} from "@pokevault/domain";
import {
  ExternalLink,
  FolderPlus,
  Heart,
  ImageOff,
  Maximize2,
  Minus,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type TranslationKey, t } from "../i18n/index.ts";
import {
  type AddCardCopyBody,
  addCardCopy,
  adjustCardCopyQuantity,
  type CardDetailBinder,
  type CardDetailPayload,
  defaultVariantFor,
  fetchCardDetail,
  formatIsoDate,
  formatPriceCents,
  isSafeHttpsUrl,
  parsePurchasePriceEuros,
  setCardInBinder,
} from "../lib/card-detail-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";

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

/** Grand visuel `high.webp` (ratio 63/88, coins 12px) avec fallback propre `ImageOff`. */
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
  return (
    <div className="relative mx-auto w-full max-w-60">
      <div
        data-testid="card-detail-image"
        className="relative w-full overflow-hidden border border-line bg-surface-2 shadow-card"
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
      </div>
      <button
        type="button"
        data-testid="card-detail-zoom"
        aria-label={t("cardDetail.image.zoom", { name })}
        disabled={onOpenViewer3D === undefined}
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

      {/* Bloc prix Cardmarket (placeholder sobre, lien externe sécurisé) */}
      <section
        data-testid="card-detail-price"
        aria-label={t("cardDetail.price.heading")}
        className="flex flex-col gap-1.5 rounded-sheet border border-line bg-surface-1 p-3 shadow-card"
      >
        <h3 className={sectionHeadingClass}>{t("cardDetail.price.heading")}</h3>
        <p className="text-sm text-secondary">{t("cardDetail.price.soon")}</p>
        {isSafeHttpsUrl(card.cardmarketUrl) ? (
          <a
            data-testid="card-detail-cardmarket-link"
            href={card.cardmarketUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill border border-line bg-surface-2 px-3 text-sm font-semibold text-accent-blue hover:text-primary ${focusRing}`}
          >
            {t("cardDetail.price.link")}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : null}
      </section>

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
 * rapides (wishlist, dossier perso), bloc prix Cardmarket (lien externe
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
  // Identifiant de la carte actuellement chargée : évite d'afficher les données
  // d'une carte A pendant le chargement de la carte B.
  const loadedCardIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Reset de l'état visuel local quand on ferme ou ouvre une autre carte.
    if (cardId === null) {
      loadedCardIdRef.current = null;
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

  const handleToggleWishlist = () => {
    if (cardId === null) return;
    const next = !wishlisted;
    setWishlisted(next);
    onToggleWishlist?.(cardId, next);
  };

  const readyPayload = load.status === "ready" ? load.payload : null;
  const title = readyPayload?.card.nameFr ?? cardName ?? t("cardDetail.title");

  const actions: CardDetailViewActions = {
    onClose,
    onRetry: () => {
      loadedCardIdRef.current = null;
      setReloadToken((token) => token + 1);
    },
    onToggleWishlist: handleToggleWishlist,
    ...(cardId === null || onOpenViewer3D === undefined
      ? {}
      : { onOpenViewer3D: () => onOpenViewer3D(cardId) }),
    onToggleBinders: () => setBindersOpen((open) => !open),
    onToggleBinder: (binder) => void handleToggleBinder(binder),
    onToggleAddForm: () => {
      setFormError(null);
      setAddFormOpen((open) => !open);
    },
    onFormChange: (patch) => setForm((current) => ({ ...current, ...patch })),
    onSubmitAdd: () => void handleSubmitAdd(),
    onStepper: (copy, delta) => void handleStepper(copy, delta),
  };

  return (
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
      }}
      actions={actions}
    />
  );
};
