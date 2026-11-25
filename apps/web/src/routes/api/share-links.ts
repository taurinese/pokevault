import { createFileRoute } from "@tanstack/react-router";
import {
  defaultShareDeps,
  handleCreateShareLink,
  handleListShareLinks,
} from "../../lib/share-server.ts";

export const Route = createFileRoute("/api/share-links")({
  server: {
    handlers: {
      GET: async ({ request }) => handleListShareLinks(request, await defaultShareDeps()),
      POST: async ({ request }) => handleCreateShareLink(request, await defaultShareDeps()),
    },
  },
});
