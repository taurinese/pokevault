import { readFileSync } from "node:fs";
import { CardAspectRatio } from "@pokevault/domain";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AlertWatchItem } from "../lib/alerts-client.ts";
import {
  AlertFormSheet,
  type AlertFormTarget,
  type AlertFormValues,
  AlertFormView,
  type AlertFormViewActions,
  type AlertFormViewState,
  AlertSwitch,
  alertCardSubtitle,
  cooldownOptionsFor,
  createAlertTarget,
  DEFAULT_ALERT_FORM_VALUES,
  editAlertTarget,
  formReferenceCents,
  validateAlertForm,
} from "./AlertFormSheet.tsx";

const noop = (): void => undefined;
const makeActions = (overrides: Partial<AlertFormViewActions> = {}): AlertFormViewActions => ({
  onClose: noop,
  onChange: noop,
  onSubmit: noop,
  ...overrides,
});

const baseState: AlertFormViewState = {
  mode: "create",
  cardName: "Dracaufeu ex",
  subtitle: "n° 199 · 151",
  imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/199/low.webp",
  values: { ...DEFAULT_ALERT_FORM_VALUES },
  referenceCents: 2000,
  submitting: false,
  error: null,
  discordAvailable: null,
};

const render = (
  state: Partial<AlertFormViewState> = {},
  actions: AlertFormViewActions = makeActions(),
): string =>
  renderToStaticMarkup(
    h(AlertFormView, { open: true, state: { ...baseState, ...state }, actions }),
  );

/** Balise ouvrante portant `data-testid="<id>"` (indépendant de l'ordre des attributs). */
const tagOf = (html: string, testId: string): string =>
  (html.match(/<[a-z]+[^>]*>/g) ?? []).find((tag) => tag.includes(`data-testid="${testId}"`)) ?? "";

