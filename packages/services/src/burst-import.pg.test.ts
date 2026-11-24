import {
  BurstImportCardNotFoundError,
  BurstImportQuantityOverflowError,
  type CatalogCard,
  type CatalogSet,
  MAX_CARD_COPY_QUANTITY,
  ValidationError,
} from "@pokevault/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  BurstImportService,
  BurstImportServiceLive,
  type BurstImportServiceShape,
} from "./burst-import.ts";
import { CatalogRepository, CatalogRepositoryLive } from "./catalog-repo.ts";
import { Database, DatabaseLive, type Sql } from "./db.ts";

/**
 * Real-Postgres tests of `BurstImportServiceLive`. They only run when
 * `PGTEST_URL` points at a Postgres where `supabase/migrations/001`–`004`
 * are applied (disposable `supabase/postgres` container, see the PR notes):
 *
 *   docker run -d --name pv-burst-pg -e POSTGRES_PASSWORD=pgtest -p 54397:5432 \
 *     -v $PWD/infra/supabase/init/99-roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro \
 *     -v $PWD/supabase/migrations:/docker-entrypoint-initdb.d/migrations:ro \
 *     supabase/postgres:15.8.1.085
 *
 *   PGTEST_URL=postgres://supabase_admin:pgtest@127.0.0.1:54397/postgres \
 *   PGTEST_AUTH_URL=postgres://authenticator:pgtest@127.0.0.1:54397/postgres \
 *     pnpm vitest run burst-import.pg
 *
 * `PGTEST_URL` is the admin connection used to seed (catalog + users);
 * `PGTEST_AUTH_URL` (defaults to `PGTEST_URL`) is the `authenticator` login
 * role used by the service under test, with `role: "authenticated"` so that
 * RLS really applies. Without `PGTEST_URL` (CI, offline dev) they are skipped.
 */
const PGTEST_URL = process.env["PGTEST_URL"];
const PGTEST_AUTH_URL = process.env["PGTEST_AUTH_URL"] ?? PGTEST_URL;

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const card = (
  id: string,
  setId: string,
  localId: string,
  numeric: number | null,
  nameFr: string,
  extra: Partial<CatalogCard> = {},
): CatalogCard => ({
  id,
  set_id: setId,
  local_id: localId,
  local_id_numeric: numeric,
  name_fr: nameFr,
  name_en: null,
  rarity: null,
  holo_effect: "none",
  category: "Pokemon",
  types: [],
  hp: null,
  illustrator: null,
  image_base_url: `https://assets.tcgdex.net/fr/${setId}/${localId}`,
  available_variants: ["normal"],
  cardmarket_product_id: null,
  cardmarket_url: null,
  ...extra,
});

const SETS: ReadonlyArray<CatalogSet> = [
  {
    id: "sv08",
    series_id: "sv",
    code: "SSP",
    cardmarket_code: "SSP",
    name_fr: "Étincelles Déferlantes",
    name_en: "Surging Sparks",
    logo_url: null,
    symbol_url: null,
    release_date: "2024-11-08",
    official_count: 191,
    total_count: 252,
  },
  {
    id: "sv03.5",
    series_id: "sv",
    code: "151",
    cardmarket_code: "MEW",
    name_fr: "151",
    name_en: "151",
    logo_url: null,
    symbol_url: null,
    release_date: "2023-09-22",
    official_count: 165,
    total_count: 207,
  },
  {
    id: "swsh12",
    series_id: "swsh",
    code: "SIT",
    cardmarket_code: "SIT",
    name_fr: "Tempête Argentée",
    name_en: "Silver Tempest",
    logo_url: null,
    symbol_url: null,
    release_date: "2022-11-11",
    official_count: 195,
    total_count: 245,
  },
];

const CARDS: ReadonlyArray<CatalogCard> = [
  // SIR : uniquement holo → auto-ajustement normal → holo.
  card("sv08-238", "sv08", "238", 238, "Pikachu ex SIR", {
    rarity: "Illustration spéciale rare",
    holo_effect: "sir",
    available_variants: ["holo"],
  }),
  // Téracristal sans variantes listées → normal → holo via holo_effect.
  card("sv08-100", "sv08", "100", 100, "Pikachu Téracristal", {
    rarity: "Rare Holo",
    holo_effect: "tera",
    available_variants: [],
  }),
  // Carte classique normal + reverse.
  card("sv03.5-006", "sv03.5", "006", 6, "Dracaufeu", {
    rarity: "Rare",
    holo_effect: "none",
    available_variants: ["normal", "reverse"],
  }),
  card("sv03.5-025", "sv03.5", "025", 25, "Pikachu", {
    rarity: "Commune",
    holo_effect: "none",
    available_variants: ["normal", "reverse", "holo"],
  }),
  // Carte d'une autre extension (test de setId).
  card("swsh12-030", "swsh12", "030", 30, "Ramboum", {
    rarity: "Commune",
    holo_effect: "none",
    available_variants: ["normal"],
  }),
];

