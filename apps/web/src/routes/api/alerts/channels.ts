import { createFileRoute } from "@tanstack/react-router";
import { defaultAlertsDeps, handleUpdateChannels } from "../../../lib/alerts-server.ts";

export const Route = createFileRoute("/api/alerts/channels")({
  server: {
    handlers: {
      PATCH: async ({ request }) => handleUpdateChannels(request, await defaultAlertsDeps()),
    },
  },
});
