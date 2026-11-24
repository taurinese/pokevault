import {
  type CardSearchHit,
  type CatalogCard,
  type CatalogSet,
  escapeLikePattern,
  type HoloEffect,
  type ParsedCardNumber,
  parseCardNumberQuery,
  SEARCH_MAX_QUERY_LENGTH,
  type SearchDiscoveryPayload,
  type SearchQuery,
  type SearchQuickAccess,
  type SearchResultsPayload,
  type SearchSuggestionsPayload,
  type SetSearchHit,
  tcgdexCardImageUrl,
  tcgdexSetLogoUrl,
} from "@pokevault/domain";
import { Context, Effect, Layer } from "effect";
import type postgres from "postgres";
import { Database, DatabaseError, type Sql } from "./db.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extensions récentes/populaires de l'écran neutre `05A`. */
export const DISCOVER_SET_LIMIT = 8;
/** Cartes phares de l'écran neutre `05A`. */
export const DISCOVER_CARD_LIMIT = 6;
/** Suggestions live `05B` : top cartes. */
export const SUGGEST_CARD_LIMIT = 5;
/** Suggestions live `05B` : top extensions. */
export const SUGGEST_SET_LIMIT = 3;
/** Extensions affichées en tête des résultats (scope `all`). */
export const SEARCH_SET_PREVIEW_LIMIT = 6;
/** Seuil `pg_trgm` de tolérance aux fautes de frappe (`similarity(name_fr, q) > …`). */
export const SIMILARITY_THRESHOLD = 0.2;
/** `holo_effect` des cartes phares de la découverte. */
export const FEATURED_HOLO_EFFECTS: ReadonlyArray<HoloEffect> = ["sir", "gold", "tera"];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Port de lecture du catalogue pour l'écran Recherche (`05A–05D`). Les trois
 * opérations sont strictement en lecture seule (`SELECT`).
 */
export interface CatalogSearchServiceShape {
  /** `05A` : extensions récentes + cartes phares (SIR / Gold / Téracristal). */
  readonly discover: () => Effect.Effect<SearchDiscoveryPayload, DatabaseError>;
  /** `05B` : top 5 cartes + top 3 extensions pour la saisie en cours. */
  readonly suggest: (rawQuery: string) => Effect.Effect<SearchSuggestionsPayload, DatabaseError>;
  /** `05C` / `05D` : recherche filtrable, triable et paginée. */
  readonly search: (query: SearchQuery) => Effect.Effect<SearchResultsPayload, DatabaseError>;
}

/** Effect-TS service key of the catalogue search service. */
export class CatalogSearchService extends Context.Service<
  CatalogSearchService,
  CatalogSearchServiceShape
>()("@pokevault/services/CatalogSearchService") {}

// ---------------------------------------------------------------------------
// Normalisation de la saisie (commune à Live et Memory)
// ---------------------------------------------------------------------------

interface SearchTerm {
  /** Saisie nettoyée (espaces compactés, longueur plafonnée). */
  readonly text: string;
  /** Motif `ILIKE` préfixe (`texte%`), littéral. */
  readonly prefix: string;
  /** Motif `ILIKE` contient (`%texte%`), littéral. */
  readonly contains: string;
  /** Saisie réduite aux lettres / chiffres : seule entrée des `tsquery` (jamais de NOTICE). */
  readonly tsText: string;
  readonly number: ParsedCardNumber | null;
}

const makeTerm = (raw: string): SearchTerm | null => {
  const text = raw.trim().replace(/\s+/g, " ").slice(0, SEARCH_MAX_QUERY_LENGTH);
  if (text === "") return null;
  const escaped = escapeLikePattern(text);
  return {
    text,
    prefix: `${escaped}%`,
    contains: `%${escaped}%`,
    tsText: text.replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
    number: parseCardNumberQuery(text),
  };
};

type MatchScope = "all" | "cards" | "illustrators";

/** Portée « cartes » d'une requête (`sets` n'interroge pas les cartes). */
const cardScopeOf = (scope: SearchQuery["scope"]): MatchScope | null =>
  scope === "sets" ? null : scope;

