import {
  CARD_CONDITION_ORDER,
  type CardCondition,
  type CardmarketAddCardListResult,
  type CardmarketExportResult,
  type CardmarketExportWarning,
  generateCardmarketAddCardList,
  generateCardmarketCsv,
  type MissingCardmarketCodeWarning,
  type MissingEnglishNameWarning,
} from "@pokevault/domain";
import { Copy, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import {
  DEFAULT_EXPORT_OPTIONS,
  toCardmarketExportEntries,
  toExportFilters,
  type WishlistEnrichedItem,
  type WishlistExportOptions,
  wishlistSetOptions,
} from "../lib/wishlist-client.ts";
import { BottomSheet } from "./BottomSheet.tsx";

// ---------------------------------------------------------------------------
// Modèle (pur : testable sans DOM)
// ---------------------------------------------------------------------------

export type ExportFormat = "csv" | "addList";
export type CopyStatus = "idle" | "done" | "error";

export interface ExportModel {
  readonly csv: CardmarketExportResult;
  readonly addList: CardmarketAddCardListResult;
}

/**
 * Génère les deux sorties (CSV et « Add Card List ») à partir de la wishlist enrichie et des
 * options d'UI, via les générateurs purs de `@pokevault/domain`. `now` fixe la date du nom de
 * fichier (déterministe en test).
 */
export const buildExportModel = (
  items: ReadonlyArray<WishlistEnrichedItem>,
  options: WishlistExportOptions,
  now: Date = new Date(),
): ExportModel => {
  const entries = toCardmarketExportEntries(items);
  const filters = toExportFilters(options);
  return {
    csv: generateCardmarketCsv(entries, filters, now),
    addList: generateCardmarketAddCardList(entries, filters),
  };
};

/** Avertissements agrégés pour l'affichage : un par extension sans code + un compteur de noms EN. */
export const summarizeWarnings = (
  warnings: ReadonlyArray<CardmarketExportWarning>,
): {
  readonly missingCodes: ReadonlyArray<MissingCardmarketCodeWarning>;
  readonly missingEnglishCount: number;
} => ({
  missingCodes: warnings.filter(
    (warning): warning is MissingCardmarketCodeWarning =>
      warning.kind === "missing_cardmarket_code",
  ),
  missingEnglishCount: warnings.filter(
    (warning): warning is MissingEnglishNameWarning => warning.kind === "missing_english_name",
  ).length,
});

const CSV_MIME = "text/csv;charset=utf-8";

/** Télécharge `content` en Blob UTF-8 sous `filename` (délai 10 s avant révocation pour iOS Safari). */
export const downloadTextFile = (filename: string, content: string): void => {
  const blob = new Blob([content], { type: CSV_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

// ---------------------------------------------------------------------------
// Briques visuelles
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;

const SCOPES: ReadonlyArray<{
  readonly id: WishlistExportOptions["scope"];
  readonly labelKey: TranslationKey;
}> = [
  { id: "all", labelKey: "cardmarketExport.scope.all" },
  { id: "high_priority", labelKey: "cardmarketExport.scope.high_priority" },
  { id: "below_threshold", labelKey: "cardmarketExport.scope.below_threshold" },
  { id: "set", labelKey: "cardmarketExport.scope.set" },
];

const LANGUAGES: ReadonlyArray<{
  readonly id: WishlistExportOptions["language"];
  readonly labelKey: TranslationKey;
}> = [
  { id: "ALL", labelKey: "cardmarketExport.language.ALL" },
  { id: "FR", labelKey: "cardmarketExport.language.FR" },
  { id: "EN", labelKey: "cardmarketExport.language.EN" },
  { id: "JP", labelKey: "cardmarketExport.language.JP" },
  { id: "ZH", labelKey: "cardmarketExport.language.ZH" },
];

const FORMATS: ReadonlyArray<{ readonly id: ExportFormat; readonly labelKey: TranslationKey }> = [
  { id: "csv", labelKey: "cardmarketExport.format.csv" },
  { id: "addList", labelKey: "cardmarketExport.format.addList" },
];

const CONDITION_LABEL_KEYS: Readonly<Record<CardCondition, TranslationKey>> = {
  M: "cardDetail.condition.M",
  NM: "cardDetail.condition.NM",
  EX: "cardDetail.condition.EX",
  GD: "cardDetail.condition.GD",
  LP: "cardDetail.condition.LP",
  PL: "cardDetail.condition.PL",
  PO: "cardDetail.condition.PO",
};

/** Choix exclusif natif (`radio` masqué visuellement : clavier et lecteurs d'écran gratuits). */
const RadioPill = ({
  name,
  value,
  checked,
  label,
  onSelect,
}: {
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) => (
  <label className="relative inline-flex">
    <input
      type="radio"
      name={name}
      value={value}
      checked={checked}
      onChange={onSelect}
      className="peer sr-only"
    />
    <span
      style={touchTarget}
      className="inline-flex cursor-pointer items-center justify-center rounded-pill border border-line bg-surface-1 px-4 text-sm font-semibold text-secondary transition-colors peer-checked:border-gold peer-checked:bg-gold-soft peer-checked:text-gold peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gold"
    >
      {label}
    </span>
  </label>
);

const selectClass = `w-full rounded-card border border-line bg-surface-1 px-3 text-sm text-primary ${focusRing}`;

// ---------------------------------------------------------------------------
// Contenu (présentation pure : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

export interface CardmarketExportActions {
  readonly onOptionsChange: (patch: Partial<WishlistExportOptions>) => void;
  readonly onFormatChange: (format: ExportFormat) => void;
  readonly onDownload: () => void;
  readonly onCopy: () => void;
}

export interface CardmarketExportContentProps {
  readonly items: ReadonlyArray<WishlistEnrichedItem>;
  readonly options: WishlistExportOptions;
  readonly format: ExportFormat;
  readonly copyStatus: CopyStatus;
  readonly model: ExportModel;
  readonly actions: CardmarketExportActions;
}

const Warnings = ({ warnings }: { readonly warnings: ReadonlyArray<CardmarketExportWarning> }) => {
  const { missingCodes, missingEnglishCount } = summarizeWarnings(warnings);
  if (missingCodes.length === 0 && missingEnglishCount === 0) return null;
  return (
    <section
      aria-labelledby="export-warnings-heading"
      data-testid="export-warnings"
      className="flex flex-col gap-1.5 rounded-card border border-warning bg-surface-2 px-3 py-2.5"
    >
      <h3 id="export-warnings-heading" className="text-sm font-semibold text-warning">
        {t("cardmarketExport.warnings.heading")}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-secondary">
        {missingCodes.map((warning) => (
          <li key={warning.setId}>
            {tPlural("cardmarketExport.warnings.missingCode", warning.count, {
              setName: warning.setNameFr,
              code: warning.fallbackCode,
            })}
          </li>
        ))}
        {missingEnglishCount > 0 ? (
          <li>{tPlural("cardmarketExport.warnings.missingEnglish", missingEnglishCount)}</li>
        ) : null}
      </ul>
    </section>
  );
};

export const CardmarketExportContent = ({
  items,
  options,
  format,
  copyStatus,
  model,
  actions,
}: CardmarketExportContentProps) => {
  const sets = wishlistSetOptions(items);
  const lineCount = format === "csv" ? model.csv.rowCount : model.addList.lineCount;
  const previewText = format === "csv" ? model.csv.content : model.addList.content;
  const empty = model.csv.rowCount === 0;
  const copyMessage =
    copyStatus === "done"
      ? t("cardmarketExport.copy.done")
      : copyStatus === "error"
        ? t("cardmarketExport.copy.error")
        : "";

  return (
    <div className="flex flex-col gap-4 pt-1">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold text-primary">
          {t("cardmarketExport.scope.label")}
        </legend>
        <div className="flex flex-wrap gap-2">
          {SCOPES.map((scope) => (
            <RadioPill
              key={scope.id}
              name="export-scope"
              value={scope.id}
              checked={options.scope === scope.id}
              label={t(scope.labelKey)}
              onSelect={() => actions.onOptionsChange({ scope: scope.id })}
            />
          ))}
        </div>
        {options.scope === "set" ? (
          <select
            aria-label={t("cardmarketExport.set.label")}
            data-testid="export-set-select"
            value={options.setId ?? sets[0]?.id ?? ""}
            onChange={(event) => actions.onOptionsChange({ setId: event.target.value })}
            style={touchTarget}
            className={selectClass}
          >
            {sets.map((set) => (
              <option key={set.id} value={set.id}>
                {t("cardmarketExport.set.option", { name: set.nameFr, count: set.count })}
              </option>
            ))}
          </select>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold text-primary">
          {t("cardmarketExport.language.label")}
        </legend>
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map((language) => (
            <RadioPill
              key={language.id}
              name="export-language"
              value={language.id}
              checked={options.language === language.id}
              label={t(language.labelKey)}
              onSelect={() => actions.onOptionsChange({ language: language.id })}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="export-condition" className="text-sm font-semibold text-primary">
          {t("cardmarketExport.condition.label")}
        </label>
        <select
          id="export-condition"
          data-testid="export-condition-select"
          value={options.minConditionOverride ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            actions.onOptionsChange({
              minConditionOverride:
                CARD_CONDITION_ORDER.find((condition) => condition === value) ?? null,
            });
          }}
          style={touchTarget}
          className={selectClass}
        >
          <option value="">{t("cardmarketExport.condition.perCard")}</option>
          {CARD_CONDITION_ORDER.map((condition) => (
            <option key={condition} value={condition}>
              {t("cardmarketExport.condition.option", {
                code: condition,
                label: t(CONDITION_LABEL_KEYS[condition]),
              })}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span id="export-foil-label" className="text-sm font-semibold text-primary">
          {t("cardmarketExport.foil.label")}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={options.foilOnly}
          aria-labelledby="export-foil-label"
          data-testid="export-foil-switch"
          onClick={() => actions.onOptionsChange({ foilOnly: !options.foilOnly })}
          style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
          className={`flex items-center justify-center rounded-pill ${focusRing}`}
        >
          <span
            aria-hidden="true"
            className={`flex h-7 w-12 items-center rounded-pill border px-0.5 transition-colors ${
              options.foilOnly ? "border-gold bg-gold-soft" : "border-line bg-surface-2"
            }`}
          >
            <span
              className={`h-5 w-5 rounded-pill transition-transform motion-reduce:transition-none ${
                options.foilOnly ? "translate-x-5 bg-gold" : "translate-x-0 bg-muted"
              }`}
            />
          </span>
        </button>
      </div>

      <Warnings warnings={model.csv.warnings} />

      <section aria-labelledby="export-preview-heading" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="export-preview-heading" className="text-sm font-semibold text-primary">
            {t("cardmarketExport.preview.heading")}
          </h3>
          <span
            data-testid="export-count"
            className="font-mono text-xs font-semibold tabular-nums text-secondary"
          >
            {tPlural("cardmarketExport.count", lineCount)}
          </span>
        </div>
        <fieldset className="flex gap-2">
          <legend className="sr-only">{t("cardmarketExport.format.label")}</legend>
          {FORMATS.map((entry) => (
            <RadioPill
              key={entry.id}
              name="export-format"
              value={entry.id}
              checked={format === entry.id}
              label={t(entry.labelKey)}
              onSelect={() => actions.onFormatChange(entry.id)}
            />
          ))}
        </fieldset>
        {empty ? (
          <p
            data-testid="export-preview-empty"
            className="rounded-card border border-dashed border-line px-3 py-6 text-center text-sm text-secondary"
          >
            {t("cardmarketExport.preview.none")}
          </p>
        ) : (
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: zone défilante : atteignable au clavier pour lire tout l'aperçu
            tabIndex={0}
            data-testid="export-preview"
            className={`max-h-48 overflow-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre text-primary ${focusRing}`}
          >
            {previewText}
          </pre>
        )}
      </section>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={actions.onDownload}
          disabled={empty}
          data-testid="export-download"
          style={touchTarget}
          className={`flex items-center justify-center gap-2 rounded-pill bg-gold-bar px-5 text-sm font-bold text-canvas transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
        >
          <Download size={16} aria-hidden="true" />
          {t("cardmarketExport.download")}
        </button>
        <button
          type="button"
          onClick={actions.onCopy}
          disabled={empty}
          data-testid="export-copy"
          style={touchTarget}
          className={`flex items-center justify-center gap-2 rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
        >
          <Copy size={16} aria-hidden="true" />
          {t("cardmarketExport.copy")}
        </button>
        <p
          role="status"
          aria-live="polite"
          data-testid="export-copy-status"
          className={`min-h-5 text-center text-xs ${
            copyStatus === "error" ? "text-danger" : "text-success-strong"
          }`}
        >
          {copyMessage}
        </p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Bottom Sheet 06C
// ---------------------------------------------------------------------------

export interface CardmarketExportSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly items: ReadonlyArray<WishlistEnrichedItem>;
}

export const CardmarketExportSheet = ({ open, onClose, items }: CardmarketExportSheetProps) => {
  const [options, setOptions] = useState<WishlistExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");

  // Le message « Copié » n'a de sens que pour l'ouverture en cours.
  useEffect(() => {
    if (open) setCopyStatus("idle");
  }, [open]);

  // Si le périmètre « Une extension » vise un set qui a disparu, on se replie sur le 1er set actif.
  const effectiveOptions = useMemo<WishlistExportOptions>(() => {
    if (options.scope !== "set") return options;
    const sets = wishlistSetOptions(items);
    if (options.setId !== null && sets.some((set) => set.id === options.setId)) return options;
    return { ...options, setId: sets[0]?.id ?? null };
  }, [items, options]);

  const model = useMemo(() => buildExportModel(items, effectiveOptions), [items, effectiveOptions]);

  const actions: CardmarketExportActions = {
    onOptionsChange: (patch) => {
      setCopyStatus("idle");
      setOptions((current) => {
        const next = { ...current, ...patch };
        // Choisir « Une extension » présélectionne la première extension de la wishlist.
        if (next.scope === "set" && next.setId === null) {
          return { ...next, setId: wishlistSetOptions(items)[0]?.id ?? null };
        }
        return next;
      });
    },
    onFormatChange: setFormat,
    onDownload: () => {
      if (model.csv.rowCount === 0) return;
      downloadTextFile(model.csv.filename, model.csv.content);
    },
    onCopy: () => {
      if (model.addList.lineCount === 0) return;
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clipboard === undefined) {
        setFormat("addList");
        setCopyStatus("error");
        return;
      }
      void clipboard.writeText(model.addList.content).then(
        () => setCopyStatus("done"),
        () => {
          setFormat("addList");
          setCopyStatus("error");
        },
      );
    },
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={t("cardmarketExport.title")}>
      {items.length === 0 ? (
        <p data-testid="export-empty" className="py-6 text-center text-sm text-secondary">
          {t("cardmarketExport.empty")}
        </p>
      ) : (
        <CardmarketExportContent
          items={items}
          options={effectiveOptions}
          format={format}
          copyStatus={copyStatus}
          model={model}
          actions={actions}
        />
      )}
    </BottomSheet>
  );
};
