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
