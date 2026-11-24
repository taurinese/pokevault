-- supabase/tests/001_profiles_and_auth.test.sql
-- Tests d'intégration SQL de supabase/migrations/001_profiles_and_auth.sql (issue #6).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres` avec le schéma
-- `auth` créé par GoTrue — `auth.users`, `auth.uid()`), APRÈS la migration 001,
-- en tant que superuser (`supabase_admin`) :
--
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/migrations/001_profiles_and_auth.sql
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/tests/001_profiles_and_auth.test.sql
--
-- Le script change de rôle (SET ROLE) pour reproduire fidèlement :
--   * GoTrue          -> `supabase_auth_admin` (INSERT INTO auth.users) ;
--   * PostgREST (app) -> `authenticated` / `anon` + claims JWT (`auth.uid()`).
-- Une assertion qui échoue lève une exception et arrête psql (code retour != 0).
-- Les données de test (@pokevault.test) sont purgées avant et après l'exécution.
-- Pas de transaction englobante : `now()` doit pouvoir avancer entre deux UPDATE.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Helpers (schéma temporaire de la session, appelés en tant que superuser)
-- ---------------------------------------------------------------------------

-- Exécute `p_sql` sous `p_role` avec `p_sub` comme `sub` du JWT.
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

-- ---------------------------------------------------------------------------
-- Données de test (purge préalable : le script est rejouable)
-- ---------------------------------------------------------------------------

DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000000%';
DELETE FROM public.allowed_users WHERE email LIKE '%@pokevault.test';

