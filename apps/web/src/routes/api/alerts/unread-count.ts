import { createFileRoute } from "@tanstack/react-router";
import { defaultAlertsDeps, handleUnreadCount } from "../../../lib/alerts-server.ts";

export const Route = createFileRoute("/api/alerts/unread-count")({
  server: {
    handlers: {
      GET: async ({ request }) => handleUnreadCount(request, await defaultAlertsDeps()),
    },
  },
});
