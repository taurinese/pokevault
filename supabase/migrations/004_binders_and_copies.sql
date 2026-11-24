-- 004_binders_and_copies.sql
-- PokéVault — T3.1 (issue #12): classeurs, dossiers perso, exemplaires possédés
-- & bucket Storage `binder-covers`.
--
-- Sources de vérité :
--   * docs/01-cahier-des-charges.md §4  (classeurs `Extensions` / `Dossiers perso`, covers)
--   * docs/02-modele-des-donnees.md §3  (`binders`, `binder_cards`, `user_card_copies`)
--   * docs/02-modele-des-donnees.md §5  (RLS `auth.uid() = user_id`, index critiques)
--   * docs/06-securite.md §2 & §3       (isolation par utilisateur, uploads de covers)
--
-- Ce que fait cette migration :
--   1. `public.binders`          : classeurs d'extension (`kind = 'set'`, 1 par set et par
--                                  utilisateur) et dossiers perso (`kind = 'custom'`).
--   2. `public.binder_cards`     : contenu des dossiers perso uniquement (un classeur
--                                  d'extension est dérivé du catalogue, jamais stocké).
--   3. `public.user_card_copies` : exemplaires possédés (langue / variante / état / grading).
--   4. Bucket privé `binder-covers` (2 Mio, JPEG/PNG/WebP, jamais SVG) + policies RLS
--      `storage.objects` limitant chaque utilisateur à `<auth.uid()>/<binder_id>.webp`.
--
-- Les trois tables utilisateur ont RLS activée ET forcée ; aucun droit pour `PUBLIC` /
-- `anon`. La lecture publique d'un classeur partagé (`/s/:token`) ne passera JAMAIS par
-- ces tables mais par la fonction SECURITY DEFINER `get_shared_binder(token)` (T-share).
--
-- Cover (`cover_type`) :
--   * 'set_logo' : logo officiel de l'extension. C'est aussi le repli neutre (valeur par
--                  défaut) d'un dossier perso sans cover choisie : dans ce cas ni carte ni
--                  fichier ne sont référencés et l'UI affiche un visuel générique.
--   * 'card'     : `cover_card_id` obligatoire, aucun fichier.
--   * 'upload'   : `cover_storage_path` obligatoire (= `<user_id>/<id>.webp`), aucune carte.
--   Aucun état incohérent n'est représentable (cf. CHECK `binders_cover_consistent`).
--
-- Prérequis :
--   * migration 001 (`public.profiles`, `public.set_updated_at()`) et 002
--     (`public.catalog_sets`, `public.catalog_cards`) ;
--   * rôles Supabase (`anon`, `authenticated`, `service_role`, `postgres`) ;
--   * schéma `storage` avec `storage.buckets` / `storage.objects`. Constaté sur
--     `supabase/postgres:15.8.1.085` : ce schéma est déjà créé par l'image elle-même, AVANT
--     le démarrage de `storage-api` (v1.29.3 ne fait ensuite que le faire évoluer via ses
--     propres migrations). L'ordre de boot `postgres` -> `storage-api` -> migration 004 reste
--     toutefois recommandé : les colonnes `file_size_limit` / `allowed_mime_types` sont
--     vérifiées ci-dessous et la migration échoue explicitement si elles manquent ;
--   * `storage.objects` appartient à `supabase_storage_admin` : `CREATE POLICY` dessus
--     exige d'être propriétaire ou superuser. Cette migration DOIT donc être jouée par
--     `supabase_admin` (superuser de l'image), comme les migrations 001–003, jamais par
--     `postgres` ni par un rôle API.

BEGIN;

-- ============================================================================
-- 0. Garde-fous de prérequis (échec explicite plutôt qu'erreur obscure)
-- ============================================================================
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'migration 001 (public.profiles, public.set_updated_at) must be applied before 004';
  END IF;
  IF to_regclass('public.catalog_sets') IS NULL OR to_regclass('public.catalog_cards') IS NULL THEN
    RAISE EXCEPTION 'migration 002 (public.catalog_sets, public.catalog_cards) must be applied before 004';
  END IF;
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'schema storage (storage.buckets / storage.objects) is missing: start the supabase/postgres image (or storage-api) before 004';
  END IF;
  IF (SELECT count(*)
        FROM information_schema.columns
       WHERE table_schema = 'storage'
         AND table_name = 'buckets'
         AND column_name IN ('id', 'name', 'public', 'file_size_limit', 'allowed_mime_types')) <> 5 THEN
    RAISE EXCEPTION 'storage.buckets lacks file_size_limit / allowed_mime_types: upgrade storage-api migrations before 004';
  END IF;
END $$;

-- ============================================================================
-- 1. Fonctions de trigger (search_path verrouillé, aucun SECURITY DEFINER)
-- ============================================================================

-- Colonnes structurelles de `binders` immuables, même pour le propriétaire (la RLS ne
-- contrôle que la ligne, pas les colonnes modifiées).
CREATE FUNCTION public.protect_binder_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'binders.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'binders.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'binders.kind is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.set_id IS DISTINCT FROM OLD.set_id THEN
    RAISE EXCEPTION 'binders.set_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'binders.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- `binder_cards` n'a de sens que pour un dossier perso. S'exécute avec les droits de
-- l'appelant : un classeur d'un autre utilisateur est invisible (RLS) et traité comme
-- inexistant, ce qui rejette aussi l'insertion.
CREATE FUNCTION public.enforce_binder_cards_custom_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT b.kind INTO v_kind FROM public.binders AS b WHERE b.id = NEW.binder_id;
  IF v_kind IS DISTINCT FROM 'custom' THEN
    RAISE EXCEPTION 'binder_cards only accepts binders of kind custom (binder %, kind %)',
      NEW.binder_id, coalesce(v_kind, 'unknown')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.protect_binder_card_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.binder_id IS DISTINCT FROM OLD.binder_id THEN
    RAISE EXCEPTION 'binder_cards.binder_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.card_id IS DISTINCT FROM OLD.card_id THEN
    RAISE EXCEPTION 'binder_cards.card_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.added_at IS DISTINCT FROM OLD.added_at THEN
    RAISE EXCEPTION 'binder_cards.added_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.protect_user_card_copy_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'user_card_copies.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_card_copies.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user_card_copies.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. Table `public.binders` (docs/02 §3)
-- ============================================================================

CREATE TABLE public.binders (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  kind               text        NOT NULL CHECK (kind IN ('set', 'custom')),
  set_id             text        REFERENCES public.catalog_sets (id) ON DELETE RESTRICT,
  title              text        NOT NULL
                                 CHECK (
                                   char_length(regexp_replace(title, '\s', '', 'g')) > 0
                                   AND char_length(title) <= 80
                                 ),
  cover_type         text        NOT NULL DEFAULT 'set_logo'
                                 CHECK (cover_type IN ('set_logo', 'card', 'upload')),
  cover_card_id      text        REFERENCES public.catalog_cards (id) ON DELETE RESTRICT,
  cover_storage_path text,
  is_pinned          boolean     NOT NULL DEFAULT false,
  sort_order         integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Un classeur d'extension pointe sur un set ; un dossier perso n'en a jamais.
  CONSTRAINT binders_kind_set_consistent CHECK (
    (kind = 'set' AND set_id IS NOT NULL) OR (kind = 'custom' AND set_id IS NULL)
  ),
  -- Une seule cover valide à la fois, aucun état incohérent représentable.
  CONSTRAINT binders_cover_consistent CHECK (
    (cover_type = 'set_logo' AND cover_card_id IS NULL     AND cover_storage_path IS NULL)
    OR (cover_type = 'card'   AND cover_card_id IS NOT NULL AND cover_storage_path IS NULL)
    OR (cover_type = 'upload' AND cover_card_id IS NULL     AND cover_storage_path IS NOT NULL)
  ),
  -- Anti-spoofing (docs/06 §3) : l'unique chemin autorisé est `<user_id>/<binder_id>.webp`.
  -- `id` (DEFAULT) est déjà évalué au moment du CHECK ; `id` et `user_id` sont immuables.
  CONSTRAINT binders_cover_storage_path_format CHECK (
    cover_storage_path IS NULL
    OR cover_storage_path = user_id::text || '/' || id::text || '.webp'
  ),
  -- Un seul classeur par extension et par utilisateur (NULL distincts : sans effet
  -- sur les dossiers perso).
  CONSTRAINT binders_user_set_unique UNIQUE (user_id, set_id)
);

COMMENT ON TABLE public.binders IS
  'Classeurs : extensions suivies (kind=set) et dossiers perso (kind=custom). RLS auth.uid() = user_id.';
COMMENT ON COLUMN public.binders.cover_storage_path IS
  'Chemin dans le bucket privé binder-covers, strictement <user_id>/<id>.webp.';

CREATE INDEX binders_user_listing_idx
  ON public.binders (user_id, kind, is_pinned DESC, sort_order, created_at DESC);

-- Index des FK vers le catalogue (ON DELETE RESTRICT) : vérification rapide côté sync.
CREATE INDEX binders_cover_card_idx
  ON public.binders (cover_card_id)
  WHERE cover_card_id IS NOT NULL;

CREATE TRIGGER binders_set_updated_at
  BEFORE UPDATE ON public.binders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER binders_protect_immutable_columns
  BEFORE UPDATE ON public.binders
  FOR EACH ROW EXECUTE FUNCTION public.protect_binder_immutable_columns();

REVOKE ALL ON public.binders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.binders TO authenticated;
GRANT ALL ON public.binders TO service_role;

ALTER TABLE public.binders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.binders FORCE ROW LEVEL SECURITY;

CREATE POLICY binders_select_own ON public.binders
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY binders_insert_own ON public.binders
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY binders_update_own ON public.binders
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY binders_delete_own ON public.binders
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 3. Table `public.binder_cards` (dossiers perso uniquement)
-- ============================================================================

CREATE TABLE public.binder_cards (
  binder_id uuid        NOT NULL REFERENCES public.binders (id) ON DELETE CASCADE,
  card_id   text        NOT NULL REFERENCES public.catalog_cards (id) ON DELETE RESTRICT,
  position  integer     NOT NULL DEFAULT 0 CHECK (position >= 0),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binder_id, card_id)
);

COMMENT ON TABLE public.binder_cards IS
  'Cartes d''un dossier perso (binders.kind = custom uniquement). Propriété héritée de binders.user_id.';

CREATE INDEX binder_cards_card_idx ON public.binder_cards (card_id);

CREATE TRIGGER binder_cards_enforce_custom_only
  BEFORE INSERT ON public.binder_cards
  FOR EACH ROW EXECUTE FUNCTION public.enforce_binder_cards_custom_only();

CREATE TRIGGER binder_cards_protect_immutable_columns
  BEFORE UPDATE ON public.binder_cards
  FOR EACH ROW EXECUTE FUNCTION public.protect_binder_card_immutable_columns();

REVOKE ALL ON public.binder_cards FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.binder_cards TO authenticated;
-- Seul l'ordre est modifiable (déplacer une carte) ; le reste est immuable (trigger).
GRANT UPDATE (position) ON public.binder_cards TO authenticated;
GRANT ALL ON public.binder_cards TO service_role;

ALTER TABLE public.binder_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.binder_cards FORCE ROW LEVEL SECURITY;

CREATE POLICY binder_cards_select_own ON public.binder_cards
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.binders AS b
     WHERE b.id = binder_cards.binder_id AND b.user_id = (SELECT auth.uid())
  ));

