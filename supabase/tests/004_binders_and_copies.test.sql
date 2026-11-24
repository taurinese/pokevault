-- supabase/tests/004_binders_and_copies.test.sql
-- Tests d'intégration SQL de supabase/migrations/004_binders_and_copies.sql (issue #12).
--
-- À exécuter sur une vraie base Supabase (image `supabase/postgres` + GoTrue + storage-api),
-- APRÈS les migrations 001 à 004, en tant que superuser (`supabase_admin`) :
--
--   for f in 001_profiles_and_auth 002_catalog 003_sync_discord_identity 004_binders_and_copies; do
--     psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f supabase/migrations/$f.sql
--   done
--   psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
--        -f supabase/tests/004_binders_and_copies.test.sql
--
-- Le script change de rôle (SET ROLE) pour reproduire fidèlement :
--   * GoTrue          -> `supabase_auth_admin` (INSERT INTO auth.users) ;
--   * PostgREST / Storage (app) -> `authenticated` / `anon` + claims JWT (`auth.uid()`).
-- Une assertion qui échoue lève une exception et arrête psql (code retour != 0).
-- Toutes les données de test (@pokevault.test, catalogue `t4-*`, objets Storage) sont
-- purgées avant et après l'exécution : le script est rejouable.
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
-- Purge préalable (le script est rejouable)
-- ---------------------------------------------------------------------------

DELETE FROM storage.objects WHERE bucket_id IN ('binder-covers', 't4-other-bucket');
DELETE FROM storage.buckets WHERE id = 't4-other-bucket';
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000000%';
DELETE FROM public.allowed_users WHERE email LIKE '%@pokevault.test';
DELETE FROM public.catalog_cards WHERE id LIKE 't4-%';
DELETE FROM public.catalog_sets WHERE id LIKE 't4-%';
DELETE FROM public.catalog_series WHERE id LIKE 't4-%';

-- ===========================================================================
-- 0. Structure : RLS activée + forcée, droits, index, fonctions, bucket, policies
-- ===========================================================================
DO $$
DECLARE
  v_tbl text;
  v_def text;
  v_bucket storage.buckets;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['binders', 'binder_cards', 'user_card_copies'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = format('public.%I', v_tbl)::regclass AND relrowsecurity AND relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '[0] RLS must be ENABLED and FORCED on public.%', v_tbl;
    END IF;
    IF has_table_privilege('anon', format('public.%I', v_tbl), 'SELECT')
       OR has_table_privilege('anon', format('public.%I', v_tbl), 'INSERT')
       OR has_table_privilege('anon', format('public.%I', v_tbl), 'UPDATE')
       OR has_table_privilege('anon', format('public.%I', v_tbl), 'DELETE')
       OR has_table_privilege('public', format('public.%I', v_tbl), 'SELECT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'INSERT')
       OR NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'DELETE') THEN
      RAISE EXCEPTION '[0] unexpected base privileges on public.%', v_tbl;
    END IF;
    -- Exactement les 4 policies (SELECT/INSERT/UPDATE/DELETE) pour `authenticated`.
    IF (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_tbl AND roles = '{authenticated}') <> 4
       OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl) <> 4 THEN
      RAISE EXCEPTION '[0] public.% must have exactly 4 policies, all for authenticated', v_tbl;
    END IF;
  END LOOP;

  -- UPDATE table-level pour binders / copies ; colonne `position` seule pour binder_cards.
  IF NOT has_table_privilege('authenticated', 'public.binders', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.user_card_copies', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.binder_cards', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.binder_cards', 'position', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.binder_cards', 'binder_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.binder_cards', 'card_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.binder_cards', 'added_at', 'UPDATE') THEN
    RAISE EXCEPTION '[0] unexpected UPDATE privileges';
  END IF;

  -- Fonctions de trigger non exécutables par les rôles API.
  IF has_function_privilege('anon', 'public.protect_binder_immutable_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.protect_binder_immutable_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_binder_cards_custom_only()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.protect_binder_card_immutable_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.protect_user_card_copy_immutable_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION '[0] trigger functions must not be executable by anon/authenticated';
  END IF;

  -- Index exigés par docs/02 §3 & §5.
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'user_card_copies_unique_slot_idx';
  IF v_def IS NULL
     OR v_def NOT LIKE 'CREATE UNIQUE INDEX%'
     OR v_def NOT LIKE '%COALESCE(grading_company, ''''::text)%'
     OR v_def NOT LIKE '%COALESCE(grading_score, ''''::text)%' THEN
    RAISE EXCEPTION '[0] user_card_copies_unique_slot_idx must be the documented unique expression index: %', v_def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_card_copies'
                  AND indexdef LIKE '%(user_id, card_id)') THEN
    RAISE EXCEPTION '[0] missing index user_card_copies (user_id, card_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'binders'
                  AND indexdef LIKE '%(user_id, kind, is_pinned DESC, sort_order, created_at DESC)') THEN
    RAISE EXCEPTION '[0] missing listing index on binders';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'binder_cards'
                  AND indexdef LIKE '%(card_id)') THEN
    RAISE EXCEPTION '[0] missing index binder_cards (card_id)';
  END IF;

  -- Bucket `binder-covers` : privé, 2 Mio, MIME images raster uniquement (jamais SVG).
  SELECT * INTO v_bucket FROM storage.buckets WHERE id = 'binder-covers';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[0] bucket binder-covers is missing';
  END IF;
  IF v_bucket.name <> 'binder-covers'
     OR v_bucket.public IS DISTINCT FROM false
     OR v_bucket.file_size_limit IS DISTINCT FROM 2097152
     OR v_bucket.allowed_mime_types IS NULL
     OR NOT (v_bucket.allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
     OR NOT (v_bucket.allowed_mime_types <@ ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
     OR 'image/svg+xml' = ANY (v_bucket.allowed_mime_types) THEN
    RAISE EXCEPTION '[0] binder-covers bucket misconfigured: %', row_to_json(v_bucket);
  END IF;

  -- Policies Storage : 4 policies `authenticated`, aucune pour anon / PUBLIC.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname LIKE 'binder_covers_%' AND roles = '{authenticated}') <> 4
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'storage' AND tablename = 'objects'
                   AND qual LIKE '%binder-covers%' AND NOT (roles = '{authenticated}')) THEN
    RAISE EXCEPTION '[0] storage.objects must carry exactly the 4 binder_covers_* policies for authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'storage.objects'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '[0] RLS must be enabled on storage.objects';
  END IF;
  RAISE NOTICE 'ok [0] RLS enabled+forced, grants, indexes, bucket and storage policies';
