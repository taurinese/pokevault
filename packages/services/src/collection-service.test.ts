import { MAX_CARD_COPY_QUANTITY } from "@pokevault/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ALICE, BOB } from "./collection.fixture.ts";
import { failureOf, runMemoryScenario } from "./collection-test-harness.ts";

describe("CollectionService (Memory) — upsertCardCopy", () => {
  it("crée un slot avec les défauts FR / NM / quantité 1", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const copy = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "holo",
        });
        expect(copy).toMatchObject({
          userId: ALICE,
          cardId: "t32-a-001",
          language: "FR",
          variant: "holo",
          condition: "NM",
          quantity: 1,
          purchasePriceCents: null,
          gradingCompany: null,
          gradingScore: null,
          notes: null,
        });
        expect(copy.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }),
    ));

  it("incrémente le même slot et en crée un par langue / variante / état / grading", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const base = { cardId: "t32-a-001", variant: "normal" } as const;
        const first = yield* collection.upsertCardCopy(ALICE, base);
        const second = yield* collection.upsertCardCopy(ALICE, { ...base, quantity: 2 });
        expect(second.id).toBe(first.id);
        expect(second.quantity).toBe(3);

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
        const again = yield* collection.upsertCardCopy(ALICE, {
          ...base,
          gradingCompany: "PSA",
          gradingScore: "10",
        });
        expect(again.quantity).toBe(2);
        expect((yield* collection.listCardCopies(ALICE)).length).toBe(6);
      }),
    ));

  it("mode 'set' fixe la quantité ; un prix / une note fournis complètent le slot", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const base = { cardId: "t32-a-002", variant: "normal" } as const;
        yield* collection.upsertCardCopy(ALICE, { ...base, quantity: 5, notes: "première" });
        const set = yield* collection.upsertCardCopy(ALICE, {
          ...base,
          quantity: 2,
          mode: "set",
          purchasePriceCents: 450,
        });
        expect(set).toMatchObject({ quantity: 2, purchasePriceCents: 450, notes: "première" });
        const keep = yield* collection.upsertCardCopy(ALICE, base);
        expect(keep).toMatchObject({ quantity: 3, purchasePriceCents: 450 });
      }),
    ));

  it("plafonne à 999 : refuse au lieu de tronquer", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const base = { cardId: "t32-a-001", variant: "normal" } as const;
        yield* collection.upsertCardCopy(ALICE, { ...base, quantity: 998 });
        const full = yield* collection.upsertCardCopy(ALICE, base);
        expect(full.quantity).toBe(MAX_CARD_COPY_QUANTITY);
        expect(yield* failureOf(collection.upsertCardCopy(ALICE, base))).toMatchObject({
          _tag: "ValidationError",
        });
        const set = yield* collection.upsertCardCopy(ALICE, { ...base, quantity: 10, mode: "set" });
        expect(set.quantity).toBe(10);
      }),
    ));

  it("refuse une carte inconnue et un userId invalide", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        expect(
          yield* failureOf(
            collection.upsertCardCopy(ALICE, { cardId: "ghost", variant: "normal" }),
          ),
        ).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card", id: "ghost" });
        expect(
          yield* failureOf(
            collection.upsertCardCopy("nope", { cardId: "t32-a-001", variant: "normal" }),
          ),
        ).toMatchObject({ _tag: "ValidationError" });
      }),
    ));

  it("isole Alice et Bob", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const alice = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "normal",
          quantity: 3,
        });
        const bob = yield* collection.upsertCardCopy(BOB, {
          cardId: "t32-a-001",
          variant: "normal",
        });
        expect(bob.id).not.toBe(alice.id);
        expect(bob.quantity).toBe(1);
        expect((yield* collection.listCardCopies(BOB)).map((copy) => copy.userId)).toEqual([BOB]);
      }),
    ));
});

