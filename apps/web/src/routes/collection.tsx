import { createFileRoute, redirect } from "@tanstack/react-router";
import { CollectionScreen } from "../components/CollectionScreen.tsx";
import { t } from "../i18n/index.ts";
import { COLLECTION_PATH } from "../lib/binders-client.ts";
import { getCurrentUser } from "../lib/session.ts";

export const Route = createFileRoute("/collection")({
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: COLLECTION_PATH } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("collection.title") }] }),
  component: () => <CollectionScreen />,
});
