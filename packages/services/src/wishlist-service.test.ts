import { MAX_CARD_COPY_QUANTITY } from "@pokevault/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, COLLECTION_MEMORY_CATALOG } from "./collection.fixture.ts";
import { CollectionMemoryStore, CollectionMemoryStoreLayer } from "./collection-memory.ts";
import { CollectionService, CollectionServiceMemory } from "./collection-service.ts";
import { failureOf } from "./collection-test-harness.ts";
import { WishlistService, WishlistServiceMemory } from "./wishlist-service.ts";

const A1 = "t32-a-001";
const A2 = "t32-a-002";
const B1 = "t32-b-001";
const C1 = "t32-c-001";

const run = <A>(
  body: (ctx: {
    readonly wishlist: typeof WishlistService.Service;
    readonly collection: typeof CollectionService.Service;
    readonly store: typeof CollectionMemoryStore.Service;
  }) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const layer = Layer.mergeAll(WishlistServiceMemory, CollectionServiceMemory).pipe(
    Layer.provideMerge(CollectionMemoryStoreLayer(COLLECTION_MEMORY_CATALOG)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({
        wishlist: yield* WishlistService,
        collection: yield* CollectionService,
        store: yield* CollectionMemoryStore,
      });
    }).pipe(Effect.provide(layer)),
  );
};

