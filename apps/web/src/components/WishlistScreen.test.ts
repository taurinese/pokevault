import { readFileSync } from "node:fs";
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
import { DEFAULT_WISHLIST_FILTERS, type WishlistEnrichedItem } from "../lib/wishlist-client.ts";
import {
  readdBodyOf,
  runWishlistUndo,
  type UndoApi,
  type WishlistToastState,
  WishlistView,
  type WishlistViewActions,
  type WishlistViewState,
} from "./WishlistScreen.tsx";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

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
    imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/1",
    setId: "sv03.5",
    setCode: "SV03.5",
    cardmarketSetCode: "MEW",
    setNameFr: "151",
    trendCents: null,
    lowFrCents: null,
    avg30Cents: null,
    priceSource: null,
    priceFetchedAt: null,
    priceExpiresAt: null,
    priceIsFresh: null,
    ...overrides,
  };
};

const priced = (cents: number, overrides: Partial<WishlistEnrichedItem> = {}) =>
  item({
    lowFrCents: cents,
    priceSource: "cardmarket",
    priceFetchedAt: minutesAgo(1),
    priceIsFresh: true,
    ...overrides,
  });

const DRACAUFEU = priced(14000, {
  nameFr: "Dracaufeu ex",
  localId: "199",
  variant: "holo",
  priority: "high",
  targetPriceCents: 15000,
});
const PIKACHU = priced(250, {
  nameFr: "Pikachu",
  localId: "25",
  priceFetchedAt: minutesAgo(90),
  targetPriceCents: 100,
});
const EVOLI = item({
  nameFr: "Évoli",
  localId: "10",
  setId: "sv08",
  setNameFr: "Étincelles Déferlantes",
  trendCents: 80,
  priceSource: "tcgdex_fallback",
  priceFetchedAt: minutesAgo(5),
  language: "JP",
  minCondition: "EX",
});
const MEW = item({
  nameFr: "Mew",
  localId: "151",
  setId: "sv08",
  setNameFr: "Étincelles Déferlantes",
});
const ITEMS = [DRACAUFEU, PIKACHU, EVOLI, MEW];

const noop = (): void => undefined;
const makeActions = (overrides: Partial<WishlistViewActions> = {}): WishlistViewActions => ({
  onRetry: noop,
  onTabChange: noop,
  onSetChange: noop,
  onResetFilters: noop,
  onOpenExport: noop,
  onCloseExport: noop,
  onTogglePriority: noop,
  onStartEditTarget: noop,
  onTargetDraftChange: noop,
  onSubmitTarget: noop,
  onCancelEditTarget: noop,
  onDelete: noop,
  onAcquire: noop,
  onUndo: noop,
  onDismissToast: noop,
  ...overrides,
});

const baseState: WishlistViewState = {
  data: { status: "ready", data: ITEMS },
  filters: DEFAULT_WISHLIST_FILTERS,
  exportOpen: false,
  pendingIds: new Set(),
  editing: null,
  toast: null,
  announcement: "",
  nowMs: NOW,
};

