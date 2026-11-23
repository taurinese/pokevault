-- PokéVault — expose the JWT settings to Postgres (RLS helpers, auth.jwt()).
--
-- Mounted read-only in /docker-entrypoint-initdb.d/init-scripts/ (see
-- 99-roles.sql). JWT_SECRET / JWT_EXP come from the container environment.
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "${JWT_EXP:-3600}"`

ALTER DATABASE :"DBNAME" SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE :"DBNAME" SET "app.settings.jwt_exp" TO :'jwt_exp';
