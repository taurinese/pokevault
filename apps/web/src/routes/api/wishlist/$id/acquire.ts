import { createFileRoute } from "@tanstack/react-router";
import { defaultWishlistDeps, handleAcquireWishlistItem } from "../../../../lib/wishlist-server.ts";

export const Route = createFileRoute("/api/wishlist/$id/acquire")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleAcquireWishlistItem(request, params.id, await defaultWishlistDeps()),
    },
  },
});
