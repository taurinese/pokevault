import { useEffect, useState } from "react";

/** Nombre de colonnes supporté par les grilles de cartes virtualisées (`3` mobile, `5` desktop `lg`, `6` large desktop `xl`). */
export type CardGridColumns = 3 | 5 | 6;

/** Seuil desktop (`lg:` Tailwind v4 = 64rem = 1024px). */
export const DESKTOP_GRID_LG_MIN_PX = 1024;
/** Seuil grand desktop (`xl:` Tailwind v4 = 80rem = 1280px). */
export const DESKTOP_GRID_XL_MIN_PX = 1280;

/** Nombre de colonnes par défaut (SSR & mobile-first `< 1024px`). */
export const DEFAULT_CARD_GRID_COLUMNS: CardGridColumns = 3;

const LG_MEDIA_QUERY = `(min-width: ${DESKTOP_GRID_LG_MIN_PX}px)`;
const XL_MEDIA_QUERY = `(min-width: ${DESKTOP_GRID_XL_MIN_PX}px)`;

/**
 * Classes Tailwind statiques correspondant à `CardGridColumns` (visibles au
 * scanner Tailwind v4 et garantissant `grid-cols-3` dès le SSR).
 */
export const CARD_GRID_COLS_CLASS: Readonly<Record<CardGridColumns, string>> = {
  3: "grid-cols-3",
  5: "grid-cols-5",
  6: "grid-cols-6",
};

/**
 * Calcule le nombre de colonnes de la grille de cartes selon la largeur du
 * viewport (`< 1024px` → `3`, `1024..1279px` → `5`, `>= 1280px` → `6`).
 */
export const resolveCardGridColumns = (viewportWidth: number): CardGridColumns => {
  if (!Number.isFinite(viewportWidth) || viewportWidth < DESKTOP_GRID_LG_MIN_PX) {
    return 3;
  }
  if (viewportWidth < DESKTOP_GRID_XL_MIN_PX) {
    return 5;
  }
  return 6;
};

/**
 * Hook SSR-safe pour synchroniser le nombre de colonnes d'une grille virtualisée
 * par rangée (`chunkIntoRows`). Retourne toujours `3` côté serveur et au premier
 * rendu client (zéro hydration mismatch), puis s'aligne sur les breakpoints
 * desktop (`lg:` 1024px → 5 colonnes, `xl:` 1280px → 6 colonnes) via `matchMedia`.
 */
export const useResponsiveCardGridColumns = (): CardGridColumns => {
  const [columns, setColumns] = useState<CardGridColumns>(DEFAULT_CARD_GRID_COLUMNS);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const lgQuery = window.matchMedia(LG_MEDIA_QUERY);
    const xlQuery = window.matchMedia(XL_MEDIA_QUERY);
    const sync = (): void => {
      setColumns(xlQuery.matches ? 6 : lgQuery.matches ? 5 : 3);
    };
    sync();
    lgQuery.addEventListener("change", sync);
    xlQuery.addEventListener("change", sync);
    return () => {
      lgQuery.removeEventListener("change", sync);
      xlQuery.removeEventListener("change", sync);
    };
  }, []);

  return columns;
};
