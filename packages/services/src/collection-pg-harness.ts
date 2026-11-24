import { Effect, Layer } from "effect";
import postgres from "postgres";
import { CatalogRepository, CatalogRepositoryLive } from "./catalog-repo.ts";
import {
  ALICE,
  BOB,
  COLLECTION_FIXTURE_CARDS,
  COLLECTION_FIXTURE_SERIES,
  COLLECTION_FIXTURE_SETS,
} from "./collection.fixture.ts";
import { DatabaseLive } from "./db.ts";

/**
 * Harnais des tests Postgres réels (`*.pg.test.ts`), ignorés sans `PGTEST_URL`.
 *
 *   docker run -d --name pv-t32-pg -e POSTGRES_PASSWORD=pgtest -p 54398:5432 \
 *     -v "$PWD/infra/supabase/init/99-roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro" \
 *     supabase/postgres:15.8.1.085
 *   # migrations 001, 002 puis 004 jouées en `supabase_admin` (003 requiert GoTrue : inutile ici ;
 *   # 004 requiert les colonnes `public`, `file_size_limit`, `allowed_mime_types` de storage.buckets,
 *   # normalement créées par storage-api).
 *   PGTEST_URL=postgres://supabase_admin:pgtest@127.0.0.1:54398/postgres pnpm vitest run .pg.test
 *
 * - `PGTEST_URL` : superuser (`supabase_admin`) — setup des fixtures, hors RLS.
 * - `PGTEST_APP_URL` (optionnel) : rôle applicatif ; défaut = `PGTEST_URL` avec l'utilisateur
 *   `authenticator` (même mot de passe, voir `infra/supabase/init/99-roles.sql`). Les services
 *   s'y connectent avec `connection: { role: "authenticated" }`, comme en production : la RLS
 *   s'applique réellement.
 */
export const PGTEST_URL = process.env["PGTEST_URL"];

export const appConnectionString = (): string => {
  const explicit = process.env["PGTEST_APP_URL"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const url = new URL(PGTEST_URL ?? "postgres://localhost/postgres");
  url.username = "authenticator";
  return url.toString();
};

/** Pool applicatif : rôle `authenticator` → `authenticated` (RLS appliquée). */
export const appDatabaseLayer = (maxConnections = 4) =>
  DatabaseLive({
    connectionString: appConnectionString(),
    maxConnections,
    role: "authenticated",
  });

const EMAILS = ["alice.t32@pokevault.test", "bob.t32@pokevault.test"] as const;

/** Connexion superuser jetable pour préparer / nettoyer les données. */
export const withAdmin = async <A>(fn: (admin: postgres.Sql) => Promise<A>): Promise<A> => {
  const admin = postgres(PGTEST_URL ?? "", { max: 1, onnotice: () => undefined });
  try {
    return await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
};

/** Purge les données utilisateur de test (classeurs, exemplaires) sans toucher au catalogue. */
export const resetUserData = (): Promise<void> =>
  withAdmin(async (admin) => {
    await admin`delete from public.binders where user_id in (${ALICE}, ${BOB})`;
    await admin`delete from public.user_card_copies where user_id in (${ALICE}, ${BOB})`;
  });

/** Clé de l'advisory lock qui sérialise les fichiers `*.pg.test.ts` partageant la base. */
const FIXTURE_LOCK_KEY = 32_000_001;
export const PG_HOOK_TIMEOUT_MS = 60_000;
let lockConnection: postgres.Sql | undefined;

/**
 * Vitest exécute les fichiers en parallèle sur la même base : un advisory lock de session
 * empêche deux fichiers `*.pg.test.ts` de s'exécuter en même temps (fixtures partagées,
 * `catalog-search.pg.test.ts` suppose un catalogue sans autres données). À appeler en
 * `beforeAll`, avec {@link releasePgLock} en `afterAll`.
 */
export const acquirePgLock = async (): Promise<void> => {
  lockConnection = postgres(PGTEST_URL ?? "", { max: 1, onnotice: () => undefined });
  await lockConnection`select pg_advisory_lock(${FIXTURE_LOCK_KEY})`;
};

export const releasePgLock = async (): Promise<void> => {
  if (lockConnection === undefined) return;
  const connection = lockConnection;
  lockConnection = undefined;
  await connection`select pg_advisory_unlock(${FIXTURE_LOCK_KEY})`.catch(() => undefined);
  await connection.end({ timeout: 5 });
};

/** Crée Alice et Bob (profils via le trigger GoTrue) + le mini catalogue `t32-*` (sous lock). */
export const seedPgFixture = async (): Promise<void> => {
  await acquirePgLock();
  await withAdmin(async (admin) => {
    await admin`delete from auth.users where id in (${ALICE}, ${BOB})`;
    await admin`delete from public.allowed_users where email in ${admin([...EMAILS])}`;
    await admin`insert into public.allowed_users (email, note) values
      (${EMAILS[0]}, 'test T3.2 A'), (${EMAILS[1]}, 'test T3.2 B')`;
    await admin`insert into auth.users (id, email, raw_user_meta_data) values
      (${ALICE}, ${EMAILS[0]}, '{"full_name": "Alice T32"}'),
      (${BOB}, ${EMAILS[1]}, '{"full_name": "Bob T32"}')`;
  });
  const adminLayer = DatabaseLive({ connectionString: PGTEST_URL ?? "", maxConnections: 1 });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* CatalogRepository;
        yield* repo.upsertSeries(COLLECTION_FIXTURE_SERIES);
        yield* repo.upsertSets(COLLECTION_FIXTURE_SETS);
        yield* repo.upsertCards(COLLECTION_FIXTURE_CARDS);
      }).pipe(Effect.provide(CatalogRepositoryLive.pipe(Layer.provideMerge(adminLayer)))),
    ),
  );
};

/** Supprime utilisateurs et catalogue de test (FK RESTRICT) puis libère le lock. */
export const dropPgFixture = async (): Promise<void> => {
  try {
    await withAdmin(async (admin) => {
      await admin`delete from auth.users where id in (${ALICE}, ${BOB})`;
      await admin`delete from public.allowed_users where email in ${admin([...EMAILS])}`;
      await admin`delete from public.catalog_cards where id like 't32-%'`;
      await admin`delete from public.catalog_sets where id like 't32-%'`;
      await admin`delete from public.catalog_series where id like 't32-%'`;
    });
  } finally {
    await releasePgLock();
  }
};
