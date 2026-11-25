/**
 * Saisie rafale · étape 2 (`08B`/`08D` Grille tactile, `08C` Pavé `#`).
 *
 * Découpage : état pur (`BurstScreenState` + `burstScreenReducer`, testables
 * sans DOM), vue pure (`BurstSessionView`, `renderToStaticMarkup`) et
 * conteneur (`BurstSessionScreen` : chargement du catalogue, clavier physique,
 * validation `POST /api/burst/commit`). La bascule Grille ↔ Pavé `#` ne touche
 * jamais au lot (lignes, quantités, variantes / langues / états, pile Undo) :
 * seul `mode` change. Les paramètres (langue, variante, état) se modifient à
 * la volée et ne s'appliquent qu'aux prochains ajouts.
 *
 * Tous les libellés passent par `i18n` (`burst.*`) ; couleurs = design tokens.
 * Réf. : docs/01 §6, docs/05, docs/06, ADR-006.
 */

import {
  type BurstImportReport,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  MAX_CARD_COPY_QUANTITY,
} from "@pokevault/domain";
import {
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  Hash,
  LayoutGrid,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { t, tPlural } from "../i18n/index.ts";
import {
  addToBurstSession,
  appendBurstNumberChar,
  BURST_SESSION_CONDITIONS,
  BURST_SESSION_VARIANTS,
  BURST_SETUP_LANGUAGES,
  type BurstCatalogCard,
  type BurstInputMode,
  type BurstLine,
  type BurstSessionState,
  type BurstSetCardsPayload,
  type BurstSetupConfig,
  backspaceBurstNumber,
  buildBurstCommitPayload,
  burstBatchQuantity,
  burstKeypadKeyAction,
  burstOwnedByCard,
  burstRecentLines,
  burstRemainingCapacity,
  canUndoBurstSession,
  clearBurstSession,
  commitBurstImport,
  decrementBurstCard,
  decrementBurstLine,
  emptyBurstSession,
  fetchBurstSetCards,
  matchBurstCardNumber,
  resolveBurstVariantForCard,
  summarizeBurstSession,
  undoBurstSession,
} from "../lib/burst-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";
import { BurstGridMode, variantLabel } from "./BurstGridMode.tsx";
import { BurstKeypadMode } from "./BurstKeypadMode.tsx";

// ---------------------------------------------------------------------------
// État pur
// ---------------------------------------------------------------------------

export type BurstCardsLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "not-found" }
  | { readonly status: "ready"; readonly payload: BurstSetCardsPayload };

/** Message transitoire (`role="status"`) quand un ajout est refusé ou borné. */
export type BurstNotice = "cap" | "lines";

export type BurstParam = "language" | "variant" | "condition";

export type BurstCommitStatus =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "error"; readonly reason: "session" | "generic" }
  | { readonly status: "done"; readonly report: BurstImportReport };

export interface BurstScreenState {
  readonly setId: string;
  readonly load: BurstCardsLoad;
  readonly session: BurstSessionState;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: CardCondition;
  readonly removeFromWishlist: boolean;
  readonly mode: BurstInputMode;
  /** Numéro saisi au pavé `#` (sans `#`). */
  readonly keypadInput: string;
  /** Variante choisie sur la carte en aperçu ; `null` = variante courante du lot. */
  readonly variantOverride: CardVariant | null;
  readonly paramSheet: BurstParam | null;
  readonly leavePrompt: boolean;
  readonly notice: BurstNotice | null;
  readonly commit: BurstCommitStatus;
}

export const initialBurstScreenState = (config: BurstSetupConfig): BurstScreenState => ({
  setId: config.setId,
  load: { status: "loading" },
  session: emptyBurstSession,
  language: config.language,
  variant: config.variant,
  condition: config.condition,
  removeFromWishlist: config.removeFromWishlist,
  mode: config.mode,
  keypadInput: "",
  variantOverride: null,
  paramSheet: null,
  leavePrompt: false,
  notice: null,
  commit: { status: "idle" },
});

export type BurstScreenAction =
  | { readonly type: "cards_loading" }
  | { readonly type: "cards_loaded"; readonly payload: BurstSetCardsPayload }
  | { readonly type: "cards_refreshed"; readonly payload: BurstSetCardsPayload }
  | { readonly type: "cards_failed"; readonly reason: "error" | "not-found" }
  | { readonly type: "param_sheet_opened"; readonly param: BurstParam }
  | { readonly type: "param_sheet_closed" }
  | { readonly type: "language_changed"; readonly language: CardLanguage }
  | { readonly type: "variant_changed"; readonly variant: CardVariant }
  | { readonly type: "condition_changed"; readonly condition: CardCondition }
  | { readonly type: "mode_changed"; readonly mode: BurstInputMode }
  | { readonly type: "card_added"; readonly cardId: string }
  | { readonly type: "card_removed"; readonly cardId: string }
  | { readonly type: "line_removed"; readonly key: string }
  | { readonly type: "undo" }
  | { readonly type: "keypad_char"; readonly char: string }
  | { readonly type: "keypad_backspace" }
  | { readonly type: "keypad_clear" }
  | { readonly type: "keypad_variant"; readonly variant: CardVariant }
  | { readonly type: "keypad_added"; readonly quantity: 1 | 2 }
  | { readonly type: "leave_prompt_opened" }
  | { readonly type: "leave_prompt_closed" }
  | { readonly type: "commit_started" }
  | { readonly type: "commit_succeeded"; readonly report: BurstImportReport }
  | { readonly type: "commit_failed"; readonly reason: "session" | "generic" }
  | { readonly type: "lot_restarted" };

