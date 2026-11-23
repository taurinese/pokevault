# 01 — Cahier des charges fonctionnel

> Chaque écran décrit ci-dessous correspond directement aux maquettes mobiles (`390×844`, Dark & Light) validées sur Brilliant.

---

## 1. Navigation globale (Mobile-first)

- **Barre de navigation principale (Navbar B)** : capsule flottante détachée en bas d’écran, 5 onglets :
  1. **Accueil** (*Dashboard*)
  2. **Collection** (*Extensions & Dossiers perso*)
  3. **Recherche** (*Catalogue TCGdex & prix*)
  4. **Wishlist** (*Cartes souhaitées & Export CSV*)
  5. **Alertes** (*Alertes prix Push + Discord* + pastille verte si déclenchement non vu)
- L’onglet actif affiche son icône remplie + libellé dans une pilule dorée ; les onglets inactifs n’affichent que leur icône.
- Les vues profondes dédiées (**Grille Classeur**, **Saisie rafale**, **Inspecteur 3D**, **Compte & paramètres**, **Vue publique partagée**) masquent la navbar pour maximiser l’espace utile et proposent un retour explicite en haut à gauche.
- **Déclinaison Desktop** (Milestone `M5`) : réutilisation intégrale des composants métier dans un layout élargi (Topbar ou Sidebar fine + panneau latéral pour la Fiche Carte).

---

## 2. Authentification & Compte (`09A` & `09B`)

### 2.1 Connexion (`09A`)
- Connexion exclusivement via **OAuth Google** ou **OAuth Discord** (aucun mot de passe local).
- Accès réservé au cercle restreint : mécanisme d’**allowlist / invitation** (par email ou activation manuelle admin) configurable par variable d’environnement afin d’éviter toute inscription publique non désirée sur l’instance self-hostée.

### 2.2 Compte & Paramètres (`09B`)
- **Liaison multi-providers** : un utilisateur connecté avec Google peut lier son compte Discord (et inversement) sur le même profil unique — indispensable notamment pour activer les alertes Discord.
- **Apparence** : sélecteur `Auto (système)` | `Sombre` | `Clair` (+ raccourci rapide soleil/lune dans le header du Dashboard).
- **Notifications** : activation/désactivation du Push PWA par appareil + configuration du canal Discord (DM bot ou webhook personnel).
- **Préférences par défaut** : langue UI (`fr` par défaut, i18n extensible), devise (`EUR`), langue/état par défaut des nouvelles cartes.
- **Gestion des partages lecture seule** : liste des liens actifs, copie en 1 tap, révocation instantanée.

---

## 3. Accueil / Dashboard (`V2b`)

- **Header compact** : identité app, toggle thème Light/Dark, accès profil (`avatar`).
- **Barre synthèse 1 ligne** :
  - Pastille de fraîcheur globale Cardmarket
  - **Valeur totale estimée** de la collection + variation 30 jours (`+4,2 %`)
  - Mini-jauge de **complétion globale** (`58 %`) + compteur total de cartes possédées (`1 248`)
- **Cartes phares** : top 3 des cartes les plus valorisées (ou épinglées) en cartes officielles `63:88` avec badge quantité (`×1`, `×2`), set/numéro, prix Cardmarket et tendance.
- **Mes classeurs** : grandes cards visuelles (couverture 1 image configurable) des classeurs récemment consultés/modifiés, avec code extension, pourcentage de complétion, jauge et valeur.
- **Dernière alerte prix déclenchée** : bandeau compact vert si au moins une alerte récente a atteint son seuil, ouvrant directement la fiche carte ou l’onglet Alertes.

---

## 4. Collection & Classeurs (`02`, `02B`, `02C`)

### 4.1 Onglet *Extensions* (`02`)
- Contrôle segmenté principal : **`Extensions`** | **`Dossiers perso`**.
- Filtres rapides par bloc/série (*Écarlate & Violet*, *Épée & Bouclier*, *Soleil & Lune*, *XY*, *Bloc Wizards*, *Tous*).
- En-tête de bloc indiquant le nombre de sets suivis et la complétion agrégée.
- Grille 2 colonnes de **grandes cards Classeurs** :
  - **Couverture configurable à 1 seule image** (modifiable dans les réglages du classeur) :
    1. **Logo officiel de l’extension** (source TCGdex, cadrage `contain` centré)
    2. **Une carte de la collection** (1 carte entière `63:88` centrée)
    3. **Une image uploadée par l’utilisateur** (stockée sur Supabase Storage, cadrage plein cadre `cover` avec pills lisibles)
  - Code extension, pourcentage, barre de complétion, compteur `possédées/total`, valeur estimée.

### 4.2 Onglet *Dossiers perso* (`02B`)
- Permet de créer des classeurs libres transversaux (ex. *Évolitions Favs*, *Doublons Échange*, *Illustrateurs favoris*), indépendant des extensions officielles.
- Même format grande card avec indicateur `Partagé` / `Privé`, nombre de cartes, valeur totale et card pointillée `+ Nouveau dossier personnalisé`.

