import { createFileRoute, redirect } from "@tanstack/react-router";
import { BinderGridScreen } from "../../components/BinderGridScreen.tsx";
import { t } from "../../i18n/index.ts";
import { getCurrentUser } from "../../lib/session.ts";

const BinderPage = () => {
  const { id } = Route.useParams();
  return <BinderGridScreen binderId={id} />;
};

export const Route = createFileRoute("/binder/$id")({
  // Vue profonde plein écran : la Navbar B est masquée (docs/01 §1).
  staticData: { hideNavbar: true },
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async ({ params }) => {
    const user = await getCurrentUser();
    if (user === null) {
      throw redirect({ to: "/login", search: { redirect: `/binder/${params.id}` } });
    }
    return { user };
  },
  head: () => ({ meta: [{ title: t("binderGrid.title") }] }),
  component: BinderPage,
});