/** Catalogue chargé, `undefined` tant qu'il n'est pas prêt. */
const readyPayload = (state: BurstScreenState): BurstSetCardsPayload | undefined =>
  state.load.status === "ready" ? state.load.payload : undefined;

const findCard = (state: BurstScreenState, cardId: string): BurstCatalogCard | undefined =>
  readyPayload(state)?.cards.find((card) => card.id === cardId);

/**
 * Ajoute `quantity` exemplaires de `card` avec les paramètres courants.
 * La variante est résolue comme le fera `BurstImportService` (ajustement
 * automatique sauf choix explicite). Refus (plafond 999 / 500 lignes) →
 * lot inchangé + notice.
 */
const applyAdd = (
  state: BurstScreenState,
  card: BurstCatalogCard,
  quantity: number,
  requestedVariant: CardVariant,
  explicit: boolean,
): BurstScreenState => {
  const { variant } = resolveBurstVariantForCard(card, requestedVariant, explicit);
  const before = burstBatchQuantity(state.session.lines, card.id);
  const session = addToBurstSession(state.session, {
    cardId: card.id,
    ownedQuantity: card.ownedQuantity,
    language: state.language,
    variant,
    requestedVariant,
    condition: state.condition,
    quantity,
    explicit,
  });
  if (session === state.session) {
    const atCap = burstRemainingCapacity(state.session.lines, card.id, card.ownedQuantity) <= 0;
    return { ...state, notice: atCap ? "cap" : "lines" };
  }
  const added = burstBatchQuantity(session.lines, card.id) - before;
  return { ...state, session, notice: added < quantity ? "cap" : null };
};

/** Reporte la validation sur la possession locale (`ownedQuantity`) du catalogue. */
const withReportApplied = (load: BurstCardsLoad, report: BurstImportReport): BurstCardsLoad => {
  if (load.status !== "ready") return load;
  const added = new Map<string, number>();
  for (const item of report.items) {
    added.set(item.cardId, (added.get(item.cardId) ?? 0) + item.addedQuantity);
  }
  return {
    status: "ready",
    payload: {
      ...load.payload,
      cards: load.payload.cards.map((card) => {
        const delta = added.get(card.id);
        return delta === undefined
          ? card
          : {
              ...card,
              ownedQuantity: Math.min(MAX_CARD_COPY_QUANTITY, card.ownedQuantity + delta),
            };
      }),
    },
  };
};

/**
 * Tant qu'une validation est en cours, le lot est gelé : le corps envoyé reste
 * identique au lot affiché (aucun ajout / Undo / retrait ne peut diverger).
 */
const LOT_ACTIONS: ReadonlySet<BurstScreenAction["type"]> = new Set([
  "card_added",
  "card_removed",
  "line_removed",
  "undo",
  "keypad_added",
]);

