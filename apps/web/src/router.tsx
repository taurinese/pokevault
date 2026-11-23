import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

export const getRouter = () =>
  createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }

  /** Données statiques de route : `hideNavbar` masque la pilule sur les vues profondes. */
  interface StaticDataRouteOption {
    readonly hideNavbar?: boolean;
  }
}
