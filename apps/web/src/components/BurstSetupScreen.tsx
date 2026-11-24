/**
 * Écran `08A` — Saisie rafale, étape 1 : configuration du lot (docs/01 §6).
 *
 * La vue est découpée en état pur (`BurstSetupState` + réducteur exporté) et
 * rendu pur (`BurstSetupView`), testables sans DOM via `renderToStaticMarkup` ;
 * `BurstSetupScreen` câble l'état (chargement des extensions, interaction) et
 * les actions de navigation. Tous les libellés passent par `i18n` (`burst.*`),
 * toutes les couleurs par les design tokens (`tokens.css`) — Dark & Light.
 *
 * Réf. : docs/01 §1 & §6, docs/03 §4, ADR-006.
 */

import type { CardLanguage } from "@pokevault/domain";
import { ArrowLeft, Hash, LayoutGrid, RotateCcw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useReducer, useState } from "react";
import { t, tPlural } from "../i18n/index.ts";
import {
  BURST_SETUP_CONDITIONS,
  BURST_SETUP_LANGUAGES,
  BURST_SETUP_MODES,
  BURST_SETUP_VARIANTS,
  type BurstInputMode,
  type BurstSetOption,
  type BurstSetupCondition,
  type BurstSetupConfig,
  type BurstSetupVariant,
  DEFAULT_BURST_SETUP,
  fetchBurstSets,
  filterBurstSets,
} from "../lib/burst-client.ts";

// ---------------------------------------------------------------------------
// État pur (configurable et testable sans DOM)
// ---------------------------------------------------------------------------

export type BurstSetupLoadStatus = "loading" | "ready" | "error";

export interface BurstSetupState {
  readonly status: BurstSetupLoadStatus;
  readonly sets: ReadonlyArray<BurstSetOption>;
  readonly filter: string;
  readonly selectedSetId: string | null;
  readonly language: CardLanguage;
  readonly variant: BurstSetupVariant;
  readonly condition: BurstSetupCondition;
  readonly removeFromWishlist: boolean;
  readonly mode: BurstInputMode;
  /** `config` = étape 1 (08A) · `confirm` = étape 2 (08B/08C à venir, issue #20). */
  readonly step: "config" | "confirm";
  readonly startedConfig: BurstSetupConfig | null;
}

/** État initial de l'étape 1 ; `initialSetId` pré-sélectionne l'extension. */
export const initialBurstSetupState = (
  initialSetId: string | undefined = undefined,
): BurstSetupState => ({
  status: "loading",
  sets: [],
  filter: "",
  selectedSetId: initialSetId?.trim() === "" || initialSetId === undefined ? null : initialSetId,
  ...DEFAULT_BURST_SETUP,
  step: "config",
  startedConfig: null,
});

export type BurstSetupAction =
  | { readonly type: "sets_loaded"; readonly sets: ReadonlyArray<BurstSetOption> }
  | { readonly type: "sets_failed" }
  | { readonly type: "filter_changed"; readonly value: string }
  | { readonly type: "set_selected"; readonly setId: string | null }
  | { readonly type: "language_changed"; readonly language: CardLanguage }
  | { readonly type: "variant_changed"; readonly variant: BurstSetupVariant }
  | { readonly type: "condition_changed"; readonly condition: BurstSetupCondition }
  | { readonly type: "wishlist_toggled" }
  | { readonly type: "mode_changed"; readonly mode: BurstInputMode }
  | { readonly type: "started" }
  | { readonly type: "back_to_config" };

export const burstSetupReducer = (
  state: BurstSetupState,
  action: BurstSetupAction,
): BurstSetupState => {
  switch (action.type) {
    case "sets_loaded":
      return { ...state, status: "ready", sets: action.sets };
    case "sets_failed":
      return { ...state, status: "error" };
    case "filter_changed":
      return { ...state, filter: action.value };
    case "set_selected":
      return { ...state, selectedSetId: action.setId };
    case "language_changed":
      return { ...state, language: action.language };
    case "variant_changed":
      return { ...state, variant: action.variant };
    case "condition_changed":
      return { ...state, condition: action.condition };
    case "wishlist_toggled":
      return { ...state, removeFromWishlist: !state.removeFromWishlist };
    case "mode_changed":
      return { ...state, mode: action.mode };
    case "started": {
      const config = burstSetupConfig(state);
      return config === null ? state : { ...state, step: "confirm", startedConfig: config };
    }
    case "back_to_config":
      return { ...state, step: "config", startedConfig: null };
  }
};