describe("AlertFormView — structure 07C", () => {
  it("renders the create title, the card summary and the submit button", () => {
    const html = render();
    expect(html).toContain("Créer une alerte");
    expect(html).toContain("Dracaufeu ex");
    expect(html).toContain("n° 199 · 151");
    expect(tagOf(html, "alert-form")).toContain('data-mode="create"');
    expect(html).toMatch(/data-testid="alert-form-submit"[^>]*>.*Créer l&#x27;alerte/s);
  });

  it("renders the edit title and the save label in edit mode", () => {
    const html = render({ mode: "edit" });
    expect(html).toContain("Modifier l&#x27;alerte");
    expect(tagOf(html, "alert-form")).toContain('data-mode="edit"');
    expect(html).toMatch(/data-testid="alert-form-submit"[^>]*>.*Enregistrer/s);
  });

  it("renders nothing when closed", () => {
    expect(
      renderToStaticMarkup(
        h(AlertFormView, { open: false, state: baseState, actions: makeActions() }),
      ),
    ).toBe("");
  });

  it("keeps the card thumbnail at the official 63/88 ratio", () => {
    expect(render()).toContain(`aspect-ratio:${CardAspectRatio}`);
  });
});

describe("AlertFormView — prix cible & raccourcis", () => {
  it("shows the current reference price in tabular monospace", () => {
    const html = render({ referenceCents: 2000 });
    expect(html).toMatch(/data-testid="alert-form-reference"[^>]*>Prix actuel · 20,00(\s| )€</);
    expect(tagOf(html, "alert-form-reference")).toContain("font-mono");
    expect(tagOf(html, "alert-form-reference")).toContain("tabular-nums");
  });

  it("offers the -5 % / -12 % / -20 % presets computed from the reference price", () => {
    const html = render({ referenceCents: 2000 });
    for (const [percent, price] of [
      [-5, "19,00"],
      [-12, "17,60"],
      [-20, "16,00"],
    ] as const) {
      const tag = tagOf(html, `alert-form-preset-${percent}`);
      expect(tag).not.toBe("");
      expect(tag).not.toContain('disabled=""');
      expect(tag).toContain(`Seuil à ${percent} % du prix actuel : ${price}`);
    }
    expect(html).toMatch(/-5 %/);
    expect(html).toMatch(/-12 %/);
    expect(html).toMatch(/-20 %/);
    expect(html).toContain("19,00");
  });

  it("disables the presets (and explains why) without any reference price", () => {
    const html = render({ referenceCents: null });
    for (const percent of [-5, -12, -20]) {
      expect(tagOf(html, `alert-form-preset-${percent}`)).toContain('disabled=""');
    }
    expect(html).toContain('data-testid="alert-form-reference-none"');
    expect(html).not.toContain('data-testid="alert-form-reference"');
  });

  it("marks the preset matching the typed threshold as pressed", () => {
    const html = render({ values: { ...DEFAULT_ALERT_FORM_VALUES, thresholdRaw: "17,60" } });
    expect(tagOf(html, "alert-form-preset--12")).toContain('aria-pressed="true"');
    expect(tagOf(html, "alert-form-preset--5")).toContain('aria-pressed="false"');
  });

  it("renders a mobile decimal input in tabular monospace, invalid state with an alert", () => {
    const html = render({ error: "threshold" });
    const input = tagOf(html, "alert-form-threshold");
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain("font-mono");
    expect(input).toContain("tabular-nums");
    expect(input).toContain('aria-invalid="true"');
    expect(html).toMatch(/role="alert"[^>]*data-error="threshold"[^>]*>Saisis un montant/);
  });
});

describe("AlertFormView — critères & canaux", () => {
  it("offers both price sources with the selected one checked", () => {
    const html = render({ values: { ...DEFAULT_ALERT_FORM_VALUES, priceField: "trend" } });
    expect(html).toContain("Plus bas FR");
    expect(html).toContain("Tendance");
    expect(html).toMatch(/aria-checked="false"[^>]*data-value="low_fr"/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="trend"/);
  });

  it("offers the seven minimum conditions M, NM, EX, GD, LP, PL, PO", () => {
    const html = render();
    const group = html.slice(html.indexOf('data-testid="alert-form-condition"'));
    for (const code of ["M", "NM", "EX", "GD", "LP", "PL", "PO"]) {
      expect(group).toMatch(new RegExp(`data-value="${code}"`));
    }
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="NM"/);
  });

  it("offers FR, EN, JP, ZH and the six variants", () => {
    const html = render({ values: { ...DEFAULT_ALERT_FORM_VALUES, language: "JP" } });
    for (const code of ["FR", "EN", "JP", "ZH"]) expect(html).toContain(`data-value="${code}"`);
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="JP"/);
    for (const variant of ["normal", "reverse", "holo", "promo", "pokeball", "masterball"]) {
      expect(html).toContain(`data-value="${variant}"`);
    }
  });

  it("offers the 6, 12, 24, 48 and 72 h cooldowns (24 h by default)", () => {
    const html = render();
    for (const hours of [6, 12, 24, 48, 72]) {
      expect(html).toContain(`data-value="${hours}"`);
      expect(html).toContain(`>${hours} h<`);
    }
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="24"/);
  });

  it("keeps an existing off-list cooldown selectable", () => {
    expect(cooldownOptionsFor(24)).toEqual([6, 12, 24, 48, 72]);
    expect(cooldownOptionsFor(36)).toEqual([6, 12, 24, 36, 48, 72]);
    const html = render({ values: { ...DEFAULT_ALERT_FORM_VALUES, cooldownHours: 36 } });
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="36"/);
  });

  it("renders Push PWA and Discord as role=switch with aria-checked and a 44px target", () => {
    const html = render({
      values: { ...DEFAULT_ALERT_FORM_VALUES, notifyPush: true, notifyDiscord: false },
    });
    const push = tagOf(html, "alert-form-notify-push");
    const discord = tagOf(html, "alert-form-notify-discord");
    expect(push).toContain('role="switch"');
    expect(push).toContain('aria-checked="true"');
    expect(push).toContain('aria-label="Push PWA"');
    expect(discord).toContain('role="switch"');
    expect(discord).toContain('aria-checked="false"');
    expect(discord).toContain('aria-label="Discord"');
    expect(push).toContain("min-height:var(--touch-target-min)");
    expect(push).toContain("min-width:var(--touch-target-min)");
  });

  it("hints that Discord is not configured only when Discord is on and unavailable", () => {
    const on = { ...DEFAULT_ALERT_FORM_VALUES, notifyDiscord: true };
    expect(render({ values: on, discordAvailable: false })).toContain(
      'data-testid="alert-form-discord-hint"',
    );
    expect(render({ values: on, discordAvailable: true })).not.toContain("alert-form-discord-hint");
    expect(render({ values: on, discordAvailable: null })).not.toContain("alert-form-discord-hint");
    expect(
      render({ values: { ...on, notifyDiscord: false }, discordAvailable: false }),
    ).not.toContain("alert-form-discord-hint");
  });

  it("shows the channels / generic / not-found errors and disables submit while saving", () => {
    expect(render({ error: "channels" })).toContain("Active au moins un canal");
    expect(render({ error: "generic" })).toContain("Impossible d&#x27;enregistrer l&#x27;alerte");
    expect(render({ error: "not-found" })).toContain("Cette alerte n&#x27;existe plus");
    const saving = render({ submitting: true });
    expect(tagOf(saving, "alert-form-submit")).toContain('disabled=""');
    expect(tagOf(saving, "alert-form-submit")).toContain('aria-busy="true"');
    expect(saving).toContain("Enregistrement…");
  });

  it("makes every interactive control at least 44px tall", () => {
    const html = render();
    expect(tagOf(html, "alert-form-submit")).toContain("min-height:var(--touch-target-min)");
    expect(tagOf(html, "alert-form-threshold")).toContain("min-height:var(--touch-target-min)");
    expect(tagOf(html, "alert-form-preset--5")).toContain("min-height:var(--touch-target-min)");
  });
});

