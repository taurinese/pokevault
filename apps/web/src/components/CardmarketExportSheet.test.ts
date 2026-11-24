import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXPORT_OPTIONS, type WishlistEnrichedItem } from "../lib/wishlist-client.ts";
import {
  buildExportModel,
  type CardmarketExportActions,
  CardmarketExportContent,
  CardmarketExportSheet,
  type CopyStatus,
  type ExportFormat,
  summarizeWarnings,
} from "./CardmarketExportSheet.tsx";

const NOW = new Date("2026-03-01T10:00:00.000Z");

let counter = 0;
const item = (overrides: Partial<WishlistEnrichedItem> = {}): WishlistEnrichedItem => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    userId: "11111111-1111-4111-8111-111111111111",
    cardId: `sv03.5-${counter}`,
    language: "FR",
    variant: "normal",
    minCondition: "NM",
    priority: "normal",
    targetPriceCents: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    localId: String(counter),
    nameFr: `Carte ${counter}`,
    nameEn: `Card ${counter}`,
    rarity: null,
    imageBaseUrl: null,
    setId: "sv03.5",
    setCode: "SV03.5",
    cardmarketSetCode: "MEW",
    setNameFr: "151",
    trendCents: 1000,
    lowFrCents: null,
    avg30Cents: null,
    priceSource: "cardmarket",
    priceFetchedAt: "2026-03-01T09:59:00.000Z",
    priceExpiresAt: "2026-03-01T10:14:00.000Z",
    priceIsFresh: true,
    ...overrides,
  };
};

const ITEMS: ReadonlyArray<WishlistEnrichedItem> = [
  item({
    cardId: "sv03.5-199",
    localId: "199",
    nameFr: "Dracaufeu ex",
    nameEn: "Charizard ex",
    variant: "holo",
    priority: "high",
    targetPriceCents: 1500,
    language: "EN",
  }),
  item({ cardId: "sv03.5-25", localId: "25", nameFr: "Pikachu", nameEn: "Pikachu" }),
  item({
    cardId: "sv08-10",
    localId: "10",
    nameFr: "Évoli",
    nameEn: null,
    setId: "sv08",
    setCode: null,
    cardmarketSetCode: null,
    setNameFr: "Étincelles Déferlantes",
  }),
];

const noActions = (): CardmarketExportActions => ({
  onOptionsChange: vi.fn(),
  onFormatChange: vi.fn(),
  onDownload: vi.fn(),
  onCopy: vi.fn(),
});

const render = (
  props: {
    readonly items?: ReadonlyArray<WishlistEnrichedItem>;
    readonly options?: Partial<typeof DEFAULT_EXPORT_OPTIONS>;
    readonly format?: ExportFormat;
    readonly copyStatus?: CopyStatus;
    readonly actions?: CardmarketExportActions;
  } = {},
): string => {
  const items = props.items ?? ITEMS;
  const options = { ...DEFAULT_EXPORT_OPTIONS, ...props.options };
  return renderToStaticMarkup(
    h(CardmarketExportContent, {
      items,
      options,
      format: props.format ?? "csv",
      copyStatus: props.copyStatus ?? "idle",
      model: buildExportModel(items, options, NOW),
      actions: props.actions ?? noActions(),
    }),
  );
};

/** Balise ouvrante portant `data-testid="<id>"` (indépendant de l'ordre des attributs). */
const tagOf = (html: string, testId: string): string =>
  (html.match(/<[a-z]+[^>]*>/g) ?? []).find((tag) => tag.includes(`data-testid="${testId}"`)) ?? "";

/** `true` si le radio `name`/`value` est rendu coché (indépendant de l'ordre des attributs). */
const isChecked = (html: string, name: string, value: string): boolean =>
  (html.match(/<input[^>]*>/g) ?? []).some(
    (input) =>
      input.includes(`name="${name}"`) &&
      input.includes(`value="${value}"`) &&
      input.includes('checked=""'),
  );

