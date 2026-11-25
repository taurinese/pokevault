import type { CardLanguage, CardVariant, NotificationChannel } from "@pokevault/domain";
import { Link } from "@tanstack/react-router";
import {
  Bell,
  BellRing,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";
import {
  ALERTS_PATH,
  type AlertChannelsStatus,
  type AlertsPayload,
  type AlertTriggeredEvent,
  type AlertWatchItem,
  alertChannels,
  computeAlertAge,
  computeThresholdGap,
  currentAlertPriceCents,
  deleteAlert,
  detectPushSupport,
  dispatchUnreadAlertsCount,
  fetchAlerts,
  isProfileDiscordWebhookUrl,
  markAlertEventsRead,
  markEventsReadLocally,
  type PushSupport,
  registerPushSubscription,
  saveDiscordWebhook,
  toPushSubscriptionBody,
  unregisterPushSubscription,
  updateAlert,
  vapidKeyToBytes,
} from "../lib/alerts-client.ts";
import { loginRedirectTo } from "../lib/auth-shared.ts";
import { formatPriceCents, isSafeHttpsUrl } from "../lib/card-detail-client.ts";
import {
  AlertFormSheet,
  type AlertFormTarget,
  AlertSwitch,
  alertCardSubtitle,
  editAlertTarget,
  priceFieldLabel,
} from "./AlertFormSheet.tsx";
import { CardDetailSheet } from "./CardDetailSheet.tsx";
import { CardTile } from "./CardTile.tsx";

// ---------------------------------------------------------------------------
// Modèle de vue (pur : rendu testable via `renderToStaticMarkup`)
// ---------------------------------------------------------------------------

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly data: T };

/** État Web Push de CET appareil (le navigateur, pas le compte). */
export interface PushUiState {
  readonly support: PushSupport;
  /** Un abonnement push existe déjà dans ce navigateur. */
  readonly thisDevice: boolean;
  /** Une activation / désactivation / un test est en cours. */
  readonly busy: boolean;
}

/** Éditeur inline du webhook Discord (jamais pré-rempli : l'URL est un secret). */
export interface WebhookEditorState {
  readonly draft: string;
  readonly invalid: boolean;
  readonly saving: boolean;
}

export interface AlertsToastState {
  readonly id: number;
  readonly tone: "success" | "error";
  readonly message: string;
}

export interface AlertsViewState {
  readonly data: Loadable<AlertsPayload>;
  readonly push: PushUiState;
  readonly webhook: WebhookEditorState | null;
  /** Alertes dont une requête est en cours (contrôles désactivés). */
  readonly pendingIds: ReadonlySet<string>;
  /** Alerte dont la suppression attend confirmation. */
  readonly confirmingDeleteId: string | null;
  readonly markingAllRead: boolean;
  readonly toast: AlertsToastState | null;
  /** Horloge de référence des horodatages relatifs (ms). */
  readonly nowMs: number;
}

export interface AlertsViewActions {
  readonly onRetry: () => void;
  readonly onMarkAllRead: () => void;
  readonly onOpenEvent: (event: AlertTriggeredEvent) => void;
  readonly onToggleActive: (alert: AlertWatchItem) => void;
  readonly onEdit: (alert: AlertWatchItem) => void;
  readonly onAskDelete: (alert: AlertWatchItem) => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: (alert: AlertWatchItem) => void;
  readonly onEnablePush: () => void;
  readonly onDisablePush: () => void;
  readonly onTestPush: () => void;
  readonly onOpenWebhook: () => void;
  readonly onWebhookDraftChange: (draft: string) => void;
  readonly onSaveWebhook: () => void;
  readonly onRemoveWebhook: () => void;
  readonly onCancelWebhook: () => void;
  readonly onDismissToast: () => void;
}

// ---------------------------------------------------------------------------
// Briques visuelles
// ---------------------------------------------------------------------------

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const touchTarget = { minHeight: "var(--touch-target-min)" } as const;
const touchSquare = {
  minWidth: "var(--touch-target-min)",
  minHeight: "var(--touch-target-min)",
} as const;

const primaryActionClass = `inline-flex items-center justify-center rounded-pill border border-gold bg-gold-soft px-5 text-sm font-semibold text-gold disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;
const secondaryActionClass = `inline-flex items-center justify-center rounded-pill border border-line bg-surface-1 px-4 text-sm font-semibold text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;

const LANGUAGE_BADGE_LABELS: Readonly<Record<CardLanguage, TranslationKey>> = {
  FR: "binderGrid.language.FR",
  EN: "binderGrid.language.EN",
  JP: "binderGrid.language.JP",
  ZH: "binderGrid.language.ZH",
};

const VARIANT_KEYS: Readonly<Record<CardVariant, TranslationKey>> = {
  normal: "binderGrid.variant.normal",
  reverse: "binderGrid.variant.reverse",
  holo: "binderGrid.variant.holo",
  promo: "binderGrid.variant.promo",
  pokeball: "binderGrid.variant.pokeball",
  masterball: "binderGrid.variant.masterball",
};

const CHANNEL_KEYS: Readonly<Record<NotificationChannel, TranslationKey>> = {
  push: "alerts.channel.push",
  discord: "alerts.channel.discord",
};