END $$;

-- ===========================================================================
-- 1. Fixtures : 2 utilisateurs (Alice, Bob) + mini catalogue
-- ===========================================================================
INSERT INTO public.allowed_users (email, note) VALUES
  ('alice.t4@pokevault.test', 'test T3.1 A'),
  ('bob.t4@pokevault.test',   'test T3.1 B');

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'alice.t4@pokevault.test', '{"full_name": "Alice T4"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'bob.t4@pokevault.test',   '{"full_name": "Bob T4"}');

INSERT INTO public.catalog_series (id, name_fr) VALUES ('t4-sv', 'Série de test T4');
INSERT INTO public.catalog_sets (id, series_id, name_fr, official_count, total_count) VALUES
  ('t4-set-a', 't4-sv', 'Set A', 2, 2),
  ('t4-set-b', 't4-sv', 'Set B', 1, 1);
INSERT INTO public.catalog_cards (id, set_id, local_id, local_id_numeric, name_fr) VALUES
  ('t4-set-a-001', 't4-set-a', '001', 1, 'Carte A1'),
  ('t4-set-a-002', 't4-set-a', '002', 2, 'Carte A2'),
  ('t4-set-b-001', 't4-set-b', '001', 1, 'Carte B1');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.profiles WHERE id IN
        ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')) <> 2 THEN
    RAISE EXCEPTION '[1] fixtures: both profiles must exist';
  END IF;
  RAISE NOTICE 'ok [1] fixtures (Alice, Bob, catalogue t4-*)';
END $$;

-- ===========================================================================
-- 2. CRUD nominal (Alice, rôle `authenticated`)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  b  public.binders;
  c  public.user_card_copies;
