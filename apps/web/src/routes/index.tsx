import { CardAspectRatio } from "@pokevault/domain";
import { createFileRoute } from "@tanstack/react-router";
import { t } from "../i18n/index.ts";

const ratioFormatter = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const Home = () => (
  <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-6 p-6">
    <h1 className="text-2xl font-bold">{t("home.heading")}</h1>
    <p className="text-center" style={{ color: "var(--text-secondary)" }}>
      {t("home.description")}
    </p>
    <div
      role="img"
      aria-label={t("home.cardPlaceholder")}
      className="w-40 rounded-lg"
      style={{
        aspectRatio: CardAspectRatio,
        background: "var(--bg-surface-1)",
        border: "1px solid var(--border-subtle)",
      }}
    />
    <p className="tabular text-sm" style={{ color: "var(--accent-gold)" }}>
      {t("home.cardRatio", { ratio: ratioFormatter.format(CardAspectRatio) })}
    </p>
  </main>
);

export const Route = createFileRoute("/")({ component: Home });