### 4.3 Bottom Sheet *Filtres & Tri* (`02C`)
- **Tri** : `Complétion ↓`, `Valeur ↓`, `Date de sortie`, `Nom A–Z`.
- **Avancement** : `En cours`, `Complets`, `Non commencés`.
- **Bloc / Série** : filtrage multi-blocs.
- **Options** : `Masquer les sets à 0 carte`, `Inclure les cartes promos / variantes`.

---

## 5. Intérieur d’un Classeur, Fiche Carte & Inspecteur 3D (`03`, `04`, `04B–04D`)

### 5.1 Grille Classeur (`03`)
- Top bar dédiée : retour, nom + code + total du set, bouton **Partage lecture seule**, bouton **Réglages classeur** (changement de cover, suppression/archivage, lancement *Saisie rafale*).
- Barre compacte 1 ligne : `% complétion` + barre dorée + `possédées/total` + `valeur du classeur`.
- Filtres rapides : `Toutes`, `Possédées`, `Manquantes`, `Doublons`, `Wishlist` + filtres avancés (rareté, type, langue, variante).
- **Grille 3 colonnes** (`63:88`) :
  - **Possédée** : visuel net, badge `×1` (neutre) ou `×2+` (doré), numéro + prix Cardmarket.
  - **Manquante** : visuel atténué (~30 % opacité), cadre pointillé discret, cœur bleu si en wishlist, prix vert si alerte déclenchée.
  - **Interactions** : tap court → ouvre la **Fiche Carte** ; appui long → ajout rapide `+1` ou bascule en sélection multiple.

### 5.2 Fiche Carte (`04`, Bottom Sheet)
- Grand visuel net de la carte avec bouton discret d’agrandissement plein écran (un tap sur l’artwork lance l’Inspecteur 3D).
- Métadonnées TCGdex : rareté, numéro officiel (`199/165`), extension, illustrateur, type, PV.
- Actions rapides : toggle **Wishlist**, ajout à un **Dossier perso**.
- **Bloc Prix Cardmarket** :
  - Indicateur de fraîcheur (`il y a 6 min` + bouton rafraîchissement manuel sous rate-limit).
  - 3 indicateurs : **Tendance**, **Plus bas FR**, **Moyenne 30 jours**.
  - Boutons **`Alerte prix`** et **`Cardmarket ↗`** (lien externe).
- **Bloc Mes exemplaires** :
  - Liste des copies possédées regroupées par combinaison `(langue, variante, état)` avec stepper `- / qty / +`, date d’ajout et prix d’achat optionnel.
  - Bouton **`+ Ajouter un exemplaire`** (langue `FR/EN/JP/ZH`, variante `Normal/Reverse/Holo/Promo/Master Ball`, état `Mint/NM/EX/GD/LP/PL/PO`, note/prix d’achat optionnels).

### 5.3 Inspecteur 3D Holo (`04B–04D`)
- Ouvert au **second tap sur la carte** depuis la Fiche Carte (et également accessible en Vue Publique Partagée).
- Fond studio sombre adaptatif (halo radial discret dérivé de la teinte dominante de la carte).
- Carte en grand format (`63:88`) observable et inclinable en 3D :
  - **Rotation fluide** au doigt / souris avec retour élastique (*spring*).
  - **Mode Gyroscope** sur mobile (`DeviceOrientationEvent` avec demande de permission iOS).
  - **Effets visuels Holo/Foil dynamiques** adaptés à la rareté/variante (*Holo classique*, *Reverse*, *EX / Full Art*, *SIR texturée*, *Téracristal prismatique*, *Gold*).
  - **Flip 180°** (double-tap ou bouton *Retourner*) vers le dos officiel Pokémon.

---

## 6. Saisie rafale — Ajout rapide optimisé (`08A–08D`)

Workflow en 2 étapes pensé pour saisir rapidement un classeur physique ou une ouverture de boosters :

1. **Étape 1 — Configuration du lot (`08A`)** :
   - Sélection de l’extension cible.
   - Réglages par défaut du lot : **Langue** (`FR/EN/JP/ZH`), **Variante** (`Normal/Reverse/Holo/Promo`, avec ajustement automatique pour les cartes n’existant qu’en Holo/SIR), **État** (`NM/Mint/EX/Good`).
   - Option **`Retirer automatiquement de la Wishlist`** (activée par défaut).
   - Choix du mode de saisie : **Grille tactile** ou **Pavé numéros `#`**.
