import { createFileRoute } from "@tanstack/react-router";
import { LoginScreen } from "../components/LoginScreen.tsx";
import { t } from "../i18n/index.ts";
import { isLoginError, type LoginError } from "../lib/auth-shared.ts";

const LoginPage = () => {
  const { error } = Route.useSearch();
  return <LoginScreen error={error} />;
};

export const Route = createFileRoute("/login")({
  staticData: { hideNavbar: true },
  validateSearch: (search: Record<string, unknown>): { error?: LoginError } =>
    isLoginError(search["error"]) ? { error: search["error"] } : {},
  head: () => ({ meta: [{ title: t("login.title") }] }),
  component: LoginPage,
});
