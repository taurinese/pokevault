import { LockKeyhole } from "lucide-react";
import { t } from "../i18n/index.ts";
import { LOGIN_PATH, type LoginError, oauthLoginHref } from "../lib/auth-shared.ts";
import { DiscordIcon, GoogleIcon } from "./BrandIcons.tsx";
import { CardTile } from "./CardTile.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

const TCGDEX_LOW = "https://assets.tcgdex.net/fr/sv/sv03.5";

/** Éventail décoratif : 3 cartes `63/88`, rotation −8° / 0° / +8°. */
const FAN_CARDS = [
  {
    id: "pikachu",
    nameKey: "login.cards.pikachu",
    image: `${TCGDEX_LOW}/025/low.webp`,
    rotate: -8,
    lift: 10,
  },
  {
    id: "charizard",
    nameKey: "login.cards.charizard",
    image: `${TCGDEX_LOW}/199/low.webp`,
    rotate: 0,
    lift: 0,
  },
  {
    id: "mewtwo",
    nameKey: "login.cards.mewtwo",
    image: `${TCGDEX_LOW}/150/low.webp`,
    rotate: 8,
    lift: 10,
  },
] as const;

const CardFan = () => (
  <div
    aria-hidden="true"
    data-testid="login-card-fan"
    className="relative mx-auto flex h-52 w-full max-w-xs items-center justify-center"
  >
    {FAN_CARDS.map((card, index) => (
      <div
        key={card.id}
        data-testid="login-fan-card"
        className="pv-fan-card w-[34%] shrink-0"
        style={{
          transform: `translateY(${card.lift}px) rotate(${card.rotate}deg)`,
          marginLeft: index === 0 ? 0 : "-6%",
          zIndex: index === 1 ? 2 : 1,
        }}
      >
        <CardTile name={t(card.nameKey)} imageUrl={card.image} priority />
      </div>
    ))}
  </div>
);

const oauthButtonClass =
  "flex w-full items-center justify-center gap-3 rounded-pill border border-line bg-surface-1 px-5 text-sm font-semibold text-primary shadow-card transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

const OAuthButtons = ({ redirectTo }: { readonly redirectTo?: string | undefined }) => (
  <div className="flex flex-col gap-3">
    <a
      href={oauthLoginHref("google", redirectTo)}
      className={oauthButtonClass}
      style={{ minHeight: "var(--touch-target-min)" }}
    >
      <GoogleIcon />
      {t("login.continueGoogle")}
    </a>
    <a
      href={oauthLoginHref("discord", redirectTo)}
      className={oauthButtonClass}
      style={{ minHeight: "var(--touch-target-min)" }}
    >
      <DiscordIcon />
      {t("login.continueDiscord")}
    </a>
    <p className="mt-1 text-center text-xs text-muted">{t("login.oauthOnly")}</p>
  </div>
);

const InviteOnlyCard = () => (
  <section
    aria-labelledby="login-invite-only-title"
    data-testid="login-invite-only"
    className="flex flex-col gap-4 rounded-sheet border border-line bg-surface-1 p-5 shadow-card"
  >
    <div className="flex items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-pill bg-gold-soft text-gold">
        <LockKeyhole size={20} aria-hidden="true" />
      </span>
      <h2 id="login-invite-only-title" className="text-lg font-bold text-primary">
        {t("login.inviteOnly.title")}
      </h2>
    </div>
    <p className="text-sm text-secondary">{t("login.inviteOnly.description")}</p>
    <p className="text-sm text-muted">{t("login.inviteOnly.hint")}</p>
    <a
      href={LOGIN_PATH}
      className="flex w-full items-center justify-center rounded-pill bg-gold-soft px-5 text-sm font-semibold text-gold transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
      style={{ minHeight: "var(--touch-target-min)" }}
    >
      {t("login.inviteOnly.retry")}
    </a>
  </section>
);

export interface LoginScreenProps {
  readonly error?: LoginError | undefined;
  /** Chemin interne (déjà assaini) où revenir après la connexion. */
  readonly redirectTo?: string | undefined;
}

/**
 * Écran `09A · Connexion` : éventail de cartes, accroche et exclusivement les
 * deux boutons OAuth (Google, Discord) — aucun formulaire e-mail / mot de passe.
 * `?error=invite_only` remplace les boutons par la carte « Accès sur invitation ».
 */
export const LoginScreen = ({ error, redirectTo }: LoginScreenProps) => (
  <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-8 px-6 pt-6 pb-10">
    <header className="flex items-center justify-between gap-4">
      <span className="text-sm font-bold tracking-wide text-gold">{t("app.name")}</span>
      <ThemeToggle />
    </header>

    <CardFan />

    <div className="flex flex-col gap-2 text-center">
      <h1 className="text-2xl font-bold text-primary">{t("login.heading")}</h1>
      <p className="text-sm text-secondary">{t("login.tagline")}</p>
    </div>

    {error === "invite_only" ? (
      <InviteOnlyCard />
    ) : (
      <>
        {error === "oauth_cancelled" || error === "auth_failed" ? (
          <p
            role="alert"
            data-testid="login-error"
            className="rounded-card border border-line bg-surface-2 px-4 py-3 text-center text-sm text-danger"
          >
            {t(
              error === "oauth_cancelled"
                ? "login.error.oauth_cancelled"
                : "login.error.auth_failed",
            )}
          </p>
        ) : null}
        <OAuthButtons redirectTo={redirectTo} />
      </>
    )}
  </main>
);
