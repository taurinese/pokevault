import { createFileRoute } from "@tanstack/react-router";
import { defaultDashboardDeps, handleGetDashboard } from "../../lib/dashboard-server.ts";

export const Route = createFileRoute("/api/dashboard")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGetDashboard(request, await defaultDashboardDeps()),
    },
  },
});
