import { createFileRoute } from "@tanstack/react-router";
import { handleLogin } from "../../../lib/auth-server.ts";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      GET: ({ request }) => handleLogin(request),
    },
  },
});
