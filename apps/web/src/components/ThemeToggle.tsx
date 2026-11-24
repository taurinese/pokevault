import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import {
  applyThemePreference,
  DEFAULT_THEME,
  readThemePreference,
  resolveTheme,
  THEME_CHANGE_EVENT,
} from "../lib/theme.ts";

const systemPrefersLight = (): boolean => {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
};

/** Thème effectif lu sur `<html data-theme>` (posé avant le rendu par le script inline). */
const readAppliedTheme = (): "dark" | "light" =>
  resolveTheme(readThemePreference(), systemPrefersLight());

/**
 * Raccourci 1-tap Dark / Light : écrit `data-theme` sur `<html>` (consommé par
 * `tokens.css`) et persiste le choix en `localStorage` (clé partagée avec le
 * script anti-FOUC de `__root.tsx`). Suit aussi les changements faits depuis le
 * `ThemeSelector` (Auto / Sombre / Clair). Repli `dark` en SSR (zéro hydration mismatch).
 */
export const ThemeToggle = () => {
  const [theme, setTheme] = useState<"dark" | "light">(DEFAULT_THEME);

  useEffect(() => {
    const sync = () => setTheme(readAppliedTheme());
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  const toggle = () => {
    // Émet THEME_CHANGE_EVENT : l'état local se resynchronise via l'écouteur ci-dessus.
    applyThemePreference(theme === "dark" ? "light" : "dark");
  };

  const Icon = theme === "dark" ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={theme === "light"}
      aria-label={t("theme.toggle", { theme: t(theme === "dark" ? "theme.dark" : "theme.light") })}
      className="flex items-center justify-center rounded-pill border border-line bg-surface-1 text-secondary shadow-card transition-colors hover:bg-surface-2 hover:text-primary"
      style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
    >
      <Icon size={20} aria-hidden="true" />
    </button>
  );
};
