import { createFileRoute } from "@tanstack/react-router";
import { defaultShareDeps, handleGetSharedBinder } from "../../../lib/share-server.ts";

// Route PUBLIQUE (aucune session) : projection `get_shared_binder(token)` uniquement.
export const Route = createFileRoute("/api/shared/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => handleGetSharedBinder(params.token, await defaultShareDeps()),
    },
  },
});