const batch = (defaults: Record<string, unknown>, items: Array<Record<string, unknown>>) => ({
  defaults,
  items,
});

describe.skipIf(PGTEST_URL === undefined)("BurstImportServiceLive (Postgres réel)", () => {
  // Admin connection (seed + inspect): superuser / service role.
  const adminDbLayer = DatabaseLive({ connectionString: PGTEST_URL ?? "", maxConnections: 2 });
  // Service under test: `authenticator` login + `role: "authenticated"` → RLS active.
  const authDbLayer = DatabaseLive({
    connectionString: PGTEST_AUTH_URL ?? "",
    maxConnections: 2,
    role: "authenticated",
  });
  const serviceLayer = BurstImportServiceLive.pipe(Layer.provide(authDbLayer));
  const seedLayer = Layer.mergeAll(
    CatalogRepositoryLive.pipe(Layer.provide(adminDbLayer)),
    adminDbLayer,
  );

  const withAdmin = <A>(program: (sql: Sql) => Effect.Effect<A, unknown>): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* Database;
          return yield* program(db.sql);
        }).pipe(Effect.provide(adminDbLayer)),
      ),
    );

  const adminQuery = <A>(statement: (sql: Sql) => Promise<A>): Promise<A> =>
    withAdmin((sql) => Effect.tryPromise({ try: () => statement(sql), catch: (cause) => cause }));

  const withServiceE = <A>(
    program: (service: BurstImportServiceShape) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, unknown, never> =>
    Effect.scoped(
      Effect.gen(function* () {
        return yield* program(yield* BurstImportService);
      }).pipe(Effect.provide(serviceLayer)),
    );

  const withService = <A>(
    program: (service: BurstImportServiceShape) => Effect.Effect<A, unknown>,
  ): Promise<A> => Effect.runPromise(withServiceE(program));

  const seed = (): Promise<void> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* CatalogRepository;
          yield* repo.upsertSeries([
            { id: "sv", name_fr: "Écarlate et Violet", name_en: null, release_order: 12 },
            { id: "swsh", name_fr: "Épée et Bouclier", name_en: null, release_order: 11 },
          ]);
          yield* repo.upsertSets(SETS);
          yield* repo.upsertCards(CARDS);
          // Users (allowlist + auth.users → trigger creates public.profiles).
          const db = yield* Database;
          yield* Effect.tryPromise({
            try: () => db.sql`
              INSERT INTO public.allowed_users (email) VALUES ('alice@burst.test'), ('bob@burst.test')
              ON CONFLICT (email) DO NOTHING
            `,
            catch: (cause) => cause,
          });
          yield* Effect.tryPromise({
            try: () => db.sql`
              INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
                (${ALICE}, 'alice@burst.test', '{"full_name":"Alice A"}'),
                (${BOB}, 'bob@burst.test', '{"full_name":"Bob B"}')
              ON CONFLICT (id) DO NOTHING
            `,
            catch: (cause) => cause,
          });
        }).pipe(Effect.provide(seedLayer)),
      ),
    ).then(() => undefined);

  const reset = () =>
    adminQuery(async (sql) => {
      await sql`DELETE FROM public.user_card_copies`;
      await sql`DROP TABLE IF EXISTS public.wishlist_items`;
    });

  const copiesOf = (userId: string) =>
    adminQuery(
      (sql) => sql<
        {
          card_id: string;
          language: string;
          variant: string;
          condition: string;
          grading_company: string | null;
          grading_score: string | null;
          quantity: number;
        }[]
      >`
        SELECT card_id, language, variant, condition, grading_company, grading_score, quantity
        FROM public.user_card_copies
        WHERE user_id = ${userId}
        ORDER BY card_id, variant, condition
      `,
    );

  const seedCopy = (
    userId: string,
    cardId: string,
    variant: string,
    quantity: number,
    gradingCompany: string | null = null,
    gradingScore: string | null = null,
  ) =>
    adminQuery(
      (sql) => sql`
        INSERT INTO public.user_card_copies (user_id, card_id, language, variant, condition, quantity, grading_company, grading_score)
        VALUES (${userId}, ${cardId}, 'FR', ${variant}, 'NM', ${quantity}, ${gradingCompany}, ${gradingScore})
      `,
    );

  const createWishlistTable = () =>
    adminQuery(
      // Multi-statement DDL: raw `unsafe` (postgres.js prepares single statements).
      (sql) =>
        sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.wishlist_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
          card_id text NOT NULL REFERENCES public.catalog_cards (id) ON DELETE RESTRICT,
          language text NOT NULL DEFAULT 'FR' CHECK (language IN ('FR','EN','JP','ZH')),
          variant text NOT NULL DEFAULT 'normal' CHECK (variant IN ('normal','reverse','holo','promo','pokeball','masterball')),
          min_condition text NOT NULL DEFAULT 'NM',
          priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
          target_price_cents integer,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (user_id, card_id, language, variant)
        );
        ALTER TABLE public.wishlist_items ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.wishlist_items FORCE ROW LEVEL SECURITY;
        REVOKE ALL ON public.wishlist_items FROM PUBLIC, anon, authenticated;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.wishlist_items TO authenticated;
        DROP POLICY IF EXISTS wishlist_items_select_own ON public.wishlist_items;
        DROP POLICY IF EXISTS wishlist_items_insert_own ON public.wishlist_items;
        DROP POLICY IF EXISTS wishlist_items_delete_own ON public.wishlist_items;
        CREATE POLICY wishlist_items_select_own ON public.wishlist_items
          FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
        CREATE POLICY wishlist_items_insert_own ON public.wishlist_items
          FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
        CREATE POLICY wishlist_items_delete_own ON public.wishlist_items
          FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);
      `),
    );

  const wishlistOf = (userId: string) =>
    adminQuery(
      (sql) => sql<{ card_id: string }[]>`
        SELECT card_id FROM public.wishlist_items WHERE user_id = ${userId} ORDER BY card_id
      `,
    );

  it("commit: transaction atomique, upsert ON CONFLICT, auto-ajustement SIR/tera, preview sans écriture", async () => {
    await seed();
    await reset();

    // Preview: aucune écriture.
    const preview = await withService((service) =>
      service.previewBatch(
        ALICE,
        batch(
          {
            setId: "sv08",
            language: "FR",
            variant: "normal",
            condition: "NM",
            removeFromWishlist: true,
          },
          [
            { cardId: "sv08-238", quantity: 2 },
            { cardId: "sv08-100", quantity: 1 },
            { cardId: "sv08-100", quantity: 1 }, // doublon de ligne → consolidé
          ],
        ),
      ),
    );
    expect(preview.totalAddedQuantity).toBe(4);
    expect(preview.distinctCardsCount).toBe(2);
    expect(preview.newCardsCount).toBe(2);
    expect(preview.duplicateCardsCount).toBe(0);
    expect(preview.adjustedVariantsCount).toBe(2);
    expect(preview.wishlistRemovedCount).toBe(0); // pas de table wishlist_items → no-op
    const sir = preview.items.find((item) => item.cardId === "sv08-238");
    expect(sir).toMatchObject({
      resolvedVariant: "holo",
      variantAdjusted: true,
      addedQuantity: 2,
      newTotalQuantity: 2,
      wasNewCard: true,
      removedFromWishlist: false,
    });
    expect(await copiesOf(ALICE)).toEqual([]);

    // Commit réel.
    const report = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ setId: "sv08", language: "FR", variant: "normal", condition: "NM" }, [
          { cardId: "sv08-238", quantity: 2 },
          { cardId: "sv08-100", quantity: 2 },
        ]),
      ),
    );
    expect(report.totalAddedQuantity).toBe(4);
    expect(report.adjustedVariantsCount).toBe(2);
    expect(await copiesOf(ALICE)).toEqual([
      {
        card_id: "sv08-100",
        language: "FR",
        variant: "holo",
        condition: "NM",
        grading_company: null,
        grading_score: null,
        quantity: 2,
      },
      {
        card_id: "sv08-238",
        language: "FR",
        variant: "holo",
        condition: "NM",
        grading_company: null,
        grading_score: null,
        quantity: 2,
      },
    ]);

    // Re-commit sur le même slot : incrément via l'index unique (pas de doublon de ligne).
    const again = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ language: "FR", variant: "holo" }, [{ cardId: "sv08-238", quantity: 3 }]),
      ),
    );
    expect(again.items[0]).toMatchObject({
      resolvedVariant: "holo",
      variantAdjusted: false,
      wasNewCard: false,
      addedQuantity: 3,
      newTotalQuantity: 5,
    });
    expect(again.newCardsCount).toBe(0);
    expect(again.duplicateCardsCount).toBe(1);
    const rows = await copiesOf(ALICE);
    expect(rows.find((row) => row.card_id === "sv08-238")?.quantity).toBe(5);
    expect(rows).toHaveLength(2);
  });

  it("atomicité réelle : carte inconnue → rollback SQL complet (zéro écriture, wishlist intacte)", async () => {
    await seed();
    await reset();
    await createWishlistTable();
    await adminQuery(
      (sql) => sql`
        INSERT INTO public.wishlist_items (user_id, card_id, language, variant) VALUES
          (${ALICE}, 'sv08-238', 'FR', 'holo'),
          (${ALICE}, 'sv03.5-006', 'FR', 'normal')
      `,
    );

    const error = await Effect.runPromise(
      Effect.flip(
        withServiceE((service) =>
          service.commitBatch(
            ALICE,
            batch({ setId: "sv08", variant: "holo", removeFromWishlist: true }, [
              { cardId: "sv08-238", quantity: 2 },
              { cardId: "sv03.5-006", quantity: 1 }, // hors setId sv08 → introuvable
              { cardId: "totally-unknown", quantity: 1 },
            ]),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(BurstImportCardNotFoundError);
    if (error instanceof BurstImportCardNotFoundError) {
      expect([...error.missingCardIds].sort()).toEqual(["sv03.5-006", "totally-unknown"]);
    }
    // Rollback complet : aucune copie écrite, wishlist intacte.
    expect(await copiesOf(ALICE)).toEqual([]);
    expect(await wishlistOf(ALICE)).toEqual([{ card_id: "sv03.5-006" }, { card_id: "sv08-238" }]);
  });

  it("atomicité réelle : dépassement 999 → BurstImportQuantityOverflowError + rollback complet", async () => {
    await seed();
    await reset();
    await seedCopy(ALICE, "sv03.5-025", "normal", MAX_CARD_COPY_QUANTITY - 1);

    const error = await Effect.runPromise(
      Effect.flip(
        withServiceE((service) =>
          service.commitBatch(
            ALICE,
            batch({ variant: "normal", removeFromWishlist: true }, [
              { cardId: "sv03.5-025", quantity: 2 }, // 998 + 2 > 999
              { cardId: "sv03.5-006", quantity: 1 },
            ]),
          ),
        ),
      ),
    );
    expect(error).toBeInstanceOf(BurstImportQuantityOverflowError);
    if (error instanceof BurstImportQuantityOverflowError) {
      expect(error.cardId).toBe("sv03.5-025");
      expect(error.currentQuantity).toBe(MAX_CARD_COPY_QUANTITY - 1);
      expect(error.requestedDelta).toBe(2);
      expect(error.maxQuantity).toBe(MAX_CARD_COPY_QUANTITY);
    }
    const rows = await copiesOf(ALICE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(MAX_CARD_COPY_QUANTITY - 1);
  });

  it("ON CONFLICT sur user_card_copies_unique_slot_idx sans écraser une copie gradée PSA 10", async () => {
    await seed();
    await reset();
    await seedCopy(ALICE, "sv03.5-025", "holo", 1, "PSA", "10"); // copie gradée
    await seedCopy(ALICE, "sv03.5-025", "normal", 5); // slot non gradé

    const report = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ language: "FR", variant: "normal", condition: "NM" }, [
          { cardId: "sv03.5-025", quantity: 3 },
          { cardId: "sv03.5-025", quantity: 1, variant: "holo" }, // slot holo non gradé (distinct du PSA)
        ]),
      ),
    );
    // La carte est possédée (copie gradée) → doublon, pas nouvelle.
    expect(report.newCardsCount).toBe(0);
    expect(report.duplicateCardsCount).toBe(1);
    const rows = await copiesOf(ALICE);
    const graded = rows.find((row) => row.grading_company === "PSA");
    expect(graded).toMatchObject({ variant: "holo", quantity: 1, grading_score: "10" });
    expect(
      rows.find((row) => row.variant === "normal" && row.grading_company === null)?.quantity,
    ).toBe(8);
    expect(
      rows.find((row) => row.variant === "holo" && row.grading_company === null)?.quantity,
    ).toBe(1);
    expect(report.items.find((item) => item.resolvedVariant === "normal")).toMatchObject({
      newTotalQuantity: 8,
      wasNewCard: false,
    });
  });

  it("isolation RLS : Bob ne voit ni n'écrase les exemplaires d'Alice", async () => {
    await seed();
    await reset();
    await withService((service) =>
      service.commitBatch(ALICE, batch({ variant: "holo" }, [{ cardId: "sv08-238", quantity: 4 }])),
    );

    const bobPreview = await withService((service) =>
      service.previewBatch(BOB, batch({ variant: "holo" }, [{ cardId: "sv08-238", quantity: 1 }])),
    );
    expect(bobPreview.items[0]).toMatchObject({ wasNewCard: true, newTotalQuantity: 1 });

    await withService((service) =>
      service.commitBatch(BOB, batch({ variant: "holo" }, [{ cardId: "sv08-238", quantity: 2 }])),
    );
    expect((await copiesOf(ALICE)).find((row) => row.card_id === "sv08-238")?.quantity).toBe(4);
    expect((await copiesOf(BOB)).find((row) => row.card_id === "sv08-238")?.quantity).toBe(2);
  });

  it("wishlist réelle : DELETE ... RETURNING quand public.wishlist_items existe (removeFromWishlist true/false)", async () => {
    await seed();
    await reset();
    await createWishlistTable();
    await adminQuery(
      (sql) => sql`
        INSERT INTO public.wishlist_items (user_id, card_id, language, variant) VALUES
          (${ALICE}, 'sv08-238', 'FR', 'holo'),
          (${ALICE}, 'sv03.5-006', 'FR', 'normal'),
          (${BOB}, 'sv08-238', 'FR', 'holo')
      `,
    );

    const removed = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ variant: "holo", removeFromWishlist: true }, [{ cardId: "sv08-238", quantity: 1 }]),
      ),
    );
    expect(removed.wishlistRemovedCount).toBe(1);
    expect(removed.items[0]?.removedFromWishlist).toBe(true);
    expect(await wishlistOf(ALICE)).toEqual([{ card_id: "sv03.5-006" }]);
    expect(await wishlistOf(BOB)).toEqual([{ card_id: "sv08-238" }]); // RLS : Bob intact

    const kept = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ variant: "normal", removeFromWishlist: false }, [
          { cardId: "sv03.5-006", quantity: 1 },
        ]),
      ),
    );
    expect(kept.wishlistRemovedCount).toBe(0);
    expect(kept.items[0]?.removedFromWishlist).toBe(false);
    expect(await wishlistOf(ALICE)).toEqual([{ card_id: "sv03.5-006" }]);
  });

  it("sans table wishlist_items (pré-M3) : removeFromWishlist est un no-op sans erreur", async () => {
    await seed();
    await reset(); // reset() drops public.wishlist_items
    const report = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ variant: "holo", removeFromWishlist: true }, [{ cardId: "sv08-238", quantity: 1 }]),
      ),
    );
    expect(report.wishlistRemovedCount).toBe(0);
    expect(report.items[0]?.removedFromWishlist).toBe(false);
    expect(await copiesOf(ALICE)).toHaveLength(1);
  });

  it("validation : userId UUID et schéma du lot (ValidationError)", async () => {
    await seed();
    await reset();
    const badUser = await Effect.runPromise(
      Effect.flip(
        withServiceE((service) =>
          service.commitBatch("not-a-uuid", batch({}, [{ cardId: "sv08-238", quantity: 1 }])),
        ),
      ),
    );
    expect(badUser).toBeInstanceOf(ValidationError);
    const badBatch = await Effect.runPromise(
      Effect.flip(withServiceE((service) => service.commitBatch(ALICE, batch({}, [])))),
    );
    expect(badBatch).toBeInstanceOf(ValidationError);
  });

  it("une variante explicite (pokeball) est respectée même hors available_variants", async () => {
    await seed();
    await reset();
    const report = await withService((service) =>
      service.commitBatch(
        ALICE,
        batch({ variant: "normal" }, [
          { cardId: "swsh12-030", quantity: 1, variant: "pokeball", variantExplicit: true },
        ]),
      ),
    );
    expect(report.items[0]).toMatchObject({ resolvedVariant: "pokeball", variantAdjusted: false });
    expect((await copiesOf(ALICE))[0]?.variant).toBe("pokeball");
  });
});