2. **Étape 2A — Grille tactile (`08B`, `08D`)** :
   - Bandeau en haut avec pills de paramètres **modifiables à la volée** (`FR ▾`, `Normal ▾`, `NM ▾`) et bascule instantanée vers le mode `# Pavé`.
   - **`1 tap = +1`** sur la carte : bordure dorée (`+1`, `+2`) pour un doublon, bordure verte (`Nouvelle` / `Wishlist ✓`) pour une nouvelle carte ; bouton **`−`** en haut à gauche pour décrémenter.
   - Barre flottante en bas : bouton **Undo** (`↩`), récapitulatif live (`+7 cartes · 2 nouvelles · +218,30 €`) et bouton **`Valider`** (enregistrement transactionnel du lot).
3. **Étape 2B — Pavé numéros `#` (`08C`)** :
   - Saisie directe du numéro sur pavé numérique custom → aperçu instantané de la carte correspondante (photo, nom, rareté, prix, quantité actuelle) + override rapide de variante (`Holo/Reverse/×2`) + ruban des derniers ajouts effaçables en 1 tap + bouton **`+ Ajouter`**.

---

## 7. Recherche (`05A–05D`)

- **État neutre (`05A`)** : barre de recherche multi-critères (`nom`, `#numéro`, `extension`, `illustrateur`), filtres de portée (`Tout`, `Cartes`, `Extensions`, `Illustrateurs`), extensions populaires, accès rapides (*SIR / Secrètes*, *Illustration Rare*, *Moins de 20 €*, *Cartes ex*, *Promos*) et tendances Cardmarket.
- **État saisie / suggestions (`05B`)** : historique des recherches récentes effaçable (stocké localement / profil), auto-complétion temps réel regroupée par *Cartes* (miniature, prix, statut possédé/manquant) et *Extensions*.
- **État résultats (`05C`, `05D`)** : compteur, filtres rapides (`Toutes`, `Possédées`, `Manquantes`, `Prix ↓`), switcher Liste / Grille, et **actions rapides directes** sur chaque résultat (`♥` Wishlist, `+` Ajout rapide ou badge quantité `×N`).

---

## 8. Wishlist & Export CSV Cardmarket (`06A–06C`)

- Barre synthèse 1 ligne : **budget total estimé Cardmarket** + badge `N sous seuil`.
- Filtres : `Toutes`, `Sous seuil`, `Prioritaires`, par extension.
- Chaque entrée précise : langue souhaitée, état minimum, priorité (`normale` / `haute`), prix actuel Cardmarket + fraîcheur, cible éventuelle.
- **Action 1-tap `✓` (Acquise)** : ajoute l’exemplaire dans la collection et retire la carte de la wishlist (avec toast *Annuler*).
- **Bottom Sheet Export Cardmarket (`06C`)** :
  - Choix du périmètre (*Toute la wishlist*, *Prioritaires*, *Sous seuil atteint*, ou *Une extension*).
  - Filtres d’export : état minimum, langue, option Foil/Holo uniquement.
  - Aperçu du contenu généré.
  - **Double sortie** : téléchargement du fichier **`wants-cardmarket.csv`** + bouton **`Copier pour « Add Card List »`** (format texte directement collable dans l’outil Wants List / Shopping Wizard de Cardmarket).

---

## 9. Alertes Prix (`07A–07C`)

- Barre de statut des canaux (`Push PWA` + `Discord lié` + accès réglages).
- Deux sections distinctes :
  - **Déclenchées récemment** : mise en avant verte, prix constaté vs seuil, horodatage, canaux notifiés, raccourci direct vers Cardmarket `↗`.
  - **En surveillance** : prix actuel, seuil cible, écart restant, switch ON/OFF individuel (pause sans suppression).
- **Création / édition (`07C`)** :
  - Prix cible numérique avec raccourcis automatiques (`-5 %`, `-12 %`, `-20 %`).
  - Critères : source prix (`Plus bas FR` ou `Tendance`), état minimum (`NM`, `EX`, etc.), langue.
  - Sélection des canaux (`Push PWA` et/ou `Discord`).
  - **Anti-spam (cooldown)** : une alerte déclenchée ne re-notifie pas tant que le prix n’est pas remonté au-dessus du seuil ou avant un délai de cooldown configurable (ex. 24h).

---

## 10. Vue Publique Partagée (`09C`, `09D`)

- Accessible sans compte via une URL contenant un jeton aléatoire long (`/s/<token>`).
- **Strictement lecture seule** :
  - Aucune donnée personnelle (pas d’email, pas de prix d’achat, pas de notes privées, pas d’alertes, pas d’accès à la wishlist privée sauf si un dossier spécifique est partagé).
  - Affiche le nom d’affichage choisi, le titre du classeur, sa complétion et la grille des cartes.
  - Filtres utiles aux échanges : **`Toutes`**, **`Doublons`**, **`Manquantes`**.
  - Tap sur une carte : ouvre une vue propre + **Inspecteur 3D Holo** (sans bloc exemplaires privés ni boutons d’édition).
  - Support Dark & Light indépendant (toggle visiteur).