describe("WishlistService (Memory) — CRUD", () => {
  it("ajoute un souhait avec les défauts SQL (FR / normal / NM / normal / pas de seuil)", () =>
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
        expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(item.createdAt).toBe(item.updatedAt);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([item]);
      }),
    ));

  it("ajoute avec tous les champs (prix cible 0 inclus)", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, {
          cardId: A1,
          language: "JP",
          variant: "masterball",
          minCondition: "PO",
          priority: "high",
          targetPriceCents: 0,
        });
        expect(item).toMatchObject({
          language: "JP",
          variant: "masterball",
          minCondition: "PO",
          priority: "high",
          targetPriceCents: 0,
        });
      }),
    ));

  it("slot unique (carte, langue, variante) : doublon → WishlistItemConflictError", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const conflict = yield* failureOf(wishlist.addWishlistItem(ALICE, { cardId: A1 }));
        expect(conflict).toMatchObject({ _tag: "WishlistItemConflictError", cardId: A1 });
        // Une autre langue, une autre variante, une autre carte restent possibles.
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1, language: "EN" });
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1, variant: "reverse" });
        yield* wishlist.addWishlistItem(ALICE, { cardId: A2 });
        expect((yield* wishlist.listWishlistItems(ALICE)).length).toBe(4);
        // Bob peut souhaiter le même slot.
        yield* wishlist.addWishlistItem(BOB, { cardId: A1 });
      }),
    ));

  it('ifExists: "return" renvoie le souhait existant sans le modifier', () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const first = yield* wishlist.addWishlistItem(ALICE, { cardId: A1, priority: "high" });
        const again = yield* wishlist.addWishlistItem(ALICE, {
          cardId: A1,
          priority: "normal",
          targetPriceCents: 100,
          ifExists: "return",
        });
        expect(again).toEqual(first);
        expect((yield* wishlist.listWishlistItems(ALICE)).length).toBe(1);
        const explicitFail = yield* failureOf(
          wishlist.addWishlistItem(ALICE, { cardId: A1, ifExists: "fail" }),
        );
        expect(explicitFail._tag).toBe("WishlistItemConflictError");
      }),
    ));

  it("refuse une carte hors catalogue et des entrées invalides", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const unknown = yield* failureOf(wishlist.addWishlistItem(ALICE, { cardId: "nope" }));
        expect(unknown).toMatchObject({
          _tag: "CatalogItemNotFoundError",
          entity: "card",
          id: "nope",
        });
        const badInput = yield* failureOf(
          wishlist.addWishlistItem(ALICE, { cardId: A1, priority: "urgent" } as never),
        );
        expect(badInput._tag).toBe("ValidationError");
        const badPrice = yield* failureOf(
          wishlist.addWishlistItem(ALICE, { cardId: A1, targetPriceCents: -1 }),
        );
        expect(badPrice._tag).toBe("ValidationError");
        const badUser = yield* failureOf(wishlist.addWishlistItem("not-a-uuid", { cardId: A1 }));
        expect(badUser._tag).toBe("ValidationError");
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([]);
      }),
    ));

  it("met à jour (patch partiel), efface le prix cible avec null, rafraîchit updatedAt", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1, targetPriceCents: 500 });
        const updated = yield* wishlist.updateWishlistItem(ALICE, item.id, {
          priority: "high",
          minCondition: "EX",
        });
        expect(updated).toMatchObject({
          id: item.id,
          cardId: A1,
          priority: "high",
          minCondition: "EX",
          targetPriceCents: 500,
          createdAt: item.createdAt,
        });
        expect(updated.updatedAt >= item.updatedAt).toBe(true);
        const cleared = yield* wishlist.updateWishlistItem(ALICE, item.id, {
          targetPriceCents: null,
        });
        expect(cleared.targetPriceCents).toBeNull();
        const moved = yield* wishlist.updateWishlistItem(ALICE, item.id, {
          language: "EN",
          variant: "holo",
        });
        expect(moved).toMatchObject({ language: "EN", variant: "holo" });
      }),
    ));

  it("update : patch vide → ValidationError ; slot occupé → conflit ; inconnu → not found", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const fr = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const en = yield* wishlist.addWishlistItem(ALICE, { cardId: A1, language: "EN" });
        const empty = yield* failureOf(wishlist.updateWishlistItem(ALICE, fr.id, {} as never));
        expect(empty._tag).toBe("ValidationError");
        const conflict = yield* failureOf(
          wishlist.updateWishlistItem(ALICE, en.id, { language: "FR" }),
        );
        expect(conflict._tag).toBe("WishlistItemConflictError");
        // Le souhait en conflit est intact.
        expect(
          (yield* wishlist.listWishlistItems(ALICE)).find((i) => i.id === en.id)?.language,
        ).toBe("EN");
        const missing = yield* failureOf(
          wishlist.updateWishlistItem(ALICE, "eeeeeeee-0000-4000-8000-000000000000", {
            priority: "high",
          }),
        );
        expect(missing).toMatchObject({ _tag: "WishlistItemNotFoundError" });
        const notUuid = yield* failureOf(
          wishlist.updateWishlistItem(ALICE, "nope", { priority: "high" }),
        );
        expect(notUuid._tag).toBe("WishlistItemNotFoundError");
      }),
    ));

  it("supprime un souhait ; inconnu ou déjà supprimé → not found", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        yield* wishlist.removeWishlistItem(ALICE, item.id);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([]);
        const again = yield* failureOf(wishlist.removeWishlistItem(ALICE, item.id));
        expect(again).toMatchObject({ _tag: "WishlistItemNotFoundError", itemId: item.id });
        const notUuid = yield* failureOf(wishlist.removeWishlistItem(ALICE, "nope"));
        expect(notUuid._tag).toBe("WishlistItemNotFoundError");
        // Re-souhaitable après suppression.
        yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
      }),
    ));

  it("isolation : Bob ne voit, ne modifie ni ne supprime les souhaits d'Alice", () =>
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
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([item]);
      }),
    ));
});