BEGIN
  -- Classeur d'extension (cover par défaut = logo du set).
  PERFORM pg_temp.expect_rows('[2] insert set binder', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, set_id, title)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', %L, 'set', 't4-set-a', 'Set A')$q$, c_a), 1);
  -- Dossier perso vide (cover neutre par défaut).
  PERFORM pg_temp.expect_rows('[2] insert custom binder', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000002', %L, 'custom', 'Évolitions Favs')$q$, c_a), 1);
  -- Dossier perso avec cover = une carte.
  PERFORM pg_temp.expect_rows('[2] insert custom binder + card cover', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_card_id, is_pinned, sort_order)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000003', %L, 'custom', 'Doublons Échange',
               'card', 't4-set-a-002', true, 5)$q$, c_a), 1);
  -- Dossier perso avec cover uploadée (chemin = <user_id>/<id>.webp).
  PERFORM pg_temp.expect_rows('[2] insert custom binder + upload cover', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_storage_path)
       VALUES ('ca000000-0000-4000-8000-0000000000a1', %L, 'custom', 'Illustrateurs',
               'upload', %L)$q$, c_a, c_a::text || '/ca000000-0000-4000-8000-0000000000a1.webp'), 1);

  SELECT * INTO b FROM public.binders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
  IF b.cover_type <> 'set_logo' OR b.is_pinned OR b.sort_order <> 0
     OR b.cover_card_id IS NOT NULL OR b.cover_storage_path IS NOT NULL
     OR b.created_at IS NULL OR b.updated_at IS NULL THEN
    RAISE EXCEPTION '[2] unexpected binder defaults: %', row_to_json(b);
  END IF;

  -- Cartes d'un dossier perso.
  PERFORM pg_temp.expect_rows('[2] binder_cards insert', 'authenticated', c_a,
    $q$INSERT INTO public.binder_cards (binder_id, card_id, position) VALUES
       ('aaaaaaaa-0000-4000-8000-000000000002', 't4-set-a-001', 0),
       ('aaaaaaaa-0000-4000-8000-000000000002', 't4-set-b-001', 1),
       ('aaaaaaaa-0000-4000-8000-000000000003', 't4-set-a-001', DEFAULT)$q$, 3);
  PERFORM pg_temp.expect_rows('[2] binder_cards move (position)', 'authenticated', c_a,
    $q$UPDATE public.binder_cards SET position = 7
        WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002' AND card_id = 't4-set-a-001'$q$, 1);

  -- Exemplaires : sans grading (valeurs par défaut) puis avec grading.
  PERFORM pg_temp.expect_rows('[2] copy insert (defaults)', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (id, user_id, card_id, variant)
       VALUES ('cccccccc-0000-4000-8000-000000000001', %L, 't4-set-a-001', 'normal')$q$, c_a), 1);
  SELECT * INTO c FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001';
  IF c.language <> 'FR' OR c.condition <> 'NM' OR c.quantity <> 1
     OR c.purchase_price_cents IS NOT NULL OR c.grading_company IS NOT NULL OR c.grading_score IS NOT NULL
     OR c.notes IS NOT NULL OR c.acquired_at IS DISTINCT FROM current_date THEN
    RAISE EXCEPTION '[2] unexpected copy defaults: %', row_to_json(c);
  END IF;
  PERFORM pg_temp.expect_rows('[2] copy insert (graded)', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies
         (user_id, card_id, language, variant, condition, quantity, purchase_price_cents,
          grading_company, grading_score, notes, acquired_at)
       VALUES (%L, 't4-set-a-001', 'JP', 'holo', 'M', 2, 12500, 'PSA', '9.5', 'Cadeau', DATE '2024-05-01')$q$, c_a), 1);
  -- Même carte, autre slot : accepté (grading différent / langue différente).
  PERFORM pg_temp.expect_rows('[2] copy other slots', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company, grading_score) VALUES
         (%L, 't4-set-a-001', 'normal', 'PSA', '10'),
         (%L, 't4-set-a-001', 'normal', 'BGS', '10'),
         (%L, 't4-set-a-001', 'reverse', NULL, NULL)$q$, c_a, c_a, c_a), 3);
  -- Lecture / mise à jour / quantité.
  PERFORM pg_temp.expect_rows('[2] copy stepper', 'authenticated', c_a,
    $q$UPDATE public.user_card_copies SET quantity = quantity + 1, notes = 'maj'
        WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, 1);
  IF (SELECT quantity FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001') <> 2 THEN
    RAISE EXCEPTION '[2] copy quantity update failed';
  END IF;
  -- Mise à jour d'un classeur (réglages) : épingler, renommer, changer de cover.
  PERFORM pg_temp.expect_rows('[2] binder settings', 'authenticated', c_a,
    $q$UPDATE public.binders SET title = 'Set A (renommé)', is_pinned = true,
          cover_type = 'card', cover_card_id = 't4-set-a-001'
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 1);
  PERFORM pg_temp.expect_rows('[2] binder settings back to logo', 'authenticated', c_a,
    $q$UPDATE public.binders SET cover_type = 'set_logo', cover_card_id = NULL
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, 1);
  RAISE NOTICE 'ok [2] nominal CRUD (set + custom binders, binder_cards, copies with/without grading)';
END $$;

-- ===========================================================================
-- 3. Garde-fous CHECK / UNIQUE / FK / triggers (Alice)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  v_ins text := 'INSERT INTO public.binders (user_id, kind, set_id, title, cover_type, cover_card_id, cover_storage_path) VALUES ';
BEGIN
  -- --- binders : unicité, cohérence kind/set_id ---------------------------------------
  PERFORM pg_temp.expect_error('[3] duplicate (user_id, set_id)', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'set', 't4-set-a', 'Doublon', 'set_logo', NULL, NULL)$q$, c_a), '23505');
  PERFORM pg_temp.expect_error('[3] set binder without set_id', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'set', NULL, 'X', 'set_logo', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] custom binder with set_id', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', 't4-set-b', 'X', 'set_logo', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] invalid kind', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'folder', NULL, 'X', 'set_logo', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] unknown set_id (FK)', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'set', 't4-nope', 'X', 'set_logo', NULL, NULL)$q$, c_a), '23503');
  -- Deux dossiers perso homonymes sont permis (set_id NULL n'entre pas dans l'unicité).
  PERFORM pg_temp.expect_rows('[3] twin custom binders allowed', 'authenticated', c_a, format(
    v_ins || $q$(%L, 'custom', NULL, 'Jumeaux', 'set_logo', NULL, NULL), (%L, 'custom', NULL, 'Jumeaux', 'set_logo', NULL, NULL)$q$, c_a, c_a), 2);
  -- Alice et Bob peuvent chacun suivre le même set.
  PERFORM pg_temp.expect_rows('[3] same set for another user', 'authenticated', c_b, format(
    v_ins || $q$(%L, 'set', 't4-set-a', 'Set A', 'set_logo', NULL, NULL)$q$, c_b), 1);

  -- --- binders : titre ---------------------------------------------------------------
  PERFORM pg_temp.expect_error('[3] empty title', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, '', 'set_logo', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] blank title', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, E'  \t\n ', 'set_logo', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] NULL title', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, NULL, 'set_logo', NULL, NULL)$q$, c_a), '23502');
  PERFORM pg_temp.expect_error('[3] title > 80 chars', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, %L, 'set_logo', NULL, NULL)$q$, c_a, repeat('x', 81)), '23514');
  PERFORM pg_temp.expect_rows('[3] title = 80 chars accepted', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, %L, 'set_logo', NULL, NULL)$q$, c_a, repeat('é', 80)), 1);

  -- --- binders : cohérence de la cover -----------------------------------------------
  PERFORM pg_temp.expect_error('[3] invalid cover_type', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'banner', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] card cover without cover_card_id', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'card', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] upload cover without storage path', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'upload', NULL, NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] set_logo with cover_card_id', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'set_logo', 't4-set-a-001', NULL)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] set_logo with storage path', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'set_logo', NULL, %L)$q$, c_a, c_a::text || '/x.webp'), '23514');
  PERFORM pg_temp.expect_error('[3] card cover with storage path', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'card', 't4-set-a-001', %L)$q$, c_a, c_a::text || '/x.webp'), '23514');
  PERFORM pg_temp.expect_error('[3] upload cover with card id', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'upload', 't4-set-a-001', %L)$q$, c_a, c_a::text || '/x.webp'), '23514');
  PERFORM pg_temp.expect_error('[3] unknown cover card (FK)', 'authenticated', c_a,
    format(v_ins || $q$(%L, 'custom', NULL, 'X', 'card', 't4-nope', NULL)$q$, c_a), '23503');

  -- --- binders : chemin d'upload (anti-spoofing cross-user) --------------------------
  -- Chemin d'un autre utilisateur.
  PERFORM pg_temp.expect_error('[3] cover path of another user', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_storage_path)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000f1', %L, 'custom', 'X', 'upload',
               %L || '/aaaaaaaa-0000-4000-8000-0000000000f1.webp')$q$, c_a, c_b::text), '23514');
  -- Bon utilisateur mais id de classeur différent.
  PERFORM pg_temp.expect_error('[3] cover path with another binder id', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_storage_path)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000f2', %L, 'custom', 'X', 'upload',
               %L || '/bbbbbbbb-0000-4000-8000-0000000000f2.webp')$q$, c_a, c_a::text), '23514');
  -- Traversée, sous-dossier, mauvaise extension, absence de dossier, casse.
  PERFORM pg_temp.expect_error('[3] cover path traversal', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_storage_path)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000f3', %L, 'custom', 'X', 'upload',
               %L || '/../' || %L || '/aaaaaaaa-0000-4000-8000-0000000000f3.webp')$q$, c_a, c_a::text, c_b::text), '23514');
  PERFORM pg_temp.expect_error('[3] cover path wrong extension', 'authenticated', c_a, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_storage_path)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000f4', %L, 'custom', 'X', 'upload',
               %L || '/aaaaaaaa-0000-4000-8000-0000000000f4.svg')$q$, c_a, c_a::text), '23514');
  PERFORM pg_temp.expect_error('[3] cover path without user folder', 'authenticated', c_a,
    $q$INSERT INTO public.binders (id, user_id, kind, title, cover_type, cover_storage_path)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000f5', '00000000-0000-4000-8000-0000000000a1', 'custom', 'X', 'upload',
               'aaaaaaaa-0000-4000-8000-0000000000f5.webp')$q$, '23514');
  -- Chemin valide accepté puis interdit en UPDATE vers le chemin d'un autre.
  PERFORM pg_temp.expect_error('[3] switch cover path to another user via UPDATE', 'authenticated', c_a, format(
    $q$UPDATE public.binders SET cover_storage_path = %L || '/ca000000-0000-4000-8000-0000000000a1.webp'
        WHERE id = 'ca000000-0000-4000-8000-0000000000a1'$q$, c_b::text), '23514');

  -- --- binder_cards ------------------------------------------------------------------
  PERFORM pg_temp.expect_error('[3] binder_cards on a set binder', 'authenticated', c_a,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 't4-set-a-001')$q$, '23514');
  PERFORM pg_temp.expect_error('[3] binder_cards on a set binder (even as superuser)', 'supabase_admin', NULL,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 't4-set-a-001')$q$, '23514');
  PERFORM pg_temp.expect_error('[3] binder_cards on an unknown binder', 'supabase_admin', NULL,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-0000000000ee', 't4-set-a-001')$q$, '23514');
  PERFORM pg_temp.expect_error('[3] binder_cards duplicate PK', 'authenticated', c_a,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 't4-set-a-001')$q$, '23505');
  PERFORM pg_temp.expect_error('[3] binder_cards unknown card (FK)', 'authenticated', c_a,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 't4-nope')$q$, '23503');
  PERFORM pg_temp.expect_error('[3] binder_cards negative position', 'authenticated', c_a,
    $q$INSERT INTO public.binder_cards (binder_id, card_id, position) VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 't4-set-a-002', -1)$q$, '23514');
  PERFORM pg_temp.expect_error('[3] binder_cards negative position (UPDATE)', 'authenticated', c_a,
    $q$UPDATE public.binder_cards SET position = -1 WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '23514');
  -- Immutabilité (trigger : testée en superuser, qui contourne les droits de colonne).
  PERFORM pg_temp.expect_error('[3] binder_cards.binder_id immutable', 'supabase_admin', NULL,
    $q$UPDATE public.binder_cards SET binder_id = 'aaaaaaaa-0000-4000-8000-000000000003'
        WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002' AND card_id = 't4-set-b-001'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] binder_cards.card_id immutable', 'supabase_admin', NULL,
    $q$UPDATE public.binder_cards SET card_id = 't4-set-a-002'
        WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002' AND card_id = 't4-set-b-001'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] binder_cards.added_at immutable', 'supabase_admin', NULL,
    $q$UPDATE public.binder_cards SET added_at = now() - interval '1 day'
        WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002' AND card_id = 't4-set-b-001'$q$, '42501');
  -- Côté API, les colonnes immuables ne sont déjà pas modifiables (droit de colonne).
  PERFORM pg_temp.expect_error('[3] binder_cards.card_id not grantable via API', 'authenticated', c_a,
    $q$UPDATE public.binder_cards SET card_id = 't4-set-a-002'
        WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002' AND card_id = 't4-set-b-001'$q$, '42501');

  -- --- user_card_copies : CHECK ------------------------------------------------------
  PERFORM pg_temp.expect_error('[3] invalid language', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, language, variant) VALUES (%L, 't4-set-a-002', 'DE', 'normal')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] invalid variant', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant) VALUES (%L, 't4-set-a-002', 'shiny')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] missing variant', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id) VALUES (%L, 't4-set-a-002')$q$, c_a), '23502');
  PERFORM pg_temp.expect_error('[3] invalid condition', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, condition) VALUES (%L, 't4-set-a-002', 'normal', 'MINT')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] quantity = 0', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, quantity) VALUES (%L, 't4-set-a-002', 'normal', 0)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] quantity < 0', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, quantity) VALUES (%L, 't4-set-a-002', 'normal', -3)$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] quantity = 0 via UPDATE', 'authenticated', c_a,
    $q$UPDATE public.user_card_copies SET quantity = 0 WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, '23514');
  PERFORM pg_temp.expect_error('[3] purchase_price_cents < 0', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, purchase_price_cents) VALUES (%L, 't4-set-a-002', 'normal', -1)$q$, c_a), '23514');
  PERFORM pg_temp.expect_rows('[3] purchase_price_cents = 0 accepted', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, purchase_price_cents) VALUES (%L, 't4-set-a-002', 'normal', 0)$q$, c_a), 1);
  PERFORM pg_temp.expect_error('[3] unknown grading company', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company, grading_score) VALUES (%L, 't4-set-a-002', 'holo', 'ACE', '10')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] grading company without score', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company) VALUES (%L, 't4-set-a-002', 'holo', 'PSA')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] grading score without company', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_score) VALUES (%L, 't4-set-a-002', 'holo', '10')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] empty grading score', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company, grading_score) VALUES (%L, 't4-set-a-002', 'holo', 'PSA', '')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] blank grading score', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company, grading_score) VALUES (%L, 't4-set-a-002', 'holo', 'PSA', '   ')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] padded grading score', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company, grading_score) VALUES (%L, 't4-set-a-002', 'holo', 'PSA', ' 10')$q$, c_a), '23514');
  PERFORM pg_temp.expect_error('[3] grading score > 16 chars', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, grading_company, grading_score) VALUES (%L, 't4-set-a-002', 'holo', 'PSA', %L)$q$, c_a, repeat('9', 17)), '23514');
  PERFORM pg_temp.expect_error('[3] notes > 1000 chars', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, notes) VALUES (%L, 't4-set-a-002', 'reverse', %L)$q$, c_a, repeat('n', 1001)), '23514');
  PERFORM pg_temp.expect_rows('[3] notes = 1000 chars accepted', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant, notes) VALUES (%L, 't4-set-a-002', 'reverse', %L)$q$, c_a, repeat('n', 1000)), 1);
  PERFORM pg_temp.expect_error('[3] unknown card (FK)', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant) VALUES (%L, 't4-nope', 'normal')$q$, c_a), '23503');
  PERFORM pg_temp.expect_error('[3] unknown user (FK)', 'supabase_admin', NULL,
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant) VALUES (gen_random_uuid(), 't4-set-a-002', 'normal')$q$, '23503');

  -- --- user_card_copies : unicité du slot --------------------------------------------
  -- Slot sans grading déjà occupé (coalesce('') : NULL ne contourne pas l'unicité).
  PERFORM pg_temp.expect_error('[3] duplicate slot (no grading)', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant) VALUES (%L, 't4-set-a-001', 'normal')$q$, c_a), '23505');
  PERFORM pg_temp.expect_error('[3] duplicate slot (graded)', 'authenticated', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, language, variant, condition, grading_company, grading_score)
       VALUES (%L, 't4-set-a-001', 'JP', 'holo', 'M', 'PSA', '9.5')$q$, c_a), '23505');
  PERFORM pg_temp.expect_error('[3] duplicate slot via UPDATE', 'authenticated', c_a,
    $q$UPDATE public.user_card_copies SET variant = 'normal', language = 'FR', condition = 'NM'
        WHERE card_id = 't4-set-a-001' AND variant = 'reverse' AND grading_company IS NULL$q$, '23505');
  -- Un autre utilisateur peut posséder le même slot (testé en section 4 via Bob).

  -- --- Immutabilité (trigger) --------------------------------------------------------
  PERFORM pg_temp.expect_error('[3] binders.user_id immutable (API)', 'authenticated', c_a, format(
    $q$UPDATE public.binders SET user_id = %L WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, c_b), '42501');
  PERFORM pg_temp.expect_error('[3] binders.user_id immutable (superuser)', 'supabase_admin', NULL, format(
    $q$UPDATE public.binders SET user_id = %L WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, c_b), '42501');
  PERFORM pg_temp.expect_error('[3] binders.id immutable', 'authenticated', c_a,
    $q$UPDATE public.binders SET id = gen_random_uuid() WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] binders.kind immutable (custom -> set)', 'authenticated', c_a,
    $q$UPDATE public.binders SET kind = 'set', set_id = 't4-set-b' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] binders.kind immutable (set -> custom)', 'authenticated', c_a,
    $q$UPDATE public.binders SET kind = 'custom', set_id = NULL WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] binders.set_id immutable', 'authenticated', c_a,
    $q$UPDATE public.binders SET set_id = 't4-set-b' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] binders.created_at immutable', 'authenticated', c_a,
    $q$UPDATE public.binders SET created_at = now() - interval '10 days' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] copies.user_id immutable (API)', 'authenticated', c_a, format(
    $q$UPDATE public.user_card_copies SET user_id = %L WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, c_b), '42501');
  PERFORM pg_temp.expect_error('[3] copies.user_id immutable (superuser)', 'supabase_admin', NULL, format(
    $q$UPDATE public.user_card_copies SET user_id = %L WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, c_b), '42501');
  PERFORM pg_temp.expect_error('[3] copies.id immutable', 'authenticated', c_a,
    $q$UPDATE public.user_card_copies SET id = gen_random_uuid() WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, '42501');
  PERFORM pg_temp.expect_error('[3] copies.created_at immutable', 'authenticated', c_a,
    $q$UPDATE public.user_card_copies SET created_at = now() - interval '10 days' WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, '42501');
  RAISE NOTICE 'ok [3] CHECK / UNIQUE / FK / trigger guards';
