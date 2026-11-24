-- supabase/tests/003_sync_discord_identity.test.sql
-- Tests d'intégration SQL de supabase/migrations/003_sync_discord_identity.sql (issue #8).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres` + schéma `auth`
-- créé par GoTrue), APRÈS les migrations 001 et 003, depuis la racine du dépôt
-- (le chemin du backfill est résolu par `\ir`, relatif à ce fichier), en superuser :
--
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/001_profiles_and_auth.sql
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/003_sync_discord_identity.sql
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/tests/003_sync_discord_identity.test.sql
--
-- Les écritures `auth.users` / `auth.identities` sont jouées sous le rôle
-- `supabase_auth_admin` (celui de GoTrue lors de `linkIdentity` / `unlinkIdentity`).
-- Une assertion qui échoue lève une exception et arrête psql (code retour != 0).
-- Les données de test (@pokevault.test) sont purgées avant et après l'exécution.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Exécute `p_sql` sous `p_role`, relance l'erreur éventuelle.
CREATE FUNCTION pg_temp.exec_as(p_role text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql;
  RESET ROLE;
END;
$$;

CREATE FUNCTION pg_temp.discord_id(p_user uuid)
RETURNS text
LANGUAGE sql
AS $$ SELECT discord_user_id FROM public.profiles WHERE id = p_user $$;

-- ---------------------------------------------------------------------------
-- Données de test (purge préalable : le script est rejouable)
-- ---------------------------------------------------------------------------

DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%@pokevault.test';
DELETE FROM public.allowed_users WHERE email LIKE '%@pokevault.test';

INSERT INTO public.allowed_users (email) VALUES ('alice@pokevault.test'), ('bob@pokevault.test');

-- Deux utilisateurs créés comme GoTrue (INSERT dans auth.users sous supabase_auth_admin).
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('00000000-0000-4000-8000-0000000000a1', 'alice@pokevault.test', '{"email_verified": true}'),
    ('00000000-0000-4000-8000-0000000000b2', 'bob@pokevault.test',   '{"email_verified": true}')
$q$);

-- ===========================================================================
-- 0. Structure : fonction SECURITY DEFINER, propriétaire, droits, trigger
-- ===========================================================================
DO $$
DECLARE
  v_proc pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO v_proc FROM pg_catalog.pg_proc WHERE oid = 'public.sync_discord_identity()'::regprocedure;

  IF NOT v_proc.prosecdef THEN
    RAISE EXCEPTION '[0] sync_discord_identity must be SECURITY DEFINER';
  END IF;
  IF pg_catalog.pg_get_userbyid(v_proc.proowner) <> 'postgres' THEN
    RAISE EXCEPTION '[0] sync_discord_identity must be owned by postgres, got %', pg_catalog.pg_get_userbyid(v_proc.proowner);
  END IF;
  IF v_proc.proconfig IS NULL OR NOT ('search_path=""' = ANY (v_proc.proconfig)) THEN
    RAISE EXCEPTION '[0] sync_discord_identity must pin search_path to empty, got %', v_proc.proconfig;
  END IF;
  IF has_function_privilege('anon', 'public.sync_discord_identity()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sync_discord_identity()', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(v_proc.proacl) AS a
       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE' -- grantee 0 = PUBLIC
     ) THEN
    RAISE EXCEPTION '[0] sync_discord_identity must not be executable by PUBLIC/anon/authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'auth.identities'::regclass
      AND tgname = 'on_auth_identity_changed'
      AND NOT tgisinternal
      AND tgenabled = 'O'
      -- AFTER (pas BEFORE) ; INSERT (4) + DELETE (8) + UPDATE (16) ; FOR EACH ROW (1)
      AND (tgtype & 2) = 0 AND (tgtype & 4) <> 0 AND (tgtype & 8) <> 0 AND (tgtype & 16) <> 0 AND (tgtype & 1) <> 0
  ) THEN
    RAISE EXCEPTION '[0] AFTER INSERT OR UPDATE OR DELETE row trigger on auth.identities is missing';
  END IF;
  RAISE NOTICE 'ok [0] function (SECURITY DEFINER, owner, search_path, grants) and trigger';
END $$;

-- ===========================================================================
-- 1. Identité Google : aucun effet sur discord_user_id
-- ===========================================================================
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES ('google-sub-alice', '00000000-0000-4000-8000-0000000000a1',
          '{"sub": "google-sub-alice", "email": "alice@pokevault.test"}', 'google')
$q$);
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS NOT NULL THEN
    RAISE EXCEPTION '[1] a Google identity must not set discord_user_id';
  END IF;
  RAISE NOTICE 'ok [1] Google identity leaves discord_user_id NULL';
END $$;

-- ===========================================================================
-- 2. linkIdentity Discord : INSERT -> discord_user_id synchronisé (provider_id)
-- ===========================================================================
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES ('111222333444555666', '00000000-0000-4000-8000-0000000000a1',
          '{"provider_id": "111222333444555666", "sub": "111222333444555666", "email": "alice@pokevault.test"}', 'discord')
$q$);
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS DISTINCT FROM '111222333444555666' THEN
    RAISE EXCEPTION '[2] discord_user_id must equal the Discord id after link, got %', pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1');
  END IF;
  -- L'autre utilisateur n'est pas affecté.
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000b2') IS NOT NULL THEN
    RAISE EXCEPTION '[2] other profiles must be untouched';
  END IF;
  RAISE NOTICE 'ok [2] Discord link sets discord_user_id (identity_data.provider_id)';
END $$;

