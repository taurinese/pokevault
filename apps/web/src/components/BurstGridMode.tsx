/**
 * Mode Grille tactile de la saisie rafale (`08B` Dark · `08D` Light) :
 * grille 3 colonnes virtualisée (ratio 63/88, miniatures `low.webp`),
 * **1 tap = +1** sur la tuile, bouton `−` dès qu'une carte est dans le lot,
 * bordure verte (nouvelle) ou dorée (doublon) + badge `+N` en monospace.
 *
 * Rendu pur (props → JSX) : l'état du lot vit dans `BurstSessionScreen`.
 * Aucune couleur hex brute : uniquement les tokens Dark / Light.
 *
 * Réf. : docs/01 §6, docs/05 (perf mobile), docs/design-brief.md.
 */

import { type CardVariant, tcgdexCardImageUrl } from "@pokevault/domain";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Minus, SearchX } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { t, tPlural } from "../i18n/index.ts";
import { chunkIntoRows } from "../lib/binder-grid-client.ts";
import {
  type BurstCardStatus,
  type BurstCatalogCard,
  burstCardStatus,
  filterBurstCards,
  resolveBurstVariantForCard,
} from "../lib/burst-client.ts";
import { CardTile } from "./CardTile.tsx";

export const BURST_GRID_COLUMNS = 3;
/** Hauteur estimée d'une rangée (carte 63/88 + pied) avant mesure réelle. */
const ESTIMATED_ROW_HEIGHT_PX = 210;
/** Rangées rendues en flux normal côté serveur / avant montage (repli SSR propre). */
const SSR_FALLBACK_ROWS = 6;
/** `priority` (chargement eager) sur les 9 premières cartes. */
const PRIORITY_CARD_COUNT = 9;

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/** Libellé i18n d'une variante (toutes celles du schéma). */
export const variantLabel = (variant: CardVariant): string => t(`burst.variant.${variant}`);

const BORDER_BY_STATUS: Record<BurstCardStatus, string> = {
  none: "border-transparent",
  new: "border-success",
  duplicate: "border-gold",
};

const COUNT_BADGE_BY_STATUS: Record<BurstCardStatus, string> = {
  none: "",
  new: "bg-success text-canvas",
  duplicate: "bg-gold text-canvas",
};

export interface BurstGridTileProps {
  readonly card: BurstCatalogCard;
  /** Exemplaires de cette carte dans le lot (toutes lignes confondues). */
  readonly batchQuantity: number;
  /** Variante réellement enregistrée si la variante courante est ajustée, sinon `null`. */
  readonly adjustedVariant: CardVariant | null;
  readonly priority: boolean;
  readonly onAdd: (cardId: string) => void;
  readonly onRemove: (cardId: string) => void;
}

/**
 * Tuile interactive. Deux boutons frères (jamais imbriqués) : la tuile (`+1`)
 * et le `−` en haut à gauche (cible tactile 44px, ne déclenche pas le `+1`).
 */
export const BurstGridTile = memo(
  ({ card, batchQuantity, adjustedVariant, priority, onAdd, onRemove }: BurstGridTileProps) => {
    const status = burstCardStatus(card.ownedQuantity, batchQuantity);
    const addLabel = t("burst.grid.card.add", { name: card.nameFr, localId: card.localId });
    const ariaLabel =
      status === "none"
        ? addLabel
        : `${addLabel} — ${tPlural("burst.grid.card.inBatch", batchQuantity)} — ${t(
            status === "new" ? "burst.grid.card.new" : "burst.grid.card.duplicate",
          )}`;
    return (
      <div className="relative min-w-0" data-testid="burst-card-wrap">
        <button
          type="button"
          data-testid="burst-card"
          data-card-id={card.id}
          data-status={status}
          aria-label={ariaLabel}
          onClick={() => onAdd(card.id)}
          className={`flex w-full min-w-0 flex-col gap-1 rounded-card text-left ${focusRing}`}
        >
          <span
            className={`relative block w-full rounded-card border-2 transition-colors ${BORDER_BY_STATUS[status]}`}
          >
            <CardTile
              name={card.nameFr}
              label={card.nameFr}
              imageUrl={tcgdexCardImageUrl(card.imageBaseUrl, "low")}
              priority={priority}
            />
            {status !== "none" ? (
              <span
                aria-hidden="true"
                data-testid="burst-badge-count"
                className={`absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs font-bold tabular-nums ${COUNT_BADGE_BY_STATUS[status]}`}
              >
                +{batchQuantity}
              </span>
            ) : null}
            {status === "new" ? (
              <span
                aria-hidden="true"
                data-testid="burst-badge-new"
                className="absolute bottom-1.5 left-1.5 rounded-md bg-success px-1.5 py-0.5 text-[10px] font-bold text-canvas uppercase"
              >
                {t("burst.grid.card.new")}
              </span>
            ) : null}
            {adjustedVariant !== null ? (
              <span
                aria-hidden="true"
                data-testid="burst-badge-auto"
                title={t("burst.grid.card.autoVariant", { variant: variantLabel(adjustedVariant) })}
                className="absolute right-1.5 bottom-1.5 rounded-md border border-line bg-surface-1/90 px-1.5 py-0.5 text-[10px] font-semibold text-secondary"
              >
                {variantLabel(adjustedVariant)}
              </span>
            ) : null}
          </span>
          <span className="truncate font-mono text-[11px] tabular-nums text-muted">
            #{card.localId}
          </span>
          <span className="truncate text-xs font-semibold text-primary">{card.nameFr}</span>
        </button>
        {batchQuantity > 0 ? (
          <button
            type="button"
            data-testid="burst-card-minus"
            aria-label={t("burst.grid.card.minus", { name: card.nameFr })}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(card.id);
            }}
            className={`absolute top-0 left-0 grid min-h-11 min-w-11 place-items-center ${focusRing}`}
          >
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-pill border border-line bg-surface-1/95 text-primary shadow-card"
            >
              <Minus size={16} />
            </span>
          </button>
        ) : null}
      </div>
    );
  },
);
BurstGridTile.displayName = "BurstGridTile";

