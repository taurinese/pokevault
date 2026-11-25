/**
 * Thème — règle unique :
 * - **Dark par défaut** quand aucune préférence n'est stockée (ou illisible),
 *   conforme à `docs/02-modele-des-donnees.md` (`DEFAULT 'dark'`) ;
 * - `data-theme="dark" | "light"` : thème explicite ;
 * - `data-theme="system"` : on suit `prefers-color-scheme` (cf. `tokens.css`).
 */
export type ThemePreference = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "pokevault-theme";
export const DEFAULT_THEME = "dark" satisfies ThemePreference;

/** Couleurs de la barre système navigateur / PWA (`<meta name="theme-color">`, docs/05 §1). */
export const THEME_COLOR_DARK = "#0B0D12";
export const THEME_COLOR_LIGHT = "#F4F6FA";
export type ThemeColor = typeof THEME_COLOR_DARK | typeof THEME_COLOR_LIGHT;

export const parseThemePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "system" || value === "dark" ? value : DEFAULT_THEME;

/** Résout une préférence en thème effectif (`system` → média query). */
export const resolveTheme = (
  preference: ThemePreference,
  systemPrefersLight: boolean,
): "dark" | "light" => {
  if (preference === "system") return systemPrefersLight ? "light" : "dark";
  return preference;
};

/** Résout une préférence en couleur `<meta name="theme-color">` (`#0B0D12` Dark / `#F4F6FA` Light). */
export const resolveThemeColor = (
  preference: ThemePreference,
  systemPrefersLight: boolean,
): ThemeColor =>
  resolveTheme(preference, systemPrefersLight) === "light" ? THEME_COLOR_LIGHT : THEME_COLOR_DARK;

/**
 * Script bloquant inline placé dans `<head>` avant le premier rendu : pose
 * `data-theme` sur `<html>` ET synchronise `<meta name="theme-color">` pour zéro
 * FOUC sur toutes les routes (y compris un rafraîchissement direct sur `/collection`).
 * Tout est dans un `try/catch` (stockage bloqué, mode privé…) avec repli sur le thème par défaut.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;var p=${JSON.stringify(DEFAULT_THEME)};try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});p=t==="light"||t==="system"?t:${JSON.stringify(DEFAULT_THEME)};}catch(e){}d.dataset.theme=p;try{var l=p==="light"||(p==="system"&&typeof window!=="undefined"&&typeof window.matchMedia==="function"&&window.matchMedia("(prefers-color-scheme: light)").matches);var m=typeof document.querySelector==="function"?document.querySelector('meta[name="theme-color"]'):null;if(m)m.setAttribute("content",l?${JSON.stringify(THEME_COLOR_LIGHT)}:${JSON.stringify(THEME_COLOR_DARK)});}catch(e){}})();`;

// ---------------------------------------------------------------------------
// Application côté navigateur (partagée par `ThemeToggle` et `ThemeSelector`)
// ---------------------------------------------------------------------------

/** Évènement `window` émis à chaque changement : garde toggle et sélecteur synchronisés. */
export const THEME_CHANGE_EVENT = "pokevault:theme-change";

/** Préférence courante lue sur `<html data-theme>` (posée avant le rendu par le script inline). */
export const readThemePreference = (): ThemePreference =>
  parseThemePreference(document.documentElement.dataset["theme"]);

const readSystemPrefersLight = (): boolean => {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches
    );
  } catch {
    return false;
  }
};

/** Met à jour `<meta name="theme-color">` selon la préférence active (Dark `#0B0D12` / Light `#F4F6FA`). */
export const syncThemeColorMeta = (preference: ThemePreference): void => {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta === null) return;
  meta.setAttribute("content", resolveThemeColor(preference, readSystemPrefersLight()));
};

/**
 * Écoute les changements système `prefers-color-scheme` pour garder `<meta name="theme-color">`
 * synchronisé lorsque l'utilisateur est sur la préférence `system`.
 */
export const subscribeSystemThemeColor = (): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = (): void => {
    syncThemeColorMeta(readThemePreference());
  };
  onChange();
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }
  return () => undefined;
};

/**
 * Applique une préférence : `data-theme` sur `<html>` (consommé par `tokens.css`),
 * synchronisation `<meta name="theme-color">`, persistance en `localStorage`
 * (clé lue par le script anti-FOUC) puis notification.
 * Un stockage indisponible (mode privé, quota…) n'empêche pas l'application.
 */
export const applyThemePreference = (preference: ThemePreference): void => {
  document.documentElement.dataset["theme"] = preference;
  syncThemeColorMeta(preference);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Le thème reste appliqué pour la session.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
};
