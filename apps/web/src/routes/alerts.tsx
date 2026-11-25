import { createFileRoute, redirect } from "@tanstack/react-router";
import { AlertsScreen } from "../components/AlertsScreen.tsx";
import { t } from "../i18n/index.ts";
import { ALERTS_PATH } from "../lib/alerts-client.ts";
import { getCurrentUser } from "../lib/session.ts";

export const Route = createFileRoute("/alerts")({
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: ALERTS_PATH } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("alerts.title") }] }),
  component: () => <AlertsScreen />,
});
