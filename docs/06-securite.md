# 06 — Sécurité, Confidentialité & Exploitation Self-Host

> Même pour une instance familiale/amis (10–20 utilisateurs), l’application est exposée sur Internet (PWA mobile + OAuth + liens partagés). La sécurité doit donc être **native et vérifiée par tests automatisés**.

---

## 1. Authentification & contrôle d’accès

- **OAuth uniquement (Google & Discord)** via Supabase GoTrue — aucun mot de passe stocké par l’application.
- **Contrôle d’inscription (cercle restreint)** :
  - Variable `AUTH_ALLOWED_EMAILS` ou table `allowed_users` / mode *invitation uniquement* : un inconnu qui tente de se connecter reçoit un écran propre *« Accès sur invitation »* et ne peut pas créer de données ni déclencher de scraping Cardmarket.
- **Sessions & Cookies** :
  - Cookies `HttpOnly`, `Secure`, `SameSite=Lax` gérés côté serveur (TanStack Start SSR).
  - Vérification systématique de la session dans chaque *Server Function* avant toute lecture/écriture privée.
- **Liaison OAuth (`Google + Discord`)** :
  - Uniquement autorisée depuis une session authentifiée valide via le flux officiel Supabase `linkIdentity` (protection CSRF/state OAuth intégrée).

---

## 2. Étanchéité des données (RLS Postgres & Partage Public)

### Isolation par utilisateur
- **RLS activée sur 100 % des tables utilisateur** (`FORCE ROW LEVEL SECURITY` en bonus côté Postgres).
- Aucune requête applicative utilisateur n’utilise la clé `service_role` : celle-ci est strictement confinée au container `worker` (sync TCGdex, cron Cardmarket, envoi d’alertes).

### Sécurité des liens de partage public (`/s/:token`)
- **Jeton non énumérable** : 32 octets aléatoires cryptographiques (`crypto.randomBytes(32).toString('base64url')`), jamais d’ID incrémental ni d’UUID prédictible.
- **Projection stricte** via fonction SQL dédiée `get_shared_binder(token)` :
  - **Exposé** : `display_name` du propriétaire, métadonnées publiques du classeur (titre, cover, complétion), liste des cartes (`card_id`, `language`, `variant`, `quantity` si autorisé).
  - **Jamais exposé** : `email`, `user_id`, `purchase_price_cents`, `notes`, `discord_user_id`, `discord_webhook_url`, `wishlist_items`, `price_alerts`, autres classeurs non partagés.
- **Révocation immédiate** : un clic sur *Révoquer* passe `is_active = false` + `revoked_at = now()`, rendant le lien invalide instantanément (`404`).
- **Tests d’intégration obligatoires** vérifiant que la réponse JSON de `/s/:token` ne contient aucune clé privée.

---

## 3. Sécurité des uploads (Covers personnalisées)

- Bucket Supabase Storage `binder-covers` :
  - Taille max stricte : **2 Mo** par image.
  - Types MIME autorisés uniquement : `image/jpeg`, `image/png`, `image/webp` (refus strict de `image/svg+xml` pour éviter tout XSS).
  - Re-compression / redimensionnement côté serveur (ex. `sharp` vers WebP `600×600` max, suppression des métadonnées EXIF/GPS).
  - Chemin isolé par utilisateur : `<user_id>/<binder_id>.webp` protégé par politique Storage RLS.

---

## 4. Protection des endpoints & abus

- **Rate limiting** :
  - Refresh manuel Cardmarket : max 1 fois / 5 min par carte + quota par utilisateur (ex. 10 refresh manuels / heure).
  - Routes publiques `/s/:token` : rate-limit par IP au niveau reverse-proxy (Caddy) contre le brute-force.
  - Upload d’images et création de liens : bornés par utilisateur.
- **Validation stricte** : toutes les entrées utilisateur (filtres, saisie rafale, seuils d’alerte, URL webhook Discord) validées par `Effect.Schema`.
  - Pour les webhooks Discord : validation stricte du préfixe `https://discord.com/api/webhooks/` (prévention SSRF).
- **En-têtes HTTP de sécurité** (Caddy / TanStack Start) :
  - `Content-Security-Policy` (autorisant uniquement `'self'` + `assets.tcgdex.net` + Storage local pour les images), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security` (HTTPS obligatoire pour PWA & Web Push).

---

## 5. Secrets, Docker & Sauvegardes (Self-Host)

- **Zéro secret dans Git** : tous les secrets (`SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`, OAuth client secrets) vivent dans un `.env` local hors repo (`.env.example` documenté sans valeurs sensibles).
- **Containers durcis** : images Docker multi-stage Node LTS `alpine`/`slim`, exécution sous utilisateur non-root (`USER node`), Postgres et GoTrue non exposés directement sur Internet (réseau Docker interne uniquement, seul Caddy expose les ports `80/443`).
- **Sauvegardes automatiques** : script cron `pg_dump` quotidien compressé (`gzip`) + rétention 14 jours (+ backup du volume `binder-covers`) vers un dossier local / NAS / cloud perso chiffré.
