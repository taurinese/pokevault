import { createFileRoute } from "@tanstack/react-router";
import { defaultBurstDeps, handleBurstSetCards } from "../../../lib/burst-server.ts";

export const Route = createFileRoute("/api/burst/cards")({
  server: {
    handlers: {
      GET: async ({ request }) => handleBurstSetCards(request, await defaultBurstDeps()),
    },
  },
});
