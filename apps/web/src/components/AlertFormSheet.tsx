import {
  type AlertPriceField,
  type CardCondition,
  type CardLanguage,
  type CardVariant,
  DEFAULT_ALERT_COOLDOWN_HOURS,
  type PriceAlert,
} from "@pokevault/domain";
import { BellPlus } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { type TranslationKey, t } from "../i18n/index.ts";
import {
  ALERT_CONDITIONS,
  ALERT_COOLDOWN_OPTIONS,
  ALERT_LANGUAGES,
  ALERT_PRICE_FIELDS,
  ALERT_VARIANTS,
  type AlertWatchItem,
  buildThresholdPresets,
  createAlert,
  formatThresholdInput,
  parseThresholdEuros,
  referencePriceCents,
  updateAlert,
} from "../lib/alerts-client.ts";
import { defaultVariantFor, formatPriceCents } from "../lib/card-detail-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";
import { CardTile } from "./CardTile.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

/** Valeurs saisies du formulaire `07C` (le seuil reste une chaîne tant qu'il n'est pas soumis). */
export interface AlertFormValues {
  readonly thresholdRaw: string;
  readonly priceField: AlertPriceField;
  readonly minCondition: CardCondition;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly cooldownHours: number;
  readonly notifyPush: boolean;
  readonly notifyDiscord: boolean;
}

export type AlertFormError = "threshold" | "channels" | "generic" | "not-found" | null;

/** Dernier prix connu d'UN slot `(carte, langue, variante)` : base des raccourcis `-5 / -12 / -20 %`. */
export interface AlertReferencePrice {
  readonly trendCents: number | null;
  readonly lowFrCents: number | null;
}

/** Carte visée + valeurs initiales : création (depuis une fiche) ou édition (depuis l'écran). */
export interface AlertFormTarget {
  readonly mode: "create" | "edit";
  /** Identifiant de l'alerte éditée (`null` en création). */
  readonly alertId: string | null;
  readonly cardId: string;
  readonly cardName: string;
  /** Ligne secondaire (`n° 199 · 151`). */
  readonly subtitle: string | null;
  readonly imageUrl: string | null;
  readonly initial: AlertFormValues;
  /** Prix du slot `initial.language` / `initial.variant` (`null` : aucun prix connu). */
  readonly referencePrice: AlertReferencePrice | null;
}

export interface AlertFormViewState {
  readonly mode: AlertFormTarget["mode"];
  readonly cardName: string;
  readonly subtitle: string | null;
  readonly imageUrl: string | null;
  readonly values: AlertFormValues;
  /** Prix de référence du slot ET du champ sélectionnés ; `null` ⇒ raccourcis désactivés. */
  readonly referenceCents: number | null;
  readonly submitting: boolean;
  readonly error: AlertFormError;
  /** `false` : aucun accès Discord configuré (astuce affichée) ; `null`/`true` : pas d'astuce. */
  readonly discordAvailable: boolean | null;
}

export interface AlertFormViewActions {
  readonly onClose: () => void;
  readonly onChange: (patch: Partial<AlertFormValues>) => void;
  readonly onSubmit: () => void;
}

export interface AlertFormViewProps {
  readonly open: boolean;
  readonly state: AlertFormViewState;
  readonly actions: AlertFormViewActions;
}

// ---------------------------------------------------------------------------
// Valeurs initiales & helpers purs
// ---------------------------------------------------------------------------

export const DEFAULT_ALERT_FORM_VALUES: AlertFormValues = {
  thresholdRaw: "",
  priceField: "low_fr",
  minCondition: "NM",
  language: "FR",
  variant: "normal",
  cooldownHours: DEFAULT_ALERT_COOLDOWN_HOURS,
  notifyPush: true,
  notifyDiscord: false,
};

/** Sous-titre `n° 199 · 151` d'une carte. */
export const alertCardSubtitle = (localId: string, setName: string | null): string =>
  setName === null
    ? t("alerts.item.number", { number: localId })
    : `${t("alerts.item.number", { number: localId })} · ${setName}`;

/** Cible de CRÉATION depuis une fiche carte, pré-remplie avec la carte et son prix courant. */
export const createAlertTarget = (input: {
  readonly cardId: string;
  readonly cardName: string;
  readonly subtitle: string | null;
  readonly imageUrl: string | null;
  readonly availableVariants: ReadonlyArray<CardVariant>;
  readonly price: AlertReferencePrice | null;
}): AlertFormTarget => ({
  mode: "create",
  alertId: null,
  cardId: input.cardId,
  cardName: input.cardName,
  subtitle: input.subtitle,
  imageUrl: input.imageUrl,
  initial: { ...DEFAULT_ALERT_FORM_VALUES, variant: defaultVariantFor(input.availableVariants) },
  referencePrice:
    input.price === null
      ? null
      : { trendCents: input.price.trendCents, lowFrCents: input.price.lowFrCents },
});

