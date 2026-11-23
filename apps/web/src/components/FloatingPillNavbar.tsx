import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { Bell, Heart, Home, LibraryBig, Search } from "lucide-react";
import { type TranslationKey, t } from "../i18n/index.ts";

export type NavbarTabId = "home" | "collection" | "search" | "wishlist" | "alerts";

export type NavbarTabTo = "/" | "/collection" | "/search" | "/wishlist" | "/alerts";

export interface NavbarTab {
  readonly id: NavbarTabId;
  readonly to: NavbarTabTo;
  readonly labelKey: TranslationKey;
  readonly Icon: LucideIcon;
}

/** Les 5 onglets exacts de la Navbar B (maquette validée). */
export const NAVBAR_TABS: readonly NavbarTab[] = [
  { id: "home", to: "/", labelKey: "nav.home", Icon: Home },
  { id: "collection", to: "/collection", labelKey: "nav.collection", Icon: LibraryBig },
  { id: "search", to: "/search", labelKey: "nav.search", Icon: Search },
  { id: "wishlist", to: "/wishlist", labelKey: "nav.wishlist", Icon: Heart },
  { id: "alerts", to: "/alerts", labelKey: "nav.alerts", Icon: Bell },
];

/** Déduit l'onglet actif depuis le chemin courant (sinon `home`). */
export const navbarTabFromPath = (pathname: string): NavbarTabId => {
  const tab = NAVBAR_TABS.find((candidate) => candidate.to === pathname);
  return tab === undefined ? "home" : tab.id;
};

export interface FloatingPillNavbarProps {
  readonly activeTab: NavbarTabId;
  readonly unreadAlertsCount?: number | undefined;
}

/**
 * Navbar B : barre flottante en pilule, ancrée en bas de l'écran, avec
 * safe-area, cibles tactiles ≥ 44px, pilule active dorée et pastille verte
 * sur l'onglet Alertes quand des alertes sont non lues.
 */
export const FloatingPillNavbar = ({
  activeTab,
  unreadAlertsCount = 0,
}: FloatingPillNavbarProps) => (
  <nav
    aria-label={t("nav.label")}
    className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-navbar) flex justify-center px-4"
    style={{ paddingBottom: "calc(0.75rem + var(--safe-area-inset-bottom))" }}
  >
    <ul
      className="pointer-events-auto flex items-center gap-1 rounded-pill border border-line bg-surface-1 p-1.5 shadow-nav"
      style={{ minHeight: "var(--navbar-pill-height)" }}
    >
      {NAVBAR_TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <li key={tab.id} className="relative">
            <Link
              to={tab.to}
              aria-current={isActive ? "page" : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 rounded-pill px-3 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-gold-soft text-gold"
                  : "text-muted hover:bg-surface-2 hover:text-secondary"
              }`}
              style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
            >
              <tab.Icon size={20} aria-hidden="true" />
              <span className={isActive ? undefined : "sr-only"}>{t(tab.labelKey)}</span>
              {tab.id === "alerts" && unreadAlertsCount > 0 ? (
                <>
                  <span className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-pill bg-success px-1 font-mono text-[10px] font-semibold tabular-nums text-canvas">
                    {unreadAlertsCount}
                  </span>
                  <span className="sr-only">
                    {t("nav.alertsUnread", { count: unreadAlertsCount })}
                  </span>
                </>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  </nav>
);
