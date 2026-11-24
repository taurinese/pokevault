/**
 * Accès serveur de l'écran `03 · Grille Classeur` : handler `Request → Response`
 * de la route `GET /api/binder-grid/$id`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par la route
 * `routes/api/binder-grid/$id.ts` (handler `server`, retiré du bundle client) —
 * jamais par un composant ou un module client (`binder-grid-client.ts` reste
 * le seul module partagé, et lui est client-safe).
 *
 * Sécurité : session SSR (`getServerSession`, 401 sinon, cookies rafraîchis
 * propagés via `Set-Cookie` + `Cache-Control: no-store`), UUID validé (404),
 * puis transaction `withUserRls` (rôle `authenticated` + `auth.uid() = userId`)
 * avec filtre explicite `user_id` partout : aucune fuite cross-user. Classeur
 * absent ou d'un autre utilisateur → 404. Erreur SQL → 503 sans détail.
 * Sans `DATABASE_URL` : payload vide documenté en 200 (jamais de 500).
 * Réf. : docs/01 §5.1, docs/02, docs/06.
 */

import {
  CARD_VARIANT_ORDER,
  type CardLanguage,
  type CardVariant,
  computePercent,
  computeSetCompletion,
  isUuid,
} from "@pokevault/domain";
import { Database, DatabaseLive, type Sql, withUserRls } from "@pokevault/services";
import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import {
  type BinderGridCard,
  type BinderGridCopy,
  type BinderGridPayload,
  emptyBinderGridPayload,
} from "./binder-grid-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type BinderGridLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface BinderGridServerDeps {
  readonly auth: AuthDeps;
  /**
   * Pool Postgres (rôle `authenticated`), ou `null` quand `DATABASE_URL` est
   * absent (dev/test) : la route répond alors le payload vide documenté.
   */
  readonly sql: Sql | null;
  readonly log: BinderGridLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: BinderGridLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

// ---------------------------------------------------------------------------
// Pool Postgres live, mis en cache sur globalThis (pattern `catalog-server.ts`)
// ---------------------------------------------------------------------------

interface LiveDbEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<Database, never>;
  readonly sql: Promise<Sql>;
}

const GLOBAL_DB_KEY = "__pokevaultBinderGridDb" as const;

const readCachedDb = (): LiveDbEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_DB_KEY] as LiveDbEntry | undefined;

const writeCachedDb = (entry: LiveDbEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_DB_KEY] = entry;
};

/**
 * Pool `postgres.js` paresseux via `DatabaseLive({ role: "authenticated" })`
 * (RLS + grants `SELECT` du catalogue/classeur), mis en cache sur `globalThis`
 * pour survivre au HMR Vite sans fuiter de pools ; une promesse rejetée est
 * immédiatement purgée du cache et le runtime éliminé.
 */
