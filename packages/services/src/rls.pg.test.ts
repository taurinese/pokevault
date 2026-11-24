import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALICE, BOB } from "./collection.fixture.ts";
import {
  appConnectionString,
  dropPgFixture,
  PG_HOOK_TIMEOUT_MS,
  PGTEST_URL,
  resetUserData,
  seedPgFixture,
} from "./collection-pg-harness.ts";
import { withUserRls } from "./rls.ts";

/** Tests réels de `withUserRls` : voir `collection-pg-harness.ts` pour lancer le conteneur. */
describe.skipIf(PGTEST_URL === undefined)(
  "withUserRls (Postgres réel, authenticator → authenticated)",
  () => {
    // Petit pool volontairement : si un `sub` fuitait, il se retrouverait sur une connexion réutilisée.
    const sql = postgres(appConnectionString(), {
      max: 2,
      connection: { role: "authenticated" },
      onnotice: () => undefined,
    });

    beforeAll(seedPgFixture, PG_HOOK_TIMEOUT_MS);
    beforeEach(resetUserData);
    afterAll(async () => {
      await sql.end({ timeout: 5 });
      await dropPgFixture();
    });

    const run = <A>(userId: string, fn: Parameters<typeof withUserRls<A>>[2]) =>
      Effect.runPromise(withUserRls(sql, userId, fn));
    const uid = (userId: string) =>
      run(userId, async (tx) => {
        const [row] = await tx<Array<{ uid: string | null }>>`select auth.uid()::text as uid`;
        return row?.uid ?? null;
      });

    it("la connexion tourne bien sous le rôle authenticated (RLS non contournée)", async () => {
      const [row] = await sql<Array<{ current_user: string; bypass: boolean }>>`
      select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
      expect(row).toEqual({ current_user: "authenticated", bypass: false });
    });

    it("auth.uid() retourne l'utilisateur de la transaction, null en dehors", async () => {
      expect(await uid(ALICE)).toBe(ALICE);
      expect(await uid(BOB)).toBe(BOB);
      expect(await uid(ALICE.toUpperCase())).toBe(ALICE);
      const [outside] = await sql<Array<{ uid: string | null }>>`select auth.uid()::text as uid`;
      expect(outside?.uid).toBeNull();
    });

    it("aucun sub ne fuite dans le pool (transactions concurrentes, succès, échec, rollback)", async () => {
      const seen = await Promise.all(
        Array.from({ length: 24 }, (_, index) => uid(index % 2 === 0 ? ALICE : BOB)),
      );
      expect(seen).toEqual(
        Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? ALICE : BOB)),
      );

      await Effect.runPromise(
        Effect.result(
          withUserRls(sql, ALICE, async (tx) => {
            await tx`select 1`;
            throw new Error("rollback me");
          }),
        ),
      );
      await Effect.runPromise(
        Effect.result(
          withUserRls(sql, BOB, async (tx) => tx`select * from public.table_that_does_not_exist`),
        ),
      );

      // Sans transaction, sur les 2 connexions du pool : plus aucun claim.
      const outside = await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            sql<Array<{ claims: string | null; sub: string | null; uid: string | null }>>`
          select current_setting('request.jwt.claims', true) as claims,
                 current_setting('request.jwt.claim.sub', true) as sub,
                 auth.uid()::text as uid`,
        ),
      );
      for (const [row] of outside) {
        expect(row?.uid).toBeNull();
        expect(row?.claims ?? "").toBe("");
        expect(row?.sub ?? "").toBe("");
      }
    });

    it("l'UUID invalide est refusé avant toute transaction", async () => {
      const result = await Effect.runPromise(
        Effect.result(withUserRls(sql, "00000000-not-uuid", async () => 1)),
      );
      expect(result._tag === "Failure" && result.failure._tag).toBe("ValidationError");
    });

    it("la RLS isole strictement Alice et Bob (lecture, écriture, update, delete)", async () => {
      const insertBinder = (userId: string, title: string) =>
        run(userId, async (tx) => {
          const [row] = await tx<Array<{ id: string }>>`
          insert into public.binders (user_id, kind, title) values (${userId}, 'custom', ${title})
          returning id`;
          return row?.id ?? "";
        });
      const aliceBinder = await insertBinder(ALICE, "Classeur d'Alice");
      const bobBinder = await insertBinder(BOB, "Classeur de Bob");

      const titles = (userId: string) =>
        run(userId, async (tx) => {
          const rows = await tx<
            Array<{ title: string }>
          >`select title from public.binders order by title`;
          return rows.map((row) => row.title);
        });
      // SANS aucun filtre user_id : seule la RLS limite le résultat.
      expect(await titles(ALICE)).toEqual(["Classeur d'Alice"]);
      expect(await titles(BOB)).toEqual(["Classeur de Bob"]);

      // Bob ne peut ni modifier ni supprimer le classeur d'Alice.
      const touched = await run(BOB, async (tx) => {
        const updated =
          await tx`update public.binders set title = 'pwned' where id = ${aliceBinder}`;
        const deleted = await tx`delete from public.binders where id = ${aliceBinder}`;
        return [updated.count, deleted.count];
      });
      expect(touched).toEqual([0, 0]);
      expect(await titles(ALICE)).toEqual(["Classeur d'Alice"]);

      // Bob ne peut pas créer un classeur au nom d'Alice (WITH CHECK).
      const forged = await Effect.runPromise(
        Effect.result(
          withUserRls(
            sql,
            BOB,
            async (tx) =>
              tx`insert into public.binders (user_id, kind, title) values (${ALICE}, 'custom', 'forgé')`,
          ),
        ),
      );
      expect(forged._tag).toBe("Failure");

      // binder_cards : Bob ne voit pas, ni n'ajoute dans le dossier d'Alice.
      await run(ALICE, async (tx) => {
        await tx`insert into public.binder_cards (binder_id, card_id) values (${aliceBinder}, 't32-a-001')`;
      });
      const bobSees = await run(
        BOB,
        async (tx) => (await tx`select * from public.binder_cards`).length,
      );
      expect(bobSees).toBe(0);
      const bobInsert = await Effect.runPromise(
        Effect.result(
          withUserRls(
            sql,
            BOB,
            async (tx) =>
              tx`insert into public.binder_cards (binder_id, card_id) values (${aliceBinder}, 't32-a-002')`,
          ),
        ),
      );
      expect(bobInsert._tag).toBe("Failure");
      expect(
        await run(
          BOB,
          async (tx) => (await tx`select * from public.binders where id = ${bobBinder}`).length,
        ),
      ).toBe(1);
    });
  },
);