/** Configuration validée, ou `null` tant qu'aucune extension n'est sélectionnée. */
export const burstSetupConfig = (state: BurstSetupState): BurstSetupConfig | null =>
  state.selectedSetId === null
    ? null
    : {
        setId: state.selectedSetId,
        language: state.language,
        variant: state.variant,
        condition: state.condition,
        removeFromWishlist: state.removeFromWishlist,
        mode: state.mode,
      };

/** Extensions filtrées par la recherche locale (insensible aux accents). */
export const visibleBurstSets = (state: BurstSetupState): ReadonlyArray<BurstSetOption> =>
  filterBurstSets(state.sets, state.filter);

/** Action du CTA « Démarrer la saisie » : appelle `onStart` si la config est complète. */
export const startBurstSetup = (
  state: BurstSetupState,
  onStart: (config: BurstSetupConfig) => void,
): void => {
  const config = burstSetupConfig(state);
  if (config !== null) onStart(config);
};

// ---------------------------------------------------------------------------
// Libellés i18n (aucune chaîne en dur dans la vue)
// ---------------------------------------------------------------------------

const LANGUAGE_LABEL_KEY = {
  FR: "burst.language.FR",
  EN: "burst.language.EN",
  JP: "burst.language.JP",
  ZH: "burst.language.ZH",
} as const satisfies Record<CardLanguage, `burst.language.${CardLanguage}`>;

const VARIANT_LABEL_KEY = {
  normal: "burst.variant.normal",
  reverse: "burst.variant.reverse",
  holo: "burst.variant.holo",
  promo: "burst.variant.promo",
} as const satisfies Record<BurstSetupVariant, `burst.variant.${BurstSetupVariant}`>;

const CONDITION_LABEL_KEY = {
  NM: "burst.condition.NM",
  M: "burst.condition.M",
  EX: "burst.condition.EX",
  GD: "burst.condition.GD",
} as const satisfies Record<BurstSetupCondition, `burst.condition.${BurstSetupCondition}`>;

const MODE_TITLE_KEY = {
  grid: "burst.mode.grid.title",
  keypad: "burst.mode.keypad.title",
} as const satisfies Record<BurstInputMode, `burst.mode.${BurstInputMode}.title`>;

const MODE_HINT_KEY = {
  grid: "burst.mode.grid.hint",
  keypad: "burst.mode.keypad.hint",
} as const satisfies Record<BurstInputMode, `burst.mode.${BurstInputMode}.hint`>;

// ---------------------------------------------------------------------------
// Vocables partagés
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const Pill = ({
  label,
  selected,
  testId,
  onToggle,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly testId: string;
  readonly onToggle: () => void;
}) => (
  <button
    type="button"
    aria-pressed={selected}
    data-testid={testId}
    onClick={onToggle}
    className={`min-h-11 rounded-pill border px-4 text-sm font-semibold transition-colors ${
      selected
        ? "border-gold bg-gold-soft text-gold"
        : "border-line bg-surface-1 text-secondary hover:bg-surface-2"
    } ${focusRing}`}
  >
    {label}
  </button>
);