-- ===========================================================================
-- 0. Structure : RLS activée + forcée, droits, fonctions de trigger
-- ===========================================================================
DO $$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['profiles', 'allowed_users'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = format('public.%I', v_tbl)::regclass AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '[0] RLS must be ENABLED and FORCED on public.%', v_tbl;
    END IF;
  END LOOP;

  -- Aucun droit résiduel pour anon / authenticated sur allowed_users.
  IF has_table_privilege('anon', 'public.allowed_users', 'SELECT')
     OR has_table_privilege('authenticated', 'public.allowed_users', 'SELECT')
     OR has_table_privilege('authenticated', 'public.allowed_users', 'INSERT') THEN
    RAISE EXCEPTION '[0] anon/authenticated must have no privilege on public.allowed_users';
  END IF;
  -- profiles : SELECT + UPDATE par colonne seulement pour authenticated, rien pour anon.
  IF has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     OR has_table_privilege('authenticated', 'public.profiles', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT')
     OR has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.profiles', 'theme', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'discord_user_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'UPDATE') THEN
    RAISE EXCEPTION '[0] unexpected table/column privileges on public.profiles';
  END IF;
  -- Fonctions de trigger non exécutables par les rôles API.
  IF has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.enforce_allowed_user()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_allowed_user()', 'EXECUTE') THEN
    RAISE EXCEPTION '[0] trigger functions must not be executable by anon/authenticated';
  END IF;
  RAISE NOTICE 'ok [0] RLS enabled+forced, grants and function privileges';
END $$;

-- Contraintes de allowed_users : e-mails normalisés uniquement.
DO $$
BEGIN
  IF pg_temp.sqlstate_as('supabase_admin', NULL, $q$INSERT INTO public.allowed_users (email) VALUES ('Not.Normalized@pokevault.test')$q$) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('supabase_admin', NULL, $q$INSERT INTO public.allowed_users (email) VALUES (' padded@pokevault.test')$q$) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('supabase_admin', NULL, $q$INSERT INTO public.allowed_users (email) VALUES ('no-at-sign')$q$) IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION '[0] allowed_users.email CHECK must reject non-normalized / malformed e-mails';
  END IF;
  RAISE NOTICE 'ok [0] allowed_users.email CHECK';
END $$;

-- ===========================================================================
-- 1. E-mail hors allowlist : INSERT INTO auth.users refusé (comme GoTrue)
-- ===========================================================================
DO $$
BEGIN
  IF pg_temp.sqlstate_as('supabase_auth_admin', NULL, $q$
       INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000f1', 'stranger@pokevault.test')
     $q$) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[1] unknown e-mail must be rejected with 42501';
  END IF;
  -- E-mail NULL (ex. utilisateur anonyme) : refusé aussi.
  IF pg_temp.sqlstate_as('supabase_auth_admin', NULL, $q$
       INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000f2', NULL)
     $q$) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[1] NULL e-mail must be rejected with 42501';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = 'stranger@pokevault.test')
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id IN
          ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2')) THEN
    RAISE EXCEPTION '[1] rejected sign-up must leave no auth.users / profiles row';
  END IF;
  -- E-mail dans l'allowlist mais explicitement non vérifié côté provider : refusé.
  INSERT INTO public.allowed_users (email) VALUES ('unverified@pokevault.test');
  IF pg_temp.sqlstate_as('supabase_auth_admin', NULL, $q$
       INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ('00000000-0000-4000-8000-0000000000f4', 'unverified@pokevault.test', '{"email_verified": false}')
     $q$) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[1] unverified provider e-mail must be rejected with 42501';
  END IF;
  DELETE FROM public.allowed_users WHERE email = 'unverified@pokevault.test';
  RAISE NOTICE 'ok [1] sign-up outside the allowlist or unverified rejected (42501)';
END $$;

-- ===========================================================================
-- 2. E-mail autorisé : INSERT réussi (casse/espaces ignorés) + profil créé
-- ===========================================================================
INSERT INTO public.allowed_users (email, note) VALUES
  ('alice.martin@pokevault.test', 'test A'),
  ('bob@pokevault.test',          'test B'),
  ('elodie@pokevault.test',       'unicode'),
  ('dave@pokevault.test',         'fallback metadata'),
  ('eve@pokevault.test',          'symbols only');

DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-00000000000a';
  c_b constant uuid := '00000000-0000-4000-8000-00000000000b';
  p public.profiles;
BEGIN
  -- A : e-mail avec majuscules et espaces, nom dans `full_name`.
  PERFORM pg_temp.rows_as('supabase_auth_admin', NULL, format(
    $q$INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES (%L, '  Alice.Martin@PokeVault.TEST ', '{"full_name": "Alice Martin"}')$q$, c_a));
  SELECT * INTO p FROM public.profiles WHERE id = c_a;
  IF NOT FOUND THEN
    RAISE EXCEPTION '[2] profile must be auto-created for an allowed e-mail';
  END IF;
  IF p.display_name <> 'Alice Martin' OR p.avatar_initials <> 'AM'
     OR p.theme <> 'dark' OR p.default_card_lang <> 'FR' OR p.default_card_condition <> 'NM'
     OR p.locale <> 'fr' OR p.currency <> 'EUR'
     OR p.push_enabled OR p.discord_alerts_enabled
     OR p.discord_user_id IS NOT NULL OR p.discord_webhook_url IS NOT NULL THEN
    RAISE EXCEPTION '[2] unexpected profile defaults/derivation: %', row_to_json(p);
  END IF;

  -- B : aucun metadata -> partie locale de l'e-mail.
  PERFORM pg_temp.rows_as('supabase_auth_admin', NULL, format(
    $q$INSERT INTO auth.users (id, email) VALUES (%L, 'bob@pokevault.test')$q$, c_b));
  SELECT * INTO p FROM public.profiles WHERE id = c_b;
  IF p.display_name <> 'bob' OR p.avatar_initials <> 'BO' THEN
    RAISE EXCEPTION '[2] e-mail local part fallback failed: %', row_to_json(p);
  END IF;
  RAISE NOTICE 'ok [2] allowed sign-up accepted, profile auto-created with defaults';
END $$;

-- Dérivation du nom / des initiales (priorité des métadonnées, unicode, symboles).
DO $$
DECLARE
  p public.profiles;
BEGIN
  PERFORM pg_temp.rows_as('supabase_auth_admin', NULL,
    $q$INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
       ('00000000-0000-4000-8000-00000000000c', 'elodie@pokevault.test', '{"name": "Élodie  Müller-Smith"}'),
       ('00000000-0000-4000-8000-00000000000d', 'dave@pokevault.test',
          '{"name": "   ", "user_name": "dave_the_trainer", "preferred_username": "ignored"}'),
       ('00000000-0000-4000-8000-00000000000e', 'eve@pokevault.test', '{"full_name": "🔥🔥"}')$q$);

  SELECT * INTO p FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000c';
  IF p.display_name <> 'Élodie  Müller-Smith' OR p.avatar_initials <> 'ÉM' THEN
    RAISE EXCEPTION '[2] unicode initials failed: %', row_to_json(p);
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000d';
  IF p.display_name <> 'dave_the_trainer' OR p.avatar_initials <> 'DT' THEN
    RAISE EXCEPTION '[2] metadata priority / blank skipping failed: %', row_to_json(p);
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000e';
  IF p.display_name <> '🔥🔥' OR p.avatar_initials <> 'CO' THEN
    RAISE EXCEPTION '[2] symbols-only name must fall back to CO initials: %', row_to_json(p);
  END IF;
  RAISE NOTICE 'ok [2] display_name / avatar_initials derivation';
END $$;

-- ===========================================================================
-- 3. Rôle `authenticated` : isolation par utilisateur (A ne voit / n'atteint pas B)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-00000000000a';
  c_b constant uuid := '00000000-0000-4000-8000-00000000000b';
BEGIN
  IF pg_temp.rows_as('authenticated', c_a, 'SELECT 1 FROM public.profiles') <> 1 THEN
    RAISE EXCEPTION '[3] user A must see exactly 1 profile (its own)';
  END IF;
  IF pg_temp.rows_as('authenticated', c_a, format('SELECT 1 FROM public.profiles WHERE id = %L', c_a)) <> 1 THEN
    RAISE EXCEPTION '[3] user A must see its own profile';
  END IF;
  IF pg_temp.rows_as('authenticated', c_a, format('SELECT 1 FROM public.profiles WHERE id = %L', c_b)) <> 0 THEN
    RAISE EXCEPTION '[3] user A must NOT see user B profile';
  END IF;
  -- Sans `sub` (JWT absent) : rien de visible.
  IF pg_temp.rows_as('authenticated', NULL, 'SELECT 1 FROM public.profiles') <> 0 THEN
    RAISE EXCEPTION '[3] authenticated without sub must see no profile';
  END IF;
  RAISE NOTICE 'ok [3] SELECT isolation';
END $$;

DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-00000000000a';
  c_b constant uuid := '00000000-0000-4000-8000-00000000000b';
  v_before timestamptz;
  p public.profiles;
BEGIN
  SELECT updated_at INTO v_before FROM public.profiles WHERE id = c_a;
  PERFORM pg_sleep(0.05);

  -- UPDATE de sa propre ligne : autorisé, updated_at avance.
  IF pg_temp.rows_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET theme = 'light', display_name = 'Alice M.' WHERE id = %L$q$, c_a)) <> 1 THEN
    RAISE EXCEPTION '[3] user A must be able to update its own profile';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = c_a;
  IF p.theme <> 'light' OR p.display_name <> 'Alice M.' OR p.updated_at <= v_before THEN
    RAISE EXCEPTION '[3] own update not applied or updated_at did not advance: %', row_to_json(p);
  END IF;
  IF p.created_at >= p.updated_at THEN
    RAISE EXCEPTION '[3] updated_at must be later than created_at';
  END IF;

  -- UPDATE de la ligne de B : 0 ligne, B intact.
  IF pg_temp.rows_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET theme = 'light', display_name = 'hacked' WHERE id = %L$q$, c_b)) <> 0 THEN
    RAISE EXCEPTION '[3] user A must NOT update user B profile';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = c_b;
  IF p.theme <> 'dark' OR p.display_name <> 'bob' THEN
    RAISE EXCEPTION '[3] user B profile was modified: %', row_to_json(p);
  END IF;

  -- Prise de contrôle / modification des colonnes protégées ou immuables : refusé.
  IF pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET id = %L WHERE id = %L$q$, c_b, c_a)) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET id = gen_random_uuid() WHERE id = %L$q$, c_a)) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET created_at = '2000-01-01' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET updated_at = '2000-01-01' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET discord_user_id = '999999999' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[3] id / created_at / updated_at / discord_user_id must not be writable by authenticated (42501)';
  END IF;
  -- Valeurs hors CHECK.
  IF pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET theme = 'purple' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET avatar_initials = 'ABC' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET display_name = '   ' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET display_name = E'\t\n' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET display_name = repeat('a', 51) WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET locale = 'xx' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514'
     OR pg_temp.sqlstate_as('authenticated', c_a,
       format($q$UPDATE public.profiles SET currency = 'BTC' WHERE id = %L$q$, c_a)) IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION '[3] CHECK constraints must reject invalid theme / initials / name / locale / currency (23514)';
  END IF;
  RAISE NOTICE 'ok [3] UPDATE own row only, updated_at trigger, immutable columns, CHECKs';
