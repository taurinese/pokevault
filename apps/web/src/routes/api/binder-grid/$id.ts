import { createFileRoute } from "@tanstack/react-router";
import { defaultBinderGridDeps, handleBinderGrid } from "../../../lib/binder-grid-server.ts";

export const Route = createFileRoute("/api/binder-grid/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleBinderGrid(request, params.id, await defaultBinderGridDeps()),
    },
  },
});
