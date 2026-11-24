import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ALICE, BOB } from "./collection.fixture.ts";
import { failureOf, runMemoryScenario } from "./collection-test-harness.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const TOKEN = "user-jwt";

describe("BinderService (Memory) — classeurs d'extension", () => {
  it("suit une extension : titre par défaut, cover neutre, complétion vide", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const summary = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        expect(summary.binder).toMatchObject({
          userId: ALICE,
          kind: "set",
          setId: "t32-a",
          title: "Extension t32-a",
          coverType: "set_logo",
          coverCardId: null,
          coverStoragePath: null,
          isPinned: false,
          sortOrder: 0,
        });
        expect(summary.set).toMatchObject({ id: "t32-a", seriesId: "t32-sv", totalCount: 4 });
        expect(summary.completion).toMatchObject({
          ownedDistinct: 0,
          targetCount: 4,
          status: "not_started",
        });
        expect(summary.cardCount).toBe(4);
      }),
    ));

  it("est idempotent, ou lève BinderConflictError avec ifExists: fail", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const first = yield* binders.createSetBinder(ALICE, { setId: "t32-a", title: "  Mon A  " });
        expect(first.binder.title).toBe("Mon A");
        const again = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        expect(again.binder.id).toBe(first.binder.id);
        expect((yield* binders.listBinders(ALICE)).length).toBe(1);
        const conflict = yield* failureOf(
          binders.createSetBinder(ALICE, { setId: "t32-a", ifExists: "fail" }),
        );
        expect(conflict).toMatchObject({ _tag: "BinderConflictError", setId: "t32-a" });
        // Bob peut suivre la même extension
        const bob = yield* binders.createSetBinder(BOB, { setId: "t32-a" });
        expect(bob.binder.id).not.toBe(first.binder.id);
      }),
    ));

  it("refuse une extension inconnue", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const error = yield* failureOf(binders.createSetBinder(ALICE, { setId: "nope" }));
        expect(error).toMatchObject({
          _tag: "CatalogItemNotFoundError",
          entity: "set",
          id: "nope",
        });
      }),
    ));

  it("reflète la collection dans la complétion du classeur", () =>
    runMemoryScenario(({ binders, collection }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        yield* collection.upsertCardCopy(ALICE, { cardId: "t32-a-001", variant: "normal" });
        yield* collection.upsertCardCopy(ALICE, {
          cardId: "t32-a-001",
          variant: "holo",
          quantity: 2,
        });
        yield* collection.upsertCardCopy(ALICE, { cardId: "t32-a-004", variant: "normal" });
        yield* collection.upsertCardCopy(BOB, { cardId: "t32-a-002", variant: "normal" });
        const summary = yield* binders.getBinder(ALICE, binder.id);
        expect(summary.completion).toMatchObject({
          ownedDistinct: 2,
          totalCopies: 4,
          duplicateCount: 2,
          percent: 50,
          status: "in_progress",
        });
        expect(summary.ownedCount).toBe(2);
        const noSecrets = yield* binders.listBinders(ALICE, { includeSecrets: false });
        expect(noSecrets[0]?.completion).toMatchObject({ targetCount: 3, ownedDistinct: 1 });
      }),
    ));
});