END $$;

DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-00000000000a';
BEGIN
  -- Pas d'INSERT ni de DELETE sur profiles pour authenticated.
  IF pg_temp.sqlstate_as('authenticated', c_a, format(
       $q$INSERT INTO public.profiles (id, display_name, avatar_initials) VALUES (gen_random_uuid(), 'x', 'X')$q$))
       IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a, format(
       $q$DELETE FROM public.profiles WHERE id = %L$q$, c_a)) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[3] authenticated must not INSERT/DELETE on profiles (42501)';
  END IF;
  -- allowed_users totalement inaccessible.
  IF pg_temp.sqlstate_as('authenticated', c_a, 'SELECT 1 FROM public.allowed_users') IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a,
          $q$INSERT INTO public.allowed_users (email) VALUES ('self-invite@pokevault.test')$q$) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a,
          $q$UPDATE public.allowed_users SET note = 'x'$q$) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('authenticated', c_a, 'DELETE FROM public.allowed_users') IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[3] authenticated must have no access to allowed_users (42501)';
  END IF;
  -- Fonctions de trigger non appelables.
  IF pg_temp.sqlstate_as('authenticated', c_a, 'SELECT public.handle_new_user()') IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[3] handle_new_user() must not be callable by authenticated (42501)';
  END IF;
  RAISE NOTICE 'ok [3] no INSERT/DELETE on profiles, no access to allowed_users';
