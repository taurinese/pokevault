import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { THEME_OPTIONS, ThemeSelector } from "./ThemeSelector.tsx";

describe("ThemeSelector", () => {
  const html = renderToStaticMarkup(h(ThemeSelector));

  it("renders Auto / Sombre / Clair mapped to system / dark / light, in that order", () => {
    expect(THEME_OPTIONS.map((option) => option.value)).toEqual(["system", "dark", "light"]);
    const labels = [...html.matchAll(/<span[^>]*>(Auto|Sombre|Clair)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Auto", "Sombre", "Clair"]);
    expect(html.match(/<input[^>]*type="radio"/g)).toHaveLength(3);
  });

  it("is an accessible radio group with a legend", () => {
    expect(html).toContain("<fieldset");
    expect(html).toContain('<legend class="sr-only">Apparence</legend>');
    expect(html.match(/name="theme-preference"/g)).toHaveLength(3);
  });

  it("renders the dark default on the server (no hydration mismatch)", () => {
    expect(html.match(/<input[^>]*checked=""[^>]*>/g)).toHaveLength(1);
    expect(html.match(/<input[^>]*checked=""[^>]*>/)?.[0]).toContain('value="dark"');
  });

  it("has 44px touch targets and a visible focus ring", () => {
    expect(html.match(/min-height:var\(--touch-target-min\)/g)).toHaveLength(3);
    expect(html).toContain("peer-focus-visible:outline-2");
  });

  it("uses no raw hex colors", () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
