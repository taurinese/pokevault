import { readFileSync } from "node:fs";
import { CardAspectRatio } from "@pokevault/domain";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type AlertChannelsStatus,
  type AlertsPayload,
  type AlertTriggeredEvent,
  type AlertWatchItem,
  emptyAlertsPayload,
} from "../lib/alerts-client.ts";
import {
  AlertsView,
  type AlertsViewActions,
  type AlertsViewState,
  discordStatusLabel,
  formatAlertAgeLabel,
  gapLabel,
  isDiscordAvailable,
  pushStatusLabel,
} from "./AlertsScreen.tsx";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const CARDMARKET = "https://www.cardmarket.com/fr/Pokemon/Products/Singles/151/Charizard-ex";

const channels = (overrides: Partial<AlertChannelsStatus> = {}): AlertChannelsStatus => ({
  pushSubscriptionsCount: 0,
  pushConfigured: true,
  vapidPublicKey: "B".repeat(87),
  discordLinked: false,
  discordWebhookConfigured: false,
  discordDefaultConfigured: false,
  ...overrides,
});

let counter = 0;
const watch = (overrides: Partial<AlertWatchItem> = {}): AlertWatchItem => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    userId: "11111111-1111-4111-8111-111111111111",
    cardId: `sv03.5-${counter}`,
    language: "FR",
    variant: "normal",
    minCondition: "NM",
    priceField: "low_fr",
    thresholdCents: 1000,
    isActive: true,
    notifyPush: true,
    notifyDiscord: false,
    cooldownHours: 24,
    lastTriggeredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cardName: `Carte ${counter}`,
    setCode: "SV03.5",
    setName: "151",
    localId: String(counter),
    imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/1/low.webp",
    cardmarketUrl: null,
    trendCents: 1300,
    lowFrCents: 1200,
    priceSource: "cardmarket",
    priceFetchedAt: minutesAgo(1),
    ...overrides,
  };
};

