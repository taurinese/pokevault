import {
  BINDER_TITLE_MAX_LENGTH,
  type BinderSummary,
  type CardSearchHit,
  type SearchQuery,
} from "@pokevault/domain";
import { CircleAlert, ImagePlus, Search, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type TranslationKey, t } from "../i18n/index.ts";
import {
  type BinderCoverChoice,
  COVER_ACCEPT_ATTRIBUTE,
  type CoverFileError,
  deleteBinder,
  type FetchLike,
  type SubmitBinderInfoResult,
  setBinderCover,
  submitBinderInfo,
  type UploadCoverResult,
  uploadBinderCover,
  validateCoverFile,
} from "../lib/binders-client.ts";
import { fetchResults } from "../lib/search-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";
import { CardTile } from "./CardTile.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

export type CoverTab = "logo" | "card" | "upload";

export type InfoError = "empty" | "too_long" | "invalid" | "notFound" | "generic";
export type CoverError = CoverFileError | "invalid" | "notFound" | "generic";

export type CardSearchState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly hits: ReadonlyArray<CardSearchHit> };

export interface BinderSettingsState {
  readonly title: string;
  readonly pinned: boolean;
  readonly info: {
    readonly saving: boolean;
    readonly saved: boolean;
    readonly error: InfoError | null;
  };
  readonly coverTab: CoverTab;
  readonly cardQuery: string;
  readonly cards: CardSearchState;
  readonly upload: {
    /** Fichier choisi et valide (aperçu local avant envoi). */
    readonly file: { readonly name: string; readonly size: number } | null;
    readonly previewUrl: string | null;
  };
  readonly cover: {
    /** Action en cours : désactive les autres boutons de cover. */
    readonly pending: CoverTab | null;
    readonly saved: boolean;
    readonly error: CoverError | null;
  };
  /** Suppression en 2 étapes : `idle` → `confirm` → requête. */
  readonly deleteStep: "idle" | "confirm";
  readonly deleting: boolean;
  readonly deleteError: boolean;
}

export interface BinderSettingsActions {
  readonly onTitleChange: (title: string) => void;
  readonly onPinnedChange: (pinned: boolean) => void;
  readonly onSaveInfo: () => void;
  readonly onCoverTabChange: (tab: CoverTab) => void;
  readonly onCardQueryChange: (query: string) => void;
  readonly onPickCard: (card: CardSearchHit) => void;
  readonly onApplyLogo: () => void;
  readonly onPickFile: (file: File | null) => void;
  readonly onSubmitUpload: () => void;
  readonly onRequestDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: () => void;
}

export const initialBinderSettingsState = (summary: BinderSummary): BinderSettingsState => ({
  title: summary.binder.title,
  pinned: summary.binder.isPinned,
  info: { saving: false, saved: false, error: null },
  coverTab: summary.binder.coverType === "card" ? "card" : "logo",
  cardQuery: "",
  cards: { status: "loading" },
  upload: { file: null, previewUrl: null },
  cover: { pending: null, saved: false, error: null },
  deleteStep: "idle",
  deleting: false,
  deleteError: false,
});

// ---------------------------------------------------------------------------
// Dérivations pures
// ---------------------------------------------------------------------------

/** Nombre de cartes proposées pour la cover (une grille 3 colonnes lisible). */
export const COVER_CARD_RESULTS_LIMIT = 12;

/** Requête catalogue : cartes de l'extension pour un classeur d'extension, tout le catalogue sinon. */
export const coverCardSearchQuery = (summary: BinderSummary, query: string): SearchQuery => ({
  q: query.trim(),
  scope: "cards",
  sort: "relevance",
  limit: COVER_CARD_RESULTS_LIMIT,
  offset: 0,
  ...(summary.binder.kind === "set" && summary.binder.setId !== null
    ? { setId: summary.binder.setId }
    : {}),
});

export const infoErrorOf = (result: SubmitBinderInfoResult): InfoError | null => {
  switch (result.kind) {
    case "ok":
    case "unauthorized":
      return null;
    case "invalid_title":
      return result.reason === "empty" ? "empty" : "too_long";
    case "invalid":
      return "invalid";
    case "not_found":
      return "notFound";
    default:
      return "generic";
  }
};