describe("AlertFormView — thèmes Dark & Light (tokens)", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

  it("uses only token classes (no raw colors) in the rendered markup", () => {
    const html = render({
      error: "generic",
      values: { ...DEFAULT_ALERT_FORM_VALUES, notifyDiscord: true },
    });
    expect(html).not.toMatch(/(class|style)="[^"]*(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/);
    expect(html).toContain("bg-surface-1");
    expect(html).toContain("border-line");
    expect(html).toContain("text-primary");
    expect(html).toContain("bg-success");
    expect(html).toContain("border-gold");
  });

  it("contains no raw hex color, no `any`, no ts-ignore and no non-null assertion in the sources", () => {
    const source = readFileSync(new URL("./AlertFormSheet.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(|hsla?\(/);
    expect(source).not.toMatch(/:\s*any\b|<any>|as any\b/);
    expect(source).not.toContain("@ts-ignore");
    expect(source).not.toMatch(/[A-Za-z0-9_)\]]!(?:[.[;,)\s])/);
  });

  it("relies on tokens defined for Dark, Light and System themes", () => {
    for (const token of ["success", "success-strong", "gold-soft", "surface-1", "line", "danger"]) {
      expect(css).toContain(`--color-${token}:`);
    }
    // `--semantic-success-strong` : dark (défaut), light explicite, system/light.
    expect(tokens.match(/--semantic-success-strong:/g)?.length).toBeGreaterThanOrEqual(3);
    expect(tokens).toContain('[data-theme="dark"]');
    expect(tokens).toContain('[data-theme="light"]');
  });
});