describe("BinderService (Memory) — listing, accès, mise à jour", () => {
  it("trie is_pinned DESC, sort_order ASC, created_at DESC et filtre par kind / série", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const a = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        yield* Effect.sleep("2 millis");
        const b = yield* binders.createSetBinder(ALICE, { setId: "t32-b" });
        yield* Effect.sleep("2 millis");
        const c = yield* binders.createSetBinder(ALICE, { setId: "t32-c" });
        yield* Effect.sleep("2 millis");
        const custom = yield* binders.createCustomBinder(ALICE, { title: "Favs" });
        yield* binders.updateBinder(ALICE, a.binder.id, { sortOrder: 5 });
        yield* binders.updateBinder(ALICE, b.binder.id, { isPinned: true, sortOrder: 9 });
        yield* binders.createCustomBinder(BOB, { title: "Autre" });

        const all = yield* binders.listBinders(ALICE);
        expect(all.map((entry) => entry.binder.id)).toEqual([
          b.binder.id, // épinglé d'abord
          custom.binder.id, // sort_order 0, plus récent
          c.binder.id, // sort_order 0
          a.binder.id, // sort_order 5
        ]);
        expect((yield* binders.listBinders(ALICE, { kind: "custom" })).length).toBe(1);
        expect(
          (yield* binders.listBinders(ALICE, { seriesId: "t32-sv" })).map(
            (entry) => entry.binder.setId,
          ),
        ).toEqual(["t32-b", "t32-a"]);
        expect(
          (yield* binders.listBinders(ALICE, { seriesId: "t32-old" })).map(
            (entry) => entry.binder.setId,
          ),
        ).toEqual(["t32-c"]);
      }),
    ));

  it("isole les utilisateurs : BinderNotFoundError pour un classeur d'un autre ou inexistant", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Privé" });
        expect(yield* failureOf(binders.getBinder(BOB, binder.id))).toMatchObject({
          _tag: "BinderNotFoundError",
        });
        expect(
          yield* failureOf(binders.updateBinder(BOB, binder.id, { title: "Hack" })),
        ).toMatchObject({ _tag: "BinderNotFoundError" });
        expect(yield* failureOf(binders.deleteBinder(BOB, binder.id))).toMatchObject({
          _tag: "BinderNotFoundError",
        });
        expect(
          yield* failureOf(binders.getBinder(ALICE, "11111111-1111-4111-8111-111111111111")),
        ).toMatchObject({ _tag: "BinderNotFoundError" });
        expect(yield* failureOf(binders.getBinder(ALICE, "not-a-uuid"))).toMatchObject({
          _tag: "BinderNotFoundError",
        });
        expect(yield* failureOf(binders.listBinders("not-a-uuid"))).toMatchObject({
          _tag: "ValidationError",
        });
        expect((yield* binders.getBinder(ALICE, binder.id)).binder.title).toBe("Privé");
      }),
    ));

  it("updateBinder : titre normalisé, épinglage, ordre", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "A" });
        const updated = yield* binders.updateBinder(ALICE, binder.id, {
          title: "Évolitions Favs",
          isPinned: true,
          sortOrder: 3,
        });
        expect(updated.binder).toMatchObject({
          title: "Évolitions Favs",
          isPinned: true,
          sortOrder: 3,
        });
        const onlyTitle = yield* binders.updateBinder(ALICE, binder.id, { title: "B" });
        expect(onlyTitle.binder).toMatchObject({ title: "B", isPinned: true, sortOrder: 3 });
        expect(updated.binder.id).toBe(binder.id);
        expect(updated.binder.createdAt).toBe(binder.createdAt);
      }),
    ));
});

