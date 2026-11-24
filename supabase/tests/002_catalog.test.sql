-- PokéVault — Tests d'intégration de la migration 002_catalog.sql.
-- Exécution (superuser) : psql -v ON_ERROR_STOP=1 -f supabase/tests/002_catalog.test.sql
-- Chaque bloc DO échoue (RAISE EXCEPTION) à la première assertion violée.
-- Isolé dans une transaction ROLLBACK : aucune donnée de test ne persiste.

BEGIN;

\echo '== 1. Insertion série / set / cartes =='
DO $$
BEGIN
  INSERT INTO public.catalog_series (id, name_fr, name_en, release_order)
  VALUES ('sv', 'Écarlate et Violet', 'Scarlet & Violet', 20);

  INSERT INTO public.catalog_sets
    (id, series_id, code, cardmarket_code, name_fr, name_en, release_date, official_count, total_count)
  VALUES
    ('sv03.5', 'sv', 'EV3.5', 'MEW', '151', '151', DATE '2023-09-22', 165, 207);

  INSERT INTO public.catalog_cards
    (id, set_id, local_id, local_id_numeric, name_fr, name_en, rarity, holo_effect,
     category, types, hp, illustrator, image_base_url, available_variants,
     cardmarket_product_id, cardmarket_url)
  VALUES
    ('sv03.5-199', 'sv03.5', '199', 199, 'Dracaufeu-ex', 'Charizard ex', 'sir', 'sir',
     'Pokemon', ARRAY['Fire'], 330, 'miki kudo',
     'https://assets.tcgdex.net/fr/sv/sv03.5/199', ARRAY['holo'],
     123456, 'https://www.cardmarket.com/fr/Pokemon/Products/Singles/151/Charizard-ex'),
    ('sv03.5-006', 'sv03.5', '006', 6, 'Dracaufeu', 'Charizard', 'Rare', 'holo',
     'Pokemon', ARRAY['Fire'], 150, 'Mitsuhiro Arita', NULL,
     ARRAY['normal', 'reverse', 'holo'], NULL, NULL),
    ('sv03.5-207', 'sv03.5', '207', 207, 'Énergie Feu', 'Fire Energy', NULL, 'none',
     'Energy', DEFAULT, NULL, NULL, NULL, DEFAULT, NULL, NULL);

  IF (SELECT count(*) FROM public.catalog_cards) <> 3 THEN
    RAISE EXCEPTION 'expected 3 catalog cards';
  END IF;
  IF (SELECT types FROM public.catalog_cards WHERE id = 'sv03.5-207') <> '{}' THEN
    RAISE EXCEPTION 'types default should be empty array';
  END IF;
  IF (SELECT search_vector FROM public.catalog_cards WHERE id = 'sv03.5-199') IS NULL THEN
    RAISE EXCEPTION 'search_vector should be generated';
  END IF;
END $$;

\echo '== 1b. Contraintes FK / updated_at =='
DO $$
DECLARE
  v_before timestamptz;
  v_after  timestamptz;
BEGIN
  BEGIN
    INSERT INTO public.catalog_sets (id, series_id, name_fr) VALUES ('x', 'unknown', 'X');
    RAISE EXCEPTION 'FK catalog_sets.series_id not enforced';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.catalog_series WHERE id = 'sv';
    RAISE EXCEPTION 'ON DELETE RESTRICT not enforced on catalog_sets.series_id';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_sets (id, series_id, name_fr, official_count)
    VALUES ('neg', 'sv', 'Neg', -1);
    RAISE EXCEPTION 'official_count >= 0 CHECK not enforced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_sets (id, series_id, name_fr, official_count, total_count)
    VALUES ('bad-counts', 'sv', 'Bad', 165, 100);
    RAISE EXCEPTION 'total_count >= official_count CHECK not enforced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr)
    VALUES ('dup-local', 'sv03.5', '199', 'Doublon');
    RAISE EXCEPTION 'UNIQUE (set_id, local_id) not enforced';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- now() étant figé dans une transaction, on recule updated_at via une valeur connue
  -- (le trigger écrase updated_at par now() à chaque UPDATE).
  UPDATE public.catalog_cards SET updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00' WHERE id = 'sv03.5-199';
  SELECT updated_at INTO v_after FROM public.catalog_cards WHERE id = 'sv03.5-199';
  IF v_after <= TIMESTAMPTZ '2000-01-01 00:00:00+00' THEN
    RAISE EXCEPTION 'updated_at trigger did not reset timestamp to now()';
  END IF;
END $$;

