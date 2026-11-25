-- supabase/tests/007_price_alerts.test.sql
-- Tests d'intégration SQL de supabase/migrations/007_price_alerts.sql (issue #28, T8.1).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres` avec le schéma `auth`),
-- APRÈS les migrations 001, 002 puis 007 (003–006 ne sont pas requises), en tant que
-- superuser (`supabase_admin`) :
--
--   for f in 001_profiles_and_auth 002_catalog 007_price_alerts; do
--     psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/$f.sql
--   done
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/tests/007_price_alerts.test.sql
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

-- Vérifie droits de table : `p_expected` = privilèges attendus (parmi SELECT/INSERT/UPDATE/DELETE)
-- pour `p_role` ; tous les autres doivent être refusés.
CREATE FUNCTION pg_temp.expect_privileges(p_table text, p_role text, p_expected text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_priv text;
BEGIN
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege(p_role, p_table, v_priv) IS DISTINCT FROM (v_priv = ANY (p_expected)) THEN
      RAISE EXCEPTION '[0] % on % for role %: expected %, got %',
        v_priv, p_table, p_role, (v_priv = ANY (p_expected)), has_table_privilege(p_role, p_table, v_priv);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Purge préalable (données résiduelles d'un run interrompu avant la transaction)
-- ---------------------------------------------------------------------------
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%.t8@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000008%';
DELETE FROM public.allowed_users WHERE email LIKE '%.t8@pokevault.test';
DELETE FROM public.catalog_cards WHERE id LIKE 't8-%';
DELETE FROM public.catalog_sets WHERE id LIKE 't8-%';
DELETE FROM public.catalog_series WHERE id LIKE 't8-%';

-- ===========================================================================
-- 0. Structure : RLS, droits, policies, index, fonctions et triggers
-- ===========================================================================
DO $$
DECLARE
  v_tbl text;
  v_fn text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['price_alerts', 'alert_events', 'push_subscriptions'] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE EXCEPTION '[0] public.% is missing', v_tbl;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = ('public.' || v_tbl)::regclass AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '[0] RLS must be ENABLED and FORCED on public.%', v_tbl;
    END IF;
    IF has_table_privilege('public', 'public.' || v_tbl, 'SELECT') THEN
      RAISE EXCEPTION '[0] PUBLIC must have no privilege on public.%', v_tbl;
    END IF;
    PERFORM pg_temp.expect_privileges('public.' || v_tbl, 'anon', ARRAY[]::text[]);
    PERFORM pg_temp.expect_privileges('public.' || v_tbl, 'service_role',
      ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']);
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = v_tbl
                  AND roles && ARRAY['anon', 'public']::name[]) THEN
      RAISE EXCEPTION '[0] no policy may target anon / PUBLIC on public.%', v_tbl;
    END IF;
    IF (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_tbl AND roles = '{service_role}') <> 1 THEN
      RAISE EXCEPTION '[0] public.% must have exactly 1 service_role policy', v_tbl;
    END IF;
  END LOOP;

  -- authenticated : CRUD sur price_alerts / push_subscriptions ; PAS d'INSERT sur alert_events.
  PERFORM pg_temp.expect_privileges('public.price_alerts', 'authenticated', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  PERFORM pg_temp.expect_privileges('public.push_subscriptions', 'authenticated', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  PERFORM pg_temp.expect_privileges('public.alert_events', 'authenticated', ARRAY['SELECT', 'UPDATE', 'DELETE']);

  -- Policies `authenticated` : 4 (une par commande) / 3 (alert_events : pas d'INSERT) / 4.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_alerts'
        AND roles = '{authenticated}') <> 4
     OR (SELECT count(DISTINCT cmd) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'price_alerts'
        AND roles = '{authenticated}') <> 4 THEN
    RAISE EXCEPTION '[0] price_alerts must have 4 authenticated policies (one per command)';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
        AND roles = '{authenticated}') <> 4
     OR (SELECT count(DISTINCT cmd) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
        AND roles = '{authenticated}') <> 4 THEN
    RAISE EXCEPTION '[0] push_subscriptions must have 4 authenticated policies (one per command)';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'alert_events'
        AND roles = '{authenticated}') <> 3
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'alert_events'
        AND roles = '{authenticated}' AND cmd IN ('INSERT', 'ALL')) THEN
    RAISE EXCEPTION '[0] alert_events must have 3 authenticated policies (SELECT, UPDATE, DELETE) and no INSERT';
  END IF;

  -- Index exigés.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'price_alerts'
                  AND indexname = 'idx_price_alerts_active_card' AND indexdef LIKE '%(is_active, card_id)') THEN
    RAISE EXCEPTION '[0] missing index idx_price_alerts_active_card (is_active, card_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'price_alerts'
                  AND indexname = 'idx_price_alerts_user' AND indexdef LIKE '%(user_id, updated_at DESC)') THEN
    RAISE EXCEPTION '[0] missing index idx_price_alerts_user (user_id, updated_at DESC)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'alert_events'
                  AND indexname = 'idx_alert_events_user_unread'
                  AND indexdef LIKE '%(user_id, triggered_at DESC)%WHERE%read_at IS NULL%') THEN
    RAISE EXCEPTION '[0] missing partial index idx_alert_events_user_unread (user_id, triggered_at DESC) WHERE read_at IS NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'alert_events'
                  AND indexname = 'idx_alert_events_user_triggered'
                  AND indexdef LIKE '%(user_id, triggered_at DESC, id DESC)') THEN
    RAISE EXCEPTION '[0] missing index idx_alert_events_user_triggered (user_id, triggered_at DESC, id DESC)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'alert_events'
                  AND indexname = 'idx_alert_events_alert' AND indexdef LIKE '%(alert_id, triggered_at DESC)') THEN
    RAISE EXCEPTION '[0] missing index idx_alert_events_alert (alert_id, triggered_at DESC)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
                  AND indexname = 'idx_push_subscriptions_user' AND indexdef LIKE '%(user_id)') THEN
    RAISE EXCEPTION '[0] missing index idx_push_subscriptions_user (user_id)';
  END IF;

  -- Endpoint UNIQUE.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.push_subscriptions'::regclass AND contype = 'u'
                    AND pg_get_constraintdef(oid) = 'UNIQUE (endpoint)') THEN
    RAISE EXCEPTION '[0] push_subscriptions.endpoint must be UNIQUE';
  END IF;

  -- Fonctions de trigger : SECURITY INVOKER, search_path verrouillé, non exécutables par les rôles API.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.protect_price_alert_immutable_columns()',
    'public.check_alert_event_owner()',
    'public.protect_alert_event_immutable_columns()',
    'public.protect_push_subscription_immutable_columns()'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = v_fn::regprocedure AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION '[0] % must be SECURITY INVOKER with search_path = ''''', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[0] % must not be executable by anon/authenticated', v_fn;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.price_alerts'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION '[0] public.price_alerts must carry exactly 2 triggers (immutable columns + updated_at)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.alert_events'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION '[0] public.alert_events must carry exactly 2 triggers (owner check + immutable columns)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.push_subscriptions'::regclass AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION '[0] public.push_subscriptions must carry exactly 1 trigger (immutable columns)';
  END IF;
  RAISE NOTICE 'ok [0] RLS enabled+forced, grants, policies, indexes, trigger functions';
END $$;

-- ===========================================================================
-- 1. Fixtures : 2 utilisateurs (Alice, Bob) + mini catalogue
-- ===========================================================================
INSERT INTO public.allowed_users (email, note) VALUES
  ('alice.t8@pokevault.test', 'test T8.1 A'),
  ('bob.t8@pokevault.test',   'test T8.1 B');

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000008a1', 'alice.t8@pokevault.test', '{"full_name": "Alice T8"}'),
  ('00000000-0000-4000-8000-0000000008b1', 'bob.t8@pokevault.test',   '{"full_name": "Bob T8"}');

INSERT INTO public.catalog_series (id, name_fr) VALUES ('t8-sv', 'Série de test T8');
INSERT INTO public.catalog_sets (id, series_id, name_fr, official_count, total_count) VALUES
  ('t8-set-a', 't8-sv', 'Set A', 2, 2);
INSERT INTO public.catalog_cards (id, set_id, local_id, local_id_numeric, name_fr) VALUES
  ('t8-set-a-001', 't8-set-a', '001', 1, 'Carte A1'),
  ('t8-set-a-002', 't8-set-a', '002', 2, 'Carte A2');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN
        ('00000000-0000-4000-8000-0000000008a1', '00000000-0000-4000-8000-0000000008b1')) <> 2 THEN
    RAISE EXCEPTION '[1] fixtures: both profiles must exist';
  END IF;
  RAISE NOTICE 'ok [1] fixtures (Alice, Bob, catalogue t8-*)';
END $$;

-- ===========================================================================
-- 2. price_alerts : CRUD nominal & valeurs par défaut (Alice, rôle `authenticated`)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
  pa public.price_alerts;
BEGIN
  PERFORM pg_temp.expect_rows('[2] insert minimal', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (id, user_id, card_id, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 't8-set-a-001', 1500)$q$, c_a), 1);

  SELECT * INTO pa FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  IF pa.language <> 'FR' OR pa.variant <> 'normal' OR pa.min_condition <> 'NM' OR pa.price_field <> 'low_fr'
     OR pa.is_active IS NOT TRUE OR pa.notify_push IS NOT TRUE OR pa.notify_discord IS NOT FALSE
     OR pa.cooldown_hours <> 24 OR pa.last_triggered_at IS NOT NULL
     OR pa.created_at IS NULL OR pa.updated_at IS NULL THEN
    RAISE EXCEPTION '[2] unexpected defaults: %', row_to_json(pa);
  END IF;

  -- Toutes les valeurs extrêmes autorisées passent.
  PERFORM pg_temp.expect_rows('[2] insert full', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (id, user_id, card_id, language, variant, min_condition, price_field,
                                        threshold_cents, is_active, notify_push, notify_discord, cooldown_hours)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000002', %L, 't8-set-a-001', 'JP', 'masterball', 'PO', 'trend',
               1, false, false, true, 168)$q$, c_a), 1);
  PERFORM pg_temp.expect_rows('[2] cooldown min bound', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (id, user_id, card_id, language, threshold_cents, cooldown_hours)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000003', %L, 't8-set-a-002', 'EN', 500, 1)$q$, c_a), 1);

  PERFORM pg_temp.expect_rows('[2] read own', 'authenticated', c_a,
    $q$SELECT * FROM public.price_alerts$q$, 3);
  PERFORM pg_temp.expect_rows('[2] update own', 'authenticated', c_a,
    $q$UPDATE public.price_alerts SET threshold_cents = 1200, is_active = false, notify_discord = true,
                                      cooldown_hours = 48, last_triggered_at = now()
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 1);
  PERFORM pg_temp.expect_rows('[2] delete own', 'authenticated', c_a,
    $q$DELETE FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003'$q$, 1);
  PERFORM pg_temp.expect_rows('[2] remaining', 'authenticated', c_a,
    $q$SELECT * FROM public.price_alerts$q$, 2);
  RAISE NOTICE 'ok [2] price_alerts CRUD & defaults';
END $$;

-- ===========================================================================
-- 3. price_alerts : contraintes CHECK / NOT NULL / FK
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
BEGIN
  PERFORM pg_temp.expect_error('[3] threshold zero', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-set-a-002', 0)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] threshold negative', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-set-a-002', -5)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] threshold required', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id) VALUES (%L, 't8-set-a-002')$q$, c_a), '23502');
  PERFORM pg_temp.expect_error('[3] cooldown zero', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, cooldown_hours) VALUES (%L, 't8-set-a-002', 100, 0)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] cooldown above 168', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, cooldown_hours) VALUES (%L, 't8-set-a-002', 100, 169)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad language', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, language) VALUES (%L, 't8-set-a-002', 100, 'DE')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad variant', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, variant) VALUES (%L, 't8-set-a-002', 100, 'shiny')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad min_condition', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, min_condition) VALUES (%L, 't8-set-a-002', 100, 'MINT')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] bad price_field', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, price_field) VALUES (%L, 't8-set-a-002', 100, 'avg')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] null is_active', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents, is_active) VALUES (%L, 't8-set-a-002', 100, NULL)$q$, c_a), '23502');
  PERFORM pg_temp.expect_error('[3] update bad threshold', 'authenticated', c_a,
    $q$UPDATE public.price_alerts SET threshold_cents = 0 WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, '23514');
  PERFORM pg_temp.expect_error('[3] unknown card', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-unknown', 100)$q$, c_a), '23503');
  -- Un profil inexistant est refusé par la FK (service_role : la RLS ne masque pas l'erreur).
  PERFORM pg_temp.expect_error('[3] unknown user', 'service_role', NULL,
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents)
       VALUES ('00000000-0000-4000-8000-0000000008ff', 't8-set-a-001', 100)$q$, '23503');
  RAISE NOTICE 'ok [3] price_alerts CHECK / NOT NULL / FK';
END $$;

-- ===========================================================================
-- 4. price_alerts : colonnes immuables & updated_at
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
  v_before timestamptz;
  v_after timestamptz;
BEGIN
  PERFORM pg_temp.expect_error('[4] id immutable', 'authenticated', c_a,
    $q$UPDATE public.price_alerts SET id = 'aaaaaaaa-0000-4000-8000-0000000000ff' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '42501');
  PERFORM pg_temp.expect_error('[4] user_id immutable (to Bob)', 'authenticated', c_a,
    $q$UPDATE public.price_alerts SET user_id = '00000000-0000-4000-8000-0000000008b1' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '42501');
  PERFORM pg_temp.expect_error('[4] created_at immutable', 'authenticated', c_a,
    $q$UPDATE public.price_alerts SET created_at = now() - interval '1 year' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '42501');
  -- Même `service_role` (BYPASSRLS) ne contourne pas le trigger.
  PERFORM pg_temp.expect_error('[4] user_id immutable (service_role)', 'service_role', NULL,
    $q$UPDATE public.price_alerts SET user_id = '00000000-0000-4000-8000-0000000008b1' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '42501');

  -- updated_at avance à chaque UPDATE (valeur initiale placée dans le passé).
  ALTER TABLE public.price_alerts DISABLE TRIGGER price_alerts_set_updated_at;
  UPDATE public.price_alerts SET updated_at = now() - interval '1 day'
   WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  ALTER TABLE public.price_alerts ENABLE TRIGGER price_alerts_set_updated_at;
  SELECT updated_at INTO v_before FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  PERFORM pg_temp.expect_rows('[4] mutable column update', 'authenticated', c_a,
    $q$UPDATE public.price_alerts SET is_active = true WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 1);
  SELECT updated_at INTO v_after FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  IF v_after <= v_before THEN
    RAISE EXCEPTION '[4] updated_at must advance on UPDATE (before %, after %)', v_before, v_after;
  END IF;
  RAISE NOTICE 'ok [4] price_alerts immutable columns & updated_at';
END $$;

-- ===========================================================================
-- 5. alert_events : insertion réservée au worker, intégrité du propriétaire, CHECK
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000008b1';
  e public.alert_events;
BEGIN
  -- Bob reçoit une alerte pour que les contrôles d'intégrité croisés soient possibles.
  PERFORM pg_temp.expect_rows('[5] bob alert', 'authenticated', c_b, format(
    $q$INSERT INTO public.price_alerts (id, user_id, card_id, threshold_cents)
       VALUES ('bbbbbbbb-0000-4000-8000-000000000001', %L, 't8-set-a-001', 900)$q$, c_b), 1);

  -- `authenticated` ne peut JAMAIS créer d'évènement (pas de droit INSERT), même pour lui-même.
  PERFORM pg_temp.expect_error('[5] authenticated cannot insert event', 'authenticated', c_a, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 1000, 1200)$q$, c_a), '42501');

  -- Worker (`service_role`) : insertion nominale + valeurs par défaut.
  PERFORM pg_temp.expect_rows('[5] service_role insert event', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (id, alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', %L, 1000, 1200)$q$, c_a), 1);
  SELECT * INTO e FROM public.alert_events WHERE id = 'eeeeeeee-0000-4000-8000-000000000001';
  IF e.channels_sent <> '{}'::text[] OR e.read_at IS NOT NULL OR e.triggered_at IS NULL THEN
    RAISE EXCEPTION '[5] unexpected alert_events defaults: %', row_to_json(e);
  END IF;
  PERFORM pg_temp.expect_rows('[5] event with channels', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (id, alert_id, user_id, observed_price_cents, threshold_cents, channels_sent, triggered_at)
       VALUES ('eeeeeeee-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', %L, 0, 1200,
               ARRAY['push', 'discord'], now() - interval '1 hour')$q$, c_a), 1);
  PERFORM pg_temp.expect_rows('[5] event for bob', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (id, alert_id, user_id, observed_price_cents, threshold_cents, channels_sent)
       VALUES ('eeeeeeee-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000001', %L, 800, 900, ARRAY['push'])$q$, c_b), 1);

  -- Intégrité : `user_id` doit être le propriétaire de l'alerte (23514 via trigger).
  PERFORM pg_temp.expect_error('[5] event user_id mismatch (bob on alice alert)', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 1000, 1200)$q$, c_b), '23514');
  PERFORM pg_temp.expect_error('[5] event user_id mismatch (alice on bob alert)', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('bbbbbbbb-0000-4000-8000-000000000001', %L, 1000, 900)$q$, c_a), '23514');
  -- Alerte inexistante : refusée (le trigger d'intégrité précède la FK).
  PERFORM pg_temp.expect_error('[5] event on unknown alert', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000fe', %L, 1000, 1200)$q$, c_a), '23514');

  -- CHECK.
  PERFORM pg_temp.expect_error('[5] negative observed price', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, -1, 1200)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[5] threshold zero', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 100, 0)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[5] unknown channel', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents, channels_sent)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 100, 1200, ARRAY['sms'])$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[5] one unknown channel among valid', 'service_role', NULL, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents, channels_sent)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 100, 1200, ARRAY['push', 'email'])$q$, c_a), '23514');
  RAISE NOTICE 'ok [5] alert_events insert (worker only), owner integrity, CHECK';
END $$;

-- ===========================================================================
-- 6. alert_events : seul `read_at` est modifiable par l'utilisateur
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
BEGIN
  -- Pastille : 2 évènements non lus pour Alice.
  PERFORM pg_temp.expect_rows('[6] alice unread', 'authenticated', c_a,
    $q$SELECT * FROM public.alert_events WHERE read_at IS NULL$q$, 2);
  PERFORM pg_temp.expect_rows('[6] mark read', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET read_at = now() WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, 1);
  PERFORM pg_temp.expect_rows('[6] alice unread after', 'authenticated', c_a,
    $q$SELECT * FROM public.alert_events WHERE read_at IS NULL$q$, 1);
  PERFORM pg_temp.expect_rows('[6] mark unread again', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET read_at = NULL WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, 1);

  -- Tout le reste est immuable, même pour le propriétaire.
  PERFORM pg_temp.expect_error('[6] id immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET id = 'eeeeeeee-0000-4000-8000-0000000000ff' WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] alert_id immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET alert_id = 'aaaaaaaa-0000-4000-8000-000000000002' WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] user_id immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET user_id = '00000000-0000-4000-8000-0000000008b1' WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] observed_price_cents immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET observed_price_cents = 1 WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] threshold_cents immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET threshold_cents = 1 WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] channels_sent immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET channels_sent = ARRAY['push'] WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] triggered_at immutable', 'authenticated', c_a,
    $q$UPDATE public.alert_events SET triggered_at = now() - interval '1 year' WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[6] observed_price_cents immutable (service_role)', 'service_role', NULL,
    $q$UPDATE public.alert_events SET observed_price_cents = 1 WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, '42501');
  -- Le même UPDATE qui ne touche que read_at passe pour le worker aussi.
  PERFORM pg_temp.expect_rows('[6] service_role may set read_at', 'service_role', NULL,
    $q$UPDATE public.alert_events SET read_at = read_at WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, 1);

  -- Suppression de ses propres évènements (purge de l'historique).
  PERFORM pg_temp.expect_rows('[6] delete own event', 'authenticated', c_a,
    $q$DELETE FROM public.alert_events WHERE id = 'eeeeeeee-0000-4000-8000-000000000002'$q$, 1);
  RAISE NOTICE 'ok [6] alert_events: read_at only';
END $$;

-- ===========================================================================
-- 7. push_subscriptions : CRUD, CHECK, unicité, immuables
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000008b1';
  s public.push_subscriptions;
BEGIN
  PERFORM pg_temp.expect_rows('[7] insert', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (id, user_id, endpoint, p256dh, auth)
       VALUES ('55555555-0000-4000-8000-000000000001', %L, 'https://push.example.test/alice-1', 'key-p256dh', 'key-auth')$q$, c_a), 1);
  SELECT * INTO s FROM public.push_subscriptions WHERE id = '55555555-0000-4000-8000-000000000001';
  IF s.user_agent IS NOT NULL OR s.created_at IS NULL OR s.last_seen_at IS NULL THEN
    RAISE EXCEPTION '[7] unexpected push_subscriptions defaults: %', row_to_json(s);
  END IF;
  PERFORM pg_temp.expect_rows('[7] insert with user_agent', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ('55555555-0000-4000-8000-000000000002', %L, 'https://push.example.test/alice-2', 'k', 'a', 'Firefox/Android')$q$, c_a), 1);
  PERFORM pg_temp.expect_rows('[7] touch last_seen_at', 'authenticated', c_a,
    $q$UPDATE public.push_subscriptions SET last_seen_at = now(), user_agent = 'Chrome' WHERE id = '55555555-0000-4000-8000-000000000001'$q$, 1);

  -- CHECK.
  PERFORM pg_temp.expect_error('[7] http endpoint refused', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'http://push.example.test/x', 'k', 'a')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[7] non-URL endpoint refused', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'push.example.test/x', 'k', 'a')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[7] blank p256dh refused', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/b', '   ', 'a')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[7] empty auth refused', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/c', 'k', '')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[7] null endpoint refused', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, NULL, 'k', 'a')$q$, c_a), '23502');

  -- endpoint UNIQUE, y compris entre utilisateurs (un navigateur = un seul propriétaire ; RLS
  -- masque la ligne d'Alice à Bob, mais la contrainte globale refuse quand même le doublon).
  PERFORM pg_temp.expect_error('[7] duplicate endpoint (same user)', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/alice-1', 'k', 'a')$q$, c_a), '23505');
  PERFORM pg_temp.expect_error('[7] duplicate endpoint (other user)', 'authenticated', c_b, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/alice-1', 'k', 'a')$q$, c_b), '23505');

  -- Colonnes immuables.
  PERFORM pg_temp.expect_error('[7] id immutable', 'authenticated', c_a,
    $q$UPDATE public.push_subscriptions SET id = '55555555-0000-4000-8000-0000000000ff' WHERE id = '55555555-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[7] user_id immutable', 'authenticated', c_a,
    $q$UPDATE public.push_subscriptions SET user_id = '00000000-0000-4000-8000-0000000008b1' WHERE id = '55555555-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[7] created_at immutable', 'authenticated', c_a,
    $q$UPDATE public.push_subscriptions SET created_at = now() - interval '1 year' WHERE id = '55555555-0000-4000-8000-000000000001'$q$, '42501');

  PERFORM pg_temp.expect_rows('[7] delete own', 'authenticated', c_a,
    $q$DELETE FROM public.push_subscriptions WHERE id = '55555555-0000-4000-8000-000000000002'$q$, 1);
  PERFORM pg_temp.expect_rows('[7] bob insert', 'authenticated', c_b, format(
    $q$INSERT INTO public.push_subscriptions (id, user_id, endpoint, p256dh, auth)
       VALUES ('55555555-0000-4000-8000-0000000000b1', %L, 'https://push.example.test/bob-1', 'k', 'a')$q$, c_b), 1);
  RAISE NOTICE 'ok [7] push_subscriptions CRUD, CHECK, unique endpoint, immutable columns';
END $$;

-- ===========================================================================
-- 8. Isolation RLS cross-user (Alice ≠ Bob) sur les 3 tables
-- ===========================================================================
-- État : Alice = 2 alertes, 1 évènement, 1 abonnement ; Bob = 1 alerte, 1 évènement, 1 abonnement.
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000008b1';
BEGIN
  -- Lecture : chacun ne voit que ses lignes.
  PERFORM pg_temp.expect_rows('[8] alice alerts', 'authenticated', c_a, $q$SELECT * FROM public.price_alerts$q$, 2);
  PERFORM pg_temp.expect_rows('[8] bob alerts', 'authenticated', c_b, $q$SELECT * FROM public.price_alerts$q$, 1);
  PERFORM pg_temp.expect_rows('[8] alice events', 'authenticated', c_a, $q$SELECT * FROM public.alert_events$q$, 1);
  PERFORM pg_temp.expect_rows('[8] bob events', 'authenticated', c_b, $q$SELECT * FROM public.alert_events$q$, 1);
  PERFORM pg_temp.expect_rows('[8] alice subs', 'authenticated', c_a, $q$SELECT * FROM public.push_subscriptions$q$, 1);
  PERFORM pg_temp.expect_rows('[8] bob subs', 'authenticated', c_b, $q$SELECT * FROM public.push_subscriptions$q$, 1);
  PERFORM pg_temp.expect_rows('[8] bob cannot read alice alert by id', 'authenticated', c_b,
    $q$SELECT * FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot read alice event by id', 'authenticated', c_b,
    $q$SELECT * FROM public.alert_events WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot read alice sub by id', 'authenticated', c_b,
    $q$SELECT * FROM public.push_subscriptions WHERE id = '55555555-0000-4000-8000-000000000001'$q$, 0);

  -- UPDATE / DELETE d'une ligne d'autrui : 0 ligne touchée, aucune erreur.
  PERFORM pg_temp.expect_rows('[8] bob cannot update alice alert', 'authenticated', c_b,
    $q$UPDATE public.price_alerts SET is_active = false WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot delete alice alert', 'authenticated', c_b,
    $q$DELETE FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot mark alice event read', 'authenticated', c_b,
    $q$UPDATE public.alert_events SET read_at = now() WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot delete alice event', 'authenticated', c_b,
    $q$DELETE FROM public.alert_events WHERE id = 'eeeeeeee-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot update alice sub', 'authenticated', c_b,
    $q$UPDATE public.push_subscriptions SET user_agent = 'x' WHERE id = '55555555-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] bob cannot delete alice sub', 'authenticated', c_b,
    $q$DELETE FROM public.push_subscriptions WHERE id = '55555555-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[8] alice rows untouched', 'service_role', NULL,
    $q$SELECT * FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001' AND is_active = false$q$, 1);
  PERFORM pg_temp.expect_rows('[8] alice event still unread', 'service_role', NULL,
    $q$SELECT * FROM public.alert_events WHERE id = 'eeeeeeee-0000-4000-8000-000000000001' AND read_at IS NULL$q$, 1);

  -- INSERT au nom d'autrui : refusé par WITH CHECK (42501).
  PERFORM pg_temp.expect_error('[8] bob cannot insert alert for alice', 'authenticated', c_b, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-set-a-002', 100)$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[8] alice cannot insert alert for bob', 'authenticated', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-set-a-002', 100)$q$, c_b), '42501');
  PERFORM pg_temp.expect_error('[8] bob cannot insert sub for alice', 'authenticated', c_b, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/x1', 'k', 'a')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[8] alice cannot insert sub for bob', 'authenticated', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/x2', 'k', 'a')$q$, c_b), '42501');

  -- Sans claims JWT (`sub` absent) : `auth.uid()` est NULL, rien n'est visible ni insérable.
  PERFORM pg_temp.expect_rows('[8] no sub sees no alert', 'authenticated', NULL, $q$SELECT * FROM public.price_alerts$q$, 0);
  PERFORM pg_temp.expect_rows('[8] no sub sees no event', 'authenticated', NULL, $q$SELECT * FROM public.alert_events$q$, 0);
  PERFORM pg_temp.expect_rows('[8] no sub sees no sub', 'authenticated', NULL, $q$SELECT * FROM public.push_subscriptions$q$, 0);
  PERFORM pg_temp.expect_error('[8] no sub cannot insert alert', 'authenticated', NULL, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-set-a-002', 100)$q$, c_a), '42501');
  RAISE NOTICE 'ok [8] cross-user RLS isolation';
END $$;

-- ===========================================================================
-- 9. `anon` : aucun accès (droits retirés, aucune policy)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000008a1';
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['price_alerts', 'alert_events', 'push_subscriptions'] LOOP
    PERFORM pg_temp.expect_error('[9] anon select ' || v_tbl, 'anon', NULL,
      format('SELECT * FROM public.%I', v_tbl), '42501');
    PERFORM pg_temp.expect_error('[9] anon select with forged sub ' || v_tbl, 'anon', c_a,
      format('SELECT * FROM public.%I', v_tbl), '42501');
    PERFORM pg_temp.expect_error('[9] anon delete ' || v_tbl, 'anon', c_a,
      format('DELETE FROM public.%I', v_tbl), '42501');
  END LOOP;
  PERFORM pg_temp.expect_error('[9] anon insert alert', 'anon', c_a, format(
    $q$INSERT INTO public.price_alerts (user_id, card_id, threshold_cents) VALUES (%L, 't8-set-a-002', 100)$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[9] anon insert event', 'anon', c_a, format(
    $q$INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 1, 1200)$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[9] anon insert sub', 'anon', c_a, format(
    $q$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (%L, 'https://push.example.test/anon', 'k', 'a')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[9] anon update event', 'anon', c_a,
    $q$UPDATE public.alert_events SET read_at = now()$q$, '42501');
  RAISE NOTICE 'ok [9] anon denied';
END $$;

-- ===========================================================================
-- 10. `service_role` : accès complet (cron de prix, worker d'alertes, push + purge 404/410)
-- ===========================================================================
DO $$
BEGIN
  -- Évaluation des alertes actives par carte (index critique) : Alice désactivée (1), Bob actif.
  PERFORM pg_temp.expect_rows('[10] service_role reads all alerts', 'service_role', NULL,
    $q$SELECT * FROM public.price_alerts WHERE user_id IN
         ('00000000-0000-4000-8000-0000000008a1', '00000000-0000-4000-8000-0000000008b1')$q$, 3);
  PERFORM pg_temp.expect_rows('[10] service_role active alerts per card', 'service_role', NULL,
    $q$SELECT card_id FROM public.price_alerts WHERE is_active AND card_id LIKE 't8-%'$q$, 2);
  PERFORM pg_temp.expect_rows('[10] service_role update last_triggered_at', 'service_role', NULL,
    $q$UPDATE public.price_alerts SET last_triggered_at = now() WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$, 1);
  PERFORM pg_temp.expect_rows('[10] service_role reads all subs', 'service_role', NULL,
    $q$SELECT * FROM public.push_subscriptions WHERE endpoint LIKE 'https://push.example.test/%'$q$, 2);
  PERFORM pg_temp.expect_rows('[10] service_role purges dead endpoint (410)', 'service_role', NULL,
    $q$DELETE FROM public.push_subscriptions WHERE endpoint = 'https://push.example.test/bob-1'$q$, 1);
  PERFORM pg_temp.expect_rows('[10] service_role deletes event', 'service_role', NULL,
    $q$DELETE FROM public.alert_events WHERE id = 'eeeeeeee-0000-4000-8000-000000000003'$q$, 1);
  RAISE NOTICE 'ok [10] service_role full access';
END $$;

-- ===========================================================================
-- 11. Compatibilité avec les requêtes existantes (Dashboard, cron de prix)
-- ===========================================================================
DO $$
DECLARE
  v_rows bigint;
BEGIN
  -- apps/web/src/lib/dashboard-server.ts : `queryLatestAlert`.
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000008a1', true);
  SELECT count(*) INTO v_rows FROM (
    SELECT e.alert_id, pa.card_id, coalesce(cc.name_fr, pa.card_id) AS card_name,
           e.observed_price_cents, e.threshold_cents, e.triggered_at
      FROM public.alert_events e
      JOIN public.price_alerts pa ON pa.id = e.alert_id
      LEFT JOIN public.catalog_cards cc ON cc.id = pa.card_id
     WHERE e.user_id = '00000000-0000-4000-8000-0000000008a1'
     ORDER BY e.triggered_at DESC, e.id DESC
     LIMIT 1
  ) q;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '[11] dashboard latest-alert query must return Alice''s event (got % rows)', v_rows;
  END IF;

  -- packages/services/src/cardmarket-price-service.ts : priorité 1 du cron (alertes actives).
  SELECT count(*) INTO v_rows FROM (
    SELECT c.id AS card_id, pa.language AS language, 'normal'::text AS variant, 1 AS rank
      FROM public.catalog_cards AS c
      JOIN public.price_alerts AS pa ON pa.card_id = c.id
     WHERE pa.is_active = TRUE AND c.id LIKE 't8-%'
  ) q;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION '[11] price-cron active-alert query must return the 2 active alerts (got % rows)', v_rows;
  END IF;
  RAISE NOTICE 'ok [11] dashboard & price-cron query compatibility';
END $$;

-- ===========================================================================
-- 12. Cascades : suppression d'une alerte / d'un utilisateur / d'une carte
-- ===========================================================================
DO $$
BEGIN
  -- Alerte supprimée -> ses évènements disparaissent.
  DELETE FROM public.price_alerts WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  IF EXISTS (SELECT 1 FROM public.alert_events WHERE alert_id = 'aaaaaaaa-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION '[12] deleting an alert must cascade to alert_events';
  END IF;

  -- Utilisateur supprimé -> alertes, évènements et abonnements disparaissent ; Alice intacte.
  INSERT INTO public.alert_events (alert_id, user_id, observed_price_cents, threshold_cents)
    VALUES ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000008b1', 700, 900);
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES ('00000000-0000-4000-8000-0000000008b1', 'https://push.example.test/bob-2', 'k', 'a');
  DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000008b1';
  IF EXISTS (SELECT 1 FROM public.price_alerts WHERE user_id = '00000000-0000-4000-8000-0000000008b1')
     OR EXISTS (SELECT 1 FROM public.alert_events WHERE user_id = '00000000-0000-4000-8000-0000000008b1')
     OR EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = '00000000-0000-4000-8000-0000000008b1') THEN
    RAISE EXCEPTION '[12] deleting a user must cascade to price_alerts, alert_events and push_subscriptions';
  END IF;
  IF (SELECT count(*) FROM public.price_alerts WHERE user_id = '00000000-0000-4000-8000-0000000008a1') <> 1
     OR (SELECT count(*) FROM public.push_subscriptions WHERE user_id = '00000000-0000-4000-8000-0000000008a1') <> 1 THEN
    RAISE EXCEPTION '[12] deleting bob must not touch alice data';
  END IF;

  -- Carte du catalogue supprimée -> alertes associées supprimées.
  DELETE FROM public.catalog_cards WHERE id = 't8-set-a-001';
  IF EXISTS (SELECT 1 FROM public.price_alerts WHERE card_id = 't8-set-a-001') THEN
    RAISE EXCEPTION '[12] deleting a catalog card must cascade to price_alerts';
  END IF;
  RAISE NOTICE 'ok [12] ON DELETE CASCADE (price_alerts, profiles, catalog_cards)';
END $$;

ROLLBACK;

\echo ALL TESTS PASSED — 007_price_alerts
