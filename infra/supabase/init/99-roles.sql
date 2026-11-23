-- PokéVault — dedicated Supabase service roles (docs/06-securite.md §5).
--
-- Mounted read-only in /docker-entrypoint-initdb.d/init-scripts/ of the
-- supabase/postgres image. Its migrate.sh runs init-scripts/*.sql in glob
-- order *after* the built-in 0000…-*.sql files (which CREATE these roles with
-- no password), then runs the migrations/ folder. The 99- prefix guarantees
-- this file runs last among init scripts.
--
-- Each service connects with its own least-privilege role instead of a
-- superuser; every password derives from POSTGRES_PASSWORD (read from the
-- container environment).
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER USER postgres WITH PASSWORD :'pgpass';
