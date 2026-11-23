import { fr, type TranslationKey } from "./fr.ts";

export const DEFAULT_LOCALE = "fr-FR";
export const HTML_LANG = "fr";

export type { TranslationKey };
export type TranslationParams = Readonly<Record<string, string | number>>;

/**
 * Typed translation helper (`fr-FR` only for now).
 * Supports `{name}` placeholders; unknown placeholders are left untouched.
 */
export const t = (key: TranslationKey, params?: TranslationParams): string => {
  const template: string = fr[key];
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
};

/** Clés de base (sans suffixe) disposant d'une forme `_one` ET `_other`. */
export type PluralKey = {
  [K in TranslationKey]: K extends `${infer Base}_one`
    ? `${Base}_other` extends TranslationKey
      ? Base
      : never
    : never;
}[TranslationKey];

const pluralRules = new Intl.PluralRules(DEFAULT_LOCALE);

/**
 * Traduction pluralisée `fr-FR` (`Intl.PluralRules`) : choisit `<base>_one`
 * (0 et 1 en français) ou `<base>_other`, et injecte `{count}` automatiquement.
 */
export const tPlural = (base: PluralKey, count: number, params?: TranslationParams): string => {
  const suffix = pluralRules.select(count) === "one" ? "_one" : "_other";
  return t(`${base}${suffix}` as TranslationKey, { ...params, count });
};