END $$;

-- Webhook Discord : prévention SSRF par CHECK.
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-00000000000a';
  v_bad text;
  v_good text;
BEGIN
  FOREACH v_bad IN ARRAY ARRAY[
    'http://169.254.169.254/latest/meta-data/',
    'http://discord.com/api/webhooks/123/abc',
    'https://evil.com/api/webhooks/123/abc',
    'https://discord.com.evil.com/api/webhooks/123/abc',
    'https://evil.com/https://discord.com/api/webhooks/123/abc',
    'https://discord.com/api/webhooks/abc/def',
    'https://discord.com/api/webhooks/123/abc/../../x',
    E'https://discord.com/api/webhooks/123/abc\nhttp://169.254.169.254/'
  ] LOOP
    IF pg_temp.sqlstate_as('authenticated', c_a,
         format('UPDATE public.profiles SET discord_webhook_url = %L WHERE id = %L', v_bad, c_a))
         IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION '[3] SSRF webhook URL must be rejected by CHECK: %', v_bad;
    END IF;
  END LOOP;

  v_good := 'https://discord.com/api/webhooks/1234567890/aB-cD_ef123';
  IF pg_temp.rows_as('authenticated', c_a,
       format('UPDATE public.profiles SET discord_webhook_url = %L WHERE id = %L', v_good, c_a)) <> 1
     OR (SELECT discord_webhook_url FROM public.profiles WHERE id = c_a) <> v_good THEN
    RAISE EXCEPTION '[3] genuine Discord webhook URL must be accepted';
  END IF;
  IF pg_temp.rows_as('authenticated', c_a,
       format('UPDATE public.profiles SET discord_webhook_url = NULL WHERE id = %L', c_a)) <> 1 THEN
    RAISE EXCEPTION '[3] NULL webhook URL must be accepted';
  END IF;
  RAISE NOTICE 'ok [3] discord_webhook_url SSRF CHECK';
