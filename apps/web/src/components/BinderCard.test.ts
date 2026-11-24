import { readFileSync } from "node:fs";
import { type Binder, type BinderSummary, CardAspectRatio } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BinderCard, binderHref } from "./BinderCard.tsx";

const BINDER_ID = "33333333-3333-4333-8333-333333333333";

const binder = (overrides: Partial<Binder> = {}): Binder => ({
  id: BINDER_ID,
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
  updatedAt: "2026-02-02T10:00:00.000Z",
  ...overrides,
});

const setSummary = (overrides: Partial<Binder> = {}): BinderSummary => ({
  binder: binder(overrides),
  set: {
    id: "sv08",
    nameFr: "Étincelles Déferlantes",
    code: "SSP",
    logoUrl: "https://assets.tcgdex.net/fr/sv/sv08/logo",
    seriesId: "sv",
    releaseDate: "2024-11-08",
    officialCount: 191,
    totalCount: 252,
  },
  completion: {
    setId: "sv08",
    officialCount: 191,
    totalCount: 252,
    targetCount: 252,
    ownedDistinct: 126,
    missingCount: 126,
    percent: 50,
    totalCopies: 140,
    duplicateCount: 14,
    duplicateCardCount: 10,
    status: "in_progress",
  },
  cardCount: 252,
  ownedCount: 126,
});

const customSummary = (overrides: Partial<Binder> = {}): BinderSummary => ({
  binder: binder({
    kind: "custom",
    setId: null,
    title: "Évolitions Favs",
    ...overrides,
  }),
  set: null,
  completion: null,
  cardCount: 12,
  ownedCount: 7,
});

const render = (props: Parameters<typeof BinderCard>[0]): string =>
  renderToStaticMarkup(h(BinderCard, props));

describe("BinderCard — cover set_logo", () => {
  it("shows the official set logo (.webp), centred with object-contain on a calm surface", () => {
    const html = render({ summary: setSummary() });
    expect(html).toContain('src="https://assets.tcgdex.net/fr/sv/sv08/logo.webp"');
    expect(html).toContain("object-contain");
    expect(html).toContain("bg-surface-2");
    expect(html).toContain('data-cover="set_logo"');
  });

  it("falls back to the set code when the logo is missing", () => {
    const summary = setSummary();
    const html = render({
      summary: { ...summary, set: summary.set === null ? null : { ...summary.set, logoUrl: null } },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain('data-testid="binder-cover-fallback"');
    expect(html).toContain("SSP");
  });

  it("falls back to a folder icon for a custom folder without cover", () => {
    const html = render({ summary: customSummary() });
    expect(html).not.toContain("<img");
    expect(html).toContain('data-testid="binder-cover-fallback"');
    expect(html).toContain("lucide-folder-heart");
  });
});

describe("BinderCard — cover card", () => {
  it("shows one whole card in the strict 63/88 ratio (low quality)", () => {
    const html = render({
      summary: setSummary({ coverType: "card", coverCardId: "sv08-238" }),
      coverCardImageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv08/238/",
    });
    expect(html).toContain('src="https://assets.tcgdex.net/fr/sv/sv08/238/low.webp"');
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).toContain('data-cover="card"');
    expect(html).not.toContain("object-contain");
  });

  it("falls back neatly when the cover card has no image", () => {
    const html = render({
      summary: setSummary({ coverType: "card", coverCardId: "sv08-238" }),
      coverCardImageBaseUrl: null,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain('data-testid="binder-cover-fallback"');
  });
});

describe("BinderCard — cover upload", () => {
  it("fills the frame via the secure proxy, cache-busted, with a subtle veil", () => {
    const html = render({
      summary: setSummary({ coverType: "upload", coverStoragePath: "u/b.webp" }),
    });
    expect(html).toContain(`src="/api/binders/${BINDER_ID}/cover?v=2026-02-02T10%3A00%3A00.000Z"`);
    expect(html).toContain("object-cover");
    expect(html).toContain("bg-linear-to-b");
    expect(html).not.toContain("storage/v1");
  });
});

describe("BinderCard — extension binder", () => {
  it("shows code, percent, gold bar and owned/total in tabular monospace", () => {
    const html = render({ summary: setSummary() });
    expect(html).toContain("SSP");
    expect(html).toContain("50 %");
    expect(html).toContain("126/252");
    expect(html).toContain("126 sur 252 cartes possédées");
    expect(html).toContain("bg-gold-bar");
    expect(html).toContain("width:50%");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html).not.toContain("Privé");
  });

  it("links to the binder grid", () => {
    const html = render({ summary: setSummary() });
    expect(html).toContain(`href="${binderHref(BINDER_ID)}"`);
    expect(html).toContain("Ouvrir le classeur Étincelles Déferlantes");
  });

  it("shows the pinned indicator only when pinned", () => {
    expect(render({ summary: setSummary() })).not.toContain("binder-pinned");
    const pinned = render({ summary: setSummary({ isPinned: true }) });
    expect(pinned).toContain('data-testid="binder-pinned"');
    expect(pinned).toContain("Épinglé");
  });
});

describe("BinderCard — custom folder", () => {
  it("shows the Private badge, card count and owned count (pluralised)", () => {
    const html = render({ summary: customSummary() });
    expect(html).toContain("Privé");
    expect(html).toContain("12 cartes");
    expect(html).toContain("7 possédées");
    expect(html).toContain('data-kind="custom"');
    expect(html).not.toContain('role="progressbar"');
  });

  it("uses the singular forms", () => {
    const html = render({ summary: { ...customSummary(), cardCount: 1, ownedCount: 1 } });
    expect(html).toContain("1 carte<");
    expect(html).toContain("1 possédée<");
  });

  it("shows the pinned indicator when pinned", () => {
    expect(render({ summary: customSummary({ isPinned: true }) })).toContain("binder-pinned");
  });
});

describe("BinderCard — settings button & first-visit loading", () => {
  it("renders no settings button without a handler", () => {
    expect(render({ summary: setSummary() })).not.toContain("Réglages du classeur");
  });

  it("renders a discreet ≥44px settings button, outside the link, when a handler is given", () => {
    const html = render({ summary: setSummary(), onOpenSettings: () => undefined });
    expect(html).toContain('aria-label="Réglages du classeur Étincelles Déferlantes"');
    expect(html).toContain("--touch-target-min");
    const link = html.slice(html.indexOf("<a "), html.indexOf("</a>"));
    expect(link).not.toContain("<button");
  });

  it("loads covers eagerly only when prioritised", () => {
    expect(render({ summary: setSummary() })).toContain('loading="lazy"');
    expect(render({ summary: setSummary(), priority: true })).toContain('loading="eager"');
  });
});

describe("BinderCard — Dark & Light via tokens only", () => {
  it("uses only token utilities (no raw colours, no dark: variants)", () => {
    const source = readFileSync(new URL("./BinderCard.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bdark:/);
    for (const token of [
      "bg-surface-1",
      "bg-surface-2",
      "border-line",
      "text-primary",
      "bg-gold-bar",
    ]) {
      expect(source).toContain(token);
    }
  });
});
