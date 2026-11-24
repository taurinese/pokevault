import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bell, Check, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../i18n/index.ts";
import {
  type AccountLinkError,
  AUTH_LOGOUT_API_PATH,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  oauthLinkHref,
} from "../lib/auth-shared.ts";
import { avatarInitials } from "../lib/profile.ts";
import { DiscordIcon, GoogleIcon } from "./BrandIcons.tsx";
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

/**
 * Écran `09B · Compte & paramètres` (docs/01 §2.2) : profil, liaison Google /
 * Discord (`linkIdentity`), apparence Auto / Sombre / Clair, aperçu des
 * notifications & préférences, déconnexion. Vue profonde : navbar masquée,
 * retour explicite en haut à gauche.
 */
export const AccountScreen = ({ user, linked, error }: AccountScreenProps) => {
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

      <Section id="account-session" title={t("account.session.heading")}>
        <p className="text-sm text-secondary">{t("account.logout.description")}</p>
        <form method="post" action={AUTH_LOGOUT_API_PATH}>
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
