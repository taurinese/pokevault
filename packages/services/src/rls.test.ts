import { ValidationError } from "@pokevault/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Sql } from "./db.ts";
import { pgErrorCode, withUserRls } from "./rls.ts";

const USER = "11111111-1111-4111-8111-111111111111";

interface Statement {
  readonly text: string;
  readonly values: ReadonlyArray<unknown>;
}

/** Faux client `postgres` : `begin` exécute le callback avec un `tx` qui enregistre les requêtes. */
const fakeSql = () => {
  const statements: Array<Statement> = [];
  const state = { begins: 0, rolledBack: false };
  const tx = (strings: TemplateStringsArray, ...values: Array<unknown>) => {
    statements.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  };
  const sql = {
    begin: async (callback: (tx: unknown) => Promise<unknown>) => {
      state.begins += 1;
      try {
        return await callback(tx);
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
    },
  } as unknown as Sql;
  return { sql, statements, state };
};

describe("withUserRls", () => {
  it("valide l'UUID avant d'ouvrir la transaction", async () => {
    const { sql, state } = fakeSql();
    const result = await Effect.runPromise(
      Effect.result(withUserRls(sql, "not-a-uuid", async () => 1)),
    );
    expect(result._tag === "Failure" && result.failure).toBeInstanceOf(ValidationError);
    expect(state.begins).toBe(0);
    const injection = await Effect.runPromise(
      Effect.result(withUserRls(sql, `${USER}'; drop table x;--`, async () => 1)),
    );
    expect(injection._tag).toBe("Failure");
    expect(state.begins).toBe(0);
  });

  it("pose les claims JWT en transaction-locale (is_local = true), paramétrés", async () => {
    const { sql, statements } = fakeSql();
    const value = await Effect.runPromise(withUserRls(sql, USER.toUpperCase(), async () => 42));
    expect(value).toBe(42);
    expect(statements).toHaveLength(1);
    const [first] = statements;
    // chaque set_config se termine par `, true)` : jamais de portée session
    expect(first?.text.match(/set_config\([^)]*\)/g)).toHaveLength(3);
    expect(first?.text.match(/, true\)/g)).toHaveLength(3);
    expect(first?.text).not.toMatch(/, false\)/);
    const [claims, sub] = first?.values ?? [];
    expect(JSON.parse(String(claims))).toEqual({ sub: USER, role: "authenticated" });
    expect(sub).toBe(USER);
  });

  it("rollback + DatabaseError sur erreur inconnue, erreur typée via mapError", async () => {
    const { sql, state } = fakeSql();
    const unknown = await Effect.runPromise(
      Effect.result(
        withUserRls(sql, USER, async () => {
          throw new Error("boom");
        }),
      ),
    );
    expect(unknown._tag === "Failure" && unknown.failure).toMatchObject({
      _tag: "DatabaseError",
    });
    expect(state.rolledBack).toBe(true);

    const mapped = await Effect.runPromise(
      Effect.result(
        withUserRls(
          sql,
          USER,
          async () => {
            throw Object.assign(new Error("dup"), { code: "23505" });
          },
          { mapError: (cause) => (pgErrorCode(cause) === "23505" ? "conflict" : undefined) },
        ),
      ),
    );
    expect(mapped._tag === "Failure" && mapped.failure).toBe("conflict");
  });
});

describe("pgErrorCode", () => {
  it("extrait le SQLSTATE d'une erreur postgres", () => {
    expect(pgErrorCode(Object.assign(new Error("x"), { code: "42501" }))).toBe("42501");
    expect(pgErrorCode(new Error("x"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode({ code: 5 })).toBeUndefined();
  });
});
