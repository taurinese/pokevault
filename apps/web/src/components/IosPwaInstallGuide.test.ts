import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fr } from "../i18n/fr.ts";
import { IosPwaInstallGuide } from "./IosPwaInstallGuide.tsx";

describe("IosPwaInstallGuide", () => {
  it("renders nothing when hidden or during SSR without explicit override", () => {
    expect(renderToStaticMarkup(h(IosPwaInstallGuide))).toBe("");
    expect(renderToStaticMarkup(h(IosPwaInstallGuide, { visible: false }))).toBe("");
  });

  it("renders a 3-step accessible guide when visible on iOS Safari non-standalone", () => {
    const html = renderToStaticMarkup(h(IosPwaInstallGuide, { visible: true }));
    const decoded = html.replaceAll("&#x27;", "'");
    expect(html).toContain('data-testid="ios-pwa-install-guide"');
    expect(html).toContain("<aside");
    expect(html).toContain('aria-labelledby="ios-pwa-guide-title"');
    expect(decoded).toContain(fr["pwa.iosGuide.title"]);
    expect(decoded).toContain(fr["pwa.iosGuide.description"]);
    expect(html).toContain("<ol");
    expect(decoded).toContain(fr["pwa.iosGuide.step1"]);
    expect(decoded).toContain(fr["pwa.iosGuide.step2"]);
    expect(decoded).toContain(fr["pwa.iosGuide.step3"]);
    expect(html.match(/<li /g)).toHaveLength(3);
  });

  it("uses only design tokens (no raw hex colors)", () => {
    const html = renderToStaticMarkup(h(IosPwaInstallGuide, { visible: true }));
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
