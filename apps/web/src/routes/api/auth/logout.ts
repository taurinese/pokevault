import { createFileRoute } from "@tanstack/react-router";
import { handleLogout } from "../../../lib/auth-server.ts";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: ({ request }) => handleLogout(request),
    },
  },
});