describe("CollectionService (Memory) — listCardCopies", () => {
  it("filtre par carte, par extension, ou liste toute la collection", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        for (const cardId of ["t32-a-001", "t32-a-002", "t32-b-001"]) {
          yield* collection.upsertCardCopy(ALICE, { cardId, variant: "normal" });
        }
        yield* collection.upsertCardCopy(ALICE, { cardId: "t32-a-001", variant: "holo" });
        const ids = (copies: ReadonlyArray<{ cardId: string }>) => copies.map((c) => c.cardId);
        expect(ids(yield* collection.listCardCopies(ALICE))).toEqual([
          "t32-a-001",
          "t32-a-001",
          "t32-a-002",
          "t32-b-001",
        ]);
        expect(ids(yield* collection.listCardCopies(ALICE, { cardId: "t32-a-001" }))).toEqual([
          "t32-a-001",
          "t32-a-001",
        ]);
        expect(ids(yield* collection.listCardCopies(ALICE, { setId: "t32-b" }))).toEqual([
          "t32-b-001",
        ]);
        expect(yield* collection.listCardCopies(ALICE, { setId: "t32-c" })).toEqual([]);
        expect(yield* collection.listCardCopies(BOB)).toEqual([]);
      }),
    ));
});

describe("CollectionService (Memory) — adjustCardCopyQuantity", () => {
  it("stepper +/- puis suppression propre à 0", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const copy = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "normal",
          quantity: 2,
        });
        expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, 1))?.quantity).toBe(3);
        expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, -2))?.quantity).toBe(1);
        expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, 0))?.quantity).toBe(1);
        expect(yield* collection.adjustCardCopyQuantity(ALICE, copy.id, -1)).toBeNull();
        expect(yield* collection.listCardCopies(ALICE)).toEqual([]);
        expect(
          yield* failureOf(collection.adjustCardCopyQuantity(ALICE, copy.id, 1)),
        ).toMatchObject({ _tag: "CardCopyNotFoundError" });
      }),
    ));

  it("une baisse au-delà de zéro supprime aussi la ligne", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const copy = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "normal",
          quantity: 2,
        });
        expect(yield* collection.adjustCardCopyQuantity(ALICE, copy.id, -10)).toBeNull();
        expect((yield* collection.listCardCopies(ALICE)).length).toBe(0);
      }),
    ));

  it("refuse > 999, un delta non entier et l'exemplaire d'un autre", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const copy = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "normal",
          quantity: 998,
        });
        expect((yield* collection.adjustCardCopyQuantity(ALICE, copy.id, 1))?.quantity).toBe(999);
        expect(
          yield* failureOf(collection.adjustCardCopyQuantity(ALICE, copy.id, 1)),
        ).toMatchObject({ _tag: "ValidationError" });
        expect(
          yield* failureOf(collection.adjustCardCopyQuantity(ALICE, copy.id, 0.5)),
        ).toMatchObject({ _tag: "ValidationError" });
        expect(yield* failureOf(collection.adjustCardCopyQuantity(BOB, copy.id, -1))).toMatchObject(
          {
            _tag: "CardCopyNotFoundError",
          },
        );
        expect(yield* failureOf(collection.adjustCardCopyQuantity(ALICE, "nope", 1))).toMatchObject(
          {
            _tag: "CardCopyNotFoundError",
          },
        );
        expect((yield* collection.listCardCopies(ALICE))[0]?.quantity).toBe(999);
      }),
    ));
});

