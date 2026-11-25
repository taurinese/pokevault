import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bell, Check, Link2, LogOut, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import {
  type AccountLinkError,
  AUTH_LOGOUT_API_PATH,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  oauthLinkHref,
} from "../lib/auth-shared.ts";
import { avatarInitials } from "../lib/profile.ts";
import { clearPrivateServiceWorkerCache } from "../lib/pwa.ts";
import {
  activeShareLinks,
  fetchShareLinks,
  formatShareDate,
  revokeShareLink,
  type ShareLinkEntry,
  sharedPageUrl,
} from "../lib/share-client.ts";
import { DiscordIcon, GoogleIcon } from "./BrandIcons.tsx";
import { IosPwaInstallGuide } from "./IosPwaInstallGuide.tsx";
import { CopyLinkButton, useCopyFeedback } from "./ShareLinkSheet.tsx";
import { ThemeSelector } from "./ThemeSelector.tsx";

/** Sous-ensemble sérialisable de `SessionUser` consommé par l'écran. */
export interface AccountUser {
  readonly email: string | null;
  readonly displayName: string | null;
  readonly identities: ReadonlyArray<{ readonly provider: OAuthProvider }>;
}

export interface AccountScreenProps {
  readonly user: AccountUser;
  /** `?linked=` : provider qui vient d'être lié. */
  readonly linked?: OAuthProvider | undefined;
  /** `?error=` : échec ou annulation de la liaison. */
  readonly error?: AccountLinkError | undefined;
  /** Contrôle explicite du micro-guide iOS Safari (tests SSR ; détection auto par défaut). */
  readonly showIosPwaGuide?: boolean | undefined;
}

const PROVIDER_LABEL_KEY = {
  google: "account.provider.google",
  discord: "account.provider.discord",
} as const;

const PROVIDER_LINK_KEY = {
  google: "account.linked.linkGoogle",
  discord: "account.linked.linkDiscord",
} as const;

const PROVIDER_ICON = { google: GoogleIcon, discord: DiscordIcon } as const;

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const Section = ({
  id,
  title,
  description,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) => (
  <section
    aria-labelledby={id}
    className="flex flex-col gap-4 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
  >
    <div className="flex flex-col gap-1">
      <h2 id={id} className="text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
      </h2>
      {description === undefined ? null : <p className="text-sm text-secondary">{description}</p>}
    </div>
    {children}
  </section>
);

const LinkedBadge = () => (
  <span
    data-testid="provider-linked-badge"
    className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-3 py-1 text-xs font-semibold text-success"
  >
    <Check size={14} aria-hidden="true" />
    {t("account.linked.badge")}
  </span>
);

const ProfileCard = ({
  user,
  linkedProviders,
}: {
  readonly user: AccountUser;
  readonly linkedProviders: ReadonlySet<OAuthProvider>;
}) => {
  const name = user.displayName ?? t("account.profile.fallbackName");
  const providers = OAUTH_PROVIDERS.filter((provider) => linkedProviders.has(provider));
  return (
    <section
      aria-label={t("account.profile.label")}
      data-testid="account-profile"
      className="flex items-center gap-4 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
    >
      <span
        data-testid="account-avatar"
        aria-hidden="true"
        className="flex size-16 shrink-0 items-center justify-center rounded-pill bg-gold-soft text-xl font-bold text-gold"
      >
        {avatarInitials(user.displayName)}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-lg font-bold text-primary">{name}</p>
        <p className="truncate text-sm text-secondary">
          {user.email ?? t("account.profile.noEmail")}
        </p>
        <p className="flex items-center gap-2 text-xs text-muted">
          {providers.map((provider) => {
            const Icon = PROVIDER_ICON[provider];
            return <Icon key={provider} size={14} />;
          })}
          <span>
            {providers.length === 0
              ? t("account.profile.noLinkedProvider")
              : t("account.profile.linkedProviders", {
                  providers: providers
                    .map((provider) => t(PROVIDER_LABEL_KEY[provider]))
                    .join(", "),
                })}
          </span>
        </p>
      </div>
    </section>
  );
};

const ProviderRow = ({
  provider,
  isLinked,
}: {
  readonly provider: OAuthProvider;
  readonly isLinked: boolean;
}) => {
  const Icon = PROVIDER_ICON[provider];
  const label = t(PROVIDER_LABEL_KEY[provider]);
  return (
    <li
      data-testid={`provider-row-${provider}`}
      className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface-2 px-4 py-3"
    >
      <span className="flex items-center gap-3 text-sm font-semibold text-primary">
        <Icon />
        {label}
      </span>
      {isLinked ? (
        <LinkedBadge />
      ) : (
        <a
          href={oauthLinkHref(provider)}
          aria-label={t("account.linked.linkAria", { provider: label })}
          className={`flex items-center justify-center rounded-pill bg-gold-soft px-4 text-sm font-semibold text-gold transition-colors hover:bg-surface-1 ${focusRing}`}
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          {t(PROVIDER_LINK_KEY[provider])}
        </a>
      )}
    </li>
  );
};

const FeedbackBanner = ({
  linked,
  error,
}: {
  readonly linked: OAuthProvider | undefined;
  readonly error: AccountLinkError | undefined;
}) => {
  if (error !== undefined) {
    return (
      <p
        role="alert"
        data-testid="account-feedback-error"
        className="rounded-card border border-line bg-surface-2 px-4 py-3 text-sm text-danger"
      >
        {t(
          error === "link_cancelled"
            ? "account.linked.error.link_cancelled"
            : "account.linked.error.link_failed",
        )}
      </p>
    );
  }
  if (linked !== undefined) {
    return (
      <p
        role="status"
        data-testid="account-feedback-success"
        className="rounded-card border border-line bg-surface-2 px-4 py-3 text-sm text-success"
      >
        {t("account.linked.success", { provider: t(PROVIDER_LABEL_KEY[linked]) })}
      </p>
    );
  }
  return null;
};

const PreferenceRow = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <dt className="text-secondary">{label}</dt>
    <dd className="font-semibold text-primary">{value}</dd>
  </div>
);

