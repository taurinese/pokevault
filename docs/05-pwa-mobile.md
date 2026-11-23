# 05 — PWA, Ergonomie Mobile & Inspecteur 3D Holo

> L’application est conçue **mobile-first (`390×844`)** comme une vraie application installable sur l’écran d’accueil iOS et Android.

---

## 1. Spécifications PWA

### Manifest (`manifest.webmanifest`)
- `display: "standalone"` (suppression de la barre URL navigateur pour un rendu natif).
- `theme_color`: dynamique selon le thème actif (`#0B0D12` en Dark, `#F4F6FA` en Light via `<meta name="theme-color">`).
- `background_color`: `#0B0D12`.
- Icônes adaptatives : `192×192`, `512×512`, `maskable` Android et `apple-touch-icon` (`180×180`) pour iOS.
- Raccourcis PWA (`shortcuts`) : *Saisie rafale*, *Recherche*, *Wishlist*.

### Service Worker (Workbox / Vite PWA)
- **App Shell** (JS, CSS, polices `Plus Jakarta Sans` & `JetBrains Mono`) : stratégie *Precache* avec mise à jour contrôlée (toast discret *« Nouvelle version disponible · Recharger »*).
- **Images cartes Pokémon (`assets.tcgdex.net`)** : stratégie *CacheFirst* avec expiration LRU (`maxEntries: 600`, `maxAgeSeconds: 30 jours`) → défilement instantané des classeurs déjà visités, consommation réseau minimale.
- **Données collection / classeurs** : *NetworkFirst* avec fallback cache (consultation de ses classeurs possible en mode hors-ligne, ex. en convention/brocante sans réseau ; bandeau discret *« Mode hors-ligne · prix figés »*, écritures désactivées ou mises en attente proprement).
- **Web Push** : réception des notifications `push` + `notificationclick` ouvrant la route exacte de la carte concernée.

### Spécificités iOS Safari
- `viewport-fit=cover` + gestion rigoureuse des zones sûres (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`) afin que la **Navbar B flottante** et les **Bottom Sheets** ne collent jamais la barre Home iOS.
- Web Push sur iOS (≥ 16.4) : ne fonctionne que si la PWA est **installée sur l’écran d’accueil** → dans `09B · Compte & paramètres`, afficher un micro-guide contextuel sur iOS Safari si l’utilisateur tente d’activer le Push hors mode standalone.

---

## 2. Ergonomie tactile & Fluidité

- **Zone de pouce** :
  - **Navbar B** flottante en bas, cible tactile minimale `44×44 px` par icône.
  - Toutes les actions modales (Filtres, Fiche Carte, Export CSV, Création d’alerte) s’ouvrent en **Bottom Sheets** fermables par swipe vers le bas.
- **Grilles de 200+ cartes fluides à 60 fps** :
  - Virtualisation de grille (`@tanstack/react-virtual`) dès qu’un classeur dépasse 60 cartes.
  - Chargement progressif des visuels (`loading="lazy"`, `decoding="async"`, ratio `63/88` réservé en CSS pour **zéro Cumulative Layout Shift**).
  - Vignettes `low.png` dans les grilles 3 colonnes (ultra-légères ~50 Ko) et `high.png` (~300 Ko) sur la Fiche Carte et dans l’Inspecteur 3D.
- **Saisie rafale ultra-réactive (`08B–08D`)** :
  - Retour visuel immédiat optimiste à chaque tap (`+1` instantané en état local avant la validation groupée du lot).
  - Option de retour haptique léger (`navigator.vibrate(10)` sur Android) lors d’un tap en saisie rafale.
  - Aucun clavier système intrusif dans le mode **Pavé `#`** grâce au pavé numérique custom intégré.

---

## 3. Inspecteur 3D Holo (`04B–04D`, façon Pokémon TCG Pocket)

### Architecture de rendu (performant & léger, sans moteur WebGL lourd requis)
- **Transformation 3D matérielle** : `perspective: 1000px` + `transform: rotateX(var(--rx)) rotateY(var(--ry))` pilotée par `requestAnimationFrame` + interpolation *spring* (zéro re-render React par frame, uniquement des CSS custom properties sur le nœud DOM).
- **Entrées interactives** :
  1. **Drag tactile / pointeur** (`PointerEvents`) sur toute la surface : inclinaison fluide jusqu’à `±22°` sur X/Y.
  2. **Gyroscope mobile** (`DeviceOrientationEvent`) activable via le bouton `Gyro` (gestion explicite de `DeviceOrientationEvent.requestPermission()` sur iOS).
  3. **Flip 180°** (`rotateY(180deg)` + `backface-visibility: hidden`) au double-tap ou via le bouton *Retourner*, révélant le verso officiel Pokémon.
- **Presets d’effets visuels par rareté (`catalog_cards.holo_effect`)** :
  - `none` : carte standard (reflet spéculaire mat très léger).
  - `holo` : bande arc-en-ciel verticale subtile (`mix-blend-mode: color-dodge`).
  - `reverse` : motif brillant discret sur le cadre hors illustration.
  - `ex` : reflet diagonal métallique contrasté.
  - `sir` : micro-texture diagonale (motif SVG/CSS fin) + irisation multi-couches.
  - `tera` : prisme cristallin multi-facettes (indigo/cyan/or).
  - `gold` : éclat doré métallique chaud.
- **Accessibilité & batterie** :
  - Respect de `prefers-reduced-motion: reduce` (désactive le tilt auto et réduit les reflets).
  - Bouton toggle **`Holo`** dans la barre de contrôles permettant de désactiver l’effet pour observer l’artwork brut.
  - Arrêt automatique des listeners gyroscope dès la fermeture de l’inspecteur ou la mise en arrière-plan de l’onglet (`visibilitychange`).
