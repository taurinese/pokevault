import { describe, expect, it } from "vitest";
import { fr, type TranslationKey } from "./fr.ts";
import { DEFAULT_LOCALE, HTML_LANG, t, tPlural } from "./index.ts";

describe("i18n fr-FR", () => {
  it("uses fr-FR as default locale", () => {
    expect(DEFAULT_LOCALE).toBe("fr-FR");
    expect(HTML_LANG).toBe("fr");
  });

  it("returns the French label for a key", () => {
    expect(t("app.name")).toBe("PokéVault");
    expect(t("notFound.backHome")).toBe("Retour à l'accueil");
  });

  it("interpolates {placeholders}", () => {
    expect(t("home.cardRatio", { ratio: "0,716" })).toBe("Ratio officiel des cartes : 0,716");
  });

  it("keeps unknown placeholders untouched", () => {
    expect(t("home.cardRatio", { other: 1 })).toBe("Ratio officiel des cartes : {ratio}");
  });

  it("has a non-empty label for every key", () => {
    const keys = Object.keys(fr) as Array<TranslationKey>;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(t(key).trim()).not.toBe("");
    }
  });
});

describe("tPlural (fr-FR)", () => {
  it("uses the singular form for 0 and 1 (French rule)", () => {
    expect(tPlural("nav.alertsUnread", 0)).toBe("0 alerte non lue");
    expect(tPlural("nav.alertsUnread", 1)).toBe("1 alerte non lue");
  });

  it("uses the plural form for 2 and more", () => {
    expect(tPlural("nav.alertsUnread", 2)).toBe("2 alertes non lues");
    expect(tPlural("nav.alertsUnread", 12)).toBe("12 alertes non lues");
  });

  it("injects extra params alongside {count}", () => {
    expect(tPlural("cardTile.duplicate", 1, { name: "Mew" })).toBe("Carte en 1 exemplaire : Mew");
    expect(tPlural("cardTile.duplicate", 3, { name: "Mew" })).toBe("Carte en 3 exemplaires : Mew");
  });
});
