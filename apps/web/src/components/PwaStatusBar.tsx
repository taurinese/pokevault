import { RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import {
  applyServiceWorkerUpdate,
  readOnlineStatus,
  registerServiceWorker,
  subscribeOnlineStatus,
} from "../lib/pwa.ts";

export interface PwaStatusBarViewProps {
  readonly isOnline: boolean;
  readonly updateAvailable: boolean;
  readonly onReload: () => void;
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/**
 * Vue pure du statut PWA (`docs/05-pwa-mobile.md §1`) :
 * - Bandeau discret « Mode hors-ligne · prix figés » lorsque le réseau est coupé.
 * - Toast discret « Nouvelle version disponible · Recharger » lorsqu'une nouvelle
 *   version du Service Worker est prête en attente (`waiting`).
 * Zéro couleur hex brute : tous les styles consomment les design tokens Dark & Light.
 */
export const PwaStatusBarView = ({
  isOnline,
  updateAvailable,
  onReload,
}: PwaStatusBarViewProps) => {
  if (isOnline && !updateAvailable) return null;

  return (
    <div
      data-testid="pwa-status-bar"
      className="pointer-events-none fixed inset-x-0 top-0 z-(--z-sheet) flex flex-col items-center gap-2 px-4 pt-2"
      style={{ paddingTop: "calc(0.5rem + var(--safe-area-inset-top))" }}
    >
      {!isOnline ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="pwa-offline-banner"
          className="pointer-events-auto flex items-center gap-2 rounded-pill border border-line bg-surface-1 px-4 py-2 text-xs font-semibold text-warning shadow-card"
        >
          <WifiOff size={14} aria-hidden="true" className="shrink-0" />
          <span>{t("pwa.offline.banner")}</span>
        </div>
      ) : null}

      {updateAvailable ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="pwa-update-toast"
          className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-card border border-line bg-surface-1 px-4 py-2 text-sm text-primary shadow-card"
        >
          <span className="flex items-center gap-2 font-medium">
            <RefreshCw size={16} aria-hidden="true" className="shrink-0 text-gold" />
            <span>{t("pwa.update.available")}</span>
          </span>
          <button
            type="button"
            data-testid="pwa-update-reload"
            aria-label={t("pwa.update.reloadAria")}
            onClick={onReload}
            className={`inline-flex shrink-0 items-center justify-center rounded-pill bg-gold-soft px-4 text-xs font-semibold text-gold transition-colors hover:bg-surface-2 ${focusRing}`}
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            {t("pwa.update.reload")}
          </button>
        </div>
      ) : null}
    </div>
  );
};

/**
 * Conteneur monté dans `__root.tsx` : enregistre `/sw.js` côté navigateur uniquement,
 * suit `navigator.onLine` + évènements `online`/`offline` et déclenche `SKIP_WAITING`
 * sur clic « Recharger ». Rend `null` en SSR (zéro hydration mismatch).
 */
export const PwaStatusBar = () => {
  const [isOnline, setIsOnline] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    setIsOnline(readOnlineStatus());
    const unsubscribe = subscribeOnlineStatus(setIsOnline);

    let active = true;
    void registerServiceWorker({
      onUpdateAvailable: (registration) => {
        if (!active) return;
        registrationRef.current = registration;
        setUpdateAvailable(true);
      },
    }).then((registration) => {
      if (active && registration !== null) {
        registrationRef.current = registration;
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleReload = (): void => {
    const applied = applyServiceWorkerUpdate(registrationRef.current);
    if (!applied && typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <PwaStatusBarView
      isOnline={isOnline}
      updateAvailable={updateAvailable}
      onReload={handleReload}
    />
  );
};
