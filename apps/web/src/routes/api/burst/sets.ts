import { createFileRoute } from "@tanstack/react-router";
import { defaultBurstDeps, handleListBurstSets } from "../../../lib/burst-server.ts";

export const Route = createFileRoute("/api/burst/sets")({
  server: {
    handlers: {
      GET: async ({ request }) => handleListBurstSets(request, await defaultBurstDeps()),
    },
  },
});