const event = (overrides: Partial<AlertTriggeredEvent> = {}): AlertTriggeredEvent => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-e${String(counter).padStart(11, "0")}`,
    alertId: "00000000-0000-4000-8000-000000000001",
    cardId: `sv03.5-${counter}`,
    cardName: `Carte ${counter}`,
    setCode: "SV03.5",
    setName: "151",
    localId: String(counter),
    language: "FR",
    variant: "normal",
    imageUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/1/low.webp",
    cardmarketUrl: CARDMARKET,
    observedPriceCents: 4690,
    thresholdCents: 5000,
    channelsSent: ["push", "discord"],
    readAt: null,
    triggeredAt: minutesAgo(120),
    ...overrides,
  };
};

const DRACAUFEU_EVENT = event({
  cardName: "Dracaufeu ex",
  localId: "199",
  observedPriceCents: 4690,
  thresholdCents: 5000,
  channelsSent: ["push", "discord"],
  triggeredAt: minutesAgo(125),
});
const PIKACHU_EVENT = event({
  cardName: "Pikachu",
  localId: "25",
  observedPriceCents: 90,
  thresholdCents: 100,
  channelsSent: ["push"],
  readAt: minutesAgo(10),
  triggeredAt: minutesAgo(3),
  cardmarketUrl: "http://insecure.example/cm",
});

const ABOVE = watch({
  cardName: "Mew",
  localId: "151",
  thresholdCents: 1000,
  lowFrCents: 1200,
  language: "JP",
  variant: "holo",
  minCondition: "EX",
  cooldownHours: 48,
  notifyDiscord: true,
});
const REACHED = watch({
  cardName: "Évoli",
  localId: "10",
  thresholdCents: 1000,
  lowFrCents: 850,
});
const PAUSED = watch({
  cardName: "Salamèche",
  localId: "4",
  isActive: false,
  priceField: "trend",
  trendCents: 400,
  thresholdCents: 300,
});
const NO_PRICE = watch({
  cardName: "Rattata",
  localId: "19",
  lowFrCents: null,
  trendCents: null,
  priceSource: null,
  priceFetchedAt: null,
});
const FALLBACK = watch({
  cardName: "Roucool",
  localId: "16",
  priceSource: "tcgdex_fallback",
});

const payload = (overrides: Partial<AlertsPayload> = {}): AlertsPayload => ({
  available: true,
  channels: channels({ pushSubscriptionsCount: 2, discordLinked: true }),
  triggeredEvents: [DRACAUFEU_EVENT, PIKACHU_EVENT],
  alerts: [ABOVE, REACHED, PAUSED, NO_PRICE],
  unreadCount: 1,
  ...overrides,
});

const noop = (): void => undefined;
const makeActions = (overrides: Partial<AlertsViewActions> = {}): AlertsViewActions => ({
  onRetry: noop,
  onMarkAllRead: noop,
  onOpenEvent: noop,
  onToggleActive: noop,
  onEdit: noop,
  onAskDelete: noop,
  onCancelDelete: noop,
  onConfirmDelete: noop,
  onEnablePush: noop,
  onDisablePush: noop,
  onTestPush: noop,
  onOpenWebhook: noop,
  onWebhookDraftChange: noop,
  onSaveWebhook: noop,
  onRemoveWebhook: noop,
  onCancelWebhook: noop,
  onDismissToast: noop,
  ...overrides,
});

const baseState: AlertsViewState = {
  data: { status: "ready", data: payload() },
  push: { support: "supported", thisDevice: false, busy: false },
  webhook: null,
  pendingIds: new Set(),
  confirmingDeleteId: null,
  markingAllRead: false,
  toast: null,
  nowMs: NOW,
};

const render = async (
  state: Partial<AlertsViewState> = {},
  actions: AlertsViewActions = makeActions(),
): Promise<string> => {
  const rootRoute = createRootRoute({
    component: () => h(AlertsView, { state: { ...baseState, ...state }, actions }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/search", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/account", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(h(RouterProvider, { router }));
};

const ready = (data: AlertsPayload): Partial<AlertsViewState> => ({
  data: { status: "ready", data },
});

/** Balise ouvrante portant `data-testid="<id>"` (indépendant de l'ordre des attributs). */
const tagOf = (html: string, testId: string): string =>
  (html.match(/<[a-z]+[^>]*>/g) ?? []).find((tag) => tag.includes(`data-testid="${testId}"`)) ?? "";

const itemOf = (html: string, testId: string, needle: string): string => {
  const open = `<li data-testid="${testId}"`;
  const chunk = html
    .split(open)
    .slice(1)
    .find((part) => part.includes(needle));
  return chunk === undefined ? "" : `${open}${chunk}`;
};

describe("AlertsView — états", () => {
  it("renders the page heading", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Alertes de prix<\/h1>/);
  });

  it("renders skeletons while loading, with an accessible status", async () => {
    const html = await render({ data: { status: "loading" } });
    expect(html).toContain('data-testid="alerts-skeleton"');
    expect(html).toContain('aria-label="Chargement des alertes…"');
    expect(html).not.toContain('data-testid="alerts-channels"');
  });

  it("renders an error notice with a retry button", async () => {
    const html = await render({ data: { status: "error" } });
    expect(html).toContain('data-testid="alerts-error"');
    expect(html).toContain("Impossible de charger les alertes");
    expect(html).toContain("Réessayer");
  });

  it("renders a clean empty state inviting to create an alert from Search", async () => {
    const html = await render(ready(payload({ alerts: [], triggeredEvents: [], unreadCount: 0 })));
    expect(html).toContain('data-testid="alerts-empty"');
    expect(html).toContain("Aucune alerte pour l&#x27;instant");
    expect(html).toContain("Alerte prix");
    expect(html).toMatch(/<a[^>]*href="\/search"[^>]*>Chercher une carte<\/a>/);
    expect(html).not.toContain('data-testid="alerts-triggered"');
    expect(html).not.toContain('data-testid="alerts-watch"');
    // La barre des canaux reste visible pour configurer Push / Discord avant la 1re alerte.
    expect(html).toContain('data-testid="alerts-channels"');
  });

  it("explains when the database is not configured (empty documented payload)", async () => {
    const html = await render(ready(emptyAlertsPayload(channels(), false)));
    expect(html).toContain('data-testid="alerts-unavailable"');
    expect(html).not.toContain('data-testid="alerts-empty"');
  });

  it("shows the toast region (role=status) with the message and a dismiss button", async () => {
    const html = await render({ toast: { id: 1, tone: "success", message: "Alerte supprimée." } });
    expect(html).toMatch(/role="status"[^>]*data-testid="alerts-toast-region"/);
    expect(tagOf(html, "alerts-toast")).toContain('data-tone="success"');
    expect(html).toContain("Alerte supprimée.");
    expect(html).toContain('aria-label="Fermer la notification"');
    const error = await render({ toast: { id: 2, tone: "error", message: "Oups" } });
    expect(tagOf(error, "alerts-toast")).toContain("border-danger");
  });
});

describe("AlertsView — barre de statut des canaux (07A)", () => {
  it("labels the Push PWA channel: not configured / available / active with the device count", () => {
    expect(pushStatusLabel(channels({ pushConfigured: false }))).toBe("Non configuré");
    expect(pushStatusLabel(channels({ pushSubscriptionsCount: 0 }))).toBe("Disponible");
    expect(pushStatusLabel(channels({ pushSubscriptionsCount: 1 }))).toBe("Actif · 1 appareil");
    expect(pushStatusLabel(channels({ pushSubscriptionsCount: 3 }))).toBe("Actif · 3 appareils");
    expect(pushStatusLabel(channels({ pushConfigured: false, pushSubscriptionsCount: 3 }))).toBe(
      "Non configuré",
    );
  });

  it("labels the Discord channel: personal webhook > linked account > default webhook > to configure", () => {
    expect(
      discordStatusLabel(channels({ discordWebhookConfigured: true, discordLinked: true })),
    ).toBe("Webhook configuré");
    expect(
      discordStatusLabel(channels({ discordLinked: true, discordDefaultConfigured: true })),
    ).toBe("Compte lié");
    expect(discordStatusLabel(channels({ discordDefaultConfigured: true }))).toBe(
      "Webhook par défaut",
    );
    expect(discordStatusLabel(channels())).toBe("À configurer");
    expect(isDiscordAvailable(channels())).toBe(false);
    expect(isDiscordAvailable(channels({ discordDefaultConfigured: true }))).toBe(true);
  });

  it("renders both pills with the active tone (emerald tokens) when channels are active", async () => {
    const html = await render();
    const push = tagOf(html, "alerts-channel-push");
    const discord = tagOf(html, "alerts-channel-discord");
    expect(push).toContain('data-tone="active"');
    expect(push).toContain("border-success/40");
    expect(push).toContain("bg-success/10");
    expect(discord).toContain('data-tone="active"');
    expect(html).toMatch(/data-testid="alerts-channel-push-status"[^>]*>Actif · 2 appareils</);
    expect(html).toMatch(/data-testid="alerts-channel-discord-status"[^>]*>Compte lié</);
  });

  it("offers Activer on a supported device without a subscription", async () => {
    const html = await render();
    expect(tagOf(html, "alerts-push-enable")).toContain(
      'aria-label="Activer les notifications push sur cet appareil"',
    );
    expect(html).not.toContain('data-testid="alerts-push-test"');
  });

  it("offers Tester and Désactiver once this device is subscribed", async () => {
    const html = await render({ push: { support: "supported", thisDevice: true, busy: false } });
    expect(tagOf(html, "alerts-push-test")).toContain("Envoyer une notification de test");
    expect(tagOf(html, "alerts-push-disable")).toContain("Désactiver les notifications push");
    expect(html).not.toContain('data-testid="alerts-push-enable"');
  });

  it("disables the push buttons while busy", async () => {
    const html = await render({ push: { support: "supported", thisDevice: false, busy: true } });
    expect(tagOf(html, "alerts-push-enable")).toContain('disabled=""');
  });

  it("explains an unsupported or denied browser instead of offering buttons", async () => {
    const unsupported = await render({
      push: { support: "unsupported", thisDevice: false, busy: false },
    });
    expect(unsupported).toContain("Non pris en charge sur cet appareil");
    expect(unsupported).not.toContain('data-testid="alerts-push-enable"');
    const denied = await render({ push: { support: "denied", thisDevice: false, busy: false } });
    expect(denied).toContain("Notifications bloquées par le navigateur");
  });

  it("shows no push action when Push is not configured on the server", async () => {
    const html = await render(
      ready(payload({ channels: channels({ pushConfigured: false, vapidPublicKey: null }) })),
    );
    expect(html).toMatch(/data-testid="alerts-channel-push-status"[^>]*>Non configuré</);
    expect(html).not.toContain('data-testid="alerts-push-enable"');
    expect(tagOf(html, "alerts-channel-push")).toContain('data-tone="neutral"');
  });

  it("offers the webhook setting and a link to /account when Discord is not linked", async () => {
    const html = await render(ready(payload({ channels: channels() })));
    expect(tagOf(html, "alerts-discord-configure")).toContain(
      'aria-label="Configurer le webhook Discord"',
    );
    expect(tagOf(html, "alerts-discord-configure")).toContain('aria-expanded="false"');
    expect(html).toMatch(
      /<a[^>]*href="\/account"[^>]*data-testid="alerts-discord-link"|<a[^>]*data-testid="alerts-discord-link"[^>]*href="\/account"/,
    );
    const linked = await render();
    expect(linked).not.toContain('data-testid="alerts-discord-link"');
  });

  it("renders the webhook editor: URL input never pre-filled, hint, remove only when configured", async () => {
    const html = await render({ webhook: { draft: "", invalid: false, saving: false } });
    const input = tagOf(html, "alerts-webhook-input");
    expect(input).toContain('type="url"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('value=""');
    expect(input).toContain('placeholder="https://discord.com/api/webhooks/…"');
    expect(html).toContain("elle n&#x27;est jamais réaffichée");
    expect(tagOf(html, "alerts-discord-configure")).toContain('aria-expanded="true"');
    expect(html).not.toContain('data-testid="alerts-webhook-remove"');

    const configured = await render({
      ...ready(payload({ channels: channels({ discordWebhookConfigured: true }) })),
      webhook: { draft: "", invalid: false, saving: false },
    });
    expect(configured).toContain('data-testid="alerts-webhook-remove"');
  });

  it("flags an invalid webhook draft and disables the save buttons while saving", async () => {
    const invalid = await render({ webhook: { draft: "http://x", invalid: true, saving: false } });
    expect(tagOf(invalid, "alerts-webhook-input")).toContain('aria-invalid="true"');
    expect(invalid).toMatch(/role="alert"[^>]*data-testid="alerts-webhook-error"/);
    expect(invalid).toContain("URL invalide");
    const saving = await render({ webhook: { draft: "x", invalid: false, saving: true } });
    expect(saving).toMatch(/<button type="submit" disabled=""/);
  });
});

describe("AlertsView — « Déclenchées récemment » (07A)", () => {
  it("renders the emerald highlight with tokens only", async () => {
    const html = await render();
    expect(html).toContain('data-testid="alerts-triggered"');
    expect(html).toContain("Déclenchées récemment");
    const row = itemOf(html, "alerts-triggered-item", "Dracaufeu ex");
    expect(row).toContain("border-success/40");
    expect(row).toContain("bg-success/10");
  });

  it("shows the observed price vs threshold in tabular monospace", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-triggered-item", "Dracaufeu ex");
    expect(row).toMatch(/data-testid="alerts-triggered-observed"[^>]*>46,90(\s| )€</);
    expect(row).toMatch(/data-testid="alerts-triggered-threshold"[^>]*>50,00(\s| )€</);
    for (const id of ["alerts-triggered-observed", "alerts-triggered-threshold"]) {
      expect(tagOf(row, id)).toContain("font-mono");
      expect(tagOf(row, id)).toContain("tabular-nums");
    }
    expect(row).toContain("Constaté");
    expect(row).toContain("Seuil");
  });

  it("shows a real relative timestamp", async () => {
    const html = await render();
    expect(itemOf(html, "alerts-triggered-item", "Dracaufeu ex")).toMatch(
      /data-testid="alerts-triggered-age"[^>]*>il y a 2 h</,
    );
    expect(itemOf(html, "alerts-triggered-item", "Pikachu")).toMatch(
      /data-testid="alerts-triggered-age"[^>]*>il y a 3 min</,
    );
    expect(formatAlertAgeLabel(minutesAgo(0), NOW)).toBe("À l'instant");
    expect(formatAlertAgeLabel(minutesAgo(60 * 24 * 3), NOW)).toBe("il y a 3 j");
    expect(formatAlertAgeLabel("nope", NOW)).toBeNull();
  });

  it("shows the notified channel badges (Push / Discord)", async () => {
    const html = await render();
    const both = itemOf(html, "alerts-triggered-item", "Dracaufeu ex");
    expect(both).toContain('data-channel="push"');
    expect(both).toContain('data-channel="discord"');
    expect(both).toContain("Notifié via Push");
    expect(both).toContain("Notifié via Discord");
    const pushOnly = itemOf(html, "alerts-triggered-item", "Pikachu");
    expect(pushOnly).toContain('data-channel="push"');
    expect(pushOnly).not.toContain('data-channel="discord"');
  });

  it("links to Cardmarket with rel=noopener noreferrer, only for https URLs", async () => {
    const html = await render();
    const safe = itemOf(html, "alerts-triggered-item", "Dracaufeu ex");
    const link = tagOf(safe, "alerts-triggered-cardmarket");
    expect(link).toContain(`href="${CARDMARKET}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain("nouvel onglet");
    expect(safe).toContain("Cardmarket");
    // http:// → aucun lien rendu.
    expect(itemOf(html, "alerts-triggered-item", "Pikachu")).not.toContain(
      "alerts-triggered-cardmarket",
    );
    expect(html).not.toContain("insecure.example");
  });

  it("makes the card tappable to open the card sheet, with the unread dot only on unread events", async () => {
    const html = await render();
    const unread = itemOf(html, "alerts-triggered-item", "Dracaufeu ex");
    expect(tagOf(unread, "alerts-triggered-open")).toContain(
      'aria-label="Ouvrir la fiche de Dracaufeu ex"',
    );
    expect(tagOf(unread, "alerts-triggered-item")).toContain('data-unread="true"');
    expect(unread).toContain('data-testid="alerts-unread-dot"');
    const read = itemOf(html, "alerts-triggered-item", "Pikachu");
    expect(tagOf(read, "alerts-triggered-item")).toContain('data-unread="false"');
    expect(read).not.toContain('data-testid="alerts-unread-dot"');
  });

  it("keeps the card thumbnails at the official 63/88 ratio", async () => {
    const html = await render();
    expect(html).toContain(`aspect-ratio:${CardAspectRatio}`);
  });

  it("shows the unread counter and an enabled « Tout marquer comme lu » when some are unread", async () => {
    const html = await render();
    expect(html).toMatch(/data-testid="alerts-unread-count"[^>]*>1 non lue</);
    const button = tagOf(html, "alerts-mark-all-read");
    expect(button).not.toContain('disabled=""');
    expect(button).toContain('aria-label="Marquer toutes les alertes déclenchées comme lues"');
    expect(button).toContain("min-height:var(--touch-target-min)");
    expect(html).toContain("Tout marquer comme lu");
    const many = await render(ready(payload({ unreadCount: 4 })));
    expect(many).toMatch(/data-testid="alerts-unread-count"[^>]*>4 non lues</);
  });

  it("disables « Tout marquer comme lu » when nothing is unread or while marking", async () => {
    const none = await render(ready(payload({ unreadCount: 0 })));
    expect(tagOf(none, "alerts-mark-all-read")).toContain('disabled=""');
    expect(none).not.toContain('data-testid="alerts-unread-count"');
    const marking = await render({ markingAllRead: true });
    expect(tagOf(marking, "alerts-mark-all-read")).toContain('disabled=""');
  });

  it("hides the section when there is no triggered event", async () => {
    const html = await render(ready(payload({ triggeredEvents: [], unreadCount: 0 })));
    expect(html).not.toContain('data-testid="alerts-triggered"');
    expect(html).toContain('data-testid="alerts-watch"');
  });
});

