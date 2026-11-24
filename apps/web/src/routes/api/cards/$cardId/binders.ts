import { createFileRoute } from "@tanstack/react-router";
import { defaultCardDetailDeps, handleCardBinder } from "../../../../lib/card-detail-server.ts";

export const Route = createFileRoute("/api/cards/$cardId/binders")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleCardBinder(request, params.cardId, await defaultCardDetailDeps()),
      DELETE: async ({ request, params }) =>
        handleCardBinder(request, params.cardId, await defaultCardDetailDeps()),
    },
  },
});
