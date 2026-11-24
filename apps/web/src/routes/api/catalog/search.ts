import { createFileRoute } from "@tanstack/react-router";
import { defaultCatalogDeps, handleSearch } from "../../../lib/catalog-server.ts";

export const Route = createFileRoute("/api/catalog/search")({
  server: {
    handlers: {
      GET: async ({ request }) => handleSearch(request, await defaultCatalogDeps()),
    },
  },
});