export const burstScreenReducer = (
  state: BurstScreenState,
  action: BurstScreenAction,
): BurstScreenState => {
  if (state.commit.status === "submitting" && LOT_ACTIONS.has(action.type)) return state;
  switch (action.type) {
    case "cards_loading":
      return { ...state, load: { status: "loading" } };
    case "cards_loaded":
      return { ...state, load: { status: "ready", payload: action.payload } };
    case "cards_refreshed":
      // Rafraîchissement silencieux (classeur créé, possession à jour) : ne touche pas au lot.
      return state.load.status === "ready"
        ? { ...state, load: { status: "ready", payload: action.payload } }
        : state;
    case "cards_failed":
      return { ...state, load: { status: action.reason } };
    case "param_sheet_opened":
      return { ...state, paramSheet: action.param };
    case "param_sheet_closed":
      return { ...state, paramSheet: null };
    case "language_changed":
      return { ...state, language: action.language, paramSheet: null };
    case "variant_changed":
      return { ...state, variant: action.variant, paramSheet: null };
    case "condition_changed":
      return { ...state, condition: action.condition, paramSheet: null };
    case "mode_changed":
      return { ...state, mode: action.mode };
    case "card_added": {
      const card = findCard(state, action.cardId);
      return card === undefined ? state : applyAdd(state, card, 1, state.variant, false);
    }
    case "card_removed":
      return {
        ...state,
        session: decrementBurstCard(state.session, action.cardId),
        notice: null,
      };
    case "line_removed":
      return { ...state, session: decrementBurstLine(state.session, action.key), notice: null };
    case "undo":
      return { ...state, session: undoBurstSession(state.session), notice: null };
    case "keypad_char":
      return {
        ...state,
        keypadInput: appendBurstNumberChar(state.keypadInput, action.char),
        variantOverride: null,
        notice: null,
      };
    case "keypad_backspace":
      return {
        ...state,
        keypadInput: backspaceBurstNumber(state.keypadInput),
        variantOverride: null,
        notice: null,
      };
    case "keypad_clear":
      return { ...state, keypadInput: "", variantOverride: null, notice: null };
    case "keypad_variant":
      return { ...state, variantOverride: action.variant };
    case "keypad_added": {
      const payload = readyPayload(state);
      if (payload === undefined) return state;
      const match = matchBurstCardNumber(payload.cards, state.keypadInput);
      if (match.kind !== "match") return state;
      const explicit = state.variantOverride !== null;
      const next = applyAdd(
        state,
        match.card,
        action.quantity,
        state.variantOverride ?? state.variant,
        explicit,
      );
      // Ajout refusé : on garde le numéro affiché ; sinon on enchaîne sur la carte suivante.
      return next.session === state.session
        ? next
        : { ...next, keypadInput: "", variantOverride: null };
    }
    case "leave_prompt_opened":
      return { ...state, leavePrompt: true };
    case "leave_prompt_closed":
      return { ...state, leavePrompt: false };
    case "commit_started":
      return { ...state, commit: { status: "submitting" }, notice: null };
    case "commit_succeeded":
      return {
        ...state,
        load: withReportApplied(state.load, action.report),
        session: clearBurstSession(),
        keypadInput: "",
        variantOverride: null,
        notice: null,
        commit: { status: "done", report: action.report },
      };
    case "commit_failed":
      return { ...state, commit: { status: "error", reason: action.reason } };
    case "lot_restarted":
      return {
        ...state,
        session: clearBurstSession(),
        keypadInput: "",
        variantOverride: null,
        notice: null,
        commit: { status: "idle" },
      };
  }
};

/** Quitter : direct si le lot est vide, sinon confirmation (le lot serait perdu). */
export const requestBurstExit = (state: BurstScreenState): "exit" | "confirm" =>
  state.session.lines.length === 0 ? "exit" : "confirm";

/**
 * Valide le lot : `POST /api/burst/commit`. Chargement → succès (confirmation)
 * ou échec (message, **lot conservé**). Un lot vide ou une validation déjà
 * en cours n'envoie rien.
 */
export const submitBurstLot = async (
  state: BurstScreenState,
  commit: typeof commitBurstImport,
  dispatch: Dispatch<BurstScreenAction>,
): Promise<void> => {
  if (state.commit.status === "submitting") return;
  const payload = buildBurstCommitPayload(
    {
      setId: state.setId,
      language: state.language,
      variant: state.variant,
      condition: state.condition,
      removeFromWishlist: state.removeFromWishlist,
    },
    state.session.lines,
  );
  if (payload === null) return;
  dispatch({ type: "commit_started" });
  try {
    const result = await commit(payload);
    if (result.kind === "ok") dispatch({ type: "commit_succeeded", report: result.data });
    else
      dispatch({
        type: "commit_failed",
        reason: result.kind === "unauthorized" ? "session" : "generic",
      });
  } catch {
    dispatch({ type: "commit_failed", reason: "generic" });
  }
};

// ---------------------------------------------------------------------------
// Données dérivées et libellés
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const conditionShort = (condition: CardCondition): string =>
  t(`burst.session.condition.short.${condition}`);

const NOTICE_KEY = {
  cap: "burst.session.notice.cap",
  lines: "burst.session.notice.lines",
} as const satisfies Record<BurstNotice, `burst.session.notice.${BurstNotice}`>;

const PARAM_LABEL_KEY = {
  language: "burst.language.label",
  variant: "burst.variant.label",
  condition: "burst.condition.label",
} as const satisfies Record<
  BurstParam,
  "burst.language.label" | "burst.variant.label" | "burst.condition.label"
>;

const paramValueLabel = (state: BurstScreenState, param: BurstParam): string =>
  param === "language"
    ? t(`burst.language.${state.language}`)
    : param === "variant"
      ? variantLabel(state.variant)
      : conditionShort(state.condition);

/** Cumul `cardId → exemplaires dans le lot`. */
const batchQuantities = (lines: ReadonlyArray<BurstLine>): Map<string, number> => {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line.cardId, (map.get(line.cardId) ?? 0) + line.quantity);
  return map;
};

// ---------------------------------------------------------------------------
// Briques de la vue
// ---------------------------------------------------------------------------