-- ===========================================================================
-- 3. UPDATE de l'identité Discord : l'ID suit (changement de provider_id)
-- ===========================================================================
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  UPDATE auth.identities
     SET identity_data = '{"provider_id": "999888777666555444", "sub": "999888777666555444"}',
         provider_id = '999888777666555444'
   WHERE user_id = '00000000-0000-4000-8000-0000000000a1' AND provider = 'discord'
$q$);
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS DISTINCT FROM '999888777666555444' THEN
    RAISE EXCEPTION '[3] discord_user_id must follow identity updates, got %', pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1');
  END IF;
  -- Un UPDATE de Google ne touche pas à l'ID Discord.
  PERFORM pg_temp.exec_as('supabase_auth_admin', $q$
    UPDATE auth.identities SET last_sign_in_at = now()
     WHERE user_id = '00000000-0000-4000-8000-0000000000a1' AND provider = 'google'
  $q$);
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS DISTINCT FROM '999888777666555444' THEN
    RAISE EXCEPTION '[3] a Google identity update must not alter discord_user_id';
  END IF;
  RAISE NOTICE 'ok [3] identity update keeps discord_user_id in sync';
END $$;

-- ===========================================================================
-- 4. Repli de l'ID : `sub`, puis colonne `provider_id`
-- ===========================================================================
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  VALUES ('col-id-bob', '00000000-0000-4000-8000-0000000000b2', '{"email": "bob@pokevault.test", "provider_id": ""}', 'discord')
$q$);
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000b2') IS DISTINCT FROM 'col-id-bob' THEN
    RAISE EXCEPTION '[4] must fall back to auth.identities.provider_id, got %', pg_temp.discord_id('00000000-0000-4000-8000-0000000000b2');
  END IF;
  PERFORM pg_temp.exec_as('supabase_auth_admin', $q$
    UPDATE auth.identities SET identity_data = '{"sub": "sub-id-bob"}'
     WHERE user_id = '00000000-0000-4000-8000-0000000000b2' AND provider = 'discord'
  $q$);
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000b2') IS DISTINCT FROM 'sub-id-bob' THEN
    RAISE EXCEPTION '[4] must fall back to identity_data.sub, got %', pg_temp.discord_id('00000000-0000-4000-8000-0000000000b2');
  END IF;
  RAISE NOTICE 'ok [4] fallbacks provider_id -> sub -> column provider_id';
END $$;

-- ===========================================================================
-- 5. unlinkIdentity : DELETE de Google n'efface pas l'ID Discord ; DELETE de Discord l'efface
-- ===========================================================================
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  DELETE FROM auth.identities WHERE user_id = '00000000-0000-4000-8000-0000000000a1' AND provider = 'google'
$q$);
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS DISTINCT FROM '999888777666555444' THEN
    RAISE EXCEPTION '[5] deleting the Google identity must keep discord_user_id';
  END IF;
END $$;

SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  DELETE FROM auth.identities WHERE user_id = '00000000-0000-4000-8000-0000000000a1' AND provider = 'discord'
$q$);
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS NOT NULL THEN
    RAISE EXCEPTION '[5] deleting the Discord identity must reset discord_user_id to NULL, got %', pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1');
  END IF;
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000b2') IS DISTINCT FROM 'sub-id-bob' THEN
    RAISE EXCEPTION '[5] other profiles must be untouched by the delete';
  END IF;
  RAISE NOTICE 'ok [5] unlink Discord resets discord_user_id, unlink Google does not';
END $$;

-- ===========================================================================
-- 6. Suppression de l'utilisateur (cascade identities) : pas d'erreur, profil supprimé
-- ===========================================================================
SELECT pg_temp.exec_as('supabase_auth_admin', $q$
  DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000b2'
$q$);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000000b2')
     OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = '00000000-0000-4000-8000-0000000000b2') THEN
    RAISE EXCEPTION '[6] deleting the user must cascade to identities and profile without error';
  END IF;
  RAISE NOTICE 'ok [6] user deletion cascades cleanly';
END $$;

-- ===========================================================================
-- 7. Rattrapage : migration rejouée (idempotente) sur une identité Discord préexistante
-- ===========================================================================
ALTER TABLE auth.identities DISABLE TRIGGER on_auth_identity_changed;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
VALUES ('777000777000', '00000000-0000-4000-8000-0000000000a1',
        '{"provider_id": "777000777000"}', 'discord');
ALTER TABLE auth.identities ENABLE TRIGGER on_auth_identity_changed;
DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS NOT NULL THEN
    RAISE EXCEPTION '[7] precondition: trigger disabled, discord_user_id must still be NULL';
  END IF;
END $$;

\ir ../migrations/003_sync_discord_identity.sql

DO $$
BEGIN
  IF pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1') IS DISTINCT FROM '777000777000' THEN
    RAISE EXCEPTION '[7] migration backfill must sync pre-existing Discord identities, got %', pg_temp.discord_id('00000000-0000-4000-8000-0000000000a1');
  END IF;
  RAISE NOTICE 'ok [7] backfill + migration is re-runnable';
END $$;

-- ===========================================================================
-- 8. `discord_user_id` reste non modifiable par l'utilisateur (droit de colonne 001)
-- ===========================================================================
DO $$
DECLARE
  v_state text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.profiles SET discord_user_id = 'spoofed' WHERE id = '00000000-0000-4000-8000-0000000000a1';
    v_state := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION '[8] authenticated must not be able to write discord_user_id (got %)', v_state;
  END IF;
  RAISE NOTICE 'ok [8] discord_user_id is not client-writable';
END $$;

-- ---------------------------------------------------------------------------
-- Nettoyage
-- ---------------------------------------------------------------------------
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%@pokevault.test';
DELETE FROM public.allowed_users WHERE email LIKE '%@pokevault.test';
DO $$ BEGIN RAISE NOTICE 'all 003 tests passed'; END $$;