export const coverErrorOf = (result: UploadCoverResult): CoverError | null => {
  switch (result.kind) {
    case "ok":
    case "unauthorized":
      return null;
    case "invalid_file":
      return result.reason;
    case "too_large":
      return "too_large";
    case "unsupported":
      return "unsupported";
    case "invalid":
      return "invalid";
    case "not_found":
      return "notFound";
    default:
      return "generic";
  }
};

/** Onglets de cover : le premier est le logo officiel (extension) ou le visuel neutre (dossier). */
export const coverTabsFor = (
  kind: BinderSummary["binder"]["kind"],
): ReadonlyArray<{ readonly id: CoverTab; readonly labelKey: TranslationKey }> => [
  {
    id: "logo",
    labelKey: kind === "set" ? "binderSettings.cover.tab.logo" : "binderSettings.cover.tab.neutral",
  },
  { id: "card", labelKey: "binderSettings.cover.tab.card" },
  { id: "upload", labelKey: "binderSettings.cover.tab.upload" },
];

const COVER_ERROR_KEYS: Readonly<Record<CoverError, TranslationKey>> = {
  too_large: "binderSettings.cover.error.too_large",
  svg: "binderSettings.cover.error.svg",
  unsupported: "binderSettings.cover.error.unsupported",
  empty: "binderSettings.cover.error.empty",
  invalid: "binderSettings.cover.error.invalid",
  notFound: "binderSettings.cover.error.notFound",
  generic: "binderSettings.cover.error.generic",
};

const INFO_ERROR_KEYS: Readonly<Record<InfoError, TranslationKey>> = {
  empty: "binderSettings.info.error.empty",
  too_long: "binderSettings.info.error.tooLong",
  invalid: "binderSettings.info.error.invalid",
  notFound: "binderSettings.info.error.notFound",
  generic: "binderSettings.info.error.generic",
};

const currentCoverLabel = (summary: BinderSummary): string => {
  const { binder } = summary;
  if (binder.coverType === "card") return t("binderSettings.cover.tab.card");
  if (binder.coverType === "upload") return t("binderSettings.cover.tab.upload");
  return t(
    binder.kind === "set" ? "binderSettings.cover.tab.logo" : "binderSettings.cover.tab.neutral",
  );
};

/** Taille affichée en Ko (arrondie au supérieur : jamais « 0 Ko » pour un petit fichier). */
export const fileSizeKo = (bytes: number): number => Math.max(1, Math.ceil(bytes / 1024));

// ---------------------------------------------------------------------------
// Briques visuelles
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;

const inputClass = `w-full rounded-pill border bg-surface-2 px-4 text-sm text-primary placeholder:text-muted ${focusRing}`;

const goldButton = `rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold disabled:opacity-60 ${focusRing}`;

const ErrorLine = ({
  id,
  testId,
  message,
}: {
  readonly id?: string | undefined;
  readonly testId: string;
  readonly message: string;
}) => (
  <p
    id={id}
    role="alert"
    data-testid={testId}
    className="flex items-center gap-2 text-sm text-danger"
  >
    <CircleAlert size={16} aria-hidden="true" />
    {message}
  </p>
);

const sectionTitle = "text-base font-bold text-primary";

