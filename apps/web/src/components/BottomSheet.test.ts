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

  it("renders a native modal <dialog> labelled by its title when open", () => {
    const html = renderToStaticMarkup(
      h(
        BottomSheet,
        { open: true, onClose: noop, title: "Démo BottomSheet" },
        h("p", null, "Contenu de la feuille"),
      ),
    );
    expect(html).toMatch(/^<dialog /);
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).not.toMatch(/<dialog[^>]*aria-label="/);
    expect(html).toContain("Démo BottomSheet");
    expect(html).toContain('aria-label="Fermer la feuille"');
    expect(html).toContain("safe-area-inset-bottom");
    expect(html).toContain("Contenu de la feuille");
    expect(html).toContain("animate-sheet-in");
  });

  it("uses ariaLabel as the accessible name when there is no title", () => {
    const html = renderToStaticMarkup(
      h(BottomSheet, { open: true, onClose: noop, ariaLabel: "Filtres" }, h("p", null, "Contenu")),
    );
    expect(html).toMatch(/<dialog[^>]*aria-label="Filtres"/);
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toContain("<h2");
  });

  it("does not render a duplicate backdrop button in the tab order", () => {
    const html = renderToStaticMarkup(
      h(BottomSheet, { open: true, onClose: noop, title: "Titre" }, "x"),
    );
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the scrollable area contained and the dialog hidden until showModal()", () => {
    const html = renderToStaticMarkup(
      h(BottomSheet, { open: true, onClose: noop, title: "Titre" }, "x"),
    );
    expect(html).toContain("overscroll-contain");
    expect(html).toContain("open:flex");
    expect(html).not.toMatch(/<dialog[^>]*\sopen(=|\s|>)/);
  });

  it("adapts into a full-height right-side drawer on desktop (lg:) and hides the mobile grab handle", () => {
    const html = renderToStaticMarkup(
      h(BottomSheet, { open: true, onClose: noop, title: "Fiche carte" }, "détails"),
    );
    expect(html).toContain("lg:items-stretch");
    expect(html).toContain("lg:justify-end");
    expect(html).toContain("lg:h-dvh");
    expect(html).toContain("lg:max-h-dvh");
    expect(html).toContain("lg:max-w-[460px]");
    expect(html).toContain("lg:rounded-l-sheet");
    expect(html).toContain("lg:animate-drawer-in");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("lg:hidden");
    expect(html).toContain("lg:cursor-default");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
