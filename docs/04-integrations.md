# 04 — Intégrations externes

---

## 1. TCGdex API (Catalogue cartes, sets & visuels)

- **Endpoint principal** : `https://api.tcgdex.net/v2/fr/...` (et `en`, `ja`, `zh-tw` pour les noms multilingues).
- **Assets officiels vérifiés** :
  - Cartes haute résolution : `https://assets.tcgdex.net/fr/<serie>/<set>/<localId>/high.png` (et `low.png` pour vignettes légères).
  - Logos d’extensions : `https://assets.tcgdex.net/fr/<serie>/<set>/logo.png`.
- **Stratégie de synchronisation (pas d’appel live bloquant côté client)** :
  - Un job **Effect-TS** dans `worker` synchronise le catalogue en base Postgres (`catalog_series`, `catalog_sets`, `catalog_cards`) :
    - **Bootstrap initial** : import de toutes les séries et extensions FR (avec enrichissement EN pour le mapping Cardmarket).
    - **Cron quotidien** (1× / 24h) : détection des nouvelles extensions et mises à jour de visuels.
  - Les écrans *Recherche*, *Collection*, *Grille Classeur* et *Saisie rafale* interrogent **exclusivement Postgres** → latence < 30 ms, fonctionnement résilient même si TCGdex subit une panne.
  - Les images sont chargées depuis `assets.tcgdex.net` avec mise en cache agressive côté navigateur / Service Worker (option proxy/cache local Caddy si besoin).

---

## 2. Cardmarket (Prix, fraîcheur TTL & Export)

### 2.1 Architecture du worker de prix
Cardmarket ne propose pas d’API ouverte grand public pour un usage perso : on met en place une stratégie hybride **propre, respectueuse et résiliente**.

1. **Source primaire (cache Postgres TTL ~15 min)** :
   - Chaque lecture de prix vérifie `price_snapshots` (`expires_at > now()`).
   - **Fraîcheur affichée en UI** :
     - `< 15 min` → pastille **verte** (`il y a 6 min`)
     - `15 min – 6 h` → pastille **ambre** (`il y a 2h`)
     - `> 6 h` ou fallback TCGdex → pastille neutre + mention *indicatif*
2. **Cron périodique (`worker`, toutes les 15 à 30 min)** :
   - Rafraîchit en priorité uniquement les cartes **utiles** (pas tout le catalogue de 20 000 cartes !) :
     1. Cartes ayant au moins une **alerte prix active** (`priority 1`).
     2. Cartes présentes dans les **wishlists** (`priority 2`).
     3. Cartes phares / récemment consultées (`priority 3`, batch borné).
3. **Refresh manuel à la demande** :
   - Depuis la Fiche Carte (`arrows-clockwise`), l’utilisateur peut demander une mise à jour immédiate.
   - Protégé par **cooldown** (ex. 1 refresh max toutes les 5 min par carte, globalement partagé entre tous les utilisateurs de l’instance).
4. **Garde-fous scraping (Effect-TS)** :
   - Concurrence strictement limitée (`Semaphore(1)` ou `2`), délai aléatoire entre requêtes (jitter 1.5–4 s).
   - **Circuit Breaker** : si Cardmarket renvoie `403` / `429` / challenge anti-bot, le worker passe en mode dégradé temporaire (pause exponentielle 15 min → 1 h) et sert le dernier snapshot connu + fallback prix agrégés TCGdex sans jamais casser l’app.
   - Logging structuré des erreurs de parsing (détection rapide si le HTML Cardmarket évolue).

### 2.2 Export Wishlist vers Cardmarket
Deux sorties générées côté domaine (`packages/domain/cardmarket.ts`) :
1. **Fichier CSV téléchargeable** (`wants-cardmarket-YYYY-MM-DD.csv`) :
   - Colonnes propres : `qty,name,set_code,number,language,min_condition,foil_only`.
   - Encodage UTF-8 avec échappement RFC 4180.
2. **Texte prêt à copier (« Add Card List » Cardmarket)** :
   - Format compatible avec l’import de Wants List / Shopping Wizard Cardmarket (ex. `1 Charizard ex (MEW 199)` — utilisation du nom EN + code set Cardmarket stocké dans `catalog_sets.cardmarket_code`).

---

## 3. Authentification OAuth (Google & Discord)

- Gérée nativement par **Supabase Auth (GoTrue)** en self-host :
  - Provider **Google OAuth 2.0** (scopes minimaux : `openid email profile`).
  - Provider **Discord OAuth 2.0** (scopes minimaux : `identify email`).
- **Liaison de comptes (`linkIdentity`)** :
  - Depuis `09B · Compte & paramètres`, un utilisateur connecté avec Google peut cliquer sur *Lier Discord* (et vice versa).
  - Un trigger / hook synchronise `discord_user_id` dans `profiles` afin d’autoriser l’envoi d’alertes Discord ciblées.

---

## 4. Notifications (Push PWA + Discord)

### 4.1 Web Push PWA (VAPID)
- Utilisation du standard **Web Push (RFC 8291)** avec paire de clés **VAPID** auto-générée (100 % gratuit, aucun compte Firebase payant requis).
- Stockage des abonnements par appareil dans `push_subscriptions`.
- Suppression automatique des abonnements retournant `404` / `410 Gone`.
- Payload léger : titre (`Florizarre-ex #198 · 46,90 €`), corps (`Passée sous ton seuil de 50,00 € sur Cardmarket`), icône, et `url` d’ouverture directe sur la Fiche Carte.

### 4.2 Discord (Webhook perso ou Bot DM)
- **Mode simple (recommandé v1)** : **Discord Webhook** (1 URL webhook d’un salon privé sur ton serveur Discord familial/perso, configurée par utilisateur ou par défaut pour l’instance) — zéro bot persistant à maintenir, embeds riches avec miniature de la carte, prix constaté, seuil cible et lien direct Cardmarket + lien vers l’app.
- **Mode étendu (optionnel)** : envoi en **DM via Bot Discord** en utilisant le `discord_user_id` issu de la liaison OAuth.
- L’abstraction `NotificationService` (Effect-TS) supporte les deux canaux de façon transparente.