const ParamPill = ({
  param,
  state,
  onOpen,
}: {
  readonly param: BurstParam;
  readonly state: BurstScreenState;
  readonly onOpen: (param: BurstParam) => void;
}) => (
  <button
    type="button"
    data-testid={`burst-param-${param}`}
    aria-haspopup="dialog"
    aria-label={t("burst.session.param.aria", {
      label: t(PARAM_LABEL_KEY[param]),
      value: paramValueLabel(state, param),
    })}
    onClick={() => onOpen(param)}
    className={`inline-flex min-h-11 items-center gap-1 rounded-pill border border-line bg-surface-1 px-4 text-sm font-semibold text-primary transition-colors hover:bg-surface-2 ${focusRing}`}
  >
    <span>{paramValueLabel(state, param)}</span>
    <ChevronDown size={14} aria-hidden="true" className="text-muted" />
  </button>
);

const ModeToggle = ({
  mode,
  onChange,
}: {
  readonly mode: BurstInputMode;
  readonly onChange: (mode: BurstInputMode) => void;
}) => (
  <fieldset className="m-0 inline-flex min-w-0 shrink-0 rounded-pill border border-line bg-surface-1 p-0.5">
    <legend className="sr-only">{t("burst.session.mode.label")}</legend>
    {(["grid", "keypad"] as const).map((entry) => {
      const selected = mode === entry;
      const Icon = entry === "grid" ? LayoutGrid : Hash;
      return (
        <button
          key={entry}
          type="button"
          aria-pressed={selected}
          data-testid={`burst-mode-toggle-${entry}`}
          onClick={() => onChange(entry)}
          className={`inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 text-sm font-semibold transition-colors ${
            selected ? "bg-gold-soft text-gold" : "text-secondary hover:text-primary"
          } ${focusRing}`}
        >
          <Icon size={16} aria-hidden="true" />
          {t(`burst.session.mode.${entry}`)}
        </button>
      );
    })}
  </fieldset>
);

