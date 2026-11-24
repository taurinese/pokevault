-- 006_wishlist_items.sql
-- PokéVault — T7.1 (issue #25): wishlist (`wishlist_items`, RLS) servant la bascule
-- 1-tap « ✓ Acquise » du `WishlistService`.
--
-- Numérotation : `005_price_snapshots.sql` est réservé à l'issue #21 (T6.1, en parallèle) ;
-- le titre historique de l'issue (`005_wishlist.sql`) est donc décalé en `006`.
--
-- Sources de vérité :
--   * docs/01-cahier-des-charges.md §8  (Wishlist `06A–06C`, action 1-tap « Acquise ✓ »)
--   * docs/02-modele-des-donnees.md §4  (`wishlist_items`) et §5 (RLS, index critiques)
--   * docs/06-securite.md               (isolation par utilisateur, wishlist jamais partagée)
--
-- Ce que fait cette migration :
--   1. `public.wishlist_items` : cartes souhaitées, UNIQUE `(user_id, card_id, language, variant)`
--      (le slot exact interrogé par `BurstImportService` pour le retrait auto de la wishlist).
--   2. Trigger `protect_wishlist_item_immutable_columns()` : `id`, `user_id`, `card_id` et
--      `created_at` sont immuables même pour le propriétaire (la RLS ne contrôle que la ligne).
--   3. RLS activée ET forcée ; aucun droit pour `PUBLIC` / `anon` ; 4 policies `authenticated`
--      (`auth.uid() = user_id`) + 1 policy `service_role` (cron de prix, export).
--
-- `wishlist_items` n'est JAMAIS exposée par `get_shared_binder(token)` (docs/06 §2).
--
-- Prérequis : migrations 001 (`profiles`, `set_updated_at()`), 002 (`catalog_cards`) et
-- 004 (`user_card_copies`, cible de la bascule « Acquise »), rôles Supabase. Comme 001–004,
-- cette migration est jouée par `supabase_admin`.

BEGIN;

-- ============================================================================
-- 0. Garde-fous de prérequis (échec explicite plutôt qu'erreur obscure)
-- ============================================================================
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'migration 001 (public.profiles, public.set_updated_at) must be applied before 006';
  END IF;
  IF to_regclass('public.catalog_cards') IS NULL THEN
    RAISE EXCEPTION 'migration 002 (public.catalog_cards) must be applied before 006';
  END IF;
  IF to_regclass('public.user_card_copies') IS NULL THEN
    RAISE EXCEPTION 'migration 004 (public.user_card_copies) must be applied before 006';
  END IF;
END $$;

-- ============================================================================
-- 1. Fonction de trigger (search_path verrouillé, aucun SECURITY DEFINER)
-- ============================================================================

CREATE FUNCTION public.protect_wishlist_item_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'wishlist_items.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'wishlist_items.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.card_id IS DISTINCT FROM OLD.card_id THEN
    RAISE EXCEPTION 'wishlist_items.card_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'wishlist_items.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. Table `public.wishlist_items` (docs/02 §4)
-- ============================================================================

CREATE TABLE public.wishlist_items (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  -- CASCADE : le catalogue n'est jamais purgé en production ; en cas de retrait d'une carte,
  -- un souhait orphelin n'a aucun sens (contrairement à un exemplaire possédé : RESTRICT).
  card_id            text        NOT NULL REFERENCES public.catalog_cards (id) ON DELETE CASCADE,
  language           text        NOT NULL DEFAULT 'FR'
                                 CHECK (language IN ('FR', 'EN', 'JP', 'ZH')),
  variant            text        NOT NULL DEFAULT 'normal'
                                 CHECK (variant IN ('normal', 'reverse', 'holo', 'promo', 'pokeball', 'masterball')),
  min_condition      text        NOT NULL DEFAULT 'NM'
                                 CHECK (min_condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  priority           text        NOT NULL DEFAULT 'normal'
                                 CHECK (priority IN ('normal', 'high')),
  target_price_cents integer     CHECK (target_price_cents IS NULL OR target_price_cents >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Un seul souhait par slot : exactement la clé utilisée par `BurstImportService`.
  CONSTRAINT wishlist_items_unique_slot UNIQUE (user_id, card_id, language, variant)
);

COMMENT ON TABLE public.wishlist_items IS
  'Cartes souhaitées (langue / variante / état minimum / priorité / prix cible). Jamais partagée. RLS auth.uid() = user_id.';
COMMENT ON COLUMN public.wishlist_items.target_price_cents IS
  'Prix cible en centimes EUR ; NULL = pas de seuil (badge « sous seuil » désactivé).';

-- Liste par défaut (récentes d'abord) et liste triée par priorité.
CREATE INDEX idx_wishlist_items_user_created
  ON public.wishlist_items (user_id, created_at DESC);

CREATE INDEX idx_wishlist_items_user_priority
  ON public.wishlist_items (user_id, priority, created_at DESC);

-- Cron de prix (T6.2) : priorise les cartes présentes dans au moins une wishlist
-- (docs/04 §2.1) ; sert aussi la FK vers le catalogue.
CREATE INDEX idx_wishlist_items_card_id
  ON public.wishlist_items (card_id);

CREATE TRIGGER wishlist_items_protect_immutable_columns
  BEFORE UPDATE ON public.wishlist_items
  FOR EACH ROW EXECUTE FUNCTION public.protect_wishlist_item_immutable_columns();

CREATE TRIGGER wishlist_items_set_updated_at
  BEFORE UPDATE ON public.wishlist_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. Droits & RLS (activée ET forcée)
-- ============================================================================

REVOKE ALL ON TABLE public.wishlist_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wishlist_items TO authenticated;
GRANT ALL ON TABLE public.wishlist_items TO service_role;

ALTER TABLE public.wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlist_items FORCE ROW LEVEL SECURITY;

CREATE POLICY wishlist_items_select_own ON public.wishlist_items
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY wishlist_items_insert_own ON public.wishlist_items
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY wishlist_items_update_own ON public.wishlist_items
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY wishlist_items_delete_own ON public.wishlist_items
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Worker / jobs serveur (cron de prix, alertes, export) : accès complet.
CREATE POLICY wishlist_items_service_role_all ON public.wishlist_items
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- 4. Propriétaire & droits d'exécution de la fonction de trigger
-- ============================================================================

-- Même convention que 001 / 004 : propriétaire `postgres`, non exécutable par les rôles API
-- (l'exécution d'un trigger ne vérifie pas EXECUTE).
ALTER FUNCTION public.protect_wishlist_item_immutable_columns() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.protect_wishlist_item_immutable_columns() FROM PUBLIC, anon, authenticated;

COMMIT;
