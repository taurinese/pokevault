import { createFileRoute } from "@tanstack/react-router";
import {
  defaultWishlistDeps,
  handleDeleteWishlistItem,
  handleUpdateWishlistItem,
} from "../../../../lib/wishlist-server.ts";

// `$id/index.ts` (et non `$id.ts`) : `$id/acquire.ts` existe dans le même dossier ; un
// fichier `$id.ts` en ferait un layout parent sans `Outlet`. La route générée est
// `/api/wishlist/$id/`.
export const Route = createFileRoute("/api/wishlist/$id/")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        handleUpdateWishlistItem(request, params.id, await defaultWishlistDeps()),
      DELETE: async ({ request, params }) =>
        handleDeleteWishlistItem(request, params.id, await defaultWishlistDeps()),
    },
  },
});
