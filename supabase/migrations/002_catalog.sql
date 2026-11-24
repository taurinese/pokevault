-- PokéVault — Migration 002 : catalogue TCGdex (series, sets, cards).
-- Réf. : docs/02-modele-des-donnees.md §2 & §5, docs/06-securite.md.
--
-- Données partagées synchronisées depuis TCGdex par le worker :
--   * lecture : rôle `authenticated` uniquement (RLS, aucune lecture `anon`) ;
--   * écriture : `service_role` uniquement (aucune politique INSERT/UPDATE/DELETE
--     pour `authenticated` / `anon`).
--
-- Cette migration est autonome (pas de dépendance à 001_*).

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- pg_trgm : recherche tolérante aux fautes de frappe ("Dracau" → Dracaufeu-ex).
-- Installée dans le schéma `extensions` (convention Supabase) ; les opérateurs
-- sont donc qualifiés (`extensions.gin_trgm_ops`, `extensions.similarity`).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Trigger générique updated_at (autonome, search_path verrouillé)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_catalog_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- catalog_series
-- ---------------------------------------------------------------------------
CREATE TABLE public.catalog_series (
  id            text PRIMARY KEY,
  name_fr       text NOT NULL,
  name_en       text,
  release_order integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- catalog_sets
-- ---------------------------------------------------------------------------
CREATE TABLE public.catalog_sets (
  id              text PRIMARY KEY,
  series_id       text NOT NULL REFERENCES public.catalog_series (id) ON DELETE RESTRICT,
  code            text,
  cardmarket_code text,
  name_fr         text NOT NULL,
  name_en         text,
  logo_url        text,
  symbol_url      text,
  release_date    date,
  official_count  integer NOT NULL DEFAULT 0 CHECK (official_count >= 0),
  total_count     integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  CHECK (total_count >= official_count),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalog_sets_series_release
  ON public.catalog_sets (series_id, release_date DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- catalog_cards
-- ---------------------------------------------------------------------------
CREATE TABLE public.catalog_cards (
  id                    text PRIMARY KEY,
  set_id                text NOT NULL REFERENCES public.catalog_sets (id) ON DELETE RESTRICT,
  local_id              text NOT NULL,
  local_id_numeric      integer,
  UNIQUE (set_id, local_id),
  name_fr               text NOT NULL,
  name_en               text,
  rarity                text,
  holo_effect           text NOT NULL DEFAULT 'none'
    CHECK (holo_effect IN ('none', 'holo', 'reverse', 'ex', 'sir', 'tera', 'gold')),
  category              text NOT NULL DEFAULT 'Pokemon'
    CHECK (category IN ('Pokemon', 'Trainer', 'Energy')),
  types                 text[] NOT NULL DEFAULT '{}',
  hp                    integer CHECK (hp IS NULL OR hp > 0),
  illustrator           text,
  image_base_url        text,
  available_variants    text[] NOT NULL DEFAULT '{}'
    CHECK (available_variants <@ ARRAY['normal', 'reverse', 'holo', 'promo', 'pokeball', 'masterball']::text[]),
  cardmarket_product_id integer,
  cardmarket_url        text,
  search_vector         tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('french',  coalesce(name_fr, '')),                  'A')
   || setweight(to_tsvector('english', coalesce(name_en, '')),                  'B')
   || setweight(to_tsvector('simple',  coalesce(local_id, '')),                 'A')
   || setweight(to_tsvector('simple',  coalesce(local_id_numeric::text, '')),   'A')
   || setweight(to_tsvector('simple',  coalesce(illustrator, '')),              'C')
  ) STORED,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Grille classeur + saisie au pavé `#` (tri naturel).
CREATE INDEX idx_catalog_cards_set_local_num
  ON public.catalog_cards (set_id, local_id_numeric, local_id);

-- Recherche plein texte pondérée.
CREATE INDEX idx_catalog_cards_search_vector
  ON public.catalog_cards USING GIN (search_vector);

-- Recherche tolérante aux fautes de frappe (ILIKE / similarity sur name_fr).
CREATE INDEX idx_catalog_cards_name_fr_trgm
  ON public.catalog_cards USING GIN (name_fr extensions.gin_trgm_ops);

CREATE INDEX idx_catalog_cards_rarity
  ON public.catalog_cards (rarity);

-- Rapprochement import CSV / scraping Cardmarket.
CREATE INDEX idx_catalog_cards_cm_product_id
  ON public.catalog_cards (cardmarket_product_id)
  WHERE cardmarket_product_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Triggers updated_at
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_catalog_series_updated_at
  BEFORE UPDATE ON public.catalog_series
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_updated_at();

CREATE TRIGGER trg_catalog_sets_updated_at
  BEFORE UPDATE ON public.catalog_sets
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_updated_at();

CREATE TRIGGER trg_catalog_cards_updated_at
  BEFORE UPDATE ON public.catalog_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_updated_at();

-- ---------------------------------------------------------------------------
-- Droits & RLS : lecture authenticated, écriture service_role uniquement
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.set_catalog_updated_at() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.catalog_series, public.catalog_sets, public.catalog_cards
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.catalog_series, public.catalog_sets, public.catalog_cards
  TO authenticated;
GRANT ALL ON public.catalog_series, public.catalog_sets, public.catalog_cards
  TO service_role;

ALTER TABLE public.catalog_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_sets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_cards  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_series FORCE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_sets   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_cards  FORCE ROW LEVEL SECURITY;

CREATE POLICY catalog_series_select_authenticated ON public.catalog_series
  FOR SELECT TO authenticated USING (true);
CREATE POLICY catalog_sets_select_authenticated ON public.catalog_sets
  FOR SELECT TO authenticated USING (true);
CREATE POLICY catalog_cards_select_authenticated ON public.catalog_cards
  FOR SELECT TO authenticated USING (true);
-- Aucune politique INSERT/UPDATE/DELETE : `service_role` (BYPASSRLS) écrit,
-- personne d'autre.

COMMIT;
