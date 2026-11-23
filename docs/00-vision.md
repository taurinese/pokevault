# 00 — Vision produit

> **Nom de travail** : *PokéVault* (renommable facilement avant la v1)  
> **Langue principale** : Français (`fr-FR`), architecture i18n prête dès le départ  
> **Statut** : Phase conception — maquettes mobiles validées sur Brilliant, documentation de référence avant développement

---

## 1. Problème & proposition de valeur

Les outils existants de gestion de collection Pokémon TCG souffrent généralement de l’un de ces défauts :
- **Surchargés par le social** (forums, chats, flux communautaires, marketplace intégrée) qui alourdissent l’interface.
- **Lents à alimenter** sur mobile quand on veut enregistrer un classeur physique existant ou une ouverture de boosters.
- **Prix peu lisibles ou sans suivi actif** : pas d’indicateur clair de fraîcheur Cardmarket, ni d’alertes réactives sur baisse de prix vers Discord / Push mobile, ni d’export propre pour le Shopping Wizard Cardmarket.
- **Dépendance cloud fermée** : impossible de maîtriser ses données chez soi.

**PokéVault** répond à ce besoin par une **PWA mobile-first, rapide, sobre et auto-hébergée** permettant de suivre sa collection personnelle (et celle d’un cercle restreint de proches) avec :
1. **Des classeurs clairs** (extensions officielles par bloc/série + dossiers personnalisés, couverture configurable à 1 image).
2. **Une saisie ultra-optimisée** (mode *Saisie rafale* en grille tactile `1 tap = +1` ou au pavé numérique `#`).
3. **Des prix Cardmarket fiables avec fraîcheur visible** (cache Postgres TTL ~15 min + cron 15–30 min).
4. **Une wishlist actionnable** (budget estimé, export CSV / texte prêt pour Cardmarket, bascule 1-tap en acquise).
5. **Des alertes prix proactives** (Push PWA + Discord).
6. **Un partage lecture seule propre** pour comparer doublons et cartes manquantes entre amis/famille, sans jamais exposer de données personnelles.
7. **Un plaisir de collectionneur** avec un inspecteur 3D holographique immersif (façon *Pokémon TCG Pocket*).

---

## 2. Audience & périmètre

### Public cible
- **Usage personnel + cercle restreint** (famille et amis proches, ~10 à 20 comptes maximum).
- **Hébergement** : self-host à la maison dans une stack **Docker Compose** (100 % gratuit côté outillage et infra).
- **Accès** : authentification **Google** et **Discord** uniquement (liaison des deux fournisseurs sur un même compte).

### Hors périmètre (explicitement exclu)
- Aucun forum, fil d’actualité, commentaires publics ou messagerie entre utilisateurs.
- Aucune marketplace / achat-vente intégrée (on redirige vers Cardmarket).
- Aucune application native App Store / Play Store (PWA installable prioritaire).
- Aucune monétisation / facturation SaaS.

---

## 3. Principes directeurs UX & Design

Validés sur l’ensemble des maquettes mobiles (`390×844`) dans Brilliant (cf. [design-brief.md](./design-brief.md)) :

1. **Les cartes Pokémon sont la star** : l’interface reste calme, structurée et sobre (*esprit Linear / Apple Wallet*). Ratio officiel `63 × 88 mm` (~`5:7`) toujours respecté.
2. **Mobile-first, pensé pour le pouce** : navigation par **Navbar B** (pill flottante 5 onglets : *Accueil*, *Collection*, *Recherche*, *Wishlist*, *Alertes*), actions primaires accessibles en bas d’écran, bottom sheets pour filtres, fiches cartes et exports.
3. **Dark & Light natifs dès le jour 1** : tokens sémantiques soignés sur les deux thèmes (anthracite `#0B0D12` + or `#F5C43D` en Dark ; ardoise très doux `#F4F6FA` + or profond `#A16207` en Light).
4. **Transparence de la donnée prix** : chaque prix Cardmarket affiche sa fraîcheur (`il y a 6 min`, pastille verte/ambre) et permet un rafraîchissement manuel maîtrisé.
5. **Rapidité avant tout** : enregistrer 30 cartes d’une ouverture de boosters doit prendre moins d’une minute.

---

## 4. Critères de succès de la v1

- **Performance mobile** : affichage d’un classeur de 200+ cartes fluide à 60 fps, Lighthouse PWA & Performance ≥ 90 sur mobile.
- **Vitesse de saisie** : ajout d’un lot de 20 cartes via la *Saisie rafale* en < 45 secondes.
- **Fiabilité prix & alertes** : fraîcheur Cardmarket respectant le TTL (~15 min) sans blocage, alertes Push + Discord délivrées dans la fenêtre cron (15–30 min).
- **Étanchéité du partage public** : 0 fuite de données privées (email, prix d’achat, notes perso, alertes) sur les liens partagés lecture seule.
- **Exploitation maison simple** : déploiement et mise à jour reproductibles via `docker compose pull && docker compose up -d`.