/** Les extensions ne remontent que pour `all` / `sets`, sans filtre de carte actif. */
const includesSets = (query: SearchQuery): boolean =>
  (query.scope === "all" || query.scope === "sets") &&
  query.quickAccess === undefined &&
  query.setId === undefined;

// ---------------------------------------------------------------------------
// Postgres implementation — 100 % paramétrée, SELECT uniquement
// ---------------------------------------------------------------------------

interface CardRow {
  readonly id: string;
  readonly set_id: string;
  readonly set_name: string;
  readonly set_code: string | null;
  readonly local_id: string;
  readonly local_id_numeric: number | null;
  readonly name_fr: string;
  readonly rarity: string | null;
  readonly holo_effect: HoloEffect;
  readonly illustrator: string | null;
  readonly image_base_url: string | null;
}

interface SetRow {
  readonly id: string;
  readonly code: string | null;
  readonly name_fr: string;
  readonly logo_url: string | null;
  readonly release_date: string | null;
  readonly official_count: number;
  readonly total_count: number;
}

interface CountRow {
  readonly total: number;
}

const toCardHit = (row: CardRow): CardSearchHit => ({
  id: row.id,
  setId: row.set_id,
  setName: row.set_name,
  setCode: row.set_code,
  localId: row.local_id,
  localIdNumeric: row.local_id_numeric,
  nameFr: row.name_fr,
  rarity: row.rarity,
  holoEffect: row.holo_effect,
  illustrator: row.illustrator,
  imageUrl: tcgdexCardImageUrl(row.image_base_url, "low") ?? null,
});

const toSetHit = (row: SetRow): SetSearchHit => ({
  id: row.id,
  code: row.code,
  nameFr: row.name_fr,
  logoUrl: tcgdexSetLogoUrl(row.logo_url) ?? null,
  releaseDate: row.release_date,
  officialCount: row.official_count,
  totalCount: row.total_count,
});

type Fragment = postgres.Fragment;

const anyOf = (sql: Sql, parts: ReadonlyArray<Fragment>): Fragment => {
  if (parts.length === 0) return sql`FALSE`;
  const combined = parts.reduce(
    (acc, part, index) => (index === 0 ? part : sql`${acc} OR ${part}`),
    sql`FALSE`,
  );
  return sql`(${combined})`;
};

const allOf = (sql: Sql, parts: ReadonlyArray<Fragment>): Fragment => {
  if (parts.length === 0) return sql`TRUE`;
  const combined = parts.reduce(
    (acc, part, index) => (index === 0 ? part : sql`${acc} AND ${part}`),
    sql`TRUE`,
  );
  return sql`(${combined})`;
};

const CARD_FROM = (sql: Sql): Fragment => sql`
  FROM catalog_cards c
  JOIN catalog_sets s ON s.id = c.set_id
`;

const CARD_COLUMNS = (sql: Sql): Fragment => sql`
  c.id,
  c.set_id,
  s.name_fr AS set_name,
  s.code AS set_code,
  c.local_id,
  c.local_id_numeric,
  c.name_fr,
  c.rarity,
  c.holo_effect,
  c.illustrator,
  c.image_base_url
`;

const SET_COLUMNS = (sql: Sql): Fragment => sql`
  s.id,
  s.code,
  s.name_fr,
  s.logo_url,
  to_char(s.release_date, 'YYYY-MM-DD') AS release_date,
  s.official_count,
  s.total_count
`;

