import { MAX_CARD_COPY_QUANTITY } from "@pokevault/domain";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BurstImportService, BurstImportServiceLive } from "./burst-import.ts";
import { ALICE, BOB } from "./collection.fixture.ts";
import {
  appDatabaseLayer,
  dropPgFixture,
  PG_HOOK_TIMEOUT_MS,
  PGTEST_URL,
  releasePgLock,
  resetUserData,
  seedPgFixture,
  withAdmin,
} from "./collection-pg-harness.ts";
import { failureOf } from "./collection-test-harness.ts";
import { WishlistService, WishlistServiceLive } from "./wishlist-service.ts";

const A1 = "t32-a-001";
const A2 = "t32-a-002";
const B1 = "t32-b-001";

/**
 * `WishlistServiceLive` contre Postgres réel (migrations 001, 002, 004 et 006 jouées, voir
 * `collection-pg-harness.ts`) : RLS Alice / Bob, `ON CONFLICT`, transaction atomique de
 * `markAcquired` et coexistence avec `BurstImportServiceLive`. Ignoré sans `PGTEST_URL`.
 *
 * Le harnais partage un advisory lock de session (`acquirePgLock` / `releasePgLock`, pris par
 * `seedPgFixture`, relâché par `dropPgFixture`) : deux fichiers `*.pg.test.ts` ne s'exécutent
 * jamais en même temps sur la base.
 */