CREATE POLICY binder_cards_insert_own ON public.binder_cards
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.binders AS b
     WHERE b.id = binder_cards.binder_id AND b.user_id = (SELECT auth.uid())
  ));

CREATE POLICY binder_cards_update_own ON public.binder_cards
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.binders AS b
     WHERE b.id = binder_cards.binder_id AND b.user_id = (SELECT auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.binders AS b
     WHERE b.id = binder_cards.binder_id AND b.user_id = (SELECT auth.uid())
  ));

CREATE POLICY binder_cards_delete_own ON public.binder_cards
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.binders AS b
     WHERE b.id = binder_cards.binder_id AND b.user_id = (SELECT auth.uid())
  ));

-- ============================================================================
-- 4. Table `public.user_card_copies` (exemplaires possédés, docs/02 §3)
-- ============================================================================

CREATE TABLE public.user_card_copies (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  card_id              text        NOT NULL REFERENCES public.catalog_cards (id) ON DELETE RESTRICT,
  language             text        NOT NULL DEFAULT 'FR'
                                   CHECK (language IN ('FR', 'EN', 'JP', 'ZH')),
  variant              text        NOT NULL
                                   CHECK (variant IN ('normal', 'reverse', 'holo', 'promo', 'pokeball', 'masterball')),
  condition            text        NOT NULL DEFAULT 'NM'
                                   CHECK (condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  quantity             integer     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Strictement privé : jamais exposé en partage public (docs/06 §2).
  purchase_price_cents integer     CHECK (purchase_price_cents IS NULL OR purchase_price_cents >= 0),
  grading_company      text        CHECK (grading_company IS NULL OR grading_company IN ('PSA', 'PCA', 'BGS', 'CGC')),
  -- Note normalisée (sans espaces de bord) pour que l'unicité du slot reste fiable.
  grading_score        text        CHECK (
                                     grading_score IS NULL
                                     OR (char_length(btrim(grading_score)) BETWEEN 1 AND 16
                                         AND grading_score = btrim(grading_score))
                                   ),
  -- Strictement privé.
  notes                text        CHECK (notes IS NULL OR char_length(notes) <= 1000),
  acquired_at          date        DEFAULT current_date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Une carte gradée a toujours une société ET une note, jamais l'une sans l'autre.
  CONSTRAINT user_card_copies_grading_consistent CHECK (
    (grading_company IS NULL) = (grading_score IS NULL)
  )
);

COMMENT ON TABLE public.user_card_copies IS
  'Exemplaires possédés, regroupés par slot (langue, variante, état, grading) avec quantity. RLS auth.uid() = user_id.';
COMMENT ON COLUMN public.user_card_copies.purchase_price_cents IS 'Strictement privé : jamais exposé en partage public.';
COMMENT ON COLUMN public.user_card_copies.notes IS 'Strictement privé : jamais exposé en partage public.';

-- Un seul enregistrement par slot : on incrémente `quantity` au lieu de dupliquer.
CREATE UNIQUE INDEX user_card_copies_unique_slot_idx
  ON public.user_card_copies (
    user_id, card_id, language, variant, condition,
    coalesce(grading_company, ''), coalesce(grading_score, '')
  );

-- Index critique (docs/02 §5) : agrégation rapide complétion & doublons.
CREATE INDEX user_card_copies_user_card_idx
  ON public.user_card_copies (user_id, card_id);

CREATE TRIGGER user_card_copies_set_updated_at
  BEFORE UPDATE ON public.user_card_copies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER user_card_copies_protect_immutable_columns
  BEFORE UPDATE ON public.user_card_copies
  FOR EACH ROW EXECUTE FUNCTION public.protect_user_card_copy_immutable_columns();

REVOKE ALL ON public.user_card_copies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_card_copies TO authenticated;
GRANT ALL ON public.user_card_copies TO service_role;

ALTER TABLE public.user_card_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_card_copies FORCE ROW LEVEL SECURITY;

CREATE POLICY user_card_copies_select_own ON public.user_card_copies
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY user_card_copies_insert_own ON public.user_card_copies
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY user_card_copies_update_own ON public.user_card_copies
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY user_card_copies_delete_own ON public.user_card_copies
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 5. Propriétaire & droits d'exécution des fonctions de trigger
-- ============================================================================

-- Même convention que 001 : propriétaire `postgres`, non exécutables par les rôles API
-- (l'exécution d'un trigger ne vérifie pas EXECUTE).
ALTER FUNCTION public.protect_binder_immutable_columns() OWNER TO postgres;
ALTER FUNCTION public.enforce_binder_cards_custom_only() OWNER TO postgres;
ALTER FUNCTION public.protect_binder_card_immutable_columns() OWNER TO postgres;
ALTER FUNCTION public.protect_user_card_copy_immutable_columns() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.protect_binder_immutable_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_binder_cards_custom_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_binder_card_immutable_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_user_card_copy_immutable_columns() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 6. Bucket Storage privé `binder-covers` (docs/06 §3)
-- ============================================================================

-- Idempotent : rejouer la migration réaligne la configuration du bucket.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'binder-covers',
  'binder-covers',
  false,
  2097152, -- 2 Mio
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[] -- jamais image/svg+xml (XSS)
)
ON CONFLICT (id) DO UPDATE
  SET name               = EXCLUDED.name,
      public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies RLS sur `storage.objects` : un utilisateur ne voit / n'écrit que
