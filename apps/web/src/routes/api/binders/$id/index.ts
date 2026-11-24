import { createFileRoute } from "@tanstack/react-router";
import {
  defaultBindersDeps,
  handleDeleteBinder,
  handleUpdateBinder,
} from "../../../../lib/binders-server.ts";

// `$id/index.ts` (et non `$id.ts`) : `$id/cover.ts` existe déjà dans le même dossier ; un
// fichier `$id.ts` en ferait un layout parent sans `Outlet`. Comme `binders/index.ts`, la
// route générée est `/api/binders/$id/`.
export const Route = createFileRoute("/api/binders/$id/")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        handleUpdateBinder(request, params.id, await defaultBindersDeps()),
      DELETE: async ({ request, params }) =>
        handleDeleteBinder(request, params.id, await defaultBindersDeps()),
    },
  },
});
