import { isUuid, ValidationError } from "@pokevault/domain";
import { Effect } from "effect";
import { DatabaseError, type Sql } from "./db.ts";

/** Callback exécuté dans la transaction : `tx` est lié à une seule connexion du pool. */
export type RlsTransactionBody<A> = (tx: Sql) => Promise<A>;

export interface WithUserRlsOptions<E> {
  /**
   * Convertit une erreur levée dans la transaction (ex. une `Data.TaggedError` du
   * domaine, ou une erreur Postgres reconnue par son code) en erreur typée `E`.
   * Retourner `undefined` laisse l'erreur devenir une {@link DatabaseError}.
   */
  readonly mapError?: ((cause: unknown) => E | undefined) | undefined;
}

/**
 * Exécute `fn` dans une transaction Postgres où `auth.uid()` vaut `userId`, comme le fait
 * PostgREST pour un JWT Supabase : les policies RLS (`auth.uid() = user_id`) s'appliquent donc
 * exactement comme en production.
 *
 * - `userId` est validé (UUID) **avant** d'ouvrir la transaction : `ValidationError` sinon.
 * - Les claims sont posés via `set_config('request.jwt.claims', …, true)` (+ le réglage
 *   historique `request.jwt.claim.sub`), strictement *transaction-local* (`is_local = true`) : aucun `sub` ne peut fuiter vers la connexion
 *   suivante du pool, même si la transaction échoue ou fait un rollback.
 * - La connexion doit être ouverte avec le rôle `authenticated` (voir `DatabaseLive`
 *   `role: "authenticated"`) ; les requêtes des services filtrent en plus explicitement par
 *   `user_id` (défense en profondeur si le pool utilisait un rôle qui contourne la RLS).
 * - Une erreur levée dans `fn` provoque un `ROLLBACK`.
 */
export const withUserRls = <A, E = never>(
  sql: Sql,
  userId: string,
  fn: RlsTransactionBody<A>,
  options: WithUserRlsOptions<E> = {},
): Effect.Effect<A, E | DatabaseError | ValidationError> =>
  isUuid(userId)
    ? Effect.tryPromise({
        try: () =>
          sql.begin(async (tx) => {
            const sub = userId.toLowerCase();
            const claims = JSON.stringify({ sub, role: "authenticated" });
            // `auth.uid()` lit `request.jwt.claims->>'sub'` ou, selon la version de l'image
            // `supabase/postgres`, uniquement le réglage historique `request.jwt.claim.sub` :
            // on pose les deux, toujours `is_local = true`.
            await tx`select
              set_config('request.jwt.claims', ${claims}, true),
              set_config('request.jwt.claim.sub', ${sub}, true),
              set_config('request.jwt.claim.role', 'authenticated', true)`;
            return (await fn(tx as unknown as Sql)) as A;
          }) as Promise<A>,
        catch: (cause): E | DatabaseError =>
          options.mapError?.(cause) ??
          new DatabaseError({ message: "postgres transaction failed", cause }),
      })
    : Effect.fail(new ValidationError({ message: "userId must be a valid UUID" }));

/** Code SQLSTATE d'une erreur `postgres` (`undefined` si ce n'en est pas une). */
export const pgErrorCode = (cause: unknown): string | undefined => {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const { code } = cause as { readonly code: unknown };
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
};

/** Nom de la contrainte violée (`postgres` expose `constraint_name`). */
export const pgConstraintName = (cause: unknown): string | undefined => {
  if (typeof cause === "object" && cause !== null && "constraint_name" in cause) {
    const { constraint_name } = cause as { readonly constraint_name: unknown };
    return typeof constraint_name === "string" ? constraint_name : undefined;
  }
  return undefined;
};
