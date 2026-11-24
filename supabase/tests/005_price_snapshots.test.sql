-- supabase/tests/005_price_snapshots.test.sql
-- Tests d'intégration SQL de supabase/migrations/005_price_snapshots.sql
-- (issue #21, T6.1 : cache de prix TTL, vue card_latest_prices, index critiques).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres`) APRÈS les
-- migrations 001 à 005, en tant que superuser (`supabase_admin`) :
--
--   for f in 001_profiles_and_auth 002_catalog 003_sync_discord_identity \
--            004_binders_and_copies 005_price_snapshots; do
--     psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/$f.sql
--   done
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/tests/005_price_snapshots.sql
--
-- Tout le script s'exécute dans une unique transaction terminée par ROLLBACK :
-- idempotent, il ne laisse aucune donnée derrière lui (seules les séquences
-- avancent, sans incidence). Toute assertion en échec lève une exception qui
-- annule la transaction et arrête psql avec un code de retour non nul.
--
-- Rôles simulés : `service_role` (worker Cardmarket/TCGdex, BYPASSRLS),
-- `authenticated` (membres) et `anon` (visiteurs, zéro accès).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers (schéma temporaire de la session, créés en tant que superuser)
-- ---------------------------------------------------------------------------

-- Exécute `p_sql` sous le rôle `p_role` ; retourne le nombre de lignes
-- touchées/renvoyées. Laisse remonter l'erreur SQL telle quelle.
CREATE FUNCTION pg_temp.rows_as(p_role text, p_sql text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows bigint;
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  RETURN v_rows;
END;
$$;

-- Comme `rows_as` mais retourne le SQLSTATE de l'erreur levée (NULL si succès).
CREATE FUNCTION pg_temp.sqlstate_as(p_role text, p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
BEGIN
  BEGIN
    PERFORM pg_temp.rows_as(p_role, p_sql);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; -- le sous-bloc annulé restaure aussi le rôle courant
  END;
  RESET ROLE;
  RETURN v_state;
END;
$$;

-- Exige que `p_sql` échoue sous `p_role` avec exactement le SQLSTATE `p_state`.
CREATE FUNCTION pg_temp.expect_error(p_label text, p_role text, p_sql text, p_state text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_state text;
BEGIN
  v_state := pg_temp.sqlstate_as(p_role, p_sql);
  IF v_state IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION '% — expected SQLSTATE %, got % for: %',
      p_label, p_state, coalesce(v_state, 'no error'), p_sql;
  END IF;
END;
$$;

-- Exige que `p_sql` touche/retourne exactement `p_rows` lignes sous `p_role`.
CREATE FUNCTION pg_temp.expect_rows(p_label text, p_role text, p_sql text, p_rows bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows bigint;
BEGIN
  v_rows := pg_temp.rows_as(p_role, p_sql);
  IF v_rows IS DISTINCT FROM p_rows THEN
    RAISE EXCEPTION '% — expected % row(s), got %', p_label, p_rows, v_rows;
  END IF;
END;
$$;

-- ===========================================================================
-- 0. Structure : RLS forcée, grants, policies, FK, défauts, index, vue
-- ===========================================================================
DO $$
DECLARE
  v_text  text;
  v_count bigint;
  v_opts  text[];
  v_cmd   text;
  v_roles text[];
BEGIN
  -- RLS activée ET forcée sur price_snapshots.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.price_snapshots'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '[0] RLS must be ENABLED and FORCED on public.price_snapshots';
  END IF;

  -- Grants table : SELECT pour authenticated, ALL pour service_role ; rien pour
  -- anon / PUBLIC, et aucune écriture pour authenticated.
  IF has_table_privilege('anon', 'public.price_snapshots', 'SELECT')
    OR has_table_privilege('anon', 'public.price_snapshots', 'INSERT')
    OR has_table_privilege('authenticated', 'public.price_snapshots', 'INSERT')
    OR has_table_privilege('authenticated', 'public.price_snapshots', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.price_snapshots', 'DELETE')
    OR has_table_privilege('public', 'public.price_snapshots', 'SELECT')
    OR NOT has_table_privilege('authenticated', 'public.price_snapshots', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.price_snapshots', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.price_snapshots', 'UPDATE')
    OR NOT has_table_privilege('service_role', 'public.price_snapshots', 'DELETE') THEN
    RAISE EXCEPTION '[0] unexpected table privileges on public.price_snapshots';
  END IF;

  -- Séquence : USAGE/SELECT uniquement pour service_role.
  IF has_sequence_privilege('anon', 'public.price_snapshots_id_seq', 'USAGE')
    OR has_sequence_privilege('authenticated', 'public.price_snapshots_id_seq', 'USAGE')
    OR NOT has_sequence_privilege('service_role', 'public.price_snapshots_id_seq', 'USAGE')
    OR NOT has_sequence_privilege('service_role', 'public.price_snapshots_id_seq', 'SELECT') THEN
    RAISE EXCEPTION '[0] unexpected privileges on sequence price_snapshots_id_seq';
  END IF;

  -- Exactement 2 policies : SELECT pour authenticated, ALL pour service_role.
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'price_snapshots';
  IF v_count <> 2 THEN
    RAISE EXCEPTION '[0] price_snapshots must have exactly 2 policies, found %', v_count;
  END IF;
  SELECT cmd, roles INTO v_cmd, v_roles
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'price_snapshots'
     AND policyname = 'price_snapshots_select_authenticated';
  IF v_cmd IS NULL OR v_cmd <> 'SELECT' OR v_roles <> ARRAY['authenticated']::text[] THEN
    RAISE EXCEPTION '[0] policy price_snapshots_select_authenticated misconfigured: % %', v_cmd, v_roles;
  END IF;
  SELECT cmd, roles INTO v_cmd, v_roles
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'price_snapshots'
     AND policyname = 'price_snapshots_service_role_all';
  IF v_cmd IS NULL OR v_cmd <> 'ALL' OR v_roles <> ARRAY['service_role']::text[] THEN
    RAISE EXCEPTION '[0] policy price_snapshots_service_role_all misconfigured: % %', v_cmd, v_roles;
  END IF;

  -- FK vers catalog_cards avec ON DELETE CASCADE (purge d'historique à la sync).
  SELECT confdeltype::text INTO v_text
    FROM pg_constraint
   WHERE conrelid = 'public.price_snapshots'::regclass
     AND contype = 'f'
     AND confrelid = 'public.catalog_cards'::regclass;
  IF v_text IS DISTINCT FROM 'c' THEN
    RAISE EXCEPTION '[0] FK price_snapshots.card_id must be ON DELETE CASCADE (found confdeltype=%)',
      coalesce(v_text, 'absent');
  END IF;

  -- Défaut du TTL : expires_at calculé à partir de now() (15 minutes, cf. §2).
  SELECT pg_get_expr(adbin, adrelid) INTO v_text
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.price_snapshots'::regclass
     AND a.attname = 'expires_at';
  IF v_text IS NULL OR position('now()' in v_text) = 0 THEN
    RAISE EXCEPTION '[0] unexpected default for expires_at: %', coalesce(v_text, '(none)');
  END IF;

  -- Index critiques (docs/02 §5).
  SELECT indexdef INTO v_text FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'idx_price_snapshots_lookup';
  IF v_text IS NULL OR v_text NOT LIKE '%(card_id, language, variant, fetched_at DESC, id DESC)%' THEN
    RAISE EXCEPTION '[0] idx_price_snapshots_lookup must be on (card_id, language, variant, fetched_at DESC, id DESC): %',
      coalesce(v_text, 'absent');
  END IF;
  SELECT indexdef INTO v_text FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'idx_price_snapshots_expires_at';
  IF v_text IS NULL OR v_text NOT LIKE '%(expires_at)%' THEN
    RAISE EXCEPTION '[0] idx_price_snapshots_expires_at must be on (expires_at): %',
      coalesce(v_text, 'absent');
  END IF;
  SELECT indexdef INTO v_text FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'idx_price_snapshots_card_fetched';
  IF v_text IS NULL OR v_text NOT LIKE '%(card_id, fetched_at DESC)%' THEN
    RAISE EXCEPTION '[0] idx_price_snapshots_card_fetched must be on (card_id, fetched_at DESC): %',
      coalesce(v_text, 'absent');
  END IF;

  -- Vue : présente, security_invoker = true, grants corrects.
  IF to_regclass('public.card_latest_prices') IS NULL THEN
    RAISE EXCEPTION '[0] view public.card_latest_prices is missing';
  END IF;
  SELECT reloptions INTO v_opts FROM pg_class WHERE oid = 'public.card_latest_prices'::regclass;
  IF v_opts IS NULL OR NOT (v_opts @> ARRAY['security_invoker=true']::text[]) THEN
    RAISE EXCEPTION '[0] view card_latest_prices must be created WITH (security_invoker = true), got %', v_opts;
  END IF;
  IF has_table_privilege('anon', 'public.card_latest_prices', 'SELECT')
    OR has_table_privilege('authenticated', 'public.card_latest_prices', 'INSERT')
    OR NOT has_table_privilege('authenticated', 'public.card_latest_prices', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.card_latest_prices', 'SELECT') THEN
    RAISE EXCEPTION '[0] unexpected privileges on view card_latest_prices';
  END IF;
  SELECT lower(pg_get_viewdef('public.card_latest_prices'::regclass)) INTO v_text;
  IF position('is_fresh' in v_text) = 0 THEN
    RAISE EXCEPTION '[0] view card_latest_prices must expose is_fresh based on expires_at';
  END IF;

  RAISE NOTICE 'ok [0] structure: RLS forced, grants, 2 policies, FK cascade, TTL default, 3 indexes, security_invoker view';
END
$$;

-- ===========================================================================
-- 1. Fixtures catalogue (préfixe t5 ; purgées implicitement par le ROLLBACK)
-- ===========================================================================
INSERT INTO public.catalog_series (id, name_fr) VALUES ('t5-sv', 'Série de test 005');
INSERT INTO public.catalog_sets (id, series_id, name_fr, official_count, total_count)
  VALUES ('t5-set', 't5-sv', 'Set de test 005', 2, 2);
INSERT INTO public.catalog_cards (id, set_id, local_id, local_id_numeric, name_fr) VALUES
  ('t5-card-1', 't5-set', '001', 1, 'Carte de test 1'),
  ('t5-card-2', 't5-set', '002', 2, 'Carte de test 2');

-- ===========================================================================
-- 2. Inserts valides (worker = service_role) et valeurs par défaut
-- ===========================================================================
DO $$
DECLARE
  v public.price_snapshots;
BEGIN
  -- Cardmarket, les trois prix : défauts language='FR', variant='normal', TTL 15 min.
  PERFORM pg_temp.expect_rows(
    '[2] insert cardmarket (service_role)',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents, low_fr_cents, avg30_cents)
        VALUES ('t5-card-1', 'cardmarket', 12500, 11900, 12250)$q$,
    1);

  SELECT * INTO v FROM public.price_snapshots WHERE card_id = 't5-card-1' AND trend_cents = 12500;
  IF v.language <> 'FR' OR v.variant <> 'normal' THEN
    RAISE EXCEPTION '[2] unexpected defaults: language=%, variant=%', v.language, v.variant;
  END IF;
  IF v.fetched_at IS NULL OR v.expires_at IS NULL
    OR v.expires_at - v.fetched_at <> interval '15 minutes' THEN
    RAISE EXCEPTION '[2] TTL: expires_at must equal fetched_at + 15 minutes (got %)',
      v.expires_at - v.fetched_at;
  END IF;
  IF v.fetched_at <> now() THEN
    RAISE EXCEPTION '[2] fetched_at must default to now() (transaction timestamp)';
  END IF;

  -- Fallback TCGdex : un seul prix suffit (le CHECK coalesce() est satisfait).
  PERFORM pg_temp.expect_rows(
    '[2] insert tcgdex_fallback single price',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, language, variant, source, trend_cents)
       VALUES ('t5-card-1', 'EN', 'holo', 'tcgdex_fallback', 9000)$q$,
    1);

  -- Prix à zéro accepté (>= 0).
  PERFORM pg_temp.expect_rows(
    '[2] zero price accepted',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, low_fr_cents)
        VALUES ('t5-card-1', 'cardmarket', 0)$q$,
    1);

  RAISE NOTICE 'ok [2] valid inserts (cardmarket + tcgdex_fallback), defaults FR/normal, TTL 15 min';
END
$$;

-- ===========================================================================
-- 3. Garde-fous CHECK / FK
-- ===========================================================================
DO $$
BEGIN
  -- Source inconnue.
  PERFORM pg_temp.expect_error(
    '[3] unknown source',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
        VALUES ('t5-card-1', 'ebay', 100)$q$,
    '23514');

  -- Prix négatif, en INSERT comme en UPDATE.
  PERFORM pg_temp.expect_error(
    '[3] negative trend on INSERT',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
        VALUES ('t5-card-1', 'cardmarket', -1)$q$,
    '23514');
  PERFORM pg_temp.expect_error(
    '[3] negative low_fr_cents on UPDATE',
    'service_role',
    $q$UPDATE public.price_snapshots SET low_fr_cents = -5 WHERE card_id = 't5-card-1'$q$,
    '23514');

  -- Les trois prix NULL : un snapshot sans aucun prix doit être refusé.
  PERFORM pg_temp.expect_error(
    '[3] all three prices NULL',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source) VALUES ('t5-card-1', 'cardmarket')$q$,
    '23514');

  -- expires_at <= fetched_at.
  PERFORM pg_temp.expect_error(
    '[3] expires_at equal to fetched_at',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents, fetched_at, expires_at)
        VALUES ('t5-card-1', 'cardmarket', 100, now(), now())$q$,
    '23514');
  PERFORM pg_temp.expect_error(
    '[3] expires_at before fetched_at',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents, fetched_at, expires_at)
        VALUES ('t5-card-1', 'cardmarket', 100,
                TIMESTAMPTZ '2025-01-02 12:00:00+00', TIMESTAMPTZ '2025-01-01 12:00:00+00')$q$,
    '23514');

  -- language / variant hors liste (alignés sur user_card_copies, migration 004).
  PERFORM pg_temp.expect_error(
    '[3] invalid language',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, language, source, trend_cents)
        VALUES ('t5-card-1', 'DE', 'cardmarket', 100)$q$,
    '23514');
  PERFORM pg_temp.expect_error(
    '[3] invalid variant',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, variant, source, trend_cents)
        VALUES ('t5-card-1', 'shiny', 'cardmarket', 100)$q$,
    '23514');

  -- Carte inconnue (FK).
  PERFORM pg_temp.expect_error(
    '[3] unknown card FK',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
        VALUES ('t5-nope', 'cardmarket', 100)$q$,
    '23503');

  RAISE NOTICE 'ok [3] CHECK / FK guards';
