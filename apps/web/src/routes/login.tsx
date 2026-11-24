import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginScreen } from "../components/LoginScreen.tsx";
import { t } from "../i18n/index.ts";
import { isLoginError, type LoginError, sanitizeRedirectPath } from "../lib/auth-shared.ts";
import { getCurrentUser } from "../lib/session.ts";

interface LoginSearch {
  error?: LoginError;
  /** Chemin interne où revenir après la connexion (ex. `/account`). */
  redirect?: string;
}

const LoginPage = () => {
  const { error, redirect: redirectTo } = Route.useSearch();
  return <LoginScreen error={error} redirectTo={redirectTo} />;
};

export const Route = createFileRoute("/login")({
  staticData: { hideNavbar: true },
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const redirectTo = sanitizeRedirectPath(
      typeof search["redirect"] === "string" ? search["redirect"] : undefined,
    );
    return {
      ...(isLoginError(search["error"]) ? { error: search["error"] } : {}),
      ...(redirectTo === "/" ? {} : { redirect: redirectTo }),
    };
  },
  // Déjà connecté : inutile de repasser par l'écran de connexion.
  beforeLoad: async ({ search }) => {
    const user = await getCurrentUser();
    if (user !== null) throw redirect({ href: search.redirect ?? "/" });
  },
  head: () => ({ meta: [{ title: t("login.title") }] }),
  component: LoginPage,
});
