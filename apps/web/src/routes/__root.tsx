import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useMatches,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { FloatingPillNavbar } from "../components/FloatingPillNavbar.tsx";
import { HTML_LANG, t } from "../i18n/index.ts";
import {
  ALERTS_UNREAD_EVENT,
  fetchUnreadAlertsCount,
  readUnreadEventDetail,
} from "../lib/alerts-client.ts";
import { THEME_INIT_SCRIPT } from "../lib/theme.ts";
import appCss from "../styles/app.css?url";

const NotFound = () => (
  <main className="mx-auto max-w-md p-6">
    <h1 className="text-xl font-bold">{t("notFound.title")}</h1>
    <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
      {t("notFound.description")}
    </p>
    <Link to="/" className="mt-4 inline-block underline">
      {t("notFound.backHome")}
    </Link>
  </main>
);

const RootDocument = ({ children }: { readonly children: ReactNode }) => (
  <html lang={HTML_LANG} suppressHydrationWarning>
    <head>
      {/* Script bloquant avant le premier rendu : pose `data-theme` (zéro FOUC, toutes routes). */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constante statique maîtrisée (aucune entrée utilisateur) */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

/**
 * Pastille verte non lue de la Navbar B : interroge `GET /api/alerts/unread-count` au montage
 * et à chaque navigation (silencieux sur 401 / erreur : la valeur reste inchangée), et écoute
 * `pokevault:alerts-unread` (`CustomEvent<number>`) émis par `/alerts` pour se mettre à jour
 * instantanément. Aucune requête sur les pages sans navbar (`/login`, `/s/$token`…).
 */
const useUnreadAlertsCount = (enabled: boolean): number => {
  const [count, setCount] = useState(0);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` relance volontairement la lecture à chaque navigation
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    const controller = new AbortController();
    void fetchUnreadAlertsCount(controller.signal).then((next) => {
      if (next !== null && !controller.signal.aborted) setCount(next);
    });
    return () => controller.abort();
  }, [enabled, pathname]);

  useEffect(() => {
    const onUnread = (event: Event): void => {
      const next = readUnreadEventDetail(event);
      if (next !== null) setCount(next);
    };
    window.addEventListener(ALERTS_UNREAD_EVENT, onUnread);
    return () => window.removeEventListener(ALERTS_UNREAD_EVENT, onUnread);
  }, []);

  return count;
};

const RootLayout = () => {
  const hideNavbar = useMatches({
    select: (matches) => matches.some((match) => match.staticData.hideNavbar === true),
  });
  const unreadCount = useUnreadAlertsCount(!hideNavbar);
  return (
    <>
      <Outlet />
      {hideNavbar ? null : <FloatingPillNavbar unreadAlertsCount={unreadCount} />}
    </>
  );
};

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: t("home.title") },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
  component: RootLayout,
});