export interface BurstGridModeProps {
  readonly cards: ReadonlyArray<BurstCatalogCard>;
  /** `cardId → exemplaires dans le lot`. */
  readonly batchByCard: ReadonlyMap<string, number>;
  /** Variante courante du lot (pill `Variante ▾`), pour signaler un ajustement automatique. */
  readonly currentVariant: CardVariant;
  readonly onAdd: (cardId: string) => void;
  readonly onRemove: (cardId: string) => void;
}

/** Grille 3 colonnes virtualisée par rangée (`@tanstack/react-virtual`, `gap: 10`). */
export const BurstGridMode = ({
  cards,
  batchByCard,
  currentVariant,
  onAdd,
  onRemove,
}: BurstGridModeProps) => {
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLElement>(null);
  const visibleCards = useMemo(() => filterBurstCards(cards, query), [cards, query]);
  const rows = useMemo(() => chunkIntoRows(visibleCards, BURST_GRID_COLUMNS), [visibleCards]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    // Cohérent avec `gap-2.5` (10 px) entre les colonnes et dans le repli SSR.
    gap: 10,
    overscan: 4,
  });
  const virtualRows = virtualizer.getVirtualItems();
  // Repli SSR / avant montage : premières rangées en flux normal ; le premier
  // rendu client est identique (aucun item virtuel) → pas d'erreur d'hydratation.
  const useFallback = virtualRows.length === 0;

  const adjustedFor = (card: BurstCatalogCard): CardVariant | null => {
    const resolution = resolveBurstVariantForCard(card, currentVariant, false);
    return resolution.adjusted ? resolution.variant : null;
  };

  const renderRow = (row: ReadonlyArray<BurstCatalogCard>, rowIndex: number) =>
    row.map((card, cardIndex) => (
      <BurstGridTile
        key={card.id}
        card={card}
        batchQuantity={batchByCard.get(card.id) ?? 0}
        adjustedVariant={adjustedFor(card)}
        priority={rowIndex * BURST_GRID_COLUMNS + cardIndex < PRIORITY_CARD_COUNT}
        onAdd={onAdd}
        onRemove={onRemove}
      />
    ));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pt-3 pb-3">
        <input
          type="search"
          data-testid="burst-grid-search"
          value={query}
          placeholder={t("burst.grid.search.placeholder")}
          aria-label={t("burst.grid.search.label")}
          onChange={(event) => setQuery(event.target.value)}
          className={`min-h-11 w-full rounded-sheet border border-line bg-surface-1 px-4 text-sm text-primary placeholder:text-muted ${focusRing}`}
        />
      </div>
      <section
        ref={scrollRef}
        data-testid="burst-grid-scroll"
        aria-label={t("burst.grid.label")}
        className="min-h-0 flex-1 overflow-y-auto px-4"
      >
        {rows.length === 0 ? (
          <p
            data-testid="burst-grid-empty"
            className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted"
          >
            <SearchX size={24} aria-hidden="true" />
            {t("burst.grid.empty")}
          </p>
        ) : useFallback ? (
          <div data-testid="burst-grid" className="flex flex-col gap-2.5 pb-4">
            {rows.slice(0, SSR_FALLBACK_ROWS).map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: repli SSR statique, rangées stables
              <div key={rowIndex} className="grid grid-cols-3 gap-2.5">
                {renderRow(row, rowIndex)}
              </div>
            ))}
          </div>
        ) : (
          <div
            data-testid="burst-grid"
            style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
          >
            {virtualRows.map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="grid grid-cols-3 gap-2.5"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderRow(rows[virtualRow.index] ?? [], virtualRow.index)}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
