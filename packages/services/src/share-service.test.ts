import {
  decodeSharedBinderPayload,
  isValidShareToken,
  SHARE_TOKEN_MIN_LENGTH,
} from "@pokevault/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { BinderService, BinderServiceMemory } from "./binder-service.ts";
import { ALICE, BOB, COLLECTION_MEMORY_CATALOG } from "./collection.fixture.ts";
import { CollectionMemoryStore, CollectionMemoryStoreLayer } from "./collection-memory.ts";
import { CollectionService, CollectionServiceMemory } from "./collection-service.ts";
import { failureOf } from "./collection-test-harness.ts";
import { CoverImageProcessorMemory } from "./cover-image.ts";
import {
  generateShareToken,
  ShareService,
  ShareServiceMemory,
  ShareServiceMemoryLayer,
  type ShareServiceMemoryOptions,
} from "./share-service.ts";
import { BinderCoverStorage, makeMemoryBinderCoverStorage } from "./storage.ts";

const A1 = "t32-a-001";
const A2 = "t32-a-002";
const A3 = "t32-a-003";
const A4 = "t32-a-004";
const B1 = "t32-b-001";
const SET_A = "t32-a";
const SET_B = "t32-b";

const setBinder = (
  binders: typeof BinderService.Service,
  userId: string,
  input: Parameters<typeof BinderService.Service.createSetBinder>[1],
) => binders.createSetBinder(userId, input).pipe(Effect.map((summary) => summary.binder));

const customBinder = (
  binders: typeof BinderService.Service,
  userId: string,
  input: Parameters<typeof BinderService.Service.createCustomBinder>[1],
) => binders.createCustomBinder(userId, input).pipe(Effect.map((summary) => summary.binder));

const run = <A>(
  body: (ctx: {
    readonly share: typeof ShareService.Service;
    readonly binders: typeof BinderService.Service;
    readonly collection: typeof CollectionService.Service;
    readonly store: typeof CollectionMemoryStore.Service;
  }) => Effect.Effect<A, unknown>,
  options?: ShareServiceMemoryOptions,
): Promise<A> => {
  const storage = makeMemoryBinderCoverStorage();
  const layer = Layer.mergeAll(
    options === undefined ? ShareServiceMemory : ShareServiceMemoryLayer(options),
    BinderServiceMemory,
    CollectionServiceMemory,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CollectionMemoryStoreLayer(COLLECTION_MEMORY_CATALOG),
        Layer.succeed(BinderCoverStorage, storage.service),
        CoverImageProcessorMemory,
      ),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({
        share: yield* ShareService,
        binders: yield* BinderService,
        collection: yield* CollectionService,
        store: yield* CollectionMemoryStore,
      });
    }).pipe(Effect.provide(layer)),
  );
};

describe("generateShareToken", () => {
  it("32 octets aléatoires en base64url : toujours 43 caractères valides", () => {
    for (let index = 0; index < 200; index += 1) {
      const token = generateShareToken();
      expect(token).toHaveLength(SHARE_TOKEN_MIN_LENGTH);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isValidShareToken(token)).toBe(true);
    }
  });

  it("n'est pas énumérable : 2000 jetons tous distincts", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateShareToken()));
    expect(tokens.size).toBe(2000);
  });
});