END
$$;

-- ===========================================================================
-- 4. Vue card_latest_prices : dernier snapshot par (card_id, language, variant)
-- ===========================================================================
DO $$
DECLARE
  v_id bigint;
  v_fresh boolean;
BEGIN
  -- Historique contrôlé sur t5-card-2 :
  --   ids 10 et 20 : même tuple (card2, FR, normal), même fetched_at explicite
  --   (2025-01-01 09:00) -> départage attendu par id DESC (id 20) ;
  --   id 5 : fetched_at plus récent (now(), stable dans la transaction, donc
  --   > '2025-01-02 09:00') malgré un id plus petit ; expire dans 15 min ->
  --   dernière ligne du tuple et fraîche (is_fresh = true) ;
  --   id 30 : (card2, EN, normal) expiré depuis longtemps -> is_fresh = false.
  PERFORM pg_temp.rows_as('service_role',
    $q$INSERT INTO public.price_snapshots (id, card_id, language, source, trend_cents, fetched_at, expires_at)
    VALUES (10, 't5-card-2', 'FR', 'cardmarket', 111, TIMESTAMPTZ '2025-01-01 09:00:00+00', TIMESTAMPTZ '2025-01-01 09:15:00+00'),
           (20, 't5-card-2', 'FR', 'cardmarket', 222, TIMESTAMPTZ '2025-01-01 09:00:00+00', TIMESTAMPTZ '2025-01-01 09:15:00+00'),
           (5,  't5-card-2', 'FR', 'cardmarket', 333, now(), now() + interval '15 minutes'),
           (30, 't5-card-2', 'EN', 'tcgdex_fallback', 444, TIMESTAMPTZ '2025-01-01 08:00:00+00', TIMESTAMPTZ '2025-01-01 08:15:00+00')$q$);

  -- Exactement une ligne par tuple (card_id, language, variant).
  IF (SELECT count(*) FROM public.card_latest_prices WHERE card_id = 't5-card-2') <> 2 THEN
    RAISE EXCEPTION '[4] view must return one row per (card_id, language, variant), got % for t5-card-2',
      (SELECT count(*) FROM public.card_latest_prices WHERE card_id = 't5-card-2');
  END IF;

  -- Le fetched_at le plus récent gagne, même avec un id plus petit : id 5 attendu.
  SELECT id, is_fresh INTO v_id, v_fresh
    FROM public.card_latest_prices
   WHERE card_id = 't5-card-2' AND language = 'FR' AND variant = 'normal';
  IF v_id <> 5 THEN
    RAISE EXCEPTION '[4] latest snapshot must be the newest fetched_at (expected id 5, got %)',
      v_id;
  END IF;
  IF v_fresh IS NOT TRUE THEN
    RAISE EXCEPTION '[4] is_fresh must be true when expires_at > now(), got %', v_fresh;
  END IF;

  -- Départage à fetched_at égal : id le plus élevé (20) une fois le 5 purgé.
  PERFORM pg_temp.rows_as('service_role', $q$DELETE FROM public.price_snapshots WHERE id = 5$q$);
  SELECT id INTO v_id
    FROM public.card_latest_prices
   WHERE card_id = 't5-card-2' AND language = 'FR' AND variant = 'normal';
  IF v_id <> 20 THEN
    RAISE EXCEPTION '[4] on fetched_at equality, highest id must win (expected 20, got %)',
      v_id;
  END IF;

  -- Ligne expirée (id 30, EN) : is_fresh = false.
  IF (SELECT is_fresh FROM public.card_latest_prices WHERE card_id = 't5-card-2' AND language = 'EN')
    IS NOT FALSE THEN
    RAISE EXCEPTION '[4] is_fresh must be false when expires_at <= now()';
  END IF;

  -- Invariant global : une ligne de vue par tuple distinct de la table.
  IF (SELECT count(*) FROM public.card_latest_prices)
    <> (SELECT count(*) FROM (SELECT DISTINCT card_id, language, variant FROM public.price_snapshots) s) THEN
    RAISE EXCEPTION '[4] view must return one row per distinct (card_id, language, variant) tuple';
  END IF;

  RAISE NOTICE 'ok [4] card_latest_prices: one row per tuple, newest fetched_at wins, id tie-break, is_fresh';