/** Cible d'ÉDITION d'une alerte existante (prix du slot de l'alerte). */
export const editAlertTarget = (alert: AlertWatchItem): AlertFormTarget => ({
  mode: "edit",
  alertId: alert.id,
  cardId: alert.cardId,
  cardName: alert.cardName,
  subtitle: alertCardSubtitle(alert.localId, alert.setName),
  imageUrl: alert.imageUrl,
  initial: {
    thresholdRaw: formatThresholdInput(alert.thresholdCents),
    priceField: alert.priceField,
    minCondition: alert.minCondition,
    language: alert.language,
    variant: alert.variant,
    cooldownHours: alert.cooldownHours,
    notifyPush: alert.notifyPush,
    notifyDiscord: alert.notifyDiscord,
  },
  referencePrice:
    alert.priceSource === "cardmarket"
      ? { trendCents: alert.trendCents, lowFrCents: alert.lowFrCents }
      : null,
});

/**
 * Prix de référence des raccourcis : connu uniquement pour le slot `(langue, variante)` d'origine
 * (le dernier prix d'un autre slot est inconnu côté client) et pour le champ sélectionné.
 */
export const formReferenceCents = (
  target: AlertFormTarget,
  values: AlertFormValues,
): number | null =>
  values.language === target.initial.language && values.variant === target.initial.variant
    ? referencePriceCents(target.referencePrice, values.priceField)
    : null;

export type AlertFormValidation =
  | { readonly ok: true; readonly thresholdCents: number }
  | { readonly ok: false; readonly error: "threshold" | "channels" };

/** Seuil `> 0` en centimes entiers ET au moins un canal (une alerte sans canal ne notifie jamais). */
export const validateAlertForm = (values: AlertFormValues): AlertFormValidation => {
  const parsed = parseThresholdEuros(values.thresholdRaw);
  if (!parsed.ok) return { ok: false, error: "threshold" };
  if (!values.notifyPush && !values.notifyDiscord) return { ok: false, error: "channels" };
  return { ok: true, thresholdCents: parsed.cents };
};

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

const CONDITION_LABELS: Readonly<Record<CardCondition, TranslationKey>> = {
  M: "cardDetail.condition.M",
  NM: "cardDetail.condition.NM",
  EX: "cardDetail.condition.EX",
  GD: "cardDetail.condition.GD",
  LP: "cardDetail.condition.LP",
  PL: "cardDetail.condition.PL",
  PO: "cardDetail.condition.PO",
};

const PRICE_FIELD_LABELS: Readonly<Record<AlertPriceField, TranslationKey>> = {
  low_fr: "alerts.form.priceField.low_fr",
  trend: "alerts.form.priceField.trend",
};

/** Libellé court d'un champ de prix (`Plus bas FR` / `Tendance`). */
export const priceFieldLabel = (field: AlertPriceField): string => t(PRICE_FIELD_LABELS[field]);

