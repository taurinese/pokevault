import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import type { ShareLinkEntry } from "../lib/share-client.ts";
import {
  CopyLinkButton,
  ShareLinkSheet,
  ShareLinkSheetView,
  type ShareLinkSheetViewActions,
  type ShareLinkSheetViewState,
  ShareSwitch,
} from "./ShareLinkSheet.tsx";

const TOKEN = "T".repeat(43);
const LINK_ID = "44444444-4444-4444-8444-444444444444";

const link = (overrides: Partial<ShareLinkEntry> = {}): ShareLinkEntry => ({
  id: LINK_ID,
  binderId: "33333333-3333-4333-8333-333333333333",
  binderTitle: "Prisme Évolutif",
  token: TOKEN,
  isActive: true,
  showQuantities: true,
  createdAt: "2026-03-12T10:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

const baseState: ShareLinkSheetViewState = {
  open: true,
  binderTitle: "Prisme Évolutif",
  load: { status: "ready" },
  links: [],
  displayName: "Ada Lovelace",
  newShowQuantities: true,
  origin: "https://pokevault.example",
  busyId: null,
  confirmRevokeId: null,
  copiedId: null,
  copyFailedId: null,
  notice: null,
};

const actions = (): ShareLinkSheetViewActions => ({
  onClose: vi.fn(),
  onRetry: vi.fn(),
  onNewShowQuantitiesChange: vi.fn(),
  onCreate: vi.fn(),
  onCopy: vi.fn(),
  onToggleQuantities: vi.fn(),
  onAskRevoke: vi.fn(),
  onRevoke: vi.fn(),
});

const render = (state: Partial<ShareLinkSheetViewState> = {}): string =>
  renderToStaticMarkup(
    h(ShareLinkSheetView, { state: { ...baseState, ...state }, actions: actions() }),
  );

/** `renderToStaticMarkup` échappe l'apostrophe en `&#x27;`. */
const escaped = (text: string): string => text.replaceAll("'", "&#x27;");

describe("ShareLinkSheetView · confidentialité", () => {
  it("states the public display name and that no e-mail, purchase price or private note is shared", () => {
    const html = render();
    expect(html).toContain(fr["share.sheet.title"]);
    expect(html).toMatch(/data-testid="share-public-name"[^>]*>Ada Lovelace</);
    expect(html).toContain(fr["share.sheet.publicName.label"]);
    expect(html).toContain(escaped(fr["share.sheet.privacy"]));
    expect(html).toMatch(/e-mail, prix d&#x27;achat ni note privée/);
  });

  it("falls back to « Collectionneur » without a display name", () => {
    expect(render({ displayName: null })).toMatch(
      /data-testid="share-public-name"[^>]*>Collectionneur</,
    );
    expect(render({ displayName: "  " })).toMatch(
      /data-testid="share-public-name"[^>]*>Collectionneur</,
    );
  });

  it("renders nothing while closed", () => {
    expect(render({ open: false })).toBe("");
    expect(
      renderToStaticMarkup(
        h(ShareLinkSheet, { open: false, binderId: "b", binderTitle: "T", onClose: vi.fn() }),
      ),
    ).toBe("");
  });
});

describe("ShareLinkSheetView · création", () => {
  it("offers a quantities switch (on by default) and a create button when no link exists", () => {
    const html = render();
    expect(html).toContain('data-testid="share-create-panel"');
    expect(html).toContain(fr["share.sheet.quantities.label"]);
    expect(html).toMatch(
      /role="switch"[^>]*aria-checked="true"[^>]*data-testid="share-new-quantities"/,
    );
    expect(html).toContain(fr["share.sheet.create"]);
    expect(html).not.toContain('data-testid="share-link"');
  });

  it("reflects a disabled quantities default and the creating state", () => {
    expect(render({ newShowQuantities: false })).toMatch(
      /aria-checked="false"[^>]*data-testid="share-new-quantities"/,
    );
    const busy = render({ busyId: "create" });
    expect(busy).toContain(fr["share.sheet.creating"]);
    expect(busy).toMatch(/data-testid="share-create"[^>]*disabled/);
  });
});

describe("ShareLinkSheetView · lien actif", () => {
  it("shows the full /s/<token> URL, copy, preview, quantities switch and revoke", () => {
    const html = render({ links: [link()] });
    expect(html).toContain(`value="https://pokevault.example/s/${TOKEN}"`);
    expect(html).toContain('readOnly=""');
    expect(html).toContain('data-testid="share-copy"');
    expect(html).toContain(fr["share.sheet.copy"]);
    expect(html).toMatch(
      new RegExp(
        `data-testid="share-preview"[^>]*href="/s/${TOKEN}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`,
      ),
    );
    expect(html).toMatch(/data-testid="share-link-quantities"/);
    expect(html).toContain('data-testid="share-revoke"');
    expect(html).toContain("Créé le 12 mars 2026");
    // « Créer un autre lien » reste proposé (plusieurs liens actifs permis).
    expect(html).toContain(fr["share.sheet.createAnother"]);
  });

  it("reflects the link's own showQuantities setting", () => {
    const off = render({ links: [link({ showQuantities: false })] });
    expect(off).toMatch(/aria-checked="false"[^>]*data-testid="share-link-quantities"/);
  });

  it("gives instant « Lien copié » feedback and announces it", () => {
    const html = render({ links: [link()], copiedId: LINK_ID });
    expect(html).toContain(fr["share.sheet.copied"]);
    expect(html).toMatch(/role="status"[^>]*data-testid="share-copy-status"[^>]*>Lien copié</);
  });

  it("explains a failed copy so the URL can be copied by hand", () => {
    const html = render({ links: [link()], copyFailedId: LINK_ID });
    expect(html).toContain(fr["share.sheet.copyFailed"]);
  });

  it("asks for confirmation before the (irreversible) revocation", () => {
    const html = render({ links: [link()], confirmRevokeId: LINK_ID });
    expect(html).toContain('data-testid="share-revoke-confirm"');
    expect(html).toContain('data-testid="share-revoke-yes"');
    expect(html).toContain('data-testid="share-revoke-cancel"');
    expect(html).not.toContain('data-testid="share-revoke"');
  });

  it("disables the actions of a link while one is in flight", () => {
    const html = render({ links: [link()], busyId: LINK_ID });
    expect(html).toMatch(/data-testid="share-revoke"[^>]*disabled/);
    expect(html).toMatch(/data-testid="share-link-quantities"[^>]*disabled/);
  });

  it("confirms an immediate revocation and the empty state returns", () => {
    const html = render({ links: [], notice: "revoked" });
    expect(html).toContain('data-testid="share-notice-revoked"');
    expect(html).toContain(fr["share.sheet.revoked"]);
    expect(html).toContain('data-testid="share-create-panel"');
  });

  it("surfaces an action error", () => {
    expect(render({ notice: "error" })).toContain('data-testid="share-notice-error"');
  });
});

describe("ShareLinkSheetView · chargement", () => {
  it("renders the loading and retryable error states without leaking links", () => {
    const loading = render({ load: { status: "loading" }, links: [link()] });
    expect(loading).toContain('data-testid="share-loading"');
    expect(loading).not.toContain('data-testid="share-link"');
    const error = render({ load: { status: "error" } });
    expect(error).toContain('data-testid="share-error"');
    expect(error).toContain('data-testid="share-retry"');
  });
});

describe("briques partagées", () => {
  it("ShareSwitch exposes role=switch, aria-checked and a ≥ 44px target", () => {
    const html = renderToStaticMarkup(
      h(ShareSwitch, { checked: true, label: "Quantités", testId: "sw", onChange: vi.fn() }),
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Quantités"');
    expect(html).toContain("min-height:var(--touch-target-min)");
  });

  it("CopyLinkButton labels the target binder for assistive tech", () => {
    const html = renderToStaticMarkup(
      h(CopyLinkButton, { title: "Mon classeur", copied: false, failed: false, onCopy: vi.fn() }),
    );
    expect(html).toContain('aria-label="Copier le lien de partage de Mon classeur"');
    expect(html).toContain(fr["share.sheet.copy"]);
  });
});