describe("BinderService (Memory) — covers", () => {
  it("cover 'card' : la carte doit exister", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        const ok = yield* binders.setBinderCover(ALICE, binder.id, {
          type: "card",
          cardId: "t32-a-002",
        });
        expect(ok.binder).toMatchObject({
          coverType: "card",
          coverCardId: "t32-a-002",
          coverStoragePath: null,
        });
        const missing = yield* failureOf(
          binders.setBinderCover(ALICE, binder.id, { type: "card", cardId: "ghost" }),
        );
        expect(missing).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card" });
        expect((yield* binders.getBinder(ALICE, binder.id)).binder.coverCardId).toBe("t32-a-002");
        const logo = yield* binders.setBinderCover(ALICE, binder.id, { type: "set_logo" });
        expect(logo.binder).toMatchObject({ coverType: "set_logo", coverCardId: null });
      }),
    ));

  it("upload : valide, recompresse, envoie vers <userId>/<binderId>.webp puis met à jour", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Cover" });
        const summary = yield* binders.setBinderCover(
          ALICE,
          binder.id,
          { type: "upload", image: PNG },
          TOKEN,
        );
        const path = `${ALICE}/${binder.id}.webp`;
        expect(summary.binder).toMatchObject({
          coverType: "upload",
          coverCardId: null,
          coverStoragePath: path,
        });
        expect([...storage.objects.keys()]).toEqual([path]);
        // l'objet stocké est le WebP recompressé, pas l'image brute
        expect(storage.objects.get(path)).not.toEqual(PNG);
      }),
    ));

  it("upload : jeton obligatoire, SVG / format inconnu refusés sans toucher au Storage", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Cover" });
        expect(
          yield* failureOf(
            binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }),
          ),
        ).toMatchObject({ _tag: "UnauthorizedBinderAccess" });
        expect(
          yield* failureOf(
            binders.setBinderCover(ALICE, binder.id, { type: "upload", image: SVG }, TOKEN),
          ),
        ).toMatchObject({ _tag: "InvalidCoverImageError", reason: "svg_not_allowed" });
        expect(
          yield* failureOf(
            binders.setBinderCover(
              ALICE,
              binder.id,
              { type: "upload", image: new Uint8Array([1, 2, 3]) },
              TOKEN,
            ),
          ),
        ).toMatchObject({ _tag: "InvalidCoverImageError", reason: "unsupported_format" });
        expect(storage.objects.size).toBe(0);
        expect((yield* binders.getBinder(ALICE, binder.id)).binder.coverType).toBe("set_logo");
      }),
    ));

  it("upload : un échec Storage laisse le classeur inchangé", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Cover" });
        storage.failures.upload = true;
        const error = yield* failureOf(
          binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }, TOKEN),
        );
        expect(error).toMatchObject({ _tag: "StorageServiceError", status: 503 });
        expect((yield* binders.getBinder(ALICE, binder.id)).binder.coverType).toBe("set_logo");
      }),
    ));

  it("upload sur le classeur d'un autre : BinderNotFoundError, rien n'est stocké", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Cover" });
        const error = yield* failureOf(
          binders.setBinderCover(BOB, binder.id, { type: "upload", image: PNG }, TOKEN),
        );
        expect(error._tag).toBe("BinderNotFoundError");
        expect(storage.objects.size).toBe(0);
      }),
    ));

  it("nettoie l'ancien objet quand 'upload' passe à 'set_logo' ou 'card'", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Cover" });
        const upload = { type: "upload", image: PNG } as const;
        yield* binders.setBinderCover(ALICE, binder.id, upload, TOKEN);
        expect(storage.objects.size).toBe(1);
        yield* binders.setBinderCover(ALICE, binder.id, { type: "set_logo" }, TOKEN);
        expect(storage.objects.size).toBe(0);
        yield* binders.setBinderCover(ALICE, binder.id, upload, TOKEN);
        yield* binders.setBinderCover(
          ALICE,
          binder.id,
          { type: "card", cardId: "t32-b-001" },
          TOKEN,
        );
        expect(storage.objects.size).toBe(0);
        // remplacement upload → upload : pas de suppression (même chemin, écrasé)
        yield* binders.setBinderCover(ALICE, binder.id, upload, TOKEN);
        yield* binders.setBinderCover(ALICE, binder.id, upload, TOKEN);
        expect(storage.objects.size).toBe(1);
      }),
    ));

  it("un nettoyage Storage en échec (ou sans jeton) ne bloque jamais", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Cover" });
        yield* binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }, TOKEN);
        storage.failures.remove = true;
        const logo = yield* binders.setBinderCover(ALICE, binder.id, { type: "set_logo" }, TOKEN);
        expect(logo.binder.coverType).toBe("set_logo");
        expect(storage.objects.size).toBe(1); // orphelin toléré, jamais bloquant
        storage.failures.remove = false;
        yield* binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }, TOKEN);
        const noToken = yield* binders.setBinderCover(ALICE, binder.id, { type: "set_logo" });
        expect(noToken.binder.coverType).toBe("set_logo");
      }),
    ));

  it("deleteBinder supprime le classeur, ses cartes et sa cover (best-effort)", () =>
    runMemoryScenario(({ binders, storage }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "À supprimer" });
        yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001");
        yield* binders.setBinderCover(ALICE, binder.id, { type: "upload", image: PNG }, TOKEN);
        yield* binders.deleteBinder(ALICE, binder.id, TOKEN);
        expect(storage.objects.size).toBe(0);
        expect((yield* binders.listBinders(ALICE)).length).toBe(0);
        expect((yield* failureOf(binders.getBinder(ALICE, binder.id)))._tag).toBe(
          "BinderNotFoundError",
        );

        const second = yield* binders.createCustomBinder(ALICE, { title: "Bis" });
        yield* binders.setBinderCover(
          ALICE,
          second.binder.id,
          { type: "upload", image: PNG },
          TOKEN,
        );
        storage.failures.remove = true;
        yield* binders.deleteBinder(ALICE, second.binder.id, TOKEN); // ne bloque pas
        expect((yield* binders.listBinders(ALICE)).length).toBe(0);
      }),
    ));
});