describe("WishlistService (Memory) — liste", () => {
  it("trie prioritaires d'abord puis du plus récent au plus ancien, et filtre", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const first = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const second = yield* wishlist.addWishlistItem(ALICE, { cardId: A2, priority: "high" });
        const third = yield* wishlist.addWishlistItem(ALICE, { cardId: B1 });
        const fourth = yield* wishlist.addWishlistItem(ALICE, { cardId: C1, priority: "high" });

        const all = yield* wishlist.listWishlistItems(ALICE);
        expect(all.map((item) => item.id)).toEqual([fourth.id, second.id, third.id, first.id]);

        const high = yield* wishlist.listWishlistItems(ALICE, { priority: "high" });
        expect(high.map((item) => item.id)).toEqual([fourth.id, second.id]);
        const normal = yield* wishlist.listWishlistItems(ALICE, { priority: "normal" });
        expect(normal.map((item) => item.id)).toEqual([third.id, first.id]);

        const byCard = yield* wishlist.listWishlistItems(ALICE, { cardId: A2 });
        expect(byCard.map((item) => item.id)).toEqual([second.id]);

        const bySet = yield* wishlist.listWishlistItems(ALICE, { setId: "t32-a" });
        expect(bySet.map((item) => item.id)).toEqual([second.id, first.id]);
        const bySetAndPriority = yield* wishlist.listWishlistItems(ALICE, {
          setId: "t32-a",
          priority: "normal",
        });
        expect(bySetAndPriority.map((item) => item.id)).toEqual([first.id]);
        expect(yield* wishlist.listWishlistItems(ALICE, { setId: "unknown" })).toEqual([]);
      }),
    ));

  it("userId invalide → ValidationError", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const error = yield* failureOf(wishlist.listWishlistItems("nope"));
        expect(error._tag).toBe("ValidationError");
      }),
    ));
});

