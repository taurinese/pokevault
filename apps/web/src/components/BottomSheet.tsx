import { X } from "lucide-react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n/index.ts";

export interface BottomSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string | undefined;
  readonly children?: ReactNode | undefined;
}

/** Distance de balayage vers le bas (en px) qui déclenche la fermeture. */
const SWIPE_CLOSE_THRESHOLD_PX = 96;

const usePrefersReducedMotion = (): boolean => {
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mediaQuery.matches);
    const onChange = () => setReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);
  return reducedMotion;
};

/**
 * Feuille modale mobile-first : handle de glissement (swipe-down sur pointeur),
 * fermeture par le fond, la touche `Escape` ou le bouton fermer accessible,
 * `role="dialog"` + `aria-modal="true"`, safe-area inférieure et respect de
 * `prefers-reduced-motion`.
 */
export const BottomSheet = ({ open, onClose, title, children }: BottomSheetProps) => {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragState = useRef<{ startY: number; deltaY: number } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = { startY: event.clientY, deltaY: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (drag === null) return;
    const deltaY = event.clientY - drag.startY;
    if (deltaY > 0) {
      drag.deltaY = deltaY;
      setDragOffset(deltaY);
    }
  };

  const endDrag = () => {
    const drag = dragState.current;
    dragState.current = null;
    setDragOffset(0);
    if (drag !== null && drag.deltaY > SWIPE_CLOSE_THRESHOLD_PX) onClose();
  };

  return (
    <div className="fixed inset-0 z-(--z-sheet)">
      <button
        type="button"
        aria-label={t("bottomSheet.close")}
        onClick={onClose}
        className="animate-backdrop-in absolute inset-0 z-(--z-backdrop) cursor-default"
        style={{ backgroundColor: "color-mix(in srgb, var(--bg-canvas) 65%, transparent)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title === undefined ? undefined : titleId}
        className="animate-sheet-in absolute inset-x-0 bottom-0 z-(--z-sheet) mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-lg border border-line bg-surface-1 shadow-sheet"
        style={{
          paddingBottom: "var(--safe-area-inset-bottom)",
          transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          transition: dragOffset > 0 || reducedMotion ? "none" : undefined,
        }}
      >
        <div
          aria-hidden="true"
          className="flex cursor-grab touch-none justify-center px-4 pt-3 pb-2 active:cursor-grabbing"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
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
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("bottomSheet.close")}
            className="flex items-center justify-center rounded-pill text-secondary transition-colors hover:bg-surface-2 hover:text-primary"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-6 text-secondary">{children}</div>
      </div>
    </div>
  );
};
