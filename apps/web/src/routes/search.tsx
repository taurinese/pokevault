import { createFileRoute, redirect } from "@tanstack/react-router";
import { SearchScreen } from "../components/SearchScreen.tsx";
import { t } from "../i18n/index.ts";
import { SEARCH_PATH } from "../lib/auth-shared.ts";
import { getCurrentUser } from "../lib/session.ts";

export const Route = createFileRoute("/search")({
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: SEARCH_PATH } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("search.title") }] }),
  component: SearchScreen,
});
