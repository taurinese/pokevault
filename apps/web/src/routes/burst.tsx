import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { BurstSetupScreen } from "../components/BurstSetupScreen.tsx";
import { t } from "../i18n/index.ts";
import {
  type BurstSetupConfig,
  parseBurstSearchParams,
  serializeBurstSearchParams,
} from "../lib/burst-client.ts";
import { getCurrentUser } from "../lib/session.ts";

const BurstPage = () => {
  const { setId } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <BurstSetupScreen
      initialSetId={setId}
      // Étape 2 (`08B`/`08C`, issue #20) : la config validée est portée par les
      // paramètres d'URL en attendant les écrans de saisie.
      onStart={(config: BurstSetupConfig) => {
        // Étape 2 (`08B`/`08C`, issue #20) : la config validée est portée par
        // les paramètres d'URL en attendant les écrans de saisie.
        void navigate({
          to: "/burst",
          search: parseBurstSearchParams(Object.fromEntries(serializeBurstSearchParams(config))),
        });
      }}
      onBack={() => navigate({ to: "/search" })}
    />
  );
};

export const Route = createFileRoute("/burst")({
  staticData: { hideNavbar: true },
  validateSearch: parseBurstSearchParams,
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: "/burst" } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("burst.title") }] }),
  component: BurstPage,
});