describe("AlertsView — « En surveillance » (07B)", () => {
  it("renders every alert with the section counter", async () => {
    const html = await render();
    expect(html).toContain('data-testid="alerts-watch"');
    expect(html).toContain("En surveillance");
    expect(html.match(/data-testid="alerts-watch-item"/g)).toHaveLength(4);
    expect(html).toMatch(/data-testid="alerts-watch-count"[^>]*>4</);
  });

  it("shows the current price vs the target price in tabular monospace", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Mew");
    expect(row).toMatch(/data-testid="alerts-watch-current"[^>]*>12,00(\s| )€</);
    expect(row).toMatch(/data-testid="alerts-watch-target"[^>]*>10,00(\s| )€</);
    for (const id of ["alerts-watch-current", "alerts-watch-target", "alerts-watch-gap"]) {
      expect(tagOf(row, id)).toContain("font-mono");
      expect(tagOf(row, id)).toContain("tabular-nums");
    }
  });

  it("shows the remaining gap to the threshold (amount and percent)", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Mew");
    expect(tagOf(row, "alerts-watch-gap")).toContain('data-gap="remaining"');
    expect(row).toMatch(/Encore 2,00(\s| )€ \(17 %\) à perdre/);
    expect(gapLabel(ABOVE)).toMatch(/^Encore 2,00(\s| )€ \(17 %\) à perdre$/);
    expect(tagOf(row, "alerts-watch-item")).toContain('data-reached="false"');
  });

  it("highlights an alert whose threshold is already reached, with the margin", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Évoli");
    expect(tagOf(row, "alerts-watch-gap")).toContain('data-gap="reached"');
    expect(tagOf(row, "alerts-watch-gap")).toContain("text-success-strong");
    expect(row).toMatch(/Seuil atteint · marge 1,50(\s| )€/);
    expect(tagOf(row, "alerts-watch-item")).toContain('data-reached="true"');
  });

  it("follows the monitored field (trend vs lowest FR) and ignores indicative TCGdex prices", async () => {
    const html = await render();
    const trend = itemOf(html, "alerts-watch-item", "Salamèche");
    expect(trend).toMatch(/data-testid="alerts-watch-current"[^>]*>4,00(\s| )€</);
    expect(trend).toContain("Tendance");
    expect(itemOf(html, "alerts-watch-item", "Mew")).toContain("Plus bas FR");
    const fallback = await render(ready(payload({ alerts: [FALLBACK] })));
    expect(fallback).toContain('data-testid="alerts-watch-no-price"');
    expect(fallback).not.toContain('data-testid="alerts-watch-gap"');
  });

  it("says so when no Cardmarket price is known", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Rattata");
    expect(row).toContain('data-testid="alerts-watch-no-price"');
    expect(row).toContain("Prix Cardmarket indisponible");
    expect(row).not.toContain('data-testid="alerts-watch-current"');
    expect(row).not.toContain('data-testid="alerts-watch-gap"');
    expect(gapLabel(NO_PRICE)).toBeNull();
  });

  it("renders an accessible ON/OFF switch (role=switch, aria-checked, ≥ 44px) per alert", async () => {
    const html = await render();
    const on = tagOf(itemOf(html, "alerts-watch-item", "Mew"), "alerts-watch-switch");
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="Alerte active pour Mew"');
    expect(on).toContain("min-height:var(--touch-target-min)");
    expect(on).toContain("min-width:var(--touch-target-min)");
    const off = tagOf(itemOf(html, "alerts-watch-item", "Salamèche"), "alerts-watch-switch");
    expect(off).toContain('aria-checked="false"');
  });

  it("marks a paused alert (pause without deletion) and dims it", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Salamèche");
    expect(tagOf(row, "alerts-watch-item")).toContain('data-active="false"');
    expect(tagOf(row, "alerts-watch-item")).toContain("opacity-70");
    expect(row).toContain('data-testid="alerts-watch-paused"');
    expect(row).toContain("En pause");
    const active = itemOf(html, "alerts-watch-item", "Mew");
    expect(active).not.toContain('data-testid="alerts-watch-paused"');
  });

  it("disables the controls of an alert with a request in flight", async () => {
    const html = await render({ pendingIds: new Set([ABOVE.id]) });
    const row = itemOf(html, "alerts-watch-item", "Mew");
    expect(tagOf(row, "alerts-watch-switch")).toContain('disabled=""');
    expect(tagOf(row, "alerts-watch-edit")).toContain('disabled=""');
    expect(tagOf(row, "alerts-watch-delete")).toContain('disabled=""');
    const other = itemOf(html, "alerts-watch-item", "Évoli");
    expect(tagOf(other, "alerts-watch-edit")).not.toContain('disabled=""');
  });

  it("shows language, variant, minimum condition, cooldown and channels", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Mew");
    expect(row).toContain('aria-label="Japonais (JP)"');
    expect(row).toContain(">JP<");
    expect(row).toContain("Holo");
    expect(row).toContain("EX min.");
    expect(row).toContain("Cooldown 48 h");
    expect(row).toContain("Push + Discord");
  });

  it("offers edit and delete with explicit labels and 44px targets", async () => {
    const html = await render();
    const row = itemOf(html, "alerts-watch-item", "Mew");
    const edit = tagOf(row, "alerts-watch-edit");
    const del = tagOf(row, "alerts-watch-delete");
    expect(edit).toContain("Modifier l&#x27;alerte de Mew");
    expect(del).toContain("Supprimer l&#x27;alerte de Mew");
    expect(edit).toContain("min-height:var(--touch-target-min)");
    expect(del).toContain("min-width:var(--touch-target-min)");
  });

  it("asks for confirmation before deleting", async () => {
    const html = await render({ confirmingDeleteId: ABOVE.id });
    const row = itemOf(html, "alerts-watch-item", "Mew");
    expect(row).toContain('data-testid="alerts-delete-confirm"');
    expect(row).toContain('role="alertdialog"');
    expect(row).toContain("Supprimer cette alerte ?");
    expect(tagOf(row, "alerts-delete-yes")).not.toBe("");
    expect(row).not.toContain('data-testid="alerts-watch-edit"');
    // Les autres alertes gardent leurs boutons.
    expect(itemOf(html, "alerts-watch-item", "Évoli")).toContain('data-testid="alerts-watch-edit"');
  });

  it("hides the section when there is no alert", async () => {
    const html = await render(ready(payload({ alerts: [] })));
    expect(html).not.toContain('data-testid="alerts-watch"');
    expect(html).toContain('data-testid="alerts-triggered"');
    expect(html).not.toContain('data-testid="alerts-empty"');
  });
});

describe("AlertsView — thèmes Dark & Light (tokens)", () => {
  it("uses only token classes in the rendered markup (no raw colors)", async () => {
    const html = await render({
      toast: { id: 1, tone: "error", message: "x" },
      webhook: { draft: "", invalid: true, saving: false },
      confirmingDeleteId: ABOVE.id,
    });
    expect(html).not.toMatch(/(class|style)="[^"]*(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/);
    for (const token of [
      "bg-surface-1",
      "border-line",
      "text-primary",
      "text-secondary",
      "border-success/40",
      "bg-success/10",
      "text-success-strong",
      "border-danger",
    ]) {
      expect(html).toContain(token);
    }
  });

  it("contains no raw hex color, no `any`, no ts-ignore and no non-null assertion in the sources", () => {
    const source = readFileSync(new URL("./AlertsScreen.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(|hsla?\(/);
    expect(source).not.toMatch(/:\s*any\b|<any>|as any\b/);
    expect(source).not.toContain("@ts-ignore");
    expect(source).not.toMatch(/[A-Za-z0-9_)\]]!(?:[.[;,)\s])/);
  });
});