describe("ShareService (Memory) — liens", () => {
  it("crée un lien actif avec jeton, défauts SQL (showQuantities = true)", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const binder = yield* setBinder(binders, ALICE, { setId: SET_A });
        const link = yield* share.createLink(ALICE, { binderId: binder.id });
        expect(link).toMatchObject({
          userId: ALICE,
          binderId: binder.id,
          isActive: true,
          showQuantities: true,
          revokedAt: null,
        });
        expect(isValidShareToken(link.token)).toBe(true);
        expect(new Date(link.createdAt).toISOString()).toBe(link.createdAt);
        expect(yield* share.listLinks(ALICE)).toEqual([link]);

        const hidden = yield* share.createLink(ALICE, {
          binderId: binder.id,
          showQuantities: false,
        });
        expect(hidden.showQuantities).toBe(false);
        // Un nouveau lien = un nouveau jeton (plusieurs liens actifs par classeur permis).
        expect(hidden.token).not.toBe(link.token);
        expect(hidden.id).not.toBe(link.id);
      }),
    ));

  it("on ne partage jamais le classeur d'un autre utilisateur ni un classeur inconnu", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const bobBinder = yield* setBinder(binders, BOB, { setId: SET_A });
        const stolen = yield* failureOf(share.createLink(ALICE, { binderId: bobBinder.id }));
        expect(stolen).toMatchObject({ _tag: "BinderNotFoundError", binderId: bobBinder.id });
        const unknown = yield* failureOf(
          share.createLink(ALICE, { binderId: "aaaaaaaa-0000-4000-8000-0000000000ff" }),
        );
        expect(unknown._tag).toBe("BinderNotFoundError");
        expect(yield* share.listLinks(ALICE)).toEqual([]);
        expect(yield* share.listLinks(BOB)).toEqual([]);
      }),
    ));

  it("entrées invalides : ValidationError (binderId, userId)", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const binder = yield* setBinder(binders, ALICE, { setId: SET_A });
        const badBinder = yield* failureOf(share.createLink(ALICE, { binderId: "nope" }));
        expect(badBinder._tag).toBe("ValidationError");
        const badFlag = yield* failureOf(
          share.createLink(ALICE, { binderId: binder.id, showQuantities: "yes" as never }),
        );
        expect(badFlag._tag).toBe("ValidationError");
        const badUser = yield* failureOf(share.createLink("nope", { binderId: binder.id }));
        expect(badUser._tag).toBe("ValidationError");
        const badList = yield* failureOf(share.listLinks("nope"));
        expect(badList._tag).toBe("ValidationError");
      }),
    ));

  it("liste : récents d'abord, filtres binderId / activeOnly, isolés par utilisateur", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const a = yield* setBinder(binders, ALICE, { setId: SET_A });
        const b = yield* setBinder(binders, ALICE, { setId: SET_B });
        const bob = yield* setBinder(binders, BOB, { setId: SET_A });
        const l1 = yield* share.createLink(ALICE, { binderId: a.id });
        const l2 = yield* share.createLink(ALICE, { binderId: b.id });
        const l3 = yield* share.createLink(ALICE, { binderId: a.id });
        yield* share.createLink(BOB, { binderId: bob.id });
        yield* share.revokeLink(ALICE, l2.id);

        const ids = (links: ReadonlyArray<{ readonly id: string }>) => links.map((l) => l.id);
        expect(ids(yield* share.listLinks(ALICE))).toEqual([l3.id, l2.id, l1.id]);
        expect(ids(yield* share.listLinks(ALICE, { binderId: a.id }))).toEqual([l3.id, l1.id]);
        expect(ids(yield* share.listLinks(ALICE, { activeOnly: true }))).toEqual([l3.id, l1.id]);
        expect(ids(yield* share.listLinks(ALICE, { binderId: b.id, activeOnly: true }))).toEqual(
          [],
        );
        expect((yield* share.listLinks(BOB)).length).toBe(1);
      }),
    ));

  it("révoque (is_active = false + revoked_at), idempotent ; le jeton ne résout plus rien", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const binder = yield* setBinder(binders, ALICE, { setId: SET_A });
        const link = yield* share.createLink(ALICE, { binderId: binder.id });
        expect((yield* share.getSharedBinder(link.token)).binder.id).toBe(binder.id);

        const revoked = yield* share.revokeLink(ALICE, link.id);
        expect(revoked).toMatchObject({ id: link.id, isActive: false, token: link.token });
        expect(revoked.revokedAt).not.toBeNull();
        const gone = yield* failureOf(share.getSharedBinder(link.token));
        expect(gone._tag).toBe("ShareLinkNotFoundError");

        const again = yield* share.revokeLink(ALICE, link.id);
        expect(again).toEqual(revoked);
        expect(yield* share.listLinks(ALICE, { activeOnly: true })).toEqual([]);
      }),
    ));

  it("RLS : Bob ne révoque ni ne modifie le lien d'Alice ; lien inconnu / non-UUID → introuvable", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const binder = yield* setBinder(binders, ALICE, { setId: SET_A });
        const link = yield* share.createLink(ALICE, { binderId: binder.id });

        const revoke = yield* failureOf(share.revokeLink(BOB, link.id));
        expect(revoke).toMatchObject({ _tag: "ShareLinkNotFoundError", linkId: link.id });
        const update = yield* failureOf(share.updateShowQuantities(BOB, link.id, false));
        expect(update._tag).toBe("ShareLinkNotFoundError");
        expect((yield* failureOf(share.revokeLink(ALICE, "nope")))._tag).toBe(
          "ShareLinkNotFoundError",
        );
        expect(
          (yield* failureOf(share.revokeLink(ALICE, "dddddddd-0000-4000-8000-000000000001")))._tag,
        ).toBe("ShareLinkNotFoundError");
        expect(yield* share.listLinks(BOB)).toEqual([]);
        expect((yield* share.listLinks(ALICE))[0]).toEqual(link);
        // Le lien d'Alice reste actif.
        expect((yield* share.getSharedBinder(link.token)).owner.displayName).toBe("Collectionneur");
      }),
    ));

  it("updateShowQuantities bascule l'affichage des quantités", () =>
    run(({ share, binders }) =>
      Effect.gen(function* () {
        const binder = yield* setBinder(binders, ALICE, { setId: SET_A });
        const link = yield* share.createLink(ALICE, { binderId: binder.id });
        const hidden = yield* share.updateShowQuantities(ALICE, link.id, false);
        expect(hidden).toEqual({ ...link, showQuantities: false });
        expect((yield* share.getSharedBinder(link.token)).binder.showQuantities).toBe(false);
        const shown = yield* share.updateShowQuantities(ALICE, link.id, true);
        expect(shown.showQuantities).toBe(true);
      }),
    ));
});

