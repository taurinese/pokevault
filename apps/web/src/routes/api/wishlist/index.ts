import { createFileRoute } from "@tanstack/react-router";
import {
  defaultWishlistDeps,
  handleAddWishlistItem,
  handleListWishlist,
} from "../../../lib/wishlist-server.ts";

export const Route = createFileRoute("/api/wishlist/")({
  server: {
    handlers: {
      GET: async ({ request }) => handleListWishlist(request, await defaultWishlistDeps()),
      POST: async ({ request }) => handleAddWishlistItem(request, await defaultWishlistDeps()),
    },
  },
});
