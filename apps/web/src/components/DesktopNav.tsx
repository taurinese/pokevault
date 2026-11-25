import { Link } from "@tanstack/react-router";
import { Layers, UserRound, Zap } from "lucide-react";
import { t, tPlural } from "../i18n/index.ts";
import { formatBadgeCount, NAVBAR_TABS } from "./FloatingPillNavbar.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

export interface DesktopNavProps {
  readonly unreadAlertsCount?: number | undefined;
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

/**
 * Navigation Desktop sobre (`>= 1024px`, `lg:`) remplaçant la Navbar B flottante.
 *
 * Consomme les 5 entrées de `NAVBAR_TABS` avec icône + libellé toujours visible,
 * état actif doré (`bg-gold-soft text-gold`), pastille verte d'alertes non lues,
 * raccourcis pied de barre (`Saisie rafale`, `Compte & paramètres`) et bascule
 * Dark / Light (`ThemeToggle`). 100 % design tokens (`tokens.css`).
 */
export const DesktopNav = ({ unreadAlertsCount = 0 }: DesktopNavProps) => (
  <aside
    data-testid="desktop-nav"
    className="hidden lg:flex fixed inset-y-0 left-0 z-(--z-navbar) w-60 flex-col border-r border-line bg-surface-1"
  >
    <div className="flex items-center border-b border-line px-4 py-4">
      <Link
        to="/"
        aria-label={t("desktopNav.homeAria")}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded-card px-1 py-1 transition-colors hover:bg-surface-2 ${focusRing}`}
        style={{ minHeight: "var(--touch-target-min)" }}
      >
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-card border border-gold/30 bg-gold-soft text-gold"
        >
          <Layers size={18} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base font-bold text-primary">{t("app.name")}</span>
          <span className="truncate text-[11px] text-muted">{t("desktopNav.tagline")}</span>
        </span>
      </Link>
    </div>

    <nav aria-label={t("desktopNav.label")} className="flex flex-1 flex-col overflow-y-auto p-3">
      <ul className="flex flex-col gap-1">
        {NAVBAR_TABS.map((tab) => (
          <li key={tab.id}>
            <Link
              to={tab.to}
              activeOptions={{ exact: tab.to === "/" }}
              activeProps={{ className: "bg-gold-soft text-gold font-semibold" }}
              inactiveProps={{
                className: "text-secondary hover:bg-surface-2 hover:text-primary",
              }}
              className={`relative flex items-center gap-3 rounded-card px-3 text-sm font-medium transition-colors ${focusRing}`}
              style={{ minHeight: "var(--touch-target-min)" }}
            >
              <tab.Icon size={20} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{t(tab.labelKey)}</span>
              {tab.id === "alerts" && unreadAlertsCount > 0 ? (
                <>
                  <span
                    aria-hidden="true"
                    className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-pill bg-success-strong px-1.5 font-mono text-[10px] font-semibold tabular-nums text-canvas"
                  >
                    {formatBadgeCount(unreadAlertsCount)}
                  </span>
                  <span className="sr-only">{tPlural("nav.alertsUnread", unreadAlertsCount)}</span>
                </>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>

    <div className="flex flex-col gap-2 border-t border-line p-3">
      <Link
        to="/burst"
        className={`flex items-center justify-center gap-2 rounded-pill border border-gold/40 bg-gold-soft px-4 text-sm font-semibold text-gold transition-colors hover:border-gold ${focusRing}`}
        style={{ minHeight: "var(--touch-target-min)" }}
      >
        <Zap size={16} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{t("desktopNav.burst")}</span>
      </Link>
      <div className="flex items-center gap-2">
        <Link
          to="/account"
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-card px-3 text-sm font-medium text-secondary transition-colors hover:bg-surface-2 hover:text-primary ${focusRing}`}
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          <UserRound size={18} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{t("desktopNav.account")}</span>
        </Link>
        <ThemeToggle />
      </div>
    </div>
  </aside>
);