describe.skipIf(PGTEST_URL === undefined)("WishlistService (Postgres réel)", () => {
  const layer = Layer.mergeAll(WishlistServiceLive, BurstImportServiceLive).pipe(
    Layer.provideMerge(appDatabaseLayer(6)),
  );

  // Chaque test construit (et ferme) son propre pool applicatif (rôle `authenticated`).
  const run = <A>(
    body: (ctx: {
      readonly wishlist: typeof WishlistService.Service;
      readonly burst: typeof BurstImportService.Service;
    }) => Effect.Effect<A, unknown>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* body({
            wishlist: yield* WishlistService,
            burst: yield* BurstImportService,
          });
        }).pipe(Effect.provide(layer)),
      ),
    );

  const wishlistRows = (userId: string) =>
    Effect.promise(() =>
      withAdmin(
        (admin) =>
          admin<Array<{ id: string; card_id: string; language: string; variant: string }>>`
            select id, card_id, language, variant from public.wishlist_items
             where user_id = ${userId} order by card_id, language, variant`,
      ),
    );

  const copyRows = (userId: string) =>
    Effect.promise(() =>
      withAdmin(
        (admin) =>
          admin<
            Array<{
              id: string;
              card_id: string;
              language: string;
              variant: string;
              condition: string;
              quantity: number;
            }>
          >`select id, card_id, language, variant, condition, quantity
              from public.user_card_copies where user_id = ${userId}
             order by card_id, language, variant, condition`,
      ),
    );

  const setBinderRows = (userId: string) =>
    Effect.promise(() =>
      withAdmin(
        (admin) =>
          admin<Array<{ id: string; set_id: string; title: string }>>`
            select id, set_id, title from public.binders
             where user_id = ${userId} and kind = 'set' order by set_id`,
      ),
    );

  const seedCopy = (userId: string, cardId: string, quantity: number) =>
    withAdmin(
      (admin) => admin`
        insert into public.user_card_copies (user_id, card_id, language, variant, condition, quantity)
        values (${userId}, ${cardId}, 'FR', 'normal', 'NM', ${quantity})`,
    );

  beforeAll(seedPgFixture, PG_HOOK_TIMEOUT_MS);
  beforeEach(async () => {
    await resetUserData();
    await withAdmin(
      (admin) => admin`delete from public.wishlist_items where user_id in (${ALICE}, ${BOB})`,
    );
  }, PG_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    try {
      await withAdmin(
        (admin) => admin`delete from public.wishlist_items where user_id in (${ALICE}, ${BOB})`,
      );
    } finally {
      await dropPgFixture();
      await releasePgLock();
    }
  }, PG_HOOK_TIMEOUT_MS);

  it("CRUD : défauts SQL, ajout, mise à jour, suppression, sérialisation des dates", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        expect(item).toMatchObject({
          userId: ALICE,
          cardId: A1,
          language: "FR",
          variant: "normal",
          minCondition: "NM",
          priority: "normal",
          targetPriceCents: null,
        });
        expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([item]);

        const updated = yield* wishlist.updateWishlistItem(ALICE, item.id, {
          priority: "high",
          minCondition: "EX",
          targetPriceCents: 1200,
        });
        expect(updated).toMatchObject({
          id: item.id,
          priority: "high",
          minCondition: "EX",
          targetPriceCents: 1200,
          createdAt: item.createdAt,
        });
        expect(updated.updatedAt > item.updatedAt).toBe(true);
        const cleared = yield* wishlist.updateWishlistItem(ALICE, item.id, {
          targetPriceCents: null,
        });
        expect(cleared.targetPriceCents).toBeNull();

        yield* wishlist.removeWishlistItem(ALICE, item.id);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([]);
        const again = yield* failureOf(wishlist.removeWishlistItem(ALICE, item.id));
        expect(again._tag).toBe("WishlistItemNotFoundError");
      }),
    ));

  it("slot unique : conflit typé, ifExists return, carte inconnue, entrées invalides", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const first = yield* wishlist.addWishlistItem(ALICE, { cardId: A1, priority: "high" });
        const conflict = yield* failureOf(wishlist.addWishlistItem(ALICE, { cardId: A1 }));
        expect(conflict).toMatchObject({ _tag: "WishlistItemConflictError", cardId: A1 });
        const again = yield* wishlist.addWishlistItem(ALICE, {
          cardId: A1,
          priority: "normal",
          ifExists: "return",
        });
        expect(again).toEqual(first);
        const en = yield* wishlist.addWishlistItem(ALICE, { cardId: A1, language: "EN" });
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1, variant: "reverse" });
        // Même slot pour Bob : autorisé.
        yield* wishlist.addWishlistItem(BOB, { cardId: A1 });

        // Déplacer un souhait vers un slot déjà occupé : conflit typé (23505), souhait intact.
        const clash = yield* failureOf(
          wishlist.updateWishlistItem(ALICE, en.id, { language: "FR" }),
        );
        expect(clash._tag).toBe("WishlistItemConflictError");
        const stillEn = (yield* wishlist.listWishlistItems(ALICE, { cardId: A1 })).find(
          (i) => i.id === en.id,
        );
        expect(stillEn?.language).toBe("EN");

        const unknown = yield* failureOf(wishlist.addWishlistItem(ALICE, { cardId: "nope" }));
        expect(unknown).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card" });
        const invalid = yield* failureOf(
          wishlist.addWishlistItem(ALICE, { cardId: A1, targetPriceCents: -1 }),
        );
        expect(invalid._tag).toBe("ValidationError");
        const badUser = yield* failureOf(wishlist.addWishlistItem("nope", { cardId: A1 }));
        expect(badUser._tag).toBe("ValidationError");
      }),
    ));

  it("liste : prioritaires d'abord, puis récents ; filtres priority / cardId / setId", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const a1 = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const a2 = yield* wishlist.addWishlistItem(ALICE, { cardId: A2, priority: "high" });
        const b1 = yield* wishlist.addWishlistItem(ALICE, { cardId: B1 });
        const b1high = yield* wishlist.addWishlistItem(ALICE, {
          cardId: B1,
          language: "EN",
          priority: "high",
        });
        const ids = (items: ReadonlyArray<{ readonly id: string }>) => items.map((i) => i.id);

        expect(ids(yield* wishlist.listWishlistItems(ALICE))).toEqual([
          b1high.id,
          a2.id,
          b1.id,
          a1.id,
        ]);
        expect(ids(yield* wishlist.listWishlistItems(ALICE, { priority: "high" }))).toEqual([
          b1high.id,
          a2.id,
        ]);
        expect(ids(yield* wishlist.listWishlistItems(ALICE, { cardId: B1 }))).toEqual([
          b1high.id,
          b1.id,
        ]);
        expect(ids(yield* wishlist.listWishlistItems(ALICE, { setId: "t32-a" }))).toEqual([
          a2.id,
          a1.id,
        ]);
        expect(
          ids(yield* wishlist.listWishlistItems(ALICE, { setId: "t32-b", priority: "normal" })),
        ).toEqual([b1.id]);
      }),
    ));

  it("RLS : Bob ne voit, ne modifie, ne supprime ni n'acquiert les souhaits d'Alice", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        expect(yield* wishlist.listWishlistItems(BOB)).toEqual([]);
        const update = yield* failureOf(
          wishlist.updateWishlistItem(BOB, item.id, { priority: "high" }),
        );
        expect(update._tag).toBe("WishlistItemNotFoundError");
        const remove = yield* failureOf(wishlist.removeWishlistItem(BOB, item.id));
        expect(remove._tag).toBe("WishlistItemNotFoundError");
        const acquire = yield* failureOf(wishlist.markAcquired(BOB, { wishlistItemId: item.id }));
        expect(acquire._tag).toBe("WishlistItemNotFoundError");

        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([item]);
        expect(yield* copyRows(BOB)).toEqual([]);
        expect(yield* setBinderRows(BOB)).toEqual([]);
      }),
    ));

  it("markAcquired : crée l'exemplaire (état = minCondition), le classeur d'extension et retire le souhait", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, {
          cardId: A1,
          language: "EN",
          variant: "reverse",
          minCondition: "EX",
        });
        const result = yield* wishlist.markAcquired(ALICE, { wishlistItemId: item.id });

        expect(result.removedWishlistItemId).toBe(item.id);
        expect(result.copy).toMatchObject({
          userId: ALICE,
          cardId: A1,
          language: "EN",
          variant: "reverse",
          condition: "EX",
          quantity: 1,
          gradingCompany: null,
          gradingScore: null,
        });
        expect(result.copy.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        expect(yield* wishlistRows(ALICE)).toEqual([]);
        const copies = yield* copyRows(ALICE);
        expect(copies).toEqual([
          {
            id: result.copy.id,
            card_id: A1,
            language: "EN",
            variant: "reverse",
            condition: "EX",
            quantity: 1,
          },
        ]);
        const binders = yield* setBinderRows(ALICE);
        expect(binders).toEqual([
          { id: result.setBinderId, set_id: "t32-a", title: "Extension t32-a" },
        ]);
      }),
    ));

  it("markAcquired : condition / quantité / prix / notes ; incrémente le slot existant ; classeur idempotent", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedCopy(ALICE, A1, 2));
        const first = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const r1 = yield* wishlist.markAcquired(ALICE, {
          wishlistItemId: first.id,
          quantity: 3,
          purchasePriceCents: 450,
          notes: "Vide-grenier",
        });
        expect(r1.copy).toMatchObject({
          quantity: 5,
          condition: "NM",
          purchasePriceCents: 450,
          notes: "Vide-grenier",
        });
        expect((yield* copyRows(ALICE)).length).toBe(1);

        // Autre état : slot distinct. Même extension : même classeur.
        const second = yield* wishlist.addWishlistItem(ALICE, { cardId: A2 });
        const r2 = yield* wishlist.markAcquired(ALICE, {
          wishlistItemId: second.id,
          condition: "LP",
        });
        expect(r2.copy).toMatchObject({ cardId: A2, condition: "LP", quantity: 1 });
        expect(r2.setBinderId).toBe(r1.setBinderId);
        const third = yield* wishlist.addWishlistItem(ALICE, { cardId: B1 });
        const r3 = yield* wishlist.markAcquired(ALICE, { wishlistItemId: third.id });
        expect(r3.setBinderId).not.toBe(r1.setBinderId);
        expect((yield* setBinderRows(ALICE)).map((b) => b.set_id)).toEqual(["t32-a", "t32-b"]);
      }),
    ));

  it("markAcquired : ne touche jamais une copie gradée (slot non gradé distinct)", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          withAdmin(
            (admin) => admin`
              insert into public.user_card_copies
                (user_id, card_id, language, variant, condition, quantity, grading_company, grading_score)
              values (${ALICE}, ${A1}, 'FR', 'normal', 'NM', 1, 'PSA', '10')`,
          ),
        );
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const result = yield* wishlist.markAcquired(ALICE, { wishlistItemId: item.id });
        expect(result.copy.gradingCompany).toBeNull();
        const copies = yield* copyRows(ALICE);
        expect(copies.length).toBe(2);
        expect(copies.map((c) => c.quantity)).toEqual([1, 1]);
      }),
    ));

  it(`markAcquired : dépasser ${MAX_CARD_COPY_QUANTITY} → rollback complet (souhait, copie, classeur intacts)`, () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedCopy(ALICE, A1, 998));
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });

        const error = yield* failureOf(
          wishlist.markAcquired(ALICE, { wishlistItemId: item.id, quantity: 2 }),
        );
        expect(error).toMatchObject({
          _tag: "WishlistQuantityOverflowError",
          cardId: A1,
          currentQuantity: 998,
          requestedDelta: 2,
          maxQuantity: MAX_CARD_COPY_QUANTITY,
        });
        expect((yield* wishlistRows(ALICE)).map((row) => row.id)).toEqual([item.id]);
        expect((yield* copyRows(ALICE)).map((row) => row.quantity)).toEqual([998]);
        expect(yield* setBinderRows(ALICE)).toEqual([]);

        // Pile au plafond : accepté, souhait retiré.
        const ok = yield* wishlist.markAcquired(ALICE, { wishlistItemId: item.id, quantity: 1 });
        expect(ok.copy.quantity).toBe(MAX_CARD_COPY_QUANTITY);
        expect(yield* wishlistRows(ALICE)).toEqual([]);
        expect((yield* setBinderRows(ALICE)).length).toBe(1);
      }),
    ));

  it("markAcquired : entrée invalide → ValidationError, aucune écriture", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        for (const input of [
          { wishlistItemId: item.id, quantity: 0 },
          { wishlistItemId: item.id, quantity: MAX_CARD_COPY_QUANTITY + 1 },
          { wishlistItemId: item.id, condition: "MINT" },
          { wishlistItemId: "not-a-uuid" },
        ]) {
          const error = yield* failureOf(wishlist.markAcquired(ALICE, input as never));
          expect(error._tag).toBe("ValidationError");
        }
        expect((yield* wishlistRows(ALICE)).length).toBe(1);
        expect(yield* copyRows(ALICE)).toEqual([]);
        expect(yield* setBinderRows(ALICE)).toEqual([]);
      }),
    ));

  it("markAcquired concurrent sur le même souhait : un seul gagne (FOR UPDATE), +1 exemplaire exactement", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const outcomes = yield* Effect.all(
          [1, 2, 3].map(() =>
            Effect.result(wishlist.markAcquired(ALICE, { wishlistItemId: item.id })),
          ),
          { concurrency: "unbounded" },
        );
        const successes = outcomes.filter((o) => o._tag === "Success");
        const failures = outcomes.filter((o) => o._tag === "Failure");
        expect(successes.length).toBe(1);
        expect(failures.length).toBe(2);
        for (const failure of failures) {
          expect(failure._tag === "Failure" && failure.failure).toMatchObject({
            _tag: "WishlistItemNotFoundError",
          });
        }
        expect((yield* copyRows(ALICE)).map((row) => row.quantity)).toEqual([1]);
        expect((yield* setBinderRows(ALICE)).length).toBe(1);
        expect(yield* wishlistRows(ALICE)).toEqual([]);
      }),
    ));

  it("coexiste avec BurstImportService : le retrait auto supprime réellement le souhait (slot exact)", () =>
    run(({ wishlist, burst }) =>
      Effect.gen(function* () {
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1, language: "FR", variant: "normal" });
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1, language: "EN", variant: "normal" });
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1, language: "FR", variant: "reverse" });
        yield* wishlist.addWishlistItem(BOB, { cardId: A1, language: "FR", variant: "normal" });

        const input = (removeFromWishlist: boolean) => ({
          defaults: { language: "FR", variant: "normal", removeFromWishlist },
          items: [{ cardId: A1, quantity: 1 }],
        });

        const kept = yield* burst.commitBatch(ALICE, input(false));
        expect(kept.wishlistRemovedCount).toBe(0);
        expect((yield* wishlist.listWishlistItems(ALICE)).length).toBe(3);

        const removed = yield* burst.commitBatch(ALICE, input(true));
        expect(removed.wishlistRemovedCount).toBe(1);
        expect(removed.items[0]?.removedFromWishlist).toBe(true);

        const left = yield* wishlist.listWishlistItems(ALICE);
        expect(left.map((i) => `${i.language}/${i.variant}`).sort()).toEqual([
          "EN/normal",
          "FR/reverse",
        ]);
        expect((yield* wishlist.listWishlistItems(BOB)).length).toBe(1); // RLS : Bob intact
      }),
    ));
});