/** Condition « la carte correspond au texte » (nom FR/EN, numéro, extension, illustrateur, fautes). */
const cardTextMatch = (sql: Sql, term: SearchTerm, scope: MatchScope): Fragment => {
  const illustrator = sql`c.illustrator ILIKE ${term.contains}`;
  if (scope === "illustrators") return illustrator;

  const parts: Array<Fragment> = [
    sql`c.name_fr ILIKE ${term.contains}`,
    sql`c.name_en ILIKE ${term.contains}`,
    sql`extensions.similarity(c.name_fr, ${term.text}) > ${SIMILARITY_THRESHOLD}`,
  ];
  if (term.tsText !== "") {
    parts.push(
      sql`c.search_vector @@ websearch_to_tsquery('french', ${term.tsText})`,
      sql`c.search_vector @@ plainto_tsquery('simple', ${term.tsText})`,
    );
  }
  if (term.number !== null) {
    parts.push(
      sql`c.local_id_numeric = ${term.number.numeric}`,
      sql`lower(c.local_id) = ${term.number.normalized}`,
    );
  }
  if (scope === "all") {
    parts.push(
      illustrator,
      sql`s.name_fr ILIKE ${term.contains}`,
      sql`lower(s.code) = lower(${term.text})`,
      sql`lower(s.cardmarket_code) = lower(${term.text})`,
    );
  }
  return anyOf(sql, parts);
};

const quickAccessFilter = (sql: Sql, quickAccess: SearchQuickAccess): Fragment => {
  switch (quickAccess) {
    case "sir":
      return sql`c.holo_effect = 'sir'`;
    case "ar":
      return sql`c.rarity ILIKE '%illustration rare%'`;
    case "ex":
      return sql`c.holo_effect = 'ex'`;
    case "tera":
      return sql`c.holo_effect = 'tera'`;
    case "promos":
      return sql`'promo' = ANY(c.available_variants)`;
  }
};

const cardWhere = (sql: Sql, query: SearchQuery, scope: MatchScope): Fragment => {
  const term = makeTerm(query.q);
  const conditions: Array<Fragment> = [];
  if (term !== null) conditions.push(cardTextMatch(sql, term, scope));
  if (query.quickAccess !== undefined) conditions.push(quickAccessFilter(sql, query.quickAccess));
  if (query.setId !== undefined) conditions.push(sql`c.set_id = ${query.setId}`);
  return allOf(sql, conditions);
};

const cardOrderBy = (sql: Sql, query: SearchQuery): Fragment => {
  const tail = sql`s.release_date DESC NULLS LAST, c.local_id_numeric ASC NULLS LAST, c.id ASC`;
  if (query.sort === "number") {
    return sql`c.local_id_numeric ASC NULLS LAST, c.local_id ASC, ${tail}`;
  }
  if (query.sort === "name") return sql`c.name_fr ASC, ${tail}`;
  const term = makeTerm(query.q);
  if (term === null) return tail;
  const rank =
    term.tsText === ""
      ? sql`0::real`
      : sql`ts_rank(c.search_vector, websearch_to_tsquery('french', ${term.tsText}))`;
  return sql`
    CASE
      WHEN lower(c.name_fr) = lower(${term.text}) THEN 3
      WHEN c.name_fr ILIKE ${term.prefix} THEN 2
      WHEN c.name_fr ILIKE ${term.contains} THEN 1
      ELSE 0
    END DESC,
    ${rank} DESC,
    extensions.similarity(c.name_fr, ${term.text}) DESC,
    ${tail}
  `;
};

const setWhere = (sql: Sql, term: SearchTerm | null): Fragment => {
  if (term === null) return sql`TRUE`;
  return anyOf(sql, [
    sql`s.name_fr ILIKE ${term.contains}`,
    sql`s.name_en ILIKE ${term.contains}`,
    sql`lower(s.code) = lower(${term.text})`,
    sql`lower(s.cardmarket_code) = lower(${term.text})`,
    sql`lower(s.id) = lower(${term.text})`,
    sql`extensions.similarity(s.name_fr, ${term.text}) > ${SIMILARITY_THRESHOLD}`,
  ]);
};

const setOrderBy = (sql: Sql, query: SearchQuery, term: SearchTerm | null): Fragment => {
  const tail = sql`s.release_date DESC NULLS LAST, s.id ASC`;
  if (query.sort === "name") return sql`s.name_fr ASC, ${tail}`;
  if (query.sort === "relevance" && term !== null) {
    return sql`
      CASE
        WHEN lower(s.name_fr) = lower(${term.text}) OR lower(s.code) = lower(${term.text}) THEN 3
        WHEN s.name_fr ILIKE ${term.prefix} THEN 2
        WHEN s.name_fr ILIKE ${term.contains} THEN 1
        ELSE 0
      END DESC,
      extensions.similarity(s.name_fr, ${term.text}) DESC,
      ${tail}
    `;
  }
  return tail;
};

