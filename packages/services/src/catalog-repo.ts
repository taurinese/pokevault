import type { CatalogCard, CatalogSeries, CatalogSet } from "@pokevault/domain";
import { Context, Effect, Layer } from "effect";
import { Database, DatabaseError, type Sql } from "./db.ts";

// ---------------------------------------------------------------------------
// CatalogRepository service
// ---------------------------------------------------------------------------

/**
 * Persistence port for the TCGdex catalogue tables (`catalog_series`,
 * `catalog_sets`, `catalog_cards`). Every upsert is idempotent
 * (`INSERT ... ON CONFLICT (id) DO UPDATE SET ... WHERE ... IS DISTINCT FROM ...`,
 * so unchanged rows are never rewritten) and batched by {@link UPSERT_BATCH_SIZE}.
 * Callers must pass rows already deduplicated by `id` (Postgres cannot update
 * the same row twice in one statement) and by `(set_id, local_id)`.
 */
export interface CatalogRepositoryShape {
  readonly upsertSeries: (
    rows: ReadonlyArray<CatalogSeries>,
  ) => Effect.Effect<number, DatabaseError>;
  readonly upsertSets: (rows: ReadonlyArray<CatalogSet>) => Effect.Effect<number, DatabaseError>;
  readonly upsertCards: (rows: ReadonlyArray<CatalogCard>) => Effect.Effect<number, DatabaseError>;
}

/** Effect-TS service key of the catalogue repository. */
export class CatalogRepository extends Context.Service<CatalogRepository, CatalogRepositoryShape>()(
  "@pokevault/services/CatalogRepository",
) {}

/** Number of rows per `INSERT ... ON CONFLICT` statement. */
export const UPSERT_BATCH_SIZE = 500;

export const chunk = <A>(rows: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
};

// ---------------------------------------------------------------------------
// Postgres implementation (respects every constraint of 002_catalog.sql)
// ---------------------------------------------------------------------------

/**
 * Real Postgres implementation. Constraints of `supabase/migrations/002_catalog.sql`
 * are guaranteed upstream by the domain schemas (`CatalogSet` enforces
 * `total_count >= official_count`, `CatalogCard` enforces the `category`,
 * `holo_effect` and `available_variants` CHECKs); the `UNIQUE (set_id, local_id)`
 * constraint is safe because upserts conflict on the primary key `id`.
 */
