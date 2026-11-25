import { PlusSquare, Share, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import { detectIosSafariNonStandalone } from "../lib/pwa.ts";

export interface IosPwaInstallGuideProps {
  /**
   * Contrôle explicite de visibilité (tests SSR / prévisualisation).
   * Omis (`undefined`) : détection automatique côté client sur iOS Safari hors standalone.
   */
  readonly visible?: boolean | undefined;
}

const STEPS = [
  { key: "pwa.iosGuide.step1", Icon: Share },
  { key: "pwa.iosGuide.step2", Icon: PlusSquare },
  { key: "pwa.iosGuide.step3", Icon: Smartphone },
] as const;

/**
 * Micro-guide contextuel d'installation PWA sur iOS Safari (`docs/05-pwa-mobile.md §1`).
 * Sur iOS ≥ 16.4, Web Push exige que la PWA soit ajoutée à l'écran d'accueil.
 * Affiché uniquement dans `09B · Compte & paramètres` quand l'utilisateur ouvre l'app
 * dans Safari iOS hors mode standalone (rend `null` en SSR si `visible` n'est pas forcé).
 */
export const IosPwaInstallGuide = ({ visible }: IosPwaInstallGuideProps) => {
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    if (visible !== undefined) return;
    setDetected(detectIosSafariNonStandalone());
  }, [visible]);

  const shouldRender = visible ?? detected;
  if (!shouldRender) return null;

  return (
    <aside
      aria-labelledby="ios-pwa-guide-title"
      data-testid="ios-pwa-install-guide"
      className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id="ios-pwa-guide-title" className="text-sm font-semibold text-primary">
          {t("pwa.iosGuide.title")}
        </h3>
        <p className="text-xs leading-relaxed text-secondary">{t("pwa.iosGuide.description")}</p>
      </div>
      <ol className="flex flex-col gap-2.5">
        {STEPS.map((step, index) => (
          <li key={step.key} className="flex items-start gap-2.5 text-xs text-primary">
            <span
              aria-hidden="true"
              className="tabular flex size-6 shrink-0 items-center justify-center rounded-pill bg-gold-soft font-semibold text-gold"
            >
              {index + 1}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2 pt-0.5 leading-snug">
              <step.Icon size={14} aria-hidden="true" className="shrink-0 text-gold" />
              <span>{t(step.key)}</span>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
};
