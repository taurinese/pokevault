# Brief Design — Application PWA Collection Pokémon TCG

> Document de référence pour la phase de conception UI/UX sur **Brilliant (`brilliant.design`) via MCP**.
> **Règle de travail** : français, questions libres en texte (pas de sélecteur multiple), avancer par étapes, **ne pas coder** tant que le design et la documentation (`docs/00` à `08`) ne sont pas validés.

---

## 1. Résumé du projet

- **Produit** : PWA fluide desktop + mobile pour gérer sa collection de cartes Pokémon TCG (classeurs par extension + dossiers perso, prix Cardmarket avec fraîcheur, wishlist exportable CSV Cardmarket, alertes de prix push + Discord, partage léger lecture seule de classeurs).
- **Hors périmètre** : aucun forum, chat, ni marketplace communautaire.
- **Audience** : usage perso + cercle restreint (famille/amis, ~10–20 comptes max), self-host à la maison.
- **Auth** : Google + Discord uniquement (liaison des deux providers possible sur un même compte).
- **Stack cible** : TanStack Start (React, SSR, PWA), Effect-TS (logique métier partagée, worker scraping Cardmarket TTL ~15 min + cron ~15–30 min), Supabase self-host (Postgres + Auth + Storage), UI en français (i18n prêt dès le départ).
- **Données** : TCGdex API (cartes, sets, visuels FR/EN/JA/ZH + prix agrégés) + worker Cardmarket temps réel en cache Postgres.
- **Nom du projet** : pas encore choisi (utiliser un placeholder sobre sur les maquettes, ex. *PokéVault* ou *DexBinder*).

---

## 2. Direction artistique retenue (à affiner sur maquette)

**Cap visuel** : **moderne, fluide et premium, sans en faire trop**.
Les artworks Pokémon apportent déjà la couleur et la richesse visuelle : l'interface autour reste calme, structurée et aérée (esprit *Linear / Apple Wallet* appliqué à la collection TCG).

### Tokens de départ (Dark mode)
- **Fond principal** : `#0B0D12` (anthracite/ardoise profond)
- **Surfaces / conteneurs** : `#121620` (niveau 1) et `#181D2A` (niveau 2 / hover)
- **Bordures** : `rgba(255, 255, 255, 0.08)` (fines `1px`, subtiles)
- **Textes** : `#F4F6FA` (principal), `#94A0B8` (secondaire), `#5E6A82` (discret)
- **Accent primaire (Jaune/Or Pokémon raffiné, non fluo)** : `#F5C43D` (CTA principaux, barres de complétion, mise en avant de valeur)
- **Accent secondaire (Bleu TCG contenu)** : `#3B82F6` / `#60A5FA` (filtres actifs, liens, synchro, badges)
- **Sémantique prix** : Vert `#22C55E` (frais / baisse avantageuse), Ambre `#F59E0B` (à rafraîchir), Rouge `#EF4444` (alerte / hausse)
- **Typographie** : `Plus Jakarta Sans` (titres & UI) + `tabular-nums` / `JetBrains Mono` discret (prix `14,90 €`, numéros `025/198`, pourcentages `78 %`)
- **Cartes Pokémon** : respecter le ratio officiel `63 × 88 mm` (~`5:7`), coins doux `8px`, pas de surcharge visuelle autour. Cartes possédées nettes + discret badge quantité/version ; cartes manquantes désaturées (~30 % opacité) avec numéro & prix discret.

---

## 3. Outil design choisi

- **Brilliant (`brilliant.design`) + MCP (`@brilliant-hq/mcp`)**, plan gratuit (projets publics acceptés, illimité via MCP).

---

## 4. Décisions design déjà validées (itérations Brilliant)

