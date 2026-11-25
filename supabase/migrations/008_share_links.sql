-- 008_share_links.sql
-- PokéVault — T9.1 (issue #31): liens de partage public en lecture seule (`share_links`) et
-- fonction `SECURITY DEFINER` `get_shared_binder(token)` à projection strictement filtrée.
--
-- Numérotation : `005` / `006` existent déjà et `007_price_alerts.sql` est réservé à l'issue
-- #28 (en parallèle) ; le titre historique de l'issue (`007_share_links.sql`) est donc décalé
-- en `008`. Cette migration ne dépend QUE de 001 (`profiles`), 002 (`catalog_*`) et 004
-- (`binders`, `binder_cards`, `user_card_copies`) — jamais de 005, 006 ni 007.
--
-- Sources de vérité :
--   * docs/02-modele-des-donnees.md §4  (`share_links`) et §5 (RLS, accès public partagé)
--   * docs/06-securite.md §2            (jeton non énumérable, projection stricte, révocation)
--   * docs/08-risques-decisions.md      (ADR-008 : partage exclusivement via fonction SQL)
--
-- Ce que fait cette migration :
--   1. `public.share_links` : un lien = un jeton aléatoire (32 octets base64url, 43 caractères)
--      désignant UN classeur du propriétaire. Révocation immédiate : `is_active = false` ET
--      `revoked_at` renseigné (CHECK `share_links_revocation_consistent`).
--   2. Triggers (search_path verrouillé) : le classeur partagé existe ET appartient à
--      `user_id` (impossible de partager le classeur d'autrui, même en `service_role`) ;
--      colonnes immuables (`id`, `user_id`, `binder_id`, `token`, `created_at`) ; une
--      révocation est irréversible (un jeton révoqué ne redevient jamais valide : on crée un
--      nouveau lien).
--   3. RLS activée ET forcée ; AUCUN droit pour `PUBLIC` / `anon` sur la table.
--   4. `public.get_shared_binder(p_token)` : l'UNIQUE porte d'entrée de la route publique
--      `/s/:token`. `SECURITY DEFINER`, `search_path = pg_catalog, public`, exécutable par
--      `anon`. Projection minimale : propriétaire (`displayName`, `avatarInitials`), métadonnées
--      publiques du classeur, cartes avec `(langue, variante, quantité si autorisée)`.
--      JAMAIS : e-mail, `user_id`, prix d'achat, notes, date d'acquisition, grading, Discord,
--      chemin Storage (`cover_storage_path` embarque le `user_id`), wishlist, alertes, autre
--      classeur.
--   5. `public.get_shared_binder_cover_path(p_token)` : réservée au `service_role` (route
--      serveur T9.2) ; renvoie le chemin Storage de la cover uploadée d'un lien actif afin de
--      la proxifier sans jamais l'exposer au navigateur.
--
-- Propriétaire des fonctions `SECURITY DEFINER` : le rôle qui joue la migration
-- (`supabase_admin`, superuser, comme 001–006). Il contourne la RLS FORCÉE des tables privées,
-- ce qui est précisément le but ; la fonction ne lit que ce que la projection expose.
--
-- Prérequis : migrations 001, 002 et 004, rôles Supabase (`anon`, `authenticated`,
-- `service_role`, `postgres`). Comme 001–006, cette migration est jouée par `supabase_admin`.

BEGIN;

-- ============================================================================
-- 0. Garde-fous de prérequis (échec explicite plutôt qu'erreur obscure)
-- ============================================================================
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'migration 001 (public.profiles) must be applied before 008';
  END IF;
  IF to_regclass('public.catalog_sets') IS NULL OR to_regclass('public.catalog_cards') IS NULL THEN
    RAISE EXCEPTION 'migration 002 (public.catalog_sets, public.catalog_cards) must be applied before 008';
  END IF;
  IF to_regclass('public.binders') IS NULL
     OR to_regclass('public.binder_cards') IS NULL
     OR to_regclass('public.user_card_copies') IS NULL THEN
    RAISE EXCEPTION 'migration 004 (public.binders, public.binder_cards, public.user_card_copies) must be applied before 008';
  END IF;
END $$;

-- ============================================================================
-- 1. Fonctions de trigger (search_path verrouillé, aucun SECURITY DEFINER)
-- ============================================================================

-- Le classeur partagé doit exister ET appartenir à `NEW.user_id`. S'exécute avec les droits de
-- l'appelant : sous RLS (`authenticated`), le classeur d'un autre utilisateur est invisible et
-- traité comme inexistant (même erreur, aucune fuite d'existence) ; pour un rôle qui contourne
-- la RLS (`service_role`) c'est la comparaison explicite des propriétaires qui refuse.
CREATE FUNCTION public.enforce_share_link_binder_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT b.user_id INTO v_owner FROM public.binders AS b WHERE b.id = NEW.binder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'share_links.binder_id % does not reference an accessible binder', NEW.binder_id
      USING ERRCODE = '23503';
  END IF;
  IF v_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'share_links.binder_id % does not belong to user %', NEW.binder_id, NEW.user_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Colonnes structurelles immuables, même pour le propriétaire (la RLS ne contrôle que la
-- ligne). Une révocation est définitive : un jeton révoqué ne peut jamais être réactivé.
CREATE FUNCTION public.protect_share_link_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'share_links.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'share_links.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.binder_id IS DISTINCT FROM OLD.binder_id THEN
    RAISE EXCEPTION 'share_links.binder_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.token IS DISTINCT FROM OLD.token THEN
    RAISE EXCEPTION 'share_links.token is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'share_links.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'share_links revocation is irreversible (create a new link instead)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. Table `public.share_links` (docs/02 §4)
-- ============================================================================

CREATE TABLE public.share_links (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  binder_id       uuid        NOT NULL REFERENCES public.binders (id) ON DELETE CASCADE,
  -- 32 octets aléatoires en base64url = 43 caractères ; 128 = borne haute défensive.
  token           text        NOT NULL UNIQUE
                              CHECK (
                                char_length(token) >= 43
                                AND char_length(token) <= 128
                                AND token ~ '^[A-Za-z0-9_-]+$'
                              ),
  is_active       boolean     NOT NULL DEFAULT true,
  -- Montre ou masque les quantités (doublons) sur la page publique.
  show_quantities boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,

  -- Un lien actif n'a jamais de date de révocation ; un lien révoqué en a toujours une.
  CONSTRAINT share_links_revocation_consistent CHECK (
    (is_active = true AND revoked_at IS NULL)
    OR (is_active = false AND revoked_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.share_links IS
  'Liens de partage public (lecture seule) d''un classeur. Jamais lisible par anon : la route /s/:token passe uniquement par get_shared_binder(token). RLS auth.uid() = user_id.';
COMMENT ON COLUMN public.share_links.token IS
  '32 octets aléatoires cryptographiques encodés base64url (43 caractères) : secret non devinable.';
COMMENT ON COLUMN public.share_links.show_quantities IS
  'true : la page publique montre les quantités ; false : quantity = null (doublons masqués).';

-- Liste « mes liens » (récents d'abord).
CREATE INDEX idx_share_links_user
  ON public.share_links (user_id, created_at DESC);

-- Lien actif d'un classeur (badge « Partagé » du Dashboard, anti-doublon côté service).
CREATE INDEX idx_share_links_binder_active
  ON public.share_links (binder_id)
  WHERE is_active = true AND revoked_at IS NULL;

CREATE TRIGGER share_links_enforce_binder_owner
  BEFORE INSERT ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_share_link_binder_owner();

CREATE TRIGGER share_links_protect_immutable_columns
  BEFORE UPDATE ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.protect_share_link_immutable_columns();

-- ============================================================================
-- 3. Droits & RLS (activée ET forcée) — aucun accès direct pour `anon`
-- ============================================================================

REVOKE ALL ON TABLE public.share_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.share_links TO authenticated;
GRANT ALL ON TABLE public.share_links TO service_role;

ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_links FORCE ROW LEVEL SECURITY;

CREATE POLICY share_links_select_own ON public.share_links
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY share_links_insert_own ON public.share_links
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY share_links_update_own ON public.share_links
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY share_links_delete_own ON public.share_links
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Worker / jobs serveur : accès complet.
CREATE POLICY share_links_service_role_all ON public.share_links
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- 4. `get_shared_binder(p_token)` — unique porte d'entrée de `/s/:token`
-- ============================================================================
--
-- Retour (jsonb) ou NULL si le jeton est mal formé, inconnu, désactivé ou révoqué (le 404 de
-- la route ne distingue jamais ces cas) :
--   {
--     "owner":  { "displayName", "avatarInitials" },
--     "binder": { "id", "kind", "title", "setId", "setCode", "setName", "coverType",
--                 "coverLogoUrl", "coverCardImageUrl", "hasUploadedCover", "showQuantities",
--                 "ownedCount", "totalCards" },
--     "cards":  [ { "cardId", "localId", "localIdNumeric", "nameFr", "setCode", "rarity",
--                   "holoEffect", "imageBaseUrl", "owned", "quantity",
--                   "copies": [ { "language", "variant", "quantity" } ] } ]
--   }
--
-- `cards` : classeur d'extension = tout le set (`local_id_numeric NULLS LAST, local_id`) ;
-- dossier perso = ses cartes (`position, added_at`). `owned` = au moins un exemplaire (toutes
-- langues / variantes / états confondus) ; `quantity` = somme (0 si non possédée), `null` si
-- `show_quantities = false`. `totalCards` compte toutes les cartes listées (secrètes incluses).
--
-- Chaque lecture est bornée au `user_id` et au classeur du LIEN (jamais d'autre classeur).

CREATE FUNCTION public.get_shared_binder(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id         uuid;
  v_binder_id       uuid;
  v_show_quantities boolean;
  v_kind            text;
  v_set_id          text;
  v_cards           jsonb;
  v_owned_count     integer;
  v_total_cards     integer;
  v_result          jsonb;
BEGIN
  IF p_token IS NULL
     OR char_length(p_token) < 43
     OR char_length(p_token) > 128
     OR p_token !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;

  SELECT sl.user_id, sl.binder_id, sl.show_quantities, b.kind, b.set_id
    INTO v_user_id, v_binder_id, v_show_quantities, v_kind, v_set_id
    FROM public.share_links AS sl
    JOIN public.binders AS b ON b.id = sl.binder_id AND b.user_id = sl.user_id
   WHERE sl.token = p_token
     AND sl.is_active = true
     AND sl.revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Cartes du classeur partagé (et de lui seul) avec leurs exemplaires agrégés par
  -- (langue, variante). État, prix d'achat, notes, grading et date d'acquisition ne sont
  -- JAMAIS lus.
  SELECT
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'cardId',         c.id,
          'localId',        c.local_id,
          'localIdNumeric', c.local_id_numeric,
          'nameFr',         c.name_fr,
          'setCode',        cs.code,
          'rarity',         c.rarity,
          'holoEffect',     c.holo_effect,
          'imageBaseUrl',   c.image_base_url,
          'owned',          cp.total IS NOT NULL,
          'quantity',       CASE WHEN v_show_quantities THEN coalesce(cp.total, 0) END,
          'copies',         coalesce(cp.copies, '[]'::jsonb)
        )
        ORDER BY
          (CASE WHEN v_kind = 'custom' THEN src.position END) ASC NULLS LAST,
          (CASE WHEN v_kind = 'custom' THEN src.added_at END) ASC NULLS LAST,
          c.local_id_numeric ASC NULLS LAST,
          c.local_id ASC,
          c.id ASC
      ),
      '[]'::jsonb
    ),
    (count(*) FILTER (WHERE cp.total IS NOT NULL))::integer,
    count(*)::integer
    INTO v_cards, v_owned_count, v_total_cards
    FROM (
      SELECT k.id AS card_id, NULL::integer AS position, NULL::timestamptz AS added_at
        FROM public.catalog_cards AS k
       WHERE v_kind = 'set' AND k.set_id = v_set_id
      UNION ALL
      SELECT bc.card_id, bc.position, bc.added_at
        FROM public.binder_cards AS bc
       WHERE v_kind = 'custom' AND bc.binder_id = v_binder_id
    ) AS src
    JOIN public.catalog_cards AS c  ON c.id = src.card_id
    JOIN public.catalog_sets  AS cs ON cs.id = c.set_id
    LEFT JOIN LATERAL (
      SELECT
        sum(g.qty)::integer AS total,
        jsonb_agg(
          jsonb_build_object(
            'language', g.language,
            'variant',  g.variant,
            'quantity', CASE WHEN v_show_quantities THEN g.qty END
          )
          ORDER BY g.language, g.variant
        ) AS copies
        FROM (
          SELECT ucc.language, ucc.variant, sum(ucc.quantity)::integer AS qty
            FROM public.user_card_copies AS ucc
           WHERE ucc.user_id = v_user_id AND ucc.card_id = c.id
           GROUP BY ucc.language, ucc.variant
        ) AS g
       HAVING count(*) > 0
    ) AS cp ON true;

  SELECT jsonb_build_object(
           'owner', jsonb_build_object(
             'displayName',    p.display_name,
             'avatarInitials', p.avatar_initials
           ),
           'binder', jsonb_build_object(
             'id',                b.id,
             'kind',              b.kind,
             'title',             b.title,
             'setId',             b.set_id,
             'setCode',           s.code,
             'setName',           s.name_fr,
             'coverType',         b.cover_type,
             'coverLogoUrl',      s.logo_url,
             'coverCardImageUrl', cover_card.image_base_url,
             -- Booléen uniquement : `cover_storage_path` contient le user_id, jamais exposé.
             'hasUploadedCover',  (b.cover_type = 'upload' AND b.cover_storage_path IS NOT NULL),
             'showQuantities',    v_show_quantities,
             'ownedCount',        v_owned_count,
             'totalCards',        v_total_cards
           ),
           'cards', v_cards
         )
    INTO v_result
    FROM public.binders AS b
    JOIN public.profiles AS p ON p.id = b.user_id
    LEFT JOIN public.catalog_sets  AS s          ON s.id = b.set_id
    LEFT JOIN public.catalog_cards AS cover_card ON cover_card.id = b.cover_card_id
   WHERE b.id = v_binder_id AND b.user_id = v_user_id;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_shared_binder(text) IS
  'Projection publique stricte d''un classeur partagé (ADR-008). NULL si jeton invalide / inconnu / révoqué. Seul accès anonyme aux données partagées.';

REVOKE ALL ON FUNCTION public.get_shared_binder(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_binder(text) TO anon, authenticated, service_role;

-- ============================================================================
-- 5. `get_shared_binder_cover_path(p_token)` — interne, `service_role` uniquement (T9.2)
-- ============================================================================

-- Chemin Storage de la cover uploadée d'un lien ACTIF (NULL sinon : jeton invalide, révoqué,
-- cover de type `set_logo` / `card`). Le serveur le proxifie ; il n'est jamais renvoyé au
-- navigateur (il embarque le `user_id`).
CREATE FUNCTION public.get_shared_binder_cover_path(p_token text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_path text;
BEGIN
  IF p_token IS NULL
     OR char_length(p_token) < 43
     OR char_length(p_token) > 128
     OR p_token !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;

  SELECT b.cover_storage_path
    INTO v_path
    FROM public.share_links AS sl
    JOIN public.binders AS b ON b.id = sl.binder_id AND b.user_id = sl.user_id
   WHERE sl.token = p_token
     AND sl.is_active = true
     AND sl.revoked_at IS NULL
     AND b.cover_type = 'upload';

  RETURN v_path;
END;
$$;

COMMENT ON FUNCTION public.get_shared_binder_cover_path(text) IS
  'Interne (service_role) : chemin Storage de la cover uploadée d''un lien actif, pour la route serveur /s/:token/cover. Jamais exposé aux clients.';

REVOKE ALL ON FUNCTION public.get_shared_binder_cover_path(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_binder_cover_path(text) TO service_role;

-- ============================================================================
-- 6. Propriétaire & droits d'exécution des fonctions de trigger
-- ============================================================================

-- Même convention que 001 / 004 / 006 : propriétaire `postgres`, non exécutables par les
-- rôles API (l'exécution d'un trigger ne vérifie pas EXECUTE).
ALTER FUNCTION public.enforce_share_link_binder_owner() OWNER TO postgres;
ALTER FUNCTION public.protect_share_link_immutable_columns() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.enforce_share_link_binder_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_share_link_immutable_columns() FROM PUBLIC, anon, authenticated;

COMMIT;
