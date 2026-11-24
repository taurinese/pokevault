import { createFileRoute } from "@tanstack/react-router";
import { defaultCatalogDeps, handleSuggest } from "../../../lib/catalog-server.ts";

export const Route = createFileRoute("/api/catalog/suggest")({
  server: {
    handlers: {
      GET: async ({ request }) => handleSuggest(request, await defaultCatalogDeps()),
    },
  },
});
