import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import type { ShareLinkEntry } from "../lib/share-client.ts";
import {
  AccountScreen,
  type AccountScreenProps,
  ShareLinksSectionView,
  type ShareLinksSectionViewProps,
} from "./AccountScreen.tsx";

const googleOnly: AccountScreenProps["user"] = {
  email: "ada@pokevault.test",
  displayName: "Ada Lovelace",
  identities: [{ provider: "google" }],
};
const bothLinked: AccountScreenProps["user"] = {
  ...googleOnly,
  identities: [{ provider: "google" }, { provider: "discord" }],
};

const render = async (props: AccountScreenProps): Promise<string> => {
  const rootRoute = createRootRoute({ component: () => h(AccountScreen, props) });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

const rowOf = (html: string, provider: "google" | "discord"): string =>
  html.match(new RegExp(`<li data-testid="provider-row-${provider}".*?</li>`))?.[0] ?? "";

describe("AccountScreen (09B)", () => {
  it("renders the profile card with 2-letter initials, name, e-mail and linked providers", async () => {
    const html = await render({ user: googleOnly });
    expect(html).toContain('data-testid="account-profile"');
    expect(html).toMatch(/data-testid="account-avatar"[^>]*>AL</);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("ada@pokevault.test");
    expect(html).toContain("Comptes liés : Google");
  });

  it("falls back gracefully without a name or e-mail", async () => {
    const html = await render({ user: { email: null, displayName: null, identities: [] } });
    expect(html).toMatch(/data-testid="account-avatar"[^>]*>CO</);
    expect(html).toContain(fr["account.profile.fallbackName"]);
    expect(html).toContain(fr["account.profile.noEmail"]);
    expect(html).toContain(fr["account.profile.noLinkedProvider"]);
  });

  it("state 1 linked / 1 to link: Google is badged « Lié », Discord offers « Lier Discord »", async () => {
    const html = await render({ user: googleOnly });
    const google = rowOf(html, "google");
    const discord = rowOf(html, "discord");
    expect(google).toContain('data-testid="provider-linked-badge"');
    expect(google).toContain("Lié");
    expect(google).not.toContain("/api/auth/link");
    expect(discord).not.toContain("provider-linked-badge");
    expect(discord).toContain('href="/api/auth/link?provider=discord"');
    expect(discord).toContain("Lier Discord");
  });

  it("state 1 linked, the other way round: Discord linked, « Lier Google » offered", async () => {
    const html = await render({
      user: { ...googleOnly, identities: [{ provider: "discord" }] },
    });
    expect(rowOf(html, "discord")).toContain("provider-linked-badge");
    expect(rowOf(html, "google")).toContain('href="/api/auth/link?provider=google"');
    expect(rowOf(html, "google")).toContain("Lier Google");
  });

  it("state 2 linked: two badges, no link action at all", async () => {
    const html = await render({ user: bothLinked });
    expect(html.match(/data-testid="provider-linked-badge"/g)).toHaveLength(2);
    expect(html).not.toContain("/api/auth/link");
    expect(html).toContain("Comptes liés : Google, Discord");
  });

  it("44px touch targets for the link action, back button and logout", async () => {
    const html = await render({ user: googleOnly });
    expect(rowOf(html, "discord")).toContain("min-height:var(--touch-target-min)");
    expect(html.match(/<a [^>]*data-testid="account-back"[^>]*>/)?.[0]).toContain(
      "min-height:var(--touch-target-min)",
    );
    expect(html.match(/<button type="submit"[^>]*>/)?.[0]).toContain(
      "min-height:var(--touch-target-min)",
    );
  });

  it("has an explicit back link to / at the top left", async () => {
    const html = await render({ user: googleOnly });
    const back = html.match(/<a [^>]*data-testid="account-back"[^>]*>/)?.[0] ?? "";
    expect(back).toContain('href="/"');
    expect(back).toContain('aria-label="Retour à l&#x27;accueil"');
    expect(html.indexOf("account-back")).toBeLessThan(html.indexOf("<h1"));
  });

  it("shows no feedback banner by default", async () => {
    const html = await render({ user: googleOnly });
    expect(html).not.toContain("account-feedback");
    expect(html).not.toContain('role="alert"');
  });

  it.each([
    ["google", "Compte Google lié avec succès."],
    ["discord", "Compte Discord lié avec succès."],
  ] as const)("shows a success status after ?linked=%s", async (linked, message) => {
    const html = await render({ user: bothLinked, linked });
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="account-feedback-success"');
    expect(html).toContain(message);
  });

  it.each([
    ["link_cancelled", fr["account.linked.error.link_cancelled"]],
    ["link_failed", fr["account.linked.error.link_failed"]],
  ] as const)("shows an alert after ?error=%s", async (error, message) => {
    const html = await render({ user: googleOnly, error });
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="account-feedback-error"');
    expect(html).toContain(message);
    expect(html).not.toContain("account-feedback-success");
  });

  it("includes the 3-choice appearance selector (Auto / Sombre / Clair)", async () => {
    const html = await render({ user: googleOnly });
    expect(html).toContain('data-testid="theme-selector"');
    expect(html.match(/name="theme-preference"/g)).toHaveLength(3);
    for (const value of ["system", "dark", "light"]) expect(html).toContain(`value="${value}"`);
    for (const label of ["Auto", "Sombre", "Clair"]) expect(html).toContain(`>${label}<`);
  });

  it("shows the Discord alert status according to the linked identity", async () => {
    const notLinked = await render({ user: googleOnly });
    expect(notLinked).toContain(fr["account.notifications.discordNotLinked"]);
    const linked = await render({ user: bothLinked });
    expect(linked).toContain(fr["account.notifications.discordLinked"]);
    expect(linked).not.toContain(fr["account.notifications.discordNotLinked"]);
  });

  it("previews the default preferences (fr-FR, EUR)", async () => {
    const html = await render({ user: googleOnly });
    expect(html).toContain("Français (fr-FR)");
    expect(html).toContain("Euro (EUR)");
  });

  it("logs out through a native POST form on /api/auth/logout", async () => {
    const html = await render({ user: googleOnly });
    const form = html.match(/<form[^>]*>/)?.[0] ?? "";
    expect(form).toContain('method="post"');
    expect(form).toContain('action="/api/auth/logout"');
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain("Se déconnecter");
    expect(html).toContain("focus-visible:outline-2");
    expect(html).toContain("text-danger");
  });

  it("shows the iOS Safari PWA install guide in notifications when requested", async () => {
    const hidden = await render({ user: googleOnly });
    expect(hidden).not.toContain('data-testid="ios-pwa-install-guide"');

    const shown = await render({ user: googleOnly, showIosPwaGuide: true });
    const decoded = shown.replaceAll("&#x27;", "'");
    expect(shown).toContain('data-testid="ios-pwa-install-guide"');
    expect(decoded).toContain(fr["pwa.iosGuide.title"]);
    expect(decoded).toContain(fr["pwa.iosGuide.step1"]);
    expect(decoded).toContain(fr["pwa.iosGuide.step2"]);
    expect(decoded).toContain(fr["pwa.iosGuide.step3"]);
  });

  it("uses no raw hex colors", async () => {
    expect(
      await render({ user: bothLinked, error: "link_failed", showIosPwaGuide: true }),
    ).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

// ---------------------------------------------------------------------------
// Section « Partages lecture seule » (docs/01 §2.2)
// ---------------------------------------------------------------------------

const shareLink = (overrides: Partial<ShareLinkEntry> = {}): ShareLinkEntry => ({
  id: "44444444-4444-4444-8444-444444444444",
  binderId: "33333333-3333-4333-8333-333333333333",
  binderTitle: "Prisme Évolutif",
  token: "T".repeat(43),
  isActive: true,
  showQuantities: true,
  createdAt: "2026-03-12T10:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

const renderShares = (props: Partial<ShareLinksSectionViewProps> = {}): string =>
  renderToStaticMarkup(
    h(ShareLinksSectionView, {
      load: { status: "ready", links: [] },
      busyId: null,
      copiedId: null,
      copyFailedId: null,
      onCopy: vi.fn(),
      onRevoke: vi.fn(),
      onRetry: vi.fn(),
      ...props,
    }),
  );

describe("AccountScreen · Partages lecture seule", () => {
  it("renders the section heading in the account screen (loading before the client fetch)", async () => {
    const html = await render({ user: googleOnly });
    expect(html).toContain(fr["share.account.heading"]);
    expect(html).toContain('data-testid="account-shares-loading"');
  });

  it("lists active links with binder title, date, quantities status, copy and revoke", () => {
    const html = renderShares({
      load: {
        status: "ready",
        links: [
          shareLink(),
          shareLink({
            id: "55555555-5555-4555-8555-555555555555",
            binderTitle: "Doublons d'échange",
            showQuantities: false,
          }),
        ],
      },
    });
    expect(html.match(/data-testid="account-share-link"/g)).toHaveLength(2);
    expect(html).toContain("Prisme Évolutif");
    expect(html).toContain("Doublons d&#x27;échange");
    expect(html).toContain("Créé le 12 mars 2026");
    expect(html).toContain(fr["share.account.row.quantitiesOn"]);
    expect(html).toContain(fr["share.account.row.quantitiesOff"]);
    expect(html.match(/data-testid="account-share-copy"/g)).toHaveLength(2);
    expect(html.match(/data-testid="account-share-revoke"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Copier le lien de partage de Prisme Évolutif"');
    expect(html).toContain('aria-label="Révoquer le lien de partage de Prisme Évolutif"');
  });

  it("never prints the secret token in the list (only copied on demand)", () => {
    expect(renderShares({ load: { status: "ready", links: [shareLink()] } })).not.toContain(
      "T".repeat(43),
    );
  });

  it("shows « Lien copié » on the copied row only and disables a busy revocation", () => {
    const html = renderShares({
      load: { status: "ready", links: [shareLink()] },
      copiedId: "44444444-4444-4444-8444-444444444444",
      busyId: "44444444-4444-4444-8444-444444444444",
    });
    expect(html).toContain(fr["share.sheet.copied"]);
    expect(html).toMatch(/data-testid="account-share-revoke"[^>]*disabled/);
  });

  it("shows a clean empty state when there is no active link", () => {
    const html = renderShares();
    expect(html).toContain('data-testid="account-shares-empty"');
    expect(html).toContain(fr["share.account.empty.title"]);
    expect(html).not.toContain('data-testid="account-share-link"');
  });

  it("shows a retryable error state", () => {
    const html = renderShares({ load: { status: "error" } });
    expect(html).toContain('data-testid="account-shares-error"');
    expect(html).toContain('data-testid="account-shares-retry"');
  });

  it("falls back to a neutral title for a binder that no longer exists", () => {
    const html = renderShares({
      load: { status: "ready", links: [shareLink({ binderTitle: null })] },
    });
    expect(html).toContain(fr["share.account.row.binderFallback"]);
  });

  it("uses no raw hex colors", () => {
    expect(
      renderShares({ load: { status: "ready", links: [shareLink()] }, copiedId: "x" }),
    ).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
