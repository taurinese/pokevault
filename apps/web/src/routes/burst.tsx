import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { BurstSessionScreen } from "../components/BurstSessionScreen.tsx";
import { BurstSetupScreen } from "../components/BurstSetupScreen.tsx";
import { t } from "../i18n/index.ts";
import { type BurstSetupConfig, parseBurstSearchParams } from "../lib/burst-client.ts";
import { getCurrentUser } from "../lib/session.ts";

const BurstPage = () => {
  const { setId } = Route.useSearch();
  const navigate = useNavigate();
  // Étape 1 (`08A`) tant que `config` est nul ; étape 2 (`08B`–`08D`) ensuite, sans
  // quitter `/burst` ni modifier l'historique navigateur. La config est conservée
  // au retour pour reprendre les réglages du lot.
  const [config, setConfig] = useState<BurstSetupConfig | null>(null);
  const [lastConfig, setLastConfig] = useState<BurstSetupConfig | undefined>(undefined);

  if (config !== null) {
    return (
      <BurstSessionScreen
        config={config}
        onExit={() => {
          setLastConfig(config);
          setConfig(null);
        }}
        onOpenBinder={(binderId) => {
          void navigate({ to: "/binder/$id", params: { id: binderId } });
        }}
        onOpenCollection={() => {
          void navigate({ to: "/collection" });
        }}
      />
    );
  }

  return (
    <BurstSetupScreen
      initialSetId={setId}
      initialConfig={lastConfig}
      onStart={setConfig}
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
