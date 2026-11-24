import { createFileRoute } from "@tanstack/react-router";
import { defaultBindersDeps, handleBinderCover } from "../../../../lib/binders-server.ts";

export const Route = createFileRoute("/api/binders/$id/cover")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleBinderCover(request, params.id, await defaultBindersDeps()),
    },
  },
});
