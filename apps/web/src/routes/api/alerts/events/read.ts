import { createFileRoute } from "@tanstack/react-router";
import { defaultAlertsDeps, handleMarkEventsRead } from "../../../../lib/alerts-server.ts";

export const Route = createFileRoute("/api/alerts/events/read")({
  server: {
    handlers: {
      POST: async ({ request }) => handleMarkEventsRead(request, await defaultAlertsDeps()),
    },
  },
});
