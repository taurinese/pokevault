/**
 * Helpers PWA client-safe (docs/05-pwa-mobile.md §1) :
 * - Configuration partagée du Service Worker (`/sw.js`, cache LRU TCGdex 600 / 30j)
 * - Détection iOS Safari hors mode standalone (`isIosSafariNonStandalone`)
 * - Assainissement anti open-redirect des URLs de notifications (`sanitizeNotificationUrl`)
 * - Enregistrement SW + détection de mise à jour contrôlée (`SKIP_WAITING`)
 * - Suivi réseau `online` / `offline` (sans casser le SSR)
 */

export {
  resolveThemeColor,
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  type ThemeColor,
} from "./theme.ts";

// ---------------------------------------------------------------------------
// Configuration du Service Worker (alignée sur `apps/web/public/sw.js`)
// ---------------------------------------------------------------------------

export const SW_SCRIPT_URL = "/sw.js";
export const SW_SCOPE = "/";
export const SW_MESSAGE_SKIP_WAITING = "SKIP_WAITING";
export const SW_MESSAGE_CLEAR_PRIVATE_CACHE = "CLEAR_PRIVATE_CACHE";
export const PWA_UPDATE_AVAILABLE_EVENT = "pokevault:sw-update-available";

export const SW_CACHE_CONFIG = {
  version: "v1",
  tcgdexImageOrigin: "https://assets.tcgdex.net",
  tcgdexImageMaxEntries: 600,
  tcgdexImageMaxAgeSeconds: 30 * 24 * 60 * 60,
  privateApiAllowlistPrefixes: [
    "/api/dashboard",
    "/api/binders",
    "/api/binder-grid/",
    "/api/wishlist",
    "/api/alerts",
    "/api/catalog/",
  ] as const,
  neverCacheApiPrefixes: [
    "/api/auth/",
    "/api/shared/",
    "/api/push-subscriptions",
    "/api/share-links",
  ] as const,
} as const;

// ---------------------------------------------------------------------------
// Détection iOS Safari hors mode standalone (Web Push iOS ≥ 16.4)
// ---------------------------------------------------------------------------

const IOS_DEVICE_RE = /iPhone|iPad|iPod/i;
const MAC_DESKTOP_RE = /Macintosh/i;
const SAFARI_ENGINE_RE = /Safari/i;
const WEBKIT_ENGINE_RE = /AppleWebKit/i;
const NON_SAFARI_IOS_BROWSER_RE =
  /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA|FBAN|FBAV|Instagram|Line|Twitter/i;

/**
 * Retourne `true` uniquement sur iOS / iPadOS Safari lancé dans le navigateur
 * (hors mode PWA installée / standalone). Exclut Chrome/Firefox/Edge iOS ainsi
 * que les apps déjà installées sur l'écran d'accueil.
 */
export const isIosSafariNonStandalone = (
  userAgent: string,
  isStandalone: boolean,
  maxTouchPoints = 0,
): boolean => {
  if (isStandalone) return false;
  if (userAgent.trim().length === 0) return false;

  const isIosDevice =
    IOS_DEVICE_RE.test(userAgent) || (MAC_DESKTOP_RE.test(userAgent) && maxTouchPoints > 1);
  if (!isIosDevice) return false;

  if (!SAFARI_ENGINE_RE.test(userAgent) || !WEBKIT_ENGINE_RE.test(userAgent)) return false;
  if (NON_SAFARI_IOS_BROWSER_RE.test(userAgent)) return false;

  return true;
};

interface StandaloneWindowLike {
  readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
  readonly navigator?: { readonly standalone?: boolean | undefined } | undefined;
}

/** Détecte si l'app tourne déjà en mode PWA installée (`display-mode: standalone` ou `navigator.standalone`). */
export const detectStandaloneMode = (
  win: StandaloneWindowLike | undefined = typeof window === "undefined"
    ? undefined
    : (window as unknown as StandaloneWindowLike),
): boolean => {
  if (win === undefined) return false;
  if (win.navigator?.standalone === true) return true;
  try {
    return win.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    return false;
  }
};

/** Détection côté client uniquement (renvoie `false` en SSR). */
export const detectIosSafariNonStandalone = (): boolean => {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return isIosSafariNonStandalone(
    navigator.userAgent,
    detectStandaloneMode(),
    navigator.maxTouchPoints ?? 0,
  );
};

// ---------------------------------------------------------------------------
// Assainissement URL `notificationclick` (anti open-redirect)
// ---------------------------------------------------------------------------

