import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import {
  DEFAULT_THEME,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
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
  resolveTheme(
    parseThemePreference(document.documentElement.dataset["theme"]),
    systemPrefersLight(),
  );

/**
 * Bascule Dark / Light : écrit `data-theme` sur `<html>` (consommé par
 * `tokens.css`) et persiste le choix en `localStorage` (clé partagée avec le
 * script anti-FOUC de `__root.tsx`). Repli `dark` en SSR (zéro hydration mismatch).
 */
export const ThemeToggle = () => {
  const [theme, setTheme] = useState<"dark" | "light">(DEFAULT_THEME);

  useEffect(() => {
    setTheme(readAppliedTheme());
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset["theme"] = next;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Stockage indisponible (mode privé, quota…) : le thème reste appliqué pour la session.
    }
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