const tabDomId = (tab: CoverTab): string => `binder-cover-tab-${tab}`;
const panelDomId = (tab: CoverTab): string => `binder-cover-panel-${tab}`;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const InfoSection = ({
  state,
  actions,
}: {
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}) => {
  const errorId = "binder-settings-title-error";
  const { info } = state;
  return (
    <form
      data-testid="settings-info"
      noValidate
      aria-labelledby="binder-settings-info-title"
      onSubmit={(event) => {
        event.preventDefault();
        actions.onSaveInfo();
      }}
      className="flex flex-col gap-3"
    >
      <h3 id="binder-settings-info-title" className={sectionTitle}>
        {t("binderSettings.info.heading")}
      </h3>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="binder-settings-title" className="text-sm font-semibold text-primary">
          {t("binderSettings.info.title.label")}
        </label>
        <input
          id="binder-settings-title"
          type="text"
          value={state.title}
          maxLength={BINDER_TITLE_MAX_LENGTH}
          onChange={(event) => actions.onTitleChange(event.target.value)}
          autoComplete="off"
          aria-invalid={info.error !== null}
          aria-describedby={info.error === null ? undefined : errorId}
          style={touchTarget}
          className={`${inputClass} ${info.error === null ? "border-line" : "border-danger"}`}
        />
        <div className="flex items-start justify-between gap-3">
          {info.error === null ? (
            <span />
          ) : (
            <ErrorLine
              id={errorId}
              testId="settings-info-error"
              message={t(INFO_ERROR_KEYS[info.error], { max: BINDER_TITLE_MAX_LENGTH })}
            />
          )}
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
            {t("binderSettings.info.counter", {
              count: state.title.length,
              max: BINDER_TITLE_MAX_LENGTH,
            })}
          </span>
        </div>
      </div>
      <label className="flex items-center gap-3 text-sm text-primary">
        <input
          type="checkbox"
          checked={state.pinned}
          onChange={(event) => actions.onPinnedChange(event.target.checked)}
          data-testid="settings-pin"
          className={`size-5 accent-gold ${focusRing}`}
        />
        {t("binderSettings.info.pin")}
      </label>
      {info.saved ? (
        <p role="status" data-testid="settings-info-saved" className="text-sm text-success">
          {t("binderSettings.info.saved")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={info.saving}
        data-testid="settings-info-save"
        style={touchTarget}
        className={goldButton}
      >
        {info.saving ? t("binderSettings.info.saving") : t("binderSettings.info.save")}
      </button>
    </form>
  );
};

const CoverTabs = ({
  kind,
  tab,
  onTabChange,
}: {
  readonly kind: BinderSummary["binder"]["kind"];
  readonly tab: CoverTab;
  readonly onTabChange: (tab: CoverTab) => void;
}) => {
  const tabs = coverTabsFor(kind);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = tabs.findIndex((entry) => entry.id === tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    const target = next === null ? undefined : tabs[next];
    if (target === undefined) return;
    event.preventDefault();
    onTabChange(target.id);
    document.getElementById(tabDomId(target.id))?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t("binderSettings.cover.tabs.label")}
      className="grid grid-cols-3 gap-1 rounded-pill border border-line bg-surface-2 p-1"
    >
      {tabs.map((entry) => {
        const selected = entry.id === tab;
        return (
          <button
            key={entry.id}
            id={tabDomId(entry.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelDomId(entry.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onTabChange(entry.id)}
            onKeyDown={onKeyDown}
            style={touchTarget}
            className={`rounded-pill px-2 text-xs font-semibold transition-colors ${focusRing} ${
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

const LogoPanel = ({
  summary,
  state,
  actions,
}: {
  readonly summary: BinderSummary;
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}) => {
  const isSet = summary.binder.kind === "set";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-secondary">
        {t(
          isSet
            ? "binderSettings.cover.logo.description"
            : "binderSettings.cover.neutral.description",
        )}
      </p>
      <button
        type="button"
        onClick={actions.onApplyLogo}
        disabled={state.cover.pending !== null}
        data-testid="cover-apply-logo"
        style={touchTarget}
        className={goldButton}
      >
        {state.cover.pending === "logo"
          ? t("binderSettings.cover.pending")
          : t(isSet ? "binderSettings.cover.logo.apply" : "binderSettings.cover.neutral.apply")}
      </button>
    </div>
  );
};

const CardPanel = ({
  summary,
  state,
  actions,
}: {
  readonly summary: BinderSummary;
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}) => {
  const scoped = summary.binder.kind === "set";
  const busy = state.cover.pending !== null;
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">{t("binderSettings.cover.card.search.label")}</span>
        <Search
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={state.cardQuery}
          onChange={(event) => actions.onCardQueryChange(event.target.value)}
          placeholder={t("binderSettings.cover.card.search.placeholder")}
          autoComplete="off"
          data-testid="cover-card-search"
          style={touchTarget}
          className={`${inputClass} border-line pl-9`}
        />
      </label>
      <p className="text-xs text-muted" data-testid="cover-card-scope">
        {scoped && summary.set !== null
          ? t("binderSettings.cover.card.scopeSet", { name: summary.set.nameFr })
          : t("binderSettings.cover.card.scopeAll")}
      </p>
      {state.cards.status === "loading" ? (
        <p
          role="status"
          data-testid="cover-card-loading"
          className="py-4 text-center text-sm text-secondary"
        >
          {t("binderSettings.cover.card.loading")}
        </p>
      ) : null}
      {state.cards.status === "error" ? (
        <ErrorLine testId="cover-card-error" message={t("binderSettings.cover.card.error")} />
      ) : null}
      {state.cards.status === "ready" && state.cards.hits.length === 0 ? (
        <p data-testid="cover-card-empty" className="py-4 text-center text-sm text-secondary">
          {t("binderSettings.cover.card.empty")}
        </p>
      ) : null}
      {state.cards.status === "ready" && state.cards.hits.length > 0 ? (
        <ul className="grid grid-cols-3 gap-2" data-testid="cover-card-grid">
          {state.cards.hits.map((hit) => {
            const selected = summary.binder.coverCardId === hit.id;
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  onClick={() => actions.onPickCard(hit)}
                  disabled={busy}
                  aria-pressed={selected}
                  aria-label={t("binderSettings.cover.card.pick", { name: hit.nameFr })}
                  data-testid="cover-card-option"
                  className={`block w-full rounded-card border-2 disabled:opacity-60 ${focusRing} ${
                    selected ? "border-gold" : "border-transparent"
                  }`}
                >
                  <CardTile
                    name={hit.nameFr}
                    label={hit.nameFr}
                    imageUrl={hit.imageUrl ?? undefined}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state.cover.pending === "card" ? (
        <p role="status" className="text-sm text-secondary">
          {t("binderSettings.cover.pending")}
        </p>
      ) : null}
    </div>
  );
};

const UploadPanel = ({
  state,
  actions,
}: {
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}) => {
  const { file, previewUrl } = state.upload;
  const uploading = state.cover.pending === "upload";
  return (
    <div className="flex flex-col gap-3">
      <label
        className={`flex cursor-pointer items-center justify-center gap-2 rounded-pill border border-dashed border-gold px-4 text-sm font-semibold text-gold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gold`}
        style={touchTarget}
      >
        <ImagePlus size={16} aria-hidden="true" />
        {t("binderSettings.cover.upload.label")}
        <input
          type="file"
          accept={COVER_ACCEPT_ATTRIBUTE}
          disabled={state.cover.pending !== null}
          data-testid="cover-file-input"
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            actions.onPickFile(picked);
            // Permet de re-choisir le même fichier après un refus.
            event.target.value = "";
          }}
          className="sr-only"
        />
      </label>
      <p className="text-xs text-muted">{t("binderSettings.cover.upload.hint")}</p>
      {file !== null && previewUrl !== null ? (
        <div className="flex items-center gap-3" data-testid="cover-upload-preview">
          <img
            src={previewUrl}
            alt={t("binderSettings.cover.upload.previewAlt")}
            className="size-24 rounded-md border border-line bg-surface-2 object-cover"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-semibold text-primary">{file.name}</span>
            <span className="font-mono text-xs tabular-nums text-muted">
              {t("binderSettings.cover.upload.fileSize", { size: fileSizeKo(file.size) })}
            </span>
            <button
              type="button"
              onClick={() => actions.onPickFile(null)}
              disabled={uploading}
              className={`self-start text-xs font-semibold text-secondary underline ${focusRing}`}
            >
              {t("binderSettings.cover.upload.clear")}
            </button>
          </div>
        </div>
      ) : null}
      {file === null ? null : (
        <button
          type="button"
          onClick={actions.onSubmitUpload}
          disabled={uploading}
          data-testid="cover-upload-submit"
          style={touchTarget}
          className={goldButton}
        >
          {uploading
            ? t("binderSettings.cover.upload.submitting")
            : t("binderSettings.cover.upload.submit")}
        </button>
      )}
    </div>
  );
};

const CoverSection = ({
  summary,
  state,
  actions,
}: {
  readonly summary: BinderSummary;
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}) => (
  <section
    data-testid="settings-cover"
    aria-labelledby="binder-settings-cover-title"
    className="flex flex-col gap-3"
  >
    <h3 id="binder-settings-cover-title" className={sectionTitle}>
      {t("binderSettings.cover.heading")}
    </h3>
    <p data-testid="cover-current" className="text-xs text-muted">
      {t("binderSettings.cover.current", { type: currentCoverLabel(summary) })}
    </p>
    <CoverTabs
      kind={summary.binder.kind}
      tab={state.coverTab}
      onTabChange={actions.onCoverTabChange}
    />
    <div
      role="tabpanel"
      id={panelDomId(state.coverTab)}
      aria-labelledby={tabDomId(state.coverTab)}
      className="flex flex-col gap-3"
    >
      {state.coverTab === "logo" ? (
        <LogoPanel summary={summary} state={state} actions={actions} />
      ) : null}
      {state.coverTab === "card" ? (
        <CardPanel summary={summary} state={state} actions={actions} />
      ) : null}
      {state.coverTab === "upload" ? <UploadPanel state={state} actions={actions} /> : null}
    </div>
    {state.cover.error === null ? null : (
      <ErrorLine testId="cover-error" message={t(COVER_ERROR_KEYS[state.cover.error])} />
    )}
    {state.cover.saved ? (
      <p role="status" data-testid="cover-saved" className="text-sm text-success">
        {t("binderSettings.cover.saved")}
      </p>
    ) : null}
  </section>
);

const DangerSection = ({
  summary,
  state,
  actions,
}: {
  readonly summary: BinderSummary;
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}) => (
  <section
    data-testid="settings-danger"
    aria-labelledby="binder-settings-danger-title"
    className="flex flex-col gap-3 rounded-sheet border border-danger p-3"
  >
    <h3 id="binder-settings-danger-title" className={`${sectionTitle} text-danger`}>
      {t("binderSettings.danger.heading")}
    </h3>
    {state.deleteStep === "idle" ? (
      <button
        type="button"
        onClick={actions.onRequestDelete}
        data-testid="delete-request"
        style={touchTarget}
        className={`flex items-center justify-center gap-2 rounded-pill border border-danger px-5 text-sm font-semibold text-danger ${focusRing}`}
      >
        <Trash2 size={16} aria-hidden="true" />
        {t("binderSettings.danger.delete")}
      </button>
    ) : (
      <div
        role="alertdialog"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-description"
        data-testid="delete-confirm"
        className="flex flex-col gap-3"
      >
        <p id="delete-confirm-title" className="text-sm font-semibold text-primary">
          {t("binderSettings.danger.confirm.title", { title: summary.binder.title })}
        </p>
        <p id="delete-confirm-description" className="text-sm text-secondary">
          {t("binderSettings.danger.confirm.description")}
        </p>
        {state.deleteError ? (
          <ErrorLine testId="delete-error" message={t("binderSettings.danger.error")} />
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={actions.onCancelDelete}
            disabled={state.deleting}
            data-testid="delete-cancel"
            style={touchTarget}
            className={`rounded-pill border border-line bg-surface-1 px-3 text-sm font-semibold text-secondary disabled:opacity-60 ${focusRing}`}
          >
            {t("binderSettings.danger.confirm.cancel")}
          </button>
          <button
            type="button"
            onClick={actions.onConfirmDelete}
            disabled={state.deleting}
            data-testid="delete-confirm-submit"
            style={touchTarget}
            className={`rounded-pill border border-danger bg-surface-1 px-3 text-sm font-semibold text-danger disabled:opacity-60 ${focusRing}`}
          >
            {state.deleting
              ? t("binderSettings.danger.deleting")
              : t("binderSettings.danger.confirm.submit")}
          </button>
        </div>
      </div>
    )}
  </section>
);

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

export interface BinderSettingsViewProps {
  readonly summary: BinderSummary;
  readonly state: BinderSettingsState;
  readonly actions: BinderSettingsActions;
}

/** Contenu du bottom sheet Réglages & cover — pur, piloté par `state` / `actions`. */
export const BinderSettingsView = ({ summary, state, actions }: BinderSettingsViewProps) => (
  <div className="flex flex-col gap-6" data-testid="binder-settings">
    <InfoSection state={state} actions={actions} />
    <CoverSection summary={summary} state={state} actions={actions} />
    <DangerSection summary={summary} state={state} actions={actions} />
  </div>
);

// ---------------------------------------------------------------------------
// Conteneur : requêtes, aperçu local, rafraîchissement
// ---------------------------------------------------------------------------

export type BinderSettingsChange =
  | { readonly kind: "info"; readonly title: string }
  | { readonly kind: "cover"; readonly title: string };

export interface BinderSettingsSheetProps {
  /** Classeur édité ; `null` : feuille fermée. */
  readonly summary: BinderSummary | null;
  readonly onClose: () => void;
  /** Modification enregistrée (la feuille reste ouverte) : l'appelant rafraîchit ses données. */
  readonly onChanged: (change: BinderSettingsChange) => void;
  /** Classeur supprimé : l'appelant ferme la feuille et rafraîchit. */
  readonly onDeleted: (title: string) => void;
  /** Session expirée (401). */
  readonly onUnauthorized: () => void;
  /** Injectable (tests). */
  readonly fetchImpl?: FetchLike | undefined;
}

type CoverRequest = () => Promise<UploadCoverResult>;

const CARD_SEARCH_DEBOUNCE_MS = 250;

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const SettingsBody = ({
  summary,
  onChanged,
  onDeleted,
  onUnauthorized,
  fetchImpl,
}: Omit<BinderSettingsSheetProps, "summary" | "onClose"> & { readonly summary: BinderSummary }) => {
  const binderId = summary.binder.id;
  const [state, setState] = useState<BinderSettingsState>(() =>
    initialBinderSettingsState(summary),
  );
  const previewRef = useRef<string | null>(null);
  /** Fichier validé en attente d'envoi (le `File` n'est pas sérialisable dans l'état de vue). */
  const selectedFileRef = useRef<File | null>(null);

  const revokePreview = (): void => {
    if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    selectedFileRef.current = null;
  };
  useEffect(
    () => () => {
      if (previewRef.current !== null) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  // Recherche live (debounce) dans le catalogue, uniquement sur l'onglet « Une carte ».
  const query = state.cardQuery;
  const searchActive = state.coverTab === "card";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `summary` n'intervient que par son extension (setId), stable pendant l'édition
  useEffect(() => {
    if (!searchActive) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void fetchResults(coverCardSearchQuery(summary, query), controller.signal, fetchImpl)
          .then((result) => {
            if (result.kind === "ok") {
              setState((current) => ({
                ...current,
                cards: { status: "ready", hits: result.data.cards },
              }));
            } else if (result.kind === "unauthorized") onUnauthorized();
            else setState((current) => ({ ...current, cards: { status: "error" } }));
          })
          .catch((error: unknown) => {
            if (!isAbort(error))
              setState((current) => ({ ...current, cards: { status: "error" } }));
          });
      },
      query === "" ? 0 : CARD_SEARCH_DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchActive, fetchImpl, onUnauthorized]);

  const applyCover = (tab: CoverTab, run: CoverRequest): void => {
    if (state.cover.pending !== null) return;
    setState((current) => ({ ...current, cover: { pending: tab, saved: false, error: null } }));
    void run().then((result) => {
      if (result.kind === "unauthorized") return onUnauthorized();
      if (result.kind === "ok") {
        revokePreview();
        setState((current) => ({
          ...current,
          upload: { file: null, previewUrl: null },
          cover: { pending: null, saved: true, error: null },
        }));
        onChanged({ kind: "cover", title: result.data.binder.title });
      } else {
        setState((current) => ({
          ...current,
          cover: { pending: null, saved: false, error: coverErrorOf(result) },
        }));
      }
    });
  };

  const chooseCover = (tab: CoverTab, choice: BinderCoverChoice): void =>
    applyCover(tab, () => setBinderCover(binderId, choice, fetchImpl));

  const actions: BinderSettingsActions = {
    onTitleChange: (title) =>
      setState((current) => ({
        ...current,
        title,
        info: { ...current.info, saved: false, error: null },
      })),
    onPinnedChange: (pinned) =>
      setState((current) => ({ ...current, pinned, info: { ...current.info, saved: false } })),
    onSaveInfo: () => {
      if (state.info.saving) return;
      setState((current) => ({ ...current, info: { saving: true, saved: false, error: null } }));
      void submitBinderInfo(binderId, state.title, state.pinned, fetchImpl).then((result) => {
        if (result.kind === "unauthorized") return onUnauthorized();
        if (result.kind === "ok") {
          setState((current) => ({
            ...current,
            title: result.data.binder.title,
            info: { saving: false, saved: true, error: null },
          }));
          onChanged({ kind: "info", title: result.data.binder.title });
        } else {
          setState((current) => ({
            ...current,
            info: { saving: false, saved: false, error: infoErrorOf(result) },
          }));
        }
      });
    },
    onCoverTabChange: (coverTab) =>
      setState((current) => ({
        ...current,
        coverTab,
        cover: { ...current.cover, saved: false, error: null },
      })),
    onCardQueryChange: (cardQuery) =>
      setState((current) => ({ ...current, cardQuery, cards: { status: "loading" } })),
    onPickCard: (card) => chooseCover("card", { type: "card", cardId: card.id }),
    onApplyLogo: () => chooseCover("logo", { type: "set_logo" }),
    onPickFile: (file) => {
      revokePreview();
      if (file === null) {
        setState((current) => ({
          ...current,
          upload: { file: null, previewUrl: null },
          cover: { ...current.cover, saved: false, error: null },
        }));
        return;
      }
      const check = validateCoverFile(file);
      if (!check.ok) {
        setState((current) => ({
          ...current,
          upload: { file: null, previewUrl: null },
          cover: { pending: null, saved: false, error: check.reason },
        }));
        return;
      }
      previewRef.current = URL.createObjectURL(file);
      selectedFileRef.current = file;
      setState((current) => ({
        ...current,
        upload: {
          file: { name: file.name, size: file.size },
          previewUrl: previewRef.current,
        },
        cover: { ...current.cover, saved: false, error: null },
      }));
    },
    onSubmitUpload: () => {
      const file = selectedFileRef.current;
      if (file === null) return;
      applyCover("upload", () => uploadBinderCover(binderId, file, fetchImpl));
    },
    onRequestDelete: () =>
      setState((current) => ({ ...current, deleteStep: "confirm", deleteError: false })),
    onCancelDelete: () =>
      setState((current) => ({ ...current, deleteStep: "idle", deleteError: false })),
    onConfirmDelete: () => {
      if (state.deleting) return;
      setState((current) => ({ ...current, deleting: true, deleteError: false }));
      void deleteBinder(binderId, fetchImpl).then((result) => {
        if (result.kind === "unauthorized") return onUnauthorized();
        // Un classeur déjà absent (404) est, du point de vue de l'utilisateur, supprimé.
        if (result.kind === "ok" || result.kind === "not_found") {
          onDeleted(summary.binder.title);
        } else {
          setState((current) => ({ ...current, deleting: false, deleteError: true }));
        }
      });
    },
  };

  return <BinderSettingsView summary={summary} state={state} actions={actions} />;
};

/**
 * Bottom sheet Réglages & cover d'un classeur : titre (1..80), épinglage, cover à UNE image
 * (logo officiel / une carte du catalogue / image perso uploadée) et suppression en 2 étapes.
 * Réutilisable depuis l'écran Collection et la grille d'un classeur.
 */
export const BinderSettingsSheet = ({ summary, onClose, ...rest }: BinderSettingsSheetProps) => (
  <BottomSheet open={summary !== null} onClose={onClose} title={t("binderSettings.title")}>
    {summary === null ? null : <SettingsBody key={summary.binder.id} summary={summary} {...rest} />}
  </BottomSheet>
);