describe("buildExportModel", () => {
  it("generates both outputs from the enriched wishlist with the pure domain generators", () => {
    const model = buildExportModel(ITEMS, DEFAULT_EXPORT_OPTIONS, NOW);
    expect(model.csv.rowCount).toBe(3);
    expect(model.csv.filename).toBe("wants-cardmarket-2026-03-01.csv");
    expect(model.csv.content.split("\r\n")[0]).toBe(
      "qty,name,set_code,number,language,min_condition,foil_only",
    );
    expect(model.addList.lineCount).toBe(3);
    expect(model.addList.content).toContain("1 Charizard ex (MEW 199)\n");
  });

  it("applies the scope, language, foil and min-condition override options", () => {
    const high = buildExportModel(
      ITEMS,
      { ...DEFAULT_EXPORT_OPTIONS, scope: "high_priority" },
      NOW,
    );
    expect(high.csv.rowCount).toBe(1);
    const set = buildExportModel(
      ITEMS,
      { ...DEFAULT_EXPORT_OPTIONS, scope: "set", setId: "sv08" },
      NOW,
    );
    expect(set.csv.rowCount).toBe(1);
    const fr = buildExportModel(ITEMS, { ...DEFAULT_EXPORT_OPTIONS, language: "FR" }, NOW);
    expect(fr.csv.rowCount).toBe(2);
    const foil = buildExportModel(ITEMS, { ...DEFAULT_EXPORT_OPTIONS, foilOnly: true }, NOW);
    expect(foil.csv.rowCount).toBe(1);
    const override = buildExportModel(
      ITEMS,
      { ...DEFAULT_EXPORT_OPTIONS, minConditionOverride: "LP" },
      NOW,
    );
    expect(override.csv.content).toContain(",LP,");
    expect(override.csv.content).not.toContain(",NM,");
  });
});

describe("summarizeWarnings", () => {
  it("keeps one entry per set without Cardmarket code and counts missing English names", () => {
    const model = buildExportModel(ITEMS, DEFAULT_EXPORT_OPTIONS, NOW);
    const summary = summarizeWarnings(model.csv.warnings);
    expect(summary.missingCodes.map((warning) => warning.setId)).toEqual(["sv08"]);
    expect(summary.missingEnglishCount).toBe(1);
  });
});