/**
 * Implémentation Postgres (`postgres.js`, requêtes préparées : la saisie
 * utilisateur n'est jamais concaténée au SQL, uniquement passée en paramètre
 * — motifs `ILIKE` échappés par `escapeLikePattern`). Cible
 * `supabase/migrations/002_catalog.sql` (index GIN `search_vector` + `pg_trgm`).
 */
export const CatalogSearchServiceLive: Layer.Layer<CatalogSearchService, never, Database> =
  Layer.effect(
    CatalogSearchService,
    Effect.gen(function* () {
      const db = yield* Database;
      const run = <A>(statement: (sql: Sql) => Promise<A>): Effect.Effect<A, DatabaseError> =>
        Effect.tryPromise({
          try: () => statement(db.sql),
          catch: (cause) => new DatabaseError({ message: "postgres query failed", cause }),
        });

      const selectCards = (
        query: SearchQuery,
        scope: MatchScope,
        limit: number,
        offset: number,
      ): Effect.Effect<ReadonlyArray<CardSearchHit>, DatabaseError> =>
        run(
          (sql) => sql<CardRow[]>`
            SELECT ${CARD_COLUMNS(sql)}
            ${CARD_FROM(sql)}
            WHERE ${cardWhere(sql, query, scope)}
            ORDER BY ${cardOrderBy(sql, query)}
            LIMIT ${limit} OFFSET ${offset}
          `,
        ).pipe(Effect.map((rows) => rows.map(toCardHit)));

      const countCards = (
        query: SearchQuery,
        scope: MatchScope,
      ): Effect.Effect<number, DatabaseError> =>
        run(
          (sql) => sql<CountRow[]>`
            SELECT count(*)::int AS total
            ${CARD_FROM(sql)}
            WHERE ${cardWhere(sql, query, scope)}
          `,
        ).pipe(Effect.map((rows) => rows[0]?.total ?? 0));

      const selectSets = (
        query: SearchQuery,
        limit: number,
        offset: number,
      ): Effect.Effect<ReadonlyArray<SetSearchHit>, DatabaseError> => {
        const term = makeTerm(query.q);
        return run(
          (sql) => sql<SetRow[]>`
            SELECT ${SET_COLUMNS(sql)}
            FROM catalog_sets s
            WHERE ${setWhere(sql, term)}
            ORDER BY ${setOrderBy(sql, query, term)}
            LIMIT ${limit} OFFSET ${offset}
          `,
        ).pipe(Effect.map((rows) => rows.map(toSetHit)));
      };

      const countSets = (query: SearchQuery): Effect.Effect<number, DatabaseError> =>
        run(
          (sql) => sql<CountRow[]>`
            SELECT count(*)::int AS total
            FROM catalog_sets s
            WHERE ${setWhere(sql, makeTerm(query.q))}
          `,
        ).pipe(Effect.map((rows) => rows[0]?.total ?? 0));

      const search = (query: SearchQuery) =>
        Effect.gen(function* () {
          const cardScope = cardScopeOf(query.scope);
          const withSets = includesSets(query);
          const setsPaged = query.scope === "sets";
          const [cards, totalCards, sets, totalSets] = yield* Effect.all(
            [
              cardScope === null
                ? Effect.succeed<ReadonlyArray<CardSearchHit>>([])
                : selectCards(query, cardScope, query.limit, query.offset),
              cardScope === null ? Effect.succeed(0) : countCards(query, cardScope),
              withSets
                ? selectSets(
                    query,
                    setsPaged ? query.limit : SEARCH_SET_PREVIEW_LIMIT,
                    setsPaged ? query.offset : 0,
                  )
                : Effect.succeed<ReadonlyArray<SetSearchHit>>([]),
              withSets ? countSets(query) : Effect.succeed(0),
            ],
            { concurrency: 4 },
          );
          return { query, totalCards, totalSets, cards, sets } satisfies SearchResultsPayload;
        });

      return {
        discover: () =>
          Effect.all(
            [
              run(
                (sql) => sql<SetRow[]>`
                  SELECT ${SET_COLUMNS(sql)}
                  FROM catalog_sets s
                  WHERE s.total_count > 0
                  ORDER BY s.release_date DESC NULLS LAST, s.id ASC
                  LIMIT ${DISCOVER_SET_LIMIT}
                `,
              ),
              run(
                (sql) => sql<CardRow[]>`
                  SELECT ${CARD_COLUMNS(sql)}
                  ${CARD_FROM(sql)}
                  WHERE c.holo_effect IN ${sql([...FEATURED_HOLO_EFFECTS])}
                  ORDER BY s.release_date DESC NULLS LAST, c.local_id_numeric DESC NULLS LAST, c.id ASC
                  LIMIT ${DISCOVER_CARD_LIMIT}
                `,
              ),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(
              ([setRows, cardRows]): SearchDiscoveryPayload => ({
                popularSets: setRows.map(toSetHit),
                featuredCards: cardRows.map(toCardHit),
              }),
            ),
          ),
        suggest: (rawQuery) => {
          const term = makeTerm(rawQuery);
          if (term === null) return Effect.succeed({ query: "", cards: [], sets: [] });
          const query: SearchQuery = {
            q: term.text,
            scope: "all",
            sort: "relevance",
            limit: SUGGEST_CARD_LIMIT,
            offset: 0,
          };
          return Effect.all(
            [
              selectCards(query, "all", SUGGEST_CARD_LIMIT, 0),
              selectSets(query, SUGGEST_SET_LIMIT, 0),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(
              ([cards, sets]): SearchSuggestionsPayload => ({ query: term.text, cards, sets }),
            ),
          );
        },
        search,
      } satisfies CatalogSearchServiceShape;
    }),
  );

// ---------------------------------------------------------------------------
// In-memory implementation (unit tests, 100 % offline)
// ---------------------------------------------------------------------------

export interface CatalogSearchFixture {
  readonly sets: ReadonlyArray<CatalogSet>;
  readonly cards: ReadonlyArray<CatalogCard>;
}

/** Trigrammes `pg_trgm` : mots en minuscules, préfixe de 2 espaces et suffixe d'1 espace. */
const trigrams = (text: string): Set<string> => {
  const grams = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      grams.add(padded.slice(index, index + 3));
    }
  }
  return grams;
};

