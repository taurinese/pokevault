import { createFileRoute } from "@tanstack/react-router";
import {
  defaultAlertsDeps,
  handleCreateAlert,
  handleListAlerts,
} from "../../../lib/alerts-server.ts";

// `alerts/index.ts` (et non `alerts.ts`) : `alerts/$id.ts`, `alerts/channels.ts`… existent dans
// le même dossier ; un fichier `alerts.ts` en ferait un layout parent sans `Outlet`.
export const Route = createFileRoute("/api/alerts/")({
  server: {
    handlers: {
      GET: async ({ request }) => handleListAlerts(request, await defaultAlertsDeps()),
      POST: async ({ request }) => handleCreateAlert(request, await defaultAlertsDeps()),
    },
  },
});
