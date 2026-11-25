import { readFileSync } from "node:fs";
import {
  CardAspectRatio,
  type SharedBinderCard,
  type SharedBinderPayload,
} from "@pokevault/domain";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import {
  SharedBinderView,
  type SharedBinderViewActions,
  type SharedBinderViewState,
} from "./SharedBinderScreen.tsx";

const TOKEN = "T".repeat(43);

const makeCard = (index: number, overrides: Partial<SharedBinderCard> = {}): SharedBinderCard => ({
  cardId: `sv08.5-${index}`,
  localId: String(index),
  localIdNumeric: index,
  nameFr: `Carte ${index}`,
  setCode: "SV08.5",
  rarity: index % 2 === 0 ? "Commune" : "Rare",
  holoEffect: index === 2 ? "holo" : "none",
  imageBaseUrl: `https://assets.tcgdex.net/fr/sv/sv08.5/${index}`,
  owned: false,
  quantity: 0,
  copies: [],
  ...overrides,
});

const cards: ReadonlyArray<SharedBinderCard> = [
  makeCard(1, {
    owned: true,
    quantity: 1,
    copies: [{ language: "FR", variant: "normal", quantity: 1 }],
  }),
  makeCard(2, {
    owned: true,
    quantity: 3,
    copies: [
      { language: "FR", variant: "normal", quantity: 2 },
      { language: "EN", variant: "holo", quantity: 1 },
    ],
  }),
  makeCard(3),
  makeCard(4),
];

const payload = (
  overrides: { showQuantities?: boolean; hasUploadedCover?: boolean } = {},
): SharedBinderPayload => {
  const showQuantities = overrides.showQuantities ?? true;
  return {
    owner: { displayName: "Ada Lovelace", avatarInitials: "AL" },
    binder: {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "set",
      title: "Prisme Évolutif",
      setId: "sv08.5",
      setCode: "SV08.5",
      setName: "Prismatic Evolutions",
      coverType: overrides.hasUploadedCover === true ? "upload" : "set_logo",
      coverLogoUrl: "https://assets.tcgdex.net/fr/sv/sv08.5/logo",
      coverCardImageUrl: null,
      hasUploadedCover: overrides.hasUploadedCover ?? false,
      showQuantities,
      ownedCount: 2,
      totalCards: 4,
    },
    cards: showQuantities
      ? cards
      : cards.map((card) => ({
          ...card,
          quantity: null,
          copies: card.copies.map((copy) => ({ ...copy, quantity: null })),
        })),
  };
};

const noopActions = (): SharedBinderViewActions => ({
  onFilterChange: vi.fn(),
  onSelectCard: vi.fn(),
  onRetry: vi.fn(),
});

