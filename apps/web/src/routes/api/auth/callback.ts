import { createFileRoute } from "@tanstack/react-router";
import { handleCallback } from "../../../lib/auth-server.ts";

export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleCallback(request),
    },
  },
});
