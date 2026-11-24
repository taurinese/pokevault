import { createFileRoute } from "@tanstack/react-router";
import { defaultCardDetailDeps, handleAddCardCopy } from "../../../../lib/card-detail-server.ts";

export const Route = createFileRoute("/api/cards/$cardId/copies")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleAddCardCopy(request, params.cardId, await defaultCardDetailDeps()),
    },
  },
});
