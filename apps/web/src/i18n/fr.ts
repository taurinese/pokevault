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

  // Navbar B (pilule flottante)
  "nav.label": "Navigation principale",
  "nav.home": "Accueil",
  "nav.collection": "Collection",
  "nav.search": "Recherche",
  "nav.wishlist": "Wishlist",
  "nav.alerts": "Alertes",
  "nav.alertsUnread": "{count} alertes non lues",

  // Bascule Dark / Light
  "theme.toggle": "Basculer entre le thème sombre et le thème clair (thème actuel : {theme})",
  "theme.dark": "sombre",
  "theme.light": "clair",

  // BottomSheet
  "bottomSheet.close": "Fermer la feuille",

  // CardTile
  "cardTile.owned": "Carte possédée : {name}",
  "cardTile.duplicate": "Carte en {count} exemplaires : {name}",
  "cardTile.missing": "Carte manquante : {name}",
  "cardTile.burst": "+{count} en saisie rafale",
  "cardTile.imageFallback": "Visuel indisponible",

  // Page d'accueil — démo des composants socles
  "home.demo.cards": "CardTile — états",
  "home.demo.sheet": "BottomSheet",
  "home.demo.openSheet": "Ouvrir la feuille",
  "home.demo.sheetTitle": "Démo BottomSheet",
  "home.demo.sheetBody":
    "Feuille modale mobile-first : fermeture par le fond, le bouton fermer, la touche Échap ou un balayage vers le bas.",
  "home.demo.card.owned": "Dracaufeu ex",
  "home.demo.card.duplicate": "Pikachu",
  "home.demo.card.missing": "Mew",
  "home.demo.card.burst": "Évoli",
  "home.demo.card.fallback": "Missingno",

  // Pages squelettes des onglets de la navbar
  "page.collection.title": "Collection",
  "page.collection.description": "Vos classeurs par extension et dossiers perso arrivent bientôt.",
  "page.search.title": "Recherche",
  "page.search.description": "La recherche de cartes (sets, raretés, prix) arrive bientôt.",
  "page.wishlist.title": "Wishlist",
  "page.wishlist.description": "Votre wishlist et l'export CSV Cardmarket arrivent bientôt.",
  "page.alerts.title": "Alertes",
  "page.alerts.description": "Vos alertes de prix (push & Discord) arrivent bientôt.",
} as const;

export type TranslationKey = keyof typeof fr;
