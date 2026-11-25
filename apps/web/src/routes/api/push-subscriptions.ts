import { createFileRoute } from "@tanstack/react-router";
import {
  defaultAlertsDeps,
  handleDeletePushSubscription,
  handleRegisterPushSubscription,
} from "../../lib/alerts-server.ts";

export const Route = createFileRoute("/api/push-subscriptions")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        handleRegisterPushSubscription(request, await defaultAlertsDeps()),
      DELETE: async ({ request }) =>
        handleDeletePushSubscription(request, await defaultAlertsDeps()),
    },
  },
});