const render = async (
  state: Partial<SharedBinderViewState> & Pick<SharedBinderViewState, "load">,
  actions: SharedBinderViewActions = noopActions(),
): Promise<string> => {
  const full: SharedBinderViewState = {
    token: TOKEN,
    filter: "all",
    selectedCardId: null,
    ...state,
  };
  const rootRoute = createRootRoute({
    component: () => h(SharedBinderView, { state: full, actions }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

const ready = (
  overrides: Parameters<typeof payload>[0] = {},
): Pick<SharedBinderViewState, "load"> => ({
  load: { status: "ready", payload: payload(overrides) },
});

/** `renderToStaticMarkup` échappe l'apostrophe en `&#x27;`. */
const escaped = (text: string): string => text.replaceAll("'", "&#x27;");

const tilesOf = (html: string): string[] =>
  html.match(/<button[^>]*data-testid="shared-card"[^>]*>/g) ?? [];

describe("SharedBinderView · rendu public (09C)", () => {
  it("renders the read-only badge, the visitor theme toggle and the owner identity", async () => {
    const html = await render(ready());
    expect(html).toContain('data-testid="shared-header"');
    expect(html).toContain(fr["share.public.badge"]);
    // Toggle Dark/Light indépendant pour le visiteur.
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Basculer entre le thème sombre et le thème clair");
    expect(html).toMatch(/data-testid="shared-owner-avatar"[^>]*>AL</);
    expect(html).toContain("Classeur de Ada Lovelace");
    expect(html).toMatch(/data-testid="shared-title"[^>]*>Prisme Évolutif</);
    expect(html).toMatch(/data-testid="shared-set-code"[^>]*>SV08\.5</);
  });

  it("shows the completion with a monospace tabular-nums ratio and percentage", async () => {
    const html = await render(ready());
    expect(html).toMatch(/data-testid="shared-percent"[^>]*font-mono[^>]*tabular-nums[^>]*>50 %</);
    expect(html).toMatch(/data-testid="shared-owned-count"[^>]*font-mono[^>]*tabular-nums/);
    expect(html).toContain("2 / 4");
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("width:50%");
  });

  it("falls back to « Collectionneur » when the owner name is blank", async () => {
    const data = payload();
    const html = await render({
      load: {
        status: "ready",
        payload: { ...data, owner: { displayName: "  ", avatarInitials: "CO" } },
      },
    });
    expect(html).toContain("Classeur de Collectionneur");
  });

  it("renders the three exchange filters (Toutes · Doublons · Manquantes) with counts", async () => {
    const html = await render(ready());
    expect(html).toMatch(/data-testid="shared-filter-all"[^>]*aria-pressed="true"/);
    expect(html).toContain('data-testid="shared-filter-duplicates"');
    expect(html).toContain('data-testid="shared-filter-missing"');
    expect(html).toContain(">Toutes<");
    expect(html).toContain(">Doublons<");
    expect(html).toContain(">Manquantes<");
    // Toutes = 4, Doublons = 1 (carte ×3), Manquantes = 2.
    expect(html).toMatch(/shared-filter-all.*?>4<\/span>/);
    expect(html).toMatch(/shared-filter-duplicates.*?>1<\/span>/);
    expect(html).toMatch(/shared-filter-missing.*?>2<\/span>/);
  });

  it("renders a 3-column grid of strictly 63/88 tiles", async () => {
    const html = await render(ready());
    expect(html).toContain('data-testid="shared-grid"');
    expect(html).toContain("grid-cols-3");
    expect(tilesOf(html)).toHaveLength(4);
    expect(html.split(`aspect-ratio:${CardAspectRatio}`).length - 1).toBeGreaterThanOrEqual(4);
  });

  it("Doublons keeps only cards with quantity >= 2; Manquantes keeps !owned", async () => {
    const duplicates = await render({ ...ready(), filter: "duplicates" });
    expect(tilesOf(duplicates)).toHaveLength(1);
    expect(duplicates).toContain('data-card-id="sv08.5-2"');
    const missing = await render({ ...ready(), filter: "missing" });
    expect(tilesOf(missing)).toHaveLength(2);
    expect(missing).not.toContain('data-card-id="sv08.5-1"');
    expect(missing).toMatch(/data-state="missing"/);
    expect(missing).not.toMatch(/data-state="owned"/);
  });

  it("dims missing cards and shows the ×N badge only for quantity >= 2", async () => {
    const html = await render(ready());
    expect(html).toContain("saturate-0 opacity-30");
    expect(html).toContain("×3");
    // Une carte à 1 exemplaire n'a pas de badge.
    expect(html).not.toContain("×1<");
    expect(html).toMatch(/data-card-id="sv08.5-2"[^>]*data-state="duplicate"/);
  });

  it("shows NO quantity and no Doublons filter when showQuantities is false", async () => {
    const html = await render({ ...ready({ showQuantities: false }) });
    expect(html).not.toContain("×");
    expect(html).not.toContain('data-testid="shared-filter-duplicates"');
    expect(html).toContain('data-testid="shared-filter-missing"');
    expect(html).not.toMatch(/data-state="duplicate"/);
    // Même un filtre « Doublons » résiduel retombe sur Toutes (aucune déduction possible).
    const stale = await render({ ...ready({ showQuantities: false }), filter: "duplicates" });
    expect(tilesOf(stale)).toHaveLength(4);
  });

  it("shows a clean empty state per filter", async () => {
    const none = await render({
      load: {
        status: "ready",
        payload: { ...payload(), cards: cards.filter((card) => card.owned) },
      },
      filter: "missing",
    });
    expect(none).toContain('data-testid="shared-empty"');
    expect(none).toContain(fr["share.public.empty.missing.title"]);
    expect(none).toContain('data-testid="shared-empty-reset"');
    const empty = await render({
      load: { status: "ready", payload: { ...payload(), cards: [] } },
    });
    expect(empty).toContain(fr["share.public.empty.all.title"]);
    expect(empty).not.toContain('data-testid="shared-empty-reset"');
  });

  it("uses the public cover proxy for an uploaded cover, never a Storage path or user id", async () => {
    const html = await render(ready({ hasUploadedCover: true }));
    expect(html).toContain(`src="/api/shared/${TOKEN}/cover"`);
    expect(html).not.toContain("binder-covers");
    expect(html).not.toContain("user_id");
  });

  it("uses the set logo for a non-uploaded cover", async () => {
    const html = await render(ready());
    expect(html).toContain('src="https://assets.tcgdex.net/fr/sv/sv08.5/logo.webp"');
    expect(html).not.toContain("/cover");
  });
});

describe("SharedBinderView · Bottom Sheet lecture seule d'une carte", () => {
  it("shows the large 63/88 visual, name, number, rarity, languages/variants and quantities", async () => {
    const html = await render({ ...ready(), selectedCardId: "sv08.5-2" });
    expect(html).toContain('data-testid="shared-card-sheet"');
    expect(html).toContain("<dialog");
    expect(html).toContain("Carte 2");
    expect(html).toMatch(/data-testid="shared-card-number"[^>]*>N° 2</);
    expect(html).toMatch(/data-testid="shared-card-rarity"[^>]*>Rareté : Commune</);
    expect(html).toContain("https://assets.tcgdex.net/fr/sv/sv08.5/2/high.webp");
    expect(html).toContain("Français (FR) · Normal");
    expect(html).toContain("Anglais (EN) · Holo");
    expect(html).toContain("×2");
    expect(html).toContain("×1");
    // Emplacement prêt pour l'Inspecteur 3D Holo (M5) : l'effet est exposé.
    expect(html).toMatch(/data-testid="shared-card-holo-slot"[^>]*data-holo-effect="holo"/);
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
  });

  it("hides quantities in the sheet when showQuantities is false", async () => {
    const html = await render({ ...ready({ showQuantities: false }), selectedCardId: "sv08.5-2" });
    const sheet = html.slice(html.indexOf('data-testid="shared-card-sheet"'));
    expect(sheet).toContain("Français (FR) · Normal");
    expect(sheet).not.toContain("×2");
    expect(sheet).not.toContain("×1");
    expect(sheet).toContain('data-testid="shared-quantities-hidden"');
  });

  it("says a missing card is not in the collection", async () => {
    const html = await render({ ...ready(), selectedCardId: "sv08.5-3" });
    expect(html).toMatch(/data-testid="shared-card-ownership"[^>]*>Pas dans la collection</);
    expect(html).not.toContain('data-testid="shared-card-copy"');
  });

  it("renders no sheet content for an unknown card id", async () => {
    const html = await render({ ...ready(), selectedCardId: "nope" });
    expect(html).not.toContain('data-testid="shared-card-sheet"');
  });
});

describe("SharedBinderView · lecture seule stricte, zéro donnée privée", () => {
  it("exposes no edit control, form, price, note, wishlist or e-mail (grid and sheet)", async () => {
    const html = await render({ ...ready(), selectedCardId: "sv08.5-2" });
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("card-tile-price");
    expect(html).not.toContain("binder-settings");
    expect(html).not.toContain("binder-share");
    expect(html).not.toContain("badge-wishlist");
    expect(html).not.toMatch(/Ajouter|Modifier|Supprimer|Éditer|Acheter|Wishlist|wishlist|@/);
    expect(html).not.toMatch(/purchase|user_id|userId|email/i);
    // Seuls des boutons de consultation : filtres, thème, tuiles, fermeture de la feuille.
    const labels = [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
    for (const button of labels) {
      expect(button).toMatch(
        /data-testid="shared-(filter-[a-z]+|card)"|aria-pressed|aria-label="Fermer la feuille"/,
      );
    }
  });

  it("reminds that no e-mail, purchase price or private note is shared", async () => {
    const html = await render(ready());
    expect(html).toContain(escaped(fr["share.public.footer"]));
  });
});

describe("SharedBinderView · états", () => {
  it("renders a clean 404 / revoked state without any binder data", async () => {
    const html = await render({ load: { status: "not-found" } });
    expect(html).toContain('data-testid="shared-not-found"');
    expect(html).toContain(escaped(fr["share.public.notFound.title"]));
    expect(html).toContain(escaped(fr["share.public.notFound.description"]));
    expect(html).toContain('data-testid="shared-header"');
    expect(html).not.toContain('data-testid="shared-grid"');
    expect(html).not.toContain('data-testid="shared-title"');
  });

  it("renders the loading skeleton and the retryable error state", async () => {
    const loading = await render({ load: { status: "loading" } });
    expect(loading).toContain('data-testid="shared-loading"');
    const error = await render({ load: { status: "error" } });
    expect(error).toContain('data-testid="shared-error"');
    expect(error).toContain('data-testid="shared-retry"');
  });
});

describe("SharedBinderScreen · tokens CSS uniquement (Dark & Light)", () => {
  it("emits no raw hex colour in the rendered class/style attributes", async () => {
    const html = await render({ ...ready(), selectedCardId: "sv08.5-2" });
    const attributes = [...html.matchAll(/\s(?:class|style)="([^"]*)"/g)].map((m) => m[1] ?? "");
    for (const value of attributes) expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).toContain("bg-canvas");
    expect(html).toContain("bg-surface-1");
    expect(html).toContain("text-primary");
  });

  it("contains no raw hex colour nor rgb() in its source", () => {
    for (const file of ["SharedBinderScreen.tsx", "ShareLinkSheet.tsx"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/);
      expect(source).not.toMatch(/\brgba?\(/);
    }
  });
});