describe("CollectionService (Memory) — updateCardCopy / deleteCardCopy", () => {
  it("met à jour état, prix, notes, date et grading (et les efface avec null)", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const copy = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "normal",
        });
        const updated = yield* collection.updateCardCopy(ALICE, copy.id, {
          condition: "LP",
          purchasePriceCents: 1999,
          notes: "dédicace",
          acquiredAt: "2025-12-24",
          gradingCompany: "PCA",
          gradingScore: "9.5",
        });
        expect(updated).toMatchObject({
          id: copy.id,
          quantity: 1,
          condition: "LP",
          purchasePriceCents: 1999,
          notes: "dédicace",
          acquiredAt: "2025-12-24",
          gradingCompany: "PCA",
          gradingScore: "9.5",
        });
        const cleared = yield* collection.updateCardCopy(ALICE, copy.id, {
          purchasePriceCents: null,
          notes: null,
          acquiredAt: null,
          gradingCompany: null,
          gradingScore: null,
        });
        expect(cleared).toMatchObject({
          purchasePriceCents: null,
          notes: null,
          acquiredAt: null,
          gradingCompany: null,
          gradingScore: null,
          condition: "LP",
        });
      }),
    ));

  it("CardCopyConflictError si le nouveau slot existe déjà", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const base = { cardId: "t32-a-001", variant: "normal" } as const;
        yield* collection.upsertCardCopy(ALICE, base);
        const ex = yield* collection.upsertCardCopy(ALICE, { ...base, condition: "EX" });
        expect(
          yield* failureOf(collection.updateCardCopy(ALICE, ex.id, { condition: "NM" })),
        ).toMatchObject({ _tag: "CardCopyConflictError" });
        const same = yield* collection.updateCardCopy(ALICE, ex.id, {
          condition: "EX",
          notes: "ok",
        });
        expect(same.notes).toBe("ok");
      }),
    ));

  it("CardCopyNotFoundError pour un autre utilisateur / un id inconnu", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const copy = yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "normal",
        });
        expect(
          yield* failureOf(collection.updateCardCopy(BOB, copy.id, { notes: "x" })),
        ).toMatchObject({ _tag: "CardCopyNotFoundError" });
        expect(yield* failureOf(collection.deleteCardCopy(BOB, copy.id))).toMatchObject({
          _tag: "CardCopyNotFoundError",
        });
        yield* collection.deleteCardCopy(ALICE, copy.id);
        expect(yield* failureOf(collection.deleteCardCopy(ALICE, copy.id))).toMatchObject({
          _tag: "CardCopyNotFoundError",
        });
        expect(yield* collection.listCardCopies(ALICE)).toEqual([]);
      }),
    ));
});

describe("CollectionService (Memory) — getCollectionOverview", () => {
  it("agrège complétion globale, par série et par extension", () =>
    runMemoryScenario(({ binders, collection }) =>
      Effect.gen(function* () {
        yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        yield* binders.createSetBinder(ALICE, { setId: "t32-b" });
        const add = (cardId: string, quantity = 1) =>
          collection.upsertCardCopy(ALICE, { cardId, variant: "normal", quantity });
        yield* add("t32-a-001", 3);
        yield* add("t32-a-004"); // secrète
        yield* add("t32-b-001");
        yield* add("t32-b-002");
        yield* add("t32-c-001"); // extension non suivie
        yield* collection.upsertCardCopy(BOB, { cardId: "t32-a-002", variant: "normal" });

        const overview = yield* collection.getCollectionOverview(ALICE);
        expect(overview.sets.map((entry) => [entry.setId, entry.tracked])).toEqual([
          ["t32-a", true],
          ["t32-b", true],
          ["t32-c", false],
        ]);
        const byId = new Map(overview.sets.map((entry) => [entry.setId, entry.completion]));
        expect(byId.get("t32-a")).toMatchObject({
          ownedDistinct: 2,
          targetCount: 4,
          percent: 50,
          totalCopies: 4,
          duplicateCount: 2,
          status: "in_progress",
        });
        expect(byId.get("t32-b")).toMatchObject({ percent: 100, status: "completed" });
        expect(overview.series.map((entry) => entry.seriesId)).toEqual(["t32-sv", "t32-old"]);
        expect(overview.series[0]?.completion).toMatchObject({
          trackedSetCount: 2,
          completedSetCount: 1,
          ownedDistinct: 4,
          targetCount: 6,
          percent: 67,
        });
        expect(overview.global).toMatchObject({
          trackedSetCount: 2,
          trackedOwnedDistinct: 4,
          trackedTargetCount: 6,
          percent: 67,
          ownedDistinct: 5,
          totalCopies: 7,
          duplicateCount: 2,
        });

        const strict = yield* collection.getCollectionOverview(ALICE, { includeSecrets: false });
        expect(strict.sets.find((entry) => entry.setId === "t32-a")?.completion).toMatchObject({
          targetCount: 3,
          ownedDistinct: 1,
        });
      }),
    ));

  it("collection vide : tout à zéro", () =>
    runMemoryScenario(({ collection }) =>
      Effect.gen(function* () {
        const overview = yield* collection.getCollectionOverview(BOB);
        expect(overview.sets).toEqual([]);
        expect(overview.series).toEqual([]);
        expect(overview.global).toMatchObject({ percent: 0, totalCopies: 0, ownedDistinct: 0 });
      }),
    ));
});
