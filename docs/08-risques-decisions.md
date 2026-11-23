# 08 — Risques & Décisions d’Architecture (ADR)

---

## 1. Registre des risques techniques & produit

| # | Risque | Probabilité | Impact | Mitigation prévue |
|---|---|---|---|---|
| **R1** | **Blocage anti-bot / Cloudflare sur Cardmarket** lors du scraping | Moyenne | Élevé | Cache Postgres TTL 15 min, scraping limité uniquement aux cartes utiles (alertes + wishlists + phares), `Semaphore(1–2)` + jitter aléatoire, **Circuit Breaker** automatique, et **fallback** sur les prix agrégés fournis par TCGdex pour ne jamais bloquer l’UI. |
| **R2** | **Changement de structure HTML Cardmarket** cassant le parser | Moyenne | Moyen | Parser isolé dans `packages/services/cardmarket.ts` avec validation `Effect.Schema`, tests sur fixtures HTML réelles, alerte log/Discord admin dès que le taux d’échec dépasse un seuil. |
| **R3** | **Mapping TCGdex ↔ Cardmarket imparfait** sur certaines promos / variantes | Moyenne | Moyen | Double clé (`cardmarket_code` + `local_id` + nom EN), table/colonne d’override manuel `cardmarket_product_id` sur `catalog_cards` pour corriger au cas par cas. |
| **R4** | **Web Push iOS Safari capricieux** (exige PWA installée sur l’écran d’accueil) | Certaine | Moyen | Micro-guide d’installation PWA sur iOS dans Paramètres + canal **Discord** toujours disponible en parallèle comme filet de sécurité ultra-fiable. |
| **R5** | **Fuite involontaire de données privées** sur un lien de partage public | Faible | Élevé | Isolation stricte par **RLS Postgres** + exposition publique **uniquement** via fonction SQL `SECURITY DEFINER` à projection minimale + test d’intégration automatisé bloquant la CI en cas de fuite. |
| **R6** | **Performance mobile** sur de gros classeurs (250+ cartes) ou sur l’Inspecteur 3D | Moyenne | Moyen | Virtualisation de grille (`@tanstack/react-virtual`), vignettes `low.png` en grille / `high.png` en détail, animations 3D 100 % CSS transforms + `requestAnimationFrame` sans re-render React. |
| **R7** | **Perte de données en self-host maison** (disque HS, mauvaise manip) | Faible | Élevé | `pg_dump` quotidien automatisé + rétention 14 jours + copie externe chiffrée des sauvegardes et du dossier `binder-covers`. |

---

## 2. Journal des Décisions d’Architecture (ADR)

### ADR-001 — Stack full-stack : TanStack Start + Effect-TS + Supabase self-host
- **Décision** : Utiliser **TanStack Start** (React 19, SSR, PWA), **Effect-TS** pour toute la logique métier et le worker, et **Supabase self-host** (Postgres + Auth + Storage) packagé en **Docker Compose**.
- **Raison** : Typage de bout en bout, excellente gestion de la concurrence/erreurs/retries via Effect-TS (crucial pour Cardmarket & cron), contrôle total des données à la maison sans dépendance cloud payante.

### ADR-002 — Outillage Agile & CI/CD 100 % gratuit : GitHub Issues/Projects + GitHub Actions + GHCR
- **Décision** : Gérer les Milestones, Epics, Issues et Kanban dans **GitHub Projects**, la CI/CD via **GitHub Actions**, et l’hébergement des images Docker sur **GHCR**.
- **Raison** : 0 € en repo public ou privé, lien natif Issue ↔ Branche ↔ PR ↔ CI ↔ Image Docker, aucun outil tiers supplémentaire à maintenir.

### ADR-003 — Synchronisation locale du catalogue TCGdex en Postgres
- **Décision** : Ne jamais dépendre de l’API TCGdex en direct pour la recherche ou les grilles ; synchroniser le catalogue en Postgres par job serveur quotidien.
- **Raison** : Recherche instantanée (`pg_trgm` + GIN), jointures SQL directes avec `user_card_copies`, résilience totale si TCGdex est lent ou indisponible.

### ADR-004 — Navigation Mobile validée : Navbar B (Pill flottante 5 onglets) + Mobile-first prioritaire
- **Décision** : Adopter la **Variante B** (capsule flottante détachée, 5 onglets : *Accueil*, *Collection*, *Recherche*, *Wishlist*, *Alertes*, libellé affiché uniquement sur l’onglet actif) et livrer l’expérience Mobile (`390×844`, Dark & Light) en priorité avant la déclinaison Desktop (`M5`).
- **Raison** : Ergonomie au pouce optimale (y compris la Recherche), forte identité moderne/sobre validée sur Brilliant, pas de surcharge visuelle autour des cartes.

### ADR-005 — Couverture de classeur configurable à 1 seule image
- **Décision** : Chaque classeur (extension ou dossier perso) affiche **une seule image** en couverture, configurable entre : (1) logo officiel de l’extension, (2) une carte de la collection, ou (3) une image uploadée (stockée recompressée en WebP dans Supabase Storage).
- **Raison** : Lisibilité nette sur mobile dans une grille 2 colonnes, personnalisation forte sans encombrement visuel.

### ADR-006 — Saisie rafale en 2 modes (Grille tactile + Pavé numéros `#`)
- **Décision** : Pré-configurer une seule fois par lot `(extension, langue, variante, état)` puis permettre la saisie en rafale au choix par **Grille tactile (`1 tap = +1`)** ou par **Pavé numérique `#`**, avec pills modifiables à la volée et validation transactionnelle groupée.
- **Raison** : Divise par 5 à 10 le temps de saisie d’un classeur physique existant ou d’une ouverture de boosters.

### ADR-007 — Inspecteur 3D Holo natif CSS 3D + Gyroscope (sans dépendance WebGL lourde)
- **Décision** : Implémenter l’inspecteur 3D façon *Pokémon TCG Pocket* via transformations CSS 3D matérielles, couches foil/blend-mode pilotées par `holo_effect` et `DeviceOrientationEvent` (gyroscope), plutôt que Three.js.
- **Raison** : Bundle minuscule (zéro surcoût ~500 Ko de moteur 3D), 60 fps constants sur mobile, compatibilité navigateur universelle et dégradation douce avec `prefers-reduced-motion`.

### ADR-008 — Partage public exclusivement via fonction SQL `SECURITY DEFINER`
- **Décision** : Ne jamais ouvrir la lecture anonyme RLS sur les tables utilisateur ; passer par un jeton aléatoire 32 octets résolu par une fonction SQL à projection strictement filtrée.
- **Raison** : Garantit structurellement l’impossibilité de fuiter des prix d’achat, notes, emails ou autres classeurs privés.
