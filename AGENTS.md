# AGENTS.md — Règles de développement PokéVault

Ce fichier guide les développeurs et agents IA travaillant sur ce dépôt.

## 1. Documentation de référence (source de vérité)
Toujours consulter `docs/` avant d’implémenter une fonctionnalité :
- [docs/design-brief.md](./docs/design-brief.md) — Direction artistique, décisions maquettes Brilliant
- [docs/00-vision.md](./docs/00-vision.md) — Vision & hors-périmètre
- [docs/01-cahier-des-charges.md](./docs/01-cahier-des-charges.md) — Spécifications fonctionnelles écran par écran
- [docs/02-modele-des-donnees.md](./docs/02-modele-des-donnees.md) — Schéma Postgres, index & RLS
- [docs/03-architecture.md](./docs/03-architecture.md) — Stack, monorepo, Effect-TS & Design Tokens
- [docs/04-integrations.md](./docs/04-integrations.md) — TCGdex, Cardmarket TTL/CSV, OAuth, Push/Discord
- [docs/05-pwa-mobile.md](./docs/05-pwa-mobile.md) — PWA, perf mobile & Inspecteur 3D Holo
- [docs/06-securite.md](./docs/06-securite.md) — RLS, partage public lecture seule, uploads, secrets
- [docs/07-plan-de-livraison.md](./docs/07-plan-de-livraison.md) — Workflow Agile, CI/CD, Milestones & Tasks
- [docs/08-risques-decisions.md](./docs/08-risques-decisions.md) — Risques & ADRs

## 2. Conventions techniques strictes
- **Langue** : UI en français (`fr-FR`) via clés i18n (aucune chaîne en dur hors dictionnaire i18n une fois le socle posé). Code, tables SQL et identifiants en anglais.
- **TypeScript strict** : `strict: true`, `noUncheckedIndexedAccess: true`, **aucun `any`**, pas de `@ts-ignore`.
- **Logique métier en Effect-TS** : toute règle métier, appel externe ou job cron vit dans `packages/domain` ou `packages/services` avec `Effect.Schema` et erreurs typées (`Data.TaggedError`).
- **UI & Design System** :
  - Mobile-first (`390px`), support **Dark & Light** systématique via les CSS custom properties de `tokens.css` (jamais de couleurs hex brutes dans les composants métier).
  - Respect du ratio officiel `63 / 88` sur toutes les cartes Pokémon.
  - Chiffres (prix, compteurs, pourcentages) en police monospace `tabular-nums`.
- **Sécurité & DB** :
  - Toute modification de schéma passe par une migration SQL dans `supabase/migrations/`.
  - Toute table utilisateur a RLS activée (`auth.uid() = user_id`).
  - La route publique `/s/:token` ne passe **que** par `get_shared_binder(token)` — jamais de lecture directe des tables privées.
- **Qualité avant PR** :
  - `pnpm biome check` + `pnpm typecheck` + `pnpm test` + `pnpm build` doivent tous passer.
  - 1 Issue = 1 branche courte = 1 PR ciblée avec `Closes #<id>` et Conventional Commits.
