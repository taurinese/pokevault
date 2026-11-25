import { createFileRoute } from "@tanstack/react-router";
import {
  defaultShareDeps,
  handleRevokeShareLink,
  handleUpdateShareLink,
} from "../../../lib/share-server.ts";

export const Route = createFileRoute("/api/share-links/$id")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        handleUpdateShareLink(request, params.id, await defaultShareDeps()),
      // `DELETE` = révocation immédiate et irréversible (le lien n'est pas supprimé).
      DELETE: async ({ request, params }) =>
        handleRevokeShareLink(request, params.id, await defaultShareDeps()),
    },
  },
});
