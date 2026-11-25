import { CardAspectRatio, type HoloEffect, tcgdexCardImageUrl } from "@pokevault/domain";
import { ImageOff, RotateCw, Sparkles, X } from "lucide-react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type TranslationKey, t } from "../i18n/index.ts";
import {
  type Card3dCssVars,
  computeCard3dCssVars,
  computePointerTilt,
  INITIAL_SPRING_STATE,
  resolveCardHaloTone,
  resolveHoloPreset,
  type SpringState,
  stepSpringState,
  type TiltTarget,
  tiltToPointerPercent,
  ZERO_TILT,
} from "../lib/card-3d-physics.ts";

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

/** Données minimales d'une carte pour l'Inspecteur 3D Holo (`04B–04D`). */
export interface Card3DInspectorCard {
  readonly cardId: string;
  readonly name: string;
  readonly setLabel?: string | null | undefined;
  readonly numberLabel?: string | null | undefined;
  readonly rarity?: string | null | undefined;
  readonly holoEffect?: HoloEffect | string | null | undefined;
  readonly types?: ReadonlyArray<string> | null | undefined;
  readonly imageBaseUrl: string | null;
}

export interface Card3DInspectorProps {
  readonly open: boolean;
  readonly card: Card3DInspectorCard;
  readonly onClose: () => void;
  /** Force le mode animation réduite (sinon détecté via `prefers-reduced-motion`). */
  readonly reducedMotion?: boolean | undefined;
  /** Inclinaison externe optionnelle (ex. gyroscope branché dans T10.2). */
  readonly externalTilt?: TiltTarget | null | undefined;
  /** Slot d'actions additionnelles dans la barre de contrôles (ex. bouton Gyroscope). */
  readonly controlsSlot?: ReactNode | undefined;
  /** État initial du toggle Holo (défaut : `true`). */
  readonly initialHoloEnabled?: boolean | undefined;
  /** État initial de la face retournée (défaut : `false`). */
  readonly initialFlipped?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Constantes d'affichage
// ---------------------------------------------------------------------------

const PRESET_LABEL_KEYS: Readonly<Record<HoloEffect, TranslationKey>> = {
  none: "inspector3d.preset.none",
  holo: "inspector3d.preset.holo",
  reverse: "inspector3d.preset.reverse",
  ex: "inspector3d.preset.ex",
  sir: "inspector3d.preset.sir",
  tera: "inspector3d.preset.tera",
  gold: "inspector3d.preset.gold",
};

const DOUBLE_TAP_MAX_DELAY_MS = 320;
const DOUBLE_TAP_MAX_DISTANCE_PX = 28;
const DRAG_MOVE_THRESHOLD_PX = 6;

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const applyCssVarsToElement = (element: HTMLElement | null, vars: Card3dCssVars): void => {
  if (element === null) return;
  for (const [name, value] of Object.entries(vars)) {
    element.style.setProperty(name, value);
  }
};

// ---------------------------------------------------------------------------
// Verso officiel Pokémon stylisé (SVG vectoriel intégré, zéro asset externe)
// ---------------------------------------------------------------------------

const PokemonCardBackSvg = ({ gradientId }: { readonly gradientId: string }) => (
  <svg
    viewBox="0 0 252 352"
    role="img"
    aria-label={t("inspector3d.card.backAlt")}
    data-testid="card3d-back-svg"
    className="h-full w-full"
  >
    <defs>
      <radialGradient id={`${gradientId}-aura`} cx="50%" cy="50%" r="55%">
        <stop offset="0%" stopColor="var(--pv-cardback-aura)" stopOpacity="0.88" />
        <stop offset="52%" stopColor="var(--pv-cardback-navy-mid)" stopOpacity="0.92" />
        <stop offset="100%" stopColor="var(--pv-cardback-navy-deep)" stopOpacity="1" />
      </radialGradient>
      <linearGradient id={`${gradientId}-ball-top`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="var(--pv-cardback-red-highlight)" />
        <stop offset="65%" stopColor="var(--pv-cardback-red)" />
      </linearGradient>
    </defs>

    {/* Cadre bleu marine extérieur + liseré intérieur */}
    <rect width="252" height="352" rx="14" fill="var(--pv-cardback-border)" />
    <rect x="12" y="12" width="228" height="328" rx="9" fill={`url(#${gradientId}-aura)`} />
    <rect
      x="16"
      y="16"
      width="220"
      height="320"
      rx="7"
      fill="none"
      stroke="var(--pv-cardback-gold)"
      strokeOpacity="0.45"
      strokeWidth="1.5"
    />

    {/* Anneaux d'énergie concentriques */}
    <circle
      cx="126"
      cy="176"
      r="88"
      fill="none"
      stroke="var(--pv-cardback-aura)"
      strokeOpacity="0.35"
      strokeWidth="2"
      strokeDasharray="10 8"
    />
    <ellipse
      cx="126"
      cy="176"
      rx="76"
      ry="116"
      fill="none"
      stroke="var(--pv-cardback-white)"
      strokeOpacity="0.16"
      strokeWidth="1.5"
      transform="rotate(-18 126 176)"
    />
    <ellipse
      cx="126"
      cy="176"
      rx="76"
      ry="116"
      fill="none"
      stroke="var(--pv-cardback-gold)"
      strokeOpacity="0.22"
      strokeWidth="1.5"
      transform="rotate(18 126 176)"
    />

    {/* Étoiles d'angle discrètes */}
    <circle cx="38" cy="40" r="3" fill="var(--pv-cardback-gold)" fillOpacity="0.7" />
    <circle cx="214" cy="40" r="3" fill="var(--pv-cardback-gold)" fillOpacity="0.7" />
    <circle cx="38" cy="312" r="3" fill="var(--pv-cardback-gold)" fillOpacity="0.7" />
    <circle cx="214" cy="312" r="3" fill="var(--pv-cardback-gold)" fillOpacity="0.7" />

    {/* Poké Ball centrale stylisée */}
    <g transform="translate(126 176) rotate(-14)">
      {/* Halo lumineux derrière la Poké Ball */}
      <circle r="60" fill="var(--pv-cardback-aura)" fillOpacity="0.28" />
      {/* Moitié supérieure rouge */}
      <path d="M -52 0 A 52 52 0 0 1 52 0 Z" fill={`url(#${gradientId}-ball-top)`} />
      {/* Moitié inférieure blanche */}
      <path d="M -52 0 A 52 52 0 0 0 52 0 Z" fill="var(--pv-cardback-white)" />
      {/* Contour extérieur */}
      <circle r="52" fill="none" stroke="var(--pv-cardback-ink)" strokeWidth="5" />
      {/* Bande équatoriale */}
      <line x1="-52" y1="0" x2="52" y2="0" stroke="var(--pv-cardback-ink)" strokeWidth="9" />
      {/* Reflet courbé sur la calotte supérieure */}
      <path
        d="M -30 -24 A 38 38 0 0 1 12 -36"
        fill="none"
        stroke="var(--pv-cardback-white)"
        strokeOpacity="0.45"
        strokeWidth="4"
        strokeLinecap="round"
      />
      {/* Bouton central */}
      <circle
        r="16"
        fill="var(--pv-cardback-white)"
        stroke="var(--pv-cardback-ink)"
        strokeWidth="5"
      />
      <circle
        r="8"
        fill="var(--pv-cardback-white)"
        stroke="var(--pv-cardback-ink)"
        strokeWidth="2"
      />
    </g>
  </svg>
);

// ---------------------------------------------------------------------------
// Composant principal : Inspecteur 3D Holo (`04B–04D`)
// ---------------------------------------------------------------------------

/**
 * Inspecteur 3D Holo plein écran (`04B–04D`) :
 * - Drag tactile/souris (`PointerEvents`) avec moteur ressort `requestAnimationFrame`
 *   pilotant uniquement les CSS custom properties `--rx`, `--ry`, `--px`, `--py`,
 *   `--bg-x`, `--bg-y`, `--glare-opacity`, `--hyp` (zéro re-render React par frame).
 * - 7 presets foil par rareté (`none`, `holo`, `reverse`, `ex`, `sir`, `tera`, `gold`)
 *   + toggle **Holo** pour inspecter l'artwork brut.
 * - Flip 180° vers le verso Pokémon vectoriel (double-tap sur la carte ou bouton **Retourner**).
 * - Prêt pour le branchement Gyroscope (`externalTilt` + `controlsSlot`) dans T10.2.
 */
export const Card3DInspector = ({
  open,
  card,
  onClose,
  reducedMotion,
  externalTilt = null,
  controlsSlot,
  initialHoloEnabled = true,
  initialFlipped = false,
}: Card3DInspectorProps) => {
  const gradientId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const [holoEnabled, setHoloEnabled] = useState(initialHoloEnabled);
  const [flipped, setFlipped] = useState(initialFlipped);
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState("");
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);

  const effectiveReducedMotion = reducedMotion ?? systemReducedMotion;
  const preset = resolveHoloPreset(card.holoEffect, card.rarity);
  const haloTone = resolveCardHaloTone(card.types, preset);
  const imageUrl = tcgdexCardImageUrl(card.imageBaseUrl, "high");
  const showImage = imageUrl !== undefined && failedUrl !== imageUrl;

  // Refs mutables du moteur 3D : zéro re-render React par frame.
  const springRef = useRef<SpringState>(INITIAL_SPRING_STATE);
  const dragTargetRef = useRef<TiltTarget>(ZERO_TILT);
  const externalTiltRef = useRef<TiltTarget | null>(externalTilt);
  const draggingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const holoEnabledRef = useRef(holoEnabled);
  const reducedMotionRef = useRef(effectiveReducedMotion);

  // Détection OS de `prefers-reduced-motion: reduce` quand la prop n'est pas forcée.
  useEffect(() => {
    if (reducedMotion !== undefined) return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setSystemReducedMotion(mediaQuery.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemReducedMotion(event.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, [reducedMotion]);

  // Réinitialise l'état d'inspection quand on change de carte ou qu'on rouvre la modale.
  const activeCardKey = open ? card.cardId : null;
  useEffect(() => {
    if (activeCardKey === null) return;
    setHoloEnabled(initialHoloEnabled);
    setFlipped(initialFlipped);
    setStatusMessage("");
  }, [activeCardKey, initialHoloEnabled, initialFlipped]);

  // Une image en erreur avant hydratation n'a pas émis `onError`.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) {
      setFailedUrl(imageUrl);
    }
  }, [imageUrl]);

  const stopAnimationLoop = useCallback(() => {
    if (rafIdRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = null;
    lastFrameTimeRef.current = null;
  }, []);

  const syncDomVars = useCallback((rx: number, ry: number, interacting: boolean) => {
    const { px, py } = tiltToPointerPercent(rx, ry);
    const vars = computeCard3dCssVars(rx, ry, px, py, {
      holoEnabled: holoEnabledRef.current,
      reducedMotion: reducedMotionRef.current,
      interacting,
    });
    applyCssVarsToElement(tiltRef.current, vars);
  }, []);

  const startAnimationLoop = useCallback(() => {
    if (reducedMotionRef.current) {
      stopAnimationLoop();
      springRef.current = INITIAL_SPRING_STATE;
      syncDomVars(0, 0, false);
      return;
    }
    if (rafIdRef.current !== null || typeof requestAnimationFrame !== "function") return;

    const tick = (now: number) => {
      const dtSeconds =
        lastFrameTimeRef.current === null ? 1 / 60 : (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;

      const activeTarget = draggingRef.current
        ? dragTargetRef.current
        : (externalTiltRef.current ?? ZERO_TILT);

      const next = stepSpringState(springRef.current, activeTarget, dtSeconds);
      springRef.current = next;

      const interacting = draggingRef.current || externalTiltRef.current !== null;
      syncDomVars(next.rx, next.ry, interacting);

      if (!next.isAtRest || draggingRef.current) {
        rafIdRef.current = requestAnimationFrame(tick);
      } else {
        rafIdRef.current = null;
        lastFrameTimeRef.current = null;
      }
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [stopAnimationLoop, syncDomVars]);

  // Ouverture / fermeture modale `<dialog>` top-layer + verrouillage scroll + nettoyage rAF.
  useEffect(() => {
    if (!open) {
      stopAnimationLoop();
      springRef.current = INITIAL_SPRING_STATE;
      draggingRef.current = false;
      activePointerIdRef.current = null;
      return;
    }

    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    if (dialog !== null && !dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
    }

    // Repli Escape explicite si le navigateur ou le contexte n'utilise pas `showModal()`.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    syncDomVars(0, 0, false);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      stopAnimationLoop();
      springRef.current = INITIAL_SPRING_STATE;
      draggingRef.current = false;
      activePointerIdRef.current = null;
      document.body.style.overflow = previousOverflow;
      if (dialog?.open) {
        dialog.close();
      }
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open, stopAnimationLoop, syncDomVars]);

  // Réagit aux changements d'inclinaison externe (gyroscope T10.2) sans re-render par frame.
  useEffect(() => {
    externalTiltRef.current = externalTilt;
    if (!open) return;
    if (effectiveReducedMotion) {
      stopAnimationLoop();
      springRef.current = INITIAL_SPRING_STATE;
      syncDomVars(0, 0, false);
      return;
    }
    if (externalTilt !== null || !draggingRef.current) {
      startAnimationLoop();
    }
  }, [
    open,
    externalTilt,
    effectiveReducedMotion,
    startAnimationLoop,
    stopAnimationLoop,
    syncDomVars,
  ]);

  // Met à jour immédiatement les variables CSS quand `holoEnabled` ou `reducedMotion` change.
  useEffect(() => {
    holoEnabledRef.current = holoEnabled;
    reducedMotionRef.current = effectiveReducedMotion;
    if (!open) return;
    if (effectiveReducedMotion) {
      stopAnimationLoop();
      springRef.current = INITIAL_SPRING_STATE;
      syncDomVars(0, 0, false);
      return;
    }
    syncDomVars(
      springRef.current.rx,
      springRef.current.ry,
      draggingRef.current || externalTiltRef.current !== null,
    );
  }, [open, holoEnabled, effectiveReducedMotion, stopAnimationLoop, syncDomVars]);

  if (!open) return null;

  const updateDragTargetFromPointer = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (stage === null) return;
    const rect = stage.getBoundingClientRect();
    const { targetRx, targetRy } = computePointerTilt(
      clientX - rect.left,
      clientY - rect.top,
      rect.width,
      rect.height,
    );
    dragTargetRef.current = { rx: targetRx, ry: targetRy };
  };

  const handleToggleFlip = () => {
    setFlipped((prev) => {
      const next = !prev;
      setStatusMessage(
        t(next ? "inspector3d.status.flippedBack" : "inspector3d.status.flippedFront"),
      );
      return next;
    });
  };

  const handleToggleHolo = () => {
    setHoloEnabled((prev) => {
      const next = !prev;
      setStatusMessage(t(next ? "inspector3d.status.holoOn" : "inspector3d.status.holoOff"));
      return next;
    });
  };

  const handleStagePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointerIdRef.current !== null) return;
    activePointerIdRef.current = event.pointerId;
    pointerDownRef.current = { x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);

    if (!effectiveReducedMotion) {
      draggingRef.current = true;
      updateDragTargetFromPointer(event.clientX, event.clientY);
      startAnimationLoop();
    }
  };

  const handleStagePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    const down = pointerDownRef.current;
    if (down !== null && !down.moved) {
      const dist = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (dist > DRAG_MOVE_THRESHOLD_PX) {
        down.moved = true;
      }
    }
    if (!effectiveReducedMotion && draggingRef.current) {
      updateDragTargetFromPointer(event.clientX, event.clientY);
      startAnimationLoop();
    }
  };

  const handleStagePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    const down = pointerDownRef.current;
    activePointerIdRef.current = null;
    pointerDownRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (draggingRef.current) {
      draggingRef.current = false;
      dragTargetRef.current = ZERO_TILT;
      startAnimationLoop();
    }

    // Détection unifiée du double-tap (tactile + souris) sans conflit avec le drag.
    if (down !== null && !down.moved) {
      const now = Date.now();
      const previous = lastTapRef.current;
      if (
        previous !== null &&
        now - previous.time <= DOUBLE_TAP_MAX_DELAY_MS &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <=
          DOUBLE_TAP_MAX_DISTANCE_PX
      ) {
        lastTapRef.current = null;
        handleToggleFlip();
      } else {
        lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
      }
    } else {
      lastTapRef.current = null;
    }
  };

