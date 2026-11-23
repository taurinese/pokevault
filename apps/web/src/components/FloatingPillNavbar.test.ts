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
import {
  FloatingPillNavbar,
  NAVBAR_TABS,
  type NavbarTabId,
  navbarTabFromPath,
} from "./FloatingPillNavbar.tsx";

const renderNavbar = async (
  activeTab: NavbarTabId,
  unreadAlertsCount?: number,
): Promise<string> => {
  const rootRoute = createRootRoute({
    component: () => h(FloatingPillNavbar, { activeTab, unreadAlertsCount }),
  });
  const children = NAVBAR_TABS.map((tab) =>
    createRoute({ getParentRoute: () => rootRoute, path: tab.to, component: () => null }),
  );
  const routeTree = rootRoute.addChildren(children);
  const activePath = NAVBAR_TABS.find((tab) => tab.id === activeTab)?.to ?? "/";
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [activePath] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

describe("FloatingPillNavbar", () => {
  it("renders the 5 exact tabs with their French labels and hrefs", async () => {
    const html = await renderNavbar("home");
    expect(html).toContain('aria-label="Navigation principale"');
    for (const tab of NAVBAR_TABS) {
      expect(html).toContain(`href="${tab.to}"`);
    }
    expect(html).toContain("Accueil");
    expect(html).toContain("Collection");
    expect(html).toContain("Recherche");
    expect(html).toContain("Wishlist");
    expect(html).toContain("Alertes");
  });

  it('marks only the active tab with aria-current="page" and the gold pill', async () => {
    const html = await renderNavbar("search");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const searchAnchor = html.match(/<a[^>]*href="\/search"[^>]*>/)?.[0] ?? "";
    expect(searchAnchor).toContain('aria-current="page"');
    expect(searchAnchor).toContain("bg-gold-soft");
    expect(searchAnchor).toContain("text-gold");
  });

  it("shows the green badge on the alerts tab when unreadAlertsCount > 0", async () => {
    const html = await renderNavbar("home", 3);
    expect(html).toContain(">3</span>");
    expect(html).toContain("3 alertes non lues");
    expect(html).toContain("bg-success");
  });

  it("hides the badge when there are no unread alerts", async () => {
    const html = await renderNavbar("alerts", 0);
    expect(html).not.toContain("alertes non lues");
    expect(html).toContain('aria-current="page"');
  });

  it("uses the bottom safe-area inset and 44px touch targets", async () => {
    const html = await renderNavbar("home");
    expect(html).toContain("safe-area-inset-bottom");
    expect(html).toContain("min-width:var(--touch-target-min)");
    expect(html).toContain("min-height:var(--touch-target-min)");
  });
});

describe("navbarTabFromPath", () => {
  it("maps the navbar paths and falls back to home", () => {
    expect(navbarTabFromPath("/")).toBe("home");
    expect(navbarTabFromPath("/collection")).toBe("collection");
    expect(navbarTabFromPath("/search")).toBe("search");
    expect(navbarTabFromPath("/wishlist")).toBe("wishlist");
    expect(navbarTabFromPath("/alerts")).toBe("alerts");
    expect(navbarTabFromPath("/binder/42")).toBe("home");
  });
});
