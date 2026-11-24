-- 003_sync_discord_identity.sql
-- PokéVault — T1.3 (issue #8): synchronise `public.profiles.discord_user_id`
-- avec les identités OAuth Discord de GoTrue (`auth.identities`).
--
-- Sources de vérité :
--   * docs/04-integrations.md §3 (liaison `linkIdentity` + synchro discord_user_id)
--   * docs/02-modele-des-donnees.md §3 (`profiles.discord_user_id`)
--   * docs/06-securite.md §1 (liaison uniquement depuis une session authentifiée)
--
-- Ce que fait cette migration :
--   1. Fonction trigger `public.sync_discord_identity()` (SECURITY DEFINER,
--      propriétaire `postgres`, non exécutable par les rôles API) :
--        - INSERT / UPDATE d'une identité `discord` -> `discord_user_id` = ID Discord ;
--        - DELETE (ou changement de provider) d'une identité `discord` ->
--          `discord_user_id` = NULL s'il ne reste aucune identité Discord.
--   2. Trigger AFTER INSERT OR UPDATE OR DELETE sur `auth.identities`
--      (exécuté par `supabase_auth_admin` lors de `linkIdentity` / `unlinkIdentity`).
--   3. Rattrapage (backfill) des identités Discord déjà existantes.
--
-- `discord_user_id` n'est pas modifiable par `authenticated` (droit de colonne
-- retiré en 001) : cette synchro côté base est la seule source d'écriture.
--
-- Prérequis : migration 001 (table `profiles`, rôle `postgres` BYPASSRLS) et
-- schéma `auth` de GoTrue (`auth.identities`).

BEGIN;

-- Même garde-fou que 001 : `postgres` doit pouvoir écrire dans `profiles`
-- (FORCE ROW LEVEL SECURITY) depuis une fonction SECURITY DEFINER.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'postgres' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role postgres must have BYPASSRLS to own auth trigger functions';
  END IF;
END $$;

-- ============================================================================
-- 1. Fonction trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_discord_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_discord_id text;
BEGIN
  -- Identité Discord ajoutée ou mise à jour : on recopie l'ID Discord.
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.provider = 'discord' THEN
    v_discord_id := coalesce(
      nullif(NEW.identity_data ->> 'provider_id', ''),
      nullif(NEW.identity_data ->> 'sub', ''),
      nullif(NEW.provider_id, '')
    );
    UPDATE public.profiles
       SET discord_user_id = v_discord_id
     WHERE id = NEW.user_id
       AND discord_user_id IS DISTINCT FROM v_discord_id;
  END IF;

  -- Identité Discord supprimée (ou rattachée à un autre provider / utilisateur) :
  -- on efface l'ID s'il ne reste aucune identité Discord pour l'ancien utilisateur.
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.provider = 'discord'
     AND (
       TG_OP = 'DELETE'
       OR NEW.provider IS DISTINCT FROM 'discord'
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM auth.identities AS i
       WHERE i.user_id = OLD.user_id
         AND i.provider = 'discord'
     )
  THEN
    UPDATE public.profiles
       SET discord_user_id = NULL
     WHERE id = OLD.user_id
       AND discord_user_id IS NOT NULL;
  END IF;

  RETURN NULL; -- trigger AFTER : valeur de retour ignorée
END;
$$;

COMMENT ON FUNCTION public.sync_discord_identity() IS
  'Trigger auth.identities : maintient public.profiles.discord_user_id (alertes Discord ciblées).';

-- Propriétaire explicite `postgres` (BYPASSRLS sans privilège superuser) et
-- aucun droit d'exécution direct pour les rôles API.
ALTER FUNCTION public.sync_discord_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_discord_identity() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. Trigger sur `auth.identities`
-- ============================================================================

DROP TRIGGER IF EXISTS on_auth_identity_changed ON auth.identities;
CREATE TRIGGER on_auth_identity_changed
  AFTER INSERT OR UPDATE OR DELETE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION public.sync_discord_identity();

-- ============================================================================
-- 3. Rattrapage des identités Discord déjà liées avant cette migration
-- ============================================================================

UPDATE public.profiles AS p
   SET discord_user_id = coalesce(
         nullif(i.identity_data ->> 'provider_id', ''),
         nullif(i.identity_data ->> 'sub', ''),
         nullif(i.provider_id, '')
       )
  FROM auth.identities AS i
 WHERE i.user_id = p.id
   AND i.provider = 'discord'
   AND p.discord_user_id IS NULL;

COMMIT;
