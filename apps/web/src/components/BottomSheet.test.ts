import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BottomSheet } from "./BottomSheet.tsx";

const noop = () => undefined;

describe("BottomSheet", () => {
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      h(BottomSheet, { open: false, onClose: noop, title: "Titre" }, "contenu"),
    );
    expect(html).toBe("");
  });

  it("renders an accessible modal dialog when open", () => {
    const html = renderToStaticMarkup(
      h(
        BottomSheet,
        { open: true, onClose: noop, title: "Démo BottomSheet" },
        h("p", null, "Contenu de la feuille"),
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Démo BottomSheet");
    expect(html).toContain("aria-labelledby");
    expect(html).toContain('aria-label="Fermer la feuille"');
    expect(html).toContain("safe-area-inset-bottom");
    expect(html).toContain("Contenu de la feuille");
    expect(html).toContain("animate-sheet-in");
  });

  it("works without a title (no aria-labelledby)", () => {
    const html = renderToStaticMarkup(
      h(BottomSheet, { open: true, onClose: noop }, h("p", null, "Contenu")),
    );
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain("aria-labelledby");
  });
});