describe("AlertSwitch", () => {
  it("exposes role=switch, aria-checked and a disabled state", () => {
    const html = renderToStaticMarkup(
      h(AlertSwitch, { checked: true, label: "Alerte active", onChange: noop, disabled: true }),
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Alerte active"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("min-width:var(--touch-target-min)");
  });
});

describe("validateAlertForm", () => {
  const ok: AlertFormValues = { ...DEFAULT_ALERT_FORM_VALUES, thresholdRaw: "12,50" };

  it("converts the euro amount to exact integer cents", () => {
    expect(validateAlertForm(ok)).toEqual({ ok: true, thresholdCents: 1250 });
    expect(validateAlertForm({ ...ok, thresholdRaw: "0,29" })).toEqual({
      ok: true,
      thresholdCents: 29,
    });
  });

  it("rejects an empty, zero, negative or malformed threshold", () => {
    for (const thresholdRaw of ["", "0", "0,00", "-3", "abc", "1,234"]) {
      expect(validateAlertForm({ ...ok, thresholdRaw })).toEqual({ ok: false, error: "threshold" });
    }
  });

  it("requires at least one channel", () => {
    expect(validateAlertForm({ ...ok, notifyPush: false, notifyDiscord: false })).toEqual({
      ok: false,
      error: "channels",
    });
    expect(validateAlertForm({ ...ok, notifyPush: false, notifyDiscord: true }).ok).toBe(true);
  });
});

describe("cibles de formulaire", () => {
  it("pre-fills a create target from a card sheet (card, default variant, current price)", () => {
    const target = createAlertTarget({
      cardId: "sv03.5-199",
      cardName: "Dracaufeu ex",
      subtitle: alertCardSubtitle("199", "151"),
      imageUrl: null,
      availableVariants: ["holo", "reverse"],
      price: { trendCents: 2100, lowFrCents: 1900 },
    });
    expect(target).toMatchObject({
      mode: "create",
      alertId: null,
      cardId: "sv03.5-199",
      subtitle: "n° 199 · 151",
      initial: { ...DEFAULT_ALERT_FORM_VALUES, variant: "reverse" },
      referencePrice: { trendCents: 2100, lowFrCents: 1900 },
    });
    // Variante `normal` privilégiée quand elle existe.
    expect(
      createAlertTarget({
        cardId: "x",
        cardName: "X",
        subtitle: null,
        imageUrl: null,
        availableVariants: ["holo", "normal"],
        price: null,
      }).initial.variant,
    ).toBe("normal");
  });

  it("builds an edit target from an existing alert (threshold back to euros, slot price)", () => {
    const alert: AlertWatchItem = {
      id: "00000000-0000-4000-8000-000000000001",
      userId: "11111111-1111-4111-8111-111111111111",
      cardId: "sv03.5-199",
      language: "EN",
      variant: "holo",
      minCondition: "EX",
      priceField: "trend",
      thresholdCents: 1760,
      isActive: true,
      notifyPush: false,
      notifyDiscord: true,
      cooldownHours: 48,
      lastTriggeredAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cardName: "Dracaufeu ex",
      setCode: "SV03.5",
      setName: "151",
      localId: "199",
      imageUrl: null,
      cardmarketUrl: null,
      trendCents: 2000,
      lowFrCents: 1800,
      priceSource: "cardmarket",
      priceFetchedAt: "2026-03-01T11:59:00.000Z",
    };
    const target = editAlertTarget(alert);
    expect(target).toMatchObject({
      mode: "edit",
      alertId: alert.id,
      initial: {
        thresholdRaw: "17,60",
        priceField: "trend",
        minCondition: "EX",
        language: "EN",
        variant: "holo",
        cooldownHours: 48,
        notifyPush: false,
        notifyDiscord: true,
      },
      referencePrice: { trendCents: 2000, lowFrCents: 1800 },
    });
    // Un prix indicatif TCGdex n'est pas une référence.
    expect(editAlertTarget({ ...alert, priceSource: "tcgdex_fallback" }).referencePrice).toBeNull();
  });

  it("only knows the reference price of the original slot and the selected field", () => {
    const target: AlertFormTarget = {
      ...createAlertTarget({
        cardId: "x",
        cardName: "X",
        subtitle: null,
        imageUrl: null,
        availableVariants: ["normal"],
        price: { trendCents: 2100, lowFrCents: 1900 },
      }),
    };
    expect(formReferenceCents(target, target.initial)).toBe(1900);
    expect(formReferenceCents(target, { ...target.initial, priceField: "trend" })).toBe(2100);
    expect(formReferenceCents(target, { ...target.initial, language: "JP" })).toBeNull();
    expect(formReferenceCents(target, { ...target.initial, variant: "holo" })).toBeNull();
    expect(
      formReferenceCents(
        { ...target, referencePrice: { trendCents: null, lowFrCents: null } },
        target.initial,
      ),
    ).toBeNull();
  });
});

describe("AlertFormSheet (conteneur)", () => {
  it("renders nothing without a target and the form once a target is given", () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    expect(renderToStaticMarkup(h(AlertFormSheet, { target: null, onClose, onSaved }))).toBe("");
    const target = createAlertTarget({
      cardId: "sv03.5-199",
      cardName: "Dracaufeu ex",
      subtitle: "n° 199 · 151",
      imageUrl: null,
      availableVariants: ["normal"],
      price: { trendCents: 2000, lowFrCents: 2000 },
    });
    const html = renderToStaticMarkup(h(AlertFormSheet, { target, onClose, onSaved }));
    expect(html).toContain('data-testid="alert-form"');
    expect(html).toContain("Dracaufeu ex");
    expect(html).toMatch(/Prix actuel · 20,00(\s| )€/);
  });
});