/** `extensions.similarity(a, b)` de `pg_trgm` (indice de Jaccard des trigrammes). */
export const trigramSimilarity = (left: string, right: string): number => {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
};

const lower = (value: string | null): string => (value ?? "").toLowerCase();
const containsFold = (value: string | null, needle: string): boolean =>
  lower(value).includes(needle.toLowerCase());

interface MemoryCard {
  readonly card: CatalogCard;
  readonly set: CatalogSet;
}

/** Approximation du plein texte : chaque mot de la saisie est contenu dans le nom / numéro / illustrateur. */
const fullTextMatch = (entry: MemoryCard, term: SearchTerm): boolean => {
  const haystack = [
    entry.card.name_fr,
    entry.card.name_en,
    entry.card.illustrator,
    entry.card.local_id,
    entry.card.local_id_numeric?.toString() ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const words = term.tsText.toLowerCase().split(" ").filter(Boolean);
  return words.length > 0 && words.every((word) => haystack.includes(word));
};

const memoryCardMatches = (entry: MemoryCard, term: SearchTerm, scope: MatchScope): boolean => {
  const { card, set } = entry;
  if (containsFold(card.illustrator, term.text) && (scope === "all" || scope === "illustrators")) {
    return true;
  }
  if (scope === "illustrators") return false;
  if (containsFold(card.name_fr, term.text) || containsFold(card.name_en, term.text)) return true;
  if (trigramSimilarity(card.name_fr, term.text) > SIMILARITY_THRESHOLD) return true;
  if (fullTextMatch(entry, term)) return true;
  if (
    term.number !== null &&
    (card.local_id_numeric === term.number.numeric ||
      card.local_id.toLowerCase() === term.number.normalized)
  ) {
    return true;
  }
  if (scope === "all") {
    return (
      containsFold(set.name_fr, term.text) ||
      lower(set.code) === term.text.toLowerCase() ||
      lower(set.cardmarket_code) === term.text.toLowerCase()
    );
  }
  return false;
};

const memoryQuickAccess = (card: CatalogCard, quickAccess: SearchQuickAccess): boolean => {
  switch (quickAccess) {
    case "sir":
      return card.holo_effect === "sir";
    case "ar":
      return containsFold(card.rarity, "illustration rare");
    case "ex":
      return card.holo_effect === "ex";
    case "tera":
      return card.holo_effect === "tera";
    case "promos":
      return card.available_variants.includes("promo");
  }
};

/** `release_date DESC NULLS LAST`. */
const byReleaseDesc = (left: string | null, right: string | null): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? 1 : -1;
};

