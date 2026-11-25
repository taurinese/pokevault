import { createFileRoute } from "@tanstack/react-router";
import { defaultShareDeps, handleGetSharedBinderCover } from "../../../../lib/share-server.ts";

// Route PUBLIQUE (aucune session) : proxy de la cover uploadée d'un lien actif.
export const Route = createFileRoute("/api/shared/$token/cover")({
  server: {
    handlers: {
      GET: async ({ params }) => handleGetSharedBinderCover(params.token, await defaultShareDeps()),
    },
  },
});
