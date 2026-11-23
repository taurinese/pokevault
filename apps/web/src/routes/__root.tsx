import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { HTML_LANG, t } from "../i18n/index.ts";
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
  <html lang={HTML_LANG}>
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

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
  component: () => <Outlet />,
});