describe("ShareService (Memory) — lecture publique (projection stricte)", () => {
  /** Alice partage Alpha ; données sensibles partout ; Bob possède aussi des cartes. */
  const seed = (ctx: Parameters<Parameters<typeof run>[0]>[0]) =>
    Effect.gen(function* () {
      const { binders, collection, store } = ctx;
      const alpha = yield* setBinder(binders, ALICE, { setId: SET_A, title: "Alpha partagé" });
      const secret = yield* setBinder(binders, ALICE, {
        setId: SET_B,
        title: "SECRET_OTHER_BINDER",
      });
      yield* collection.upsertCardCopy(ALICE, {
        cardId: A1,
        variant: "normal",
        quantity: 2,
        purchasePriceCents: 99999,
        notes: "SECRET_PRIVATE_NOTE",
        acquiredAt: "2020-02-29",
      });
      yield* collection.upsertCardCopy(ALICE, {
        cardId: A1,
        variant: "normal",
        quantity: 1,
        gradingCompany: "PSA",
        gradingScore: "10",
        notes: "SECRET_GRADED_NOTE",
      });
      yield* collection.upsertCardCopy(ALICE, {
        cardId: A1,
        language: "EN",
        variant: "holo",
        condition: "EX",
        quantity: 1,
      });
      yield* collection.upsertCardCopy(ALICE, { cardId: A3, variant: "reverse" });
      yield* collection.upsertCardCopy(ALICE, {
        cardId: B1,
        variant: "normal",
        quantity: 5,
        purchasePriceCents: 55555,
      });
      yield* collection.upsertCardCopy(BOB, {
        cardId: A2,
        variant: "normal",
        quantity: 9,
        notes: "BOB_PRIVATE_NOTE",
      });
      // Cover uploadée simulée : le chemin Storage (user_id inclus) ne doit jamais sortir.
      const stored = store.state.binders.get(alpha.id);
      if (stored !== undefined) {
        store.state.binders.set(alpha.id, {
          ...stored,
          coverType: "upload",
          coverCardId: null,
          coverStoragePath: `${ALICE}/${alpha.id}.webp`,
        });
      }
      return { alpha, secret };
    });

  it("projette le classeur d'extension : owner, binder, cartes triées, quantités agrégées", () =>
    run(
      (ctx) =>
        Effect.gen(function* () {
          const { alpha } = yield* seed(ctx);
          const link = yield* ctx.share.createLink(ALICE, { binderId: alpha.id });
          const payload = yield* ctx.share.getSharedBinder(link.token);

          expect(payload.owner).toEqual({ displayName: "Alice Test", avatarInitials: "AT" });
          expect(payload.binder).toEqual({
            id: alpha.id,
            kind: "set",
            title: "Alpha partagé",
            setId: SET_A,
            setCode: "T32-A",
            setName: "Extension t32-a",
            coverType: "upload",
            coverLogoUrl: "https://assets.tcgdex.net/fr/t32-a/logo",
            coverCardImageUrl: null,
            hasUploadedCover: true,
            showQuantities: true,
            ownedCount: 2,
            totalCards: 4,
          });
          expect(payload.cards.map((card) => card.cardId)).toEqual([A1, A2, A3, A4]);
          expect(payload.cards[0]).toMatchObject({
            localId: "001",
            localIdNumeric: 1,
            setCode: "T32-A",
            owned: true,
            quantity: 4,
            copies: [
              { language: "EN", variant: "holo", quantity: 1 },
              { language: "FR", variant: "normal", quantity: 3 },
            ],
          });
          // Bob possède 9 exemplaires de la carte 002 : jamais mélangés avec Alice.
          expect(payload.cards[1]).toMatchObject({ owned: false, quantity: 0, copies: [] });
          expect(payload.cards[2]).toMatchObject({
            owned: true,
            quantity: 1,
            copies: [{ language: "FR", variant: "reverse", quantity: 1 }],
          });
          // La projection respecte exactement le schéma (clés inconnues refusées).
          yield* decodeSharedBinderPayload(payload);
        }),
      {
        owner: () => ({ displayName: "Alice Test", avatarInitials: "AT" }),
      },
    ));

  it("ZÉRO fuite : aucune donnée privée, aucun autre classeur, aucun user_id", () =>
    run((ctx) =>
      Effect.gen(function* () {
        const { alpha, secret } = yield* seed(ctx);
        const link = yield* ctx.share.createLink(ALICE, { binderId: alpha.id });
        const payload = yield* ctx.share.getSharedBinder(link.token);
        const text = JSON.stringify(payload).toLowerCase();

        for (const forbidden of [
          ALICE,
          BOB,
          "0000000000a1",
          "0000000000b1",
          "99999",
          "55555",
          "secret_private_note",
          "secret_graded_note",
          "secret_other_binder",
          "bob_private_note",
          secret.id,
          "purchase",
          "notes",
          "acquired",
          "grading",
          "psa",
          "condition",
          "storage",
          ".webp",
          "email",
          "discord",
          "userid",
          "user_id",
          "wishlist",
          B1, // carte du 2ᵉ classeur (autre extension)
        ]) {
          expect(text, `leak: ${forbidden}`).not.toContain(forbidden.toLowerCase());
        }
        expect(Object.keys(payload).sort()).toEqual(["binder", "cards", "owner"]);
        expect(Object.keys(payload.owner).sort()).toEqual(["avatarInitials", "displayName"]);
        for (const card of payload.cards) {
          expect(Object.keys(card).sort()).toEqual([
            "cardId",
            "copies",
            "holoEffect",
            "imageBaseUrl",
            "localId",
            "localIdNumeric",
            "nameFr",
            "owned",
            "quantity",
            "rarity",
            "setCode",
          ]);
        }
      }),
    ));

  it("showQuantities = false : quantity = null partout, possession toujours visible", () =>
    run((ctx) =>
      Effect.gen(function* () {
        const { alpha } = yield* seed(ctx);
        const link = yield* ctx.share.createLink(ALICE, {
          binderId: alpha.id,
          showQuantities: false,
        });
        const payload = yield* ctx.share.getSharedBinder(link.token);
        expect(payload.binder.showQuantities).toBe(false);
        expect(payload.binder.ownedCount).toBe(2);
        for (const card of payload.cards) {
          expect(card.quantity).toBeNull();
          for (const copy of card.copies) expect(copy.quantity).toBeNull();
        }
        expect(payload.cards[0]?.owned).toBe(true);
        expect(payload.cards[0]?.copies.map((copy) => `${copy.language}/${copy.variant}`)).toEqual([
          "EN/holo",
          "FR/normal",
        ]);
        expect(payload.cards[1]?.owned).toBe(false);
      }),
    ));

  it("dossier perso : cartes dans l'ordre des positions, de plusieurs extensions", () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* seed(ctx);
        const custom = yield* customBinder(ctx.binders, ALICE, { title: "Dossier favoris" });
        yield* ctx.binders.addCardToCustomBinder(ALICE, custom.id, B1, 0);
        yield* ctx.binders.addCardToCustomBinder(ALICE, custom.id, A1, 1);
        yield* ctx.binders.addCardToCustomBinder(ALICE, custom.id, A2, 2);
        const link = yield* ctx.share.createLink(ALICE, { binderId: custom.id });
        const payload = yield* ctx.share.getSharedBinder(link.token);

        expect(payload.binder).toMatchObject({
          kind: "custom",
          title: "Dossier favoris",
          setId: null,
          setCode: null,
          setName: null,
          hasUploadedCover: false,
          ownedCount: 2,
          totalCards: 3,
        });
        expect(payload.cards.map((card) => card.cardId)).toEqual([B1, A1, A2]);
        expect(payload.cards[0]).toMatchObject({ quantity: 5, setCode: "T32-B" });
        expect(JSON.stringify(payload)).not.toContain("SECRET_OTHER_BINDER");
      }),
    ));

  it("détails de carte et profil injectables (cover carte, nom, rareté, effet holo)", () =>
    run(
      (ctx) =>
        Effect.gen(function* () {
          const { alpha } = yield* seed(ctx);
          yield* ctx.binders.setBinderCover(ALICE, alpha.id, { type: "card", cardId: A3 });
          const link = yield* ctx.share.createLink(ALICE, { binderId: alpha.id });
          const payload = yield* ctx.share.getSharedBinder(link.token);
          expect(payload.binder).toMatchObject({
            coverType: "card",
            coverCardImageUrl: "https://img.test/t32-a-003",
            hasUploadedCover: false,
          });
          expect(payload.cards[0]).toMatchObject({
            nameFr: "Pikachu",
            rarity: "Commune",
            holoEffect: "holo",
            imageBaseUrl: "https://img.test/t32-a-001",
          });
          expect(payload.owner.displayName).toBe("Alice Collectionneuse");
        }),
      {
        owner: () => ({ displayName: "Alice Collectionneuse", avatarInitials: "AC" }),
        cardDetails: (cardId) => ({
          nameFr: cardId === A1 ? "Pikachu" : `Carte ${cardId}`,
          rarity: cardId === A1 ? "Commune" : null,
          holoEffect: cardId === A1 ? "holo" : "none",
          imageBaseUrl: `https://img.test/${cardId}`,
        }),
      },
    ));

  it("jeton mal formé, inconnu ou révoqué : ShareLinkNotFoundError sans fuite du jeton", () =>
    run((ctx) =>
      Effect.gen(function* () {
        const { alpha } = yield* seed(ctx);
        const link = yield* ctx.share.createLink(ALICE, { binderId: alpha.id });
        yield* ctx.share.revokeLink(ALICE, link.id);

        const unknownButValid = generateShareToken();
        for (const token of [
          "",
          "short",
          "A".repeat(42),
          "A".repeat(129),
          `${"A".repeat(42)}+`,
          `${link.token}'; select 1 --`,
          unknownButValid,
          link.token, // révoqué
        ]) {
          const error = yield* failureOf(ctx.share.getSharedBinder(token));
          expect(error._tag).toBe("ShareLinkNotFoundError");
          expect(error.message).toBe("shared binder not found");
          if (token !== "") expect(JSON.stringify(error)).not.toContain(token);
        }
      }),
    ));

  it("un classeur supprimé n'est plus accessible via son lien", () =>
    run((ctx) =>
      Effect.gen(function* () {
        const { alpha } = yield* seed(ctx);
        const link = yield* ctx.share.createLink(ALICE, { binderId: alpha.id });
        ctx.store.state.binders.delete(alpha.id);
        const error = yield* failureOf(ctx.share.getSharedBinder(link.token));
        expect(error._tag).toBe("ShareLinkNotFoundError");
      }),
    ));

  it("deux utilisateurs, deux jetons : chacun ne voit que ses cartes", () =>
    run((ctx) =>
      Effect.gen(function* () {
        const { alpha } = yield* seed(ctx);
        const bobBinder = yield* setBinder(ctx.binders, BOB, { setId: SET_A });
        const aliceLink = yield* ctx.share.createLink(ALICE, { binderId: alpha.id });
        const bobLink = yield* ctx.share.createLink(BOB, { binderId: bobBinder.id });
        const forBob = yield* ctx.share.getSharedBinder(bobLink.token);
        const forAlice = yield* ctx.share.getSharedBinder(aliceLink.token);
        expect(forBob.cards.filter((c) => c.owned).map((c) => c.cardId)).toEqual([A2]);
        expect(forBob.cards[1]?.quantity).toBe(9);
        expect(forAlice.cards.filter((c) => c.owned).map((c) => c.cardId)).toEqual([A1, A3]);
        expect(JSON.stringify(forBob)).not.toContain("99999");
      }),
    ));
});
