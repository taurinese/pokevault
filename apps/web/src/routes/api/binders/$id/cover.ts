import { createFileRoute } from "@tanstack/react-router";
import {
  defaultBindersDeps,
  handleBinderCover,
  handleSetBinderCover,
} from "../../../../lib/binders-server.ts";

export const Route = createFileRoute("/api/binders/$id/cover")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleBinderCover(request, params.id, await defaultBindersDeps()),
      // `PUT` = remplacement de la cover (JSON set_logo/card, multipart `image` ou image brute) ;
      // `POST` en alias pour les clients qui n'émettent que des formulaires.
      PUT: async ({ request, params }) =>
        handleSetBinderCover(request, params.id, await defaultBindersDeps()),
      POST: async ({ request, params }) =>
        handleSetBinderCover(request, params.id, await defaultBindersDeps()),
    },
  },
});
