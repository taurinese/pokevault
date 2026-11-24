import { createFileRoute } from "@tanstack/react-router";
import {
  defaultCardPriceRefreshDeps,
  handleCardPriceRefresh,
} from "../../../../lib/card-detail-server.ts";

export const Route = createFileRoute("/api/cards/$cardId/price-refresh")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleCardPriceRefresh(request, params.cardId, await defaultCardPriceRefreshDeps()),
    },
  },
});