END $$;

-- updated_at : avance à chaque UPDATE, même si le client tente de le figer.
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  v_before timestamptz;
  v_after  timestamptz;
BEGIN
  PERFORM pg_sleep(0.05);
  SELECT updated_at INTO v_before FROM public.binders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  PERFORM pg_temp.expect_rows('[3] updated_at binders', 'authenticated', c_a,
    $q$UPDATE public.binders SET title = 'Évolitions Favs 2', updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 1);
  SELECT updated_at INTO v_after FROM public.binders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002';
  IF v_after <= v_before THEN
    RAISE EXCEPTION '[3] binders.updated_at must advance on UPDATE (% -> %)', v_before, v_after;
  END IF;

  SELECT updated_at INTO v_before FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001';
  PERFORM pg_sleep(0.05);
  PERFORM pg_temp.expect_rows('[3] updated_at copies', 'authenticated', c_a,
    $q$UPDATE public.user_card_copies SET quantity = 5, updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'
        WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, 1);
  SELECT updated_at INTO v_after FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001';
  IF v_after <= v_before THEN
    RAISE EXCEPTION '[3] user_card_copies.updated_at must advance on UPDATE (% -> %)', v_before, v_after;
  END IF;
  RAISE NOTICE 'ok [3] updated_at triggers';