export const CatalogRepositoryLive: Layer.Layer<CatalogRepository, never, Database> = Layer.effect(
  CatalogRepository,
  Effect.gen(function* () {
    const db = yield* Database;
    const query = <A>(statement: (sql: Sql) => Promise<A>): Effect.Effect<A, DatabaseError> =>
      Effect.tryPromise({
        try: () => statement(db.sql),
        catch: (cause) => new DatabaseError({ message: "postgres query failed", cause }),
      });
    const upsert = <A>(
      rows: ReadonlyArray<A>,
      statement: (sql: Sql, batch: ReadonlyArray<A>) => Promise<unknown>,
    ): Effect.Effect<number, DatabaseError> =>
      Effect.forEach(
        chunk(rows, UPSERT_BATCH_SIZE),
        (batch) => query((sql) => statement(sql, batch)),
        {
          concurrency: 1,
          discard: true,
        },
      ).pipe(Effect.as(rows.length));

    return {
      upsertSeries: (rows) =>
        upsert(
          rows,
          (sql, batch) => sql`
          INSERT INTO catalog_series ${sql(batch, "id", "name_fr", "name_en", "release_order")}
          ON CONFLICT (id) DO UPDATE SET
            name_fr = EXCLUDED.name_fr,
            name_en = EXCLUDED.name_en,
            release_order = EXCLUDED.release_order
          WHERE (catalog_series.name_fr, catalog_series.name_en, catalog_series.release_order)
            IS DISTINCT FROM (EXCLUDED.name_fr, EXCLUDED.name_en, EXCLUDED.release_order)
        `,
        ),
      upsertSets: (rows) =>
        upsert(
          rows,
          (sql, batch) => sql`
          INSERT INTO catalog_sets ${sql(
            batch,
            "id",
            "series_id",
            "code",
            "cardmarket_code",
            "name_fr",
            "name_en",
            "logo_url",
            "symbol_url",
            "release_date",
            "official_count",
            "total_count",
          )}
          ON CONFLICT (id) DO UPDATE SET
            series_id = EXCLUDED.series_id,
            code = EXCLUDED.code,
            cardmarket_code = EXCLUDED.cardmarket_code,
            name_fr = EXCLUDED.name_fr,
            name_en = EXCLUDED.name_en,
            logo_url = EXCLUDED.logo_url,
            symbol_url = EXCLUDED.symbol_url,
            release_date = EXCLUDED.release_date,
            official_count = EXCLUDED.official_count,
            total_count = EXCLUDED.total_count
          WHERE (
            catalog_sets.series_id,
            catalog_sets.code,
            catalog_sets.cardmarket_code,
            catalog_sets.name_fr,
            catalog_sets.name_en,
            catalog_sets.logo_url,
            catalog_sets.symbol_url,
            catalog_sets.release_date,
            catalog_sets.official_count,
            catalog_sets.total_count
          ) IS DISTINCT FROM (
            EXCLUDED.series_id,
            EXCLUDED.code,
            EXCLUDED.cardmarket_code,
            EXCLUDED.name_fr,
            EXCLUDED.name_en,
            EXCLUDED.logo_url,
            EXCLUDED.symbol_url,
            EXCLUDED.release_date,
            EXCLUDED.official_count,
            EXCLUDED.total_count
          )
        `,
        ),
      upsertCards: (rows) =>
        upsert(
          rows,
          (sql, batch) => sql`
          INSERT INTO catalog_cards ${sql(
            batch,
            "id",
            "set_id",
            "local_id",
            "local_id_numeric",
            "name_fr",
            "name_en",
            "rarity",
            "holo_effect",
            "category",
            "types",
            "hp",
            "illustrator",
            "image_base_url",
            "available_variants",
            "cardmarket_product_id",
            "cardmarket_url",
          )}
          ON CONFLICT (id) DO UPDATE SET
            set_id = EXCLUDED.set_id,
            local_id = EXCLUDED.local_id,
            local_id_numeric = EXCLUDED.local_id_numeric,
            name_fr = EXCLUDED.name_fr,
            name_en = EXCLUDED.name_en,
            rarity = EXCLUDED.rarity,
            holo_effect = EXCLUDED.holo_effect,
            category = EXCLUDED.category,
            types = EXCLUDED.types,
            hp = EXCLUDED.hp,
            illustrator = EXCLUDED.illustrator,
            image_base_url = EXCLUDED.image_base_url,
            available_variants = EXCLUDED.available_variants,
            cardmarket_product_id = EXCLUDED.cardmarket_product_id,
            cardmarket_url = EXCLUDED.cardmarket_url
          WHERE (
            catalog_cards.set_id,
            catalog_cards.local_id,
            catalog_cards.local_id_numeric,
            catalog_cards.name_fr,
            catalog_cards.name_en,
            catalog_cards.rarity,
            catalog_cards.holo_effect,
            catalog_cards.category,
            catalog_cards.types,
            catalog_cards.hp,
            catalog_cards.illustrator,
            catalog_cards.image_base_url,
            catalog_cards.available_variants,
            catalog_cards.cardmarket_product_id,
            catalog_cards.cardmarket_url
          ) IS DISTINCT FROM (
            EXCLUDED.set_id,
            EXCLUDED.local_id,
            EXCLUDED.local_id_numeric,
            EXCLUDED.name_fr,
            EXCLUDED.name_en,
            EXCLUDED.rarity,
            EXCLUDED.holo_effect,
            EXCLUDED.category,
            EXCLUDED.types,
            EXCLUDED.hp,
            EXCLUDED.illustrator,
            EXCLUDED.image_base_url,
            EXCLUDED.available_variants,
            EXCLUDED.cardmarket_product_id,
            EXCLUDED.cardmarket_url
          )
        `,
        ),
    } satisfies CatalogRepositoryShape;
  }),
);

// ---------------------------------------------------------------------------
// In-memory implementation (unit tests, 100 % offline)
// ---------------------------------------------------------------------------

export interface CatalogRepositoryMemory {
  readonly layer: Layer.Layer<CatalogRepository>;
  readonly series: Map<string, CatalogSeries>;
  readonly sets: Map<string, CatalogSet>;
  readonly cards: Map<string, CatalogCard>;
}

/** In-memory {@link CatalogRepository} layer for deterministic unit tests. */
export const makeCatalogRepositoryMemory = (): CatalogRepositoryMemory => {
  const series = new Map<string, CatalogSeries>();
  const sets = new Map<string, CatalogSet>();
  const cards = new Map<string, CatalogCard>();
  const impl: CatalogRepositoryShape = {
    upsertSeries: (rows) =>
      Effect.sync(() => {
        for (const row of rows) series.set(row.id, row);
        return rows.length;
      }),
    upsertSets: (rows) =>
      Effect.sync(() => {
        for (const row of rows) sets.set(row.id, row);
        return rows.length;
      }),
    upsertCards: (rows) =>
      Effect.sync(() => {
        for (const row of rows) cards.set(row.id, row);
        return rows.length;
      }),
  };
  return { layer: Layer.succeed(CatalogRepository, impl), series, sets, cards };
};
