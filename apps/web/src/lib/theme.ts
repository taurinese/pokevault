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

/**
 * Script bloquant inline placé dans `<head>` avant le premier rendu : pose
 * `data-theme` sur `<html>` pour zéro FOUC sur toutes les routes (y compris un
 * rafraîchissement direct sur `/collection`). Tout est dans un `try/catch`
 * (stockage bloqué, mode privé…) avec repli sur le thème par défaut.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});d.dataset.theme=t==="light"||t==="system"?t:${JSON.stringify(DEFAULT_THEME)}}catch(e){d.dataset.theme=${JSON.stringify(DEFAULT_THEME)}}})();`;

// ---------------------------------------------------------------------------
// Application côté navigateur (partagée par `ThemeToggle` et `ThemeSelector`)
// ---------------------------------------------------------------------------

/** Évènement `window` émis à chaque changement : garde toggle et sélecteur synchronisés. */
export const THEME_CHANGE_EVENT = "pokevault:theme-change";

/** Préférence courante lue sur `<html data-theme>` (posée avant le rendu par le script inline). */
export const readThemePreference = (): ThemePreference =>
  parseThemePreference(document.documentElement.dataset["theme"]);

/**
 * Applique une préférence : `data-theme` sur `<html>` (consommé par `tokens.css`),
 * persistance en `localStorage` (clé lue par le script anti-FOUC) puis notification.
 * Un stockage indisponible (mode privé, quota…) n'empêche pas l'application.
 */
export const applyThemePreference = (preference: ThemePreference): void => {
  document.documentElement.dataset["theme"] = preference;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Le thème reste appliqué pour la session.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
};
