import { createFileRoute } from "@tanstack/react-router";
import { defaultCatalogDeps, handleDiscover } from "../../../lib/catalog-server.ts";

export const Route = createFileRoute("/api/catalog/discover")({
  server: {
    handlers: {
      GET: async ({ request }) => handleDiscover(request, await defaultCatalogDeps()),
    },
  },
});
