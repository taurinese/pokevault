/** Dictionnaire `fr-FR` — source de vérité des libellés de l'interface. */
export const fr = {
  "app.name": "PokéVault",
  "app.tagline": "Votre collection de cartes Pokémon, au même endroit.",
  "home.title": "PokéVault — Collection de cartes Pokémon",
  "home.heading": "Bienvenue dans PokéVault",
  "home.description": "Le squelette de l'application est en place. La suite arrive bientôt.",
  "home.cardPlaceholder": "Emplacement de carte",
  "home.cardRatio": "Ratio officiel des cartes : {ratio}",
  "notFound.title": "Page introuvable",
  "notFound.description": "La page que vous cherchez n'existe pas.",
  "notFound.backHome": "Retour à l'accueil",
} as const;

export type TranslationKey = keyof typeof fr;
