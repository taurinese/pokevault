import { createFileRoute, redirect } from "@tanstack/react-router";
import { WishlistScreen } from "../components/WishlistScreen.tsx";
import { t } from "../i18n/index.ts";
import { getCurrentUser } from "../lib/session.ts";
import { WISHLIST_PATH } from "../lib/wishlist-client.ts";

export const Route = createFileRoute("/wishlist")({
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: WISHLIST_PATH } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("wishlist.title") }] }),
  component: () => <WishlistScreen />,
});
