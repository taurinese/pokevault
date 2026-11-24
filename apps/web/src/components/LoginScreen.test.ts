import { CardAspectRatio } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fr } from "../i18n/fr.ts";
import { LoginScreen } from "./LoginScreen.tsx";

const render = (error?: Parameters<typeof LoginScreen>[0]["error"]): string =>
  renderToStaticMarkup(h(LoginScreen, { error }));

describe("LoginScreen (09A)", () => {
  it("renders exactly the two OAuth buttons", () => {
    const html = render();
    expect(html).toContain('href="/api/auth/login?provider=google"');
    expect(html).toContain('href="/api/auth/login?provider=discord"');
    expect(html).toContain("Continuer avec Google");
    expect(html).toContain("Continuer avec Discord");
    expect(html.match(/\/api\/auth\/login\?provider=/g)).toHaveLength(2);
  });

  it("has no email / password form", () => {
    const html = render();
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("renders a fan of 3 cards with the strict 63/88 ratio and -8/0/+8deg rotations", () => {
    const html = render();
    expect(html.match(/data-testid="login-fan-card"/g)).toHaveLength(3);
    expect(html.match(new RegExp(`aspect-ratio:${CardAspectRatio}`, "g"))).toHaveLength(3);
    expect(html).toContain("rotate(-8deg)");
    expect(html).toContain("rotate(0deg)");
    expect(html).toContain("rotate(8deg)");
    expect(
      html.match(/<img [^>]*src="https:\/\/assets\.tcgdex\.net\/fr\/sv\/sv03\.5\/\d+\/low\.webp"/g),
    ).toHaveLength(3);
    expect(html).toContain('loading="eager"');
  });

  it("includes the theme toggle and the app title", () => {
    const html = render();
    expect(html).toContain("Basculer entre le thème sombre et le thème clair");
    expect(html).toContain(fr["login.heading"]);
  });

  it("does not show the invite-only card by default", () => {
    const html = render();
    expect(html).not.toContain("login-invite-only");
    expect(html).not.toContain("Accès sur invitation");
  });

  it("shows the invite-only card with a way back instead of the OAuth buttons", () => {
    const html = render("invite_only");
    expect(html).toContain('data-testid="login-invite-only"');
    expect(html).toContain("Accès sur invitation");
    expect(html).toContain("Essayer un autre compte");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("/api/auth/login?provider=");
  });

  it.each([
    ["oauth_cancelled", fr["login.error.oauth_cancelled"]],
    ["auth_failed", fr["login.error.auth_failed"]],
  ] as const)("shows an alert for %s and keeps the OAuth buttons", (error, message) => {
    const html = render(error);
    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
    expect(html).toContain("/api/auth/login?provider=google");
    expect(html).not.toContain("login-invite-only");
  });

  it("uses no raw hex colors", () => {
    expect(render("invite_only")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
