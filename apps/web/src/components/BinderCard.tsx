import {
  type BinderSummary,
  CardAspectRatio,
  tcgdexCardImageUrl,
  tcgdexSetLogoUrl,
} from "@pokevault/domain";
import { FolderHeart, Lock, Pin, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t, tPlural } from "../i18n/index.ts";
import { binderCoverUrl } from "../lib/binders-client.ts";

export interface BinderCardProps {
  readonly summary: BinderSummary;
  /**
   * `image_base_url` TCGdex de la carte de couverture (`binder.coverCardId`),
   * résolue côté serveur ; `null` / absent : repli neutre.
   */
  readonly coverCardImageBaseUrl?: string | null | undefined;
  /** Visuel au-dessus de la ligne de flottaison : chargement `eager` au lieu de `lazy`. */
  readonly priority?: boolean | undefined;
  /** Bouton discret « Réglages » (T3.4) ; absent : aucun bouton rendu. */
  readonly onOpenSettings?: ((summary: BinderSummary) => void) | undefined;
}

/** Lien vers la grille du classeur. */
export const binderHref = (binderId: string): string => `/binder/${binderId}`;

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/** Pastille lisible sur n'importe quelle cover (y compris une image uploadée). */
const pill =
  "inline-flex items-center gap-1 rounded-pill border border-line bg-surface-1/90 px-2 py-0.5 text-xs font-semibold text-primary";

type FailureHandler = (src: string) => void;

/** Image de cover avec repli quand elle ne charge pas (réseau, 404 du proxy). */
const CoverImage = ({
  src,
  className,
  priority,
  onFailure,
}: {
  readonly src: string;
  readonly className: string;
  readonly priority: boolean;
  readonly onFailure: FailureHandler;
}) => {
  const ref = useRef<HTMLImageElement>(null);
  // Une erreur survenue avant l'hydratation n'a pas déclenché `onError`.
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth === 0) onFailure(src);
  }, [src, onFailure]);
  return (
    <img
      ref={ref}
      src={src}
      alt=""
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      onError={() => onFailure(src)}
      className={className}
    />
  );
};

/** Repli sobre : code de l'extension, ou icône dossier pour un dossier perso. */
const CoverFallback = ({ summary }: { readonly summary: BinderSummary }) => (
  <div
    aria-hidden="true"
    data-testid="binder-cover-fallback"
    className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted"
  >
    {summary.binder.kind === "set" ? (
      <span className="font-mono text-2xl font-bold tabular-nums text-secondary">
        {summary.set?.code ?? summary.binder.setId}
      </span>
    ) : (
      <FolderHeart size={32} strokeWidth={1.5} />
    )}
  </div>
);

