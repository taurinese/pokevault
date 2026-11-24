import { readFileSync } from "node:fs";
import type { Binder, BinderSummary, CardSearchHit } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type BinderSettingsActions,
  BinderSettingsSheet,
  type BinderSettingsState,
  BinderSettingsView,
  COVER_CARD_RESULTS_LIMIT,
  coverCardSearchQuery,
  coverErrorOf,
  coverTabsFor,
  fileSizeKo,
  infoErrorOf,
  initialBinderSettingsState,
} from "./BinderSettingsSheet.tsx";

const binderOf = (overrides: Partial<Binder> = {}): Binder => ({
  id: "33333333-3333-4333-8333-333333333333",
  userId: "11111111-1111-4111-8111-111111111111",
  kind: "set",
  setId: "sv08",
  title: "Étincelles Déferlantes",
  coverType: "set_logo",
  coverCardId: null,
  coverStoragePath: null,
  isPinned: false,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const setSummary = (overrides: Partial<Binder> = {}): BinderSummary => ({
  binder: binderOf(overrides),
  set: {
    id: "sv08",
    nameFr: "Étincelles Déferlantes",
    code: "SSP",
    logoUrl: null,
    seriesId: "sv",
    releaseDate: "2024-11-08",
    officialCount: 191,
    totalCount: 252,
  },
  completion: null,
  cardCount: 252,
  ownedCount: 0,
});

const folderSummary = (overrides: Partial<Binder> = {}): BinderSummary => ({
  binder: binderOf({ kind: "custom", setId: null, title: "Évolitions Favs", ...overrides }),
  set: null,
  completion: null,
  cardCount: 5,
  ownedCount: 2,
});

const hit = (id: string, nameFr: string): CardSearchHit => ({
  id,
  setId: "sv08",
  setName: "Étincelles Déferlantes",
  setCode: "SSP",
  localId: "001",
  localIdNumeric: 1,
  nameFr,
  rarity: null,
  holoEffect: "none",
  illustrator: null,
  imageUrl: `https://assets.tcgdex.net/fr/sv/sv08/${id}/low.webp`,
});

const noop = (): void => undefined;
const actions: BinderSettingsActions = {
  onTitleChange: noop,
  onPinnedChange: noop,
  onSaveInfo: noop,
  onCoverTabChange: noop,
  onCardQueryChange: noop,
  onPickCard: noop,
  onApplyLogo: noop,
  onPickFile: noop,
  onSubmitUpload: noop,
  onRequestDelete: noop,
  onCancelDelete: noop,
  onConfirmDelete: noop,
};

const render = (
  summary: BinderSummary = setSummary(),
  state: Partial<BinderSettingsState> = {},
  overrides: Partial<BinderSettingsActions> = {},
): string =>
  renderToStaticMarkup(
    h(BinderSettingsView, {
      summary,
      state: { ...initialBinderSettingsState(summary), ...state },
      actions: { ...actions, ...overrides },
    }),
  );

describe("BinderSettingsView — informations", () => {
  it("prefills the title (max 80, counter in tabular mono) and the pin switch", () => {
    const html = render(folderSummary({ isPinned: true }));
    expect(html).toContain('value="Évolitions Favs"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain("15 / 80");
    expect(html).toContain("tabular-nums");
    expect(html).toMatch(
      /type="checkbox"[^>]*checked=""[^>]*data-testid="settings-pin"|data-testid="settings-pin"[^>]*checked=""/,
    );
    expect(html).toContain("Épingler en haut");
    expect(html).toContain("Enregistrer");
  });

  it("surfaces validation errors as an alert linked to the field", () => {
    const html = render(setSummary(), {
      info: { saving: false, saved: false, error: "too_long" },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="binder-settings-title-error"');
    expect(html).toContain("Le nom ne peut pas dépasser 80 caractères.");
  });

  it("shows saving and saved feedback", () => {
    expect(render(setSummary(), { info: { saving: true, saved: false, error: null } })).toContain(
      "Enregistrement…",
    );
    const saved = render(setSummary(), { info: { saving: false, saved: true, error: null } });
    expect(saved).toContain('data-testid="settings-info-saved"');
    expect(saved).toContain("Modifications enregistrées.");
  });

  it("maps save results to displayable errors", () => {
    expect(infoErrorOf({ kind: "invalid_title", reason: "empty" })).toBe("empty");
    expect(infoErrorOf({ kind: "invalid_title", reason: "too_long" })).toBe("too_long");
    expect(infoErrorOf({ kind: "invalid" })).toBe("invalid");
    expect(infoErrorOf({ kind: "not_found" })).toBe("notFound");
    expect(infoErrorOf({ kind: "error" })).toBe("generic");
    expect(infoErrorOf({ kind: "unauthorized" })).toBeNull();
  });
});

describe("BinderSettingsView — couverture", () => {
  it("offers three tabs, the first one being the official logo (set) or a neutral visual (folder)", () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Logo officiel");
    expect(html).toContain("Une carte");
    expect(html).toContain("Image perso");
    expect(html).toMatch(/id="binder-cover-tab-logo"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="binder-cover-tab-card"[^>]*aria-selected="false"/);
    expect(html).toMatch(/id="binder-cover-tab-card"[^>]*tabindex="-1"/);
    expect(coverTabsFor("set").map((tab) => tab.labelKey)[0]).toBe("binderSettings.cover.tab.logo");
    expect(coverTabsFor("custom").map((tab) => tab.labelKey)[0]).toBe(
      "binderSettings.cover.tab.neutral",
    );
    expect(render(folderSummary())).toContain("Visuel neutre");
  });

  it("logo tab: one tap applies the logo; folders get the neutral wording", () => {
    const html = render();
    expect(html).toContain('data-testid="cover-apply-logo"');
    expect(html).toContain("Utiliser le logo officiel");
    const folder = render(folderSummary());
    expect(folder).toContain("Utiliser le visuel neutre");
    expect(folder).not.toContain("Utiliser le logo officiel");
    expect(
      render(setSummary(), { cover: { pending: "logo", saved: false, error: null } }),
    ).toContain("Mise à jour de la couverture…");
  });

  it("shows the current cover type", () => {
    expect(render(setSummary({ coverType: "upload" }))).toContain(
      "Couverture actuelle : Image perso",
    );
    expect(render(setSummary({ coverType: "card" }))).toContain("Couverture actuelle : Une carte");
  });

  it("card tab: scoped search for a set, whole catalogue for a custom folder, 63/88 thumbnails", () => {
    const ready = {
      coverTab: "card",
      cards: {
        status: "ready",
        hits: [hit("sv08-001", "Bulbizarre"), hit("sv08-002", "Herbizarre")],
      },
    } as const;
    const set = render(setSummary(), ready);
    expect(set).toContain('data-testid="cover-card-search"');
    expect(set).toContain("Cartes de Étincelles Déferlantes");
    expect(set).toContain('data-testid="cover-card-grid"');
    expect(set.match(/data-testid="cover-card-option"/g)).toHaveLength(2);
    expect(set).toContain('aria-label="Choisir Bulbizarre comme couverture"');
    expect(set).toContain("aspect-ratio");
    const folder = render(folderSummary(), ready);
    expect(folder).toContain("Tout le catalogue");
  });

  it("card tab: loading, empty and error states; the current card is pressed", () => {
    expect(render(setSummary(), { coverTab: "card", cards: { status: "loading" } })).toContain(
      "Recherche des cartes…",
    );
    expect(
      render(setSummary(), { coverTab: "card", cards: { status: "ready", hits: [] } }),
    ).toContain("Aucune carte trouvée.");
    expect(render(setSummary(), { coverTab: "card", cards: { status: "error" } })).toContain(
      "Recherche indisponible.",
    );
    const current = render(setSummary({ coverType: "card", coverCardId: "sv08-001" }), {
      coverTab: "card",
      cards: { status: "ready", hits: [hit("sv08-001", "Bulbizarre")] },
    });
    expect(current).toMatch(/aria-pressed="true"[^>]*data-testid="cover-card-option"/);
  });

  it("builds the catalogue query: scoped on the set, unscoped for folders, bounded", () => {
    expect(coverCardSearchQuery(setSummary(), "  bulbi ")).toEqual({
      q: "bulbi",
      scope: "cards",
      sort: "relevance",
      limit: COVER_CARD_RESULTS_LIMIT,
      offset: 0,
      setId: "sv08",
    });
    const custom = coverCardSearchQuery(folderSummary(), "");
    expect(custom).not.toHaveProperty("setId");
    expect(custom.q).toBe("");
  });

  it("upload tab: file input restricted to JPEG/PNG/WebP (never SVG) with the limits hint", () => {
    const html = render(setSummary(), { coverTab: "upload" });
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).not.toContain("image/svg");
    expect(html).toContain("2 Mo maximum");
    expect(html).toContain("sans métadonnées");
    expect(html).not.toContain('data-testid="cover-upload-submit"');
  });

  it("upload tab: local preview before sending, then submit / uploading states", () => {
    const upload = {
      file: { name: "ma-cover.png", size: 150_000 },
      previewUrl: "blob:http://localhost/preview",
    };
    const html = render(setSummary(), { coverTab: "upload", upload });
    expect(html).toContain('data-testid="cover-upload-preview"');
    expect(html).toContain('src="blob:http://localhost/preview"');
    expect(html).toContain("ma-cover.png");
    expect(html).toContain("147 Ko");
    expect(html).toContain("Envoyer l&#x27;image");
    const sending = render(setSummary(), {
      coverTab: "upload",
      upload,
      cover: { pending: "upload", saved: false, error: null },
    });
    expect(sending).toContain("Envoi en cours…");
    expect(sending).toMatch(
      /disabled=""[^>]*data-testid="cover-upload-submit"|data-testid="cover-upload-submit"[^>]*disabled=""/,
    );
  });

  it.each([
    ["too_large", "2 Mo maximum."],
    ["svg", "Les images SVG ne sont pas acceptées."],
    ["unsupported", "Format non pris en charge"],
    ["empty", "Ce fichier est vide."],
    ["invalid", "n'a pas pu être traitée"],
    ["notFound", "n'existe plus"],
    ["generic", "a échoué"],
  ] as const)("announces the cover error %s as an alert", (error, text) => {
    const html = render(setSummary(), {
      coverTab: "upload",
      cover: { pending: null, saved: false, error },
    });
    expect(html).toContain('data-testid="cover-error"');
    expect(html).toContain('role="alert"');
    expect(html.replace(/&#x27;/g, "'")).toContain(text);
  });

  it("confirms a saved cover", () => {
    expect(render(setSummary(), { cover: { pending: null, saved: true, error: null } })).toContain(
      "Couverture mise à jour.",
    );
  });

  it("maps cover results to displayable errors and formats sizes in Ko", () => {
    expect(coverErrorOf({ kind: "invalid_file", reason: "svg" })).toBe("svg");
    expect(coverErrorOf({ kind: "too_large" })).toBe("too_large");
    expect(coverErrorOf({ kind: "unsupported" })).toBe("unsupported");
    expect(coverErrorOf({ kind: "invalid" })).toBe("invalid");
    expect(coverErrorOf({ kind: "not_found" })).toBe("notFound");
    expect(coverErrorOf({ kind: "error" })).toBe("generic");
    expect(coverErrorOf({ kind: "unauthorized" })).toBeNull();
    expect(fileSizeKo(1)).toBe(1);
    expect(fileSizeKo(1024)).toBe(1);
    expect(fileSizeKo(1025)).toBe(2);
  });
});

describe("BinderSettingsView — zone danger (suppression en 2 étapes)", () => {
  it("step 1: only a 'Supprimer ce classeur' button, no confirmation yet", () => {
    const html = render();
    expect(html).toContain("Zone dangereuse");
    expect(html).toContain('data-testid="delete-request"');
    expect(html).toContain("Supprimer ce classeur");
    expect(html).not.toContain('data-testid="delete-confirm"');
    expect(html).not.toContain('data-testid="delete-confirm-submit"');
  });

  it("step 2: an in-sheet confirmation naming the binder (never window.confirm)", () => {
    const html = render(setSummary(), { deleteStep: "confirm" });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('data-testid="delete-confirm"');
    expect(html).toContain("Supprimer « Étincelles Déferlantes » ?");
    expect(html).toContain("Cette action est définitive");
    expect(html).toContain("Oui, supprimer définitivement");
    expect(html).toContain("Annuler");
    expect(html).not.toContain('data-testid="delete-request"');
  });

  it("disables the buttons while deleting and surfaces a failure as an alert", () => {
    const deleting = render(setSummary(), { deleteStep: "confirm", deleting: true });
    expect(deleting).toContain("Suppression…");
    expect(deleting).toMatch(
      /disabled=""[^>]*data-testid="delete-cancel"|data-testid="delete-cancel"[^>]*disabled=""/,
    );
    const failed = render(setSummary(), { deleteStep: "confirm", deleteError: true });
    expect(failed).toContain('data-testid="delete-error"');
    expect(failed).toContain("La suppression a échoué.");
  });
});

describe("BinderSettingsSheet", () => {
  const props = {
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onDeleted: vi.fn(),
    onUnauthorized: vi.fn(),
  };

  it("is not rendered without a binder", () => {
    expect(renderToStaticMarkup(h(BinderSettingsSheet, { summary: null, ...props }))).toBe("");
  });

  it("renders a titled dialog with the three sections for a given binder", () => {
    const html = renderToStaticMarkup(h(BinderSettingsSheet, { summary: setSummary(), ...props }));
    expect(html).toContain("<dialog");
    expect(html).toContain("Réglages du classeur");
    expect(html).toContain('data-testid="settings-info"');
    expect(html).toContain('data-testid="settings-cover"');
    expect(html).toContain('data-testid="settings-danger"');
  });

  it("starts on the card tab when the binder already uses a card cover", () => {
    expect(initialBinderSettingsState(setSummary({ coverType: "card" })).coverTab).toBe("card");
    expect(initialBinderSettingsState(setSummary({ coverType: "upload" })).coverTab).toBe("logo");
  });
});

describe("Dark & Light via tokens only, zero hard-coded UI string", () => {
  const source = readFileSync(new URL("./BinderSettingsSheet.tsx", import.meta.url), "utf8");

  it("uses only token utilities", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bdark:/);
  });

  it("never relies on window.confirm", () => {
    expect(source).not.toMatch(/\b(?:window\.)?confirm\(/);
  });

  it("routes every user-facing label through the i18n dictionary", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const jsxText = code.match(/(?<!=)>[ \t]*[A-Za-zÀ-ÿ][^<>{}\n;()=]*[ \t]*</g) ?? [];
    expect(jsxText).toEqual([]);
  });
});
