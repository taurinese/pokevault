import { createFileRoute } from "@tanstack/react-router";
import { buildHealthResponse } from "../../lib/health.ts";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => buildHealthResponse(),
    },
  },
});
