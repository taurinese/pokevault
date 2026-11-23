import { CardAspectRatio } from "@pokevault/domain";
import { ImageOff } from "lucide-react";
import { t } from "../i18n/index.ts";

export type CardTileState = "owned" | "duplicate" | "missing";

export interface CardTileProps {
  /** Nom de la carte (used dans le `aria-label`). */
  readonly name: string;
  readonly imageUrl?: string | undefined;
  /** `owned` par défaut ; `duplicate` affiche un badge `×N` ; `missing` atténue la tuile. */
  readonly state?: CardTileState | undefined;
  /** Nombre d'exemplaires (badge `×N` de l'état `duplicate`). */
  readonly count?: number | undefined;
  /** Compteur du mode saisie rafale (badge doré `+N`). */
  readonly burstCount?: number | undefined;
}

/**
 * Tuile carte Pokémon : ratio strict 63/88 (`CardAspectRatio`), image lazy +
 * async (zéro CLS grâce au ratio fixe), coins 8px, états `owned` / `duplicate`
 * / `missing` (+ badge doré `burstCount`), et fallback visuel propre quand
 * `imageUrl` est absent. Zéro couleur hex brute : uniquement des tokens.
 */
export const CardTile = ({ name, imageUrl, state = "owned", count, burstCount }: CardTileProps) => {
  const isMissing = state === "missing";
  const baseLabel =
    state === "duplicate" && count !== undefined
      ? t("cardTile.duplicate", { name, count })
      : isMissing
        ? t("cardTile.missing", { name })
        : t("cardTile.owned", { name });
  const ariaLabel =
    burstCount !== undefined && burstCount > 0
      ? `${baseLabel} — ${t("cardTile.burst", { count: burstCount })}`
      : baseLabel;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={`relative w-full overflow-hidden rounded-card border border-line bg-surface-1 shadow-card ${
        isMissing ? "saturate-0 opacity-30" : ""
      }`}
      style={{ aspectRatio: CardAspectRatio }}
    >
      {imageUrl === undefined ? (
        <div
          aria-hidden="true"
          className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 px-1 text-muted"
        >
          <ImageOff size={20} />
          <span className="text-center text-[10px] leading-tight">
            {t("cardTile.imageFallback")}
          </span>
        </div>
      ) : (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}
      {state === "duplicate" && count !== undefined && count > 1 ? (
        <span className="absolute top-1.5 right-1.5 rounded-md border border-line bg-surface-1/90 px-1.5 py-0.5 font-mono text-xs tabular-nums text-primary">
          ×{count}
        </span>
      ) : null}
      {burstCount !== undefined && burstCount > 0 ? (
        <span className="absolute top-1.5 left-1.5 rounded-md bg-gold-soft px-1.5 py-0.5 font-mono text-xs tabular-nums text-gold">
          +{burstCount}
        </span>
      ) : null}
    </div>
  );
};
