import { decodeSharedBinderPayload, type SharedBinderPayload } from "@pokevault/domain";
import { Effect } from "effect";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { Database } from "./db.ts";
import { withUserRls } from "./rls.ts";
import { generateShareToken, ShareService, ShareServiceLive } from "./share-service.ts";

const A1 = "t32-a-001";
const A2 = "t32-a-002";
const A3 = "t32-a-003";
const B1 = "t32-b-001";

const ALICE_EMAIL = "alice.t32@pokevault.test";
const ALICE_BINDER = "aaaaaaaa-0000-4000-8000-00000000b001";
const ALICE_SECRET_BINDER = "aaaaaaaa-0000-4000-8000-00000000b002";
const BOB_BINDER = "bbbbbbbb-0000-4000-8000-00000000b001";
const ALICE_COVER_PATH = `${ALICE}/${ALICE_BINDER}.webp`;
const WEBHOOK = "https://discord.com/api/webhooks/123456/SECRETWEBHOOKTOKEN";

/** Chaînes (valeurs ET noms de colonnes) qui ne doivent JAMAIS apparaître dans la réponse publique. */
const FORBIDDEN = [
  ALICE,
  BOB,
  ALICE_EMAIL,
  "alice.t32",
  "@pokevault",
  "99999",
  "88888",
  "55555",
  "66666",
  "SECRET_PRIVATE_NOTE",
  "SECRET_GRADED_NOTE",
  "SECRET_OTHER_BINDER",
  "SECRET_OTHER_NOTE",
  "BOB_PRIVATE_NOTE",
  ALICE_SECRET_BINDER,
  BOB_BINDER,
  ALICE_COVER_PATH,
  "discord",
  "987654321098765432",
  "SECRETWEBHOOKTOKEN",
  "webhook",
  "purchase",
  "notes",
  "acquired",
  "grading",
  "psa",
  "condition",
  "storage",
  ".webp",
  "user_id",
  "userid",
  "email",
  "wishlist",
  "price_alert",
  B1, // carte du classeur privé d'Alice
] as const;

/**
 * `ShareServiceLive` contre Postgres réel (migrations 001, 002, 004 et 008 jouées, voir
 * `collection-pg-harness.ts`) : RLS Alice / Bob, appel de `get_shared_binder` sous le rôle
 * `anon`, tests ANTI-FUITE, révocation immédiate. Ignoré sans `PGTEST_URL`.
 *
 * Le harnais partage un advisory lock de session (`acquirePgLock` / `releasePgLock`, pris par
 * `seedPgFixture`, relâché par `dropPgFixture`) : deux fichiers `*.pg.test.ts` ne s'exécutent
 * jamais en même temps sur la base.
 */
