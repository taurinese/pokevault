import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { Bell, Heart, House, LibraryBig, Search } from "lucide-react";
import { type TranslationKey, t, tPlural } from "../i18n/index.ts";

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
  { id: "home", to: "/", labelKey: "nav.home", Icon: House },
  { id: "collection", to: "/collection", labelKey: "nav.collection", Icon: LibraryBig },
  { id: "search", to: "/search", labelKey: "nav.search", Icon: Search },
  { id: "wishlist", to: "/wishlist", labelKey: "nav.wishlist", Icon: Heart },
  { id: "alerts", to: "/alerts", labelKey: "nav.alerts", Icon: Bell },
];

/** Au-delà, la pastille affiche `9+`. */
export const MAX_BADGE_COUNT = 9;

export const formatBadgeCount = (count: number): string =>
  count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count);

export interface FloatingPillNavbarProps {
  readonly unreadAlertsCount?: number | undefined;
}

/**
 * Navbar B : barre flottante en pilule, ancrée en bas de l'écran, avec
 * safe-area, cibles tactiles ≥ 44px, pilule active dorée et pastille verte
 * sur l'onglet Alertes quand des alertes sont non lues.
 *
 * L'onglet actif a une seule source de vérité : le routeur (TanStack Router
 * pose `data-status="active"` + `aria-current="page"`). `/` est en
 * correspondance exacte ; les autres onglets restent actifs sur leurs
 * sous-chemins (`/collection/abc` n'active que Collection).
 */
export const FloatingPillNavbar = ({ unreadAlertsCount = 0 }: FloatingPillNavbarProps) => (
  <nav
    aria-label={t("nav.label")}
    className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-navbar) flex justify-center px-4 lg:hidden"
    style={{ paddingBottom: "calc(0.75rem + var(--safe-area-inset-bottom))" }}
  >
    <ul
      className="pointer-events-auto flex items-center gap-1 rounded-pill border border-line bg-surface-1 p-1.5 shadow-nav"
      style={{ minHeight: "var(--navbar-pill-height)" }}
    >
      {NAVBAR_TABS.map((tab) => (
        <li key={tab.id} className="relative">
          <Link
            to={tab.to}
            activeOptions={{ exact: tab.to === "/" }}
            activeProps={{ className: "bg-gold-soft text-gold" }}
            inactiveProps={{ className: "text-muted hover:bg-surface-2 hover:text-secondary" }}
            className="group flex flex-col items-center justify-center gap-0.5 rounded-pill px-3 text-xs font-medium transition-colors"
            style={{ minWidth: "var(--touch-target-min)", minHeight: "var(--touch-target-min)" }}
          >
            <tab.Icon size={20} aria-hidden="true" />
            <span className="sr-only group-data-[status=active]:not-sr-only">
              {t(tab.labelKey)}
            </span>
            {tab.id === "alerts" && unreadAlertsCount > 0 ? (
              <>
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-pill bg-success-strong px-1 font-mono text-[10px] font-semibold tabular-nums text-canvas"
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
);
