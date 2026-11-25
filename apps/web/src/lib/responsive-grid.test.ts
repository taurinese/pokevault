import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CARD_GRID_COLS_CLASS,
  DEFAULT_CARD_GRID_COLUMNS,
  resolveCardGridColumns,
  useResponsiveCardGridColumns,
} from "./responsive-grid.ts";

describe("resolveCardGridColumns", () => {
  it("returns 3 columns on mobile and tablet viewports (< 1024px)", () => {
    expect(resolveCardGridColumns(390)).toBe(3);
    expect(resolveCardGridColumns(768)).toBe(3);
    expect(resolveCardGridColumns(1023)).toBe(3);
  });

  it("returns 5 columns on desktop lg viewports (1024px..1279px)", () => {
    expect(resolveCardGridColumns(1024)).toBe(5);
    expect(resolveCardGridColumns(1279)).toBe(5);
  });

  it("returns 6 columns on large desktop xl viewports (>= 1280px)", () => {
    expect(resolveCardGridColumns(1280)).toBe(6);
    expect(resolveCardGridColumns(1440)).toBe(6);
  });

  it("falls back safely to 3 for non-finite or non-positive widths", () => {
    expect(resolveCardGridColumns(0)).toBe(3);
    expect(resolveCardGridColumns(-100)).toBe(3);
    expect(resolveCardGridColumns(Number.NaN)).toBe(3);
    expect(resolveCardGridColumns(Number.POSITIVE_INFINITY)).toBe(3);
  });
});

describe("CARD_GRID_COLS_CLASS", () => {
  it("maps each supported column count to its Tailwind utility class", () => {
    expect(CARD_GRID_COLS_CLASS[3]).toBe("grid-cols-3");
    expect(CARD_GRID_COLS_CLASS[5]).toBe("grid-cols-5");
    expect(CARD_GRID_COLS_CLASS[6]).toBe("grid-cols-6");
  });
});

const ColumnsProbe = () => {
  const cols = useResponsiveCardGridColumns();
  return h("span", { "data-cols": cols }, CARD_GRID_COLS_CLASS[cols]);
};

describe("useResponsiveCardGridColumns (SSR)", () => {
  it("defaults to 3 columns during server rendering to prevent hydration mismatch", () => {
    const html = renderToStaticMarkup(h(ColumnsProbe));
    expect(DEFAULT_CARD_GRID_COLUMNS).toBe(3);
    expect(html).toContain('data-cols="3"');
    expect(html).toContain("grid-cols-3");
  });
});
