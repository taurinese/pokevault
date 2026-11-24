import { readFileSync } from "node:fs";
import { CardAspectRatio, type UserCardCopy } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fr } from "../i18n/fr.ts";
import type { CardDetailPayload } from "../lib/card-detail-client.ts";
import {
  type AddCopyFormState,
  CardDetailView,
  type CardDetailViewActions,
  type CardDetailViewState,
} from "./CardDetailSheet.tsx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CARD_ID = "sv03.5-199";
const COPY_ID = "55555555-5555-4555-8555-555555555555";
const BINDER_ID = "33333333-3333-4333-8333-333333333333";

const copyFixture = (overrides: Partial<UserCardCopy> = {}): UserCardCopy => ({
  id: COPY_ID,
  userId: "11111111-1111-4111-8111-111111111111",
  cardId: CARD_ID,
  language: "FR",
  variant: "holo",
  condition: "NM",
  quantity: 2,
  purchasePriceCents: 1250,
  gradingCompany: "PSA",
  gradingScore: "9",
  notes: "Achetée à la convention",
  acquiredAt: "2026-01-01",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const payload: CardDetailPayload = {
  card: {
    id: CARD_ID,
    setId: "sv03.5",
    setNameFr: "Prisme Évolutif",
    setCode: "SV03.5",
    officialCount: 197,
    totalCount: 207,
    localId: "199",
    nameFr: "Dracaufeu ex",
    nameEn: "Charizard ex",
    rarity: "Rare secrète",
    holoEffect: "sir",
    category: "Pokemon",
    types: ["Feu"],
    hp: 330,
    illustrator: "takuyoa",
    imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199",
    availableVariants: ["normal", "reverse", "holo"],
    cardmarketUrl: "https://www.cardmarket.com/fr/Pokemon/Products/123",
  },
  copies: [
    copyFixture(),
    copyFixture({
      id: "77777777-7777-4777-8777-777777777777",
      variant: "normal",
      quantity: 1,
      purchasePriceCents: null,
      gradingCompany: null,
      gradingScore: null,
      notes: null,
    }),
  ],
  customBinders: [
    { id: BINDER_ID, title: "Évolutions Favs", containsCard: true },
    { id: "66666666-6666-4666-8666-666666666666", title: "Doublons", containsCard: false },
  ],
};

const formFixture: AddCopyFormState = {
  language: "FR",
  variant: "holo",
  condition: "NM",
  quantity: 1,
  priceRaw: "12,50",
  notes: "",
};

const makeState = (overrides: Partial<CardDetailViewState> = {}): CardDetailViewState => ({
  load: { status: "ready", payload },
  wishlisted: false,
  bindersOpen: true,
  addFormOpen: true,
  pendingCopyId: null,
  pendingBinderId: null,
  submittingAdd: false,
  actionError: false,
  form: formFixture,
  formError: null,
  ...overrides,
});

const makeActions = (overrides: Partial<CardDetailViewActions> = {}): CardDetailViewActions => ({
  onClose: vi.fn(),
  onRetry: vi.fn(),
  onToggleWishlist: vi.fn(),
  onOpenViewer3D: vi.fn(),
  onToggleBinders: vi.fn(),
  onToggleBinder: vi.fn(),
  onToggleAddForm: vi.fn(),
  onFormChange: vi.fn(),
  onSubmitAdd: vi.fn(),
  onStepper: vi.fn(),
  ...overrides,
});

const renderReady = (state = makeState(), actions = makeActions()): string =>
  renderToStaticMarkup(
    h(CardDetailView, { open: true, title: payload.card.nameFr, state, actions }),
  );

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

describe("CardDetailView — fiche prête", () => {
  it("rend le grand visuel high.webp au ratio 63/88 avec coins 12px", () => {
    const html = renderReady();
    expect(html).toContain("https://assets.tcgdex.net/fr/sv/sv03.5/199/high.webp");
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
    expect(html).toContain('data-testid="card-detail-image"');
    expect(html).toContain("border-radius:12px");
    expect(html).toContain('data-testid="card-detail-zoom"');
  });

  it("affiche les métadonnées TCGdex (nom, rareté, numéro, extension, illustrateur, types, PV)", () => {
    const html = renderReady();
    expect(html).toContain("Dracaufeu ex");
    expect(html).toContain("Rare secrète");
    // Numéro officiel localId/officialCount en tabular-nums
    expect(html).toContain("199/197");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("Prisme Évolutif (SV03.5)");
    expect(html).toContain("takuyoa");
    expect(html).toContain("Feu");
    expect(html).toContain("330");
  });

  it("rend le stepper - / qty / + avec cibles 44px et aria-labels précis", () => {
    const html = renderReady();
    expect(html).toContain(`data-testid="card-detail-minus-${COPY_ID}"`);
    expect(html).toContain(`data-testid="card-detail-plus-${COPY_ID}"`);
    expect(html).toContain(`data-testid="card-detail-qty-${COPY_ID}"`);
    expect(html).toContain("min-h-[44px] min-w-[44px]");
    expect(html).toContain("Retirer un exemplaire de Dracaufeu ex");
    expect(html).toContain("Ajouter un exemplaire de Dracaufeu ex");
    expect(html).toContain("Quantité : 2");
    // Badges langue / variante / état / grading + prix fr-FR + date + notes
    expect(html).toContain("Français (FR)");
    expect(html).toContain("Holo");
    expect(html).toContain("Near Mint");
    expect(html).toContain("PSA 9");
    expect(html).toContain("12,50");
    expect(html).toContain("Achetée à la convention");
  });

  it("désactive le bouton + au plafond 999", () => {
    const html = renderReady(
      makeState({
        load: {
          status: "ready",
          payload: { ...payload, copies: [copyFixture({ quantity: 999 })] },
        },
      }),
    );
    const plus =
      html.match(new RegExp(`data-testid="card-detail-plus-${COPY_ID}"[^>]*`))?.[0] ?? "";
    expect(plus).toContain("disabled");
  });

  it("rend le sélecteur de dossiers perso avec état containsCard", () => {
    const html = renderReady();
    expect(html).toContain('data-testid="card-detail-binders-panel"');
    expect(html).toContain(`data-testid="card-detail-binder-${BINDER_ID}"`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Évolutions Favs");
    expect(html).toContain("Doublons");
    expect(html).toContain('aria-pressed="false"');
  });

  it("affiche un message propre quand aucun dossier perso n'existe", () => {
    const html = renderReady(
      makeState({ load: { status: "ready", payload: { ...payload, customBinders: [] } } }),
    );
    expect(html).toContain('data-testid="card-detail-binders-empty"');
    expect(html).toContain("Aucun dossier perso");
  });

  it("rend le bloc prix Cardmarket avec lien externe sécurisé rel=noopener noreferrer", () => {
    const html = renderReady();
    expect(html).toContain('data-testid="card-detail-price"');
    expect(html).toContain('href="https://www.cardmarket.com/fr/Pokemon/Products/123"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("prix en temps réel arrivent bientôt");
  });

  it("rend le formulaire d'ajout déplié (langue, variante, état, quantité, prix, notes)", () => {
    const html = renderReady();
    expect(html).toContain('data-testid="card-detail-add-form"');
    expect(html).toContain('data-testid="card-detail-form-language"');
    expect(html).toContain('data-testid="card-detail-form-variant"');
    expect(html).toContain('data-testid="card-detail-form-condition"');
    expect(html).toContain('data-testid="card-detail-form-quantity"');
    expect(html).toContain('data-testid="card-detail-form-price"');
    expect(html).toContain('data-testid="card-detail-form-notes"');
    expect(html).toContain('data-testid="card-detail-add-submit"');
    expect(html).toContain('value="12,50"');
  });

  it("rend les états loading et error", () => {
    const loading = renderToStaticMarkup(
      h(CardDetailView, {
        open: true,
        title: "Fiche carte",
        state: makeState({ load: { status: "loading" } }),
        actions: makeActions(),
      }),
    );
    expect(loading).toContain('data-testid="card-detail-loading"');

    const error = renderToStaticMarkup(
      h(CardDetailView, {
        open: true,
        title: "Fiche carte",
        state: makeState({ load: { status: "error" } }),
        actions: makeActions(),
      }),
    );
    expect(error).toContain('data-testid="card-detail-error"');
    expect(error).toContain('data-testid="card-detail-retry"');
  });

  it("rend le toggle wishlist avec aria-pressed", () => {
    const html = renderReady(makeState({ wishlisted: true }));
    const toggle = html.match(/data-testid="card-detail-wishlist"[^>]*/)?.[0] ?? "";
    expect(toggle).toContain('aria-pressed="true"');
    expect(html).toContain("Retirer Dracaufeu ex de la wishlist");
  });

  it("n'affiche pas de fallback image quand imageBaseUrl est null (ImageOff)", () => {
    const html = renderReady(
      makeState({
        load: {
          status: "ready",
          payload: {
            ...payload,
            card: { ...payload.card, imageBaseUrl: null, cardmarketUrl: null },
          },
        },
      }),
    );
    expect(html).not.toContain("high.webp");
    expect(html).toContain("Visuel indisponible");
    expect(html).not.toContain('data-testid="card-detail-cardmarket-link"');
  });
});

// ---------------------------------------------------------------------------
// Hygiène design : zéro couleur hex brute dans le composant (tokens Dark/Light)
// ---------------------------------------------------------------------------

describe("CardDetailSheet — tokens uniquement", () => {
  it("ne contient aucune couleur hex dans le source du composant", () => {
    const source = readFileSync(new URL("./CardDetailSheet.tsx", import.meta.url), "utf8");
    const hexColors = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexColors).toEqual([]);
  });

  it("n'affiche aucune chaîne UI en dur : tout texte rendu vient du dictionnaire i18n (ou des données)", () => {
    const html = renderReady();
    const unescaped = html
      .replace(/<[^>]+>/g, "\n")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    const chunks = unescaped
      .split("\n")
      .map((text) => text.trim())
      .filter((text) => /[A-Za-zÀ-ÿ]{2,}/.test(text));
    expect(chunks.length).toBeGreaterThan(5);
    // Templates i18n : {placeholder} devient un joker.
    const i18nPatterns = Object.values(fr).map(
      (template) =>
        new RegExp(
          `^${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, ".+")}$`,
        ),
    );
    const dataJson = JSON.stringify(payload);
    const offenders = chunks.filter((chunk) => {
      if (i18nPatterns.some((pattern) => pattern.test(chunk))) return false;
      // Donnée de la fiche (nom, extension, grading…) ou valeur calculée (prix, quantité).
      if (chunk.split(/[\s()/,:]+/).every((word) => word === "" || dataJson.includes(word))) {
        return false;
      }
      if (/^[\d\s,.'’€$£¥%×+×#/-]+$/.test(chunk)) return false;
      return true;
    });
    expect(offenders).toEqual([]);
  });
});
