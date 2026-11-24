/** Dictionnaire `fr-FR` — source de vérité des libellés de l'interface. */
export const fr = {
  "app.name": "PokéVault",
  "app.tagline": "Votre collection de cartes Pokémon, au même endroit.",
  "home.title": "PokéVault — Collection de cartes Pokémon",
  "home.heading": "Bienvenue dans PokéVault",
  "home.description": "Le squelette de l'application est en place. La suite arrive bientôt.",
  "home.accountLink": "Mon compte et paramètres",
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
  "nav.alertsUnread_one": "{count} alerte non lue",
  "nav.alertsUnread_other": "{count} alertes non lues",

  // Bascule Dark / Light
  "theme.toggle": "Basculer entre le thème sombre et le thème clair (thème actuel : {theme})",
  "theme.dark": "sombre",
  "theme.light": "clair",

  // Sélecteur d'apparence (09B)
  "theme.selector.label": "Apparence",
  "theme.selector.system": "Auto",
  "theme.selector.dark": "Sombre",
  "theme.selector.light": "Clair",

  // BottomSheet
  "bottomSheet.close": "Fermer la feuille",

  // CardTile
  "cardTile.owned": "Carte possédée : {name}",
  "cardTile.duplicate_one": "Carte en {count} exemplaire : {name}",
  "cardTile.duplicate_other": "Carte en {count} exemplaires : {name}",
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

  // Écran 09A · Connexion
  "login.title": "Connexion — PokéVault",
  "login.heading": "Votre collection, en toute sérénité.",
  "login.tagline":
    "Classez vos cartes, suivez leur valeur Cardmarket et complétez vos classeurs. Connectez-vous pour retrouver votre collection.",
  "login.cards.label": "Aperçu de cartes Pokémon",
  "login.cards.pikachu": "Pikachu",
  "login.cards.charizard": "Dracaufeu ex",
  "login.cards.mewtwo": "Mewtwo",
  "login.continueGoogle": "Continuer avec Google",
  "login.continueDiscord": "Continuer avec Discord",
  "login.oauthOnly": "Connexion sécurisée via votre compte Google ou Discord. Aucun mot de passe.",
  "login.inviteOnly.title": "Accès sur invitation",
  "login.inviteOnly.description":
    "PokéVault est un cercle privé réservé aux personnes invitées. Le compte utilisé n'a pas encore été autorisé : aucune donnée n'a été créée.",
  "login.inviteOnly.hint":
    "Demandez à la personne qui héberge l'instance de vous inviter, ou essayez avec une autre adresse e-mail.",
  "login.inviteOnly.retry": "Essayer un autre compte",
  "login.error.oauth_cancelled":
    "Connexion annulée. Vous pouvez réessayer quand vous le souhaitez.",
  "login.error.auth_failed": "La connexion a échoué. Veuillez réessayer dans un instant.",

  // Écran 09B · Compte & paramètres
  "account.title": "Compte & paramètres — PokéVault",
  "account.heading": "Compte & paramètres",
  "account.back": "Retour à l'accueil",
  "account.profile.label": "Profil",
  "account.profile.fallbackName": "Collectionneur",
  "account.profile.noEmail": "Adresse e-mail non communiquée",
  "account.profile.linkedProviders": "Comptes liés : {providers}",
  "account.profile.noLinkedProvider": "Aucun compte lié",

  "account.linked.heading": "Comptes liés",
  "account.linked.description":
    "Reliez Google et Discord au même profil : vous vous connectez avec l'un ou l'autre, vos données restent uniques.",
  "account.provider.google": "Google",
  "account.provider.discord": "Discord",
  "account.linked.badge": "Lié",
  "account.linked.notLinked": "Non lié",
  "account.linked.linkGoogle": "Lier Google",
  "account.linked.linkDiscord": "Lier Discord",
  "account.linked.linkAria": "Lier le compte {provider}",
  "account.linked.success": "Compte {provider} lié avec succès.",
  "account.linked.error.link_cancelled":
    "Liaison annulée. Vous pouvez réessayer quand vous le souhaitez.",
  "account.linked.error.link_failed":
    "La liaison a échoué (compte déjà rattaché à un autre profil ou service indisponible). Veuillez réessayer.",

  "account.appearance.heading": "Apparence",
  "account.appearance.description":
    "Auto suit le réglage de votre appareil. Le raccourci soleil / lune de l'accueil reste disponible.",

  "account.notifications.heading": "Notifications & préférences",
  "account.notifications.discord": "Alertes Discord",
  "account.notifications.discordLinked":
    "Compte Discord lié : les alertes Discord pourront vous être envoyées.",
  "account.notifications.discordNotLinked":
    "Liez votre compte Discord pour activer les alertes Discord.",
  "account.notifications.soon": "La configuration des notifications arrive bientôt.",
  "account.preferences.language": "Langue de l'interface",
  "account.preferences.languageValue": "Français (fr-FR)",
  "account.preferences.currency": "Devise",
  "account.preferences.currencyValue": "Euro (EUR)",

  "account.session.heading": "Session",
  "account.logout": "Se déconnecter",
  "account.logout.description": "Vous devrez vous reconnecter via Google ou Discord.",
} as const;

export type TranslationKey = keyof typeof fr;
