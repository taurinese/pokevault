-- 007_price_alerts.sql
-- PokéVault — T8.1 (issue #28) : alertes de prix (`price_alerts`), historique des
-- déclenchements (`alert_events`) et abonnements Web Push (`push_subscriptions`), avec RLS.
--
-- Numérotation : `005_price_snapshots.sql` et `006_wishlist_items.sql` existent déjà ;
-- le titre historique de l'issue est donc décalé en `007`. `008_share_links.sql` (issue #31)
-- est développée en parallèle et ne dépend pas de cette migration.
--
-- Sources de vérité :
--   * docs/02-modele-des-donnees.md §4  (`price_alerts`, `alert_events`, `push_subscriptions`)
--     et §5 (RLS, index critique `price_alerts(is_active, card_id)`)
--   * docs/06-securite.md §2            (isolation par utilisateur ; `price_alerts` jamais partagée)
--
-- Ce que fait cette migration :
--   1. `public.price_alerts` : une alerte = (carte, langue, variante, état minimum, champ de
--      prix `low_fr` | `trend`, seuil en centimes, canaux, cooldown). Colonnes `card_id`,
--      `language`, `is_active` lues telles quelles par `CardmarketPriceService` (priorité 1 du
--      cron de prix) ; `alert_events` + `price_alerts` lus par le Dashboard (dernière alerte).
--   2. `public.alert_events` : historique des déclenchements. SEUL le worker (`service_role`)
--      les crée ; l'utilisateur ne peut que les lire, les supprimer et poser `read_at`
--      (pastille verte non lue de la Navbar B). Trigger d'intégrité `user_id` = propriétaire de
--      l'alerte, et colonnes factuelles immuables.
--   3. `public.push_subscriptions` : abonnements Web Push (endpoint HTTPS unique) ; purge
--      automatique des endpoints 404/410 par le worker.
--   4. Triggers : `updated_at`, colonnes immuables (SET search_path = ''), RLS activée ET forcée,
--      aucun droit pour `PUBLIC` / `anon`.
--
-- Prérequis : migrations 001 (`profiles`, `set_updated_at()`) et 002 (`catalog_cards`),
-- rôles Supabase. Comme 001–006, cette migration est jouée par `supabase_admin`.

BEGIN;

-- ============================================================================
-- 0. Garde-fous de prérequis (échec explicite plutôt qu'erreur obscure)
-- ============================================================================
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'migration 001 (public.profiles, public.set_updated_at) must be applied before 007';
  END IF;
  IF to_regclass('public.catalog_cards') IS NULL THEN
    RAISE EXCEPTION 'migration 002 (public.catalog_cards) must be applied before 007';
  END IF;
END $$;

-- ============================================================================
-- 1. Fonctions de trigger (search_path verrouillé, aucun SECURITY DEFINER)
-- ============================================================================

CREATE FUNCTION public.protect_price_alert_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'price_alerts.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'price_alerts.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'price_alerts.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Intégrité : `alert_events.user_id` doit être le propriétaire de l'alerte référencée
-- (la RLS ne contrôle que `user_id`, pas la cohérence avec `alert_id`).
-- Exécutée en SECURITY INVOKER : le worker `service_role` (BYPASSRLS) lit `price_alerts`
-- sans entrave ; un rôle sans droit de lecture n'insère de toute façon pas.
CREATE FUNCTION public.check_alert_event_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT pa.user_id INTO v_owner FROM public.price_alerts AS pa WHERE pa.id = NEW.alert_id;
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'alert_events.user_id must match price_alerts.user_id of alert_id'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Seul `read_at` est modifiable (pastille non lue) ; tout le reste est un fait historique.
CREATE FUNCTION public.protect_alert_event_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'alert_events.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.alert_id IS DISTINCT FROM OLD.alert_id THEN
    RAISE EXCEPTION 'alert_events.alert_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'alert_events.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.observed_price_cents IS DISTINCT FROM OLD.observed_price_cents THEN
    RAISE EXCEPTION 'alert_events.observed_price_cents is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.threshold_cents IS DISTINCT FROM OLD.threshold_cents THEN
    RAISE EXCEPTION 'alert_events.threshold_cents is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.channels_sent IS DISTINCT FROM OLD.channels_sent THEN
    RAISE EXCEPTION 'alert_events.channels_sent is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.triggered_at IS DISTINCT FROM OLD.triggered_at THEN
    RAISE EXCEPTION 'alert_events.triggered_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.protect_push_subscription_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'push_subscriptions.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'push_subscriptions.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'push_subscriptions.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. Table `public.price_alerts` (docs/02 §4)
-- ============================================================================

CREATE TABLE public.price_alerts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  -- CASCADE : une alerte sur une carte retirée du catalogue n'a plus de sens.
  card_id           text        NOT NULL REFERENCES public.catalog_cards (id) ON DELETE CASCADE,
  language          text        NOT NULL DEFAULT 'FR'
                                CHECK (language IN ('FR', 'EN', 'JP', 'ZH')),
  variant           text        NOT NULL DEFAULT 'normal'
                                CHECK (variant IN ('normal', 'reverse', 'holo', 'promo', 'pokeball', 'masterball')),
  min_condition     text        NOT NULL DEFAULT 'NM'
                                CHECK (min_condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  price_field       text        NOT NULL DEFAULT 'low_fr'
                                CHECK (price_field IN ('low_fr', 'trend')),
  threshold_cents   integer     NOT NULL CHECK (threshold_cents > 0),
  is_active         boolean     NOT NULL DEFAULT true,
  notify_push       boolean     NOT NULL DEFAULT true,
  notify_discord    boolean     NOT NULL DEFAULT false,
  cooldown_hours    integer     NOT NULL DEFAULT 24
                                CHECK (cooldown_hours >= 1 AND cooldown_hours <= 168),
  last_triggered_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.price_alerts IS
  'Alertes de prix (carte / langue / variante / état minimum / seuil en centimes / canaux / cooldown). Jamais partagée. RLS auth.uid() = user_id.';
COMMENT ON COLUMN public.price_alerts.price_field IS
  '`low_fr` = prix le plus bas FR ; `trend` = tendance Cardmarket.';
COMMENT ON COLUMN public.price_alerts.threshold_cents IS
  'Seuil en centimes EUR : alerte quand le prix observé passe sous ce seuil (> 0).';
COMMENT ON COLUMN public.price_alerts.cooldown_hours IS
  'Délai minimal entre deux déclenchements (1 à 168 h, 24 h par défaut) ; référence : last_triggered_at.';

-- Index critique (docs/02 §5) : sélection rapide des alertes actives à évaluer par carte (cron).
CREATE INDEX idx_price_alerts_active_card
  ON public.price_alerts (is_active, card_id);

-- Liste des alertes de l'utilisateur (récentes d'abord) ; sert aussi la FK `user_id`.
CREATE INDEX idx_price_alerts_user
  ON public.price_alerts (user_id, updated_at DESC);

CREATE TRIGGER price_alerts_protect_immutable_columns
  BEFORE UPDATE ON public.price_alerts
  FOR EACH ROW EXECUTE FUNCTION public.protect_price_alert_immutable_columns();

CREATE TRIGGER price_alerts_set_updated_at
  BEFORE UPDATE ON public.price_alerts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. Table `public.alert_events` (docs/02 §4)
-- ============================================================================

CREATE TABLE public.alert_events (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id             uuid        NOT NULL REFERENCES public.price_alerts (id) ON DELETE CASCADE,
  user_id              uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  observed_price_cents integer     NOT NULL CHECK (observed_price_cents >= 0),
  threshold_cents      integer     NOT NULL CHECK (threshold_cents > 0),
  channels_sent        text[]      NOT NULL DEFAULT '{}'
                                   CHECK (channels_sent <@ ARRAY['push', 'discord']::text[]),
  -- NULL = non lu : pilote la pastille verte de la Navbar B.
  read_at              timestamptz,
  triggered_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.alert_events IS
  'Historique des déclenchements d''alertes. Créé uniquement par le worker (service_role) ; l''utilisateur lit, supprime et marque lu. RLS auth.uid() = user_id.';
COMMENT ON COLUMN public.alert_events.read_at IS
  'NULL = non lu (pastille verte Navbar B) ; seule colonne modifiable par l''utilisateur.';

-- Compteur / pastille « non lus ».
CREATE INDEX idx_alert_events_user_unread
  ON public.alert_events (user_id, triggered_at DESC)
  WHERE read_at IS NULL;

-- Historique paginé par curseur (triggered_at, id) — dernière alerte du Dashboard.
CREATE INDEX idx_alert_events_user_triggered
  ON public.alert_events (user_id, triggered_at DESC, id DESC);

-- Historique d'une alerte donnée ; sert aussi la FK `alert_id`.
CREATE INDEX idx_alert_events_alert
  ON public.alert_events (alert_id, triggered_at DESC);

CREATE TRIGGER alert_events_check_owner
  BEFORE INSERT ON public.alert_events
  FOR EACH ROW EXECUTE FUNCTION public.check_alert_event_owner();

CREATE TRIGGER alert_events_protect_immutable_columns
  BEFORE UPDATE ON public.alert_events
  FOR EACH ROW EXECUTE FUNCTION public.protect_alert_event_immutable_columns();

-- ============================================================================
-- 4. Table `public.push_subscriptions` (docs/02 §4)
-- ============================================================================

CREATE TABLE public.push_subscriptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  endpoint     text        NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh       text        NOT NULL CHECK (char_length(trim(p256dh)) > 0),
  auth         text        NOT NULL CHECK (char_length(trim(auth)) > 0),
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.push_subscriptions IS
  'Abonnements Web Push (un par navigateur/appareil, endpoint HTTPS unique). Purge 404/410 par le worker. RLS auth.uid() = user_id.';

CREATE INDEX idx_push_subscriptions_user
  ON public.push_subscriptions (user_id);

CREATE TRIGGER push_subscriptions_protect_immutable_columns
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.protect_push_subscription_immutable_columns();

-- ============================================================================
-- 5. Droits & RLS (activée ET forcée) — zéro accès `anon`
-- ============================================================================

REVOKE ALL ON TABLE public.price_alerts       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.alert_events       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.price_alerts       TO authenticated;
-- Pas d'INSERT pour `authenticated` : seul le worker crée les évènements.
GRANT SELECT, UPDATE, DELETE         ON TABLE public.alert_events       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_subscriptions TO authenticated;

GRANT ALL ON TABLE public.price_alerts       TO service_role;
GRANT ALL ON TABLE public.alert_events       TO service_role;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;

ALTER TABLE public.price_alerts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_alerts       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.alert_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_events       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions FORCE ROW LEVEL SECURITY;

-- price_alerts : CRUD du propriétaire.
CREATE POLICY price_alerts_select_own ON public.price_alerts
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY price_alerts_insert_own ON public.price_alerts
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY price_alerts_update_own ON public.price_alerts
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY price_alerts_delete_own ON public.price_alerts
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY price_alerts_service_role_all ON public.price_alerts
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- alert_events : lecture / marquage lu / suppression par le propriétaire (aucun INSERT).
CREATE POLICY alert_events_select_own ON public.alert_events
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY alert_events_update_own ON public.alert_events
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY alert_events_delete_own ON public.alert_events
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY alert_events_service_role_all ON public.alert_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- push_subscriptions : CRUD du propriétaire.
CREATE POLICY push_subscriptions_select_own ON public.push_subscriptions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY push_subscriptions_insert_own ON public.push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY push_subscriptions_update_own ON public.push_subscriptions
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY push_subscriptions_delete_own ON public.push_subscriptions
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Worker : évaluation des alertes, création d'évènements, envoi push + purge 404/410.
CREATE POLICY push_subscriptions_service_role_all ON public.push_subscriptions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- 6. Propriétaire & droits d'exécution des fonctions de trigger
-- ============================================================================

-- Même convention que 001 / 004 / 006 : propriétaire `postgres`, non exécutables par les
-- rôles API (l'exécution d'un trigger ne vérifie pas EXECUTE).
ALTER FUNCTION public.protect_price_alert_immutable_columns()       OWNER TO postgres;
ALTER FUNCTION public.check_alert_event_owner()                     OWNER TO postgres;
ALTER FUNCTION public.protect_alert_event_immutable_columns()       OWNER TO postgres;
ALTER FUNCTION public.protect_push_subscription_immutable_columns() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.protect_price_alert_immutable_columns()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_alert_event_owner()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_alert_event_immutable_columns()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_push_subscription_immutable_columns() FROM PUBLIC, anon, authenticated;

COMMIT;
