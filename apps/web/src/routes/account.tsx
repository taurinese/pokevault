import { createFileRoute, redirect } from "@tanstack/react-router";
import { AccountScreen } from "../components/AccountScreen.tsx";
import { t } from "../i18n/index.ts";
import {
  ACCOUNT_PATH,
  type AccountLinkError,
  isAccountLinkError,
  isOAuthProvider,
  type OAuthProvider,
} from "../lib/auth-shared.ts";
import { getCurrentUser } from "../lib/session.ts";

interface AccountSearch {
  linked?: OAuthProvider;
  error?: AccountLinkError;
}

const AccountPage = () => {
  const { user } = Route.useRouteContext();
  const { linked, error } = Route.useSearch();
  return <AccountScreen user={user} linked={linked} error={error} />;
};

export const Route = createFileRoute("/account")({
  staticData: { hideNavbar: true },
  validateSearch: (search: Record<string, unknown>): AccountSearch => ({
    ...(isOAuthProvider(search["linked"]) ? { linked: search["linked"] } : {}),
    ...(isAccountLinkError(search["error"]) ? { error: search["error"] } : {}),
  }),
  // Protection de route côté SSR : session GoTrue vérifiée avant tout rendu.
  beforeLoad: async () => {
    const user = await getCurrentUser();
    if (user === null) throw redirect({ to: "/login", search: { redirect: ACCOUNT_PATH } });
    return { user };
  },
  head: () => ({ meta: [{ title: t("account.title") }] }),
  component: AccountPage,
});
