import { CardAspectRatio } from "@pokevault/domain";
import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t, tPlural } from "../i18n/index.ts";

/**
 * Possession de la carte, en union discriminée (aucune combinaison invalide) :
 * - `owned` (défaut) : exemplaire unique ;
 * - `missing` : carte manquante (tuile atténuée) ;
 * - `duplicate` : `count >= 2` exemplaires (badge `×N`). Un `count < 2` est
 *   traité comme `owned` à l'exécution.
 */
export type CardTileOwnership =
  | { readonly state?: "owned" | undefined; readonly count?: undefined }
  | { readonly state: "missing"; readonly count?: undefined }
  | { readonly state: "duplicate"; readonly count: number };

export type CardTileState = "owned" | "duplicate" | "missing";

export type CardTileProps = CardTileOwnership & {
  /** Nom de la carte (utilisé dans le libellé accessible). */
  readonly name: string;
  /**
   * Libellé accessible explicite (remplace celui dérivé de la possession), pour
   * les contextes où la possession est inconnue ou sans objet (ex. recherche du catalogue).
   */
  readonly label?: string | undefined;
  readonly imageUrl?: string | undefined;
  /** Compteur du mode saisie rafale (badge doré `+N`). */
  readonly burstCount?: number | undefined;
  /** Visuel au-dessus de la ligne de flottaison : chargement `eager` au lieu de `lazy`. */
  readonly priority?: boolean | undefined;
};

/**
 * Tuile carte Pokémon : ratio strict 63/88 (`CardAspectRatio`), image lazy +
 * async (zéro CLS grâce au ratio fixe), coins 8px, états `owned` / `duplicate`
 * / `missing` (+ badge doré `burstCount`), et fallback visuel propre quand
 * `imageUrl` est absent ou ne charge pas. Pas de `role="img"` sur le conteneur
 * (la tuile pourra devenir interactive) : le libellé est un texte `sr-only`.
 * Zéro couleur hex brute : uniquement des tokens.
 */
export const CardTile = (props: CardTileProps) => {
  const { name, imageUrl, burstCount, priority = false } = props;
  const duplicateCount = props.state === "duplicate" && props.count >= 2 ? props.count : undefined;
  const isMissing = props.state === "missing";
  const hasBurst = burstCount !== undefined && burstCount > 0;

  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const imageRef = useRef<HTMLImageElement>(null);
  const showImage = imageUrl !== undefined && failedUrl !== imageUrl;

  // Une erreur de chargement survenue avant l'hydratation n'a pas déclenché `onError`.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) setFailedUrl(imageUrl);
  }, [imageUrl]);

  const baseLabel =
    props.label !== undefined
      ? props.label
      : duplicateCount !== undefined
        ? tPlural("cardTile.duplicate", duplicateCount, { name })
        : isMissing
          ? t("cardTile.missing", { name })
          : t("cardTile.owned", { name });
  const label = hasBurst
    ? `${baseLabel} — ${t("cardTile.burst", { count: burstCount })}`
    : baseLabel;

  return (
    <div
      className={`relative w-full overflow-hidden rounded-card border border-line bg-surface-1 shadow-card ${
        isMissing ? "saturate-0 opacity-30" : ""
      }`}
      style={{ aspectRatio: CardAspectRatio }}
    >
      <span className="sr-only">{label}</span>
      {showImage ? (
        <img
          ref={imageRef}
          src={imageUrl}
          alt=""
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailedUrl(imageUrl)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 px-1 text-muted"
        >
          <ImageOff size={20} />
          <span className="text-center text-[10px] leading-tight">
            {t("cardTile.imageFallback")}
          </span>
        </div>
      )}
      {duplicateCount !== undefined ? (
        <span
          aria-hidden="true"
          className="absolute top-1.5 right-1.5 rounded-md border border-line bg-surface-1/90 px-1.5 py-0.5 font-mono text-xs tabular-nums text-primary"
        >
          ×{duplicateCount}
        </span>
      ) : null}
      {hasBurst ? (
        <span
          aria-hidden="true"
          className="absolute top-1.5 left-1.5 rounded-md bg-gold-soft px-1.5 py-0.5 font-mono text-xs tabular-nums text-gold"
        >
          +{burstCount}
        </span>
      ) : null}
    </div>
  );
};
