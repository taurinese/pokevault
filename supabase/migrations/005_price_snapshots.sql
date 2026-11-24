-- 005_price_snapshots.sql
-- PokéVault — T6.1 (issue #21) : cache de prix Cardmarket / TCGdex avec TTL,
-- vue `card_latest_prices` (dernier prix par (carte, langue, variante)) et
-- index critiques pour le lookup O(1), le contrôle TTL et le cooldown de refresh.

-- Sources de vérité :
--   * docs/02-modele-des-donnees.md §4      (`price_snapshots`, vue `card_latest_prices`)
--   * docs/02-modele-des-donnees.md §5      (RLS catalogue : SELECT authenticated,
--     écriture service_role uniquement ; index critiques)
--   * docs/04-integrations.md §2.1          (cache Postgres TTL ~15 min, cooldown 5 min)
--   * docs/06-securite.md                   (lecture authentifiée, aucune exposition anon)
--
-- Ce que fait cette migration :
--   1. `public.price_snapshots` : historique léger des prix (cache TTL 15 min) par
--      (card_id, language, variant). Insertion réservée au worker (`service_role`),
--      lecture `SELECT` pour les membres authentifiés, jamais pour `anon`.
--   2. Vue `card_latest_prices` (PostgreSQL 15, `security_invoker = on`) : dernier
--      snapshot par (card_id, language, variant) via DISTINCT ON ordonné
--      fetched_at DESC puis id DESC (départage en cas d'égalité de fetched_at),
--      avec `is_fresh` = `expires_at > now()` pour afficher la pastille de fraîcheur.
--   3. Index critiques (docs/02 §5) :
--      - idx_price_snapshots_lookup : (card_id, language, variant, fetched_at DESC, id DESC)
--        — lookup du dernier snapshot, alimentation de la vue, contrôle TTL ;
--      - idx_price_snapshots_expires_at : (expires_at) — purge des snapshots expirés ;
--      - idx_price_snapshots_card_fetched : (card_id, fetched_at DESC) — cooldown
--        du refresh manuel (5 min/carte) et historique par carte.
--
-- Convention (alignée sur 002_catalog.sql) : RLS activée ET forcée, aucun droit pour
-- PUBLIC / anon, SELECT pour `authenticated`, `service_role` (BYPASSRLS) écrit via le
-- worker. La vue `security_invoker` ne permet aucun contournement de la RLS par le
-- propriétaire de la vue : chaque lecture s'exécute avec les droits de l'appelant.
--
-- Prérequis : migration 002 (tables du catalogue `public.catalog_cards`).
-- Cette migration DOIT être jouée par `supabase_admin` (superuser), comme 001–004.

BEGIN;

-- ============================================================================
-- 0. Garde-fou de prérequis (échec explicite plutôt qu'une erreur obscure)
-- ============================================================================

DO $guard$
BEGIN
  IF to_regclass('public.catalog_cards') IS NULL THEN
    RAISE EXCEPTION 'migration 002 (public.catalog_cards) must be applied before 005';
  END IF;

  -- `security_invoker = true` sur les vues exige PostgreSQL 15+ (cible Supabase).
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'postgreSQL 15+ is required for view option security_invoker (found %)',
      current_setting('server_version');
  END IF;
END
$guard$;

-- ============================================================================
-- 1. Table `public.price_snapshots` (docs/02 §4)
-- ============================================================================

CREATE TABLE public.price_snapshots (
  id        bigserial PRIMARY KEY,
  card_id   text NOT NULL REFERENCES public.catalog_cards (id) ON DELETE CASCADE,

  -- Aligné sur `user_card_copies` (migration 004).
  language  text   NOT NULL DEFAULT 'FR'
            CHECK (language IN ('FR', 'EN', 'JP', 'ZH')),
  variant   text   NOT NULL DEFAULT 'normal'
            CHECK (variant IN ('normal', 'reverse', 'holo', 'promo', 'pokeball', 'masterball')),

  -- Source primaire (Cardmarket) ou repli TCGdex (indicatif).
  source    text   NOT NULL CHECK (source IN ('cardmarket', 'tcgdex_fallback')),

  -- Prix en centimes EUR ; chaque champ est soit absent, soit >= 0.
  -- Le cache ne doit jamais stocker une ligne vide : au moins un prix renseigné.
  trend_cents integer CHECK (trend_cents IS NULL OR trend_cents >= 0),
  low_fr_cents integer CHECK (low_fr_cents IS NULL OR low_fr_cents >= 0),
  avg30_cents integer CHECK (avg30_cents IS NULL OR avg30_cents >= 0),
  CONSTRAINT price_snapshots_at_least_one_price
    CHECK (coalesce(trend_cents, low_fr_cents, avg30_cents) IS NOT NULL),

  -- TTL : fraîcheur affichée en UI. Un snapshot reste > fetched_at.
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  CONSTRAINT price_snapshots_expires_after_fetched CHECK (expires_at > fetched_at)
);

COMMENT ON TABLE public.price_snapshots IS
  'Cache de prix (TTL 15 min) et historique léger, par (card_id, language, variant). Insertion worker (service_role), lecture authenticated.';
COMMENT ON COLUMN public.price_snapshots.low_fr_cents IS 'Plus bas prix FR (NM+) en centimes EUR.';
COMMENT ON COLUMN public.price_snapshots.fetched_at IS 'Horodatage de collecte ; sert au calcul de fraîcheur (TTL 15 min).';
COMMENT ON COLUMN public.price_snapshots.expires_at IS 'Limite de fraîcheur du cache : fetched_at + 15 minutes (Cardmarket, docs/04 §2.1).';

CREATE INDEX idx_price_snapshots_lookup
  ON public.price_snapshots (card_id, language, variant, fetched_at DESC, id DESC);

CREATE INDEX idx_price_snapshots_expires_at
  ON public.price_snapshots (expires_at);

CREATE INDEX idx_price_snapshots_card_fetched
  ON public.price_snapshots (card_id, fetched_at DESC);

-- ============================================================================
-- 2. Vue `card_latest_prices` (PostgreSQL 15, security_invoker)
-- ============================================================================

-- Dernier snapshot par (card_id, language, variant) : DISTINCT ON + ORDER BY
-- fetched_at DESC, id DESC (départage en cas d'égalité de fetched_at).
-- `security_invoker = true` : la RLS de `price_snapshots` s'applique à l'appelant
-- de la vue ; le propriétaire de la vue ne contourne jamais la RLS.
CREATE VIEW public.card_latest_prices
WITH (security_invoker = true) AS
SELECT DISTINCT ON (ps.card_id, ps.language, ps.variant)
  ps.id,
  ps.card_id,
  ps.language,
  ps.variant,
  ps.source,
  ps.trend_cents,
  ps.low_fr_cents,
  ps.avg30_cents,
  ps.fetched_at,
  ps.expires_at,
  (ps.expires_at > now()) AS is_fresh
FROM public.price_snapshots AS ps
ORDER BY ps.card_id, ps.language, ps.variant, ps.fetched_at DESC, ps.id DESC;

COMMENT ON VIEW public.card_latest_prices IS
  'Dernier prix connu par (card_id, language, variant), avec fraîcheur TTL (is_fresh). security_invoker: la RLS de price_snapshots s''applique.';

-- ============================================================================
-- 3. Droits & RLS (convention 002_catalog : lecture authenticated, écriture
--    service_role uniquement ; anon n'a aucun accès, authenticated n'écrit jamais)
-- ============================================================================

REVOKE ALL ON TABLE public.price_snapshots
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.price_snapshots_id_seq
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.card_latest_prices
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.price_snapshots, public.card_latest_prices
  TO authenticated;
GRANT ALL ON TABLE public.price_snapshots, public.card_latest_prices
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.price_snapshots_id_seq
  TO service_role;

ALTER TABLE public.price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY price_snapshots_select_authenticated
  ON public.price_snapshots
  FOR SELECT
  TO authenticated
  USING (true);
-- Le worker (`service_role`, BYPASSRLS) écrit les snapshots ; la policy ALL le
-- documente explicitement, aucun autre rôle n'a de droit d'écriture.
CREATE POLICY price_snapshots_service_role_all
  ON public.price_snapshots
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