const StateNotice = ({
  testId,
  icon,
  title,
  description,
  action,
}: {
  readonly testId: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) => (
  <div
    data-testid={testId}
    className="flex flex-col items-center gap-3 rounded-sheet border border-line bg-surface-1 px-6 py-10 text-center shadow-card"
  >
    <span aria-hidden="true" className="text-muted">
      {icon}
    </span>
    <h2 className="text-base font-bold text-primary">{title}</h2>
    <p className="max-w-xs text-sm text-secondary">{description}</p>
    {action}
  </div>
);

const SkeletonList = () => (
  <div
    role="status"
    aria-label={t("alerts.loading")}
    data-testid="alerts-skeleton"
    className="flex flex-col gap-3 lg:grid lg:grid-cols-2 motion-reduce:animate-none"
  >
    {Array.from({ length: 3 }, (_, index) => (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: squelette statique sans identité
        key={index}
        aria-hidden="true"
        className="h-28 animate-pulse rounded-sheet border border-line bg-surface-2"
      />
    ))}
  </div>
);

/** Âge relatif réel d'un déclenchement (`À l'instant`, `il y a 6 min`, `il y a 2 h`, `il y a 3 j`). */
export const formatAlertAgeLabel = (triggeredAt: string, nowMs: number): string | null => {
  const age = computeAlertAge(triggeredAt, nowMs);
  if (age === null) return null;
  switch (age.kind) {
    case "just_now":
      return t("price.age.justNow");
    case "minutes":
      return t("price.age.minutesAgo", { count: age.count });
    case "hours":
      return t("price.age.hoursAgo", { count: age.count });
    case "days":
      return tPlural("price.age.daysAgo", age.count);
  }
};

const Pill = ({
  testId,
  label,
  status,
  tone,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly status: string;
  readonly tone: "active" | "neutral";
  readonly children?: ReactNode;
}) => (
  <div
    data-testid={testId}
    data-tone={tone}
    className={`flex min-w-0 flex-col gap-2 rounded-card border p-3 ${
      tone === "active" ? "border-success/40 bg-success/10" : "border-line bg-surface-1"
    }`}
  >
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs font-semibold text-secondary">{label}</span>
      <span
        className={`flex items-center gap-1.5 text-sm font-bold ${
          tone === "active" ? "text-success-strong" : "text-primary"
        }`}
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-pill ${tone === "active" ? "bg-success" : "bg-muted"}`}
        />
        <span data-testid={`${testId}-status`} className="min-w-0 truncate">
          {status}
        </span>
      </span>
    </div>
    {children === undefined ? null : <div className="flex flex-wrap gap-2">{children}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// Barre de statut des canaux (07A)
// ---------------------------------------------------------------------------

/** Libellé de statut du canal Push PWA. */
export const pushStatusLabel = (channels: AlertChannelsStatus): string => {
  if (!channels.pushConfigured) return t("alerts.push.notConfigured");
  if (channels.pushSubscriptionsCount > 0) {
    return tPlural("alerts.push.active", channels.pushSubscriptionsCount);
  }
  return t("alerts.push.available");
};

/** Libellé de statut du canal Discord (webhook perso > compte lié > webhook par défaut). */
export const discordStatusLabel = (channels: AlertChannelsStatus): string => {
  if (channels.discordWebhookConfigured) return t("alerts.discord.webhook");
  if (channels.discordLinked) return t("alerts.discord.linked");
  if (channels.discordDefaultConfigured) return t("alerts.discord.default");
  return t("alerts.discord.none");
};

/** Au moins un accès Discord utilisable (webhook perso, compte lié ou webhook par défaut). */
export const isDiscordAvailable = (channels: AlertChannelsStatus): boolean =>
  channels.discordWebhookConfigured || channels.discordLinked || channels.discordDefaultConfigured;

const PushPill = ({
  channels,
  push,
  actions,
}: {
  readonly channels: AlertChannelsStatus;
  readonly push: PushUiState;
  readonly actions: Pick<AlertsViewActions, "onEnablePush" | "onDisablePush" | "onTestPush">;
}) => {
  const active = channels.pushConfigured && channels.pushSubscriptionsCount > 0;
  const canAct = channels.pushConfigured && push.support === "supported";
  return (
    <Pill
      testId="alerts-channel-push"
      label={t("alerts.channels.push")}
      status={pushStatusLabel(channels)}
      tone={active ? "active" : "neutral"}
    >
      {canAct && push.thisDevice ? (
        <>
          <button
            type="button"
            data-testid="alerts-push-test"
            disabled={push.busy}
            onClick={actions.onTestPush}
            aria-label={t("alerts.push.test.aria")}
            style={touchTarget}
            className={secondaryActionClass}
          >
            {t("alerts.push.test")}
          </button>
          <button
            type="button"
            data-testid="alerts-push-disable"
            disabled={push.busy}
            onClick={actions.onDisablePush}
            aria-label={t("alerts.push.disable.aria")}
            style={touchTarget}
            className={secondaryActionClass}
          >
            {t("alerts.push.disable")}
          </button>
        </>
      ) : null}
      {canAct && !push.thisDevice ? (
        <button
          type="button"
          data-testid="alerts-push-enable"
          disabled={push.busy}
          onClick={actions.onEnablePush}
          aria-label={t("alerts.push.enable.aria")}
          style={touchTarget}
          className={primaryActionClass}
        >
          {t("alerts.push.enable")}
        </button>
      ) : null}
      {channels.pushConfigured && push.support !== "supported" ? (
        <span data-testid="alerts-push-note" className="text-xs text-muted">
          {t(push.support === "denied" ? "alerts.push.denied" : "alerts.push.unsupported")}
        </span>
      ) : null}
    </Pill>
  );
};

const WebhookEditor = ({
  editor,
  configured,
  actions,
}: {
  readonly editor: WebhookEditorState;
  readonly configured: boolean;
  readonly actions: Pick<
    AlertsViewActions,
    "onWebhookDraftChange" | "onSaveWebhook" | "onRemoveWebhook" | "onCancelWebhook"
  >;
}) => {
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    actions.onSaveWebhook();
  };
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      data-testid="alerts-webhook-form"
      className="flex flex-col gap-2 rounded-card border border-line bg-surface-2 p-3"
    >
      <label htmlFor="alerts-webhook-url" className="text-xs font-semibold text-secondary">
        {t("alerts.discord.webhook.label")}
      </label>
      <input
        id="alerts-webhook-url"
        data-testid="alerts-webhook-input"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={editor.draft}
        placeholder={t("alerts.discord.webhook.placeholder")}
        aria-invalid={editor.invalid}
        aria-describedby="alerts-webhook-hint"
        onChange={(event) => actions.onWebhookDraftChange(event.target.value)}
        style={touchTarget}
        className={`w-full rounded-card border bg-surface-1 px-3 font-mono text-xs text-primary ${focusRing} ${
          editor.invalid ? "border-danger" : "border-line"
        }`}
      />
      <p id="alerts-webhook-hint" className="text-[11px] text-muted">
        {t("alerts.discord.webhook.hint")}
      </p>
      {editor.invalid ? (
        <p role="alert" data-testid="alerts-webhook-error" className="text-xs text-danger">
          {t("alerts.discord.webhook.invalid")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={editor.saving}
          style={touchTarget}
          className={primaryActionClass}
        >
          {t("alerts.discord.webhook.save")}
        </button>
        {configured ? (
          <button
            type="button"
            data-testid="alerts-webhook-remove"
            disabled={editor.saving}
            onClick={actions.onRemoveWebhook}
            style={touchTarget}
            className={secondaryActionClass}
          >
            {t("alerts.discord.webhook.remove")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={actions.onCancelWebhook}
          style={touchTarget}
          className={secondaryActionClass}
        >
          {t("alerts.discord.webhook.cancel")}
        </button>
      </div>
    </form>
  );
};

const ChannelsBar = ({
  channels,
  push,
  webhook,
  actions,
}: {
  readonly channels: AlertChannelsStatus;
  readonly push: PushUiState;
  readonly webhook: WebhookEditorState | null;
  readonly actions: AlertsViewActions;
}) => (
  <section
    aria-label={t("alerts.channels.label")}
    data-testid="alerts-channels"
    className="flex flex-col gap-2"
  >
    <div className="grid grid-cols-2 gap-2">
      <PushPill channels={channels} push={push} actions={actions} />
      <Pill
        testId="alerts-channel-discord"
        label={t("alerts.channels.discord")}
        status={discordStatusLabel(channels)}
        tone={isDiscordAvailable(channels) ? "active" : "neutral"}
      >
        <button
          type="button"
          data-testid="alerts-discord-configure"
          aria-expanded={webhook !== null}
          aria-label={t("alerts.discord.configure.aria")}
          onClick={actions.onOpenWebhook}
          style={touchTarget}
          className={secondaryActionClass}
        >
          {t("alerts.discord.configure")}
        </button>
        {channels.discordLinked ? null : (
          <Link
            to="/account"
            data-testid="alerts-discord-link"
            style={touchTarget}
            className={secondaryActionClass}
          >
            {t("alerts.discord.link")}
          </Link>
        )}
      </Pill>
    </div>
    {webhook === null ? null : (
      <WebhookEditor
        editor={webhook}
        configured={channels.discordWebhookConfigured}
        actions={actions}
      />
    )}
  </section>
);

// ---------------------------------------------------------------------------
// Section « Déclenchées récemment » (07A)
// ---------------------------------------------------------------------------

const ChannelBadge = ({ channel }: { readonly channel: NotificationChannel }) => (
  <li
    aria-label={t("alerts.channel.sent", { channel: t(CHANNEL_KEYS[channel]) })}
    data-channel={channel}
    className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-secondary"
  >
    {t(CHANNEL_KEYS[channel])}
  </li>
);

const TriggeredRow = ({
  event,
  nowMs,
  onOpen,
}: {
  readonly event: AlertTriggeredEvent;
  readonly nowMs: number;
  readonly onOpen: (event: AlertTriggeredEvent) => void;
}) => {
  const unread = event.readAt === null;
  const age = formatAlertAgeLabel(event.triggeredAt, nowMs);
  return (
    <li
      data-testid="alerts-triggered-item"
      data-unread={unread ? "true" : "false"}
      className="flex flex-col gap-2 rounded-sheet border border-success/40 bg-success/10 p-3 shadow-card"
    >
      <button
        type="button"
        data-testid="alerts-triggered-open"
        aria-label={t("alerts.triggered.open", { name: event.cardName })}
        onClick={() => onOpen(event)}
        className={`flex gap-3 rounded-card text-left ${focusRing}`}
      >
        <span className="w-14 shrink-0 self-start">
          <CardTile
            name={event.cardName}
            label={event.cardName}
            {...(event.imageUrl === null ? {} : { imageUrl: event.imageUrl })}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-bold text-primary">
              {event.cardName}
            </span>
            {unread ? (
              <span
                data-testid="alerts-unread-dot"
                role="img"
                aria-label={t("alerts.triggered.unreadDot")}
                className="mt-1 size-2.5 shrink-0 rounded-pill bg-success-strong"
              />
            ) : null}
          </span>
          <span className="truncate text-xs text-secondary">
            {alertCardSubtitle(event.localId, event.setName)}
          </span>
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="flex items-baseline gap-1">
              <span className="text-[11px] text-secondary">{t("alerts.triggered.observed")}</span>
              <span
                data-testid="alerts-triggered-observed"
                className="font-mono text-base font-bold tabular-nums text-success-strong"
              >
                {formatPriceCents(event.observedPriceCents)}
              </span>
            </span>
            <span className="flex items-baseline gap-1">
              <span className="text-[11px] text-secondary">{t("alerts.triggered.threshold")}</span>
              <span
                data-testid="alerts-triggered-threshold"
                className="font-mono text-xs font-semibold tabular-nums text-secondary"
              >
                {formatPriceCents(event.thresholdCents)}
              </span>
            </span>
          </span>
          {age === null ? null : (
            <span
              data-testid="alerts-triggered-age"
              className="font-mono text-[11px] tabular-nums text-muted"
            >
              {age}
            </span>
          )}
        </span>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul
          aria-label={t("alerts.channels.label")}
          data-testid="alerts-triggered-channels"
          className="flex flex-wrap gap-1.5"
        >
          {event.channelsSent.map((channel) => (
            <ChannelBadge key={channel} channel={channel} />
          ))}
        </ul>
        {isSafeHttpsUrl(event.cardmarketUrl) ? (
          <a
            data-testid="alerts-triggered-cardmarket"
            href={event.cardmarketUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("alerts.triggered.cardmarket.aria", { name: event.cardName })}
            style={touchTarget}
            className={`inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface-1 px-3 text-sm font-semibold text-accent-blue hover:text-primary ${focusRing}`}
          >
            {t("alerts.triggered.cardmarket")}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </li>
  );
};

const TriggeredSection = ({
  events,
  unreadCount,
  nowMs,
  markingAllRead,
  actions,
}: {
  readonly events: ReadonlyArray<AlertTriggeredEvent>;
  readonly unreadCount: number;
  readonly nowMs: number;
  readonly markingAllRead: boolean;
  readonly actions: Pick<AlertsViewActions, "onMarkAllRead" | "onOpenEvent">;
}) => (
  <section
    aria-labelledby="alerts-triggered-heading"
    data-testid="alerts-triggered"
    className="flex flex-col gap-3"
  >
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id="alerts-triggered-heading" className="text-base font-bold text-primary">
          {t("alerts.triggered.heading")}
        </h2>
        {unreadCount > 0 ? (
          <span
            data-testid="alerts-unread-count"
            className="shrink-0 rounded-pill border border-success bg-success/15 px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-success-strong"
          >
            {tPlural("alerts.triggered.unread", unreadCount)}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="alerts-mark-all-read"
        disabled={unreadCount === 0 || markingAllRead}
        onClick={actions.onMarkAllRead}
        aria-label={t("alerts.triggered.markAll.aria")}
        style={touchTarget}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-success/40 bg-success/10 px-3 text-sm font-semibold text-success-strong disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        <CheckCheck size={16} aria-hidden="true" />
        {t("alerts.triggered.markAll")}
      </button>
    </div>
    <ul
      aria-label={t("alerts.triggered.list")}
      className="flex flex-col gap-3 lg:grid lg:grid-cols-2"
    >
      {events.map((event) => (
        <TriggeredRow key={event.id} event={event} nowMs={nowMs} onOpen={actions.onOpenEvent} />
      ))}
    </ul>
  </section>
);

// ---------------------------------------------------------------------------
// Section « En surveillance » (07B)
// ---------------------------------------------------------------------------

const Badge = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <li
    aria-label={label}
    className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-secondary"
  >
    {children}
  </li>
);

/** Ligne d'écart au seuil (`Encore 3,40 € (12 %) à perdre` / `Seuil atteint · marge 0,50 €`). */
export const gapLabel = (alert: AlertWatchItem): string | null => {
  const gap = computeThresholdGap(currentAlertPriceCents(alert), alert.thresholdCents);
  if (gap.kind === "unknown") return null;
  const amount = formatPriceCents(gap.cents) ?? "";
  return gap.kind === "reached"
    ? t("alerts.watch.gap.reached", { amount })
    : t("alerts.watch.gap.remaining", { amount, percent: gap.percent });
};

const WatchRow = ({
  alert,
  pending,
  confirmingDelete,
  actions,
}: {
  readonly alert: AlertWatchItem;
  readonly pending: boolean;
  readonly confirmingDelete: boolean;
  readonly actions: Pick<
    AlertsViewActions,
    "onToggleActive" | "onEdit" | "onAskDelete" | "onCancelDelete" | "onConfirmDelete"
  >;
}) => {
  const name = alert.cardName;
  const current = currentAlertPriceCents(alert);
  const gap = computeThresholdGap(current, alert.thresholdCents);
  const gapText = gapLabel(alert);
  const language = t(LANGUAGE_BADGE_LABELS[alert.language]);
  const variant = t(VARIANT_KEYS[alert.variant]);
  const channels = alertChannels(alert);
  const iconButton = `flex items-center justify-center rounded-pill border border-line bg-surface-1 text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;

  return (
    <li
      data-testid="alerts-watch-item"
      data-active={alert.isActive ? "true" : "false"}
      data-reached={gap.kind === "reached" ? "true" : "false"}
      className={`flex gap-3 rounded-sheet border bg-surface-1 p-3 shadow-card ${
        alert.isActive ? "border-line" : "border-line opacity-70"
      }`}
    >
      <div className="w-16 shrink-0 self-start">
        <CardTile
          name={name}
          label={name}
          {...(alert.imageUrl === null ? {} : { imageUrl: alert.imageUrl })}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-primary">{name}</h3>
            <p className="truncate text-xs text-secondary">
              {alertCardSubtitle(alert.localId, alert.setName)}
            </p>
          </div>
          <span className="-mt-1 -mr-1 shrink-0">
            <AlertSwitch
              testId="alerts-watch-switch"
              checked={alert.isActive}
              disabled={pending}
              label={t("alerts.watch.toggle", { name })}
              onChange={() => actions.onToggleActive(alert)}
            />
          </span>
        </div>

        <ul className="flex flex-wrap gap-1.5">
          <Badge label={language}>{alert.language}</Badge>
          <Badge label={variant}>{variant}</Badge>
          <Badge label={t("alerts.watch.minCondition", { condition: alert.minCondition })}>
            {t("alerts.watch.minCondition", { condition: alert.minCondition })}
          </Badge>
          <Badge label={priceFieldLabel(alert.priceField)}>
            {priceFieldLabel(alert.priceField)}
          </Badge>
          {alert.isActive ? null : (
            <li
              data-testid="alerts-watch-paused"
              className="rounded-md border border-warning px-1.5 py-0.5 text-[11px] font-semibold text-warning"
            >
              {t("alerts.watch.paused")}
            </li>
          )}
        </ul>

        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="flex items-baseline gap-1">
            <span className="text-[11px] text-secondary">{t("alerts.watch.current")}</span>
            {current === null ? (
              <span data-testid="alerts-watch-no-price" className="text-xs text-muted">
                {t("alerts.watch.noPrice")}
              </span>
            ) : (
              <span
                data-testid="alerts-watch-current"
                className="font-mono text-base font-bold tabular-nums text-primary"
              >
                {formatPriceCents(current)}
              </span>
            )}
          </span>
          <span className="flex items-baseline gap-1">
            <span className="text-[11px] text-secondary">{t("alerts.watch.target")}</span>
            <span
              data-testid="alerts-watch-target"
              className="font-mono text-sm font-semibold tabular-nums text-secondary"
            >
              {formatPriceCents(alert.thresholdCents)}
            </span>
          </span>
        </div>
        {gapText === null ? null : (
          <p
            data-testid="alerts-watch-gap"
            data-gap={gap.kind}
            className={`font-mono text-xs font-semibold tabular-nums ${
              gap.kind === "reached" ? "text-success-strong" : "text-secondary"
            }`}
          >
            {gapText}
          </p>
        )}
        <p className="font-mono text-[11px] tabular-nums text-muted">
          {t("alerts.watch.cooldown", { hours: alert.cooldownHours })}
          {channels.length === 0 ? "" : ` · ${channels.map((c) => t(CHANNEL_KEYS[c])).join(" + ")}`}
        </p>

        {confirmingDelete ? (
          <div
            role="alertdialog"
            aria-label={t("alerts.watch.delete.confirm")}
            data-testid="alerts-delete-confirm"
            className="flex flex-wrap items-center gap-2 rounded-card border border-danger bg-surface-2 p-2"
          >
            <span className="text-xs font-semibold text-primary">
              {t("alerts.watch.delete.confirm")}
            </span>
            <button
              type="button"
              data-testid="alerts-delete-yes"
              disabled={pending}
              onClick={() => actions.onConfirmDelete(alert)}
              style={touchTarget}
              className={`inline-flex items-center justify-center rounded-pill border border-danger px-4 text-sm font-semibold text-danger disabled:opacity-40 ${focusRing}`}
            >
              {t("alerts.watch.delete.yes")}
            </button>
            <button
              type="button"
              onClick={actions.onCancelDelete}
              style={touchTarget}
              className={secondaryActionClass}
            >
              {t("alerts.watch.delete.no")}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="alerts-watch-edit"
              aria-label={t("alerts.watch.edit", { name })}
              disabled={pending}
              onClick={() => actions.onEdit(alert)}
              style={touchSquare}
              className={iconButton}
            >
              <Pencil size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="alerts-watch-delete"
              aria-label={t("alerts.watch.delete", { name })}
              disabled={pending}
              onClick={() => actions.onAskDelete(alert)}
              style={touchSquare}
              className={iconButton}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
};

const WatchSection = ({
  alerts,
  pendingIds,
  confirmingDeleteId,
  actions,
}: {
  readonly alerts: ReadonlyArray<AlertWatchItem>;
  readonly pendingIds: ReadonlySet<string>;
  readonly confirmingDeleteId: string | null;
  readonly actions: AlertsViewActions;
}) => (
  <section
    aria-labelledby="alerts-watch-heading"
    data-testid="alerts-watch"
    className="flex flex-col gap-3"
  >
    <div className="flex items-baseline gap-2">
      <h2 id="alerts-watch-heading" className="text-base font-bold text-primary">
        {t("alerts.watch.heading")}
      </h2>
      <span
        data-testid="alerts-watch-count"
        className="font-mono text-xs font-semibold tabular-nums text-muted"
      >
        {alerts.length}
      </span>
    </div>
    <ul aria-label={t("alerts.watch.list")} className="flex flex-col gap-3 lg:grid lg:grid-cols-2">
      {alerts.map((alert) => (
        <WatchRow
          key={alert.id}
          alert={alert}
          pending={pendingIds.has(alert.id)}
          confirmingDelete={confirmingDeleteId === alert.id}
          actions={actions}
        />
      ))}
    </ul>
  </section>
);

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const ToastRegion = ({
  toast,
  onDismiss,
}: {
  readonly toast: AlertsToastState | null;
  readonly onDismiss: () => void;
}) => (
  <div
    role="status"
    aria-live="polite"
    data-testid="alerts-toast-region"
    className="pointer-events-none fixed inset-x-4 bottom-28 z-40 mx-auto max-w-md lg:right-8 lg:bottom-8 lg:left-60"
  >
    {toast === null ? null : (
      <div
        data-testid="alerts-toast"
        data-tone={toast.tone}
        className={`pointer-events-auto flex items-center gap-2 rounded-card border bg-surface-1 py-1.5 pr-1.5 pl-4 shadow-sheet ${
          toast.tone === "error" ? "border-danger" : "border-success"
        }`}
      >
        <p className="min-w-0 flex-1 text-sm font-semibold text-primary">{toast.message}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("alerts.toast.dismiss")}
          style={touchSquare}
          className={`flex shrink-0 items-center justify-center rounded-pill text-secondary hover:text-primary ${focusRing}`}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

export interface AlertsViewProps {
  readonly state: AlertsViewState;
  readonly actions: AlertsViewActions;
  /** Feuilles `07C` / `04` rendues par le conteneur. */
  readonly children?: ReactNode;
}

export const AlertsView = ({ state, actions, children }: AlertsViewProps) => {
  const payload = state.data.status === "ready" ? state.data.data : null;
  const isEmpty =
    payload?.available === true &&
    payload.alerts.length === 0 &&
    payload.triggeredEvents.length === 0;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-4 pt-10 pb-40 lg:max-w-5xl lg:gap-6 lg:px-8 lg:pb-12">
      <header className="flex items-center gap-2">
        <BellRing size={24} aria-hidden="true" className="text-gold" />
        <h1 className="text-2xl font-bold text-primary">{t("alerts.heading")}</h1>
      </header>

      {state.data.status === "loading" ? <SkeletonList /> : null}
      {state.data.status === "error" ? (
        <StateNotice
          testId="alerts-error"
          icon={<CircleAlert size={32} strokeWidth={1.5} />}
          title={t("alerts.error.title")}
          description={t("alerts.error.description")}
          action={
            <button
              type="button"
              onClick={actions.onRetry}
              style={touchTarget}
              className={primaryActionClass}
            >
              {t("alerts.error.retry")}
            </button>
          }
        />
      ) : null}

      {payload === null ? null : (
        <>
          <ChannelsBar
            channels={payload.channels}
            push={state.push}
            webhook={state.webhook}
            actions={actions}
          />
          {payload.available ? null : (
            <StateNotice
              testId="alerts-unavailable"
              icon={<CircleAlert size={32} strokeWidth={1.5} />}
              title={t("alerts.unavailable.title")}
              description={t("alerts.unavailable.description")}
            />
          )}
          {payload.triggeredEvents.length > 0 ? (
            <TriggeredSection
              events={payload.triggeredEvents}
              unreadCount={payload.unreadCount}
              nowMs={state.nowMs}
              markingAllRead={state.markingAllRead}
              actions={actions}
            />
          ) : null}
          {payload.alerts.length > 0 ? (
            <WatchSection
              alerts={payload.alerts}
              pendingIds={state.pendingIds}
              confirmingDeleteId={state.confirmingDeleteId}
              actions={actions}
            />
          ) : null}
          {isEmpty ? (
            <StateNotice
              testId="alerts-empty"
              icon={<Bell size={32} strokeWidth={1.5} />}
              title={t("alerts.empty.title")}
              description={t("alerts.empty.description")}
              action={
                <Link to="/search" style={touchTarget} className={primaryActionClass}>
                  {t("alerts.empty.cta")}
                </Link>
              }
            />
          ) : null}
        </>
      )}

      <ToastRegion toast={state.toast} onDismiss={actions.onDismissToast} />
      {children}
    </main>
  );
};

// ---------------------------------------------------------------------------
// Conteneur : chargement, mutations, Web Push, pastille Navbar B
// ---------------------------------------------------------------------------

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const redirectToLogin = (): void => {
  window.location.assign(loginRedirectTo(ALERTS_PATH));
};

const TOAST_DURATION_MS = 6000;
const CLOCK_TICK_MS = 60_000;

const getPushRegistration = async (): Promise<ServiceWorkerRegistration | undefined> =>
  navigator.serviceWorker.getRegistration();

export const AlertsScreen = () => {
  const [data, setData] = useState<Loadable<AlertsPayload>>({ status: "loading" });
  const [push, setPush] = useState<PushUiState>({
    support: "unsupported",
    thisDevice: false,
    busy: false,
  });
  const [webhook, setWebhook] = useState<WebhookEditorState | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [toast, setToast] = useState<AlertsToastState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  // Les rechargements après mutation gardent l'écran affiché (pas de retour au squelette).
  const [silentReload, setSilentReload] = useState(false);
  const [formTarget, setFormTarget] = useState<AlertFormTarget | null>(null);
  const [detailCard, setDetailCard] = useState<{ id: string; name: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    if (!silentReload) setData({ status: "loading" });
    fetchAlerts(controller.signal)
      .then((result) => {
        if (result.kind === "ok") {
          setData({ status: "ready", data: result.payload });
          setNowMs(Date.now());
          // Aligne la pastille de la Navbar B sur la vérité serveur.
          dispatchUnreadAlertsCount(result.payload.unreadCount);
        } else if (result.kind === "unauthorized") redirectToLogin();
        else
          setData((current) =>
            silentReload && current.status === "ready" ? current : { status: "error" },
          );
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setData({ status: "error" });
      });
    return () => controller.abort();
  }, [reloadToken]);

  // Fait vieillir les horodatages relatifs sans recharger la liste.
  useEffect(() => {
    const handle = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(handle);
  }, []);

  // Support Web Push + abonnement existant de CET appareil (côté client uniquement).
  useEffect(() => {
    let cancelled = false;
    const support = detectPushSupport();
    setPush((current) => ({ ...current, support }));
    if (support !== "supported") return;
    void (async () => {
      try {
        const registration = await getPushRegistration();
        const subscription = (await registration?.pushManager.getSubscription()) ?? null;
        if (!cancelled) setPush((current) => ({ ...current, thisDevice: subscription !== null }));
      } catch {
        // Service worker indisponible : l'appareil reste « non abonné ».
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Dismiss automatique du toast.
  useEffect(() => {
    if (toast === null) return;
    const handle = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, TOAST_DURATION_MS);
    return () => clearTimeout(handle);
  }, [toast]);

  const reload = (silent: boolean): void => {
    setSilentReload(silent);
    setReloadToken((token) => token + 1);
  };

  const showToast = (message: string, tone: "success" | "error"): void =>
    setToast((current) => ({ id: (current?.id ?? 0) + 1, tone, message }));

  const setPending = (id: string, pending: boolean): void =>
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });

  const patchPayload = (patch: (payload: AlertsPayload) => AlertsPayload): void =>
    setData((current) =>
      current.status === "ready" ? { status: "ready", data: patch(current.data) } : current,
    );

  const markRead = (event: AlertTriggeredEvent): void => {
    if (event.readAt !== null) return;
    const optimistic = data.status === "ready" ? Math.max(0, data.data.unreadCount - 1) : null;
    patchPayload((payload) => ({
      ...payload,
      unreadCount: Math.max(0, payload.unreadCount - 1),
      triggeredEvents: markEventsReadLocally(
        payload.triggeredEvents,
        new Date().toISOString(),
        event.id,
      ),
    }));
    if (optimistic !== null) dispatchUnreadAlertsCount(optimistic);
    void markAlertEventsRead(event.id).then((result) => {
      if (result.kind === "ok") {
        patchPayload((payload) => ({ ...payload, unreadCount: result.body }));
        dispatchUnreadAlertsCount(result.body);
      } else if (result.kind === "unauthorized") redirectToLogin();
      else reload(true);
    });
  };

  const setDiscordConfigured = (configured: boolean): void =>
    patchPayload((payload) => ({
      ...payload,
      channels: { ...payload.channels, discordWebhookConfigured: configured },
    }));

  const enablePush = async (): Promise<void> => {
    if (data.status !== "ready" || push.busy) return;
    const key = data.data.channels.vapidPublicKey;
    if (key === null) return;
    setPush((current) => ({ ...current, busy: true }));
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPush((current) => ({
          ...current,
          busy: false,
          support: permission === "denied" ? "denied" : current.support,
        }));
        showToast(t("alerts.push.toast.error"), "error");
        return;
      }
      const registration = await getPushRegistration();
      if (registration === undefined) throw new Error("no service worker");
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyToBytes(key),
        }));
      const body = toPushSubscriptionBody(subscription.toJSON(), navigator.userAgent);
      if (body === null) throw new Error("incomplete subscription");
      const result = await registerPushSubscription(body);
      if (result.kind === "unauthorized") return redirectToLogin();
      if (result.kind !== "ok") throw new Error("registration failed");
      setPush((current) => ({ ...current, busy: false, thisDevice: true }));
      showToast(t("alerts.push.toast.enabled"), "success");
      reload(true);
    } catch {
      setPush((current) => ({ ...current, busy: false }));
      showToast(t("alerts.push.toast.error"), "error");
    }
  };

  const disablePush = async (): Promise<void> => {
    if (push.busy) return;
    setPush((current) => ({ ...current, busy: true }));
    try {
      const registration = await getPushRegistration();
      const subscription = (await registration?.pushManager.getSubscription()) ?? null;
      if (subscription !== null) {
        const { endpoint } = subscription;
        await subscription.unsubscribe();
        const result = await unregisterPushSubscription(endpoint);
        if (result.kind === "unauthorized") return redirectToLogin();
      }
      setPush((current) => ({ ...current, busy: false, thisDevice: false }));
      showToast(t("alerts.push.toast.disabled"), "success");
      reload(true);
    } catch {
      setPush((current) => ({ ...current, busy: false }));
      showToast(t("alerts.error.action"), "error");
    }
  };

  const testPush = async (): Promise<void> => {
    if (push.busy) return;
    setPush((current) => ({ ...current, busy: true }));
    try {
      const registration = await getPushRegistration();
      if (registration === undefined) throw new Error("no service worker");
      await registration.showNotification(t("alerts.push.test.title"), {
        body: t("alerts.push.test.body"),
      });
      showToast(t("alerts.push.toast.tested"), "success");
    } catch {
      showToast(t("alerts.push.toast.error"), "error");
    } finally {
      setPush((current) => ({ ...current, busy: false }));
    }
  };

  const persistWebhook = (url: string | null): void => {
    setWebhook((current) => (current === null ? current : { ...current, saving: true }));
    void saveDiscordWebhook(url).then((result) => {
      if (result.kind === "unauthorized") return redirectToLogin();
      if (result.kind === "ok") {
        setDiscordConfigured(result.body.discordWebhookConfigured);
        setWebhook(null);
        showToast(
          t(url === null ? "alerts.discord.toast.removed" : "alerts.discord.toast.saved"),
          "success",
        );
        return;
      }
      setWebhook((current) =>
        current === null
          ? current
          : { ...current, saving: false, invalid: result.kind === "invalid" },
      );
      if (result.kind !== "invalid") showToast(t("alerts.error.action"), "error");
    });
  };

  const actions: AlertsViewActions = {
    onRetry: () => reload(false),

    onMarkAllRead: () => {
      if (markingAllRead) return;
      setMarkingAllRead(true);
      const readAt = new Date().toISOString();
      patchPayload((payload) => ({
        ...payload,
        unreadCount: 0,
        triggeredEvents: markEventsReadLocally(payload.triggeredEvents, readAt),
      }));
      // Mise à jour immédiate de la pastille Navbar B (avant la réponse serveur).
      dispatchUnreadAlertsCount(0);
      void markAlertEventsRead().then((result) => {
        setMarkingAllRead(false);
        if (result.kind === "ok") {
          showToast(t("alerts.toast.markedRead"), "success");
          dispatchUnreadAlertsCount(result.body);
          return;
        }
        if (result.kind === "unauthorized") return redirectToLogin();
        showToast(t("alerts.error.action"), "error");
        reload(true);
      });
    },

    onOpenEvent: (event) => {
      setDetailCard({ id: event.cardId, name: event.cardName });
      markRead(event);
    },

    onToggleActive: (alert) => {
      if (pendingIds.has(alert.id)) return;
      setPending(alert.id, true);
      const next = !alert.isActive;
      void updateAlert(alert.id, { isActive: next }).then((result) => {
        setPending(alert.id, false);
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok") {
          patchPayload((payload) => ({
            ...payload,
            alerts: payload.alerts.map((entry) =>
              entry.id === alert.id
                ? { ...entry, isActive: result.body.isActive, updatedAt: result.body.updatedAt }
                : entry,
            ),
          }));
          showToast(t(next ? "alerts.toast.resumed" : "alerts.toast.paused"), "success");
          return;
        }
        if (result.kind === "not-found") return reload(true);
        showToast(t("alerts.error.action"), "error");
      });
    },

    onEdit: (alert) => setFormTarget(editAlertTarget(alert)),

    onAskDelete: (alert) => setConfirmingDeleteId(alert.id),
    onCancelDelete: () => setConfirmingDeleteId(null),
    onConfirmDelete: (alert) => {
      if (pendingIds.has(alert.id)) return;
      setPending(alert.id, true);
      void deleteAlert(alert.id).then((result) => {
        setPending(alert.id, false);
        if (result.kind === "unauthorized") return redirectToLogin();
        if (result.kind === "ok" || result.kind === "not-found") {
          setConfirmingDeleteId(null);
          patchPayload((payload) => ({
            ...payload,
            alerts: payload.alerts.filter((entry) => entry.id !== alert.id),
            triggeredEvents: payload.triggeredEvents.filter((event) => event.alertId !== alert.id),
          }));
          showToast(t("alerts.toast.deleted"), "success");
          // L'évènement supprimé en cascade change le compteur de non lus.
          reload(true);
          return;
        }
        showToast(t("alerts.error.action"), "error");
      });
    },

    onEnablePush: () => void enablePush(),
    onDisablePush: () => void disablePush(),
    onTestPush: () => void testPush(),

    onOpenWebhook: () =>
      setWebhook((current) =>
        current === null ? { draft: "", invalid: false, saving: false } : null,
      ),
    onWebhookDraftChange: (draft) =>
      setWebhook((current) => (current === null ? current : { ...current, draft, invalid: false })),
    onSaveWebhook: () => {
      if (webhook === null || webhook.saving) return;
      const url = webhook.draft.trim();
      if (!isProfileDiscordWebhookUrl(url)) {
        setWebhook({ ...webhook, invalid: true });
        return;
      }
      persistWebhook(url);
    },
    onRemoveWebhook: () => {
      if (webhook === null || webhook.saving) return;
      persistWebhook(null);
    },
    onCancelWebhook: () => setWebhook(null),
    onDismissToast: () => setToast(null),
  };

  const payload = data.status === "ready" ? data.data : null;

  return (
    <AlertsView
      state={{
        data,
        push,
        webhook,
        pendingIds,
        confirmingDeleteId,
        markingAllRead,
        toast,
        nowMs,
      }}
      actions={actions}
    >
      <AlertFormSheet
        target={formTarget}
        discordAvailable={payload === null ? null : isDiscordAvailable(payload.channels)}
        onClose={() => setFormTarget(null)}
        onSaved={() => {
          setFormTarget(null);
          showToast(t("alerts.toast.updated"), "success");
          reload(true);
        }}
      />
      <CardDetailSheet
        cardId={detailCard?.id ?? null}
        cardName={detailCard?.name}
        onClose={() => setDetailCard(null)}
      />
    </AlertsView>
  );
};