/** Ruban horizontal des derniers ajouts : `#025 ×1 · Reverse` + `×` (−1 exemplaire). */
const BurstRibbon = ({
  lines,
  cardsById,
  onRemove,
}: {
  readonly lines: ReadonlyArray<BurstLine>;
  readonly cardsById: ReadonlyMap<string, BurstCatalogCard>;
  readonly onRemove: (key: string) => void;
}) => {
  const recent = burstRecentLines(lines).slice(0, 50);
  return (
    <section
      data-testid="burst-ribbon"
      aria-label={t("burst.ribbon.label")}
      className="border-t border-line px-4 py-2"
    >
      {recent.length === 0 ? (
        <p className="py-1.5 text-center text-xs text-muted">{t("burst.ribbon.empty")}</p>
      ) : (
        <ul className="flex gap-2 overflow-x-auto">
          {recent.map((line) => {
            const card = cardsById.get(line.cardId);
            if (card === undefined) return null;
            return (
              <li
                key={line.key}
                data-testid="burst-ribbon-chip"
                className="flex shrink-0 items-center rounded-pill border border-line bg-surface-1 pl-3"
              >
                <span className="font-mono text-xs font-semibold tabular-nums text-primary">
                  {`#${card.localId} ×${line.quantity} · ${variantLabel(line.variant)}`}
                </span>
                <button
                  type="button"
                  data-testid="burst-ribbon-remove"
                  aria-label={t("burst.ribbon.remove", {
                    name: card.nameFr,
                    localId: card.localId,
                    variant: variantLabel(line.variant),
                  })}
                  onClick={() => onRemove(line.key)}
                  className={`grid min-h-11 min-w-11 place-items-center rounded-pill text-secondary hover:text-primary ${focusRing}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

const optionClass = (selected: boolean): string =>
  `min-h-11 rounded-pill border px-4 text-sm font-semibold transition-colors ${
    selected
      ? "border-gold bg-gold-soft text-gold"
      : "border-line bg-surface-2 text-secondary hover:text-primary"
  } ${focusRing}`;

/** Feuille compacte de changement d'un paramètre : 1 tap = appliqué et fermé. */
const ParamSheet = ({
  state,
  actions,
}: {
  readonly state: BurstScreenState;
  readonly actions: BurstSessionViewActions;
}) => {
  const param = state.paramSheet;
  return (
    <BottomSheet
      open={param !== null}
      onClose={actions.onCloseParam}
      title={param === null ? undefined : t(PARAM_LABEL_KEY[param])}
      ariaLabel={t("burst.session.params.label")}
    >
      <div data-testid="burst-param-sheet" className="flex flex-col gap-3 pt-1">
        <div className="flex flex-wrap gap-2">
          {param === "language"
            ? BURST_SETUP_LANGUAGES.map((language) => (
                <button
                  key={language}
                  type="button"
                  aria-pressed={state.language === language}
                  data-testid={`burst-option-language-${language}`}
                  onClick={() => actions.onLanguageChange(language)}
                  className={optionClass(state.language === language)}
                >
                  {t(`burst.language.${language}`)}
                </button>
              ))
            : null}
          {param === "variant"
            ? BURST_SESSION_VARIANTS.map((variant) => (
                <button
                  key={variant}
                  type="button"
                  aria-pressed={state.variant === variant}
                  data-testid={`burst-option-variant-${variant}`}
                  onClick={() => actions.onVariantChange(variant)}
                  className={optionClass(state.variant === variant)}
                >
                  {variantLabel(variant)}
                </button>
              ))
            : null}
          {param === "condition"
            ? BURST_SESSION_CONDITIONS.map((condition) => (
                <button
                  key={condition}
                  type="button"
                  aria-pressed={state.condition === condition}
                  data-testid={`burst-option-condition-${condition}`}
                  onClick={() => actions.onConditionChange(condition)}
                  className={optionClass(state.condition === condition)}
                >
                  {t(`burst.condition.${condition}`)}
                </button>
              ))
            : null}
        </div>
        <p className="text-xs text-muted">{t("burst.session.param.hint")}</p>
      </div>
    </BottomSheet>
  );
};

const LeaveSheet = ({
  open,
  quantity,
  onStay,
  onConfirm,
}: {
  readonly open: boolean;
  readonly quantity: number;
  readonly onStay: () => void;
  readonly onConfirm: () => void;
}) => (
  <BottomSheet open={open} onClose={onStay} title={t("burst.leave.title")}>
    <div data-testid="burst-leave-sheet" className="flex flex-col gap-4 pt-1">
      <p className="text-sm text-secondary">{tPlural("burst.leave.body", quantity)}</p>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="burst-leave-stay"
          onClick={onStay}
          className={`min-h-12 rounded-pill bg-gold px-6 text-sm font-bold text-canvas hover:bg-gold-bar ${focusRing}`}
        >
          {t("burst.leave.stay")}
        </button>
        <button
          type="button"
          data-testid="burst-leave-confirm"
          onClick={onConfirm}
          className={`min-h-12 rounded-pill border border-line bg-surface-2 px-6 text-sm font-semibold text-danger ${focusRing}`}
        >
          {t("burst.leave.confirm")}
        </button>
      </div>
    </div>
  </BottomSheet>
);

const CenteredNotice = ({
  testId,
  message,
  children,
}: {
  readonly testId: string;
  readonly message: string;
  readonly children?: ReactNode;
}) => (
  <div
    data-testid={testId}
    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-secondary"
  >
    <TriangleAlert size={20} aria-hidden="true" className="text-warning" />
    <p>{message}</p>
    {children}
  </div>
);

/** Panneau de confirmation après validation (cartes ajoutées, nouvelles, doublons…). */
const DonePanel = ({
  report,
  cardsById,
  binderId,
  actions,
}: {
  readonly report: BurstImportReport;
  readonly cardsById: ReadonlyMap<string, BurstCatalogCard>;
  readonly binderId: string | null;
  readonly actions: BurstSessionViewActions;
}) => {
  const adjusted = report.items.filter((item) => item.variantAdjusted);
  return (
    <div
      data-testid="burst-done"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 bg-canvas px-5 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:max-w-xl lg:px-8"
    >
      <header className="flex flex-col items-center gap-2 text-center">
        <CircleCheck size={40} aria-hidden="true" className="text-success" />
        <h1 className="text-xl font-bold text-primary">{t("burst.done.title")}</h1>
      </header>
      <section
        aria-label={t("burst.done.title")}
        className="flex flex-col gap-2 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
      >
        <ul className="flex flex-col gap-2 font-mono text-sm tabular-nums text-primary">
          <li data-testid="burst-done-added">
            {tPlural("burst.done.added", report.totalAddedQuantity)}
          </li>
          <li data-testid="burst-done-new">{tPlural("burst.done.new", report.newCardsCount)}</li>
          <li data-testid="burst-done-duplicate">
            {tPlural("burst.done.duplicate", report.duplicateCardsCount)}
          </li>
          {report.wishlistRemovedCount > 0 ? (
            <li data-testid="burst-done-wishlist">
              {tPlural("burst.done.wishlist", report.wishlistRemovedCount)}
            </li>
          ) : null}
        </ul>
      </section>
      {adjusted.length > 0 ? (
        <section
          data-testid="burst-done-adjusted"
          className="flex flex-col gap-2 rounded-sheet border border-line bg-surface-1 p-5 text-sm text-secondary"
        >
          <h2 className="font-semibold text-primary">
            {tPlural("burst.done.adjusted.heading", adjusted.length)}
          </h2>
          <ul className="flex flex-col gap-1">
            {adjusted.map((item) => {
              const card = cardsById.get(item.cardId);
              return (
                <li
                  key={`${item.cardId}-${item.language}-${item.resolvedVariant}-${item.condition}`}
                >
                  {t("burst.done.adjusted.item", {
                    name: card?.nameFr ?? item.cardId,
                    localId: card?.localId ?? "",
                    variant: variantLabel(item.resolvedVariant),
                  })}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          data-testid="burst-done-again"
          onClick={actions.onRestart}
          className={`min-h-12 rounded-pill bg-gold px-6 text-sm font-bold text-canvas hover:bg-gold-bar ${focusRing}`}
        >
          {t("burst.done.again")}
        </button>
        {binderId === null ? (
          <button
            type="button"
            data-testid="burst-done-collection"
            onClick={actions.onOpenCollection}
            className={`min-h-12 rounded-pill border border-gold bg-gold-soft px-6 text-sm font-semibold text-gold ${focusRing}`}
          >
            {t("burst.done.openCollection")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="burst-done-binder"
            onClick={() => actions.onOpenBinder(binderId)}
            className={`min-h-12 rounded-pill border border-gold bg-gold-soft px-6 text-sm font-semibold text-gold ${focusRing}`}
          >
            {t("burst.done.openBinder")}
          </button>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Vue pure
// ---------------------------------------------------------------------------

export interface BurstSessionViewActions {
  readonly onBack: () => void;
  readonly onOpenParam: (param: BurstParam) => void;
  readonly onCloseParam: () => void;
  readonly onLanguageChange: (language: CardLanguage) => void;
  readonly onVariantChange: (variant: CardVariant) => void;
  readonly onConditionChange: (condition: CardCondition) => void;
  readonly onModeChange: (mode: BurstInputMode) => void;
  readonly onAddCard: (cardId: string) => void;
  readonly onRemoveCard: (cardId: string) => void;
  readonly onRemoveLine: (key: string) => void;
  readonly onUndo: () => void;
  readonly onKeypadChar: (char: string) => void;
  readonly onKeypadBackspace: () => void;
  readonly onKeypadClear: () => void;
  readonly onKeypadVariant: (variant: CardVariant) => void;
  readonly onKeypadAdd: (quantity: 1 | 2) => void;
  readonly onValidate: () => void;
  readonly onRetryLoad: () => void;
  readonly onStay: () => void;
  readonly onConfirmLeave: () => void;
  readonly onRestart: () => void;
  readonly onOpenBinder: (binderId: string) => void;
  readonly onOpenCollection: () => void;
}

export const BurstSessionView = ({
  state,
  actions,
}: {
  readonly state: BurstScreenState;
  readonly actions: BurstSessionViewActions;
}) => {
  const payload = readyPayload(state);
  const cards = payload?.cards ?? [];
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.id, card] as const)), [cards]);
  const ownedByCard = useMemo(() => burstOwnedByCard(cards), [cards]);
  const lines = state.session.lines;
  const batchByCard = useMemo(() => batchQuantities(lines), [lines]);
  const summary = useMemo(() => summarizeBurstSession(lines, ownedByCard), [lines, ownedByCard]);

  if (state.commit.status === "done") {
    return (
      <DonePanel
        report={state.commit.report}
        cardsById={cardsById}
        binderId={payload?.binderId ?? null}
        actions={actions}
      />
    );
  }

  const submitting = state.commit.status === "submitting";
  const canValidate = payload !== undefined && summary.totalQuantity > 0 && !submitting;
  const title = payload?.set.nameFr ?? t("burst.title");
  const subtitle =
    payload === undefined
      ? null
      : `${payload.set.code === null ? "" : `${payload.set.code} · `}${tPlural("burst.sets.cards", payload.set.totalCount)}`;

  return (
    <div
      data-testid="burst-session"
      data-mode={state.mode}
      className="mx-auto flex h-dvh w-full max-w-md flex-col bg-canvas lg:max-w-5xl"
    >
      {/* Barre supérieure sticky (commune Grille & Pavé #) */}
      <header className="sticky top-0 z-10 shrink-0 border-b border-line bg-canvas px-4 pt-3 pb-3 lg:px-8">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="burst-session-back"
            aria-label={t("burst.session.back")}
            onClick={actions.onBack}
            className={`grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded-pill border border-line bg-surface-1 text-primary ${focusRing}`}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1
              data-testid="burst-session-title"
              className="truncate text-base font-bold text-primary"
            >
              {title}
            </h1>
            {subtitle === null ? null : (
              <p className="truncate font-mono text-[11px] tabular-nums text-muted">{subtitle}</p>
            )}
          </div>
          <ModeToggle mode={state.mode} onChange={actions.onModeChange} />
        </div>
        <fieldset className="m-0 mt-2 flex min-w-0 items-center gap-2 overflow-x-auto border-0 p-0">
          <legend className="sr-only">{t("burst.session.params.label")}</legend>
          <ParamPill param="language" state={state} onOpen={actions.onOpenParam} />
          <ParamPill param="variant" state={state} onOpen={actions.onOpenParam} />
          <ParamPill param="condition" state={state} onOpen={actions.onOpenParam} />
        </fieldset>
      </header>

      {/* Corps : chargement, erreurs ou mode de saisie (le lot vit dans l'état, pas dans le mode) */}
      {state.load.status === "loading" ? (
        <p
          data-testid="burst-session-loading"
          className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted"
        >
          {t("burst.session.loading")}
        </p>
      ) : state.load.status === "error" ? (
        <CenteredNotice testId="burst-session-error" message={t("burst.session.error")}>
          <button
            type="button"
            data-testid="burst-session-retry"
            onClick={actions.onRetryLoad}
            className={`min-h-11 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
          >
            {t("burst.sets.retry")}
          </button>
        </CenteredNotice>
      ) : state.load.status === "not-found" ? (
        <CenteredNotice testId="burst-session-notfound" message={t("burst.session.notFound")} />
      ) : cards.length === 0 ? (
        <CenteredNotice testId="burst-session-empty" message={t("burst.session.empty")} />
      ) : state.mode === "grid" ? (
        <BurstGridMode
          cards={cards}
          batchByCard={batchByCard}
          currentVariant={state.variant}
          onAdd={actions.onAddCard}
          onRemove={actions.onRemoveCard}
        />
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col">
          <BurstKeypadMode
            cards={cards}
            input={state.keypadInput}
            variantOverride={state.variantOverride}
            currentVariant={state.variant}
            batchByCard={batchByCard}
            onChar={actions.onKeypadChar}
            onBackspace={actions.onKeypadBackspace}
            onClear={actions.onKeypadClear}
            onVariantOverride={actions.onKeypadVariant}
            onAdd={actions.onKeypadAdd}
          />
        </div>
      )}

      {/* Pied fixe : ruban (Pavé #) + barre de validation flottante, safe-area aware */}
      {payload === undefined ? null : (
        <footer
          data-testid="burst-footer"
          className="shrink-0 border-t border-line bg-canvas shadow-nav"
        >
          {state.mode === "keypad" ? (
            <BurstRibbon lines={lines} cardsById={cardsById} onRemove={actions.onRemoveLine} />
          ) : null}
          <section
            aria-label={t("burst.bar.label")}
            className="px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:px-8"
          >
            {state.notice === null ? null : (
              <p
                role="status"
                data-testid="burst-notice"
                className="mb-2 rounded-md bg-gold-soft px-3 py-1.5 text-xs font-semibold text-gold"
              >
                {t(NOTICE_KEY[state.notice])}
              </p>
            )}
            {state.commit.status === "error" ? (
              <p
                role="alert"
                data-testid="burst-commit-error"
                className="mb-2 rounded-md border border-danger px-3 py-2 text-xs font-semibold text-danger"
              >
                {t(
                  state.commit.reason === "session"
                    ? "burst.commit.error.session"
                    : "burst.commit.error.generic",
                )}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="burst-undo"
                aria-label={t("burst.bar.undo")}
                disabled={!canUndoBurstSession(state.session) || submitting}
                onClick={actions.onUndo}
                className={`grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded-pill border border-line bg-surface-1 text-primary disabled:opacity-40 ${focusRing}`}
              >
                <Undo2 size={20} aria-hidden="true" />
              </button>
              <p
                data-testid="burst-summary"
                aria-live="polite"
                className="min-w-0 flex-1 truncate font-mono text-sm font-semibold tabular-nums text-primary"
              >
                {`${tPlural("burst.bar.cards", summary.totalQuantity)} · ${tPlural("burst.bar.new", summary.newCards)}`}
              </p>
              <button
                type="button"
                data-testid="burst-validate"
                disabled={!canValidate}
                aria-busy={submitting}
                onClick={actions.onValidate}
                className={`min-h-11 shrink-0 rounded-pill px-6 text-sm font-bold transition-colors ${
                  canValidate ? "bg-gold text-canvas hover:bg-gold-bar" : "bg-surface-2 text-muted"
                } ${focusRing}`}
              >
                {t(submitting ? "burst.bar.validating" : "burst.bar.validate")}
              </button>
            </div>
          </section>
        </footer>
      )}

      <ParamSheet state={state} actions={actions} />
      <LeaveSheet
        open={state.leavePrompt}
        quantity={summary.totalQuantity}
        onStay={actions.onStay}
        onConfirm={actions.onConfirmLeave}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Conteneur (chargement, clavier physique, validation)
// ---------------------------------------------------------------------------

export interface BurstSessionScreenProps {
  /** Configuration validée à l'étape 1 (`08A`). */
  readonly config: BurstSetupConfig;
  /** Retour à l'étape 1 (le lot est abandonné après confirmation). */
  readonly onExit: () => void;
  readonly onOpenBinder: (binderId: string) => void;
  readonly onOpenCollection: () => void;
  /** Substituables dans les tests. */
  readonly fetchCards?: typeof fetchBurstSetCards | undefined;
  readonly commit?: typeof commitBurstImport | undefined;
}

export const BurstSessionScreen = ({
  config,
  onExit,
  onOpenBinder,
  onOpenCollection,
  fetchCards,
  commit,
}: BurstSessionScreenProps) => {
  const [state, dispatch] = useReducer(burstScreenReducer, config, initialBurstScreenState);
  const [retryNonce, setRetryNonce] = useState(0);
  // Verrou synchrone contre un double-clic sur « Valider » avant re-rendu.
  const committingRef = useRef(false);
  const loadCards = fetchCards ?? fetchBurstSetCards;
  const sendCommit = commit ?? commitBurstImport;

  // Chargement du catalogue de l'extension (+ possession) ; `retryNonce` relance volontairement.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryNonce` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    loadCards(config.setId, controller.signal)
      .then((result) => {
        if (result.kind === "ok") dispatch({ type: "cards_loaded", payload: result.data });
        else
          dispatch({
            type: "cards_failed",
            reason: result.kind === "not-found" ? "not-found" : "error",
          });
      })
      .catch(() => {}); // AbortError : démontage
    return () => controller.abort();
  }, [config.setId, loadCards, retryNonce]);

  // Après validation : rafraîchissement silencieux (classeur créé, possession à jour).
  const committed = state.commit.status === "done";
  useEffect(() => {
    if (!committed) return;
    const controller = new AbortController();
    loadCards(config.setId, controller.signal)
      .then((result) => {
        if (result.kind === "ok") dispatch({ type: "cards_refreshed", payload: result.data });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [committed, config.setId, loadCards]);

  // Clavier physique du pavé `#` : `0-9`, lettres, Backspace, Enter, Escape.
  const keyboardActive =
    state.mode === "keypad" &&
    state.load.status === "ready" &&
    state.paramSheet === null &&
    !state.leavePrompt &&
    state.commit.status !== "done";
  useEffect(() => {
    if (!keyboardActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = burstKeypadKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        target: classifyKeyTarget(event.target),
      });
      if (action === null) return;
      event.preventDefault();
      switch (action.type) {
        case "char":
          return dispatch({ type: "keypad_char", char: action.char });
        case "backspace":
          return dispatch({ type: "keypad_backspace" });
        case "clear":
          return dispatch({ type: "keypad_clear" });
        case "add":
          return dispatch({ type: "keypad_added", quantity: 1 });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyboardActive]);

  // Callbacks stables : les tuiles de la grille sont mémoïsées (gros sets, 250+ cartes).
  const onAddCard = useCallback((cardId: string) => dispatch({ type: "card_added", cardId }), []);
  const onRemoveCard = useCallback(
    (cardId: string) => dispatch({ type: "card_removed", cardId }),
    [],
  );

  return (
    <BurstSessionView
      state={state}
      actions={{
        onBack: () => {
          if (state.commit.status === "submitting") return;
          if (requestBurstExit(state) === "exit") onExit();
          else dispatch({ type: "leave_prompt_opened" });
        },
        onOpenParam: (param) => dispatch({ type: "param_sheet_opened", param }),
        onCloseParam: () => dispatch({ type: "param_sheet_closed" }),
        onLanguageChange: (language) => dispatch({ type: "language_changed", language }),
        onVariantChange: (variant) => dispatch({ type: "variant_changed", variant }),
        onConditionChange: (condition) => dispatch({ type: "condition_changed", condition }),
        onModeChange: (mode) => dispatch({ type: "mode_changed", mode }),
        onAddCard,
        onRemoveCard,
        onRemoveLine: (key) => dispatch({ type: "line_removed", key }),
        onUndo: () => dispatch({ type: "undo" }),
        onKeypadChar: (char) => dispatch({ type: "keypad_char", char }),
        onKeypadBackspace: () => dispatch({ type: "keypad_backspace" }),
        onKeypadClear: () => dispatch({ type: "keypad_clear" }),
        onKeypadVariant: (variant) => dispatch({ type: "keypad_variant", variant }),
        onKeypadAdd: (quantity) => dispatch({ type: "keypad_added", quantity }),
        onValidate: () => {
          if (committingRef.current) return;
          committingRef.current = true;
          void submitBurstLot(state, sendCommit, dispatch).finally(() => {
            committingRef.current = false;
          });
        },
        onRetryLoad: () => {
          dispatch({ type: "cards_loading" });
          setRetryNonce((nonce) => nonce + 1);
        },
        onStay: () => dispatch({ type: "leave_prompt_closed" }),
        onConfirmLeave: () => {
          dispatch({ type: "leave_prompt_closed" });
          onExit();
        },
        onRestart: () => dispatch({ type: "lot_restarted" }),
        onOpenBinder,
        onOpenCollection,
      }}
    />
  );
};

/** Classe la cible d'un évènement clavier pour `burstKeypadKeyAction`. */
const classifyKeyTarget = (
  target: EventTarget | null,
): "text-field" | "interactive" | "keypad" | "other" => {
  if (!(target instanceof HTMLElement)) return "other";
  if (target.closest("input, textarea, select, [contenteditable='true']") !== null) {
    return "text-field";
  }
  if (target.closest("[data-burst-keypad]") !== null) return "keypad";
  if (target.closest("button, a, [role='button']") !== null) return "interactive";
  return "other";
};
