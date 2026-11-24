/**
 * Mode Pavé numéros `#` de la saisie rafale (`08C`) : afficheur du numéro,
 * aperçu instantané de la carte correspondante (miniature 63/88, nom, numéro,
 * rareté, `Nouvelle` / `Déjà ×K`), override rapide de variante, actions
 * `+1` / `×2` et pavé numérique custom mobile (`1`–`9`, `Effacer`, `0`, `⌫`).
 * Le clavier physique (chiffres, lettres, `Backspace`, `Enter`, `Escape`) est
 * câblé par `BurstSessionScreen` via `burstKeypadKeyAction`.
 *
 * Rendu pur (props → JSX) ; état et ruban dans `BurstSessionScreen`.
 *
 * Réf. : docs/01 §6, docs/05, docs/design-brief.md.
 */

import { type CardVariant, tcgdexCardImageUrl } from "@pokevault/domain";
import { useMemo } from "react";
import { t } from "../i18n/index.ts";
import {
  type BurstCatalogCard,
  burstVariantChoices,
  matchBurstCardNumber,
  resolveBurstVariantForCard,
} from "../lib/burst-client.ts";
import { variantLabel } from "./BurstGridMode.tsx";
import { CardTile } from "./CardTile.tsx";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const DIGIT_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

export interface BurstKeypadModeProps {
  readonly cards: ReadonlyArray<BurstCatalogCard>;
  /** Numéro saisi (`25`, `025`, `SV001`…), sans `#`. */
  readonly input: string;
  /** Variante choisie sur la carte en aperçu ; `null` = variante courante du lot. */
  readonly variantOverride: CardVariant | null;
  /** Variante courante du lot (pill `Variante ▾`). */
  readonly currentVariant: CardVariant;
  readonly batchByCard: ReadonlyMap<string, number>;
  readonly onChar: (char: string) => void;
  readonly onBackspace: () => void;
  readonly onClear: () => void;
  readonly onVariantOverride: (variant: CardVariant) => void;
  readonly onAdd: (quantity: 1 | 2) => void;
}

const keyClass = `grid min-h-14 place-items-center rounded-sheet border border-line bg-surface-1 font-mono text-xl font-semibold tabular-nums text-primary transition-colors active:bg-surface-2 ${focusRing}`;

