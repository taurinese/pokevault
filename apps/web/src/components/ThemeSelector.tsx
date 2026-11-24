import { useEffect, useState } from "react";
import { type TranslationKey, t } from "../i18n/index.ts";
import {
  applyThemePreference,
  DEFAULT_THEME,
  readThemePreference,
  THEME_CHANGE_EVENT,
  type ThemePreference,
} from "../lib/theme.ts";

export const THEME_OPTIONS = [
  { value: "system", labelKey: "theme.selector.system" },
  { value: "dark", labelKey: "theme.selector.dark" },
  { value: "light", labelKey: "theme.selector.light" },
] as const satisfies ReadonlyArray<{ value: ThemePreference; labelKey: TranslationKey }>;

/**
 * Contrôle segmenté `Auto / Sombre / Clair` (écran 09B). Boutons radio natifs
 * (navigation clavier flèches, lecteurs d'écran) stylés en segments.
 * Rend `dark` côté serveur puis se resynchronise sur `<html data-theme>` après
 * l'hydratation (zéro hydration mismatch) et sur le raccourci `ThemeToggle`.
 */
export const ThemeSelector = () => {
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME);

  useEffect(() => {
    const sync = () => setPreference(readThemePreference());
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return (
    <fieldset
      data-testid="theme-selector"
      className="m-0 flex min-w-0 gap-1 rounded-pill border border-line bg-surface-2 p-1"
    >
      <legend className="sr-only">{t("theme.selector.label")}</legend>
      {THEME_OPTIONS.map((option) => (
        <label key={option.value} className="relative flex flex-1 cursor-pointer">
          <input
            type="radio"
            name="theme-preference"
            value={option.value}
            checked={preference === option.value}
            onChange={() => applyThemePreference(option.value)}
            className="peer sr-only"
          />
          <span
            className="flex w-full items-center justify-center rounded-pill px-3 text-sm font-semibold text-secondary transition-colors peer-checked:bg-gold-soft peer-checked:text-gold peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-gold"
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            {t(option.labelKey)}
          </span>
        </label>
      ))}
    </fieldset>
  );
};
