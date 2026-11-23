import { type TranslationKey, t } from "../i18n/index.ts";

export interface SkeletonPageProps {
  readonly titleKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
}

/** Page squelette d'un onglet de la navbar (padding bas pour la pilule flottante). */
export const SkeletonPage = ({ titleKey, descriptionKey }: SkeletonPageProps) => (
  <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-6 pt-10 pb-40">
    <h1 className="text-2xl font-bold text-primary">{t(titleKey)}</h1>
    <p className="text-secondary">{t(descriptionKey)}</p>
  </main>
);