describe("CardmarketExportContent (06C)", () => {
  it("offers the 4 scopes as native radios, `Toute la wishlist` checked by default", () => {
    const html = render();
    for (const label of [
      "Toute la wishlist",
      "Prioritaires",
      "Sous seuil atteint",
      "Une extension",
    ]) {
      expect(html).toContain(label);
    }
    expect(isChecked(html, "export-scope", "all")).toBe(true);
    expect(isChecked(html, "export-scope", "high_priority")).toBe(false);
    expect(html).not.toContain('data-testid="export-set-select"');
  });

  it("shows the set selector with the sets present in the wishlist for the `Une extension` scope", () => {
    const html = render({ options: { scope: "set", setId: "sv08" } });
    expect(html).toContain('data-testid="export-set-select"');
    expect(html).toMatch(/<option value="sv08" selected="">Étincelles Déferlantes \(1\)<\/option>/);
    expect(html).toContain("151 (2)");
  });

  it("offers the languages Toutes / FR / EN / JP / ZH", () => {
    const html = render({ options: { language: "EN" } });
    for (const code of ["ALL", "FR", "EN", "JP", "ZH"]) {
      expect(html).toContain(`value="${code}"`);
    }
    expect(isChecked(html, "export-language", "EN")).toBe(true);
    expect(isChecked(html, "export-language", "ALL")).toBe(false);
  });

  it("exposes a single, unambiguous minimum condition (override) select: per card by default", () => {
    const html = render();
    expect(html.match(/data-testid="export-condition-select"/g)).toHaveLength(1);
    expect(html).toContain("État minimum exporté");
    expect(html).toContain("Par carte (défaut)");
    for (const code of ["M", "NM", "EX", "GD", "LP", "PL", "PO"]) {
      expect(html).toContain(`<option value="${code}">${code} · `);
    }
    expect(html).toMatch(/<option value="" selected="">Par carte \(défaut\)<\/option>/);
    const chosen = render({ options: { minConditionOverride: "EX" } });
    expect(chosen).toMatch(/<option value="EX" selected="">/);
  });

  it("renders the foil switch as role=switch with aria-checked and a 44px touch target", () => {
    const off = render();
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off).toContain("Foil / Holo uniquement");
    expect(off).toMatch(/data-testid="export-foil-switch"[^>]*min-width:var\(--touch-target-min\)/);
    const on = render({ options: { foilOnly: true } });
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
  });

  it("previews the CSV by default with a monospace tabular counter", () => {
    const html = render({ options: { scope: "high_priority" } });
    expect(html).toContain('data-testid="export-preview"');
    expect(html).toContain("qty,name,set_code,number,language,min_condition,foil_only");
    expect(html).toContain("1,Charizard ex,MEW,199,EN,NM,true");
    expect(html).toMatch(/data-testid="export-count"[^>]*>1 ligne</);
    expect(html).toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toMatch(/<pre[^>]*font-mono/);
  });

  it("previews the Add Card List text when selected, with its own line counter", () => {
    const html = render({ format: "addList" });
    expect(isChecked(html, "export-format", "addList")).toBe(true);
    expect(isChecked(html, "export-format", "csv")).toBe(false);
    expect(html).toContain("1 Charizard ex (MEW 199)");
    expect(html).toContain("1 Pikachu (MEW 25)");
    expect(html).not.toContain("qty,name,set_code");
    expect(html).toMatch(/data-testid="export-count"[^>]*>3 lignes</);
  });

  it("shows the effect of the min-condition override in the CSV preview", () => {
    const html = render({ options: { minConditionOverride: "PL" } });
    expect(html).toContain(",PL,");
  });

  it("shows non-blocking warnings: missing Cardmarket code (with fallback) and missing English name", () => {
    const html = render();
    expect(html).toContain('data-testid="export-warnings"');
    expect(html).toContain("À vérifier avant l&#x27;import");
    expect(html).toContain("Étincelles Déferlantes");
    expect(html).toContain("code Cardmarket inconnu");
    expect(html).toContain("1 carte sans nom anglais");
    // Non bloquant : l'export reste actif.
    expect(tagOf(html, "export-download")).not.toContain('disabled=""');
  });

  it("shows no warning block when everything is exportable", () => {
    const html = render({ items: [ITEMS[0] as WishlistEnrichedItem] });
    expect(html).not.toContain('data-testid="export-warnings"');
  });

  it("gives the primary gold download button its exact label and enables both actions", () => {
    const html = render();
    expect(html).toContain("Télécharger wants-cardmarket.csv");
    expect(html).toContain("Copier pour « Add Card List »");
    expect(tagOf(html, "export-download")).toContain("bg-gold-bar");
    expect(tagOf(html, "export-download")).not.toContain('disabled=""');
    expect(tagOf(html, "export-copy")).not.toContain('disabled=""');
  });

  it("disables both outputs and explains why when no row matches the filters", () => {
    const html = render({ options: { language: "JP" } });
    expect(html).toContain('data-testid="export-preview-empty"');
    expect(html).toContain("Aucune carte ne correspond à ces filtres.");
    expect(html).not.toContain('data-testid="export-preview"');
    expect(tagOf(html, "export-download")).toContain('disabled=""');
    expect(tagOf(html, "export-copy")).toContain('disabled=""');
    expect(html).toMatch(/data-testid="export-count"[^>]*>0 ligne</);
  });

  it("announces the clipboard result politely, and the region always exists", () => {
    const idle = render();
    expect(idle).toMatch(/role="status" aria-live="polite" data-testid="export-copy-status"/);
    expect(render({ copyStatus: "done" })).toContain("Copié dans le presse-papier");
    expect(idle).not.toContain("Copié dans le presse-papier");
    expect(render({ copyStatus: "error" })).toContain("Copie impossible");
  });
});

describe("CardmarketExportSheet (BottomSheet)", () => {
  const renderSheet = (open: boolean, items: ReadonlyArray<WishlistEnrichedItem> = ITEMS): string =>
    renderToStaticMarkup(h(CardmarketExportSheet, { open, onClose: () => undefined, items }));

  it("renders nothing while closed", () => {
    expect(renderSheet(false)).toBe("");
  });

  it("renders a titled dialog with the export content when open", () => {
    const html = renderSheet(true);
    expect(html).toContain("<dialog");
    expect(html).toContain("Export Cardmarket");
    expect(html).toContain("Télécharger wants-cardmarket.csv");
  });

  it("shows an informative empty state instead of the form for an empty wishlist", () => {
    const html = renderSheet(true, []);
    expect(html).toContain('data-testid="export-empty"');
    expect(html).not.toContain("export-download");
  });
});

describe("Dark & Light via tokens only, zero hard-coded UI string", () => {
  const source = readFileSync(new URL("./CardmarketExportSheet.tsx", import.meta.url), "utf8");

  it("uses only token utilities (no raw colours, no dark: variants)", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bdark:/);
  });

  it("routes every user-facing label through the i18n dictionary", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const jsxText = code.match(/>[ \t]*[A-Za-zÀ-ÿ][^<>{}\n;()=]*[ \t]*</g) ?? [];
    expect(jsxText).toEqual([]);
  });
});
