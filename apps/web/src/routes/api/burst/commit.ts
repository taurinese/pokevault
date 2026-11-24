import { createFileRoute } from "@tanstack/react-router";
import { defaultBurstDeps, handleCommitBurstImport } from "../../../lib/burst-server.ts";

export const Route = createFileRoute("/api/burst/commit")({
  server: {
    handlers: {
      POST: async ({ request }) => handleCommitBurstImport(request, await defaultBurstDeps()),
    },
  },
});
