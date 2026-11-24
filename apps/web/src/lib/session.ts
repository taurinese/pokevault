import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import type { SessionUser } from "./auth.ts";
import { getServerSession } from "./auth-server.ts";

/**
 * Server Function : utilisateur courant (`null` si non connecté). Rafraîchit
 * les cookies de session si le jeton d'accès avait expiré. Prête à être
 * consommée par les `beforeLoad` / loaders des routes protégées (ex. `09B`) :
 * le client ne reçoit jamais de jeton, uniquement `{ id, email, provider }`.
 */
export const getCurrentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionUser | null> => {
    const session = await getServerSession(getRequest());
    if (session === null) return null;
    for (const cookie of session.refreshedCookies ?? []) {
      appendResponseHeader("Set-Cookie", cookie);
    }
    return session.user;
  },
);
