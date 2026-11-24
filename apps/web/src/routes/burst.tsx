import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { BurstSetupScreen } from "../components/BurstSetupScreen.tsx";
import { t } from "../i18n/index.ts";
import { type BurstSetupConfig, parseBurstSearchParams } from "../lib/burst-client.ts";
import { getCurrentUser } from "../lib/session.ts";

const BurstPage = () => {
  const { setId } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <BurstSetupScreen
      initialSetId={setId}
      // Étape 2 (`08B`/`08C`, issue #20) : la config validée sera transmise aux
      // écrans de saisie rafale sans perturber l'historique navigateur en attendant.
      onStart={(_config: BurstSetupConfig) => {}}
      onBack={() => {
        if (typeof window !== "undefined" && window.history.length > 1) {
          window.history.back();
        } else {
          void navigate({ to: "/collection" });
        }
      }}
    />
  );
};

export const Route = createFileRoute("/burst")({
  staticData: { hideNavbar: true },
  validateSearch: parseBurstSearchParams,
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async ({ location }) => {
    const user = await getCurrentUser();
    if (user === null) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    return { user };
  },
  head: () => ({ meta: [{ title: t("burst.title") }] }),
  component: BurstPage,
});
