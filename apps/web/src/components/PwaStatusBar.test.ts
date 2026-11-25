import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import { PwaStatusBar, PwaStatusBarView } from "./PwaStatusBar.tsx";

describe("PwaStatusBar", () => {
  it("renders nothing when online and no service worker update is pending", () => {
    const html = renderToStaticMarkup(
      h(PwaStatusBarView, { isOnline: true, updateAvailable: false, onReload: vi.fn() }),
    );
    expect(html).toBe("");
  });

  it("renders nothing during SSR by default (no hydration mismatch)", () => {
    expect(renderToStaticMarkup(h(PwaStatusBar))).toBe("");
  });

  it("renders a discreet status banner when offline", () => {
    const html = renderToStaticMarkup(
      h(PwaStatusBarView, { isOnline: false, updateAvailable: false, onReload: vi.fn() }),
    );
    expect(html).toContain('data-testid="pwa-offline-banner"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(fr["pwa.offline.banner"]);
    expect(html).not.toContain('data-testid="pwa-update-toast"');
  });

  it("renders a discreet update toast with an accessible 44px reload button", () => {
    const html = renderToStaticMarkup(
      h(PwaStatusBarView, { isOnline: true, updateAvailable: true, onReload: vi.fn() }),
    );
    expect(html).toContain('data-testid="pwa-update-toast"');
    expect(html).toContain('role="status"');
    expect(html).toContain(fr["pwa.update.available"]);
    expect(html).toContain('data-testid="pwa-update-reload"');
    expect(html).toContain(fr["pwa.update.reload"]);
    expect(html).toContain("min-height:var(--touch-target-min)");
    expect(html).toContain("focus-visible:outline-2");
    expect(html).not.toContain('data-testid="pwa-offline-banner"');
  });

  it("renders both banners cleanly when offline with an update waiting", () => {
    const html = renderToStaticMarkup(
      h(PwaStatusBarView, { isOnline: false, updateAvailable: true, onReload: vi.fn() }),
    );
    expect(html).toContain('data-testid="pwa-offline-banner"');
    expect(html).toContain('data-testid="pwa-update-toast"');
  });

  it("respects iOS safe-area top inset and uses no raw hex colors (Dark & Light tokens only)", () => {
    const html = renderToStaticMarkup(
      h(PwaStatusBarView, { isOnline: false, updateAvailable: true, onReload: vi.fn() }),
    );
    expect(html).toContain("var(--safe-area-inset-top)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