/** `NULLS LAST` ascending comparison. */
const byNumberAsc = (left: number | null, right: number | null): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const nameScore = (name: string, term: SearchTerm): number => {
  const folded = name.toLowerCase();
  const needle = term.text.toLowerCase();
  if (folded === needle) return 3;
  if (folded.startsWith(needle)) return 2;
  if (folded.includes(needle)) return 1;
  return 0;
};

const memoryToCardHit = ({ card, set }: MemoryCard): CardSearchHit => ({
  id: card.id,
  setId: card.set_id,
  setName: set.name_fr,
  setCode: set.code,
  localId: card.local_id,
  localIdNumeric: card.local_id_numeric,
  nameFr: card.name_fr,
  rarity: card.rarity,
  holoEffect: card.holo_effect,
  illustrator: card.illustrator,
  imageUrl: tcgdexCardImageUrl(card.image_base_url, "low") ?? null,
});

const memoryToSetHit = (set: CatalogSet): SetSearchHit => ({
  id: set.id,
  code: set.code,
  nameFr: set.name_fr,
  logoUrl: tcgdexSetLogoUrl(set.logo_url) ?? null,
  releaseDate: set.release_date,
  officialCount: set.official_count,
  totalCount: set.total_count,
});

const memorySetMatches = (set: CatalogSet, term: SearchTerm | null): boolean => {
  if (term === null) return true;
  const needle = term.text.toLowerCase();
  return (
    containsFold(set.name_fr, term.text) ||
    containsFold(set.name_en, term.text) ||
    lower(set.code) === needle ||
    lower(set.cardmarket_code) === needle ||
    set.id.toLowerCase() === needle ||
    trigramSimilarity(set.name_fr, term.text) > SIMILARITY_THRESHOLD
  );
};

/**
 * Layer de test 100 % hors-ligne : mêmes règles de filtrage, tri et pagination
 * que {@link CatalogSearchServiceLive} sur des données en mémoire (le plein
 * texte `tsvector` est approximé par une inclusion mot à mot ; la similarité
 * `pg_trgm` est reproduite à l'identique).
 */