describe.skipIf(PGTEST_URL === undefined)("ShareService (Postgres réel)", () => {
  const run = <A>(
    body: (ctx: {
      readonly share: typeof ShareService.Service;
      readonly database: typeof Database.Service;
    }) => Effect.Effect<A, unknown>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* body({ share: yield* ShareService, database: yield* Database });
        }).pipe(Effect.provide(ShareServiceLive), Effect.provide(appDatabaseLayer(6))),
      ),
    );

  const linkRows = (userId: string) =>
    Effect.promise(() =>
      withAdmin(
        (admin) =>
          admin<
            Array<{
              id: string;
              binder_id: string;
              token: string;
              is_active: boolean;
              show_quantities: boolean;
              revoked_at: Date | null;
            }>
          >`select id, binder_id, token, is_active, show_quantities, revoked_at
              from public.share_links where user_id = ${userId} order by created_at, id`,
      ),
    );

  /** Appelle `get_shared_binder` sous le rôle `anon` (comme la route publique `/s/:token`). */
  const publicPayload = (token: string): Effect.Effect<unknown> =>
    Effect.promise(() =>
      withAdmin((admin) =>
        admin.begin(async (tx) => {
          await tx`set local role anon`;
          const rows = await tx<Array<{ payload: unknown }>>`
            select public.get_shared_binder(${token}::text) as payload`;
          return rows[0]?.payload ?? null;
        }),
      ),
    );

  /** Exécute `query` sous un rôle sans droits et renvoie le SQLSTATE de l'erreur (ou `undefined`). */
  const sqlStateAs = (role: string, query: (tx: postgres.Sql) => Promise<unknown>) =>
    Effect.promise(() =>
      withAdmin(async (admin) => {
        try {
          await admin.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await query(tx as unknown as postgres.Sql);
          });
          return undefined;
        } catch (cause) {
          const code = (cause as { readonly code?: unknown }).code;
          return typeof code === "string" ? code : "unknown";
        }
      }),
    );

  /** Données sensibles partout : le classeur partagé (Alpha) + un classeur privé + Bob. */
  const seedSensitiveData = () =>
    withAdmin(async (admin) => {
      await admin`
        update public.profiles
           set display_name = 'Alice Collectionneuse', avatar_initials = 'AC',
               discord_user_id = '987654321098765432', discord_webhook_url = ${WEBHOOK}
         where id = ${ALICE}`;
      await admin`
        insert into public.binders (id, user_id, kind, set_id, title, cover_type, cover_storage_path)
        values (${ALICE_BINDER}, ${ALICE}, 'set', 't32-a', 'Classeur Alpha partagé', 'upload',
                ${ALICE_COVER_PATH})`;
      await admin`
        insert into public.binders (id, user_id, kind, set_id, title)
        values (${ALICE_SECRET_BINDER}, ${ALICE}, 'set', 't32-b', 'SECRET_OTHER_BINDER'),
               (${BOB_BINDER}, ${BOB}, 'set', 't32-a', 'Classeur de Bob')`;
      await admin`
        insert into public.user_card_copies
          (user_id, card_id, language, variant, condition, quantity, purchase_price_cents, notes,
           acquired_at, grading_company, grading_score)
        values
          (${ALICE}, ${A1}, 'FR', 'normal', 'NM', 2, 99999, 'SECRET_PRIVATE_NOTE', '2020-02-29', null, null),
          (${ALICE}, ${A1}, 'FR', 'normal', 'NM', 1, 88888, 'SECRET_GRADED_NOTE', '2021-03-01', 'PSA', '10'),
          (${ALICE}, ${A1}, 'EN', 'holo', 'EX', 1, null, null, null, null, null),
          (${ALICE}, ${A3}, 'FR', 'reverse', 'NM', 1, null, null, null, null, null),
          (${ALICE}, ${B1}, 'FR', 'normal', 'NM', 5, 55555, 'SECRET_OTHER_NOTE', null, null, null),
          (${BOB}, ${A2}, 'FR', 'normal', 'NM', 9, 66666, 'BOB_PRIVATE_NOTE', null, null, null)`;
    });

  beforeAll(seedPgFixture, PG_HOOK_TIMEOUT_MS);
  beforeEach(async () => {
    await resetUserData();
    await withAdmin(
      (admin) => admin`delete from public.share_links where user_id in (${ALICE}, ${BOB})`,
    );
  }, PG_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    try {
      await resetUserData();
    } finally {
      await dropPgFixture();
      await releasePgLock();
    }
  }, PG_HOOK_TIMEOUT_MS);

  it("CRUD : jeton cryptographique, défauts SQL, liste, bascule des quantités, sérialisation des dates", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });
        expect(link).toMatchObject({
          userId: ALICE,
          binderId: ALICE_BINDER,
          isActive: true,
          showQuantities: true,
          revokedAt: null,
        });
        expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(new Date(link.createdAt).toISOString()).toBe(link.createdAt);

        const hidden = yield* share.createLink(ALICE, {
          binderId: ALICE_BINDER,
          showQuantities: false,
        });
        expect(hidden.showQuantities).toBe(false);
        expect(hidden.token).not.toBe(link.token);

        const listed = yield* share.listLinks(ALICE);
        expect(listed.map((l) => l.id)).toEqual([hidden.id, link.id]);
        expect(yield* share.listLinks(ALICE, { binderId: ALICE_SECRET_BINDER })).toEqual([]);

        const updated = yield* share.updateShowQuantities(ALICE, link.id, false);
        expect(updated).toEqual({ ...link, showQuantities: false });
        const restored = yield* share.updateShowQuantities(ALICE, link.id, true);
        expect(restored.showQuantities).toBe(true);
        expect((yield* linkRows(ALICE)).length).toBe(2);
      }),
    ));

  it("RLS : Bob ne voit, ne partage, ne révoque ni ne modifie rien d'Alice", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });

        expect(yield* share.listLinks(BOB)).toEqual([]);
        const stolen = yield* failureOf(share.createLink(BOB, { binderId: ALICE_BINDER }));
        expect(stolen).toMatchObject({ _tag: "BinderNotFoundError", binderId: ALICE_BINDER });
        const aliceOnBob = yield* failureOf(share.createLink(ALICE, { binderId: BOB_BINDER }));
        expect(aliceOnBob._tag).toBe("BinderNotFoundError");
        const revoke = yield* failureOf(share.revokeLink(BOB, link.id));
        expect(revoke._tag).toBe("ShareLinkNotFoundError");
        const update = yield* failureOf(share.updateShowQuantities(BOB, link.id, false));
        expect(update._tag).toBe("ShareLinkNotFoundError");
        expect((yield* failureOf(share.revokeLink(ALICE, "not-a-uuid")))._tag).toBe(
          "ShareLinkNotFoundError",
        );

        const rows = yield* linkRows(ALICE);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ is_active: true, show_quantities: true, revoked_at: null });
        expect(yield* linkRows(BOB)).toEqual([]);
        expect((yield* failureOf(share.createLink("nope", { binderId: ALICE_BINDER })))._tag).toBe(
          "ValidationError",
        );
      }),
    ));

  it("ANTI-FUITE : la réponse `anon` ne contient AUCUNE donnée privée, que la projection attendue", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });

        const raw = yield* publicPayload(link.token);
        expect(raw).not.toBeNull();
        const text = JSON.stringify(raw).toLowerCase();
        for (const forbidden of FORBIDDEN) {
          expect(text, `leak: ${forbidden}`).not.toContain(forbidden.toLowerCase());
        }

        // Contenu attendu (propriétaire, titre, cartes).
        const payload = yield* decodeSharedBinderPayload(raw);
        expect(payload.owner).toEqual({
          displayName: "Alice Collectionneuse",
          avatarInitials: "AC",
        });
        expect(payload.binder).toMatchObject({
          id: ALICE_BINDER,
          kind: "set",
          title: "Classeur Alpha partagé",
          setId: "t32-a",
          setCode: "T32-A",
          setName: "Extension t32-a",
          coverType: "upload",
          hasUploadedCover: true,
          showQuantities: true,
          ownedCount: 2,
          totalCards: 4,
        });
        expect(payload.cards.map((card) => card.cardId)).toEqual([
          "t32-a-001",
          "t32-a-002",
          "t32-a-003",
          "t32-a-004",
        ]);
        expect(payload.cards[0]).toMatchObject({
          owned: true,
          quantity: 4,
          copies: [
            { language: "EN", variant: "holo", quantity: 1 },
            { language: "FR", variant: "normal", quantity: 3 },
          ],
        });
        // Bob possède 9 exemplaires de 002 : jamais mélangés avec ceux d'Alice.
        expect(payload.cards[1]).toMatchObject({ owned: false, quantity: 0, copies: [] });

        // Liste blanche stricte des clés, à tous les niveaux.
        const data = raw as SharedBinderPayload;
        expect(Object.keys(data).sort()).toEqual(["binder", "cards", "owner"]);
        expect(Object.keys(data.owner).sort()).toEqual(["avatarInitials", "displayName"]);
        expect(Object.keys(data.binder).sort()).toEqual([
          "coverCardImageUrl",
          "coverLogoUrl",
          "coverType",
          "hasUploadedCover",
          "id",
          "kind",
          "ownedCount",
          "setCode",
          "setId",
          "setName",
          "showQuantities",
          "title",
          "totalCards",
        ]);
        for (const card of data.cards) {
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
          for (const copy of card.copies) {
            expect(Object.keys(copy).sort()).toEqual(["language", "quantity", "variant"]);
          }
        }

        // Le service (pool applicatif, rôle `authenticated`) relaie exactement la même projection.
        expect(yield* share.getSharedBinder(link.token)).toEqual(payload);
      }),
    ));

  it("showQuantities = false masque les quantités (null) via le service et sous `anon`", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, {
          binderId: ALICE_BINDER,
          showQuantities: false,
        });
        const payload = yield* share.getSharedBinder(link.token);
        expect(payload.binder.showQuantities).toBe(false);
        for (const card of payload.cards) {
          expect(card.quantity).toBeNull();
          for (const copy of card.copies) expect(copy.quantity).toBeNull();
        }
        expect(payload.cards[0]?.owned).toBe(true);
        expect(payload.cards[1]?.owned).toBe(false);
        expect(JSON.stringify(yield* publicPayload(link.token))).not.toMatch(/"quantity":[1-9]/);

        yield* share.updateShowQuantities(ALICE, link.id, true);
        expect((yield* share.getSharedBinder(link.token)).cards[0]?.quantity).toBe(4);
      }),
    ));

  it("révocation IMMÉDIATE : service, SQL direct, idempotence, irréversibilité", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });
        const other = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });
        expect((yield* share.getSharedBinder(link.token)).binder.id).toBe(ALICE_BINDER);

        const revoked = yield* share.revokeLink(ALICE, link.id);
        expect(revoked).toMatchObject({ id: link.id, isActive: false });
        expect(revoked.revokedAt).not.toBeNull();
        expect((yield* failureOf(share.getSharedBinder(link.token)))._tag).toBe(
          "ShareLinkNotFoundError",
        );
        expect(yield* publicPayload(link.token)).toBeNull();
        expect(yield* share.revokeLink(ALICE, link.id)).toEqual(revoked); // idempotent
        // L'autre lien d'Alice n'est pas affecté.
        expect((yield* share.getSharedBinder(other.token)).binder.id).toBe(ALICE_BINDER);
        expect((yield* share.listLinks(ALICE, { activeOnly: true })).map((l) => l.id)).toEqual([
          other.id,
        ]);

        // Révocation en SQL direct (`is_active = false, revoked_at = now()`) : effet immédiat.
        yield* Effect.promise(() =>
          withAdmin(
            (admin) => admin`
              update public.share_links set is_active = false, revoked_at = now()
               where id = ${other.id}`,
          ),
        );
        expect(yield* publicPayload(other.token)).toBeNull();

        // Un lien révoqué ne redevient jamais valide (trigger) ; même pour service_role.
        const reactivation = yield* Effect.promise(() =>
          withAdmin(async (admin) => {
            try {
              await admin`update public.share_links set is_active = true, revoked_at = null
                           where id = ${link.id}`;
              return undefined;
            } catch (cause) {
              return (cause as { readonly code?: string }).code;
            }
          }),
        );
        expect(reactivation).toBe("42501");
        expect(yield* publicPayload(link.token)).toBeNull();
      }),
    ));

  it("jetons mal formés / inconnus : 404 uniforme, sans requête ni fuite du jeton", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        for (const token of [
          "",
          "short",
          "A".repeat(129),
          `${"A".repeat(42)}+`,
          `${"A".repeat(43)}' or '1'='1`,
          generateShareToken(), // valide mais inconnu
        ]) {
          const error = yield* failureOf(share.getSharedBinder(token));
          expect(error._tag).toBe("ShareLinkNotFoundError");
          expect(error.message).toBe("shared binder not found");
          if (token !== "") expect(JSON.stringify(error)).not.toContain(token);
        }
      }),
    ));

  it("`anon` : aucun accès direct aux tables privées ni à la fonction de cover ; service_role : cover du lien actif", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });

        for (const table of [
          "share_links",
          "binders",
          "binder_cards",
          "user_card_copies",
          "profiles",
        ]) {
          const state = yield* sqlStateAs("anon", (tx) =>
            tx.unsafe(`select * from public.${table}`),
          );
          expect(state, `anon select ${table}`).toBe("42501");
        }
        const insert = yield* sqlStateAs(
          "anon",
          (tx) =>
            tx`insert into public.share_links (user_id, binder_id, token)
               values (${ALICE}, ${ALICE_BINDER}, ${generateShareToken()})`,
        );
        expect(insert).toBe("42501");
        const coverAsAnon = yield* sqlStateAs(
          "anon",
          (tx) => tx`select public.get_shared_binder_cover_path(${link.token}::text)`,
        );
        expect(coverAsAnon).toBe("42501");
        const coverAsAuthenticated = yield* sqlStateAs(
          "authenticated",
          (tx) => tx`select public.get_shared_binder_cover_path(${link.token}::text)`,
        );
        expect(coverAsAuthenticated).toBe("42501");

        const cover = (token: string) =>
          Effect.promise(() =>
            withAdmin((admin) =>
              admin.begin(async (tx) => {
                await tx`set local role service_role`;
                const rows = await tx<Array<{ path: string | null }>>`
                  select public.get_shared_binder_cover_path(${token}::text) as path`;
                return rows[0]?.path ?? null;
              }),
            ),
          );
        expect(yield* cover(link.token)).toBe(ALICE_COVER_PATH);
        yield* share.revokeLink(ALICE, link.id);
        expect(yield* cover(link.token)).toBeNull();
      }),
    ));

  it("compatibilité Dashboard : la requête `share_links(binder_id, user_id, is_active, revoked_at)` suit les liens actifs", () =>
    run(({ share, database }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const first = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });
        const second = yield* share.createLink(ALICE, { binderId: ALICE_SECRET_BINDER });
        const dashboard = () =>
          withUserRls(
            database.sql,
            ALICE,
            (tx) =>
              tx<Array<{ binder_id: string }>>`
              select binder_id
                from public.share_links
               where user_id = ${ALICE} and is_active and revoked_at is null`,
          ).pipe(Effect.map((rows) => rows.map((row) => row.binder_id).sort()));

        expect(yield* dashboard()).toEqual([ALICE_BINDER, ALICE_SECRET_BINDER].sort());
        yield* share.revokeLink(ALICE, first.id);
        expect(yield* dashboard()).toEqual([ALICE_SECRET_BINDER]);
        yield* share.revokeLink(ALICE, second.id);
        expect(yield* dashboard()).toEqual([]);
      }),
    ));

  it("supprimer le classeur supprime ses liens (CASCADE) : le jeton ne résout plus rien", () =>
    run(({ share }) =>
      Effect.gen(function* () {
        yield* Effect.promise(seedSensitiveData);
        const link = yield* share.createLink(ALICE, { binderId: ALICE_BINDER });
        yield* Effect.promise(() =>
          withAdmin((admin) => admin`delete from public.binders where id = ${ALICE_BINDER}`),
        );
        expect(yield* linkRows(ALICE)).toEqual([]);
        expect((yield* failureOf(share.getSharedBinder(link.token)))._tag).toBe(
          "ShareLinkNotFoundError",
        );
      }),
    ));
});
