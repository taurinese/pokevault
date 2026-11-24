import { createFileRoute, redirect } from "@tanstack/react-router";
import { DashboardScreen } from "../components/DashboardScreen.tsx";
import { t } from "../i18n/index.ts";
import { DASHBOARD_PATH } from "../lib/dashboard-client.ts";
import { getCurrentUser } from "../lib/session.ts";

export const Route = createFileRoute("/")({
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu
  // (même pattern que `/collection` et `/wishlist`).
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: DASHBOARD_PATH } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("dashboard.title") }] }),
  component: () => <DashboardScreen />,
});