END
$$;

-- ===========================================================================
-- 5. RLS & grants
-- ===========================================================================
DO $$
DECLARE
  v_superuser_count bigint;
BEGIN
  SELECT count(*) INTO v_superuser_count FROM public.price_snapshots;

  -- authenticated : SELECT autorisé sur la table (voir tout, USING (true))...
  PERFORM pg_temp.expect_rows(
    '[5] authenticated SELECT price_snapshots',
    'authenticated',
    'SELECT 1 FROM public.price_snapshots',
    v_superuser_count);
  -- ...et SELECT autorisé sur la vue (security_invoker : RLS de la table appliquée).
  PERFORM pg_temp.expect_rows(
    'authenticated SELECT card_latest_prices',
    'authenticated',
    'SELECT 1 FROM public.card_latest_prices',
    (SELECT count(DISTINCT (card_id, language, variant)) FROM public.price_snapshots));

  -- authenticated : aucune écriture (ni grant ni policy) — INSERT, UPDATE, DELETE.
  PERFORM pg_temp.expect_error(
    '[5] authenticated INSERT rejected',
    'authenticated',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
       VALUES ('t5-card-1', 'cardmarket', 100)$q$,
    '42501');
  PERFORM pg_temp.expect_error(
    '[5] authenticated UPDATE rejected',
    'authenticated',
    $q$UPDATE public.price_snapshots SET trend_cents = 1$q$,
    '42501');
  PERFORM pg_temp.expect_error(
    '[5] authenticated DELETE rejected',
    'authenticated',
    $q$DELETE FROM public.price_snapshots$q$,
    '42501');

  -- anon : aucun accès (aucun grant).
  PERFORM pg_temp.expect_error('[5] anon SELECT table rejected', 'anon',
    'SELECT 1 FROM public.price_snapshots', '42501');
  PERFORM pg_temp.expect_error('[5] anon SELECT view rejected', 'anon',
    'SELECT 1 FROM public.card_latest_prices', '42501');
  PERFORM pg_temp.expect_error(
    '[5] anon INSERT rejected',
    'anon',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
       VALUES ('t5-card-1', 'cardmarket', 100)$q$,
    '42501');

  -- service_role (BYPASSRLS) : cycle INSERT / UPDATE / DELETE complet.
  PERFORM pg_temp.expect_rows(
    '[5] service_role INSERT',
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
       VALUES ('t5-card-1', 'tcgdex_fallback', 700)$q$,
    1);
  PERFORM pg_temp.expect_rows(
    '[5] service_role UPDATE',
    'service_role',
    $q$UPDATE public.price_snapshots SET trend_cents = 701 WHERE trend_cents = 700$q$,
    1);
  IF (SELECT count(*) FROM public.price_snapshots WHERE trend_cents = 701) <> 1 THEN
    RAISE EXCEPTION '[5] service_role UPDATE not applied';
  END IF;
  PERFORM pg_temp.expect_rows(
    '[5] service_role DELETE',
    'service_role',
    $q$DELETE FROM public.price_snapshots WHERE trend_cents = 701$q$,
    1);

  -- ON DELETE CASCADE : supprimer une carte du catalogue purge ses snapshots.
  PERFORM pg_temp.rows_as(
    'service_role',
    $q$INSERT INTO public.price_snapshots (card_id, source, trend_cents)
       VALUES ('t5-card-2', 'cardmarket', 500)$q$);
  DELETE FROM public.catalog_cards WHERE id = 't5-card-2';
  IF EXISTS (SELECT 1 FROM public.price_snapshots WHERE card_id = 't5-card-2') THEN
    RAISE EXCEPTION '[5] deleting a catalog card must cascade to price_snapshots';
  END IF;

  RAISE NOTICE 'ok [5] RLS & grants: authenticated read-only, anon denied, service_role full access, cascade ok';
END
$$;

-- ===========================================================================
-- Nettoyage : tout le script s'exécute dans une transaction unique annulée
-- ci-dessous, y compris en cas d'échec d'une assertion (ON_ERROR_STOP coupe
-- psql, la connexion fermée annule alors la transaction ouverte).
-- ===========================================================================
ROLLBACK;

\echo ALL TESTS PASSED — 005_price_snapshots
