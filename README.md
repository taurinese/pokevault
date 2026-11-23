# PokéVault

PWA mobile-first, rapide, sobre et auto-hébergée pour gérer sa collection de cartes **Pokémon TCG** (usage perso + cercle restreint).

## Fonctionnalités clés

- **Classeurs par extension & Dossiers perso** avec couverture configurable (1 image : logo officiel, carte de la collection, ou image uploadée).
- **Saisie rafale** optimisée : configuration unique par lot (`langue`, `variante`, `état`) puis ajout en **Grille tactile (`1 tap = +1`)** ou au **Pavé numéros `#`**.
- **Prix Cardmarket** avec indicateur de fraîcheur (cache Postgres TTL ~15 min + cron 15–30 min).
- **Wishlist & Export CSV / Add Card List** prêt pour le Shopping Wizard Cardmarket.
- **Alertes prix** automatiques par **Push PWA** et **Discord**.
- **Inspecteur 3D Holo** immersif (drag tactile, gyroscope mobile, flip 180°, effets foil par rareté).
- **Partage public en lecture seule** (`/s/:token`) strictement isolé via RLS + fonction SQL dédiée (zéro fuite de données personnelles).
- **Auth OAuth Google + Discord** (liaison des deux comptes possible).

## Stack technique

- **Web / PWA** : TanStack Start (React 19, SSR, Tailwind, Dark & Light tokens)
- **Logique métier & Worker** : Effect-TS (`Effect.Schema`, erreurs typées, cron, scraping résilient)
- **Base de données, Auth & Storage** : Supabase self-host (PostgreSQL + RLS + GoTrue + Storage)
- **Déploiement** : Docker Compose + GitHub Actions CI/CD + GHCR

## Documentation de référence

Toute la conception produit, technique et Agile vit dans [`docs/`](./docs/) :

- [00 — Vision](./docs/00-vision.md)
- [01 — Cahier des charges](./docs/01-cahier-des-charges.md)
- [02 — Modèle de données & RLS](./docs/02-modele-des-donnees.md)
- [03 — Architecture & Design System](./docs/03-architecture.md)
- [04 — Intégrations (TCGdex, Cardmarket, OAuth, Push/Discord)](./docs/04-integrations.md)
- [05 — PWA, Mobile & Inspecteur 3D Holo](./docs/05-pwa-mobile.md)
- [06 — Sécurité & Self-Host](./docs/06-securite.md)
- [07 — Plan de livraison Agile & Backlog](./docs/07-plan-de-livraison.md)
- [08 — Risques & ADRs](./docs/08-risques-decisions.md)
- [Brief Design & Maquettes Brilliant](./docs/design-brief.md)