const render = async (
  state: Partial<WishlistViewState> = {},
  actions: WishlistViewActions = makeActions(),
): Promise<string> => {
  const rootRoute = createRootRoute({
    component: () => h(WishlistView, { state: { ...baseState, ...state }, actions }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/search", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

/** Balise ouvrante portant `data-testid="<id>"` (indépendant de l'ordre des attributs). */
const tagOf = (html: string, testId: string): string =>
  (html.match(/<[a-z]+[^>]*>/g) ?? []).find((tag) => tag.includes(`data-testid="${testId}"`)) ?? "";

const ROW_OPEN = '<li data-testid="wishlist-item"';

/** Balisage de la première ligne de souhait dont le contenu contient `needle`. */
const rowOf = (html: string, needle: string): string => {
  const chunk = html
    .split(ROW_OPEN)
    .slice(1)
    .find((part) => part.includes(needle));
  return chunk === undefined ? "" : `${ROW_OPEN}${chunk}`;
};

describe("WishlistView — en-tête & barre synthèse (06A)", () => {
  it("shows the title and an Export button opening the Cardmarket sheet", async () => {
    const onOpenExport = vi.fn();
    const html = await render({}, makeActions({ onOpenExport }));
    expect(html).toContain("<h1");
    expect(html).toContain("Wishlist");
    expect(html).toContain("Exporter");
    expect(tagOf(html, "wishlist-export")).not.toContain('disabled=""');
    expect(tagOf(html, "wishlist-export")).toContain(
      'aria-label="Exporter la wishlist vers Cardmarket"',
    );
  });

  it("shows the estimated budget (sum of effective prices) in tabular monospace, with the unpriced hint", async () => {
    const html = await render();
    // 140,00 + 2,50 + 0,80 = 143,30 € (Mew n'a pas de prix).
    expect(html).toMatch(/data-testid="wishlist-budget"[^>]*>143,30(\s| )€</);
    expect(html).toContain("Budget estimé");
    expect(tagOf(html, "wishlist-budget")).toContain("font-mono");
    expect(tagOf(html, "wishlist-budget")).toContain("tabular-nums");
    expect(html).toMatch(/data-testid="wishlist-unpriced"[^>]*>1 sans prix</);
  });

  it("shows the green `N sous seuil` badge only when some items reached their target", async () => {
    // Dracaufeu (140 ≤ 150) uniquement : Pikachu (2,50 > 1,00).
    const html = await render();
    expect(html).toMatch(/data-testid="wishlist-below-badge"[^>]*>1 sous seuil</);
    expect(tagOf(html, "wishlist-below-badge")).toContain("text-success-strong");
    const none = await render({ data: { status: "ready", data: [PIKACHU, MEW] } });
    expect(none).not.toContain('data-testid="wishlist-below-badge"');
  });

  it("keeps the summary on a single row (no wrapping container)", async () => {
    const html = await render();
    expect(tagOf(html, "wishlist-summary")).toContain("flex items-center justify-between");
    expect(tagOf(html, "wishlist-summary")).not.toContain("flex-wrap");
  });

  it("hides the unpriced hint when every card has a price", async () => {
    const html = await render({ data: { status: "ready", data: [DRACAUFEU, PIKACHU] } });
    expect(html).not.toContain('data-testid="wishlist-unpriced"');
  });
});

describe("WishlistView — filtres", () => {
  it("renders Toutes / Sous seuil / Prioritaires pills with counters and aria-pressed", async () => {
    const html = await render();
    expect(html).toMatch(/aria-pressed="true"[^>]*>Toutes</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Sous seuil<span[^>]*>1</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Prioritaires<span[^>]*>1</);
    expect(html).toMatch(/<legend[^>]*>Filtrer la wishlist<\/legend>/);
  });

  it("exposes the extension filter with the sets present in the wishlist and their counts", async () => {
    const html = await render();
    expect(html).toContain('data-testid="wishlist-set-filter"');
    expect(html).toContain("Toutes les extensions");
    expect(html).toContain("151 (2)");
    expect(html).toContain("Étincelles Déferlantes (2)");
  });

  it("filters the list by tab", async () => {
    const below = await render({ filters: { tab: "below_threshold", setId: null } });
    expect(below.match(/data-testid="wishlist-item"/g)).toHaveLength(1);
    expect(below).toContain("Dracaufeu ex");
    expect(below).not.toContain("Pikachu");
    expect(below).toMatch(/aria-pressed="true"[^>]*>Sous seuil</);

    const high = await render({ filters: { tab: "high_priority", setId: null } });
    expect(high.match(/data-testid="wishlist-item"/g)).toHaveLength(1);
    expect(high).toContain("Dracaufeu ex");
  });

  it("filters the list by extension and selects it in the dropdown", async () => {
    const html = await render({ filters: { tab: "all", setId: "sv08" } });
    expect(html.match(/data-testid="wishlist-item"/g)).toHaveLength(2);
    expect(html).toContain("Évoli");
    expect(html).toContain("Mew");
    expect(html).not.toContain("Pikachu");
    expect(html).toMatch(/<option value="sv08" selected="">/);
  });

  it("shows a filtered-empty state with a reset button", async () => {
    const html = await render({ filters: { tab: "below_threshold", setId: "sv08" } });
    expect(html).toContain('data-testid="wishlist-filtered-empty"');
    expect(html).toContain("Aucun souhait pour ces filtres");
    expect(html).toContain("Réinitialiser les filtres");
    expect(html).not.toContain('data-testid="wishlist-item"');
    // Le résumé et les filtres restent visibles pour pouvoir changer de filtre.
    expect(html).toContain('data-testid="wishlist-filters"');
  });
});

describe("WishlistView — états", () => {
  it("renders skeletons while loading, with an accessible status and a disabled export", async () => {
    const html = await render({ data: { status: "loading" } });
    expect(html).toContain('data-testid="wishlist-skeleton"');
    expect(html).toContain('aria-label="Chargement de votre wishlist"');
    expect(tagOf(html, "wishlist-export")).toContain('disabled=""');
    expect(html).not.toContain('data-testid="wishlist-item"');
  });

  it("renders an error state with a retry button and a disabled export", async () => {
    const html = await render({ data: { status: "error" } });
    expect(html).toContain('data-testid="wishlist-error"');
    expect(html).toContain("Wishlist indisponible");
    expect(html).toContain("Réessayer");
    expect(tagOf(html, "wishlist-export")).toContain('disabled=""');
  });

  it("renders an empty state linking to /search, with the export disabled", async () => {
    const html = await render({ data: { status: "ready", data: [] } });
    expect(html).toContain('data-testid="wishlist-empty"');
    expect(html).toContain("Votre wishlist est vide");
    expect(html).toMatch(/<a [^>]*href="\/search"[^>]*>Chercher des cartes</);
    expect(tagOf(html, "wishlist-export")).toContain('disabled=""');
    expect(html).not.toContain('data-testid="wishlist-summary"');
  });
});

describe("WishlistView — ligne de souhait", () => {
  it("shows a 63/88 low.webp thumbnail, name, #number, set and the language/variant/min-condition badges", async () => {
    const html = await render({ data: { status: "ready", data: [EVOLI] } });
    expect(html).toContain("aspect-ratio:0.71590909");
    expect(html).toContain('src="https://assets.tcgdex.net/fr/sv/sv03.5/1/low.webp"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("Évoli");
    expect(html).toContain("#10");
    expect(html).toContain("Étincelles Déferlantes");
    expect(html).toContain('aria-label="Langue souhaitée : JP"');
    expect(html).toContain('aria-label="Variante : Normal"');
    expect(html).toContain('aria-label="État minimum : EX"');
    expect(html).toContain("EX min.");
  });

  it("renders a priority toggle with aria-pressed (high = pressed) and a 44px target", async () => {
    const html = await render();
    const high = tagOf(rowOf(html, "Dracaufeu ex"), "wishlist-priority");
    expect(high).toContain('aria-pressed="true"');
    expect(high).toContain('aria-label="Priorité haute pour Dracaufeu ex"');
    expect(high).toContain("min-width:var(--touch-target-min)");
    expect(tagOf(rowOf(html, "Pikachu"), "wishlist-priority")).toContain('aria-pressed="false"');
  });

  it("shows the current price + relative-age freshness pill: green < 15 min, amber 15 min–6 h, neutral indicative, `Prix indisponible` when missing", async () => {
    const html = await render();
    const freshRow = rowOf(html, "Dracaufeu ex");
    const fresh = tagOf(freshRow, "wishlist-freshness");
    expect(fresh).toContain('data-freshness="fresh"');
    expect(freshRow).toContain("text-success-strong");
    expect(freshRow).toContain("il y a 1 min");
    expect(freshRow).toMatch(/data-testid="wishlist-price"[^>]*>140,00(\s| )€</);

    const aging = rowOf(html, "Pikachu");
    expect(tagOf(aging, "wishlist-freshness")).toContain('data-freshness="aging"');
    expect(tagOf(aging, "wishlist-freshness")).toContain("text-warning");
    expect(aging).toContain("il y a 1 h");

    const stale = rowOf(html, "Évoli");
    expect(tagOf(stale, "wishlist-freshness")).toContain('data-freshness="stale"');
    expect(stale).toContain("il y a 5 min · indicatif");

    const missing = rowOf(html, "Mew");
    expect(tagOf(missing, "wishlist-freshness")).toContain('data-freshness="missing"');
    expect(missing).toContain("Prix indisponible");
    expect(missing).not.toContain('data-testid="wishlist-price"');

    // 5 h 50 doit afficher « il y a 5 h », jamais « Il y a quelques minutes ».
    const fiveHours = priced(500, {
      nameFr: "Florizarre",
      priceFetchedAt: minutesAgo(350),
    });
    const htmlFive = await render({ data: { status: "ready", data: [fiveHours] } });
    expect(htmlFive).toContain("il y a 5 h");
    expect(htmlFive).not.toContain("quelques minutes");
  });

  it("falls back to all sets when the active setId filter no longer exists in items", async () => {
    const html = await render({ filters: { tab: "all", setId: "removed-set" } });
    expect(html.match(/data-testid="wishlist-item"/g)).toHaveLength(4);
    expect(html).not.toContain('data-testid="wishlist-filtered-empty"');
  });

  it("shows the target price, highlighted in green and badged when below threshold", async () => {
    const html = await render();
    const below = rowOf(html, "Dracaufeu ex");
    expect(below).toMatch(/data-testid="wishlist-target"[^>]*>Cible 150,00(\s| )€ · Sous seuil</);
    expect(tagOf(below, "wishlist-target")).toContain("text-success-strong");
    expect(tagOf(below, "wishlist-item")).toContain('data-below-threshold="true"');
    const above = rowOf(html, "Pikachu");
    expect(tagOf(above, "wishlist-target")).not.toContain("text-success-strong");
    expect(above).not.toContain("Sous seuil");
    expect(tagOf(above, "wishlist-item")).toContain('data-below-threshold="false"');
    expect(rowOf(html, "Mew")).not.toContain('data-testid="wishlist-target"');
  });

  it("offers 44px edit-target, delete and acquire (✓) actions with explicit labels", async () => {
    const html = await render();
    const row = rowOf(html, "Pikachu");
    for (const [testId, label] of [
      ["wishlist-edit-target", "Modifier le prix cible de Pikachu"],
      ["wishlist-delete", "Retirer Pikachu de la wishlist"],
      ["wishlist-acquire", "Marquer Pikachu comme acquise"],
    ] as const) {
      const tag = tagOf(row, testId);
      expect(tag).toContain(`aria-label="${label}"`);
      expect(tag).toContain("min-width:var(--touch-target-min)");
      expect(tag).toContain("min-height:var(--touch-target-min)");
      expect(tag).not.toContain('disabled=""');
    }
  });

  it("disables every row action while a request is pending for that item only", async () => {
    const html = await render({ pendingIds: new Set([PIKACHU.id]) });
    const pending = rowOf(html, "Pikachu");
    for (const testId of [
      "wishlist-edit-target",
      "wishlist-delete",
      "wishlist-acquire",
      "wishlist-priority",
    ]) {
      expect(tagOf(pending, testId)).toContain('disabled=""');
    }
    expect(tagOf(rowOf(html, "Dracaufeu ex"), "wishlist-acquire")).not.toContain('disabled=""');
  });

  it("opens the inline target editor with a labelled field, save/cancel, and an error message", async () => {
    const html = await render({
      editing: { itemId: PIKACHU.id, draft: "1,00", invalid: false },
    });
    const row = rowOf(html, "Pikachu");
    expect(row).toContain('data-testid="wishlist-target-form"');
    expect(row).toContain("Prix cible (€)");
    expect(row).toContain('value="1,00"');
    expect(row).toContain("Enregistrer");
    expect(row).toContain("Retirer le seuil");
    expect(rowOf(html, "Dracaufeu ex")).not.toContain("wishlist-target-form");

    const invalid = await render({
      editing: { itemId: PIKACHU.id, draft: "abc", invalid: true },
    });
    expect(rowOf(invalid, "Pikachu")).toContain('role="alert"');
    expect(rowOf(invalid, "Pikachu")).toContain("Prix invalide");
    expect(rowOf(invalid, "Pikachu")).toContain('aria-invalid="true"');
  });
});

describe("WishlistView — toast « Acquise » avec Annuler", () => {
  const toast = (overrides: Partial<WishlistToastState> = {}): WishlistToastState => ({
    id: 1,
    tone: "success",
    message: "Pikachu ajoutée à ta collection",
    canUndo: true,
    undoing: false,
    ...overrides,
  });

  it("exposes a persistent polite status region and shows the toast with an `Annuler` button", async () => {
    const empty = await render();
    expect(tagOf(empty, "wishlist-toast-region")).toContain('role="status"');
    expect(tagOf(empty, "wishlist-toast-region")).toContain('aria-live="polite"');
    expect(empty).not.toContain('data-testid="wishlist-toast"');

    const html = await render({ toast: toast() });
    expect(html).toContain("Pikachu ajoutée à ta collection");
    expect(html).toMatch(
      /data-testid="wishlist-undo"[^>]*style="min-height:var\(--touch-target-min\)"[^>]*>Annuler</,
    );
    expect(tagOf(html, "wishlist-toast")).toContain('data-tone="success"');
  });

  it("disables Annuler while the undo is running and hides it for non-undoable toasts", async () => {
    const running = await render({ toast: toast({ undoing: true }) });
    expect(tagOf(running, "wishlist-undo")).toContain('disabled=""');
    const error = await render({
      toast: toast({
        tone: "error",
        canUndo: false,
        message: "Action impossible pour le moment. Veuillez réessayer.",
      }),
    });
    expect(error).not.toContain('data-testid="wishlist-undo"');
    expect(tagOf(error, "wishlist-toast")).toContain('data-tone="error"');
  });

  it("announces the last action in a polite live region", async () => {
    const html = await render({ announcement: "Pikachu retirée de la wishlist" });
    expect(html).toMatch(/data-testid="wishlist-announcer"[^>]*>Pikachu retirée de la wishlist</);
    expect(tagOf(html, "wishlist-announcer")).toContain('aria-live="polite"');
  });
});

describe("Annulation d'une acquisition (runWishlistUndo)", () => {
  const api = (
    add: Awaited<ReturnType<UndoApi["addWishlistItem"]>>,
    adjust: Awaited<ReturnType<UndoApi["adjustCardCopyQuantity"]>> = {
      kind: "ok",
      body: { copy: null, deleted: true },
    },
  ) => ({
    addWishlistItem: vi.fn(async () => add),
    adjustCardCopyQuantity: vi.fn(async () => adjust),
  });

  const payload = {
    name: "Pikachu",
    readd: readdBodyOf(PIKACHU),
    copyId: "55555555-5555-4555-8555-555555555555",
  };

  it("re-adds the wish with the same slot and preferences", () => {
    expect(readdBodyOf(DRACAUFEU)).toEqual({
      cardId: DRACAUFEU.cardId,
      language: "FR",
      variant: "holo",
      minCondition: "NM",
      priority: "high",
      targetPriceCents: 15000,
    });
  });

  it("re-adds the wish then decrements the added copy by one", async () => {
    const calls: string[] = [];
    const deps = {
      addWishlistItem: vi.fn(async () => {
        calls.push("add");
        return { kind: "ok" as const, body: {} as never };
      }),
      adjustCardCopyQuantity: vi.fn(async () => {
        calls.push("adjust");
        return { kind: "ok" as const, body: { copy: null, deleted: true } };
      }),
    };
    expect(await runWishlistUndo(payload, deps)).toBe("done");
    expect(calls).toEqual(["add", "adjust"]);
    expect(deps.addWishlistItem).toHaveBeenCalledWith(payload.readd);
    expect(deps.adjustCardCopyQuantity).toHaveBeenCalledWith(payload.copyId, -1);
  });

  it("only re-adds the wish when no copy was created (undo of a plain removal)", async () => {
    const deps = api({ kind: "ok", body: {} as never });
    expect(await runWishlistUndo({ ...payload, copyId: null }, deps)).toBe("done");
    expect(deps.adjustCardCopyQuantity).not.toHaveBeenCalled();
  });

  it("tolerates a wish re-created in the meantime (409) and an already-deleted copy (404)", async () => {
    expect(await runWishlistUndo(payload, api({ kind: "conflict" }))).toBe("done");
    expect(
      await runWishlistUndo(payload, api({ kind: "ok", body: {} as never }, { kind: "not-found" })),
    ).toBe("done");
  });

  it("does not touch the copy when the wish cannot be re-added", async () => {
    const deps = api({ kind: "error" });
    expect(await runWishlistUndo(payload, deps)).toBe("failed");
    expect(deps.adjustCardCopyQuantity).not.toHaveBeenCalled();
  });

  it("reports a partial failure when the copy cannot be decremented, and propagates 401", async () => {
    expect(
      await runWishlistUndo(payload, api({ kind: "ok", body: {} as never }, { kind: "error" })),
    ).toBe("partial");
    expect(await runWishlistUndo(payload, api({ kind: "unauthorized" }))).toBe("unauthorized");
    expect(
      await runWishlistUndo(
        payload,
        api({ kind: "ok", body: {} as never }, { kind: "unauthorized" }),
      ),
    ).toBe("unauthorized");
  });
});

describe("Export sheet wiring", () => {
  it("renders the Cardmarket export sheet only when opened with a non-empty wishlist", async () => {
    const closed = await render();
    expect(closed).not.toContain("<dialog");
    const open = await render({ exportOpen: true });
    expect(open).toContain("<dialog");
    expect(open).toContain("Export Cardmarket");
    expect(open).toContain("Télécharger wants-cardmarket.csv");
    const emptyOpen = await render({ data: { status: "ready", data: [] }, exportOpen: true });
    expect(emptyOpen).not.toContain("<dialog");
  });
});

describe("Dark & Light via tokens only, zero hard-coded UI string", () => {
  const source = readFileSync(new URL("./WishlistScreen.tsx", import.meta.url), "utf8");

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
