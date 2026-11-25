-- supabase/tests/008_share_links.test.sql
-- Tests d'intégration SQL de supabase/migrations/008_share_links.sql (issue #31) :
-- table `share_links` (RLS, contraintes, triggers) et fonction `get_shared_binder(token)`
-- (projection stricte, ANTI-FUITE, révocation immédiate).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres` + GoTrue + storage-api),
-- APRÈS les migrations 001, 002 et 004 puis 008 (003, 005, 006 et 007 ne sont PAS requises),
-- en tant que superuser (`supabase_admin`) :
--
--   for f in 001_profiles_and_auth 002_catalog 004_binders_and_copies 008_share_links; do
--     psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/$f.sql
--   done
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/tests/008_share_links.test.sql
--
-- Le script change de rôle (SET ROLE) pour reproduire fidèlement PostgREST (`authenticated` /
-- `anon` / `service_role` + claims JWT -> `auth.uid()`). Une assertion qui échoue lève une
-- exception et arrête psql (code retour != 0).
--
-- Tout se déroule dans UNE transaction annulée par `ROLLBACK` : aucune donnée de test ne
-- subsiste, le script est rejouable.

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

-- Appelle `public.get_shared_binder(p_token)` sous `p_role` (anon par défaut côté route
-- publique) et renvoie le jsonb produit.
CREATE FUNCTION pg_temp.shared_as(p_role text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  v_payload := public.get_shared_binder(p_token);
  RESET ROLE;
  RETURN v_payload;
END;
$$;

-- Jetons de test (43 caractères base64url), un par lien.
CREATE FUNCTION pg_temp.tok(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_name
    WHEN 'a'   THEN rpad('t9-alice-set-binder-', 43, 'A')
    WHEN 'c'   THEN rpad('t9-alice-custom-', 43, 'C')
    WHEN 'b'   THEN rpad('t9-bob-set-binder-', 43, 'B')
    WHEN 'old' THEN rpad('t9-alice-set-old-', 43, 'O')
  END
$$;

-- Les clés d'un objet jsonb, triées, en texte (`a,b,c`).
CREATE FUNCTION pg_temp.keys_of(p_obj jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(p_obj) AS k
$$;

-- ---------------------------------------------------------------------------
-- Purge préalable (données résiduelles d'un run interrompu avant la transaction)
-- ---------------------------------------------------------------------------
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%.t9@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000009%';
DELETE FROM public.allowed_users WHERE email LIKE '%.t9@pokevault.test';
DELETE FROM public.catalog_cards WHERE id LIKE 't9-%';
DELETE FROM public.catalog_sets WHERE id LIKE 't9-%';
DELETE FROM public.catalog_series WHERE id LIKE 't9-%';

-- ===========================================================================
-- 0. Structure : RLS, droits, policies, index, triggers, fonctions
-- ===========================================================================
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('public.share_links') IS NULL THEN
    RAISE EXCEPTION '[0] public.share_links is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.share_links'::regclass AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '[0] RLS must be ENABLED and FORCED on public.share_links';
  END IF;

  -- Droits : ZÉRO accès pour PUBLIC / anon ; CRUD pour authenticated et service_role.
  IF has_table_privilege('anon', 'public.share_links', 'SELECT')
     OR has_table_privilege('anon', 'public.share_links', 'INSERT')
     OR has_table_privilege('anon', 'public.share_links', 'UPDATE')
     OR has_table_privilege('anon', 'public.share_links', 'DELETE')
     OR has_table_privilege('anon', 'public.share_links', 'REFERENCES')
     OR has_table_privilege('public', 'public.share_links', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.share_links', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.share_links', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.share_links', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.share_links', 'DELETE')
     OR has_table_privilege('authenticated', 'public.share_links', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.share_links', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.share_links', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.share_links', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.share_links', 'DELETE') THEN
    RAISE EXCEPTION '[0] unexpected base privileges on public.share_links';
  END IF;

  -- `anon` n'a aucun droit direct sur les tables privées : seul get_shared_binder lui ouvre l'accès.
  IF has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR has_table_privilege('anon', 'public.binders', 'SELECT')
     OR has_table_privilege('anon', 'public.binder_cards', 'SELECT')
     OR has_table_privilege('anon', 'public.user_card_copies', 'SELECT') THEN
    RAISE EXCEPTION '[0] anon must have no SELECT on private tables';
  END IF;

  -- 4 policies `authenticated` (une par commande) + 1 policy `service_role`, aucune autre.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'share_links' AND roles = '{authenticated}') <> 4
     OR (SELECT count(DISTINCT cmd) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'share_links' AND roles = '{authenticated}') <> 4
     OR (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'share_links' AND roles = '{service_role}') <> 1
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'share_links') <> 5 THEN
    RAISE EXCEPTION '[0] public.share_links must have 4 authenticated policies (one per command) + 1 service_role policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'share_links'
                AND roles && ARRAY['anon', 'public']::name[]) THEN
    RAISE EXCEPTION '[0] no policy may target anon / PUBLIC';
  END IF;

  -- Unicité du jeton.
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.share_links'::regclass AND c.contype = 'u';
  IF v_def IS DISTINCT FROM 'UNIQUE (token)' THEN
    RAISE EXCEPTION '[0] share_links.token must be UNIQUE, got %', v_def;
  END IF;

  -- Index exigés.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_share_links_user'
                  AND indexdef LIKE '%(user_id, created_at DESC)') THEN
    RAISE EXCEPTION '[0] missing index idx_share_links_user (user_id, created_at DESC)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_share_links_binder_active'
                  AND indexdef LIKE '%(binder_id)%' AND indexdef LIKE '%is_active = true%' AND indexdef LIKE '%revoked_at IS NULL%') THEN
    RAISE EXCEPTION '[0] missing partial index idx_share_links_binder_active (binder_id) WHERE is_active AND revoked_at IS NULL';
  END IF;

  -- Fonctions de trigger : search_path verrouillé, pas de SECURITY DEFINER, non exécutables par les rôles API.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.enforce_share_link_binder_owner()'::regprocedure
       AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.protect_share_link_immutable_columns()'::regprocedure
       AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION '[0] trigger functions must be SECURITY INVOKER with search_path = ''''';
  END IF;
  IF has_function_privilege('anon', 'public.enforce_share_link_binder_owner()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.protect_share_link_immutable_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION '[0] trigger functions must not be executable by anon/authenticated';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.share_links'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION '[0] public.share_links must carry exactly 2 triggers (binder owner + immutable columns)';
  END IF;

  -- get_shared_binder : SECURITY DEFINER, STABLE, search_path verrouillé, exécutable par anon.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.get_shared_binder(text)'::regprocedure
       AND p.prosecdef AND p.provolatile = 's'
       AND p.prorettype = 'jsonb'::regtype
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION '[0] get_shared_binder must be STABLE SECURITY DEFINER returning jsonb with search_path = pg_catalog, public';
  END IF;
  IF has_function_privilege('public', 'public.get_shared_binder(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_shared_binder(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_shared_binder(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_shared_binder(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '[0] get_shared_binder must be executable by anon, authenticated and service_role only';
  END IF;

  -- get_shared_binder_cover_path : SECURITY DEFINER, service_role UNIQUEMENT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.get_shared_binder_cover_path(text)'::regprocedure
       AND p.prosecdef AND p.prorettype = 'text'::regtype
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION '[0] get_shared_binder_cover_path must be SECURITY DEFINER returning text with search_path = pg_catalog, public';
  END IF;
  IF has_function_privilege('public', 'public.get_shared_binder_cover_path(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_shared_binder_cover_path(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_shared_binder_cover_path(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_shared_binder_cover_path(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '[0] get_shared_binder_cover_path must be executable by service_role only';
  END IF;
  RAISE NOTICE 'ok [0] RLS enabled+forced, grants, policies, indexes, triggers, function ACLs';
END $$;

-- ===========================================================================
-- 1. Fixtures : Alice (données sensibles partout), Bob, mini catalogue
-- ===========================================================================
INSERT INTO public.allowed_users (email, note) VALUES
  ('alice.t9@pokevault.test', 'test T9.1 A'),
  ('bob.t9@pokevault.test',   'test T9.1 B');

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000009a1', 'alice.t9@pokevault.test', '{"full_name": "Alice T9"}'),
  ('00000000-0000-4000-8000-0000000009b1', 'bob.t9@pokevault.test',   '{"full_name": "Bob T9"}');

-- Alice : nom public + identifiants Discord (strictement privés).
UPDATE public.profiles
   SET display_name        = 'Alice Collectionneuse',
       avatar_initials     = 'AC',
       discord_user_id     = '987654321098765432',
       discord_webhook_url = 'https://discord.com/api/webhooks/123456/SECRETWEBHOOKTOKEN'
 WHERE id = '00000000-0000-4000-8000-0000000009a1';

INSERT INTO public.catalog_series (id, name_fr) VALUES ('t9-sv', 'Série de test T9');
INSERT INTO public.catalog_sets (id, series_id, code, name_fr, logo_url, official_count, total_count) VALUES
  ('t9-set-a', 't9-sv', 'T9A', 'Extension Alpha', 'https://assets.test/t9-set-a/logo', 3, 4),
  ('t9-set-b', 't9-sv', 'T9B', 'Extension Beta',  'https://assets.test/t9-set-b/logo', 1, 1);
INSERT INTO public.catalog_cards (id, set_id, local_id, local_id_numeric, name_fr, rarity, holo_effect, image_base_url) VALUES
  ('t9-set-a-001', 't9-set-a', '001', 1,    'Pikachu Alpha',  'Commune',   'none',    'https://assets.test/t9-set-a/001'),
  ('t9-set-a-002', 't9-set-a', '002', 2,    'Salamèche Alpha', 'Peu commune', 'holo',  'https://assets.test/t9-set-a/002'),
  ('t9-set-a-003', 't9-set-a', '003', 3,    'Carapuce Alpha', 'Rare',       'reverse', 'https://assets.test/t9-set-a/003'),
  ('t9-set-a-sv1', 't9-set-a', 'SV1', NULL, 'Mew Secret Alpha', 'Secrète',  'sir',     'https://assets.test/t9-set-a/sv1'),
  ('t9-set-b-001', 't9-set-b', '001', 1,    'Dracaufeu Beta', 'Rare',       'ex',      'https://assets.test/t9-set-b/001');

-- Classeurs d'Alice :
--   b01 : classeur d'extension Alpha, cover uploadée  -> PARTAGÉ (lien 'a')
--   b02 : classeur d'extension Beta, titre secret     -> PRIVÉ (jamais partagé)
--   b03 : dossier perso                               -> PARTAGÉ (lien 'c')
-- Bob : b01 classeur d'extension Alpha (même set), PARTAGÉ (lien 'b').
INSERT INTO public.binders (id, user_id, kind, set_id, title, cover_type, cover_storage_path) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000009a1', 'set', 't9-set-a',
   'Classeur Alpha partagé', 'upload',
   '00000000-0000-4000-8000-0000000009a1/aaaaaaaa-0000-4000-8000-000000000b01.webp');
INSERT INTO public.binders (id, user_id, kind, set_id, title) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-0000000009a1', 'set', 't9-set-b', 'SECRET_OTHER_BINDER'),
  ('bbbbbbbb-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-0000000009b1', 'set', 't9-set-a', 'Classeur de Bob');
INSERT INTO public.binders (id, user_id, kind, set_id, title, cover_type, cover_card_id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000b03', '00000000-0000-4000-8000-0000000009a1', 'custom', NULL,
   'Dossier favoris', 'card', 't9-set-a-003');

INSERT INTO public.binder_cards (binder_id, card_id, position) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000b03', 't9-set-b-001', 1),
  ('aaaaaaaa-0000-4000-8000-000000000b03', 't9-set-a-001', 0),
  ('aaaaaaaa-0000-4000-8000-000000000b03', 't9-set-a-002', 2);

-- Exemplaires d'Alice : données privées partout (prix 99999, note secrète, grading, date).
INSERT INTO public.user_card_copies
  (user_id, card_id, language, variant, condition, quantity, purchase_price_cents, notes, acquired_at, grading_company, grading_score) VALUES
  ('00000000-0000-4000-8000-0000000009a1', 't9-set-a-001', 'FR', 'normal', 'NM', 2, 99999, 'SECRET_PRIVATE_NOTE', '2020-02-29', NULL, NULL),
  ('00000000-0000-4000-8000-0000000009a1', 't9-set-a-001', 'FR', 'normal', 'NM', 1, 88888, 'SECRET_GRADED_NOTE',  '2021-03-01', 'PSA', '10'),
  ('00000000-0000-4000-8000-0000000009a1', 't9-set-a-001', 'EN', 'holo',   'EX', 1, 77777, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000000009a1', 't9-set-a-003', 'FR', 'reverse', 'NM', 1, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-0000000009a1', 't9-set-b-001', 'FR', 'normal', 'NM', 5, 55555, 'SECRET_OTHER_BINDER_NOTE', NULL, NULL, NULL),
  -- Bob possède la carte 002 d'Alpha : ne doit JAMAIS apparaître dans le lien d'Alice.
  ('00000000-0000-4000-8000-0000000009b1', 't9-set-a-002', 'FR', 'normal', 'NM', 9, 66666, 'BOB_PRIVATE_NOTE', NULL, NULL, NULL);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN
        ('00000000-0000-4000-8000-0000000009a1', '00000000-0000-4000-8000-0000000009b1')) <> 2 THEN
    RAISE EXCEPTION '[1] fixtures: both profiles must exist';
  END IF;
  RAISE NOTICE 'ok [1] fixtures (Alice, Bob, catalogue t9-*)';
END $$;

-- ===========================================================================
-- 2. CRUD nominal & valeurs par défaut (Alice, rôle `authenticated`)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000009b1';
  l public.share_links;
BEGIN
  PERFORM pg_temp.expect_rows('[2] alice creates link a', 'authenticated', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b01', %L)$q$, c_a, pg_temp.tok('a')), 1);
  SELECT * INTO l FROM public.share_links WHERE token = pg_temp.tok('a');
  IF l.id IS NULL OR l.is_active IS NOT TRUE OR l.show_quantities IS NOT TRUE
     OR l.revoked_at IS NOT NULL OR l.created_at IS NULL THEN
    RAISE EXCEPTION '[2] unexpected defaults: %', row_to_json(l);
  END IF;

  PERFORM pg_temp.expect_rows('[2] alice creates link c (custom binder)', 'authenticated', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b03', %L)$q$, c_a, pg_temp.tok('c')), 1);
  PERFORM pg_temp.expect_rows('[2] bob creates link b', 'authenticated', c_b, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'bbbbbbbb-0000-4000-8000-000000000b01', %L)$q$, c_b, pg_temp.tok('b')), 1);
  PERFORM pg_temp.expect_rows('[2] alice reads her links', 'authenticated', c_a,
    $q$SELECT * FROM public.share_links$q$, 2);
  PERFORM pg_temp.expect_rows('[2] alice toggles show_quantities', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET show_quantities = false WHERE token = %L$q$, pg_temp.tok('a')), 1);
  PERFORM pg_temp.expect_rows('[2] alice toggles it back', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET show_quantities = true WHERE token = %L$q$, pg_temp.tok('a')), 1);
  RAISE NOTICE 'ok [2] CRUD nominal & defaults';
END $$;

-- ===========================================================================
-- 3. Contraintes : jeton, cohérence de révocation, unicité, propriété du classeur
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000009b1';
BEGIN
  -- Jeton : longueur 43..128 et alphabet base64url strict.
  PERFORM pg_temp.expect_error('[3] token too short (42)', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L)$q$, c_a, repeat('x', 42)), '23514');
  PERFORM pg_temp.expect_error('[3] token too long (129)', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L)$q$, c_a, repeat('x', 129)), '23514');
  PERFORM pg_temp.expect_error('[3] token with illegal char', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L)$q$, c_a, repeat('x', 42) || '+'), '23514');
  PERFORM pg_temp.expect_error('[3] token with space', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L)$q$, c_a, repeat('x', 42) || ' '), '23514');
  PERFORM pg_temp.expect_error('[3] null token', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', NULL)$q$, c_a), '23502');
  PERFORM pg_temp.expect_rows('[3] token 43 chars (min) accepted', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (id, user_id, binder_id, token, is_active, revoked_at)
       VALUES ('cccccccc-0000-4000-8000-000000000001', %L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L, false, now())$q$,
    c_a, repeat('m', 43)), 1);
  PERFORM pg_temp.expect_rows('[3] token 128 chars (max) accepted', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (id, user_id, binder_id, token, is_active, revoked_at)
       VALUES ('cccccccc-0000-4000-8000-000000000002', %L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L, false, now())$q$,
    c_a, repeat('M', 64) || repeat('-_', 32)), 1);
  PERFORM pg_temp.expect_error('[3] duplicate token', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b01', %L)$q$, c_a, pg_temp.tok('a')), '23505');

  -- Cohérence de révocation : actif ⇔ pas de revoked_at.
  PERFORM pg_temp.expect_error('[3] active with revoked_at', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token, is_active, revoked_at)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L, true, now())$q$, c_a, rpad('t9-bad-1', 43, 'z')), '23514');
  PERFORM pg_temp.expect_error('[3] inactive without revoked_at', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token, is_active)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L, false)$q$, c_a, rpad('t9-bad-2', 43, 'z')), '23514');
  PERFORM pg_temp.expect_error('[3] revoke by is_active only (no revoked_at)', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET is_active = false WHERE token = %L$q$, pg_temp.tok('a')), '23514');
  PERFORM pg_temp.expect_error('[3] revoked_at only (still active)', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET revoked_at = now() WHERE token = %L$q$, pg_temp.tok('a')), '23514');

  -- Propriété du classeur : on ne partage jamais le classeur d'autrui.
  PERFORM pg_temp.expect_error('[3] alice cannot share bob binder (RLS hides it)', 'authenticated', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'bbbbbbbb-0000-4000-8000-000000000b01', %L)$q$, c_a, rpad('t9-steal-1', 43, 'z')), '23503');
  PERFORM pg_temp.expect_error('[3] alice cannot share bob binder as bob', 'authenticated', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'bbbbbbbb-0000-4000-8000-000000000b01', %L)$q$, c_b, rpad('t9-steal-2', 43, 'z')), '23503');
  PERFORM pg_temp.expect_error('[3] alice cannot link her binder to bob', 'authenticated', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L)$q$, c_b, rpad('t9-steal-3', 43, 'z')), '42501');
  PERFORM pg_temp.expect_error('[3] service_role cannot bind alice to bob binder', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'bbbbbbbb-0000-4000-8000-000000000b01', %L)$q$, c_a, rpad('t9-steal-4', 43, 'z')), '42501');
  PERFORM pg_temp.expect_error('[3] unknown binder', 'authenticated', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-0000000000ff', %L)$q$, c_a, rpad('t9-steal-5', 43, 'z')), '23503');
  RAISE NOTICE 'ok [3] token CHECK / revocation CHECK / unique / binder ownership';
END $$;

-- ===========================================================================
-- 4. Colonnes immuables & révocation irréversible
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
BEGIN
  PERFORM pg_temp.expect_error('[4] id immutable', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET id = 'cccccccc-0000-4000-8000-0000000000ff' WHERE token = %L$q$, pg_temp.tok('a')), '42501');
  PERFORM pg_temp.expect_error('[4] user_id immutable (to Bob)', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET user_id = '00000000-0000-4000-8000-0000000009b1' WHERE token = %L$q$, pg_temp.tok('a')), '42501');
  PERFORM pg_temp.expect_error('[4] binder_id immutable', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET binder_id = 'aaaaaaaa-0000-4000-8000-000000000b02' WHERE token = %L$q$, pg_temp.tok('a')), '42501');
  PERFORM pg_temp.expect_error('[4] token immutable', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET token = %L WHERE token = %L$q$, rpad('t9-new-token', 43, 'n'), pg_temp.tok('a')), '42501');
  PERFORM pg_temp.expect_error('[4] created_at immutable', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET created_at = now() - interval '1 year' WHERE token = %L$q$, pg_temp.tok('a')), '42501');
  -- Même `service_role` (BYPASSRLS) ne contourne pas le trigger.
  PERFORM pg_temp.expect_error('[4] token immutable (service_role)', 'service_role', NULL, format(
    $q$UPDATE public.share_links SET token = %L WHERE token = %L$q$, rpad('t9-new-token', 43, 'n'), pg_temp.tok('a')), '42501');

  -- Révocation par le propriétaire : OK, puis irréversible.
  PERFORM pg_temp.expect_rows('[4] alice revokes an extra link', 'service_role', NULL, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b02', %L)$q$, c_a, pg_temp.tok('old')), 1);
  PERFORM pg_temp.expect_rows('[4] revoke', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET is_active = false, revoked_at = now() WHERE token = %L$q$, pg_temp.tok('old')), 1);
  PERFORM pg_temp.expect_error('[4] revocation is irreversible (reactivate)', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET is_active = true, revoked_at = NULL WHERE token = %L$q$, pg_temp.tok('old')), '42501');
  PERFORM pg_temp.expect_error('[4] revocation is irreversible (service_role)', 'service_role', NULL, format(
    $q$UPDATE public.share_links SET is_active = true, revoked_at = NULL WHERE token = %L$q$, pg_temp.tok('old')), '42501');
  PERFORM pg_temp.expect_rows('[4] show_quantities still editable on a revoked link', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET show_quantities = false WHERE token = %L$q$, pg_temp.tok('old')), 1);
  RAISE NOTICE 'ok [4] immutable columns & irreversible revocation';
END $$;

-- ===========================================================================
-- 5. Isolation RLS cross-user (Alice ≠ Bob)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000009b1';
BEGIN
  PERFORM pg_temp.expect_rows('[5] bob sees only his link', 'authenticated', c_b,
    $q$SELECT * FROM public.share_links$q$, 1);
  PERFORM pg_temp.expect_rows('[5] bob cannot read alice link by token', 'authenticated', c_b, format(
    $q$SELECT * FROM public.share_links WHERE token = %L$q$, pg_temp.tok('a')), 0);
  PERFORM pg_temp.expect_rows('[5] bob cannot update alice link', 'authenticated', c_b, format(
    $q$UPDATE public.share_links SET show_quantities = false WHERE token = %L$q$, pg_temp.tok('a')), 0);
  PERFORM pg_temp.expect_rows('[5] bob cannot revoke alice link', 'authenticated', c_b, format(
    $q$UPDATE public.share_links SET is_active = false, revoked_at = now() WHERE token = %L$q$, pg_temp.tok('a')), 0);
  PERFORM pg_temp.expect_rows('[5] bob cannot delete alice link', 'authenticated', c_b, format(
    $q$DELETE FROM public.share_links WHERE token = %L$q$, pg_temp.tok('a')), 0);
  PERFORM pg_temp.expect_rows('[5] alice link untouched', 'authenticated', c_a, format(
    $q$SELECT * FROM public.share_links WHERE token = %L AND is_active AND show_quantities$q$, pg_temp.tok('a')), 1);
  PERFORM pg_temp.expect_rows('[5] authenticated without sub sees nothing', 'authenticated', NULL,
    $q$SELECT * FROM public.share_links$q$, 0);
  RAISE NOTICE 'ok [5] cross-user RLS isolation';
END $$;

-- ===========================================================================
-- 6. `anon` : AUCUN accès direct aux tables privées
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
BEGIN
  PERFORM pg_temp.expect_error('[6] anon select share_links', 'anon', NULL,
    $q$SELECT * FROM public.share_links$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select share_links with forged sub', 'anon', c_a,
    $q$SELECT * FROM public.share_links$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select token', 'anon', NULL,
    $q$SELECT token FROM public.share_links WHERE is_active$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon insert share_links', 'anon', c_a, format(
    $q$INSERT INTO public.share_links (user_id, binder_id, token)
       VALUES (%L, 'aaaaaaaa-0000-4000-8000-000000000b01', %L)$q$, c_a, rpad('t9-anon-1', 43, 'z')), '42501');
  PERFORM pg_temp.expect_error('[6] anon update share_links', 'anon', c_a,
    $q$UPDATE public.share_links SET is_active = true$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon delete share_links', 'anon', c_a,
    $q$DELETE FROM public.share_links$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select binders', 'anon', NULL,
    $q$SELECT * FROM public.binders$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select binder_cards', 'anon', NULL,
    $q$SELECT * FROM public.binder_cards$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select user_card_copies', 'anon', NULL,
    $q$SELECT * FROM public.user_card_copies$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select profiles', 'anon', NULL,
    $q$SELECT * FROM public.profiles$q$, '42501');
  PERFORM pg_temp.expect_error('[6] anon select profiles (forged sub)', 'anon', c_a,
    $q$SELECT discord_webhook_url FROM public.profiles$q$, '42501');
  -- La fonction interne de cover n'est pas appelable par anon / authenticated.
  PERFORM pg_temp.expect_error('[6] anon cannot call cover path fn', 'anon', NULL, format(
    $q$SELECT public.get_shared_binder_cover_path(%L)$q$, pg_temp.tok('a')), '42501');
  PERFORM pg_temp.expect_error('[6] authenticated cannot call cover path fn', 'authenticated', c_a, format(
    $q$SELECT public.get_shared_binder_cover_path(%L)$q$, pg_temp.tok('a')), '42501');
  RAISE NOTICE 'ok [6] anon denied on every private table';
END $$;

-- ===========================================================================
-- 7. `get_shared_binder` : projection stricte & ANTI-FUITE (rôle `anon`)
-- ===========================================================================
DO $$
DECLARE
  v        jsonb := pg_temp.shared_as('anon', pg_temp.tok('a'));
  v_text   text;
  v_forbidden text[] := ARRAY[
    -- identité & secrets du propriétaire
    'alice.t9', '@pokevault', 'pokevault.test',
    '00000000-0000-4000-8000-0000000009a1', '0000000009a1', '0000000009b1',
    'user_id', 'userid', 'email',
    -- Discord
    'discord', '987654321098765432', 'SECRETWEBHOOKTOKEN', 'webhook',
    -- données privées des exemplaires
    '99999', '88888', '77777', '55555', '66666', 'purchase', 'notes', 'SECRET_PRIVATE_NOTE',
    'SECRET_GRADED_NOTE', 'BOB_PRIVATE_NOTE', 'acquired', '2020-02-29', 'grading', 'PSA',
    'condition',
    -- chemin Storage de la cover (embarque le user_id)
    'storage', 'cover_storage_path', '.webp',
    -- autre classeur d'Alice & classeur de Bob
    'SECRET_OTHER_BINDER', 'Dracaufeu Beta', 't9-set-b', 'aaaaaaaa-0000-4000-8000-000000000b02',
    'Classeur de Bob', 'bbbbbbbb-0000-4000-8000-000000000b01',
    -- autres tables privées
    'wishlist', 'price_alert', 'alert'
  ];
  v_word   text;
  v_card   jsonb;
  v_copy   jsonb;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION '[7] get_shared_binder returned NULL for an active link';
  END IF;
  v_text := lower(v::text);

  -- 7.1 Aucune occurrence d'une donnée privée (valeurs ET noms de clés).
  FOREACH v_word IN ARRAY v_forbidden LOOP
    IF position(lower(v_word) IN v_text) > 0 THEN
      RAISE EXCEPTION '[7] LEAK: the public payload contains "%": %', v_word, v;
    END IF;
  END LOOP;

  -- 7.2 Forme exacte : aucune clé en trop (liste blanche).
  IF pg_temp.keys_of(v) <> 'binder,cards,owner' THEN
    RAISE EXCEPTION '[7] unexpected top-level keys: %', pg_temp.keys_of(v);
  END IF;
  IF pg_temp.keys_of(v -> 'owner') <> 'avatarInitials,displayName' THEN
    RAISE EXCEPTION '[7] unexpected owner keys: %', pg_temp.keys_of(v -> 'owner');
  END IF;
  IF pg_temp.keys_of(v -> 'binder') <>
     'coverCardImageUrl,coverLogoUrl,coverType,hasUploadedCover,id,kind,ownedCount,setCode,setId,setName,showQuantities,title,totalCards' THEN
    RAISE EXCEPTION '[7] unexpected binder keys: %', pg_temp.keys_of(v -> 'binder');
  END IF;
  FOR v_card IN SELECT jsonb_array_elements(v -> 'cards') LOOP
    IF pg_temp.keys_of(v_card) <>
       'cardId,copies,holoEffect,imageBaseUrl,localId,localIdNumeric,nameFr,owned,quantity,rarity,setCode' THEN
      RAISE EXCEPTION '[7] unexpected card keys: %', pg_temp.keys_of(v_card);
    END IF;
    FOR v_copy IN SELECT jsonb_array_elements(v_card -> 'copies') LOOP
      IF pg_temp.keys_of(v_copy) <> 'language,quantity,variant' THEN
        RAISE EXCEPTION '[7] unexpected copy keys: %', pg_temp.keys_of(v_copy);
      END IF;
    END LOOP;
  END LOOP;

  -- 7.3 Contenu attendu : propriétaire, classeur, cartes (tri `local_id_numeric NULLS LAST`).
  IF v #>> '{owner,displayName}' <> 'Alice Collectionneuse' OR v #>> '{owner,avatarInitials}' <> 'AC' THEN
    RAISE EXCEPTION '[7] unexpected owner: %', v -> 'owner';
  END IF;
  IF v #>> '{binder,id}' <> 'aaaaaaaa-0000-4000-8000-000000000b01'
     OR v #>> '{binder,kind}' <> 'set'
     OR v #>> '{binder,title}' <> 'Classeur Alpha partagé'
     OR v #>> '{binder,setId}' <> 't9-set-a'
     OR v #>> '{binder,setCode}' <> 'T9A'
     OR v #>> '{binder,setName}' <> 'Extension Alpha'
     OR v #>> '{binder,coverType}' <> 'upload'
     OR v #>> '{binder,coverLogoUrl}' <> 'https://assets.test/t9-set-a/logo'
     OR v #> '{binder,coverCardImageUrl}' <> 'null'::jsonb
     OR (v #> '{binder,hasUploadedCover}') <> 'true'::jsonb
     OR (v #> '{binder,showQuantities}') <> 'true'::jsonb
     OR (v #>> '{binder,ownedCount}')::int <> 2
     OR (v #>> '{binder,totalCards}')::int <> 4 THEN
    RAISE EXCEPTION '[7] unexpected binder meta: %', v -> 'binder';
  END IF;
  IF (SELECT array_agg(c ->> 'cardId' ORDER BY ord) FROM jsonb_array_elements(v -> 'cards') WITH ORDINALITY AS t(c, ord))
     IS DISTINCT FROM ARRAY['t9-set-a-001', 't9-set-a-002', 't9-set-a-003', 't9-set-a-sv1'] THEN
    RAISE EXCEPTION '[7] unexpected cards order / content: %', v -> 'cards';
  END IF;
  IF (v -> 'cards' -> 0 ->> 'nameFr') <> 'Pikachu Alpha'
     OR (v -> 'cards' -> 0 ->> 'setCode') <> 'T9A'
     OR (v -> 'cards' -> 0 ->> 'rarity') <> 'Commune'
     OR (v -> 'cards' -> 0 ->> 'holoEffect') <> 'none'
     OR (v -> 'cards' -> 0 ->> 'imageBaseUrl') <> 'https://assets.test/t9-set-a/001'
     OR (v -> 'cards' -> 0 ->> 'localId') <> '001'
     OR (v -> 'cards' -> 0 ->> 'localIdNumeric')::int <> 1
     OR (v -> 'cards' -> 3 -> 'localIdNumeric') <> 'null'::jsonb THEN
    RAISE EXCEPTION '[7] unexpected card projection: %', v -> 'cards';
  END IF;

  -- Possédée : somme des quantités (2 + 1 gradée + 1 EN holo = 4), agrégée par (langue, variante).
  IF (v -> 'cards' -> 0 -> 'owned') <> 'true'::jsonb
     OR (v -> 'cards' -> 0 ->> 'quantity')::int <> 4
     OR (v -> 'cards' -> 0 -> 'copies') <>
        '[{"language":"EN","variant":"holo","quantity":1},{"language":"FR","variant":"normal","quantity":3}]'::jsonb THEN
    RAISE EXCEPTION '[7] unexpected copies for card 001: %', v -> 'cards' -> 0;
  END IF;
  -- Non possédée par Alice (Bob en possède 9 : jamais mélangé).
  IF (v -> 'cards' -> 1 -> 'owned') <> 'false'::jsonb
     OR (v -> 'cards' -> 1 ->> 'quantity')::int <> 0
     OR (v -> 'cards' -> 1 -> 'copies') <> '[]'::jsonb THEN
    RAISE EXCEPTION '[7] card 002 must be unowned for Alice (Bob data must not leak): %', v -> 'cards' -> 1;
  END IF;
  IF (v -> 'cards' -> 2 -> 'owned') <> 'true'::jsonb
     OR (v -> 'cards' -> 2 -> 'copies') <> '[{"language":"FR","variant":"reverse","quantity":1}]'::jsonb THEN
    RAISE EXCEPTION '[7] unexpected copies for card 003: %', v -> 'cards' -> 2;
  END IF;

  -- Les rôles authenticated / service_role obtiennent exactement la même projection.
  IF pg_temp.shared_as('authenticated', pg_temp.tok('a')) IS DISTINCT FROM v
     OR pg_temp.shared_as('service_role', pg_temp.tok('a')) IS DISTINCT FROM v THEN
    RAISE EXCEPTION '[7] payload must be identical for anon / authenticated / service_role';
  END IF;
  RAISE NOTICE 'ok [7] anti-leak projection (anon), strict key whitelist, content & order';
END $$;

-- ===========================================================================
-- 8. `show_quantities = false` masque les quantités (`quantity: null`)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
  v jsonb;
  v_card jsonb;
  v_copy jsonb;
BEGIN
  PERFORM pg_temp.expect_rows('[8] hide quantities', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET show_quantities = false WHERE token = %L$q$, pg_temp.tok('a')), 1);
  v := pg_temp.shared_as('anon', pg_temp.tok('a'));

  IF v IS NULL OR (v #> '{binder,showQuantities}') <> 'false'::jsonb THEN
    RAISE EXCEPTION '[8] binder.showQuantities must be false: %', v;
  END IF;
  FOR v_card IN SELECT jsonb_array_elements(v -> 'cards') LOOP
    IF v_card -> 'quantity' <> 'null'::jsonb THEN
      RAISE EXCEPTION '[8] card quantity must be null when show_quantities = false: %', v_card;
    END IF;
    FOR v_copy IN SELECT jsonb_array_elements(v_card -> 'copies') LOOP
      IF v_copy -> 'quantity' <> 'null'::jsonb THEN
        RAISE EXCEPTION '[8] copy quantity must be null when show_quantities = false: %', v_copy;
      END IF;
    END LOOP;
  END LOOP;
  -- Le fait de posséder la carte reste visible ; seules les quantités sont masquées.
  IF (v -> 'cards' -> 0 -> 'owned') <> 'true'::jsonb
     OR (v -> 'cards' -> 1 -> 'owned') <> 'false'::jsonb
     OR (v -> 'cards' -> 0 -> 'copies') <>
        '[{"language":"EN","variant":"holo","quantity":null},{"language":"FR","variant":"normal","quantity":null}]'::jsonb THEN
    RAISE EXCEPTION '[8] ownership must remain visible with hidden quantities: %', v -> 'cards';
  END IF;
  IF (v #>> '{binder,ownedCount}')::int <> 2 THEN
    RAISE EXCEPTION '[8] ownedCount must remain exposed: %', v -> 'binder';
  END IF;

  PERFORM pg_temp.expect_rows('[8] show quantities again', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET show_quantities = true WHERE token = %L$q$, pg_temp.tok('a')), 1);
  IF (pg_temp.shared_as('anon', pg_temp.tok('a')) -> 'cards' -> 0 ->> 'quantity')::int <> 4 THEN
    RAISE EXCEPTION '[8] quantities must be visible again';
  END IF;
  RAISE NOTICE 'ok [8] show_quantities = false hides every quantity';
END $$;

-- ===========================================================================
-- 9. Dossier perso : cartes dans l'ordre `position, added_at`, aucune autre carte
-- ===========================================================================
DO $$
DECLARE
  v jsonb := pg_temp.shared_as('anon', pg_temp.tok('c'));
  v_text text;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION '[9] custom binder link must resolve';
  END IF;
  v_text := lower(v::text);
  IF v #>> '{binder,kind}' <> 'custom'
     OR v #>> '{binder,title}' <> 'Dossier favoris'
     OR v #> '{binder,setId}' <> 'null'::jsonb
     OR v #> '{binder,setCode}' <> 'null'::jsonb
     OR v #>> '{binder,coverType}' <> 'card'
     OR v #>> '{binder,coverCardImageUrl}' <> 'https://assets.test/t9-set-a/003'
     OR (v #> '{binder,hasUploadedCover}') <> 'false'::jsonb
     OR (v #>> '{binder,totalCards}')::int <> 3
     OR (v #>> '{binder,ownedCount}')::int <> 2 THEN
    RAISE EXCEPTION '[9] unexpected custom binder meta: %', v -> 'binder';
  END IF;
  -- position 0 -> 001, position 1 -> b-001, position 2 -> 002.
  IF (SELECT array_agg(c ->> 'cardId' ORDER BY ord) FROM jsonb_array_elements(v -> 'cards') WITH ORDINALITY AS t(c, ord))
     IS DISTINCT FROM ARRAY['t9-set-a-001', 't9-set-b-001', 't9-set-a-002'] THEN
    RAISE EXCEPTION '[9] custom binder cards must follow position order: %', v -> 'cards';
  END IF;
  IF (v -> 'cards' -> 1 ->> 'setCode') <> 'T9B' OR (v -> 'cards' -> 1 ->> 'quantity')::int <> 5 THEN
    RAISE EXCEPTION '[9] a custom binder may span several sets: %', v -> 'cards' -> 1;
  END IF;
  -- Ni les cartes 003 / sv1 (hors dossier), ni le classeur partagé 'a', ni le titre secret.
  IF position('secret_other_binder' IN v_text) > 0
     OR position('classeur alpha' IN v_text) > 0
     OR position('99999' IN v_text) > 0 OR position('secret_' IN v_text) > 0 THEN
    RAISE EXCEPTION '[9] custom binder payload leaks foreign data: %', v;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'cards') c WHERE c ->> 'cardId' IN ('t9-set-a-003', 't9-set-a-sv1')) THEN
    RAISE EXCEPTION '[9] cards outside the custom binder must not be listed: %', v -> 'cards';
  END IF;
  RAISE NOTICE 'ok [9] custom binder projection & ordering';
END $$;

-- ===========================================================================
-- 10. Lien de Bob : un autre jeton ne révèle JAMAIS les données d'Alice
-- ===========================================================================
DO $$
DECLARE
  v jsonb := pg_temp.shared_as('anon', pg_temp.tok('b'));
  v_text text;
BEGIN
  IF v IS NULL OR v #>> '{owner,displayName}' = 'Alice Collectionneuse' THEN
    RAISE EXCEPTION '[10] bob link must expose bob only: %', v;
  END IF;
  v_text := lower(v::text);
  IF position('alice' IN v_text) > 0 OR position('99999' IN v_text) > 0
     OR position('secret_' IN v_text) > 0 OR position('0000000009a1' IN v_text) > 0 THEN
    RAISE EXCEPTION '[10] bob payload leaks alice data: %', v;
  END IF;
  -- Même set qu'Alice mais exemplaires de Bob : 002 x9, rien d'autre.
  IF (SELECT count(*) FROM jsonb_array_elements(v -> 'cards') c WHERE (c -> 'owned') = 'true'::jsonb) <> 1
     OR (v -> 'cards' -> 1 ->> 'quantity')::int <> 9
     OR (v -> 'cards' -> 0 ->> 'quantity')::int <> 0 THEN
    RAISE EXCEPTION '[10] bob payload must only contain bob copies: %', v -> 'cards';
  END IF;
  RAISE NOTICE 'ok [10] token isolation between owners';
END $$;

-- ===========================================================================
-- 11. Jetons invalides / inconnus / désactivés : toujours NULL, jamais d'erreur
-- ===========================================================================
DO $$
DECLARE
  v_token text;
BEGIN
  IF pg_temp.shared_as('anon', NULL) IS NOT NULL THEN
    RAISE EXCEPTION '[11] NULL token must return NULL';
  END IF;
  FOREACH v_token IN ARRAY ARRAY[
    '',
    'short',
    repeat('a', 42),
    repeat('A', 129),
    repeat('a', 42) || '+',
    repeat('a', 42) || '/',
    repeat('a', 42) || '=',
    repeat('a', 42) || ' ',
    repeat('a', 42) || E'\n',
    repeat('é', 43),
    rpad('t9-unknown-token-', 43, 'u'),            -- valide mais inconnu
    pg_temp.tok('a') || '''; select 1 --',          -- tentative d'injection
    '%',
    repeat('%', 43)
  ] LOOP
    IF pg_temp.shared_as('anon', v_token) IS NOT NULL THEN
      RAISE EXCEPTION '[11] invalid/unknown token must return NULL: "%"', v_token;
    END IF;
  END LOOP;
  -- Le jeton (déjà révoqué en [4]) du lien 'old' ne résout rien non plus.
  IF pg_temp.shared_as('anon', pg_temp.tok('old')) IS NOT NULL THEN
    RAISE EXCEPTION '[11] revoked token must return NULL';
  END IF;
  -- Casse : le jeton est sensible à la casse.
  IF pg_temp.shared_as('anon', lower(pg_temp.tok('b'))) IS NOT NULL
     AND lower(pg_temp.tok('b')) <> pg_temp.tok('b') THEN
    RAISE EXCEPTION '[11] tokens are case-sensitive';
  END IF;
  RAISE NOTICE 'ok [11] malformed / unknown / revoked tokens return NULL';
END $$;

-- ===========================================================================
-- 12. Cover : `get_shared_binder_cover_path` (service_role uniquement)
-- ===========================================================================
DO $$
DECLARE
  v_path text;
  v_tok_a text := pg_temp.tok('a');
  v_tok_c text := pg_temp.tok('c');
  v_unknown text := rpad('t9-unknown-token-', 43, 'u');
BEGIN
  -- Lien 'a' : cover uploadée -> chemin Storage (jamais renvoyé par get_shared_binder).
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE service_role;
  v_path := public.get_shared_binder_cover_path(v_tok_a);
  RESET ROLE;
  IF v_path IS DISTINCT FROM '00000000-0000-4000-8000-0000000009a1/aaaaaaaa-0000-4000-8000-000000000b01.webp' THEN
    RAISE EXCEPTION '[12] unexpected cover path for an upload cover: %', v_path;
  END IF;

  -- Lien 'c' : cover de type `card` -> NULL ; jetons invalides / inconnus -> NULL.
  SET LOCAL ROLE service_role;
  IF public.get_shared_binder_cover_path(v_tok_c) IS NOT NULL
     OR public.get_shared_binder_cover_path(NULL) IS NOT NULL
     OR public.get_shared_binder_cover_path('short') IS NOT NULL
     OR public.get_shared_binder_cover_path(v_unknown) IS NOT NULL THEN
    RESET ROLE;
    RAISE EXCEPTION '[12] cover path must be NULL for non-upload covers and invalid tokens';
  END IF;
  RESET ROLE;
  RAISE NOTICE 'ok [12] cover path (service_role only)';
END $$;

-- ===========================================================================
-- 13. RÉVOCATION immédiate : le lien devient NULL (404) dès `is_active = false`
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000009a1';
  v_path text;
  v_tok_a text := pg_temp.tok('a');
BEGIN
  IF pg_temp.shared_as('anon', pg_temp.tok('a')) IS NULL THEN
    RAISE EXCEPTION '[13] precondition: link a must be active';
  END IF;

  PERFORM pg_temp.expect_rows('[13] alice revokes link a', 'authenticated', c_a, format(
    $q$UPDATE public.share_links SET is_active = false, revoked_at = now() WHERE token = %L$q$, pg_temp.tok('a')), 1);

  IF pg_temp.shared_as('anon', pg_temp.tok('a')) IS NOT NULL
     OR pg_temp.shared_as('authenticated', pg_temp.tok('a')) IS NOT NULL
     OR pg_temp.shared_as('service_role', pg_temp.tok('a')) IS NOT NULL THEN
    RAISE EXCEPTION '[13] a revoked link must immediately return NULL';
  END IF;
  SET LOCAL ROLE service_role;
  v_path := public.get_shared_binder_cover_path(v_tok_a);
  RESET ROLE;
  IF v_path IS NOT NULL THEN
    RAISE EXCEPTION '[13] a revoked link must not expose its cover path';
  END IF;

  -- Les autres liens ne sont pas affectés.
  IF pg_temp.shared_as('anon', pg_temp.tok('c')) IS NULL OR pg_temp.shared_as('anon', pg_temp.tok('b')) IS NULL THEN
    RAISE EXCEPTION '[13] revoking link a must not affect other links';
  END IF;

  -- Suppression du classeur partagé ou du lien : NULL aussi (CASCADE).
  DELETE FROM public.share_links WHERE token = pg_temp.tok('c');
  IF pg_temp.shared_as('anon', pg_temp.tok('c')) IS NOT NULL THEN
    RAISE EXCEPTION '[13] a deleted link must return NULL';
  END IF;
  RAISE NOTICE 'ok [13] immediate revocation / deletion';
END $$;

-- ===========================================================================
-- 14. Cascades : suppression d'un classeur / d'un utilisateur
-- ===========================================================================
DO $$
BEGIN
  DELETE FROM public.binders WHERE id = 'bbbbbbbb-0000-4000-8000-000000000b01';
  IF EXISTS (SELECT 1 FROM public.share_links WHERE token = pg_temp.tok('b')) THEN
    RAISE EXCEPTION '[14] deleting a binder must cascade to its share_links';
  END IF;
  IF pg_temp.shared_as('anon', pg_temp.tok('b')) IS NOT NULL THEN
    RAISE EXCEPTION '[14] link of a deleted binder must return NULL';
  END IF;

  DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000009a1';
  IF EXISTS (SELECT 1 FROM public.share_links WHERE user_id = '00000000-0000-4000-8000-0000000009a1') THEN
    RAISE EXCEPTION '[14] deleting a user must cascade to share_links';
  END IF;
  RAISE NOTICE 'ok [14] ON DELETE CASCADE (binders, profiles)';
END $$;

ROLLBACK;

\echo ALL TESTS PASSED — 008_share_links