export const CatalogSearchServiceMemory = (
  fixture: CatalogSearchFixture,
): Layer.Layer<CatalogSearchService> => {
  const setsById = new Map(fixture.sets.map((set) => [set.id, set] as const));
  const entries: ReadonlyArray<MemoryCard> = fixture.cards.flatMap((card) => {
    const set = setsById.get(card.set_id);
    return set === undefined ? [] : [{ card, set }];
  });

  const searchCards = (query: SearchQuery, scope: MatchScope): ReadonlyArray<MemoryCard> => {
    const term = makeTerm(query.q);
    const matching = entries.filter(
      (entry) =>
        (term === null || memoryCardMatches(entry, term, scope)) &&
        (query.quickAccess === undefined || memoryQuickAccess(entry.card, query.quickAccess)) &&
        (query.setId === undefined || entry.card.set_id === query.setId),
    );
    const tail = (a: MemoryCard, b: MemoryCard): number =>
      byReleaseDesc(a.set.release_date, b.set.release_date) ||
      byNumberAsc(a.card.local_id_numeric, b.card.local_id_numeric) ||
      compareText(a.card.id, b.card.id);
    return [...matching].sort((a, b) => {
      if (query.sort === "number") {
        return (
          byNumberAsc(a.card.local_id_numeric, b.card.local_id_numeric) ||
          compareText(a.card.local_id, b.card.local_id) ||
          tail(a, b)
        );
      }
      if (query.sort === "name") return compareText(a.card.name_fr, b.card.name_fr) || tail(a, b);
      if (term === null) return tail(a, b);
      return (
        nameScore(b.card.name_fr, term) - nameScore(a.card.name_fr, term) ||
        trigramSimilarity(b.card.name_fr, term.text) -
          trigramSimilarity(a.card.name_fr, term.text) ||
        tail(a, b)
      );
    });
  };

  const searchSets = (query: SearchQuery): ReadonlyArray<CatalogSet> => {
    const term = makeTerm(query.q);
    const tail = (a: CatalogSet, b: CatalogSet): number =>
      byReleaseDesc(a.release_date, b.release_date) || compareText(a.id, b.id);
    return fixture.sets
      .filter((set) => memorySetMatches(set, term))
      .sort((a, b) => {
        if (query.sort === "name") return compareText(a.name_fr, b.name_fr) || tail(a, b);
        if (query.sort === "relevance" && term !== null) {
          return (
            nameScore(b.name_fr, term) - nameScore(a.name_fr, term) ||
            trigramSimilarity(b.name_fr, term.text) - trigramSimilarity(a.name_fr, term.text) ||
            tail(a, b)
          );
        }
        return tail(a, b);
      });
  };

  const impl: CatalogSearchServiceShape = {
    discover: () =>
      Effect.sync(() => {
        const popularSets = [...fixture.sets]
          .filter((set) => set.total_count > 0)
          .sort((a, b) => byReleaseDesc(a.release_date, b.release_date) || compareText(a.id, b.id))
          .slice(0, DISCOVER_SET_LIMIT)
          .map(memoryToSetHit);
        const featuredCards = entries
          .filter((entry) => FEATURED_HOLO_EFFECTS.includes(entry.card.holo_effect))
          .sort(
            (a, b) =>
              byReleaseDesc(a.set.release_date, b.set.release_date) ||
              byNumberAsc(b.card.local_id_numeric, a.card.local_id_numeric) ||
              compareText(a.card.id, b.card.id),
          )
          .slice(0, DISCOVER_CARD_LIMIT)
          .map(memoryToCardHit);
        return { popularSets, featuredCards };
      }),
    suggest: (rawQuery) =>
      Effect.sync(() => {
        const term = makeTerm(rawQuery);
        if (term === null) return { query: "", cards: [], sets: [] };
        const query: SearchQuery = {
          q: term.text,
          scope: "all",
          sort: "relevance",
          limit: SUGGEST_CARD_LIMIT,
          offset: 0,
        };
        return {
          query: term.text,
          cards: searchCards(query, "all").slice(0, SUGGEST_CARD_LIMIT).map(memoryToCardHit),
          sets: searchSets(query).slice(0, SUGGEST_SET_LIMIT).map(memoryToSetHit),
        };
      }),
    search: (query) =>
      Effect.sync(() => {
        const cardScope = cardScopeOf(query.scope);
        const matchedCards = cardScope === null ? [] : searchCards(query, cardScope);
        const matchedSets = includesSets(query) ? searchSets(query) : [];
        const setsPaged = query.scope === "sets";
        const setPage = setsPaged
          ? matchedSets.slice(query.offset, query.offset + query.limit)
          : matchedSets.slice(0, SEARCH_SET_PREVIEW_LIMIT);
        return {
          query,
          totalCards: matchedCards.length,
          totalSets: matchedSets.length,
          cards: matchedCards.slice(query.offset, query.offset + query.limit).map(memoryToCardHit),
          sets: setPage.map(memoryToSetHit),
        };
      }),
  };
  return Layer.succeed(CatalogSearchService, impl);
};
