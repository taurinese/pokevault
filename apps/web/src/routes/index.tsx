import { CardAspectRatio } from "@pokevault/domain";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { CardTile } from "../components/CardTile.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { DEFAULT_LOCALE, t } from "../i18n/index.ts";

const ratioFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const DEMO_IMAGE_URL = "https://assets.tcgdex.net/fr/sv/sv03.5/199/high.webp";

const Home = () => {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-6 pt-8 pb-40">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary">{t("home.heading")}</h1>
          <p className="text-sm text-secondary">{t("app.tagline")}</p>
        </div>
        <ThemeToggle />
      </header>

      <p className="text-secondary">{t("home.description")}</p>

      <section aria-labelledby="home-demo-cards">
        <h2
          id="home-demo-cards"
          className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase"
        >
          {t("home.demo.cards")}
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <CardTile name={t("home.demo.card.owned")} imageUrl={DEMO_IMAGE_URL} state="owned" />
          <CardTile
            name={t("home.demo.card.duplicate")}
            imageUrl={DEMO_IMAGE_URL}
            state="duplicate"
            count={3}
          />
          <CardTile name={t("home.demo.card.missing")} state="missing" />
          <CardTile
            name={t("home.demo.card.burst")}
            imageUrl={DEMO_IMAGE_URL}
            state="owned"
            burstCount={12}
          />
          <CardTile name={t("home.demo.card.fallback")} />
        </div>
        <p className="tabular mt-4 text-sm text-gold">
          {t("home.cardRatio", { ratio: ratioFormatter.format(CardAspectRatio) })}
        </p>
      </section>

      <section aria-labelledby="home-demo-sheet">
        <h2
          id="home-demo-sheet"
          className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase"
        >
          {t("home.demo.sheet")}
        </h2>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="rounded-pill border border-line bg-surface-1 px-4 py-2.5 text-sm font-medium text-primary shadow-card transition-colors hover:bg-surface-2"
          style={{ minHeight: "var(--touch-target-min)" }}
        >
          {t("home.demo.openSheet")}
        </button>
      </section>

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t("home.demo.sheetTitle")}
      >
        <p>{t("home.demo.sheetBody")}</p>
      </BottomSheet>
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Home });
