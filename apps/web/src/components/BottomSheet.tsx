import { X } from "lucide-react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n/index.ts";

/** Libellé accessible obligatoire : un `title` visible, ou à défaut un `ariaLabel`. */
export type BottomSheetLabel =
  | { readonly title: string; readonly ariaLabel?: string | undefined }
  | { readonly title?: undefined; readonly ariaLabel: string };

export type BottomSheetProps = BottomSheetLabel & {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children?: ReactNode | undefined;
};

/** Distance de balayage vers le bas (en px) qui déclenche la fermeture. */
const SWIPE_CLOSE_THRESHOLD_PX = 96;

/**
 * Feuille modale mobile-first basée sur un `<dialog>` natif (`showModal()`) :
 * focus trap, couche top-layer, `::backdrop` et `Escape` natifs (aucun bouton
 * de fond dans l'ordre de tabulation). Fermeture par le fond, `Escape` ou le
 * bouton fermer ; swipe-down sur toute la zone d'en-tête (poignée + titre) avec
 * retour animé sous le seuil ; focus restauré sur l'élément précédent ;
 * safe-area inférieure ; `prefers-reduced-motion` géré en CSS.
 */
export const BottomSheet = ({ open, onClose, title, ariaLabel, children }: BottomSheetProps) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // `onClose` vit dans une ref : un re-render parent ne doit jamais relancer les effets d'ouverture/focus.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const dragState = useRef<{ startY: number; deltaY: number } | null>(null);
  /** Décalage vertical pendant le glissement ; `null` au repos (transition de retour active). */
  const [dragOffset, setDragOffset] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Laisse le bouton fermer gérer son propre clic (pas de capture du pointeur).
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    dragState.current = { startY: event.clientY, deltaY: 0 };
    setDragOffset(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (drag === null) return;
    drag.deltaY = Math.max(0, event.clientY - drag.startY);
    setDragOffset(drag.deltaY);
  };

  const endDrag = () => {
    const drag = dragState.current;
    dragState.current = null;
    setDragOffset(null);
    if (drag !== null && drag.deltaY > SWIPE_CLOSE_THRESHOLD_PX) onCloseRef.current();
  };

  const dragging = dragOffset !== null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: fermeture clavier assurée par Escape (onCancel) et le bouton fermer
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={title === undefined ? undefined : titleId}
      aria-label={title === undefined ? ariaLabel : undefined}
      onCancel={(event) => {
        // L'état `open` appartient au parent : on délègue la fermeture.
        event.preventDefault();
        onCloseRef.current();
      }}
      // Clic sur le fond (le `<dialog>` couvre l'écran) : `Escape` et le bouton fermer couvrent le clavier.
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
      className="m-0 h-dvh max-h-none border-0 w-dvw max-w-none items-end justify-center bg-transparent p-0 text-inherit open:flex backdrop:animate-backdrop-in backdrop:bg-[color-mix(in_srgb,var(--bg-canvas)_65%,transparent)]"
    >
      <div
        className="animate-sheet-in flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-sheet border border-line bg-surface-1 shadow-sheet motion-reduce:transition-none"
        style={{
          paddingBottom: "var(--safe-area-inset-bottom)",
          transform:
            dragOffset !== null && dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          transition: dragging ? "none" : "transform var(--pv-duration-med) var(--pv-ease-out)",
        }}
      >
        <div
          className="cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div aria-hidden="true" className="flex justify-center px-4 pt-3 pb-2">
            <div className="h-1.5 w-10 rounded-pill bg-muted opacity-60" />
          </div>
          <div className="flex items-center justify-between gap-3 px-4 pb-2">
            {title === undefined ? (
              <span className="min-h-7" aria-hidden="true" />
            ) : (
              <h2 id={titleId} className="min-h-7 text-lg font-semibold text-primary">
                {title}
              </h2>
            )}
            <button
              type="button"
              onClick={() => onCloseRef.current()}
              aria-label={t("bottomSheet.close")}
              className="flex items-center justify-center rounded-pill text-secondary transition-colors hover:bg-surface-2 hover:text-primary"
              style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 pb-6 text-secondary">
          {children}
        </div>
      </div>
    </dialog>
  );
};