export const BurstKeypadMode = ({
  cards,
  input,
  variantOverride,
  currentVariant,
  batchByCard,
  onChar,
  onBackspace,
  onClear,
  onVariantOverride,
  onAdd,
}: BurstKeypadModeProps) => {
  const match = useMemo(() => matchBurstCardNumber(cards, input), [cards, input]);
  const card = match.kind === "match" ? match.card : null;
  const batchQuantity = card === null ? 0 : (batchByCard.get(card.id) ?? 0);
  const selectedVariant =
    card === null
      ? null
      : (variantOverride ?? resolveBurstVariantForCard(card, currentVariant, false).variant);

  return (
    <section
      data-testid="burst-keypad"
      aria-label={t("burst.session.mode.keypad")}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-3 pb-4"
    >
      <output
        data-testid="burst-keypad-display"
        aria-label={t("burst.keypad.display.label")}
        className="block rounded-sheet border border-line bg-surface-1 px-4 py-2 text-center font-mono text-3xl font-bold tabular-nums text-primary"
      >
        {input === "" ? (
          <span className="text-base font-medium text-muted">
            {t("burst.keypad.display.empty")}
          </span>
        ) : (
          `#${input}`
        )}
      </output>

      <div
        data-testid="burst-keypad-preview"
        aria-live="polite"
        className="flex min-h-[7.5rem] items-center gap-3 rounded-sheet border border-line bg-surface-1 p-3"
      >
        {match.kind === "empty" ? (
          <p className="w-full text-center text-sm text-muted">{t("burst.keypad.preview.hint")}</p>
        ) : match.kind === "none" ? (
          <p
            data-testid="burst-keypad-none"
            className="w-full text-center text-sm font-semibold text-secondary"
          >
            {t("burst.keypad.preview.none", { number: match.query })}
          </p>
        ) : (
          <>
            <div className="w-20 shrink-0" data-testid="burst-keypad-thumb">
              <CardTile
                name={match.card.nameFr}
                label={match.card.nameFr}
                imageUrl={tcgdexCardImageUrl(match.card.imageBaseUrl, "low")}
                priority
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p
                data-testid="burst-keypad-name"
                className="truncate text-base font-bold text-primary"
              >
                {match.card.nameFr}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs tabular-nums text-secondary">
                <span>{t("burst.keypad.preview.number", { localId: match.card.localId })}</span>
                {match.card.rarity === null ? null : (
                  <span className="font-sans">{match.card.rarity}</span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {match.card.ownedQuantity === 0 ? (
                  <span
                    data-testid="burst-keypad-status"
                    data-status="new"
                    className="rounded-md bg-success px-2 py-0.5 text-xs font-bold text-canvas"
                  >
                    {t("burst.keypad.preview.new")}
                  </span>
                ) : (
                  <span
                    data-testid="burst-keypad-status"
                    data-status="owned"
                    className="rounded-md border border-gold bg-gold-soft px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-gold"
                  >
                    {t("burst.keypad.preview.owned", { count: match.card.ownedQuantity })}
                  </span>
                )}
                {batchQuantity > 0 ? (
                  <span
                    data-testid="burst-keypad-inbatch"
                    className="font-mono text-xs font-semibold tabular-nums text-primary"
                  >
                    {t("burst.keypad.preview.inBatch", { count: batchQuantity })}
                  </span>
                ) : null}
              </div>
              {match.quality === "prefix" ? (
                <p className="text-[11px] text-muted">{t("burst.keypad.preview.prefix")}</p>
              ) : null}
            </div>
          </>
        )}
      </div>

      {card !== null ? (
        <fieldset
          data-testid="burst-keypad-variants"
          className="flex flex-col gap-1.5"
          aria-label={t("burst.keypad.variant.label")}
        >
          <legend className="sr-only">{t("burst.keypad.variant.label")}</legend>
          <div className="flex flex-wrap gap-2">
            {burstVariantChoices(card).map((variant) => {
              const selected = selectedVariant === variant;
              return (
                <button
                  key={variant}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`burst-keypad-variant-${variant}`}
                  onClick={() => onVariantOverride(variant)}
                  className={`min-h-11 rounded-pill border px-4 text-sm font-semibold transition-colors ${
                    selected
                      ? "border-gold bg-gold-soft text-gold"
                      : "border-line bg-surface-1 text-secondary hover:bg-surface-2"
                  } ${focusRing}`}
                >
                  {variantLabel(variant)}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          data-testid="burst-keypad-add"
          data-burst-keypad=""
          disabled={card === null}
          aria-label={t("burst.keypad.add.label", { name: card?.nameFr ?? "" })}
          onClick={() => onAdd(1)}
          className={`min-h-12 rounded-pill font-mono text-lg font-bold tabular-nums transition-colors ${
            card === null ? "bg-surface-2 text-muted" : "bg-gold text-canvas hover:bg-gold-bar"
          } ${focusRing}`}
        >
          {t("burst.keypad.add.text")}
        </button>
        <button
          type="button"
          data-testid="burst-keypad-double"
          data-burst-keypad=""
          disabled={card === null}
          aria-label={t("burst.keypad.double.label", { name: card?.nameFr ?? "" })}
          onClick={() => onAdd(2)}
          className={`min-h-12 rounded-pill border font-mono text-lg font-bold tabular-nums transition-colors ${
            card === null
              ? "border-line bg-surface-2 text-muted"
              : "border-gold bg-gold-soft text-gold"
          } ${focusRing}`}
        >
          {t("burst.keypad.double.text")}
        </button>
      </div>

      <fieldset className="m-0 grid min-w-0 grid-cols-3 gap-2 border-0 p-0">
        <legend className="sr-only">{t("burst.keypad.pad.label")}</legend>
        {DIGIT_ROWS.flat().map((digit) => (
          <button
            key={digit}
            type="button"
            data-testid={`burst-key-${digit}`}
            data-burst-keypad=""
            onClick={() => onChar(digit)}
            className={keyClass}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          data-testid="burst-key-clear"
          data-burst-keypad=""
          onClick={onClear}
          className={`${keyClass} font-sans text-sm`}
        >
          {t("burst.keypad.key.clear")}
        </button>
        <button
          type="button"
          data-testid="burst-key-0"
          data-burst-keypad=""
          onClick={() => onChar("0")}
          className={keyClass}
        >
          0
        </button>
        <button
          type="button"
          data-testid="burst-key-backspace"
          data-burst-keypad=""
          aria-label={t("burst.keypad.key.backspace")}
          onClick={onBackspace}
          className={keyClass}
        >
          <span aria-hidden="true">{t("burst.keypad.key.backspaceSymbol")}</span>
        </button>
      </fieldset>
    </section>
  );
};