const Cover = ({
  summary,
  coverCardImageBaseUrl,
  priority,
}: {
  readonly summary: BinderSummary;
  readonly coverCardImageBaseUrl: string | null | undefined;
  readonly priority: boolean;
}) => {
  const { binder } = summary;
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);

  let src: string | undefined;
  if (binder.coverType === "upload") src = binderCoverUrl(binder);
  else if (binder.coverType === "card") {
    src = tcgdexCardImageUrl(coverCardImageBaseUrl ?? null, "low");
  } else src = tcgdexSetLogoUrl(summary.set?.logoUrl ?? null);

  if (src === undefined || failedSrc === src) return <CoverFallback summary={summary} />;

  if (binder.coverType === "upload") {
    return (
      <>
        <CoverImage
          src={src}
          priority={priority}
          onFailure={setFailedSrc}
          className="h-full w-full object-cover"
        />
        {/* Voile subtil : garde les pastilles lisibles sur n'importe quelle image. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-b from-canvas/50 via-transparent to-canvas/40"
        />
      </>
    );
  }

  if (binder.coverType === "card") {
    return (
      <div className="flex h-full w-full items-center justify-center py-3">
        <div className="h-full" style={{ aspectRatio: CardAspectRatio }}>
          <CoverImage
            src={src}
            priority={priority}
            onFailure={setFailedSrc}
            className="h-full w-full rounded-card border border-line object-cover shadow-card"
          />
        </div>
      </div>
    );
  }

  return (
    <CoverImage
      src={src}
      priority={priority}
      onFailure={setFailedSrc}
      className="h-full w-full object-contain p-5"
    />
  );
};

/**
 * Grande card classeur de l'écran Collection (grille 2 colonnes à 390 px).
 * Couverture à UNE seule image (docs/01 §4.1, ADR-005) : logo officiel
 * (`set_logo`, `contain` sur fond calme), une carte entière 63/88 (`card`) ou
 * une image uploadée plein cadre (`upload`, `cover` + voile). Classeur
 * d'extension : code, complétion `%`, barre dorée, `possédées/total`.
 * Dossier perso : badge Privé, nombre de cartes, possédées. 100 % tokens.
 */
export const BinderCard = ({
  summary,
  coverCardImageBaseUrl,
  priority = false,
  onOpenSettings,
}: BinderCardProps) => {
  const { binder, set, completion } = summary;
  const isSet = binder.kind === "set";
  const owned = completion?.ownedDistinct ?? summary.ownedCount;
  const total = completion?.targetCount ?? summary.cardCount;
  const percent = completion?.percent ?? 0;

  return (
    <article
      data-testid="binder-card"
      data-kind={binder.kind}
      data-cover={binder.coverType}
      className="relative flex flex-col overflow-hidden rounded-sheet border border-line bg-surface-1 shadow-card"
    >
      <a
        href={binderHref(binder.id)}
        aria-label={t("binderCard.open", { title: binder.title })}
        className={`flex flex-col ${focusRing}`}
      >
        <div className="relative aspect-4/3 w-full overflow-hidden bg-surface-2">
          <Cover
            // Réinitialise le repli quand la cover change (nouvelle image, nouveau type).
            key={`${binder.coverType}:${binder.updatedAt}`}
            summary={summary}
            coverCardImageBaseUrl={coverCardImageBaseUrl}
            priority={priority}
          />
          <div className="absolute top-2 left-2 flex max-w-[70%] flex-wrap gap-1">
            {isSet ? (
              <span className={`${pill} font-mono tabular-nums`}>{set?.code ?? binder.setId}</span>
            ) : (
              <span className={pill}>
                <Lock size={12} aria-hidden="true" />
                {t("binderCard.private")}
              </span>
            )}
            {binder.isPinned ? (
              <span className={`${pill} text-gold`} data-testid="binder-pinned">
                <Pin size={12} aria-hidden="true" />
                <span className="sr-only">{t("binderCard.pinned")}</span>
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2 p-3">
          <h3 className="truncate text-sm font-bold text-primary">{binder.title}</h3>
          {isSet ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-bold tabular-nums text-primary">
                  {t("binderCard.percent", { percent })}
                </span>
                <span aria-hidden="true" className="font-mono text-xs tabular-nums text-secondary">
                  {owned}/{total}
                </span>
                <span className="sr-only">{t("binderCard.ratio", { owned, total })}</span>
              </div>
              <div
                role="progressbar"
                aria-label={t("binderCard.progress", { title: binder.title })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 w-full overflow-hidden rounded-pill bg-surface-2"
              >
                <div className="h-full rounded-pill bg-gold-bar" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : (
            <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-secondary">
              <span className="font-mono tabular-nums">
                {tPlural("binderCard.cardCount", summary.cardCount)}
              </span>
              <span className="font-mono tabular-nums text-muted">
                {tPlural("binderCard.owned", summary.ownedCount)}
              </span>
            </p>
          )}
        </div>
      </a>

      {onOpenSettings === undefined ? null : (
        <button
          type="button"
          onClick={() => onOpenSettings(summary)}
          aria-label={t("binderCard.settings", { title: binder.title })}
          className={`absolute top-1 right-1 flex items-center justify-center rounded-pill border border-line bg-surface-1/90 text-secondary transition-colors hover:text-primary ${focusRing}`}
          style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
        >
          <Settings2 size={16} aria-hidden="true" />
        </button>
      )}
    </article>
  );
};