describe("WishlistService (Memory) — markAcquired", () => {
  it("crée l'exemplaire (état par défaut = minCondition), suit l'extension et retire le souhait", () =>
    run(({ wishlist, collection, store }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, {
          cardId: A1,
          language: "EN",
          variant: "reverse",
          minCondition: "EX",
          priority: "high",
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
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([]);
        expect(yield* collection.listCardCopies(ALICE)).toEqual([result.copy]);

        const binder =
          result.setBinderId === null ? undefined : store.state.binders.get(result.setBinderId);
        expect(binder).toMatchObject({
          userId: ALICE,
          kind: "set",
          setId: "t32-a",
          title: "Extension t32-a",
          coverType: "set_logo",
        });
      }),
    ));

  it("applique condition, quantité, prix d'achat et notes fournis", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1, minCondition: "NM" });
        const { copy } = yield* wishlist.markAcquired(ALICE, {
          wishlistItemId: item.id,
          condition: "LP",
          quantity: 3,
          purchasePriceCents: 450,
          notes: "Vide-grenier",
        });
        expect(copy).toMatchObject({
          condition: "LP",
          quantity: 3,
          purchasePriceCents: 450,
          notes: "Vide-grenier",
        });
      }),
    ));

  it("incrémente le slot non gradé existant au lieu de dupliquer", () =>
    run(({ wishlist, collection }) =>
      Effect.gen(function* () {
        const owned = yield* collection.upsertCardCopy(ALICE, {
          cardId: A1,
          variant: "normal",
          quantity: 2,
        });
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const result = yield* wishlist.markAcquired(ALICE, {
          wishlistItemId: item.id,
          quantity: 3,
        });
        expect(result.copy.id).toBe(owned.id);
        expect(result.copy.quantity).toBe(5);
        const copies = yield* collection.listCardCopies(ALICE);
        expect(copies.length).toBe(1);
        expect(copies[0]?.quantity).toBe(5);
      }),
    ));

  it("ne touche jamais une copie gradée : crée un slot non gradé distinct", () =>
    run(({ wishlist, collection }) =>
      Effect.gen(function* () {
        const graded = yield* collection.upsertCardCopy(ALICE, {
          cardId: A1,
          variant: "normal",
          gradingCompany: "PSA",
          gradingScore: "10",
        });
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const result = yield* wishlist.markAcquired(ALICE, { wishlistItemId: item.id });
        expect(result.copy.id).not.toBe(graded.id);
        expect(result.copy.gradingCompany).toBeNull();
        const copies = yield* collection.listCardCopies(ALICE);
        expect(copies.length).toBe(2);
        expect(copies.find((copy) => copy.id === graded.id)?.quantity).toBe(1);
      }),
    ));

  it("réutilise le classeur d'extension (idempotent) et en crée un par extension", () =>
    run(({ wishlist, store }) =>
      Effect.gen(function* () {
        const one = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const two = yield* wishlist.addWishlistItem(ALICE, { cardId: A2 });
        const three = yield* wishlist.addWishlistItem(ALICE, { cardId: B1 });
        const r1 = yield* wishlist.markAcquired(ALICE, { wishlistItemId: one.id });
        const r2 = yield* wishlist.markAcquired(ALICE, { wishlistItemId: two.id });
        const r3 = yield* wishlist.markAcquired(ALICE, { wishlistItemId: three.id });
        expect(r1.setBinderId).not.toBeNull();
        expect(r2.setBinderId).toBe(r1.setBinderId);
        expect(r3.setBinderId).not.toBe(r1.setBinderId);
        expect([...store.state.binders.values()].filter((b) => b.kind === "set").length).toBe(2);
      }),
    ));

  it(`dépasser ${MAX_CARD_COPY_QUANTITY} : WishlistQuantityOverflowError, rollback complet (souhait, copie, classeur intacts)`, () =>
    run(({ wishlist, collection, store }) =>
      Effect.gen(function* () {
        const owned = yield* collection.upsertCardCopy(ALICE, {
          cardId: A1,
          variant: "normal",
          quantity: 998,
        });
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
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([item]);
        expect(yield* collection.listCardCopies(ALICE)).toEqual([owned]);
        expect(store.state.binders.size).toBe(0);

        // Pile au plafond : accepté.
        const ok = yield* wishlist.markAcquired(ALICE, { wishlistItemId: item.id, quantity: 1 });
        expect(ok.copy.quantity).toBe(MAX_CARD_COPY_QUANTITY);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([]);
      }),
    ));

  it("entrée invalide → ValidationError, aucune mutation", () =>
    run(({ wishlist, collection, store }) =>
      Effect.gen(function* () {
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        for (const input of [
          { wishlistItemId: item.id, quantity: 0 },
          { wishlistItemId: item.id, quantity: MAX_CARD_COPY_QUANTITY + 1 },
          { wishlistItemId: item.id, quantity: 1.5 },
          { wishlistItemId: item.id, condition: "MINT" },
          { wishlistItemId: item.id, purchasePriceCents: -1 },
          { wishlistItemId: "not-a-uuid" },
        ]) {
          const error = yield* failureOf(wishlist.markAcquired(ALICE, input as never));
          expect(error._tag).toBe("ValidationError");
        }
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([item]);
        expect(yield* collection.listCardCopies(ALICE)).toEqual([]);
        expect(store.state.binders.size).toBe(0);
      }),
    ));

  it("souhait inconnu ou déjà acquis → WishlistItemNotFoundError", () =>
    run(({ wishlist }) =>
      Effect.gen(function* () {
        const missing = yield* failureOf(
          wishlist.markAcquired(ALICE, { wishlistItemId: "eeeeeeee-0000-4000-8000-000000000000" }),
        );
        expect(missing._tag).toBe("WishlistItemNotFoundError");
        const item = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        yield* wishlist.markAcquired(ALICE, { wishlistItemId: item.id });
        const twice = yield* failureOf(wishlist.markAcquired(ALICE, { wishlistItemId: item.id }));
        expect(twice).toMatchObject({ _tag: "WishlistItemNotFoundError", itemId: item.id });
      }),
    ));

  it("isolation : Bob ne peut pas acquérir le souhait d'Alice ; chacun garde sa collection", () =>
    run(({ wishlist, collection }) =>
      Effect.gen(function* () {
        const alice = yield* wishlist.addWishlistItem(ALICE, { cardId: A1 });
        const bob = yield* wishlist.addWishlistItem(BOB, { cardId: A1 });
        const denied = yield* failureOf(wishlist.markAcquired(BOB, { wishlistItemId: alice.id }));
        expect(denied._tag).toBe("WishlistItemNotFoundError");
        expect(yield* collection.listCardCopies(BOB)).toEqual([]);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([alice]);

        const got = yield* wishlist.markAcquired(BOB, { wishlistItemId: bob.id });
        expect(got.copy.userId).toBe(BOB);
        expect(yield* collection.listCardCopies(ALICE)).toEqual([]);
        expect(yield* wishlist.listWishlistItems(ALICE)).toEqual([alice]);
        expect(yield* wishlist.listWishlistItems(BOB)).toEqual([]);
      }),
    ));
});