/** État du chargement de `GET /api/share-links` (section « Partages lecture seule »). */
export type ShareLinksSectionLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly links: ReadonlyArray<ShareLinkEntry> };

export interface ShareLinksSectionViewProps {
  readonly load: ShareLinksSectionLoad;
  readonly busyId: string | null;
  readonly copiedId: string | null;
  readonly copyFailedId: string | null;
  readonly onCopy: (link: ShareLinkEntry) => void;
  readonly onRevoke: (link: ShareLinkEntry) => void;
  readonly onRetry: () => void;
}

const ShareLinkRow = ({
  link,
  busy,
  copied,
  copyFailed,
  onCopy,
  onRevoke,
}: {
  readonly link: ShareLinkEntry;
  readonly busy: boolean;
  readonly copied: boolean;
  readonly copyFailed: boolean;
  readonly onCopy: () => void;
  readonly onRevoke: () => void;
}) => {
  const title = link.binderTitle ?? t("share.account.row.binderFallback");
  return (
    <li
      data-testid="account-share-link"
      data-link-id={link.id}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 p-3"
    >
      <div className="flex items-start gap-3">
        <Link2 size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-gold" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            data-testid="account-share-title"
            className="truncate text-sm font-semibold text-primary"
          >
            {title}
          </p>
          <p className="text-xs text-muted">
            {t("share.account.row.createdOn", { date: formatShareDate(link.createdAt) })}
          </p>
          <p data-testid="account-share-quantities" className="text-xs text-secondary">
            {t(
              link.showQuantities
                ? "share.account.row.quantitiesOn"
                : "share.account.row.quantitiesOff",
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CopyLinkButton
          title={title}
          copied={copied}
          failed={copyFailed}
          onCopy={onCopy}
          testId="account-share-copy"
        />
        <button
          type="button"
          data-testid="account-share-revoke"
          aria-label={t("share.sheet.revokeAria", { title })}
          disabled={busy}
          onClick={onRevoke}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-pill border border-line bg-surface-1 px-4 text-sm font-semibold text-danger transition-colors hover:bg-surface-2 disabled:opacity-50 ${focusRing}`}
        >
          <Trash2 size={16} aria-hidden="true" />
          {t("share.sheet.revoke")}
        </button>
      </div>
    </li>
  );
};

/**
 * Section « Partages lecture seule » de `09B` (docs/01 §2.2) : liens actifs (titre du classeur,
 * date, quantités visibles ou non), copie en 1 tap et révocation instantanée ; état vide propre.
 */
export const ShareLinksSectionView = ({
  load,
  busyId,
  copiedId,
  copyFailedId,
  onCopy,
  onRevoke,
  onRetry,
}: ShareLinksSectionViewProps) => (
  <Section
    id="account-shares"
    title={t("share.account.heading")}
    description={t("share.account.description")}
  >
    {load.status === "loading" ? (
      <p role="status" data-testid="account-shares-loading" className="text-sm text-secondary">
        {t("share.account.loading")}
      </p>
    ) : load.status === "error" ? (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" data-testid="account-shares-error" className="text-sm text-danger">
          {t("share.account.error")}
        </p>
        <button
          type="button"
          data-testid="account-shares-retry"
          onClick={onRetry}
          className={`inline-flex min-h-11 items-center justify-center rounded-pill border border-line bg-surface-2 px-4 text-sm font-semibold text-primary ${focusRing}`}
        >
          {t("share.account.retry")}
        </button>
      </div>
    ) : load.links.length === 0 ? (
      <div
        data-testid="account-shares-empty"
        className="flex flex-col gap-1 rounded-card border border-line bg-surface-2 px-4 py-3"
      >
        <p className="text-sm font-semibold text-primary">{t("share.account.empty.title")}</p>
        <p className="text-sm text-secondary">{t("share.account.empty.description")}</p>
      </div>
    ) : (
      <ul data-testid="account-shares-list" className="flex flex-col gap-3">
        {load.links.map((link) => (
          <ShareLinkRow
            key={link.id}
            link={link}
            busy={busyId === link.id}
            copied={copiedId === link.id}
            copyFailed={copyFailedId === link.id}
            onCopy={() => onCopy(link)}
            onRevoke={() => onRevoke(link)}
          />
        ))}
      </ul>
    )}
  </Section>
);

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/** Conteneur : charge les liens actifs, copie l'URL, révoque (mise à jour immédiate). */
const ShareLinksSection = () => {
  const [load, setLoad] = useState<ShareLinksSectionLoad>({ status: "loading" });
  const [origin, setOrigin] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const { copiedId, failedId, copy } = useCopyFeedback();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `retryToken` relance volontairement le chargement
  useEffect(() => {
    const controller = new AbortController();
    setOrigin(window.location.origin);
    setLoad({ status: "loading" });
    fetchShareLinks({ signal: controller.signal })
      .then((result) => {
        setLoad(
          result.kind === "ok"
            ? { status: "ready", links: activeShareLinks(result.payload.links) }
            : { status: "error" },
        );
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setLoad({ status: "error" });
      });
    return () => controller.abort();
  }, [retryToken]);

  const revoke = async (link: ShareLinkEntry) => {
    setBusyId(link.id);
    const result = await revokeShareLink(link.id);
    setBusyId(null);
    if (result.kind === "ok" || result.kind === "not-found") {
      setLoad((current) =>
        current.status === "ready"
          ? { status: "ready", links: current.links.filter((entry) => entry.id !== link.id) }
          : current,
      );
    }
  };

  return (
    <ShareLinksSectionView
      load={load}
      busyId={busyId}
      copiedId={copiedId}
      copyFailedId={failedId}
      onCopy={(link) => void copy(link.id, sharedPageUrl(origin, link.token))}
      onRevoke={(link) => void revoke(link)}
      onRetry={() => setRetryToken((token) => token + 1)}
    />
  );
};

/**
 * Écran `09B · Compte & paramètres` (docs/01 §2.2) : profil, liaison Google /
 * Discord (`linkIdentity`), apparence Auto / Sombre / Clair, aperçu des
 * notifications & préférences, déconnexion. Vue profonde : navbar masquée,
 * retour explicite en haut à gauche.
 */
export const AccountScreen = ({ user, linked, error, showIosPwaGuide }: AccountScreenProps) => {
  const linkedProviders = new Set(user.identities.map((identity) => identity.provider));
  const discordLinked = linkedProviders.has("discord");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-6 pt-4 pb-10">
      <header className="flex items-center gap-3">
        <Link
          to="/"
          aria-label={t("account.back")}
          data-testid="account-back"
          className={`flex shrink-0 items-center justify-center rounded-pill border border-line bg-surface-1 text-secondary shadow-card transition-colors hover:bg-surface-2 hover:text-primary ${focusRing}`}
          style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </Link>
        <h1 className="text-xl font-bold text-primary">{t("account.heading")}</h1>
      </header>

      <ProfileCard user={user} linkedProviders={linkedProviders} />

      <Section
        id="account-linked"
        title={t("account.linked.heading")}
        description={t("account.linked.description")}
      >
        <FeedbackBanner linked={linked} error={error} />
        <ul className="flex flex-col gap-3">
          {OAUTH_PROVIDERS.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              isLinked={linkedProviders.has(provider)}
            />
          ))}
        </ul>
      </Section>

      <Section
        id="account-appearance"
        title={t("account.appearance.heading")}
        description={t("account.appearance.description")}
      >
        <ThemeSelector />
      </Section>

      <Section id="account-notifications" title={t("account.notifications.heading")}>
        <div
          data-testid="account-discord-status"
          className="flex items-start gap-3 rounded-card border border-line bg-surface-2 px-4 py-3"
        >
          <Bell size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-gold" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-primary">
              {t("account.notifications.discord")}
            </p>
            <p className="text-sm text-secondary">
              {t(
                discordLinked
                  ? "account.notifications.discordLinked"
                  : "account.notifications.discordNotLinked",
              )}
            </p>
          </div>
        </div>
        <IosPwaInstallGuide visible={showIosPwaGuide} />
        <p className="text-xs text-muted">{t("account.notifications.soon")}</p>
        <dl className="flex flex-col gap-3 border-t border-line pt-4">
          <PreferenceRow
            label={t("account.preferences.language")}
            value={t("account.preferences.languageValue")}
          />
          <PreferenceRow
            label={t("account.preferences.currency")}
            value={t("account.preferences.currencyValue")}
          />
        </dl>
      </Section>

      <ShareLinksSection />

      <Section id="account-session" title={t("account.session.heading")}>
        <p className="text-sm text-secondary">{t("account.logout.description")}</p>
        <form
          method="post"
          action={AUTH_LOGOUT_API_PATH}
          onSubmit={() => clearPrivateServiceWorkerCache()}
        >
          <button
            type="submit"
            className={`flex w-full items-center justify-center gap-2 rounded-pill border border-line bg-surface-2 px-5 text-sm font-semibold text-danger transition-colors hover:bg-surface-1 ${focusRing}`}
            style={{ minHeight: "var(--touch-target-min)" }}
          >
            <LogOut size={18} aria-hidden="true" />
            {t("account.logout")}
          </button>
        </form>
      </Section>
    </main>
  );
};