/**
 * Valide qu'une URL issue d'une notification Web Push reste strictement interne
 * à PokéVault :
 * - autorise un chemin relatif commençant par `/` (jamais `//`, sans `\` ni contrôle) ;
 * - convertit une URL absolue de même origine (`origin`) en chemin relatif sûr ;
 * - rejette tout protocole dangereux ou domaine externe et replie sur `fallback`.
 */
const hasForbiddenUrlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
};

export const sanitizeNotificationUrl = (
  rawUrl: unknown,
  origin?: string,
  fallback = "/alerts",
): string => {
  if (typeof rawUrl !== "string") return fallback;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return fallback;
  if (hasForbiddenUrlChars(trimmed)) return fallback;

  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) return fallback;
    try {
      const parsed = new URL(trimmed, "https://pokevault.local");
      if (parsed.origin !== "https://pokevault.local") return fallback;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return fallback;
    }
  }

  if (typeof origin === "string" && origin.length > 0) {
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.origin === origin
      ) {
        const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        return path.startsWith("/") && !path.startsWith("//") ? path : fallback;
      }
    } catch {
      return fallback;
    }
  }

  return fallback;
};

// ---------------------------------------------------------------------------
// Statut réseau `online` / `offline`
// ---------------------------------------------------------------------------

export interface OnlineNavigatorLike {
  readonly onLine?: boolean | undefined;
}

export interface OnlineEventTargetLike {
  readonly addEventListener: (type: "online" | "offline", listener: () => void) => void;
  readonly removeEventListener: (type: "online" | "offline", listener: () => void) => void;
}

/** Retourne `true` côté SSR (évite un flash hors-ligne à l'hydratation) et `navigator.onLine` côté client. */
export const readOnlineStatus = (
  nav: OnlineNavigatorLike | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean => {
  if (nav === undefined) return true;
  return nav.onLine !== false;
};

/** S'abonne aux évènements navigateur `online` / `offline` et retourne la fonction de désabonnement. */
export const subscribeOnlineStatus = (
  onChange: (isOnline: boolean) => void,
  target: OnlineEventTargetLike | undefined = typeof window === "undefined" ? undefined : window,
): (() => void) => {
  if (target === undefined) return () => undefined;
  const handleOnline = (): void => onChange(true);
  const handleOffline = (): void => onChange(false);
  target.addEventListener("online", handleOnline);
  target.addEventListener("offline", handleOffline);
  return () => {
    target.removeEventListener("online", handleOnline);
    target.removeEventListener("offline", handleOffline);
  };
};

// ---------------------------------------------------------------------------
// Enregistrement & cycle de vie du Service Worker (côté navigateur uniquement)
// ---------------------------------------------------------------------------

export interface RegisterServiceWorkerOptions {
  readonly onUpdateAvailable?: ((registration: ServiceWorkerRegistration) => void) | undefined;
}

/**
 * Enregistre `/sw.js` uniquement côté navigateur (`"serviceWorker" in navigator`).
 * Détecte une mise à jour en attente (`waiting`) ou fraîchement installée (`updatefound`)
 * sans forcer le rechargement : l'utilisateur confirme via le toast discret.
 */
export const registerServiceWorker = async (
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> => {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register(SW_SCRIPT_URL, {
      scope: SW_SCOPE,
    });

    const notifyUpdate = (): void => {
      options.onUpdateAvailable?.(registration);
      window.dispatchEvent(new Event(PWA_UPDATE_AVAILABLE_EVENT));
    };

    if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
      notifyUpdate();
    }

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (installing === null) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller !== null) {
          notifyUpdate();
        }
      });
    });

    return registration;
  } catch {
    // Enregistrement impossible (navigation privée stricte, contexte non sécurisé…) : silencieux.
    return null;
  }
};

/**
 * Demande au Service Worker en attente de prendre la main (`SKIP_WAITING`), puis
 * recharge la page dès `controllerchange` (au plus une fois).
 */
export const applyServiceWorkerUpdate = (
  registration: ServiceWorkerRegistration | null | undefined,
  onReload?: () => void,
): boolean => {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const waiting = registration?.waiting;
  if (waiting === null || waiting === undefined) return false;

  const reload = onReload ?? (() => window.location.reload());
  if ("serviceWorker" in navigator) {
    let reloaded = false;
    const onControllerChange = (): void => {
      if (reloaded) return;
      reloaded = true;
      reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange, {
      once: true,
    });
  }

  waiting.postMessage({ type: SW_MESSAGE_SKIP_WAITING });
  return true;
};

/** Demande au Service Worker actif de purger les caches privés (ex. déconnexion). */
export const clearPrivateServiceWorkerCache = (): void => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.controller?.postMessage({ type: SW_MESSAGE_CLEAR_PRIVATE_CACHE });
};
