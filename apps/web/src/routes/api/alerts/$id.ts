import { createFileRoute } from "@tanstack/react-router";
import {
  defaultAlertsDeps,
  handleDeleteAlert,
  handleUpdateAlert,
} from "../../../lib/alerts-server.ts";

export const Route = createFileRoute("/api/alerts/$id")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        handleUpdateAlert(request, params.id, await defaultAlertsDeps()),
      DELETE: async ({ request, params }) =>
        handleDeleteAlert(request, params.id, await defaultAlertsDeps()),
    },
  },
});
