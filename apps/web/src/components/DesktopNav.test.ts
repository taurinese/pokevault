import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopNav } from "./DesktopNav.tsx";
import { NAVBAR_TABS } from "./FloatingPillNavbar.tsx";

const renderDesktopNav = async (path: string, unreadAlertsCount?: number): Promise<string> => {
  const rootRoute = createRootRoute({
    component: () => h(DesktopNav, { unreadAlertsCount }),
  });
  const children = [
    ...NAVBAR_TABS.map((tab) =>
      createRoute({ getParentRoute: () => rootRoute, path: tab.to, component: () => null }),
    ),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/collection/$id",
      component: () => null,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/burst", component: () => null }),
    createRoute({ getParentRoute: () => rootRoute, path: "/account", component: () => null }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

const navSection = (html: string): string => html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

const anchorFor = (fragment: string, href: string): string =>
  fragment.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? "";

describe("DesktopNav", () => {
  it("renders a desktop-only sidebar (hidden lg:flex) with the 5 exact tabs and visible French labels", async () => {
    const html = await renderDesktopNav("/");
    expect(html).toContain('data-testid="desktop-nav"');
    expect(html).toContain("hidden lg:flex");
    expect(html).toContain("w-60");
    expect(html).toContain('aria-label="Navigation latérale"');
    expect(html).toContain("PokéVault");

    const nav = navSection(html);
    for (const tab of NAVBAR_TABS) {
      expect(nav).toContain(`href="${tab.to}"`);
    }
    expect(nav).toContain("Accueil");
    expect(nav).toContain("Collection");
    expect(nav).toContain("Recherche");
    expect(nav).toContain("Wishlist");
    expect(nav).toContain("Alertes");
    // Les libellés de la sidebar desktop sont toujours visibles (jamais masqués par `sr-only`).
    expect(nav).not.toContain('class="sr-only group-data-[status=active]:not-sr-only"');
  });

  it('marks only the active tab with aria-current="page" and gold highlight', async () => {
    const html = await renderDesktopNav("/search");
    const nav = navSection(html);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    const searchAnchor = anchorFor(nav, "/search");
    expect(searchAnchor).toContain('aria-current="page"');
    expect(searchAnchor).toContain("bg-gold-soft");
    expect(searchAnchor).toContain("text-gold");
    expect(anchorFor(nav, "/")).not.toContain("aria-current");
    expect(anchorFor(nav, "/")).not.toContain("bg-gold-soft");
  });

  it("activates only Collection on a nested path like /collection/abc", async () => {
    const html = await renderDesktopNav("/collection/abc");
    const nav = navSection(html);
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchorFor(nav, "/collection")).toContain('aria-current="page"');
    expect(anchorFor(nav, "/")).not.toContain("aria-current");
  });

  it("renders the unread alerts green badge for 0, 1, 3 and 12 (capped at 9+)", async () => {
    const zero = await renderDesktopNav("/", 0);
    expect(zero).not.toContain("non lue");
    expect(zero).not.toContain("bg-success-strong");

    const one = await renderDesktopNav("/", 1);
    expect(one).toContain("1 alerte non lue");
    expect(one).toContain("bg-success-strong");
    expect(one).toMatch(/<span aria-hidden="true"[^>]*>1<\/span>/);

    const three = await renderDesktopNav("/", 3);
    expect(three).toMatch(/<span aria-hidden="true"[^>]*>3<\/span>/);
    expect(three).toContain("3 alertes non lues");

    const twelve = await renderDesktopNav("/", 12);
    expect(twelve).toMatch(/<span aria-hidden="true"[^>]*>9\+<\/span>/);
    expect(twelve).toContain("12 alertes non lues");
  });

  it("includes footer shortcuts to /burst, /account and the ThemeToggle", async () => {
    const html = await renderDesktopNav("/");
    expect(html).toContain('href="/burst"');
    expect(html).toContain("Saisie rafale");
    expect(html).toContain('href="/account"');
    expect(html).toContain("Compte &amp; paramètres");
    expect(html).toContain("Basculer entre le thème sombre et le thème clair");
  });

  it("uses 44px touch targets and zero raw hex colors (design tokens only)", async () => {
    const html = await renderDesktopNav("/", 2);
    expect(html).toContain("min-height:var(--touch-target-min)");
    expect(html).toContain("bg-surface-1");
    expect(html).toContain("border-line");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
