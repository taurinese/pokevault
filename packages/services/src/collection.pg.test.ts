import { MAX_CARD_COPY_QUANTITY } from "@pokevault/domain";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BinderService, BinderServiceLive } from "./binder-service.ts";
import { ALICE, BOB } from "./collection.fixture.ts";
import {
  appDatabaseLayer,
  dropPgFixture,
  PG_HOOK_TIMEOUT_MS,
  PGTEST_URL,
  resetUserData,
  seedPgFixture,
  withAdmin,
} from "./collection-pg-harness.ts";
import { CollectionService, CollectionServiceLive } from "./collection-service.ts";
import { failureOf } from "./collection-test-harness.ts";
import { CoverImageProcessorMemory } from "./cover-image.ts";
import { Database } from "./db.ts";
import {
  BinderCoverStorage,
  type MemoryBinderCoverStorage,
  makeMemoryBinderCoverStorage,
} from "./storage.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const TOKEN = "user-jwt";

/**
 * Services Live contre Postgres réel (voir `collection-pg-harness.ts`) : RLS Alice / Bob,
 * transactions, `ON CONFLICT` du slot unique, contraintes de la migration 004.
 */
describe.skipIf(PGTEST_URL === undefined)(
  "BinderService & CollectionService (Postgres réel)",
  () => {
    const storage: MemoryBinderCoverStorage = makeMemoryBinderCoverStorage();
    const dbLayer = appDatabaseLayer(6);
    const layer = Layer.mergeAll(BinderServiceLive, CollectionServiceLive).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          dbLayer,
          Layer.succeed(BinderCoverStorage, storage.service),
          CoverImageProcessorMemory,
        ),
      ),
    );

    // Chaque test construit (et ferme) son propre pool applicatif.
    const run = <A>(
      body: (ctx: {
        readonly binders: typeof BinderService.Service;
        readonly collection: typeof CollectionService.Service;
      }) => Effect.Effect<A, unknown>,
    ): Promise<A> =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            return yield* body({
              binders: yield* BinderService,
              collection: yield* CollectionService,
            });
          }).pipe(Effect.provide(layer)),
        ),
      );

    beforeAll(seedPgFixture, PG_HOOK_TIMEOUT_MS);
    beforeEach(async () => {
      await resetUserData();
      storage.objects.clear();
      storage.failures.upload = false;
      storage.failures.remove = false;
    });
    afterAll(async () => {
      await dropPgFixture();
    });

    // ---------------------------------------------------------------- binders --

    it("classeurs d'extension : création idempotente, conflit typé, extension inconnue", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const first = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
          expect(first.binder).toMatchObject({
            userId: ALICE,
            kind: "set",
            setId: "t32-a",
            title: "Extension t32-a",
            coverType: "set_logo",
          });
          expect(first.set).toMatchObject({ seriesId: "t32-sv", officialCount: 3, totalCount: 4 });
          expect(first.completion).toMatchObject({ ownedDistinct: 0, status: "not_started" });
          const again = yield* binders.createSetBinder(ALICE, { setId: "t32-a", title: "Autre" });
          expect(again.binder.id).toBe(first.binder.id);
          expect(again.binder.title).toBe("Extension t32-a");
          expect(
            yield* failureOf(binders.createSetBinder(ALICE, { setId: "t32-a", ifExists: "fail" })),
          ).toMatchObject({ _tag: "BinderConflictError", setId: "t32-a" });
          expect(
            yield* failureOf(binders.createSetBinder(ALICE, { setId: "ghost" })),
          ).toMatchObject({
            _tag: "CatalogItemNotFoundError",
            entity: "set",
          });
          const bob = yield* binders.createSetBinder(BOB, { setId: "t32-a" });
          expect(bob.binder.id).not.toBe(first.binder.id);
        }),
      ));

    it("listBinders : tri is_pinned DESC, sort_order ASC, created_at DESC + filtres", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const a = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
          const b = yield* binders.createSetBinder(ALICE, { setId: "t32-b" });
          const c = yield* binders.createSetBinder(ALICE, { setId: "t32-c" });
          const custom = yield* binders.createCustomBinder(ALICE, {
            title: "  Évolitions   Favs ",
          });
          expect(custom.binder.title).toBe("Évolitions Favs");
          yield* binders.updateBinder(ALICE, a.binder.id, { sortOrder: 5 });
          yield* binders.updateBinder(ALICE, b.binder.id, { isPinned: true, sortOrder: 9 });
          yield* binders.createCustomBinder(BOB, { title: "Bob" });
          // created_at DESC départage les égalités (now() est déjà croissant entre transactions)
          const ids = (yield* binders.listBinders(ALICE)).map((entry) => entry.binder.id);
          expect(ids).toEqual([b.binder.id, custom.binder.id, c.binder.id, a.binder.id]);
          expect((yield* binders.listBinders(ALICE, { kind: "custom" })).length).toBe(1);
          expect(
            (yield* binders.listBinders(ALICE, { seriesId: "t32-sv" })).map((e) => e.binder.setId),
          ).toEqual(["t32-b", "t32-a"]);
          expect((yield* binders.listBinders(BOB)).length).toBe(1);
        }),
      ));

    it("isolation RLS : classeur d'un autre = BinderNotFoundError (lecture, update, delete, cartes)", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Privé" });
          const gone = { _tag: "BinderNotFoundError" };
          expect(yield* failureOf(binders.getBinder(BOB, binder.id))).toMatchObject(gone);
          expect(
            yield* failureOf(binders.updateBinder(BOB, binder.id, { title: "Hack" })),
          ).toMatchObject(gone);
          expect(yield* failureOf(binders.deleteBinder(BOB, binder.id))).toMatchObject(gone);
          expect(
            yield* failureOf(binders.addCardToCustomBinder(BOB, binder.id, "t32-a-001")),
          ).toMatchObject(gone);
          expect(yield* failureOf(binders.listBinderCards(BOB, binder.id))).toMatchObject(gone);
          expect(yield* failureOf(binders.getBinder(ALICE, "not-a-uuid"))).toMatchObject(gone);
          expect(yield* failureOf(binders.listBinders("nope"))).toMatchObject({
            _tag: "ValidationError",
          });
          expect((yield* binders.getBinder(ALICE, binder.id)).binder.title).toBe("Privé");
        }),
      ));

    it("covers : carte (FK), set_logo, upload → chemin <user>/<binder>.webp + nettoyage", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const { binder } = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
          const card = yield* binders.setBinderCover(ALICE, binder.id, {
            type: "card",
            cardId: "t32-a-002",
          });
          expect(card.binder).toMatchObject({ coverType: "card", coverCardId: "t32-a-002" });
          expect(
            yield* failureOf(
              binders.setBinderCover(ALICE, binder.id, { type: "card", cardId: "ghost" }),
            ),
          ).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card" });

          const path = `${ALICE}/${binder.id}.webp`;
          const upload = yield* binders.setBinderCover(
            ALICE,
            binder.id,
            { type: "upload", image: PNG },
            TOKEN,
          );
          expect(upload.binder).toMatchObject({
            coverType: "upload",
            coverCardId: null,
            coverStoragePath: path,
          });
          expect([...storage.objects.keys()]).toEqual([path]);

          // Bob ne peut pas toucher à la cover d'Alice
          expect(
            yield* failureOf(
              binders.setBinderCover(BOB, binder.id, { type: "upload", image: PNG }, TOKEN),
            ),
          ).toMatchObject({ _tag: "BinderNotFoundError" });

          const logo = yield* binders.setBinderCover(ALICE, binder.id, { type: "set_logo" }, TOKEN);
          expect(logo.binder).toMatchObject({
            coverType: "set_logo",
            coverCardId: null,
            coverStoragePath: null,
          });
          expect(storage.objects.size).toBe(0);

          // L'échec du nettoyage Storage ne bloque pas la mise à jour DB.
          yield* binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }, TOKEN);
          storage.failures.remove = true;
          const cardAgain = yield* binders.setBinderCover(
            ALICE,
            binder.id,
            { type: "card", cardId: "t32-a-001" },
            TOKEN,
          );
          expect(cardAgain.binder.coverType).toBe("card");
          expect(storage.objects.size).toBe(1);
        }),
      ));

    it("deleteBinder : supprime le classeur, cascade binder_cards, nettoie la cover", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const { binder } = yield* binders.createCustomBinder(ALICE, { title: "À supprimer" });
          yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001");
          yield* binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }, TOKEN);
          yield* binders.deleteBinder(ALICE, binder.id, TOKEN);
          expect(storage.objects.size).toBe(0);
          expect((yield* failureOf(binders.getBinder(ALICE, binder.id)))._tag).toBe(
            "BinderNotFoundError",
          );
          const left = yield* Effect.promise(() =>
            withAdmin(async (admin) => (await admin`select 1 from public.binder_cards`).length),
          );
          expect(left).toBe(0);
        }),
      ));

    it("dossier perso : ON CONFLICT met à jour la position seule, réordonne, retire", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Favs" });
          const cards = ["t32-a-001", "t32-a-002", "t32-b-001"];
          const added = [];
          for (const cardId of cards) {
            added.push(yield* binders.addCardToCustomBinder(ALICE, binder.id, cardId));
          }
          expect(added.map((entry) => entry.position)).toEqual([0, 1, 2]);
          const again = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001");
          expect(again).toMatchObject({ position: 0, addedAt: added[0]?.addedAt });
          const moved = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001", 7);
          expect(moved).toMatchObject({ position: 7, addedAt: added[0]?.addedAt });
          expect((yield* binders.listBinderCards(ALICE, binder.id)).map((e) => e.cardId)).toEqual([
            "t32-a-002",
            "t32-b-001",
            "t32-a-001",
          ]);

          const reordered = yield* binders.reorderCustomBinderCards(ALICE, binder.id, [
            "t32-b-001",
            "t32-a-001",
            "t32-a-002",
          ]);
          expect(reordered.map((entry) => [entry.cardId, entry.position])).toEqual([
            ["t32-b-001", 0],
            ["t32-a-001", 1],
            ["t32-a-002", 2],
          ]);
          expect(
            yield* failureOf(
              binders.reorderCustomBinderCards(ALICE, binder.id, ["t32-b-001", "t32-a-001"]),
            ),
          ).toMatchObject({ _tag: "ValidationError" });

          yield* binders.removeCardFromCustomBinder(ALICE, binder.id, "t32-a-001");
          yield* binders.removeCardFromCustomBinder(ALICE, binder.id, "t32-a-001");
          expect((yield* binders.listBinderCards(ALICE, binder.id)).map((e) => e.cardId)).toEqual([
            "t32-b-001",
            "t32-a-002",
          ]);
          expect(
            yield* failureOf(binders.addCardToCustomBinder(ALICE, binder.id, "ghost")),
          ).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card" });
          expect(
            yield* failureOf(binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001", -1)),
          ).toMatchObject({ _tag: "ValidationError" });
        }),
      ));

    it("un classeur d'extension n'accepte aucune carte (service + trigger)", () =>
      run(({ binders }) =>
        Effect.gen(function* () {
          const { binder } = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
          expect(
            yield* failureOf(binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001")),
          ).toMatchObject({ _tag: "ValidationError" });
          expect(yield* binders.listBinderCards(ALICE, binder.id)).toEqual([]);
        }),
      ));

    // ------------------------------------------------------------ collection --

    it("upsertCardCopy : ON CONFLICT sur le slot unique incrémente, un slot par variante / état / grading", () =>
      run(({ collection }) =>
        Effect.gen(function* () {
          const base = { cardId: "t32-a-001", variant: "normal" } as const;
          const first = yield* collection.upsertCardCopy(ALICE, base);
          expect(first).toMatchObject({
            userId: ALICE,
            language: "FR",
            condition: "NM",
            quantity: 1,
            gradingCompany: null,
            gradingScore: null,
            purchasePriceCents: null,
          });
          expect(first.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const second = yield* collection.upsertCardCopy(ALICE, {
            ...base,
            quantity: 2,
            purchasePriceCents: 350,
          });
          expect(second).toMatchObject({ id: first.id, quantity: 3, purchasePriceCents: 350 });

          yield* collection.upsertCardCopy(ALICE, { ...base, language: "EN" });
          yield* collection.upsertCardCopy(ALICE, { ...base, condition: "EX" });
          yield* collection.upsertCardCopy(ALICE, { ...base, variant: "reverse" });
          yield* collection.upsertCardCopy(ALICE, {
            ...base,
            gradingCompany: "PSA",
            gradingScore: "10",
          });
          yield* collection.upsertCardCopy(ALICE, {
            ...base,
            gradingCompany: "PSA",
            gradingScore: "9",
          });
          const graded = yield* collection.upsertCardCopy(ALICE, {
            ...base,
            gradingCompany: "PSA",
            gradingScore: "10",
          });
          expect(graded.quantity).toBe(2);
          expect((yield* collection.listCardCopies(ALICE)).length).toBe(6);

          const set = yield* collection.upsertCardCopy(ALICE, {
            ...base,
            quantity: 9,
            mode: "set",
          });
          expect(set).toMatchObject({ id: first.id, quantity: 9 });
          expect(
            yield* failureOf(
              collection.upsertCardCopy(ALICE, { cardId: "ghost", variant: "normal" }),
            ),
          ).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card" });
        }),
      ));

    it("upsertCardCopy : 20 ajouts concurrents du même slot = quantité 20 (aucun doublon)", () =>
      run(({ collection }) =>
        Effect.gen(function* () {
          const input = { cardId: "t32-a-002", variant: "holo" } as const;
          yield* Effect.all(
            Array.from({ length: 20 }, () => collection.upsertCardCopy(ALICE, input)),
            { concurrency: 6 },
          );
          const copies = yield* collection.listCardCopies(ALICE, { cardId: "t32-a-002" });
          expect(copies.map((copy) => copy.quantity)).toEqual([20]);
        }),
      ));

    it("plafond 999 : refus, jamais de troncature (insert direct, incrément et mode set)", () =>
      run(({ collection }) =>
        Effect.gen(function* () {
          const base = { cardId: "t32-a-001", variant: "normal" } as const;
          expect(
            yield* failureOf(collection.upsertCardCopy(ALICE, { ...base, quantity: 5000 })),
          ).toMatchObject({ _tag: "ValidationError" });
          yield* collection.upsertCardCopy(ALICE, { ...base, quantity: 998 });
          const full = yield* collection.upsertCardCopy(ALICE, base);
          expect(full.quantity).toBe(MAX_CARD_COPY_QUANTITY);
          expect(yield* failureOf(collection.upsertCardCopy(ALICE, base))).toMatchObject({
            _tag: "ValidationError",
          });
          expect(
            yield* failureOf(
              collection.upsertCardCopy(ALICE, { ...base, quantity: 5000, mode: "set" }),
            ),
          ).toMatchObject({ _tag: "ValidationError" });
          expect(
            yield* failureOf(collection.adjustCardCopyQuantity(ALICE, full.id, 1)),
          ).toMatchObject({
            _tag: "ValidationError",
          });
          expect((yield* collection.listCardCopies(ALICE))[0]?.quantity).toBe(999);
        }),
      ));

    it("adjustCardCopyQuantity : stepper et suppression de la ligne à 0", () =>
      run(({ collection }) =>
        Effect.gen(function* () {
          const copy = yield* collection.upsertCardCopy(ALICE, {
            cardId: "t32-a-001",
            variant: "normal",
            quantity: 2,
          });
          expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, 3))?.quantity).toBe(5);
          expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, -4))?.quantity).toBe(1);
          expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, 0))?.quantity).toBe(1);
          expect(
            yield* failureOf(collection.adjustCardCopyQuantity(BOB, copy.id, -1)),
          ).toMatchObject({ _tag: "CardCopyNotFoundError" });
          expect(yield* collection.adjustCardCopyQuantity(ALICE, copy.id, -1)).toBeNull();
          expect(yield* collection.listCardCopies(ALICE)).toEqual([]);
          expect(
            yield* failureOf(collection.adjustCardCopyQuantity(ALICE, copy.id, 1)),
          ).toMatchObject({ _tag: "CardCopyNotFoundError" });
          expect(
            yield* failureOf(collection.adjustCardCopyQuantity(ALICE, "nope", 1)),
          ).toMatchObject({ _tag: "CardCopyNotFoundError" });
        }),
      ));

    it("updateCardCopy : champs éditables, grading, null, conflit de slot (23505) typé", () =>
      run(({ collection }) =>
        Effect.gen(function* () {
          const base = { cardId: "t32-a-001", variant: "normal" } as const;
          const nm = yield* collection.upsertCardCopy(ALICE, base);
          const ex = yield* collection.upsertCardCopy(ALICE, { ...base, condition: "EX" });
          const updated = yield* collection.updateCardCopy(ALICE, nm.id, {
            purchasePriceCents: 1999,
            notes: "dédicace",
            acquiredAt: "2025-12-24",
            gradingCompany: "PCA",
            gradingScore: "9.5",
          });
          expect(updated).toMatchObject({
            quantity: 1,
            purchasePriceCents: 1999,
            notes: "dédicace",
            acquiredAt: "2025-12-24",
            gradingCompany: "PCA",
            gradingScore: "9.5",
          });
          expect(
            yield* collection.updateCardCopy(ALICE, nm.id, {
              gradingCompany: null,
              gradingScore: null,
              notes: null,
              purchasePriceCents: null,
              acquiredAt: null,
            }),
          ).toMatchObject({ gradingCompany: null, notes: null, acquiredAt: null });
          // NM sans grading existe déjà avec EX → passer EX en NM entre en collision
          expect(
            yield* failureOf(collection.updateCardCopy(ALICE, ex.id, { condition: "NM" })),
          ).toMatchObject({ _tag: "CardCopyConflictError" });
          expect(
            yield* failureOf(collection.updateCardCopy(BOB, nm.id, { notes: "x" })),
          ).toMatchObject({ _tag: "CardCopyNotFoundError" });
          expect(
            yield* failureOf(collection.updateCardCopy(ALICE, nm.id, { notes: "x".repeat(1001) })),
          ).toMatchObject({ _tag: "ValidationError" });
        }),
      ));

    it("deleteCardCopy : supprime, isole les utilisateurs, filtre par carte / extension", () =>
      run(({ collection }) =>
        Effect.gen(function* () {
          const a = yield* collection.upsertCardCopy(ALICE, {
            cardId: "t32-a-001",
            variant: "normal",
          });
          yield* collection.upsertCardCopy(ALICE, { cardId: "t32-b-001", variant: "normal" });
          yield* collection.upsertCardCopy(BOB, { cardId: "t32-a-001", variant: "normal" });
          expect((yield* collection.listCardCopies(ALICE, { setId: "t32-b" })).length).toBe(1);
          expect((yield* collection.listCardCopies(ALICE, { cardId: "t32-a-001" })).length).toBe(1);
          expect((yield* collection.listCardCopies(BOB)).map((c) => c.userId)).toEqual([BOB]);
          expect(yield* failureOf(collection.deleteCardCopy(BOB, a.id))).toMatchObject({
            _tag: "CardCopyNotFoundError",
          });
          yield* collection.deleteCardCopy(ALICE, a.id);
          expect((yield* collection.listCardCopies(ALICE)).length).toBe(1);
          expect((yield* collection.listCardCopies(BOB)).length).toBe(1);
        }),
      ));

    it("getCollectionOverview : complétion globale / série / extension, secrètes optionnelles", () =>
      run(({ binders, collection }) =>
        Effect.gen(function* () {
          yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
          yield* binders.createSetBinder(ALICE, { setId: "t32-b" });
          const add = (cardId: string, quantity = 1) =>
            collection.upsertCardCopy(ALICE, { cardId, variant: "normal", quantity });
          yield* add("t32-a-001", 3);
          yield* add("t32-a-004");
          yield* add("t32-b-001");
          yield* add("t32-b-002");
          yield* add("t32-c-001");
          yield* collection.upsertCardCopy(BOB, { cardId: "t32-a-002", variant: "normal" });

          const overview = yield* collection.getCollectionOverview(ALICE);
          expect(overview.sets.map((entry) => [entry.setId, entry.tracked])).toEqual([
            ["t32-a", true],
            ["t32-b", true],
            ["t32-c", false],
          ]);
          expect(overview.sets[0]?.completion).toMatchObject({
            ownedDistinct: 2,
            targetCount: 4,
            percent: 50,
            totalCopies: 4,
            duplicateCount: 2,
          });
          expect(overview.series.map((entry) => entry.seriesId)).toEqual(["t32-sv", "t32-old"]);
          expect(overview.global).toMatchObject({
            trackedSetCount: 2,
            trackedOwnedDistinct: 4,
            trackedTargetCount: 6,
            percent: 67,
            ownedDistinct: 5,
            totalCopies: 7,
          });
          const strict = yield* collection.getCollectionOverview(ALICE, { includeSecrets: false });
          expect(strict.sets[0]?.completion).toMatchObject({ targetCount: 3, ownedDistinct: 1 });

          const listed = yield* binders.getBinder(
            ALICE,
            (yield* binders.listBinders(ALICE, { seriesId: "t32-sv" }))[1]?.binder.id ?? "",
          );
          expect(listed.completion?.ownedDistinct).toBeGreaterThan(0);
        }),
      ));

    it("le pool n'a pas de rôle de contournement RLS (garde-fou de la suite)", () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { sql } = yield* Database;
            const [row] = yield* Effect.promise(
              () => sql<Array<{ current_user: string }>>`select current_user`,
            );
            expect(row?.current_user).toBe("authenticated");
          }).pipe(Effect.provide(dbLayer)),
        ),
      ));
  },
);
