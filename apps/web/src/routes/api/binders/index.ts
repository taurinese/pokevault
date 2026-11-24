import { createFileRoute } from "@tanstack/react-router";
import {
  defaultBindersDeps,
  handleCreateBinder,
  handleListBinders,
} from "../../../lib/binders-server.ts";

export const Route = createFileRoute("/api/binders/")({
  server: {
    handlers: {
      GET: async ({ request }) => handleListBinders(request, await defaultBindersDeps()),
      POST: async ({ request }) => handleCreateBinder(request, await defaultBindersDeps()),
    },
  },
});
