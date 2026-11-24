import { createFileRoute } from "@tanstack/react-router";
import { defaultCardDetailDeps, handleCardDetail } from "../../../../lib/card-detail-server.ts";

export const Route = createFileRoute("/api/cards/$cardId/")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleCardDetail(request, params.cardId, await defaultCardDetailDeps()),
    },
  },
});