describe("BinderService (Memory) — cartes d'un dossier perso", () => {
  it("ajoute en fin de dossier, met à jour la position d'un doublon, compte les possédées", () =>
    runMemoryScenario(({ binders, collection }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Favs" });
        const first = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001");
        const second = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-b-002");
        const third = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-c-001");
        expect([first.position, second.position, third.position]).toEqual([0, 1, 2]);
        const again = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001");
        expect(again.position).toBe(0); // sans position : inchangée
        expect(again.addedAt).toBe(first.addedAt);
        const moved = yield* binders.addCardToCustomBinder(ALICE, binder.id, "t32-a-001", 7);
        expect(moved.position).toBe(7);
        expect(
          (yield* binders.listBinderCards(ALICE, binder.id)).map((entry) => entry.cardId),
        ).toEqual(["t32-b-002", "t32-c-001", "t32-a-001"]);
        yield* collection.upsertCardCopy(ALICE, { cardId: "t32-b-002", variant: "normal" });
        const summary = yield* binders.getBinder(ALICE, binder.id);
        expect(summary).toMatchObject({ cardCount: 3, ownedCount: 1, completion: null });
      }),
    ));

  it("refuse carte inconnue, position invalide et classeur d'extension", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const custom = yield* binders.createCustomBinder(ALICE, { title: "Favs" });
        const set = yield* binders.createSetBinder(ALICE, { setId: "t32-a" });
        expect(
          yield* failureOf(binders.addCardToCustomBinder(ALICE, custom.binder.id, "ghost")),
        ).toMatchObject({ _tag: "CatalogItemNotFoundError", entity: "card" });
        expect(
          yield* failureOf(binders.addCardToCustomBinder(ALICE, custom.binder.id, "t32-a-001", -1)),
        ).toMatchObject({ _tag: "ValidationError" });
        expect(
          yield* failureOf(binders.addCardToCustomBinder(ALICE, set.binder.id, "t32-a-001")),
        ).toMatchObject({ _tag: "ValidationError" });
        expect(
          yield* failureOf(binders.addCardToCustomBinder(BOB, custom.binder.id, "t32-a-001")),
        ).toMatchObject({ _tag: "BinderNotFoundError" });
        expect(yield* binders.listBinderCards(ALICE, set.binder.id)).toEqual([]);
      }),
    ));

  it("réordonne (permutation stricte) et retire une carte (idempotent)", () =>
    runMemoryScenario(({ binders }) =>
      Effect.gen(function* () {
        const { binder } = yield* binders.createCustomBinder(ALICE, { title: "Favs" });
        for (const cardId of ["t32-a-001", "t32-a-002", "t32-a-003"]) {
          yield* binders.addCardToCustomBinder(ALICE, binder.id, cardId);
        }
        const reordered = yield* binders.reorderCustomBinderCards(ALICE, binder.id, [
          "t32-a-003",
          "t32-a-001",
          "t32-a-002",
        ]);
        expect(reordered.map((entry) => [entry.cardId, entry.position])).toEqual([
          ["t32-a-003", 0],
          ["t32-a-001", 1],
          ["t32-a-002", 2],
        ]);
        for (const bad of [
          ["t32-a-003", "t32-a-001"],
          ["t32-a-003", "t32-a-001", "t32-a-001"],
          ["t32-a-003", "t32-a-001", "t32-b-001"],
        ]) {
          expect(
            yield* failureOf(binders.reorderCustomBinderCards(ALICE, binder.id, bad)),
          ).toMatchObject({ _tag: "ValidationError" });
        }
        expect(
          yield* failureOf(binders.reorderCustomBinderCards(BOB, binder.id, [])),
        ).toMatchObject({ _tag: "BinderNotFoundError" });

        yield* binders.removeCardFromCustomBinder(ALICE, binder.id, "t32-a-001");
        yield* binders.removeCardFromCustomBinder(ALICE, binder.id, "t32-a-001");
        expect(
          (yield* binders.listBinderCards(ALICE, binder.id)).map((entry) => entry.cardId),
        ).toEqual(["t32-a-003", "t32-a-002"]);
        expect(
          yield* failureOf(binders.removeCardFromCustomBinder(BOB, binder.id, "t32-a-002")),
        ).toMatchObject({ _tag: "BinderNotFoundError" });
      }),
    ));
});