  const handleStagePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    pointerDownRef.current = null;
    if (draggingRef.current) {
      draggingRef.current = false;
      dragTargetRef.current = ZERO_TILT;
      startAnimationLoop();
    }
  };

  const presetLabel = t(PRESET_LABEL_KEYS[preset]);
  const subtitleParts = [card.setLabel, card.numberLabel].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: fermeture clavier assurée par Escape (onCancel/keydown) et le bouton Fermer
    <dialog
      ref={dialogRef}
      // biome-ignore lint/a11y/noRedundantRoles: rôle explicite requis par le contrat d'accessibilité et les tests SSR
      role="dialog"
      aria-modal="true"
      aria-label={t("inspector3d.dialog.aria", { name: card.name })}
      data-testid="card3d-inspector"
      data-halo-tone={haloTone}
      data-reduced-motion={effectiveReducedMotion ? "true" : "false"}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onClick={(event) => {
        if (
          event.target === event.currentTarget ||
          (event.target instanceof Element &&
            (event.target.getAttribute("data-testid") === "card3d-backdrop" ||
              event.target.getAttribute("data-testid") === "card3d-center"))
        ) {
          onCloseRef.current();
        }
      }}
      className="pv-inspector-dialog fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none border-0 p-0 open:flex"
    >
      <div
        data-testid="card3d-backdrop"
        className="relative flex h-full w-full flex-col justify-between overflow-hidden px-4"
        style={{
          paddingTop: "max(1rem, var(--safe-area-inset-top))",
          paddingBottom: "max(1.25rem, var(--safe-area-inset-bottom))",
        }}
      >
        {/* Halo radial studio adaptatif (dérivé du type dominant / preset foil) */}
        <div aria-hidden="true" data-testid="card3d-halo" className="pv-inspector-halo" />

        {/* En-tête : identité de la carte + badge preset foil + bouton Fermer ≥ 44×44 */}
        <header className="relative z-10 mx-auto flex w-full max-w-lg items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-base font-bold">{card.name}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {subtitleParts.length > 0 ? (
                <span className="pv-inspector-secondary truncate font-mono text-xs tabular-nums">
                  {subtitleParts.join(" · ")}
                </span>
              ) : null}
              <span
                data-testid="card3d-preset-badge"
                title={t("inspector3d.preset.label", { preset: presetLabel })}
                className="pv-inspector-badge inline-flex items-center rounded-pill px-2.5 py-0.5 text-[11px] font-semibold"
              >
                <span className="sr-only">
                  {t("inspector3d.preset.label", { preset: presetLabel })}
                </span>
                <span aria-hidden="true">{presetLabel}</span>
              </span>
            </div>
          </div>

          <button
            type="button"
            data-testid="card3d-close"
            onClick={() => onCloseRef.current()}
            aria-label={t("inspector3d.close")}
            className={`pv-inspector-pill flex shrink-0 items-center justify-center rounded-pill transition-colors ${focusRing}`}
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        {/* Scène 3D centrale (ratio strict 63/88) */}
        <div
          data-testid="card3d-center"
          className="relative z-10 flex flex-1 items-center justify-center py-4"
        >
          <section
            ref={stageRef}
            data-testid="card3d-stage"
            aria-label={t("inspector3d.stage.aria", { name: card.name })}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerCancel}
            className="pv-card3d-stage w-full max-w-[300px] sm:max-w-[340px]"
          >
            <div
              ref={tiltRef}
              data-testid="card3d-card"
              data-holo-preset={preset}
              data-holo-enabled={holoEnabled ? "true" : "false"}
              data-flipped={flipped ? "true" : "false"}
              data-reduced-motion={effectiveReducedMotion ? "true" : "false"}
              className="pv-card3d-tilt"
              style={{ aspectRatio: CardAspectRatio }}
            >
              <div className="pv-card3d-flipper">
                {/* Face recto : visuel haute résolution + couches foil/glare */}
                <div className="pv-card3d-face pv-card3d-face--front" data-testid="card3d-front">
                  {showImage ? (
                    <img
                      ref={imageRef}
                      src={imageUrl}
                      alt={t("inspector3d.card.frontAlt", { name: card.name })}
                      loading="eager"
                      decoding="async"
                      draggable={false}
                      onError={() => setFailedUrl(imageUrl)}
                      className="h-full w-full select-none object-cover"
                    />
                  ) : (
                    <div
                      data-testid="card3d-image-fallback"
                      className="pv-inspector-muted flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center"
                    >
                      <ImageOff size={32} aria-hidden="true" />
                      <span className="text-sm font-semibold">{card.name}</span>
                      <span className="text-xs">{t("inspector3d.card.fallback")}</span>
                    </div>
                  )}
                  <div aria-hidden="true" className="pv-card3d-foil" />
                  <div aria-hidden="true" className="pv-card3d-sparkle" />
                  <div aria-hidden="true" className="pv-card3d-glare" />
                </div>

                {/* Face verso : dos Pokémon vectoriel stylisé + reflet léger */}
                <div className="pv-card3d-face pv-card3d-face--back" data-testid="card3d-back">
                  <PokemonCardBackSvg gradientId={gradientId} />
                  <div aria-hidden="true" className="pv-card3d-glare" />
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Barre inférieure : indice d'interaction + contrôles Holo / Retourner / slot Gyro */}
        <footer className="relative z-10 mx-auto flex w-full max-w-lg flex-col items-center gap-3">
          <p data-testid="card3d-hint" className="pv-inspector-muted text-center text-xs">
            {t(effectiveReducedMotion ? "inspector3d.hint.reducedMotion" : "inspector3d.hint.drag")}
          </p>

          <div
            role="toolbar"
            aria-label={t("inspector3d.controls.label")}
            data-testid="card3d-controls"
            className="flex flex-wrap items-center justify-center gap-2"
          >
            <button
              type="button"
              data-testid="card3d-toggle-holo"
              aria-pressed={holoEnabled}
              aria-label={t(
                holoEnabled ? "inspector3d.action.holo.disable" : "inspector3d.action.holo.enable",
              )}
              data-active={holoEnabled ? "true" : "false"}
              onClick={handleToggleHolo}
              className={`pv-inspector-pill inline-flex items-center justify-center gap-2 rounded-pill px-4 text-sm font-semibold transition-colors ${focusRing}`}
              style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            >
              <Sparkles size={16} aria-hidden="true" />
              <span aria-hidden="true">{t("inspector3d.action.holo")}</span>
            </button>

            <button
              type="button"
              data-testid="card3d-toggle-flip"
              aria-pressed={flipped}
              aria-label={t(
                flipped ? "inspector3d.action.flip.toFront" : "inspector3d.action.flip.toBack",
              )}
              data-active={flipped ? "true" : "false"}
              onClick={handleToggleFlip}
              className={`pv-inspector-pill inline-flex items-center justify-center gap-2 rounded-pill px-4 text-sm font-semibold transition-colors ${focusRing}`}
              style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            >
              <RotateCw size={16} aria-hidden="true" />
              <span aria-hidden="true">{t("inspector3d.action.flip")}</span>
            </button>

            {controlsSlot ?? null}
          </div>

          <output aria-live="polite" data-testid="card3d-live-status" className="sr-only">
            {statusMessage}
          </output>
        </footer>
      </div>
    </dialog>
  );
};