-- `<auth.uid()>/<binder_id>.webp` dans CE bucket (exactement 2 segments, UUID en
-- minuscules : aucun `..`, aucun slash supplémentaire, aucune autre extension).
-- On n'exige pas que le classeur existe : l'upload peut précéder l'INSERT du classeur
-- (id généré côté client) et le nettoyage peut suivre sa suppression ; la cohérence
-- chemin <-> classeur est garantie côté table par `binders_cover_storage_path_format`.
-- Les policies d'autres buckets ne sont pas touchées ; `anon` n'a aucune policy.
DROP POLICY IF EXISTS binder_covers_select_own ON storage.objects;
DROP POLICY IF EXISTS binder_covers_insert_own ON storage.objects;
DROP POLICY IF EXISTS binder_covers_update_own ON storage.objects;
DROP POLICY IF EXISTS binder_covers_delete_own ON storage.objects;

CREATE POLICY binder_covers_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'binder-covers'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    AND split_part(name, '/', 1) = (SELECT auth.uid())::text
  );

CREATE POLICY binder_covers_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'binder-covers'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    AND split_part(name, '/', 1) = (SELECT auth.uid())::text
  );

CREATE POLICY binder_covers_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'binder-covers'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    AND split_part(name, '/', 1) = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'binder-covers'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    AND split_part(name, '/', 1) = (SELECT auth.uid())::text
  );

CREATE POLICY binder_covers_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'binder-covers'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    AND split_part(name, '/', 1) = (SELECT auth.uid())::text
  );

COMMIT;
