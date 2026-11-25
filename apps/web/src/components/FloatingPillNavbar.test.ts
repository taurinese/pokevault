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
import { FloatingPillNavbar, formatBadgeCount, NAVBAR_TABS } from "./FloatingPillNavbar.tsx";

const renderNavbar = async (path: string, unreadAlertsCount?: number): Promise<string> => {
  const rootRoute = createRootRoute({
    component: () => h(FloatingPillNavbar, { unreadAlertsCount }),
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
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

const anchorFor = (html: string, href: string): string =>
  html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? "";

describe("FloatingPillNavbar", () => {
  it("renders the 5 exact tabs with their French labels and hrefs", async () => {
    const html = await renderNavbar("/");
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
    const html = await renderNavbar("/search");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const searchAnchor = anchorFor(html, "/search");
    expect(searchAnchor).toContain('aria-current="page"');
    expect(searchAnchor).toContain('data-status="active"');
    expect(searchAnchor).toContain("bg-gold-soft");
    expect(searchAnchor).toContain("text-gold");
    expect(anchorFor(html, "/")).not.toContain("aria-current");
  });

  it("activates only Collection on a nested path like /collection/abc", async () => {
    const html = await renderNavbar("/collection/abc");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchorFor(html, "/collection")).toContain('aria-current="page"');
    expect(anchorFor(html, "/")).not.toContain("aria-current");
  });

  it("matches Home exactly (not active on other routes)", async () => {
    const html = await renderNavbar("/wishlist");
    expect(anchorFor(html, "/")).not.toContain("bg-gold-soft");
    expect(anchorFor(html, "/wishlist")).toContain("bg-gold-soft");
  });

  it("shows the green badge with a singular sr-only label for 1 unread alert", async () => {
    const html = await renderNavbar("/", 1);
    expect(html).toContain("1 alerte non lue");
    expect(html).not.toContain("1 alertes non lues");
    expect(html).toContain("bg-success-strong");
  });

  it("hides the visible badge digit from assistive tech (sr-only text announces the count)", async () => {
    const html = await renderNavbar("/", 3);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>3<\/span>/);
    expect(html).toContain("3 alertes non lues");
  });

  it("caps the visible badge at 9+ while the sr-only text keeps the real count", async () => {
    const html = await renderNavbar("/", 12);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>9\+<\/span>/);
    expect(html).toContain("12 alertes non lues");
  });

  it("hides the badge when there are no unread alerts", async () => {
    const html = await renderNavbar("/alerts", 0);
    expect(html).not.toContain("non lue");
    expect(html).toContain('aria-current="page"');
  });

  it("uses the bottom safe-area inset and 44px touch targets", async () => {
    const html = await renderNavbar("/");
    expect(html).toContain("safe-area-inset-bottom");
    expect(html).toContain("min-width:var(--touch-target-min)");
    expect(html).toContain("min-height:var(--touch-target-min)");
  });

  it("hides the mobile floating pill on desktop (lg:hidden) in favor of DesktopNav", async () => {
    const html = await renderNavbar("/");
    expect(html).toContain("lg:hidden");
  });
});

describe("formatBadgeCount", () => {
  it("caps above 9", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(9)).toBe("9");
    expect(formatBadgeCount(10)).toBe("9+");
    expect(formatBadgeCount(250)).toBe("9+");
  });
});