- **Priorité Mobile-first (`390×844`)** : on conçoit et valide d'abord tous les écrans mobiles (Dark + Light mode en parallèle), le Desktop viendra dans un second temps.
- **Navbar Mobile validée — Variante B** : capsule flottante détachée ("pill"), 5 onglets (*Accueil*, *Classeurs*, *Recherche*, *Wishlist*, *Alertes*), libellé affiché sur l'onglet actif, badge discret sur *Alertes*. Comme la Recherche est dans la navbar, le header du haut accueille un toggle Light/Dark + avatar.
- **Dashboard Mobile (en cours d'affinage V2)** :
  - **Valeur estimée + complétion sur 1 seule ligne compacte** (point fraîcheur Cardmarket, montant, tendance, mini-jauge et compteur).
  - **Grandes cards Classeurs** avec **couverture configurable à 1 seule image** (au choix dans les réglages du classeur : **logo officiel de l'extension** TCGdex, **une carte de la collection**, ou **une image uploadée par l'utilisateur**).

- **Collection & Grille Classeur (validés)** :
  - Onglet **Collection** séparé en **`Extensions`** (filtrables par bloc/série + bottom sheet Filtres & Tri) et **`Dossiers perso`**.
  - **Grille Classeur** plein écran (3 cartes/ligne, possédées nettes vs manquantes atténuées + badges wishlist/doublons) et **Fiche Carte** en bottom sheet (Cardmarket frais, alerte prix, exemplaires par langue/état/variante).
- **Inspecteur 3D Holo (façon Pokémon TCG Pocket)** :
  - Au second tap sur la carte depuis la Fiche Carte : vue immersive plein écran fond studio sombre adaptatif, carte observable et inclinable en 3D (drag tactile/souris + gyroscope mobile), effets holo/foil dynamiques selon la rareté/variante (Holo, Reverse, EX, SIR texturée, Téracristal, Gold) et flip 180° vers le verso.
- **Recherche (validée)** :
  - 3 états complets : neutre (extensions populaires, accès rapides rareté/prix, tendances Cardmarket), focus/suggestions instantanées + recherches récentes, et résultats (liste/grille avec actions rapides `♥` et `+` / badge quantité).
- **Wishlist & Export CSV Cardmarket (validée)** :
  - Budget estimé 1 ligne + badge `sous seuil`, liste des cartes souhaitées avec bascule 1-tap en acquise (`✓`), et bottom sheet Export Cardmarket (téléchargement `.csv` + copie directe pour « Add Card List »).
- **Alertes Prix (validée)** :
  - Statut canaux `Push PWA` + `Discord lié`, sections `Déclenchées récemment` / `En surveillance` avec switches ON/OFF, et bottom sheet de création d'alerte (seuil cible + presets `-5%/-12%/-20%`, source prix, état min, canaux Push & Discord).
- **Saisie rafale (validée)** :
  - Étape 1 : configuration unique par extension (langue, variante/finition, état, retrait auto de la Wishlist).
  - Étape 2 : bascule libre entre **Grille tactile (1 tap = +1, `-` pour retirer, bandeau paramètres éditables à la volée)** et **Pavé numérique par `#`** (aperçu instantané de la carte + validation groupée du lot).
- **Connexion, Compte & Vue Publique Partagée** :
  - Connexion sobre OAuth **Google + Discord** uniquement ; écran **Compte & paramètres** avec liaison des 2 providers sur le même compte, réglages Push/Discord, thème Auto/Sombre/Clair et gestion des partages.
  - **Vue Publique Partagée** (Dark & Light) en lecture seule, sans prix perso ni boutons d'édition, avec filtres orientés échange (*Toutes*, *Doublons*, *Manquantes*) et observation 3D des cartes.

---

## 5. Écrans complets prévus pour la suite (une fois la Home + Navbar validées)

1. Connexion / Onboarding (OAuth Google + Discord)
2. Dashboard (Accueil) — mobile + desktop
3. Liste des Classeurs (Extensions par bloc/série + Dossiers perso)
4. Grille Classeur (écran phare, possédées vs manquantes, filtres, partage, wishlist) — mobile + desktop
5. Fiche Carte (bottom sheet mobile / panneau latéral desktop : prix Cardmarket frais, exemplaires perso, alerte prix)
6. Wishlist & Export CSV Cardmarket
7. Alertes Prix (seuil, Push + Discord, historique)
8. Vue Publique Partagée (lecture seule, sans données personnelles)

---

## 6. Suite du projet après validation du design

Rédiger la documentation complète dans `docs/` avant tout code :
`00-vision.md`, `01-cahier-des-charges.md`, `02-modele-de-donnees.md`, `03-architecture.md`, `04-integrations.md`, `05-pwa-mobile.md`, `06-securite.md`, `07-plan-de-livraison.md`, `08-risques-decisions.md`.