/** Interrupteur ON/OFF (`role="switch"`, cible tactile ≥ 44 px, tokens uniquement). */
export const AlertSwitch = ({
  checked,
  label,
  onChange,
  disabled = false,
  testId,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    data-testid={testId}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    style={touchSquare}
    className={`group inline-flex shrink-0 items-center justify-center rounded-pill disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
  >
    <span
      aria-hidden="true"
      className={`relative h-6 w-11 rounded-pill border transition-colors motion-reduce:transition-none ${
        checked ? "border-success bg-success" : "border-line bg-surface-2"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4.5 rounded-pill transition-transform motion-reduce:transition-none ${
          checked ? "translate-x-5 bg-canvas" : "bg-muted"
        }`}
      />
    </span>
  </button>
);

const SectionLabel = ({ id, children }: { readonly id: string; readonly children: ReactNode }) => (
  <span id={id} className="text-xs font-semibold text-secondary">
    {children}
  </span>
);

/** Choix unique en pilules (`radiogroup` / `radio`, cible ≥ 44 px). */
const Segmented = <T extends string | number>({
  labelId,
  testId,
  options,
  value,
  onSelect,
}: {
  readonly labelId: string;
  readonly testId: string;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly text: string;
    readonly aria?: string;
  }>;
  readonly value: T;
  readonly onSelect: (value: T) => void;
}) => (
  <div
    role="radiogroup"
    aria-labelledby={labelId}
    data-testid={testId}
    className="flex flex-wrap gap-2"
  >
    {options.map((option) => {
      const checked = option.value === value;
      return (
        // biome-ignore lint/a11y/useSemanticElements: pilules tactiles (cible ≥ 44 px) ; `radiogroup` + `role="radio"` + `aria-checked` portent la sémantique
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={checked}
          aria-label={option.aria}
          data-value={String(option.value)}
          onClick={() => onSelect(option.value)}
          style={touchTarget}
          className={`inline-flex min-w-11 items-center justify-center rounded-pill border px-3 text-sm font-semibold transition-colors ${focusRing} ${
            checked
              ? "border-gold bg-gold-soft text-gold"
              : "border-line bg-surface-1 text-secondary hover:text-primary"
          }`}
        >
          {option.text}
        </button>
      );
    })}
  </div>
);

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

const ERROR_KEYS: Readonly<Record<Exclude<AlertFormError, null>, TranslationKey>> = {
  threshold: "alerts.form.threshold.invalid",
  channels: "alerts.form.error.channels",
  generic: "alerts.form.error.generic",
  "not-found": "alerts.form.error.notFound",
};

/**
 * Bottom Sheet `07C · Créer / Modifier une alerte` (vue pure) : prix cible en euros avec
 * raccourcis `-5 / -12 / -20 %`, source du prix, état minimum, langue + variante, cooldown
 * anti-spam et canaux Push PWA / Discord. Tokens uniquement, chiffres `font-mono tabular-nums`.
 */
export const AlertFormView = ({ open, state, actions }: AlertFormViewProps) => {
  const uid = useId();
  const { values } = state;
  const presets = buildThresholdPresets(state.referenceCents);
  const parsedThreshold = parseThresholdEuros(values.thresholdRaw);
  const thresholdInvalid = state.error === "threshold";
  const inputId = `${uid}-threshold`;
  const errorId = `${uid}-error`;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    actions.onSubmit();
  };

  return (
    <BottomSheet
      open={open}
      onClose={actions.onClose}
      title={t(state.mode === "create" ? "alerts.form.title.create" : "alerts.form.title.edit")}
    >
      <form
        onSubmit={onSubmit}
        noValidate
        data-testid="alert-form"
        data-mode={state.mode}
        className="flex flex-col gap-4"
      >
        <div className="flex items-center gap-3 rounded-sheet border border-line bg-surface-1 p-3 shadow-card">
          <div className="w-12 shrink-0">
            <CardTile
              name={state.cardName}
              label={state.cardName}
              {...(state.imageUrl === null ? {} : { imageUrl: state.imageUrl })}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p data-testid="alert-form-card" className="truncate text-sm font-bold text-primary">
              {state.cardName}
            </p>
            {state.subtitle === null ? null : (
              <p className="truncate font-mono text-xs tabular-nums text-secondary">
                {state.subtitle}
              </p>
            )}
            {state.referenceCents === null ? (
              <p data-testid="alert-form-reference-none" className="text-xs text-muted">
                {t("alerts.form.reference.none")}
              </p>
            ) : (
              <p
                data-testid="alert-form-reference"
                className="font-mono text-xs font-semibold tabular-nums text-primary"
              >
                {t("alerts.form.reference", {
                  price: formatPriceCents(state.referenceCents) ?? "",
                })}
              </p>
            )}
          </div>
        </div>

        {/* Source du prix */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel id={`${uid}-field`}>{t("alerts.form.priceField.label")}</SectionLabel>
          <Segmented
            labelId={`${uid}-field`}
            testId="alert-form-price-field"
            options={ALERT_PRICE_FIELDS.map((field) => ({
              value: field,
              text: priceFieldLabel(field),
            }))}
            value={values.priceField}
            onSelect={(priceField) => actions.onChange({ priceField })}
          />
        </div>

        {/* Prix cible + raccourcis */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-xs font-semibold text-secondary">
            {t("alerts.form.threshold.label")}
          </label>
          <input
            id={inputId}
            data-testid="alert-form-threshold"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={values.thresholdRaw}
            placeholder={t("alerts.form.threshold.placeholder")}
            aria-invalid={thresholdInvalid}
            aria-describedby={state.error === null ? undefined : errorId}
            onChange={(event) => actions.onChange({ thresholdRaw: event.target.value })}
            style={touchTarget}
            className={`w-full rounded-card border bg-surface-1 px-3 font-mono text-base tabular-nums text-primary ${focusRing} ${
              thresholdInvalid ? "border-danger" : "border-line"
            }`}
          />
          <p className="text-[11px] text-muted">{t("alerts.form.threshold.hint")}</p>
          <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 text-xs font-semibold text-secondary">
              {t("alerts.form.presets.label")}
            </legend>
            <div data-testid="alert-form-presets" className="flex flex-wrap gap-2">
              {presets.map((preset) => {
                const cents = preset.thresholdCents;
                const selected =
                  cents !== null && parsedThreshold.ok && parsedThreshold.cents === cents;
                return (
                  <button
                    key={preset.percent}
                    type="button"
                    data-testid={`alert-form-preset-${preset.percent}`}
                    disabled={cents === null}
                    aria-pressed={selected}
                    aria-label={
                      cents === null
                        ? t("alerts.form.preset", { percent: preset.percent })
                        : t("alerts.form.preset.aria", {
                            percent: preset.percent,
                            price: formatPriceCents(cents) ?? "",
                          })
                    }
                    onClick={() => {
                      if (cents !== null)
                        actions.onChange({ thresholdRaw: formatThresholdInput(cents) });
                    }}
                    style={touchTarget}
                    className={`inline-flex flex-col items-center justify-center rounded-pill border px-4 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${focusRing} ${
                      selected
                        ? "border-gold bg-gold-soft text-gold"
                        : "border-line bg-surface-1 text-secondary hover:text-primary"
                    }`}
                  >
                    <span className="font-mono text-sm font-semibold tabular-nums">
                      {t("alerts.form.preset", { percent: preset.percent })}
                    </span>
                    {cents === null ? null : (
                      <span className="font-mono text-[10px] tabular-nums text-muted">
                        {formatPriceCents(cents)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        {/* État minimum */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel id={`${uid}-condition`}>{t("alerts.form.condition.label")}</SectionLabel>
          <Segmented<CardCondition>
            labelId={`${uid}-condition`}
            testId="alert-form-condition"
            options={ALERT_CONDITIONS.map((condition) => ({
              value: condition,
              text: condition,
              aria: t(CONDITION_LABELS[condition]),
            }))}
            value={values.minCondition}
            onSelect={(minCondition) => actions.onChange({ minCondition })}
          />
        </div>

        {/* Langue + variante */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel id={`${uid}-language`}>{t("alerts.form.language.label")}</SectionLabel>
          <Segmented<CardLanguage>
            labelId={`${uid}-language`}
            testId="alert-form-language"
            options={ALERT_LANGUAGES.map((language) => ({
              value: language,
              text: language,
              aria: t(LANGUAGE_LABELS[language]),
            }))}
            value={values.language}
            onSelect={(language) => actions.onChange({ language })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <SectionLabel id={`${uid}-variant`}>{t("alerts.form.variant.label")}</SectionLabel>
          <Segmented<CardVariant>
            labelId={`${uid}-variant`}
            testId="alert-form-variant"
            options={ALERT_VARIANTS.map((variant) => ({
              value: variant,
              text: t(VARIANT_LABELS[variant]),
            }))}
            value={values.variant}
            onSelect={(variant) => actions.onChange({ variant })}
          />
        </div>

        {/* Cooldown anti-spam */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel id={`${uid}-cooldown`}>{t("alerts.form.cooldown.label")}</SectionLabel>
          <Segmented<number>
            labelId={`${uid}-cooldown`}
            testId="alert-form-cooldown"
            options={cooldownOptionsFor(values.cooldownHours).map((hours) => ({
              value: hours,
              text: t("alerts.form.cooldown.option", { hours }),
            }))}
            value={values.cooldownHours}
            onSelect={(cooldownHours) => actions.onChange({ cooldownHours })}
          />
          <p className="text-[11px] text-muted">{t("alerts.form.cooldown.hint")}</p>
        </div>

        {/* Canaux */}
        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          <legend className="mb-1 text-xs font-semibold text-secondary">
            {t("alerts.form.channels.label")}
          </legend>
          <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface-1 pl-3">
            <span className="text-sm font-semibold text-primary">
              {t("alerts.form.channel.push")}
            </span>
            <AlertSwitch
              testId="alert-form-notify-push"
              checked={values.notifyPush}
              label={t("alerts.form.channel.push")}
              onChange={(notifyPush) => actions.onChange({ notifyPush })}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface-1 pl-3">
            <span className="text-sm font-semibold text-primary">
              {t("alerts.form.channel.discord")}
            </span>
            <AlertSwitch
              testId="alert-form-notify-discord"
              checked={values.notifyDiscord}
              label={t("alerts.form.channel.discord")}
              onChange={(notifyDiscord) => actions.onChange({ notifyDiscord })}
            />
          </div>
          {state.discordAvailable === false && values.notifyDiscord ? (
            <p data-testid="alert-form-discord-hint" className="text-[11px] text-warning">
              {t("alerts.form.channels.discordUnavailable")}
            </p>
          ) : null}
        </fieldset>

        {state.error === null ? null : (
          <p
            id={errorId}
            role="alert"
            data-testid="alert-form-error"
            data-error={state.error}
            className="text-xs text-danger"
          >
            {t(ERROR_KEYS[state.error])}
          </p>
        )}

        <button
          type="submit"
          data-testid="alert-form-submit"
          disabled={state.submitting}
          aria-busy={state.submitting}
          style={touchTarget}
          className={`inline-flex items-center justify-center gap-2 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
        >
          <BellPlus size={16} aria-hidden="true" />
          {state.submitting
            ? t("alerts.form.submitting")
            : t(state.mode === "create" ? "alerts.form.submit.create" : "alerts.form.submit.edit")}
        </button>
      </form>
    </BottomSheet>
  );
};

/** Cooldowns proposés ; une valeur existante hors liste (API : `1..168 h`) reste sélectionnable. */
export const cooldownOptionsFor = (current: number): ReadonlyArray<number> =>
  ALERT_COOLDOWN_OPTIONS.includes(current)
    ? ALERT_COOLDOWN_OPTIONS
    : [...ALERT_COOLDOWN_OPTIONS, current].sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Conteneur : état du formulaire + appels API
// ---------------------------------------------------------------------------

export interface AlertFormSheetProps {
  /** Cible à éditer / créer ; `null` ferme la feuille. */
  readonly target: AlertFormTarget | null;
  /** `false` : Discord non configuré (astuce) ; `null` : inconnu (pas d'astuce). */
  readonly discordAvailable?: boolean | null | undefined;
  readonly onClose: () => void;
  /** Alerte créée / mise à jour (la liste appelante se recharge). */
  readonly onSaved: (alert: PriceAlert, mode: AlertFormTarget["mode"]) => void;
  /** Session expirée : par défaut, redirection vers `/login` en conservant la page courante. */
  readonly onUnauthorized?: (() => void) | undefined;
}

const redirectToLogin = (): void => {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?${new URLSearchParams({ redirect: here }).toString()}`);
};

/**
 * Bottom Sheet `07C` (conteneur) : `POST /api/alerts` (création) ou `PATCH /api/alerts/$id`
 * (édition). Le formulaire est réinitialisé à chaque ouverture / changement de cible.
 */
export const AlertFormSheet = ({
  target,
  discordAvailable = null,
  onClose,
  onSaved,
  onUnauthorized,
}: AlertFormSheetProps) => {
  const [values, setValues] = useState<AlertFormValues>(
    target?.initial ?? DEFAULT_ALERT_FORM_VALUES,
  );
  const [error, setError] = useState<AlertFormError>(null);
  const [submitting, setSubmitting] = useState(false);
  const targetKey = target === null ? null : `${target.mode}:${target.cardId}:${target.alertId}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: réinitialisé uniquement quand la cible change (clé stable)
  useEffect(() => {
    setValues(target?.initial ?? DEFAULT_ALERT_FORM_VALUES);
    setError(null);
    setSubmitting(false);
  }, [targetKey]);

  if (target === null) return null;

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const validation = validateAlertForm(values);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    const body = {
      language: values.language,
      variant: values.variant,
      minCondition: values.minCondition,
      priceField: values.priceField,
      thresholdCents: validation.thresholdCents,
      notifyPush: values.notifyPush,
      notifyDiscord: values.notifyDiscord,
      cooldownHours: values.cooldownHours,
    };
    const result =
      target.mode === "create" || target.alertId === null
        ? await createAlert({ cardId: target.cardId, ...body })
        : await updateAlert(target.alertId, body);
    setSubmitting(false);
    if (result.kind === "ok") {
      onSaved(result.body, target.mode);
      return;
    }
    if (result.kind === "unauthorized") {
      (onUnauthorized ?? redirectToLogin)();
      return;
    }
    setError(result.kind === "not-found" ? "not-found" : "generic");
  };

  return (
    <AlertFormView
      open
      state={{
        mode: target.mode,
        cardName: target.cardName,
        subtitle: target.subtitle,
        imageUrl: target.imageUrl,
        values,
        referenceCents: formReferenceCents(target, values),
        submitting,
        error,
        discordAvailable,
      }}
      actions={{
        onClose,
        onChange: (patch) => {
          setError(null);
          setValues((current) => ({ ...current, ...patch }));
        },
        onSubmit: () => void submit(),
      }}
    />
  );
};
