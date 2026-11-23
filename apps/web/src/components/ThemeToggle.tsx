import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";

export type ThemePreference = "dark" | "light";

const THEME_STORAGE_KEY = "pokevault:theme";

const readInitialTheme = (): ThemePreference => {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "dark";
};

/**
 * Bascule Dark / Light : écrit `data-theme` sur `<html>` (consommé par
 * `tokens.css`), persiste le choix en `localStorage`. Par défaut : dark.
 */
export const ThemeToggle = () => {
  const [theme, setTheme] = useState<ThemePreference>("dark");

  useEffect(() => {
    const initial = readInitialTheme();
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  const toggle = () => {
    const next: ThemePreference = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
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
