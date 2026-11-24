import { createFileRoute } from "@tanstack/react-router";
import { handleLinkIdentity } from "../../../lib/auth-server.ts";

export const Route = createFileRoute("/api/auth/link")({
  server: {
    handlers: {
      GET: ({ request }) => handleLinkIdentity(request),
    },
  },
});
