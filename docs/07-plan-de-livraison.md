# 07 — Plan de livraison Agile, CI/CD & Backlog (Epics & Tasks)

> **Outillage 100 % gratuit** : **GitHub Issues + GitHub Projects (Kanban)** + **GitHub Actions (CI/CD)** + **GHCR (`ghcr.io`)** + **Docker Compose** self-host.

---

## 1. Méthodologie de développement

### Workflow Git (Integration `develop` → Release `main`)
- **`main`** : branche unique de production, **protégée** (PR obligatoire, CI verte obligatoire, zéro push direct, zéro force-push). Chaque PR `develop` → `main` correspond à une **milestone complète** (puis à chaque nouvelle version en prod) et déclenche la CD GHCR.
- **`develop`** : branche d’intégration protégée (PR obligatoire + CI verte). Toutes les PR d’issues ciblent `develop`.
- **Branches courtes** : créées depuis `develop` (`feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `chore/<issue>-<slug>`).
- **Conventional Commits** : `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- **1 Issue = 1 PR ciblée vers `develop`** : template PR avec résumé, `Closes #<num>` (ou lien issue), captures Dark + Light si UI, checklist tests. **Squash & Merge** sur `develop`, puis **Merge PR** `develop` → `main` en fin de milestone / release.

### Pipeline CI/CD (GitHub Actions)
- **CI (sur chaque PR vers `main`)** :
  1. `pnpm biome check` (lint + format)
  2. `pnpm typecheck` (`tsc --noEmit` strict sur tous les packages)
  3. `pnpm test` (Vitest : domaine Effect-TS + services mockés)
  4. `pnpm build` (build TanStack Start + worker)
  5. Validation des migrations SQL (`supabase/migrations/`)
  6. *(à partir de M2)* Playwright E2E sur les parcours critiques
- **CD (sur merge dans `main`)** :
  1. Build Docker multi-stage (`web` + `worker`) et publication sur `ghcr.io/<owner>/pokevault-web` et `pokevault-worker` (tags `sha-<commit>` + `latest`).
  2. Déploiement sur le serveur maison : `docker compose pull && docker compose up -d` + migration DB + check `/api/health`.

### Definition of Done (DoD)
Une issue n’est fermée que lorsque :
- [ ] Le comportement respecte les maquettes Brilliant en **Dark & Light** (mobile `390px`).
- [ ] La logique métier est portée par des services **Effect-TS** validés par `Effect.Schema`.
- [ ] Les tests unitaires (et RLS/E2E si concerné) sont verts en CI.
- [ ] Les migrations SQL éventuelles sont propres et testées.

---

## 2. Feuille de route : Milestones → Epics → Tasks (prêtes pour GitHub Issues)

### Milestone `M0` — Walking Skeleton, Design System & CI/CD
*Objectif : socle propre, déployable en Docker, CI verte, tokens Dark/Light en place.*

- **Epic `E0 · Socle & Infra`**
  - `T0.1` Initialiser le monorepo (`pnpm workspaces`), TypeScript strict, **Biome**, **Vitest**, `AGENTS.md` et templates GitHub (PR/Issues).
  - `T0.2` Créer le squelette `apps/web` (**TanStack Start** + Tailwind) et `apps/worker` (**Effect-TS** runtime) + endpoint `/api/health`.
  - `T0.3` Extraire les **Design Tokens Dark & Light** de Brilliant (`tokens.css`), polices (`Plus Jakarta Sans` + `JetBrains Mono`), composants de base (`BottomSheet`, `FloatingPillNavbar` Navbar B, `CardTile`).
  - `T0.4` Configurer `docker-compose.yml` (Supabase self-host + `web` + `worker` + Caddy) et `Dockerfile` multi-stage.
  - `T0.5` Mettre en place `.github/workflows/ci.yml` (lint, typecheck, test, build) et `cd.yml` (build & push GHCR).

---

### Milestone `M1` — Auth OAuth & Catalogue TCGdex
*Objectif : connexion Google/Discord fonctionnelle, profil lié, catalogue FR synchronisé et recherchable.*

- **Epic `E1 · Auth OAuth & Profil (`09A`, `09B`)`**
  - `T1.1` Migration SQL `001_profiles_and_auth.sql` (`profiles` + trigger création + RLS + allowlist cercle restreint).
  - `T1.2` Écran `09A · Connexion` (OAuth Google & Discord via Supabase GoTrue + session cookie SSR).
  - `T1.3` Écran `09B · Compte & paramètres` : liaison multi-providers (`linkIdentity` Google + Discord), sélecteur thème `Auto/Sombre/Clair`, déconnexion.
- **Epic `E2 · Catalogue TCGdex & Recherche (`05A–05D`)`**
  - `T2.1` Migration SQL `002_catalog.sql` (`catalog_series`, `catalog_sets`, `catalog_cards`, index GIN + `pg_trgm`).
  - `T2.2` Service Effect-TS `TcgdexSyncService` + job CLI/cron dans `worker` (import séries, sets, logos officiels, cartes FR/EN, mapping `holo_effect`).
  - `T2.3` Écran `05A–05D · Recherche` : état neutre (extensions populaires, accès rapides), saisie avec recherches récentes + suggestions live, résultats Liste/Grille avec filtres.

---

### Milestone `M2` — Collection, Classeurs, Fiche Carte & Saisie rafale
*Objectif : cœur produit 100 % utilisable au quotidien pour gérer sa vraie collection.*

- **Epic `E3 · Classeurs & Dossiers perso (`02`, `02B`, `02C`)`**
  - `T3.1` Migration SQL `003_binders_and_copies.sql` (`binders`, `binder_cards`, `user_card_copies` + RLS + bucket `binder-covers`).
  - `T3.2` Services Effect-TS `BinderService` & `CollectionService` (calculs complétion, agrégations, upload & recompression cover WebP).
  - `T3.3` Écran `02 · Collection` (onglets *Extensions* par bloc & *Dossiers perso*, grandes cards cover 1 image : logo / carte / upload, création dossier).
  - `T3.4` Bottom Sheet `02C · Filtres & Tri` + réglages de classeur (changement de cover à la volée).
- **Epic `E4 · Grille Classeur & Fiche Carte (`03`, `04`)`**
  - `T4.1` Écran `03 · Grille Classeur` virtualisée 3 colonnes (Dark & Light, possédées vs manquantes, badges `×N`/wishlist, filtres rapides).
  - `T4.2` Bottom Sheet `04 · Fiche Carte` (métadonnées TCGdex, gestion multi-exemplaires par langue/variante/état avec stepper `- / +`, ajout dossier perso).
- **Epic `E5 · Saisie rafale (`08A–08D`)`**
  - `T5.1` Service Effect-TS transactionnel `BurstImportService` (enregistrement d’un lot de cartes + retrait auto de la Wishlist + tests unitaires).
  - `T5.2` Écran `08A · Configurer le lot` (extension, langue, variante auto-ajustée, état, mode).
  - `T5.3` Écrans `08B/08D · Grille tactile rafale` (`1 tap = +1`, pills modifiables à la volée, Undo, barre validation) & `08C · Pavé numéros #` (aperçu instantané + override rapide).

---

### Milestone `M3` — Prix Cardmarket, Dashboard V2 & Wishlist Export CSV
*Objectif : valorisation réelle de la collection, fraîcheur visible et wishlist exportable Cardmarket.*

- **Epic `E6 · Worker Prix Cardmarket & Dashboard (`V2b`)`**
  - `T6.1` Migration SQL `004_prices.sql` (`price_snapshots` + vue `card_latest_prices` + index TTL).
  - `T6.2` Service Effect-TS `CardmarketPriceService` (scraper respectueux, `Semaphore`, jitter, circuit breaker, fallback TCGdex, cron 15–30 min + refresh manuel rate-limité).
  - `T6.3` Intégration du bloc Prix Cardmarket (fraîcheur, Tendance / Plus bas FR / Moy. 30j) dans `04 · Fiche Carte` et dans les tuiles.
  - `T6.4` Écran `V2b · Accueil / Dashboard` (barre valeur 1 ligne, cartes phares, grands classeurs récents, bandeau dernière alerte).
- **Epic `E7 · Wishlist & Export Cardmarket (`06A–06C`)`**
  - `T7.1` Migration SQL `005_wishlist.sql` (`wishlist_items` + RLS) et `WishlistService` (bascule 1-tap `✓ Acquise` vers collection).
  - `T7.2` Générateur pur `packages/domain/cardmarket.ts` (CSV RFC 4180 + texte « Add Card List » Shopping Wizard + tests unitaires exhaustifs).
  - `T7.3` Écrans `06A/06B · Wishlist` + Bottom Sheet `06C · Export CSV Cardmarket`.

---

### Milestone `M4` — Alertes Prix (Push + Discord) & Partage Public Lecture Seule
*Objectif : alertes automatiques fiables et partage sécurisé entre proches.*

- **Epic `E8 · Alertes Prix Push & Discord (`07A–07C`)`**
  - `T8.1` Migration SQL `006_alerts_and_push.sql` (`price_alerts`, `alert_events`, `push_subscriptions` + RLS).
  - `T8.2` Moteur pur `AlertEvaluator` (Effect-TS : comparaison seuils, cooldown anti-spam) + `NotificationService` (Web Push VAPID + Discord Webhook/DM) + job cron dans `worker`.
  - `T8.3` Écrans `07A/07B · Alertes prix` + Bottom Sheet `07C · Configurer une alerte` + pastille verte non-lue sur Navbar B.
- **Epic `E9 · Vue Publique Partagée (`09C`, `09D`)`**
  - `T9.1` Migration SQL `007_share_links.sql` (`share_links` + fonction `SECURITY DEFINER get_shared_binder(token)` + tests d’intégration anti-fuite).
  - `T9.2` Écrans `09C/09D · Vue Publique Partagée` (Dark & Light, filtres *Toutes / Doublons / Manquantes*, zéro donnée privée) + gestion/révocation des liens depuis Classeur et Paramètres.

---

### Milestone `M5` — Inspecteur 3D Holo, Polish PWA & Déclinaison Desktop
*Objectif : effet waouh collectionneur, PWA installable irréprochable et confort grand écran.*

- **Epic `E10 · Inspecteur 3D Holo (`04B–04D`)`**
  - `T10.1` Composant `HoloCardViewer3D` (drag 3D spring, presets foil par rareté `holo/reverse/ex/sir/tera/gold`, flip 180°, halo adaptatif).
  - `T10.2` Support Gyroscope mobile (`DeviceOrientationEvent` + permission iOS) + branchement au 2e tap depuis Fiche Carte et Vue Publique.
- **Epic `E11 · PWA, E2E & Desktop`**
  - `T11.1` Manifest PWA, Service Worker (cache LRU images TCGdex, mode offline lecture seule, handler Push) et audit Lighthouse mobile ≥ 90.
  - `T11.2` Suite E2E Playwright sur les 5 parcours critiques (Auth, Saisie rafale, Fiche + 3D, Export CSV, Partage public).
  - `T11.3` Adaptation responsive **Desktop (`1440px`)** : navigation desktop (Sidebar fine ou Topbar), grilles étendues (5–6 colonnes), Fiche Carte en panneau latéral droit.
