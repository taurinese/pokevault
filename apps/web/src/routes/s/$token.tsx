import { createFileRoute } from "@tanstack/react-router";
import { SharedBinderScreen } from "../../components/SharedBinderScreen.tsx";
import { t } from "../../i18n/index.ts";

const SharedBinderPage = () => {
  const { token } = Route.useParams();
  return <SharedBinderScreen token={token} />;
};

/**
 * `/s/$token` — Vue Publique Partagée (`09C–09D`) : AUCUNE authentification (visiteurs sans
 * compte), donc ni `beforeLoad` ni redirection `/login`. Les données viennent exclusivement de
 * `GET /api/shared/$token` (projection `get_shared_binder`). Navbar masquée, page non indexée.
 */
export const Route = createFileRoute("/s/$token")({
  staticData: { hideNavbar: true },
  head: () => ({
    meta: [
      { title: t("share.public.title") },
      // Le jeton est un secret d'URL : ni indexation, ni `Referer` vers un tiers.
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: SharedBinderPage,
});