END $$;

-- ===========================================================================
-- 4. Rôle `anon` : aucun accès
-- ===========================================================================
DO $$
BEGIN
  IF pg_temp.sqlstate_as('anon', NULL, 'SELECT 1 FROM public.profiles') IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('anon', NULL, $q$UPDATE public.profiles SET theme = 'light'$q$) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('anon', NULL,
          $q$INSERT INTO public.profiles (id, display_name, avatar_initials) VALUES (gen_random_uuid(), 'x', 'X')$q$) IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('anon', NULL, 'DELETE FROM public.profiles') IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('anon', NULL, 'SELECT 1 FROM public.allowed_users') IS DISTINCT FROM '42501'
     OR pg_temp.sqlstate_as('anon', NULL,
          $q$INSERT INTO public.allowed_users (email) VALUES ('anon-invite@pokevault.test')$q$) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[4] anon must have no access to profiles / allowed_users (42501)';
  END IF;
  RAISE NOTICE 'ok [4] anon has no access';
END $$;

-- ===========================================================================
-- 5. service_role (worker) : accès complet malgré FORCE RLS (BYPASSRLS)
-- ===========================================================================
DO $$
BEGIN
  IF pg_temp.rows_as('service_role', NULL, 'SELECT 1 FROM public.profiles') < 5
     OR pg_temp.rows_as('service_role', NULL, 'SELECT 1 FROM public.allowed_users') < 5 THEN
    RAISE EXCEPTION '[5] service_role must read all profiles and allowed_users';
  END IF;
  PERFORM pg_temp.rows_as('service_role', NULL,
    $q$INSERT INTO public.allowed_users (email, note) VALUES ('srv-invite@pokevault.test', 'via service_role')$q$);
  PERFORM pg_temp.rows_as('service_role', NULL,
    $q$DELETE FROM public.allowed_users WHERE email = 'srv-invite@pokevault.test'$q$);
  RAISE NOTICE 'ok [5] service_role read/write access';
END $$;

-- ===========================================================================
-- 6. Retrait de l'allowlist : nouvelle inscription refusée ; suppression en cascade
-- ===========================================================================
DO $$
BEGIN
  DELETE FROM public.allowed_users WHERE email = 'bob@pokevault.test';
  -- Un utilisateur déjà créé n'est pas affecté, mais une réinscription serait refusée.
  IF pg_temp.sqlstate_as('supabase_auth_admin', NULL, $q$
       INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000000000f3', 'BOB@pokevault.test')
     $q$) IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[6] revoked invitation must block new sign-ups';
  END IF;

  DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000b';
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000b') THEN
    RAISE EXCEPTION '[6] deleting auth.users must cascade to profiles';
  END IF;
  RAISE NOTICE 'ok [6] revoked invitation blocks sign-up, ON DELETE CASCADE';
END $$;

-- ---------------------------------------------------------------------------
-- Nettoyage final
-- ---------------------------------------------------------------------------
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000000%';
DELETE FROM public.allowed_users WHERE email LIKE '%@pokevault.test';

\echo ALL TESTS PASSED — 001_profiles_and_auth