END $$;

-- ===========================================================================
-- 4. Étanchéité RLS : Alice vs Bob vs anon (tables)
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  v_t text;
BEGIN
  -- Bob possède déjà un classeur de set (section 3). Il ajoute dossier, cartes et exemplaires.
  PERFORM pg_temp.rows_as('authenticated', c_b, format(
    $q$INSERT INTO public.binders (id, user_id, kind, title) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', %L, 'custom', 'Dossier de Bob')$q$, c_b));
  PERFORM pg_temp.rows_as('authenticated', c_b,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 't4-set-a-001')$q$);
  -- Même slot que celui d'Alice : autorisé (l'unicité est par utilisateur).
  PERFORM pg_temp.rows_as('authenticated', c_b, format(
    $q$INSERT INTO public.user_card_copies (id, user_id, card_id, variant) VALUES ('cccccccc-0000-4000-8000-0000000000b1', %L, 't4-set-a-001', 'normal')$q$, c_b));

  -- Chacun ne voit que ses lignes.
  PERFORM pg_temp.expect_rows('[4] alice sees only her binders', 'authenticated', c_a,
    $q$SELECT * FROM public.binders$q$, (SELECT count(*) FROM public.binders WHERE user_id = c_a));
  PERFORM pg_temp.expect_rows('[4] alice sees none of bob binders', 'authenticated', c_a,
    $q$SELECT * FROM public.binders WHERE user_id = '00000000-0000-4000-8000-0000000000b1'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob sees only his binders', 'authenticated', c_b,
    $q$SELECT * FROM public.binders$q$, 2);
  PERFORM pg_temp.expect_rows('[4] bob sees none of alice binders', 'authenticated', c_b,
    $q$SELECT * FROM public.binders WHERE user_id = '00000000-0000-4000-8000-0000000000a1'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob cannot read alice binder_cards', 'authenticated', c_b,
    $q$SELECT * FROM public.binder_cards WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob sees only his binder_cards', 'authenticated', c_b,
    $q$SELECT * FROM public.binder_cards$q$, 1);
  PERFORM pg_temp.expect_rows('[4] bob sees only his copies', 'authenticated', c_b,
    $q$SELECT * FROM public.user_card_copies$q$, 1);
  PERFORM pg_temp.expect_rows('[4] alice sees none of bob copies', 'authenticated', c_a,
    $q$SELECT * FROM public.user_card_copies WHERE user_id = '00000000-0000-4000-8000-0000000000b1'$q$, 0);

  -- Écritures cross-user : lignes invisibles (0 ligne) ou refus RLS (42501).
  PERFORM pg_temp.expect_rows('[4] bob cannot update alice binder', 'authenticated', c_b,
    $q$UPDATE public.binders SET title = 'pwned' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob cannot delete alice binder', 'authenticated', c_b,
    $q$DELETE FROM public.binders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob cannot update alice copy', 'authenticated', c_b,
    $q$UPDATE public.user_card_copies SET quantity = 99 WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob cannot delete alice copy', 'authenticated', c_b,
    $q$DELETE FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob cannot update alice binder_cards', 'authenticated', c_b,
    $q$UPDATE public.binder_cards SET position = 9 WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 0);
  PERFORM pg_temp.expect_rows('[4] bob cannot delete alice binder_cards', 'authenticated', c_b,
    $q$DELETE FROM public.binder_cards WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 0);
  PERFORM pg_temp.expect_error('[4] bob cannot insert a binder for alice', 'authenticated', c_b, format(
    $q$INSERT INTO public.binders (user_id, kind, title) VALUES (%L, 'custom', 'Intrus')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[4] bob cannot insert a copy for alice', 'authenticated', c_b, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant) VALUES (%L, 't4-set-b-001', 'normal')$q$, c_a), '42501');
  -- Le trigger BEFORE INSERT (droits de l'appelant) ne voit pas le classeur d'Alice (RLS) et
  -- rejette en 23514 avant même le WITH CHECK ; dans tous les cas l'insertion est impossible.
  PERFORM pg_temp.expect_error('[4] bob cannot add cards to alice custom binder', 'authenticated', c_b,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000003', 't4-set-a-002')$q$, '23514');
  IF EXISTS (SELECT 1 FROM public.binder_cards WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000003' AND card_id = 't4-set-a-002') THEN
    RAISE EXCEPTION '[4] bob managed to add a card to alice binder';
  END IF;
  -- Bob ne peut pas « emprunter » le chemin de cover d'Alice pour son propre classeur.
  PERFORM pg_temp.expect_error('[4] bob cannot reuse alice cover path', 'authenticated', c_b, format(
    $q$INSERT INTO public.binders (user_id, kind, title, cover_type, cover_storage_path)
       VALUES (%L, 'custom', 'Vol de cover', 'upload', %L || '/ca000000-0000-4000-8000-0000000000a1.webp')$q$, c_b, c_a::text), '23514');
  -- Transfert de propriété de ses propres lignes vers Alice : refusé (WITH CHECK / trigger).
  PERFORM pg_temp.expect_error('[4] bob cannot gift his binder to alice', 'authenticated', c_b, format(
    $q$UPDATE public.binders SET user_id = %L WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001'$q$, c_a), '42501');

  -- Sans identité JWT (claims vides) : aucune ligne, aucune écriture.
  FOREACH v_t IN ARRAY ARRAY['binders', 'binder_cards', 'user_card_copies'] LOOP
    PERFORM pg_temp.expect_rows('[4] authenticated without sub sees nothing in ' || v_t, 'authenticated', NULL,
      format('SELECT * FROM public.%I', v_t), 0);
    -- anon : aucun privilège de table (refus avant même la RLS).
    PERFORM pg_temp.expect_error('[4] anon SELECT ' || v_t, 'anon', NULL, format('SELECT * FROM public.%I', v_t), '42501');
    PERFORM pg_temp.expect_error('[4] anon DELETE ' || v_t, 'anon', NULL, format('DELETE FROM public.%I', v_t), '42501');
  END LOOP;
  PERFORM pg_temp.expect_error('[4] anon INSERT binders', 'anon', c_a, format(
    $q$INSERT INTO public.binders (user_id, kind, title) VALUES (%L, 'custom', 'anon')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[4] anon INSERT copies', 'anon', c_a, format(
    $q$INSERT INTO public.user_card_copies (user_id, card_id, variant) VALUES (%L, 't4-set-a-002', 'normal')$q$, c_a), '42501');
  PERFORM pg_temp.expect_error('[4] anon INSERT binder_cards', 'anon', c_a,
    $q$INSERT INTO public.binder_cards (binder_id, card_id) VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 't4-set-a-002')$q$, '42501');
  PERFORM pg_temp.expect_error('[4] anon UPDATE binders', 'anon', c_a,
    $q$UPDATE public.binders SET title = 'anon'$q$, '42501');
  PERFORM pg_temp.expect_error('[4] authenticated without sub cannot insert', 'authenticated', NULL, format(
    $q$INSERT INTO public.binders (user_id, kind, title) VALUES (%L, 'custom', 'nobody')$q$, c_a), '42501');

  -- Rien n'a bougé du côté d'Alice.
  IF (SELECT title FROM public.binders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002') <> 'Évolitions Favs 2'
     OR (SELECT quantity FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001') <> 5 THEN
    RAISE EXCEPTION '[4] alice data was modified by another role';
  END IF;
  RAISE NOTICE 'ok [4] strict RLS isolation Alice / Bob / anon on binders, binder_cards, user_card_copies';
END $$;

-- ===========================================================================
-- 5. Suppression : cascades & RESTRICT
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
BEGIN
  -- Le catalogue référencé ne peut pas être supprimé (RESTRICT).
  PERFORM pg_temp.expect_error('[5] card used by a copy cannot be deleted', 'supabase_admin', NULL,
    $q$DELETE FROM public.catalog_cards WHERE id = 't4-set-a-001'$q$, '23503');
  PERFORM pg_temp.expect_error('[5] set used by a binder cannot be deleted', 'supabase_admin', NULL,
    $q$DELETE FROM public.catalog_sets WHERE id = 't4-set-a'$q$, '23503');
  PERFORM pg_temp.expect_error('[5] card used as cover cannot be deleted', 'supabase_admin', NULL,
    $q$DELETE FROM public.catalog_cards WHERE id = 't4-set-a-002'$q$, '23503');

  -- Supprimer un dossier perso supprime ses cartes.
  PERFORM pg_temp.expect_rows('[5] delete custom binder', 'authenticated', c_a,
    $q$DELETE FROM public.binders WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'$q$, 1);
  IF EXISTS (SELECT 1 FROM public.binder_cards WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION '[5] deleting a binder must cascade to binder_cards';
  END IF;
  -- Supprimer une carte du dossier ne touche pas à la collection.
  PERFORM pg_temp.expect_rows('[5] remove card from custom binder', 'authenticated', c_a,
    $q$DELETE FROM public.binder_cards WHERE binder_id = 'aaaaaaaa-0000-4000-8000-000000000003' AND card_id = 't4-set-a-001'$q$, 1);
  IF NOT EXISTS (SELECT 1 FROM public.user_card_copies WHERE user_id = c_a AND card_id = 't4-set-a-001') THEN
    RAISE EXCEPTION '[5] removing a card from a folder must not delete owned copies';
  END IF;
  PERFORM pg_temp.expect_rows('[5] delete copy', 'authenticated', c_a,
    $q$DELETE FROM public.user_card_copies WHERE id = 'cccccccc-0000-4000-8000-000000000001'$q$, 1);
  RAISE NOTICE 'ok [5] cascades and RESTRICT';
END $$;

-- ===========================================================================
-- 6. Storage `binder-covers` : isolation par préfixe `<auth.uid()>/<binder_id>.webp`
-- ===========================================================================
DO $$
DECLARE
  c_a constant uuid := '00000000-0000-4000-8000-0000000000a1';
  c_b constant uuid := '00000000-0000-4000-8000-0000000000b1';
  v_pa constant text := '00000000-0000-4000-8000-0000000000a1/ca000000-0000-4000-8000-0000000000a1.webp';
  v_pb constant text := '00000000-0000-4000-8000-0000000000b1/cb000000-0000-4000-8000-0000000000b1.webp';
  v_bad text;
  v_ins constant text := 'INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ';
BEGIN
  -- Objets de référence créés par le service (superuser) : 1 pour Alice, 1 pour Bob,
  -- et 1 dans un autre bucket au chemin « valide » (ne doit jamais être visible).
  INSERT INTO storage.buckets (id, name, public) VALUES ('t4-other-bucket', 't4-other-bucket', false);
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES
    ('binder-covers',   v_pa, c_a::text),
    ('binder-covers',   v_pb, c_b::text),
    ('t4-other-bucket', v_pa, c_a::text);

  -- Lecture : chacun ne voit que son objet, uniquement dans binder-covers.
  PERFORM pg_temp.expect_rows('[6] alice reads only her cover', 'authenticated', c_a,
    $q$SELECT * FROM storage.objects WHERE bucket_id = 'binder-covers'$q$, 1);
  PERFORM pg_temp.expect_rows('[6] alice cannot read bob cover', 'authenticated', c_a, format(
    $q$SELECT * FROM storage.objects WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pb), 0);
  PERFORM pg_temp.expect_rows('[6] bob reads only his cover', 'authenticated', c_b,
    $q$SELECT * FROM storage.objects WHERE bucket_id = 'binder-covers'$q$, 1);
  PERFORM pg_temp.expect_rows('[6] other buckets stay invisible to alice (no policy)', 'authenticated', c_a,
    $q$SELECT * FROM storage.objects WHERE bucket_id = 't4-other-bucket'$q$, 0);
  PERFORM pg_temp.expect_rows('[6] anon sees no cover', 'anon', NULL,
    $q$SELECT * FROM storage.objects WHERE bucket_id = 'binder-covers'$q$, 0);
  PERFORM pg_temp.expect_rows('[6] authenticated without sub sees no cover', 'authenticated', NULL,
    $q$SELECT * FROM storage.objects WHERE bucket_id = 'binder-covers'$q$, 0);

  -- Écriture : chemin exact dans son propre préfixe uniquement.
  PERFORM pg_temp.expect_rows('[6] alice inserts her second cover', 'authenticated', c_a, format(
    v_ins || $q$('binder-covers', %L || '/aaaaaaaa-0000-4000-8000-000000000003.webp', %L)$q$, c_a::text, c_a::text), 1);
  PERFORM pg_temp.expect_error('[6] alice cannot write in bob prefix', 'authenticated', c_a, format(
    v_ins || $q$('binder-covers', %L || '/aaaaaaaa-0000-4000-8000-000000000009.webp', %L)$q$, c_b::text, c_a::text), '42501');
  PERFORM pg_temp.expect_error('[6] alice cannot overwrite bob cover path', 'authenticated', c_a, format(
    v_ins || $q$('binder-covers', %L, %L)$q$, v_pb, c_a::text), '42501');
  PERFORM pg_temp.expect_error('[6] bob cannot write in alice prefix', 'authenticated', c_b, format(
    v_ins || $q$('binder-covers', %L || '/aaaaaaaa-0000-4000-8000-000000000008.webp', %L)$q$, c_a::text, c_b::text), '42501');
  PERFORM pg_temp.expect_error('[6] anon cannot insert', 'anon', NULL, format(
    v_ins || $q$('binder-covers', %L, NULL)$q$, v_pa), '42501');
  PERFORM pg_temp.expect_error('[6] authenticated without sub cannot insert', 'authenticated', NULL, format(
    v_ins || $q$('binder-covers', %L || '/aaaaaaaa-0000-4000-8000-000000000007.webp', NULL)$q$, c_a::text), '42501');
  PERFORM pg_temp.expect_error('[6] alice cannot write in another bucket', 'authenticated', c_a, format(
    v_ins || $q$('t4-other-bucket', %L || '/aaaaaaaa-0000-4000-8000-000000000006.webp', %L)$q$, c_a::text, c_a::text), '42501');

  -- Chemins mal formés dans son propre préfixe : refusés.
  FOREACH v_bad IN ARRAY ARRAY[
    c_a::text || '/../' || c_b::text || '/cb000000-0000-4000-8000-0000000000b1.webp',  -- traversée
    c_a::text || '/sub/aaaaaaaa-0000-4000-8000-000000000005.webp',                      -- 3 segments
    c_a::text || '/aaaaaaaa-0000-4000-8000-000000000005.png',                           -- extension
    c_a::text || '/aaaaaaaa-0000-4000-8000-000000000005.svg',                           -- SVG
    c_a::text || '/aaaaaaaa-0000-4000-8000-000000000005.webp.svg',                      -- double extension
    c_a::text || '/AAAAAAAA-0000-4000-8000-000000000005.webp',                          -- casse
    c_a::text || '/not-a-uuid.webp',                                                    -- id arbitraire
    c_a::text || '/',                                                                   -- dossier
    c_a::text || '.webp',                                                               -- pas de dossier
    'aaaaaaaa-0000-4000-8000-000000000005.webp',                                        -- racine
    upper(c_a::text) || '/aaaaaaaa-0000-4000-8000-000000000005.webp',                   -- préfixe en majuscules
    c_a::text || 'x/aaaaaaaa-0000-4000-8000-000000000005.webp',                         -- préfixe déformé
    E'\n' || c_a::text || '/aaaaaaaa-0000-4000-8000-000000000005.webp'                  -- caractère de contrôle
  ] LOOP
    PERFORM pg_temp.expect_error('[6] malformed path rejected: ' || replace(v_bad, E'\n', '\n'), 'authenticated', c_a,
      format(v_ins || '(%L, %L, %L)', 'binder-covers', v_bad, c_a::text), '42501');
  END LOOP;

  -- UPDATE / DELETE : seulement ses propres objets ; impossible de déplacer vers un autre préfixe.
  PERFORM pg_temp.expect_rows('[6] bob cannot update alice cover', 'authenticated', c_b, format(
    $q$UPDATE storage.objects SET metadata = '{"x":1}'::jsonb WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), 0);
  PERFORM pg_temp.expect_rows('[6] bob cannot delete alice cover', 'authenticated', c_b, format(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), 0);
  PERFORM pg_temp.expect_rows('[6] anon cannot update cover', 'anon', NULL, format(
    $q$UPDATE storage.objects SET metadata = '{"x":1}'::jsonb WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), 0);
  PERFORM pg_temp.expect_rows('[6] anon cannot delete cover', 'anon', NULL, format(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), 0);
  PERFORM pg_temp.expect_rows('[6] alice updates her cover', 'authenticated', c_a, format(
    $q$UPDATE storage.objects SET metadata = '{"x":1}'::jsonb WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), 1);
  PERFORM pg_temp.expect_error('[6] alice cannot rename her cover into bob prefix', 'authenticated', c_a, format(
    $q$UPDATE storage.objects SET name = %L WHERE bucket_id = 'binder-covers' AND name = %L$q$, c_b::text || '/aaaaaaaa-0000-4000-8000-000000000004.webp', v_pa), '42501');
  PERFORM pg_temp.expect_error('[6] alice cannot rename her cover to a malformed path', 'authenticated', c_a, format(
    $q$UPDATE storage.objects SET name = %L WHERE bucket_id = 'binder-covers' AND name = %L$q$, c_a::text || '/x.svg', v_pa), '42501');
  PERFORM pg_temp.expect_error('[6] alice cannot move her cover to another bucket', 'authenticated', c_a, format(
    $q$UPDATE storage.objects SET bucket_id = 't4-other-bucket' WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), '42501');
  PERFORM pg_temp.expect_rows('[6] alice deletes her cover', 'authenticated', c_a, format(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'binder-covers' AND name = %L$q$, v_pa), 1);
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'binder-covers' AND name = v_pb) THEN
    RAISE EXCEPTION '[6] bob cover must have survived';
  END IF;
  RAISE NOTICE 'ok [6] storage.objects isolation on binder-covers (Alice / Bob / anon)';
END $$;

-- ===========================================================================
-- 7. service_role (worker / partage public via fonction SECURITY DEFINER à venir)
-- ===========================================================================
DO $$
BEGIN
  IF pg_temp.rows_as('service_role', NULL, 'SELECT 1 FROM public.binders') < 3
     OR pg_temp.rows_as('service_role', NULL, 'SELECT 1 FROM public.user_card_copies') < 1
     OR pg_temp.rows_as('service_role', NULL, 'SELECT 1 FROM public.binder_cards') < 1 THEN
    RAISE EXCEPTION '[7] service_role must read all rows of binders / binder_cards / user_card_copies';
  END IF;
  RAISE NOTICE 'ok [7] service_role access';
END $$;

-- ===========================================================================
-- 8. Suppression d'un utilisateur : cascade vers binders / binder_cards / copies
-- ===========================================================================
DO $$
BEGIN
  DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000b1';
  IF EXISTS (SELECT 1 FROM public.binders WHERE user_id = '00000000-0000-4000-8000-0000000000b1')
     OR EXISTS (SELECT 1 FROM public.user_card_copies WHERE user_id = '00000000-0000-4000-8000-0000000000b1')
     OR EXISTS (SELECT 1 FROM public.binder_cards WHERE binder_id = 'bbbbbbbb-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION '[8] deleting a user must cascade to binders, binder_cards and user_card_copies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.binders WHERE user_id = '00000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION '[8] deleting bob must not touch alice data';
  END IF;
  RAISE NOTICE 'ok [8] ON DELETE CASCADE from auth.users';
END $$;

-- ---------------------------------------------------------------------------
-- Nettoyage final
-- ---------------------------------------------------------------------------
DELETE FROM storage.objects WHERE bucket_id IN ('binder-covers', 't4-other-bucket');
DELETE FROM storage.buckets WHERE id = 't4-other-bucket';
DELETE FROM auth.users WHERE lower(btrim(email)) LIKE '%@pokevault.test' OR id::text LIKE '00000000-0000-4000-8000-0000000000%';
DELETE FROM public.allowed_users WHERE email LIKE '%@pokevault.test';
DELETE FROM public.catalog_cards WHERE id LIKE 't4-%';
DELETE FROM public.catalog_sets WHERE id LIKE 't4-%';
DELETE FROM public.catalog_series WHERE id LIKE 't4-%';

\echo ALL TESTS PASSED — 004_binders_and_copies
