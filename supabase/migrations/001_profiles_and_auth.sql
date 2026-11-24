-- 001_profiles_and_auth.sql
-- PokéVault — T1.1 (issue #6): profiles, invite-only allowlist & strict RLS.
--
-- Sources de vérité :
--   * docs/02-modele-des-donnees.md §3  (table `profiles`)
--   * docs/06-securite.md §1            (cercle restreint — table `allowed_users`)
--   * docs/06-securite.md §2 & §4       (RLS + FORCE RLS, prévention SSRF webhook Discord)
--
-- Ce que fait cette migration :
--   1. `public.profiles`      : 1 ligne par utilisateur GoTrue, RLS `auth.uid() = id`.
--   2. `public.allowed_users` : allowlist d'invitation, inaccessible aux clients
--                               (aucun droit pour anon / authenticated).
--   3. Triggers sur `auth.users` (exécutés par `supabase_auth_admin` lors des
--      INSERT de GoTrue) :
--        - BEFORE INSERT `enforce_allowed_user` : refuse tout e-mail hors allowlist ;
--        - AFTER  INSERT `handle_new_user`      : crée automatiquement le profil.
--
-- Prérequis : schéma `auth` de GoTrue (table `auth.users`, fonction `auth.uid()`)
-- et rôles Supabase (`anon`, `authenticated`, `service_role`). Le rôle qui joue
-- la migration (`postgres` ou `supabase_admin`) doit posséder l'attribut
-- BYPASSRLS (cas des deux rôles dans l'image `supabase/postgres`) : les
-- fonctions SECURITY DEFINER ci-dessous lisent `allowed_users` et écrivent dans
-- `profiles`, tables en FORCE ROW LEVEL SECURITY.

-- ============================================================================
-- 1. Fonctions utilitaires (triggers de `profiles`)
-- ============================================================================

-- Maintient `updated_at` (réutilisable par les futures tables).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- `id` et `created_at` sont immuables, même pour l'utilisateur propriétaire
-- (la RLS ne contrôle que la ligne, pas les colonnes modifiées).
CREATE OR REPLACE FUNCTION public.protect_profile_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'profiles.id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'profiles.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. Table `public.profiles` (docs/02 §3)
-- ============================================================================

CREATE TABLE public.profiles (
  id                     uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name           text        NOT NULL CHECK (char_length(trim(display_name)) > 0),
  avatar_initials        text        NOT NULL CHECK (char_length(avatar_initials) BETWEEN 1 AND 2),
  locale                 text        NOT NULL DEFAULT 'fr',
  currency               text        NOT NULL DEFAULT 'EUR',
  theme                  text        NOT NULL DEFAULT 'dark'
                                     CHECK (theme IN ('system', 'dark', 'light')),
  default_card_lang      text        NOT NULL DEFAULT 'FR'
                                     CHECK (default_card_lang IN ('FR', 'EN', 'JP', 'ZH')),
  default_card_condition text        NOT NULL DEFAULT 'NM'
                                     CHECK (default_card_condition IN ('M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO')),
  discord_user_id        text,
  -- Prévention SSRF (docs/06 §4) : seules les URLs de webhook Discord officielles.
  discord_webhook_url    text
                         CHECK (
                           discord_webhook_url IS NULL
                           OR discord_webhook_url ~ '^https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$'
                         ),
  push_enabled           boolean     NOT NULL DEFAULT false,
  discord_alerts_enabled boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profiles IS
  'Profil applicatif (1:1 avec auth.users). Créé par le trigger handle_new_user ; RLS auth.uid() = id.';

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER profiles_protect_immutable_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_immutable_columns();

-- ============================================================================
-- 3. RLS stricte sur `profiles`
-- ============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- Supabase accorde par défaut ALL aux rôles API sur les nouvelles tables :
-- on repart de zéro. Pas d'INSERT (trigger) ni de DELETE (cascade auth.users).
REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id);

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

-- ============================================================================
-- 4. Allowlist « cercle restreint » (docs/06 §1)
-- ============================================================================

CREATE TABLE public.allowed_users (
  email      text        PRIMARY KEY
                         CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  note       text,
  invited_by uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.allowed_users IS
  'Allowlist d''invitation (e-mails normalisés). Gérée uniquement via service_role / SQL admin.';

ALTER TABLE public.allowed_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allowed_users FORCE ROW LEVEL SECURITY;

-- Aucune politique pour anon / authenticated : la table est invisible côté API.
REVOKE ALL ON public.allowed_users FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.allowed_users TO service_role;

-- ============================================================================
-- 5. Triggers sur `auth.users` (exécutés avec les droits du propriétaire)
-- ============================================================================

-- BEFORE INSERT : refuse l'inscription d'un e-mail absent de l'allowlist.
CREATE OR REPLACE FUNCTION public.enforce_allowed_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.email IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.allowed_users AS au
       WHERE au.email = lower(btrim(NEW.email))
     )
  THEN
    RAISE EXCEPTION 'access_denied: email not in invite allowlist'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- AFTER INSERT : crée le profil avec un nom d'affichage et des initiales propres.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_display_name text;
  v_words        text[];
  v_initials     text;
BEGIN
  v_display_name := btrim(left(
    coalesce(
      nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(NEW.raw_user_meta_data ->> 'name'), ''),
      nullif(btrim(NEW.raw_user_meta_data ->> 'user_name'), ''),
      nullif(btrim(NEW.raw_user_meta_data ->> 'preferred_username'), ''),
      nullif(btrim(split_part(btrim(NEW.email), '@', 1)), ''),
      'Collectionneur'
    ),
    50
  ));

  -- Mots alphanumériques du nom (ponctuation, tirets, points, emojis ignorés).
  v_words := array_remove(regexp_split_to_array(v_display_name, '[^[:alnum:]]+'), '');

  v_initials := CASE
    WHEN cardinality(v_words) >= 2 THEN upper(left(v_words[1], 1) || left(v_words[2], 1))
    WHEN cardinality(v_words) = 1 THEN upper(left(v_words[1], 2))
    ELSE 'CO'
  END;

  INSERT INTO public.profiles (id, display_name, avatar_initials)
  VALUES (NEW.id, v_display_name, v_initials)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Les fonctions de trigger ne sont pas appelables par les rôles API
-- (l'exécution d'un trigger ne vérifie pas EXECUTE : GoTrue n'est pas affecté).
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_profile_immutable_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_allowed_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_allowed_user ON auth.users;
CREATE TRIGGER enforce_allowed_user
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_allowed_user();

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
