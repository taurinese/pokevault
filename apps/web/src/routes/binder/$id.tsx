import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { BinderGridScreen } from "../../components/BinderGridScreen.tsx";
import { CardDetailSheet } from "../../components/CardDetailSheet.tsx";
import { t } from "../../i18n/index.ts";
import type { BinderGridCard } from "../../lib/binder-grid-client.ts";
import { getCurrentUser } from "../../lib/session.ts";

const BinderPage = () => {
  const { id } = Route.useParams();
  // Bottom Sheet `04 · Fiche Carte` (T4.2) : tap sur une tuile → fiche de la carte.
  const [selectedCard, setSelectedCard] = useState<BinderGridCard | null>(null);
  // Jeton de rechargement silencieux de la grille après mutation d'exemplaires.
  const [gridReloadToken, setGridReloadToken] = useState(0);

  return (
    <>
      <BinderGridScreen
        binderId={id}
        reloadToken={gridReloadToken}
        onSelectCard={setSelectedCard}
      />
      <CardDetailSheet
        key={selectedCard?.id ?? "none"}
        cardId={selectedCard?.id ?? null}
        cardName={selectedCard?.nameFr}
        initialWishlisted={selectedCard?.inWishlist ?? false}
        onClose={() => setSelectedCard(null)}
        onCopiesChanged={() => setGridReloadToken((token) => token + 1)}
      />
    </>
  );
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
