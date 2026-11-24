import { createFileRoute } from "@tanstack/react-router";
import {
  defaultCardDetailDeps,
  handleDeleteCardCopy,
  handlePatchCardCopy,
} from "../../../../lib/card-detail-server.ts";

export const Route = createFileRoute("/api/cards/copies/$copyId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) =>
        handlePatchCardCopy(request, params.copyId, await defaultCardDetailDeps()),
      DELETE: async ({ request, params }) =>
        handleDeleteCardCopy(request, params.copyId, await defaultCardDetailDeps()),
    },
  },
});