\echo '== 2. Contraintes CHECK =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr, holo_effect)
    VALUES ('bad-1', 'sv03.5', '1', 'Bad', 'rainbow');
    RAISE EXCEPTION 'invalid holo_effect accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr, available_variants)
    VALUES ('bad-2', 'sv03.5', '2', 'Bad', ARRAY['normal', 'shiny']);
    RAISE EXCEPTION 'invalid available_variants accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr, hp)
    VALUES ('bad-3', 'sv03.5', '3', 'Bad', 0);
    RAISE EXCEPTION 'hp = 0 accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr, hp)
    VALUES ('bad-4', 'sv03.5', '4', 'Bad', -10);
    RAISE EXCEPTION 'hp < 0 accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr, category)
    VALUES ('bad-5', 'sv03.5', '5', 'Bad', 'Stadium');
    RAISE EXCEPTION 'invalid category accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Toutes les variantes valides sont acceptées.
  INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr, available_variants)
  VALUES ('ok-1', 'sv03.5', '8', 'Ok',
          ARRAY['normal', 'reverse', 'holo', 'promo', 'pokeball', 'masterball']);
  DELETE FROM public.catalog_cards WHERE id = 'ok-1';
END $$;

\echo '== 3. Recherche plein texte (search_vector) =='
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199'
                   AND search_vector @@ websearch_to_tsquery('french', 'Dracaufeu')) THEN
    RAISE EXCEPTION 'FTS french name_fr "Dracaufeu" did not match sv03.5-199';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199'
                   AND search_vector @@ plainto_tsquery('simple', '199')) THEN
    RAISE EXCEPTION 'FTS local_id "199" did not match sv03.5-199';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-006'
                   AND search_vector @@ plainto_tsquery('simple', '6')) THEN
    RAISE EXCEPTION 'FTS local_id_numeric "6" did not match sv03.5-006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199'
                   AND search_vector @@ plainto_tsquery('simple', 'miki')) THEN
    RAISE EXCEPTION 'FTS illustrator "miki" did not match sv03.5-199';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199'
                   AND search_vector @@ plainto_tsquery('english', 'Charizard')) THEN
    RAISE EXCEPTION 'FTS english name_en "Charizard" did not match sv03.5-199';
  END IF;
  -- Pas de faux positif : "199" ne doit pas retourner la carte 006.
  IF EXISTS (SELECT 1 FROM public.catalog_cards
             WHERE id = 'sv03.5-006'
               AND search_vector @@ plainto_tsquery('simple', '199')) THEN
    RAISE EXCEPTION 'FTS "199" false positive on sv03.5-006';
  END IF;
END $$;

\echo '== 4. Recherche tolérante pg_trgm + présence des index =='
DO $$
DECLARE
  v_expected text[] := ARRAY[
    'idx_catalog_sets_series_release',
    'idx_catalog_cards_set_local_num',
    'idx_catalog_cards_search_vector',
    'idx_catalog_cards_name_fr_trgm',
    'idx_catalog_cards_rarity',
    'idx_catalog_cards_cm_product_id'
  ];
  v_idx text;
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199' AND name_fr ILIKE '%dracau%') THEN
    RAISE EXCEPTION 'ILIKE %%dracau%% did not match Dracaufeu-ex';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199' AND extensions.similarity(name_fr, 'Dracau') > 0.2) THEN
    RAISE EXCEPTION 'similarity(name_fr, Dracau) <= 0.2 for Dracaufeu-ex';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_cards
                 WHERE id = 'sv03.5-199' AND name_fr OPERATOR(extensions.%) 'Dracaufeux') THEN
    RAISE EXCEPTION 'trigram %% operator did not match typo "Dracaufeux"';
  END IF;

  FOREACH v_idx IN ARRAY v_expected LOOP
    SELECT indexdef INTO v_def FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = v_idx;
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'missing index %', v_idx;
    END IF;
  END LOOP;

  SELECT indexdef INTO v_def FROM pg_indexes WHERE indexname = 'idx_catalog_cards_search_vector';
  IF v_def NOT ILIKE '%USING gin (search_vector)%' THEN
    RAISE EXCEPTION 'search_vector index is not GIN: %', v_def;
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE indexname = 'idx_catalog_cards_name_fr_trgm';
  IF v_def NOT ILIKE '%USING gin (name_fr%gin_trgm_ops)%' THEN
    RAISE EXCEPTION 'name_fr trigram index is not GIN gin_trgm_ops: %', v_def;
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE indexname = 'idx_catalog_cards_cm_product_id';
  IF v_def NOT ILIKE '%WHERE (cardmarket_product_id IS NOT NULL)%' THEN
    RAISE EXCEPTION 'cm_product_id index is not partial: %', v_def;
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes WHERE indexname = 'idx_catalog_sets_series_release';
  IF v_def NOT ILIKE '%release_date DESC NULLS LAST%' THEN
    RAISE EXCEPTION 'sets index ordering wrong: %', v_def;
  END IF;
END $$;