/** Bloc de pills (Langue, Variante, État). */
const PillGroup = ({
  id,
  legend,
  children,
}: {
  readonly id: string;
  readonly legend: string;
  readonly children: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    <p id={id} className="text-xs font-semibold tracking-wide text-muted uppercase">
      {legend}
    </p>
    <div className="flex flex-wrap gap-2">{children}</div>
  </div>
);

/** Ligne d'extension sélectionnable (bordure dorée quand sélectionnée). */
const SetRow = ({
  set,
  selected,
  onSelect,
}: {
  readonly set: BurstSetOption;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) => (
  <li>
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`burst-set-${set.id}`}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-sheet border p-3 text-left transition-colors ${
        selected ? "border-gold bg-gold-soft" : "border-line bg-surface-1 hover:bg-surface-2"
      } ${focusRing}`}
    >
      {set.logoUrl === null ? (
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-2 font-mono text-xs font-bold tabular-nums text-muted"
        >
          {set.code ?? set.id}
        </span>
      ) : (
        <img src={set.logoUrl} alt="" loading="lazy" className="size-10 shrink-0 object-contain" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-bold text-primary">{set.nameFr}</span>
        <span className="truncate text-xs text-secondary">
          {set.seriesNameFr}
          {set.code === null ? "" : ` · ${set.code}`}
        </span>
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
        {tPlural("burst.sets.cards", set.totalCount)}
      </span>
    </button>
  </li>
);

// ---------------------------------------------------------------------------
// Vue (rendu pur : props état + actions)
// ---------------------------------------------------------------------------

export interface BurstSetupViewActions {
  readonly onFilterChange: (value: string) => void;
  readonly onSelectSet: (setId: string) => void;
  readonly onLanguageChange: (language: CardLanguage) => void;
  readonly onVariantChange: (variant: BurstSetupVariant) => void;
  readonly onConditionChange: (condition: BurstSetupCondition) => void;
  readonly onToggleWishlist: () => void;
  readonly onModeChange: (mode: BurstInputMode) => void;
  readonly onStart: () => void;
  readonly onEditLot: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}

export const BurstSetupView = ({
  state,
  actions,
}: {
  readonly state: BurstSetupState;
  readonly actions: BurstSetupViewActions;
}) => {
  const visibleSets = useMemo(() => visibleBurstSets(state), [state]);
  const config = burstSetupConfig(state);
  const selectedSet = state.sets.find((set) => set.id === state.selectedSetId) ?? null;

  if (state.step === "confirm" && state.startedConfig !== null) {
    return (
      <div
        data-testid="burst-step2"
        className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        <header className="flex items-center gap-2">
          <button
            type="button"
            data-testid="burst-back"
            aria-label={t("burst.back")}
            onClick={actions.onBack}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-pill border border-line bg-surface-1 text-primary ${focusRing}`}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <h1 className="text-lg font-bold text-primary">{t("burst.title")}</h1>
          <span className="ml-auto rounded-pill bg-surface-2 px-3 py-1 font-mono text-xs tabular-nums text-secondary">
            {t("burst.step", { current: 2, total: 2 })}
          </span>
        </header>

        <section
          aria-labelledby="burst-step2-recap"
          className="flex flex-col gap-3 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
        >
          <h2
            id="burst-step2-recap"
            className="text-xs font-semibold tracking-wide text-muted uppercase"
          >
            {t("burst.step2.recap.heading")}
          </h2>
          <p className="text-lg font-bold text-primary">
            {selectedSet?.nameFr ?? state.startedConfig.setId}
          </p>
          <ul className="flex flex-col gap-1 text-sm text-secondary">
            <li>{`${t(LANGUAGE_LABEL_KEY[state.startedConfig.language])} · ${t(VARIANT_LABEL_KEY[state.startedConfig.variant])} · ${t(CONDITION_LABEL_KEY[state.startedConfig.condition])}`}</li>
            <li>
              {t(
                state.startedConfig.removeFromWishlist ? "burst.wishlist.on" : "burst.wishlist.off",
              )}
            </li>
            <li>{t(MODE_TITLE_KEY[state.startedConfig.mode])}</li>
          </ul>
          <button
            type="button"
            data-testid="burst-edit"
            onClick={actions.onEditLot}
            className={`min-h-11 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold ${focusRing}`}
          >
            {t("burst.step2.edit")}
          </button>
        </section>

        <p className="rounded-sheet border border-line bg-surface-1 p-4 text-sm text-muted">
          {t("burst.step2.placeholder")}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="burst-setup"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4"
    >
      {/* En-tête dédié (navbar masquée sur cette vue profonde, docs/01 §1) */}
      <header className="flex items-center gap-2 pb-3">
        <button
          type="button"
          data-testid="burst-back"
          aria-label={t("burst.back")}
          onClick={actions.onBack}
          className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-pill border border-line bg-surface-1 text-primary ${focusRing}`}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="text-lg font-bold text-primary">{t("burst.title")}</h1>
        <span className="ml-auto rounded-pill bg-surface-2 px-3 py-1 font-mono text-xs tabular-nums text-secondary">
          {t("burst.step", { current: 1, total: 2 })}
        </span>
      </header>

      {/* Bloc 1 — Extension cible */}
      <section aria-labelledby="burst-sets-heading" className="flex flex-col gap-3 py-3">
        <h2
          id="burst-sets-heading"
          className="text-xs font-semibold tracking-wide text-muted uppercase"
        >
          {t("burst.sets.heading")}
        </h2>
        <input
          type="search"
          data-testid="burst-filter"
          value={state.filter}
          placeholder={t("burst.filter.placeholder")}
          aria-label={t("burst.filter.label")}
          onChange={(event) => actions.onFilterChange(event.target.value)}
          className={`min-h-11 rounded-sheet border border-line bg-surface-1 px-4 text-sm text-primary placeholder:text-muted ${focusRing}`}
        />
        {state.status === "loading" ? (
          <p data-testid="burst-sets-loading" className="py-6 text-center text-sm text-muted">
            {t("burst.sets.loading")}
          </p>
        ) : state.status === "error" ? (
          <div
            data-testid="burst-sets-error"
            className="flex flex-col items-center gap-3 rounded-sheet border border-line bg-surface-1 p-5 text-sm text-secondary"
          >
            <TriangleAlert size={20} aria-hidden="true" className="text-warning" />
            <p>{t("burst.sets.error")}</p>
            <button
              type="button"
              onClick={actions.onRetry}
              className={`min-h-11 rounded-pill border border-gold bg-gold-soft px-5 font-semibold text-gold ${focusRing}`}
            >
              <RotateCcw size={14} aria-hidden="true" className="mr-1 inline" />
              {t("burst.sets.retry")}
            </button>
          </div>
        ) : (
          <ul aria-label={t("burst.sets.heading")} className="flex flex-col gap-2">
            {visibleSets.length === 0 ? (
              <li data-testid="burst-sets-empty" className="py-6 text-center text-sm text-muted">
                {t("burst.sets.empty")}
              </li>
            ) : (
              visibleSets.map((set) => (
                <SetRow
                  key={set.id}
                  set={set}
                  selected={set.id === state.selectedSetId}
                  onSelect={() => actions.onSelectSet(set.id)}
                />
              ))
            )}
          </ul>
        )}
      </section>

      {/* Bloc 2 — Paramètres par défaut du lot */}
      <section
        aria-labelledby="burst-settings-heading"
        className="flex flex-col gap-4 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
      >
        <h2
          id="burst-settings-heading"
          className="text-xs font-semibold tracking-wide text-muted uppercase"
        >
          {t("burst.settings.heading")}
        </h2>

        <PillGroup id="burst-language-label" legend={t("burst.language.label")}>
          {BURST_SETUP_LANGUAGES.map((language) => (
            <Pill
              key={language}
              label={t(LANGUAGE_LABEL_KEY[language])}
              selected={state.language === language}
              testId={`burst-language-${language}`}
              onToggle={() => actions.onLanguageChange(language)}
            />
          ))}
        </PillGroup>

        <PillGroup id="burst-variant-label" legend={t("burst.variant.label")}>
          {BURST_SETUP_VARIANTS.map((variant) => (
            <Pill
              key={variant}
              label={t(VARIANT_LABEL_KEY[variant])}
              selected={state.variant === variant}
              testId={`burst-variant-${variant}`}
              onToggle={() => actions.onVariantChange(variant)}
            />
          ))}
        </PillGroup>
        <p className="text-xs text-muted">{t("burst.variant.autoHint")}</p>

        <PillGroup id="burst-condition-label" legend={t("burst.condition.label")}>
          {BURST_SETUP_CONDITIONS.map((condition) => (
            <Pill
              key={condition}
              label={t(CONDITION_LABEL_KEY[condition])}
              selected={state.condition === condition}
              testId={`burst-condition-${condition}`}
              onToggle={() => actions.onConditionChange(condition)}
            />
          ))}
        </PillGroup>
      </section>

      {/* Bloc 3 — Option Wishlist */}
      <section
        aria-labelledby="burst-wishlist-heading"
        className="flex items-center justify-between gap-4 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
      >
        <h2 id="burst-wishlist-heading" className="sr-only">
          {t("burst.wishlist.label")}
        </h2>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-semibold text-primary">{t("burst.wishlist.label")}</p>
          <p className="text-xs text-muted">{t("burst.wishlist.hint")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.removeFromWishlist}
          data-testid="burst-wishlist-switch"
          onClick={actions.onToggleWishlist}
          className={`relative h-6 w-10 shrink-0 rounded-pill transition-colors ${state.removeFromWishlist ? "bg-gold" : "bg-surface-2"} ${focusRing}`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-5 rounded-pill bg-canvas transition-all ${
              state.removeFromWishlist ? "left-[1.125rem]" : "left-0.5"
            }`}
          />
        </button>
      </section>

      {/* Bloc 4 — Mode de saisie */}
      <section
        aria-labelledby="burst-mode-heading"
        className="flex flex-col gap-3 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
      >
        <h2
          id="burst-mode-heading"
          className="text-xs font-semibold tracking-wide text-muted uppercase"
        >
          {t("burst.mode.label")}
        </h2>
        <div
          role="radiogroup"
          aria-labelledby="burst-mode-heading"
          className="grid grid-cols-2 gap-3"
        >
          {BURST_SETUP_MODES.map((mode) => {
            const selected = state.mode === mode;
            const Icon = mode === "grid" ? LayoutGrid : Hash;
            return (
              // biome-ignore lint/a11y/useSemanticElements: cartes radio stylées exigées par les specs (08A)
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`burst-mode-${mode}`}
                onClick={() => actions.onModeChange(mode)}
                className={`flex min-h-28 flex-col gap-1 rounded-sheet border p-4 text-left ${
                  selected ? "border-gold bg-gold-soft" : "border-line bg-surface-2"
                } ${focusRing}`}
              >
                <Icon
                  size={20}
                  aria-hidden="true"
                  className={selected ? "text-gold" : "text-secondary"}
                />
                <span className="text-sm font-bold text-primary">{t(MODE_TITLE_KEY[mode])}</span>
                <span className="text-xs text-muted">{t(MODE_HINT_KEY[mode])}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Barre d'action fixe */}
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-canvas px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-nav">
        <div className="mx-auto flex w-full max-w-md items-center gap-3">
          <p
            data-testid="burst-summary"
            className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-secondary"
          >
            {`${t(LANGUAGE_LABEL_KEY[state.language])} · ${t(VARIANT_LABEL_KEY[state.variant])} · ${t(CONDITION_LABEL_KEY[state.condition])}`}
          </p>
          <button
            type="button"
            data-testid="burst-start"
            disabled={config === null}
            onClick={actions.onStart}
            className={`min-h-11 shrink-0 rounded-pill px-6 text-sm font-bold transition-colors ${
              config === null ? "bg-surface-2 text-muted" : "bg-gold text-canvas hover:bg-gold-bar"
            } ${focusRing}`}
          >
            {t("burst.action.start")}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Conteneur (état local + chargement des extensions)
// ---------------------------------------------------------------------------

export interface BurstSetupScreenProps {
  /** `?setId=` : extension pré-sélectionnée à l'ouverture. */
  readonly initialSetId?: string | undefined;
  readonly onBack: () => void;
  /** Appelé par le CTA avec la configuration validée du lot. */
  readonly onStart: (config: BurstSetupConfig) => void;
  /** Substituable dans les tests. */
  readonly fetchSets?: typeof fetchBurstSets | undefined;
}

export const BurstSetupScreen = ({
  initialSetId,
  onBack,
  onStart,
  fetchSets,
}: BurstSetupScreenProps) => {
  const [state, dispatch] = useReducer(burstSetupReducer, initialSetId, initialBurstSetupState);
  const [retryNonce, setRetryNonce] = useState(0);
  const loadSets = fetchSets ?? fetchBurstSets;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryNonce` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    loadSets(controller.signal)
      .then((result) => {
        if (result.kind === "ok") dispatch({ type: "sets_loaded", sets: result.data.sets });
        else dispatch({ type: "sets_failed" });
      })
      .catch(() => {}); // AbortError : changement de page / démontage
    return () => controller.abort();
  }, [loadSets, retryNonce]);

  return (
    <BurstSetupView
      state={state}
      actions={{
        onFilterChange: (value) => dispatch({ type: "filter_changed", value }),
        onSelectSet: (setId) =>
          dispatch({ type: "set_selected", setId: setId === state.selectedSetId ? null : setId }),
        onLanguageChange: (language) => dispatch({ type: "language_changed", language }),
        onVariantChange: (variant) => dispatch({ type: "variant_changed", variant }),
        onConditionChange: (condition) => dispatch({ type: "condition_changed", condition }),
        onToggleWishlist: () => dispatch({ type: "wishlist_toggled" }),
        onModeChange: (mode) => dispatch({ type: "mode_changed", mode }),
        onStart: () => {
          dispatch({ type: "started" });
          const config = burstSetupConfig(state);
          if (config !== null) onStart(config);
        },
        onEditLot: () => dispatch({ type: "back_to_config" }),
        onRetry: () => setRetryNonce((nonce) => nonce + 1),
        onBack,
      }}
    />
  );
};