const getLiveSql = (databaseUrl: string): Promise<Sql> => {
  const existing = readCachedDb();
  if (existing !== undefined && existing.url === databaseUrl) {
    return existing.sql;
  }
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedDb(undefined);
  }
  const runtime = ManagedRuntime.make(
    DatabaseLive({ connectionString: databaseUrl, maxConnections: 5, role: "authenticated" }),
  );
  const sql = runtime
    .runPromise(
      Effect.gen(function* () {
        return (yield* Database).sql;
      }),
    )
    .catch((error: unknown) => {
      if (readCachedDb()?.runtime === runtime) writeCachedDb(undefined);
      void runtime.dispose();
      throw error;
    });
  writeCachedDb({ url: databaseUrl, runtime, sql });
  return sql;
};

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`). */
export const defaultBinderGridDeps = async (): Promise<BinderGridServerDeps> => {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth: defaultAuthDeps(),
    sql: databaseUrl === undefined || databaseUrl === "" ? null : await getLiveSql(databaseUrl),
    log: logWarning,
  };
};

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

const json = (
  body: unknown,
  status: number,
  cacheControl: string,
  cookies: ReadonlyArray<string> = [],
): Response => {
  const headers = new Headers({ "Cache-Control": cacheControl });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
};

/** Métadonnées d'erreur sûres à journaliser (jamais de message SQL). */
const extractErrorMeta = (cause: Cause.Cause<unknown>): Readonly<Record<string, unknown>> => {
  const failure = Cause.squash(cause);
  if (typeof failure !== "object" || failure === null) return {};
  const record = failure as Record<string, unknown>;
  const inner =
    typeof record["cause"] === "object" && record["cause"] !== null
      ? (record["cause"] as Record<string, unknown>)
      : null;
  const tag = typeof record["_tag"] === "string" ? record["_tag"] : undefined;
  const code =
    typeof inner?.["code"] === "string"
      ? inner["code"]
      : typeof record["code"] === "string"
        ? record["code"]
        : undefined;
  return {
    ...(tag === undefined ? {} : { errorTag: tag }),
    ...(code === undefined ? {} : { pgCode: code }),
  };
};

// ---------------------------------------------------------------------------
// Chargement RLS (transaction)
// ---------------------------------------------------------------------------

/** Ordre canonique des langues pour l'agrégation (`CardLanguage`). */
const LANGUAGE_ORDER: ReadonlyArray<CardLanguage> = ["FR", "EN", "JP", "ZH"];

interface BinderRow {
  readonly id: string;
  readonly user_id: string;
  readonly kind: "set" | "custom";
  readonly set_id: string | null;
  readonly title: string;
  readonly set_code: string | null;
  readonly set_name_fr: string | null;
  readonly set_official_count: number | null;
  readonly set_total_count: number | null;
}

interface CatalogCardRow {
  readonly id: string;
  readonly set_id: string;
  readonly local_id: string;
  readonly local_id_numeric: number | null;
  readonly name_fr: string;
  readonly rarity: string | null;
  readonly types: ReadonlyArray<string>;
  readonly image_base_url: string | null;
}

interface CopyRow {
  readonly id: string;
  readonly card_id: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly condition: string;
  readonly quantity: number;
  readonly grading_company: string | null;
  readonly grading_score: string | null;
}

/**
 * Charge le classeur, ses cartes et les exemplaires de l'utilisateur dans la
 * transaction RLS courante. `null` si le classeur est absent (ou appartient à
 * un autre utilisateur : invisible par RLS + filtre `user_id`).
 */
const loadBinderGrid = async (
  tx: Sql,
  userId: string,
  binderId: string,
): Promise<BinderGridPayload | null> => {
  const binderRows = await tx<BinderRow[]>`
    select b.id, b.user_id, b.kind, b.set_id, b.title,
           s.code as set_code, s.name_fr as set_name_fr,
           s.official_count as set_official_count, s.total_count as set_total_count
      from public.binders b
      left join public.catalog_sets s on s.id = b.set_id
     where b.id = ${binderId} and b.user_id = ${userId}`;
  const binder = binderRows[0];
  if (binder === undefined) return null;

  const cardRows: ReadonlyArray<CatalogCardRow> =
    binder.kind === "set" && binder.set_id !== null
      ? await tx<CatalogCardRow[]>`
          select c.id, c.set_id, c.local_id, c.local_id_numeric, c.name_fr, c.rarity,
                 c.types, c.image_base_url
            from public.catalog_cards c
           where c.set_id = ${binder.set_id}
           order by c.local_id_numeric asc nulls last, c.local_id asc`
      : await tx<CatalogCardRow[]>`
          select c.id, c.set_id, c.local_id, c.local_id_numeric, c.name_fr, c.rarity,
                 c.types, c.image_base_url
            from public.binder_cards bc
            join public.catalog_cards c on c.id = bc.card_id
           where bc.binder_id = ${binderId}
           order by bc.position asc, bc.added_at asc`;

  const cardIds = cardRows.map((row) => row.id);
  const copyRows: ReadonlyArray<CopyRow> =
    cardIds.length === 0
      ? []
      : await tx<CopyRow[]>`
          select c.id, c.card_id, c.language, c.variant, c.condition, c.quantity,
                 c.grading_company, c.grading_score
            from public.user_card_copies c
           where c.user_id = ${userId} and c.card_id in ${tx(cardIds)}`;

  const copiesByCard = new Map<string, Array<CopyRow>>();
  for (const row of copyRows) {
    const list = copiesByCard.get(row.card_id) ?? [];
    list.push(row);
    copiesByCard.set(row.card_id, list);
  }

  const cards: ReadonlyArray<BinderGridCard> = cardRows.map((row): BinderGridCard => {
    const copies = copiesByCard.get(row.id) ?? [];
    const totalQuantity = copies.reduce((sum, copy) => sum + copy.quantity, 0);
    return {
      id: row.id,
      setId: row.set_id,
      localId: row.local_id,
      localIdNumeric: row.local_id_numeric,
      nameFr: row.name_fr,
      rarity: row.rarity,
      types: row.types,
      imageBaseUrl: row.image_base_url,
      // Wishlist (M3) : tant que la table n'existe pas, aucune carte n'est souhaitée.
      inWishlist: false,
      totalQuantity,
      languages: LANGUAGE_ORDER.filter((language) =>
        copies.some((copy) => copy.language === language),
      ),
      variants: CARD_VARIANT_ORDER.filter((variant) =>
        copies.some((copy) => copy.variant === variant),
      ),
      copies: copies.map(
        (copy): BinderGridCopy => ({
          id: copy.id,
          language: copy.language,
          variant: copy.variant,
          condition: copy.condition,
          quantity: copy.quantity,
          gradingCompany: copy.grading_company,
          gradingScore: copy.grading_score,
        }),
      ),
    };
  });

  const stats =
    binder.kind === "set" && binder.set_id !== null
      ? (() => {
          const localIdNumericByCard = new Map(
            cardRows.map((row) => [row.id, row.local_id_numeric] as const),
          );
          const completion = computeSetCompletion(
            {
              setId: binder.set_id,
              officialCount: binder.set_official_count ?? 0,
              totalCount: binder.set_total_count ?? 0,
            },
            copyRows.map((copy) => ({
              cardId: copy.card_id,
              variant: copy.variant,
              quantity: copy.quantity,
              localIdNumeric: localIdNumericByCard.get(copy.card_id) ?? null,
            })),
          );
          return {
            cardCount: cardRows.length,
            ownedCount: completion.ownedDistinct,
            percent: completion.percent,
            totalCopies: completion.totalCopies,
            duplicateCardCount: completion.duplicateCardCount,
          };
        })()
      : (() => {
          const ownedCount = cards.filter((card) => card.totalQuantity >= 1).length;
          return {
            cardCount: cards.length,
            ownedCount,
            percent: computePercent(ownedCount, cards.length),
            totalCopies: cards.reduce((sum, card) => sum + card.totalQuantity, 0),
            duplicateCardCount: cards.filter((card) => card.totalQuantity >= 2).length,
          };
        })();

  return {
    binder: {
      id: binder.id,
      title: binder.title,
      kind: binder.kind,
      setId: binder.set_id,
      setCode: binder.set_code,
      setNameFr: binder.set_name_fr,
      stats,
    },
    cards,
  };
};

// ---------------------------------------------------------------------------
// GET /api/binder-grid/$id
// ---------------------------------------------------------------------------

/**
 * Handler `GET /api/binder-grid/$id` :
 * - 401 sans session SSR valide (cookies rafraîchis propagés sinon) ;
 * - 404 si `$id` n'est pas un UUID, si le classeur est absent ou appartient à
 *   un autre utilisateur (RLS + `user_id`) ;
 * - 200 + `BinderGridPayload` (`Cache-Control: no-store`, données utilisateur) ;
 * - 503 sans détail SQL en cas d'échec Postgres ;
 * - 200 + payload vide documenté sans `DATABASE_URL`.
 */
export const handleBinderGrid = async (
  request: Request,
  binderId: string,
  deps: BinderGridServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) {
    return json({ error: "unauthorized" }, 401, "no-store");
  }
  const cookies = session.refreshedCookies ?? [];

  if (!isUuid(binderId)) {
    return json({ error: "binder_not_found" }, 404, "no-store", cookies);
  }

  if (deps.sql === null) {
    deps.log("binderGrid.database_url_missing", { operation: "binder-grid", binderId });
    return json(emptyBinderGridPayload, 200, "no-store", cookies);
  }

  const exit = await Effect.runPromiseExit(
    withUserRls(deps.sql, session.user.id, (tx) => loadBinderGrid(tx, session.user.id, binderId)),
  );
  if (Exit.isFailure(exit)) {
    deps.log("binderGrid.query_failed", {
      operation: "binder-grid",
      binderId,
      ...extractErrorMeta(exit.cause),
    });
    return json({ error: "binder_grid_unavailable" }, 503, "no-store", cookies);
  }
  const payload = exit.value;
  if (payload === null) {
    return json({ error: "binder_not_found" }, 404, "no-store", cookies);
  }
  return json(payload, 200, "no-store", cookies);
};
