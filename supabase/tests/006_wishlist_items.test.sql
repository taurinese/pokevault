-- supabase/tests/006_wishlist_items.test.sql
-- Tests d'intégration SQL de supabase/migrations/006_wishlist_items.sql (issue #25).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres` + GoTrue + storage-api),
-- APRÈS les migrations 001 à 004 (005 n'est pas requise) puis 006, en tant que superuser
-- (`supabase_admin`) :
--
--   for f in 001_profiles_and_auth 002_catalog 003_sync_discord_identity 004_binders_and_copies 006_wishlist_items; do
--     psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/$f.sql
--   done
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/tests/006_wishlist_items.test.sql
--
-- Le script change de rôle (SET ROLE) pour reproduire fidèlement PostgREST (`authenticated` /
-- `anon` / `service_role` + claims JWT -> `auth.uid()`). Une assertion qui échoue lève une
-- exception et arrête psql (code retour != 0).
--
-- Tout se déroule dans UNE transaction annulée par `ROLLBACK` : aucune donnée de test ne
-- subsiste, le script est rejouable. `now()` étant figé dans une transaction, l'avancée de
-- `updated_at` est vérifiée à partir d'une valeur initiale explicitement dans le passé.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers (schéma temporaire de la session, appelés en tant que superuser)
-- ---------------------------------------------------------------------------

-- Exécute `p_sql` sous `p_role` avec `p_sub` comme `sub` du JWT (NULL = pas de JWT).
-- Retourne le nombre de lignes touchées/renvoyées ; lève l'erreur si elle survient.
CREATE FUNCTION pg_temp.rows_as(p_role text, p_sub uuid, p_sql text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  PERFORM set_config(
    'request.jwt.claims',
    CASE WHEN p_sub IS NULL THEN '' ELSE json_build_object('sub', p_sub, 'role', p_role)::text END,
    true
  );
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  RETURN v_rows;
END;
$$;

-- Comme `rows_as`, mais retourne le SQLSTATE de l'erreur (NULL si aucune erreur).
CREATE FUNCTION pg_temp.sqlstate_as(p_role text, p_sub uuid, p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
BEGIN
  BEGIN
    PERFORM pg_temp.rows_as(p_role, p_sub, p_sql);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; -- le sous-bloc annulé restaure aussi le rôle courant
  END;
  RESET ROLE;
  RETURN v_state;
END;
$$;

-- Exige que `p_sql` échoue avec exactement `p_state` (et ne laisse aucune trace).
CREATE FUNCTION pg_temp.expect_error(p_label text, p_role text, p_sub uuid, p_sql text, p_state text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
BEGIN
  v_state := pg_temp.sqlstate_as(p_role, p_sub, p_sql);
  IF v_state IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION '% — expected SQLSTATE %, got % for: %', p_label, p_state, coalesce(v_state, 'no error'), p_sql;
  END IF;
END;
$$;

-- Exige que `p_sql` touche exactement `p_rows` lignes sans erreur.
CREATE FUNCTION pg_temp.expect_rows(p_label text, p_role text, p_sub uuid, p_sql text, p_rows bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows bigint;
BEGIN
  v_rows := pg_temp.rows_as(p_role, p_sub, p_sql);
  IF v_rows IS DISTINCT FROM p_rows THEN
    RAISE EXCEPTION '% — expected % row(s), got % for: %', p_label, p_rows, v_rows, p_sql;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Purge préalable (données résiduelles d'un run interrompu avant la transaction)
-- ---------------------------------------------------------------------------
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%.t7@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000007%';
DELETE FROM public.allowed_users WHERE email LIKE '%.t7@pokevault.test';
DELETE FROM public.catalog_cards WHERE id LIKE 't7-%';
DELETE FROM public.catalog_sets WHERE id LIKE 't7-%';
DELETE FROM public.catalog_series WHERE id LIKE 't7-%';

-- ===========================================================================
-- 0. Structure : RLS activée + forcée, droits, policies, index, fonction de trigger
-- ===========================================================================
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('public.wishlist_items') IS NULL THEN
    RAISE EXCEPTION '[0] public.wishlist_items is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.wishlist_items'::regclass AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '[0] RLS must be ENABLED and FORCED on public.wishlist_items';
  END IF;

  -- Droits : rien pour PUBLIC / anon ; CRUD complet pour authenticated et service_role.
  IF has_table_privilege('anon', 'public.wishlist_items', 'SELECT')
     OR has_table_privilege('anon', 'public.wishlist_items', 'INSERT')
     OR has_table_privilege('anon', 'public.wishlist_items', 'UPDATE')
     OR has_table_privilege('anon', 'public.wishlist_items', 'DELETE')
     OR has_table_privilege('public', 'public.wishlist_items', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.wishlist_items', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.wishlist_items', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.wishlist_items', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.wishlist_items', 'DELETE')
     OR has_table_privilege('authenticated', 'public.wishlist_items', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.wishlist_items', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.wishlist_items', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.wishlist_items', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.wishlist_items', 'DELETE') THEN
    RAISE EXCEPTION '[0] unexpected base privileges on public.wishlist_items';
  END IF;

  -- 4 policies `authenticated` (une par commande) + 1 policy `service_role`, aucune autre.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'wishlist_items' AND roles = '{authenticated}') <> 4
     OR (SELECT count(DISTINCT cmd) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'wishlist_items' AND roles = '{authenticated}') <> 4
     OR (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'wishlist_items' AND roles = '{service_role}') <> 1
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wishlist_items') <> 5 THEN
    RAISE EXCEPTION '[0] public.wishlist_items must have 4 authenticated policies (one per command) + 1 service_role policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'wishlist_items'
                AND roles && ARRAY['anon', 'public']::name[]) THEN
    RAISE EXCEPTION '[0] no policy may target anon / PUBLIC';
  END IF;

  -- Unicité du slot exact attendu par BurstImportService : (user_id, card_id, language, variant).
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.wishlist_items'::regclass AND c.conname = 'wishlist_items_unique_slot';
  IF v_def IS DISTINCT FROM 'UNIQUE (user_id, card_id, language, variant)' THEN
    RAISE EXCEPTION '[0] wishlist_items_unique_slot must be UNIQUE (user_id, card_id, language, variant), got %', v_def;
  END IF;

  -- Index exigés (liste, tri par priorité, cron de prix par carte).
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wishlist_items_user_created'
                  AND indexdef LIKE '%(user_id, created_at DESC)') THEN
    RAISE EXCEPTION '[0] missing index idx_wishlist_items_user_created (user_id, created_at DESC)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wishlist_items_user_priority'
                  AND indexdef LIKE '%(user_id, priority, created_at DESC)') THEN
    RAISE EXCEPTION '[0] missing index idx_wishlist_items_user_priority (user_id, priority, created_at DESC)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_wishlist_items_card_id'
                  AND indexdef LIKE '%(card_id)') THEN
    RAISE EXCEPTION '[0] missing index idx_wishlist_items_card_id (card_id)';
  END IF;

  -- Fonction de trigger : propriétaire de confiance, search_path verrouillé, pas de SECURITY DEFINER,
  -- non exécutable par les rôles API.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.protect_wishlist_item_immutable_columns()'::regprocedure
       AND NOT p.prosecdef
       AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION '[0] protect_wishlist_item_immutable_columns must be SECURITY INVOKER with search_path = ''''';
  END IF;
  IF has_function_privilege('anon', 'public.protect_wishlist_item_immutable_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.protect_wishlist_item_immutable_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION '[0] trigger function must not be executable by anon/authenticated';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.wishlist_items'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION '[0] public.wishlist_items must carry exactly 2 triggers (immutable columns + updated_at)';
  END IF;
  RAISE NOTICE 'ok [0] RLS enabled+forced, grants, policies, unique slot, indexes, trigger function';
END $$;

-- ===========================================================================
-- 1. Fixtures : 2 utilisateurs (Alice, Bob) + mini catalogue
-- ===========================================================================
INSERT INTO public.allowed_users (email, note) VALUES
  ('alice.t7@pokevault.test', 'test T7.1 A'),
  ('bob.t7@pokevault.test',   'test T7.1 B');

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000007a1', 'alice.t7@pokevault.test', '{"full_name": "Alice T7"}'),
  ('00000000-0000-4000-8000-0000000007b1', 'bob.t7@pokevault.test',   '{"full_name": "Bob T7"}');

INSERT INTO public.catalog_series (id, name_fr) VALUES ('t7-sv', 'Série de test T7');
INSERT INTO public.catalog_sets (id, series_id, name_fr, official_count, total_count) VALUES
  ('t7-set-a', 't7-sv', 'Set A', 2, 2);
INSERT INTO public.catalog_cards (id, set_id, local_id, local_id_numeric, name_fr) VALUES
  ('t7-set-a-001', 't7-set-a', '001', 1, 'Carte A1'),
  ('t7-set-a-002', 't7-set-a', '002', 2, 'Carte A2');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN
        ('00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-0000000007b1')) <> 2 THEN
    RAISE EXCEPTION '[1] fixtures: both profiles must exist';
  END IF;
  RAISE NOTICE 'ok [1] fixtures (Alice, Bob, catalogue t7-*)';
END $$;

-- ===========================================================================
-- 2. CRUD nominal & valeurs par défaut (Alice, rôle `authenticated`)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000007a1';
  w public.wishlist_items;
BEGIN
  PERFORM pg_temp.expect_rows('[2] insert minimal', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 't7-set-a-001')$q$, c_a), 1);

  SELECT * INTO w FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  IF w.language <> 'FR' OR w.variant <> 'normal' OR w.min_condition <> 'NM' OR w.priority <> 'normal'
     OR w.target_price_cents IS NOT NULL OR w.created_at IS NULL OR w.updated_at IS NULL THEN
    RAISE EXCEPTION '[2] unexpected defaults: %', row_to_json(w);
  END IF;

  -- Toutes les valeurs autorisées passent (dont prix cible = 0 : « gratuit » reste un entier >= 0).
  PERFORM pg_temp.expect_rows('[2] insert full', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id, language, variant, min_condition, priority, target_price_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000002', %L, 't7-set-a-001', 'JP', 'masterball', 'PO', 'high', 0)$q$, c_a), 1);
  PERFORM pg_temp.expect_rows('[2] read own', 'authenticated', c_a,
    $q$SELECT * FROM public.wishlist_items$q$, 2);
  PERFORM pg_temp.expect_rows('[2] update own', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET priority = 'high', target_price_cents = 1500, min_condition = 'EX'
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 1);
  PERFORM pg_temp.expect_rows('[2] clear target price', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET target_price_cents = NULL WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 1);
  PERFORM pg_temp.expect_rows('[2] delete own', 'authenticated', c_a,
    $q$DELETE FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 1);
  PERFORM pg_temp.expect_rows('[2] remaining', 'authenticated', c_a,
    $q$SELECT * FROM public.wishlist_items$q$, 1);
  RAISE NOTICE 'ok [2] CRUD nominal & defaults';
END $$;

-- ===========================================================================
-- 3. Contraintes : CHECK, FK, unicité du slot
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000007a1';
BEGIN
  PERFORM pg_temp.expect_error('[3] bad language', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, language) VALUES (%L, 't7-set-a-002', 'DE')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad variant', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, variant) VALUES (%L, 't7-set-a-002', 'shiny')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad min_condition', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, min_condition) VALUES (%L, 't7-set-a-002', 'MINT')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad priority', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, priority) VALUES (%L, 't7-set-a-002', 'urgent')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] negative target price', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, target_price_cents) VALUES (%L, 't7-set-a-002', -1)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] null language', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, language) VALUES (%L, 't7-set-a-002', NULL)$q$, c_a), '23502');
  PERFORM pg_temp.expect_error('[3] update bad priority', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET priority = 'urgent' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, '23514');

  -- FK vers le catalogue.
  PERFORM pg_temp.expect_error('[3] unknown card', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id) VALUES (%L, 't7-unknown')$q$, c_a), '23503');

  -- Slot unique (user, carte, langue, variante) : doublon exact refusé...
  PERFORM pg_temp.expect_error('[3] duplicate slot', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id) VALUES (%L, 't7-set-a-001')$q$, c_a), '23505');
  -- ... y compris par UPDATE vers un slot occupé.
  PERFORM pg_temp.expect_rows('[3] other language ok', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id, language) VALUES ('aaaaaaaa-0000-4000-8000-000000000003', %L, 't7-set-a-001', 'EN')$q$, c_a), 1);
  PERFORM pg_temp.expect_rows('[3] other variant ok', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id, variant) VALUES ('aaaaaaaa-0000-4000-8000-000000000004', %L, 't7-set-a-001', 'reverse')$q$, c_a), 1);
  PERFORM pg_temp.expect_error('[3] update into occupied slot', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET language = 'FR' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003'$q$, '23505');
  PERFORM pg_temp.expect_rows('[3] other card ok', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000005', %L, 't7-set-a-002')$q$, c_a), 1);

  -- Le même slot est libre pour un autre utilisateur (unicité scopée par user_id).
  PERFORM pg_temp.expect_rows('[3] same slot other user ok', 'authenticated', '00000000-0000-4000-8000-0000000007b1', format(
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', %L, 't7-set-a-001')$q$,
    '00000000-0000-4000-8000-0000000007b1'::uuid), 1);
  RAISE NOTICE 'ok [3] CHECK / FK / unique slot';
END $$;

-- ===========================================================================
-- 4. Colonnes immuables & updated_at
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000007a1';
  v_before timestamptz;
  v_after timestamptz;
BEGIN
  PERFORM pg_temp.expect_error('[4] id immutable', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET id = 'aaaaaaaa-0000-4000-8000-0000000000ff' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005'$q$, '42501');
  PERFORM pg_temp.expect_error('[4] user_id immutable (to Bob)', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET user_id = '00000000-0000-4000-8000-0000000007b1' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005'$q$, '42501');
  PERFORM pg_temp.expect_error('[4] card_id immutable', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET card_id = 't7-set-a-001' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005'$q$, '42501');
  PERFORM pg_temp.expect_error('[4] created_at immutable', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET created_at = now() - interval '1 year' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005'$q$, '42501');
  -- Même `service_role` (BYPASSRLS) ne contourne pas le trigger (pas de SECURITY DEFINER, aucune exception).
  PERFORM pg_temp.expect_error('[4] card_id immutable (service_role)', 'service_role', NULL,
    $q$UPDATE public.wishlist_items SET card_id = 't7-set-a-001' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005'$q$, '42501');

  -- updated_at avance à chaque UPDATE (valeur initiale placée dans le passé).
  -- (le trigger `set_updated_at` est suspendu le temps de reculer la valeur de départ).
  ALTER TABLE public.wishlist_items DISABLE TRIGGER wishlist_items_set_updated_at;
  UPDATE public.wishlist_items SET updated_at = now() - interval '1 day'
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005';
  ALTER TABLE public.wishlist_items ENABLE TRIGGER wishlist_items_set_updated_at;
  SELECT updated_at INTO v_before FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005';
  PERFORM pg_temp.expect_rows('[4] mutable column update', 'authenticated', c_a,
    $q$UPDATE public.wishlist_items SET priority = 'high' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005'$q$, 1);
  SELECT updated_at INTO v_after FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000005';
  IF v_after <= v_before THEN
    RAISE EXCEPTION '[4] updated_at must advance on UPDATE (before %, after %)', v_before, v_after;
  END IF;
  RAISE NOTICE 'ok [4] immutable columns & updated_at';
END $$;

-- ===========================================================================
-- 5. Isolation RLS cross-user (Alice ≠ Bob)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000007a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000007b1';
BEGIN
  -- Chacun ne voit que ses lignes.
  PERFORM pg_temp.expect_rows('[5] alice sees only hers', 'authenticated', c_a,
    $q$SELECT * FROM public.wishlist_items WHERE user_id = '00000000-0000-4000-8000-0000000007b1'$q$, 0);
  PERFORM pg_temp.expect_rows('[5] alice total', 'authenticated', c_a,
    $q$SELECT * FROM public.wishlist_items$q$, 4);
  PERFORM pg_temp.expect_rows('[5] bob sees only his', 'authenticated', c_b,
    $q$SELECT * FROM public.wishlist_items$q$, 1);
  PERFORM pg_temp.expect_rows('[5] bob cannot read alice row by id', 'authenticated', c_b,
    $q$SELECT * FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 0);

  -- UPDATE / DELETE d'une ligne d'autrui : 0 ligne touchée, aucune erreur.
  PERFORM pg_temp.expect_rows('[5] bob cannot update alice row', 'authenticated', c_b,
    $q$UPDATE public.wishlist_items SET priority = 'high' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[5] bob cannot delete alice row', 'authenticated', c_b,
    $q$DELETE FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[5] alice rows untouched', 'authenticated', c_a,
    $q$SELECT * FROM public.wishlist_items WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001' AND priority = 'high'$q$, 1);

  -- INSERT au nom d'autrui : refusé par WITH CHECK (42501).
  PERFORM pg_temp.expect_error('[5] bob cannot insert for alice', 'authenticated', c_b, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, language) VALUES (%L, 't7-set-a-002', 'JP')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[5] alice cannot insert for bob', 'authenticated', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, language) VALUES (%L, 't7-set-a-002', 'JP')$q$, c_b), '42501');

  -- Sans claims JWT (`sub` absent) : `auth.uid()` est NULL, rien n'est visible ni insérable.
  PERFORM pg_temp.expect_rows('[5] authenticated without sub sees nothing', 'authenticated', NULL,
    $q$SELECT * FROM public.wishlist_items$q$, 0);
  PERFORM pg_temp.expect_error('[5] authenticated without sub cannot insert', 'authenticated', NULL, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id, language) VALUES (%L, 't7-set-a-002', 'ZH')$q$, c_a), '42501');
  RAISE NOTICE 'ok [5] cross-user RLS isolation';
END $$;

-- ===========================================================================
-- 6. `anon` : aucun accès (droits retirés, aucune policy)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000007a1';
BEGIN
  PERFORM pg_temp.expect_error('[6] anon select', 'anon', NULL,
    $q$SELECT * FROM public.wishlist_items$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select with forged sub', 'anon', c_a,
    $q$SELECT * FROM public.wishlist_items$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon insert', 'anon', c_a, format(
    $q$INSERT INTO public.wishlist_items (user_id, card_id) VALUES (%L, 't7-set-a-002')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[6] anon update', 'anon', c_a,
    $q$UPDATE public.wishlist_items SET priority = 'high'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon delete', 'anon', c_a,
    $q$DELETE FROM public.wishlist_items$q$, '42501');
  RAISE NOTICE 'ok [6] anon denied';
END $$;

-- ===========================================================================
-- 7. `service_role` : accès complet (cron de prix, export)
-- ===========================================================================
DO $$
BEGIN
  PERFORM pg_temp.expect_rows('[7] service_role reads all users', 'service_role', NULL,
    $q$SELECT * FROM public.wishlist_items WHERE user_id IN
         ('00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-0000000007b1')$q$, 5);
  PERFORM pg_temp.expect_rows('[7] service_role distinct cards (price cron)', 'service_role', NULL,
    $q$SELECT DISTINCT card_id FROM public.wishlist_items WHERE user_id IN
         ('00000000-0000-4000-8000-0000000007a1', '00000000-0000-4000-8000-0000000007b1')$q$, 2);
  PERFORM pg_temp.expect_rows('[7] service_role insert', 'service_role', NULL,
    $q$INSERT INTO public.wishlist_items (id, user_id, card_id, language)
       VALUES ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000007b1', 't7-set-a-002', 'EN')$q$, 1);
  PERFORM pg_temp.expect_rows('[7] service_role delete', 'service_role', NULL,
    $q$DELETE FROM public.wishlist_items WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002'$q$, 1);
  RAISE NOTICE 'ok [7] service_role full access';
END $$;

-- ===========================================================================
-- 8. Cascades : suppression d'un utilisateur / d'une carte du catalogue
-- ===========================================================================
DO $$
BEGIN
  DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000007b1';
  IF EXISTS (SELECT 1 FROM public.wishlist_items WHERE user_id = '00000000-0000-4000-8000-0000000007b1') THEN
    RAISE EXCEPTION '[8] deleting a user must cascade to wishlist_items';
  END IF;
  IF (SELECT count(*) FROM public.wishlist_items WHERE user_id = '00000000-0000-4000-8000-0000000007a1') <> 4 THEN
    RAISE EXCEPTION '[8] deleting bob must not touch alice wishlist';
  END IF;

  DELETE FROM public.catalog_cards WHERE id = 't7-set-a-002';
  IF EXISTS (SELECT 1 FROM public.wishlist_items WHERE card_id = 't7-set-a-002') THEN
    RAISE EXCEPTION '[8] deleting a catalog card must cascade to wishlist_items';
  END IF;
  IF (SELECT count(*) FROM public.wishlist_items WHERE user_id = '00000000-0000-4000-8000-0000000007a1') <> 3 THEN
    RAISE EXCEPTION '[8] deleting a catalog card must only remove its own wishlist rows';
  END IF;
  RAISE NOTICE 'ok [8] ON DELETE CASCADE (profiles, catalog_cards)';
END $$;

ROLLBACK;

\echo ALL TESTS PASSED — 006_wishlist_items
