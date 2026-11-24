import { createFileRoute } from "@tanstack/react-router";
import { defaultBurstDeps, handlePreviewBurstImport } from "../../../lib/burst-server.ts";

export const Route = createFileRoute("/api/burst/preview")({
  server: {
    handlers: {
      POST: async ({ request }) => handlePreviewBurstImport(request, await defaultBurstDeps()),
    },
  },
});