\echo '== 5a. RLS : metadata (RLS + FORCE, politiques) =='
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_series', 'catalog_sets', 'catalog_cards'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = t
                     AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'RLS + FORCE not enabled on %', t;
    END IF;
    -- Seule politique : SELECT pour authenticated.
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = t
                        AND cmd = 'SELECT' AND roles = '{authenticated}') THEN
      RAISE EXCEPTION 'unexpected policies on %', t;
    END IF;
  END LOOP;
END $$;

\echo '== 5b. RLS : authenticated (SELECT ok, écriture refusée) =='
SET ROLE authenticated;
DO $$
DECLARE
  t text;
  n integer;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'expected role authenticated, got %', current_user;
  END IF;
  FOREACH t IN ARRAY ARRAY['catalog_series', 'catalog_sets', 'catalog_cards'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n < 1 THEN
      RAISE EXCEPTION 'authenticated cannot read rows of %', t;
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.catalog_series (id, name_fr) VALUES ('hack', 'Hack');
    RAISE EXCEPTION 'authenticated INSERT catalog_series succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_sets (id, series_id, name_fr) VALUES ('hack', 'sv', 'Hack');
    RAISE EXCEPTION 'authenticated INSERT catalog_sets succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr)
    VALUES ('hack', 'sv03.5', '999', 'Hack');
    RAISE EXCEPTION 'authenticated INSERT catalog_cards succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.catalog_series SET name_fr = 'Hack';
    RAISE EXCEPTION 'authenticated UPDATE catalog_series succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.catalog_sets SET name_fr = 'Hack';
    RAISE EXCEPTION 'authenticated UPDATE catalog_sets succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.catalog_cards SET name_fr = 'Hack';
    RAISE EXCEPTION 'authenticated UPDATE catalog_cards succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.catalog_series;
    RAISE EXCEPTION 'authenticated DELETE catalog_series succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.catalog_sets;
    RAISE EXCEPTION 'authenticated DELETE catalog_sets succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.catalog_cards;
    RAISE EXCEPTION 'authenticated DELETE catalog_cards succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

\echo '== 5c. RLS : anon (tout refusé) =='
SET ROLE anon;
DO $$
DECLARE
  t text;
  n integer;
BEGIN
  IF current_user <> 'anon' THEN
    RAISE EXCEPTION 'expected role anon, got %', current_user;
  END IF;
  FOREACH t IN ARRAY ARRAY['catalog_series', 'catalog_sets', 'catalog_cards'] LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      RAISE EXCEPTION 'anon SELECT on % succeeded', t;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.catalog_series (id, name_fr) VALUES ('hack', 'Hack');
    RAISE EXCEPTION 'anon INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

\echo '== 5d. RLS : service_role (écriture ok) =='
SET ROLE service_role;
DO $$
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'expected role service_role, got %', current_user;
  END IF;

  INSERT INTO public.catalog_series (id, name_fr, release_order) VALUES ('swsh', 'Épée et Bouclier', 19);
  INSERT INTO public.catalog_sets (id, series_id, name_fr) VALUES ('swsh1', 'swsh', 'Épée et Bouclier');
  INSERT INTO public.catalog_cards (id, set_id, local_id, name_fr)
  VALUES ('swsh1-1', 'swsh1', '1', 'Chenipan');

  UPDATE public.catalog_cards SET name_en = 'Caterpie' WHERE id = 'swsh1-1';
  UPDATE public.catalog_sets SET name_en = 'Sword & Shield' WHERE id = 'swsh1';
  UPDATE public.catalog_series SET name_en = 'Sword & Shield' WHERE id = 'swsh';
  IF (SELECT name_en FROM public.catalog_cards WHERE id = 'swsh1-1') <> 'Caterpie' THEN
    RAISE EXCEPTION 'service_role UPDATE had no effect';
  END IF;

  DELETE FROM public.catalog_cards WHERE id = 'swsh1-1';
  DELETE FROM public.catalog_sets WHERE id = 'swsh1';
  DELETE FROM public.catalog_series WHERE id = 'swsh';
  IF EXISTS (SELECT 1 FROM public.catalog_series WHERE id = 'swsh') THEN
    RAISE EXCEPTION 'service_role DELETE had no effect';
  END IF;
END $$;
RESET ROLE;

\echo '== 5e. RLS : postgres (rôle worker, écriture ok) =='
SET ROLE postgres;
DO $$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'expected role postgres, got %', current_user;
  END IF;
  INSERT INTO public.catalog_series (id, name_fr, release_order) VALUES ('xy', 'XY', 15);
  DELETE FROM public.catalog_series WHERE id = 'xy';
END $$;
RESET ROLE;

\echo '== 6. ON DELETE RESTRICT set -> cards =='
DO $$
BEGIN
  BEGIN
    DELETE FROM public.catalog_sets WHERE id = 'sv03.5';
    RAISE EXCEPTION 'ON DELETE RESTRICT not enforced on catalog_cards.set_id';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

ROLLBACK;

\echo 'OK — 002_catalog : toutes les assertions sont passées.'
