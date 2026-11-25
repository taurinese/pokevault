import {
  type CardLanguage,
  CardmarketBlockedError,
  CardmarketNetworkError,
  CardmarketParseError,
  type CardmarketScrapeError,
  type CardVariant,
  computePriceFreshness,
  MAX_PRICE_CENTS,
  PRICE_MANUAL_COOLDOWN_MS,
  PRICE_REFRESH_PRIORITY_RANK,
  PRICE_TTL_MS,
  type PriceBatchReport,
  PriceCircuitOpenError,
  type PriceFreshness,
  PriceRefreshCooldownError,
  type PriceRefreshTarget,
  type PriceSnapshot,
  type PriceSource,
  type TcgdexFallbackPrices,
} from "@pokevault/domain";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Random,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { parseCardmarketProductPage } from "./cardmarket-parser.ts";
import { Database, DatabaseError, DatabaseLive, type Sql } from "./db.ts";
import {
  DEFAULT_TCGDEX_BASE_URL,
  TcgdexDecodeError,
  type TcgdexError,
  TcgdexHttpError,
} from "./tcgdex.ts";

// ---------------------------------------------------------------------------
// Guard-rail constants (docs/04-integrations.md §2.1, docs/08 R1)
// ---------------------------------------------------------------------------

/** Jitter between two Cardmarket requests, in milliseconds (prod: 1.5–4 s). */
export const MIN_JITTER_MS = 1_500;
export const MAX_JITTER_MS = 4_000;

/** Circuit breaker exponential backoff: 15 min → 30 min → 60 min (capped at 1 h). */
export const CIRCUIT_BASE_PAUSE_MS = 15 * 60 * 1000;
export const CIRCUIT_MAX_PAUSE_MS = 60 * 60 * 1000;

/** Default number of targets per scheduled refresh batch. */
export const DEFAULT_PRICE_BATCH_LIMIT = 30;

/** Default per-request HTTP timeout for Cardmarket pages. */
export const DEFAULT_CARDMARKET_TIMEOUT_MS = 15_000;

/** Maximum number of manual redirect hops allowed on Cardmarket. */
export const MAX_CARDMARKET_REDIRECTS = 3;

/** Maximum HTML response size accepted from Cardmarket (2 MiB). */
export const MAX_CARDMARKET_HTML_BYTES = 2 * 1024 * 1024;

/** Polite user agent: the worker scrapes at most 1–2 requests per minute. */
export const DEFAULT_CARDMARKET_USER_AGENT =
  "PokéVault price-cache worker (personal use, rate-limited scraping)";

/**
 * SSRF guard: only `https://www.cardmarket.com/...` or `https://cardmarket.com/...`
 * on the default HTTPS port with no embedded credentials may be fetched.
 */
export const isAllowedCardmarketUrl = (url: string | null): url is string => {
  if (url === null) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "www.cardmarket.com" || host === "cardmarket.com";
};

/** Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export const parseRetryAfterMs = (value: string | null, nowMs: number): number | undefined => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
};

/**
 * Circuit breaker pause for the n-th consecutive block: exponential backoff
 * `base * 2^(n-1)` capped at `max`, raised to `Retry-After` when larger (still
 * capped at `max`).
 */
export const computeCircuitPauseMs = (
  consecutiveBlocks: number,
  retryAfterMs: number | undefined,
  baseMs: number,
  maxMs: number,
): number => {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, consecutiveBlocks - 1), maxMs);
  const fromHeader = retryAfterMs === undefined ? 0 : Math.min(Math.max(0, retryAfterMs), maxMs);
  return Math.max(exponential, fromHeader);
};

// ---------------------------------------------------------------------------
// PriceSnapshotStore port (Live Postgres + Memory)
// ---------------------------------------------------------------------------

/** Snapshot to persist; `fetchedAt` / `expiresAt` are ALWAYS set explicitly. */
export interface NewPriceSnapshot {
  readonly cardId: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly source: PriceSource;
  readonly trendCents: number | null;
  readonly lowFrCents: number | null;
  readonly avg30Cents: number | null;
  /** ISO 8601 collection timestamp. */
  readonly fetchedAt: string;
  /** ISO 8601 TTL limit (`fetchedAt + 15 min`). */
  readonly expiresAt: string;
}

export interface PriceSnapshotStoreShape {
  readonly getLatest: (
    cardId: string,
    language: CardLanguage,
    variant: CardVariant,
  ) => Effect.Effect<PriceSnapshot | null, DatabaseError>;
  /** Most recent `fetched_at` for a card across every language/variant (cooldown). */
  readonly getLastFetchedAtMs: (cardId: string) => Effect.Effect<number | null, DatabaseError>;
  readonly insertSnapshot: (
    snapshot: NewPriceSnapshot,
  ) => Effect.Effect<PriceSnapshot, DatabaseError>;
  /** Cron targets: active alerts → wishlists → featured owned cards, deduped, bounded. */
  readonly selectPriorityTargets: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PriceRefreshTarget>, DatabaseError>;
  /**
   * Deletes expired snapshots but ALWAYS keeps the most recent snapshot per
   * `(card_id, language, variant)` (degraded mode of the circuit breaker).
   */
  readonly pruneExpiredSnapshots: () => Effect.Effect<number, DatabaseError>;
}

/** Effect-TS service key of the price snapshot persistence port. */
export class PriceSnapshotStore extends Context.Service<
  PriceSnapshotStore,
  PriceSnapshotStoreShape
>()("@pokevault/services/PriceSnapshotStore") {}

interface PriceSnapshotRow {
  id: number | string | bigint;
  card_id: string;
  language: string;
  variant: string;
  source: string;
  trend_cents: number | null;
  low_fr_cents: number | null;
  avg30_cents: number | null;
  fetched_at: Date | string;
  expires_at: Date | string;
  is_fresh: boolean;
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const rowToSnapshot = (row: PriceSnapshotRow): PriceSnapshot => ({
  id: Number(row.id),
  cardId: row.card_id,
  language: row.language as CardLanguage,
  variant: row.variant as CardVariant,
  source: row.source as PriceSource,
  trendCents: row.trend_cents,
  lowFrCents: row.low_fr_cents,
  avg30Cents: row.avg30_cents,
  fetchedAt: toIso(row.fetched_at),
  expiresAt: toIso(row.expires_at),
  isFresh: row.is_fresh,
});

/**
 * Live Postgres store over the `Database` pool (worker, `service_role`).
 *
 * Review rules of PR #61 are enforced here:
 * - every `INSERT` sets `fetched_at` AND `expires_at` explicitly (never relies on
 *   the column DEFAULT of `expires_at`);
 * - `pruneExpiredSnapshots` keeps the latest snapshot per `(card_id, language, variant)`;
 * - `selectPriorityTargets` guards `price_alerts` / `wishlist_items` with
 *   `to_regclass(...) IS NOT NULL` (evaluated first, because a static reference to
 *   a not-yet-deployed table would fail at parse time) so the cron works whether
 *   or not M4 / #25 are deployed.
 */
export const PriceSnapshotStoreLive: Layer.Layer<PriceSnapshotStore, never, Database> =
  Layer.effect(
    PriceSnapshotStore,
    Effect.gen(function* () {
      const db = yield* Database;
      const query = <A>(statement: (sql: Sql) => Promise<A>): Effect.Effect<A, DatabaseError> =>
        Effect.tryPromise({
          try: () => statement(db.sql),
          catch: (cause) => new DatabaseError({ message: "postgres query failed", cause }),
        });

      const getLatest: PriceSnapshotStoreShape["getLatest"] = (cardId, language, variant) =>
        query(async (sql) => {
          const rows = await sql<PriceSnapshotRow[]>`
          SELECT id, card_id, language, variant, source, trend_cents, low_fr_cents, avg30_cents,
                 fetched_at, expires_at, is_fresh
          FROM card_latest_prices
          WHERE card_id = ${cardId} AND language = ${language} AND variant = ${variant}
          LIMIT 1
        `;
          return rows[0] ?? null;
        }).pipe(Effect.map((row) => (row === null ? null : rowToSnapshot(row))));

      const getLastFetchedAtMs: PriceSnapshotStoreShape["getLastFetchedAtMs"] = (cardId) =>
        query(async (sql) => {
          const rows = await sql<Array<{ last_fetched_at: Date | string | null }>>`
          SELECT max(fetched_at) AS last_fetched_at
          FROM price_snapshots
          WHERE card_id = ${cardId}
        `;
          const value = rows[0]?.last_fetched_at ?? null;
          if (value === null) return null;
          return value instanceof Date ? value.getTime() : new Date(value).getTime();
        });

      const insertSnapshot: PriceSnapshotStoreShape["insertSnapshot"] = (snapshot) =>
        query(async (sql) => {
          const rows = await sql<PriceSnapshotRow[]>`
          INSERT INTO price_snapshots
            (card_id, language, variant, source, trend_cents, low_fr_cents, avg30_cents, fetched_at, expires_at)
          VALUES
            (${snapshot.cardId}, ${snapshot.language}, ${snapshot.variant}, ${snapshot.source},
             ${snapshot.trendCents}, ${snapshot.lowFrCents}, ${snapshot.avg30Cents},
             ${snapshot.fetchedAt}, ${snapshot.expiresAt})
          RETURNING id, card_id, language, variant, source, trend_cents, low_fr_cents, avg30_cents,
                    fetched_at, expires_at, (expires_at > now()) AS is_fresh
        `;
          const row = rows[0];
          if (row === undefined) {
            throw new Error("INSERT INTO price_snapshots returned no row");
          }
          return row;
        }).pipe(Effect.map(rowToSnapshot));

      const selectPriorityTargets: PriceSnapshotStoreShape["selectPriorityTargets"] = (limit) =>
        Effect.gen(function* () {
          // Guards first: referencing a missing table in static SQL fails at parse
          // time, so the optional CTEs below are only interpolated when the table
          // exists (to_regclass(...) IS NOT NULL).
          const guards = yield* query(async (sql) => {
            const rows = await sql<Array<{ has_alerts: boolean; has_wishlist: boolean }>>`
            SELECT to_regclass('public.price_alerts') IS NOT NULL AS has_alerts,
                   to_regclass('public.wishlist_items') IS NOT NULL AS has_wishlist
          `;
            return rows[0] ?? { has_alerts: false, has_wishlist: false };
          });

          const emptyFragment = db.sql`
          SELECT NULL::text AS card_id, NULL::text AS language, NULL::text AS variant,
                 0 AS rank
          WHERE FALSE
        `;
          // Priority 1: cards with at least one active price alert.
          const alertsFragment = guards.has_alerts
            ? db.sql`
              SELECT c.id AS card_id, pa.language AS language, pa.variant AS variant,
                     1 AS rank
              FROM catalog_cards AS c
              JOIN price_alerts AS pa ON pa.card_id = c.id
              WHERE pa.is_active = TRUE
            `
            : emptyFragment;
          // Priority 2: wishlist items.
          const wishlistFragment = guards.has_wishlist
            ? db.sql`
              SELECT c.id AS card_id, wi.language AS language, wi.variant AS variant,
                     2 AS rank
              FROM catalog_cards AS c
              JOIN wishlist_items AS wi ON wi.card_id = c.id
            `
            : emptyFragment;
          // Priority 3: owned cards.
          const featuredFragment = db.sql`
          SELECT ucc.card_id AS card_id, ucc.language AS language, ucc.variant AS variant,
                 3 AS rank
          FROM user_card_copies AS ucc
          JOIN catalog_cards AS c ON c.id = ucc.card_id
        `;

          const rows = yield* query(async (sql) => {
            const results = await sql<
              Array<{
                card_id: string;
                language: string;
                variant: string;
                cardmarket_url: string | null;
                rank: number;
              }>
            >`
            WITH candidates AS (
              ${alertsFragment}
              UNION ALL
              ${wishlistFragment}
              UNION ALL
              ${featuredFragment}
            ),
            dedup AS (
              SELECT DISTINCT ON (card_id, language, variant)
                     card_id, language, variant, rank
              FROM candidates
              ORDER BY card_id, language, variant, rank
            )
            SELECT d.card_id, d.language, d.variant, c.cardmarket_url, d.rank
            FROM dedup AS d
            JOIN catalog_cards AS c ON c.id = d.card_id
            LEFT JOIN LATERAL (
              SELECT lp.id, lp.fetched_at, lp.expires_at, lp.trend_cents, lp.avg30_cents, lp.low_fr_cents
              FROM card_latest_prices AS lp
              WHERE lp.card_id = d.card_id
                AND lp.language = d.language
                AND lp.variant = d.variant
              LIMIT 1
            ) AS lp ON TRUE
            WHERE lp.id IS NULL OR lp.expires_at <= now()
            ORDER BY d.rank ASC,
                     lp.fetched_at ASC NULLS FIRST,
                     coalesce(lp.trend_cents, lp.avg30_cents, lp.low_fr_cents, 0)::bigint DESC,
                     d.card_id ASC,
                     d.language ASC,
                     d.variant ASC
            LIMIT ${limit}
          `;
            return results;
          });

          return rows.map(
            (row): PriceRefreshTarget => ({
              cardId: row.card_id,
              language: row.language as CardLanguage,
              variant: row.variant as CardVariant,
              cardmarketUrl: row.cardmarket_url,
              priority: row.rank === 1 ? "active_alert" : row.rank === 2 ? "wishlist" : "featured",
            }),
          );
        });

      const pruneExpiredSnapshots: PriceSnapshotStoreShape["pruneExpiredSnapshots"] = () =>
        query(async (sql) => {
          const rows = await sql<Array<{ id: number }>>`
          DELETE FROM price_snapshots AS ps
          WHERE ps.expires_at <= now()
            AND EXISTS (
              SELECT 1 FROM price_snapshots AS newer
              WHERE newer.card_id = ps.card_id
                AND newer.language = ps.language
                AND newer.variant = ps.variant
                AND (newer.fetched_at, newer.id) > (ps.fetched_at, ps.id)
            )
          RETURNING ps.id
        `;
          return rows.length;
        });

      return {
        getLatest,
        getLastFetchedAtMs,
        insertSnapshot,
        selectPriorityTargets,
        pruneExpiredSnapshots,
      } satisfies PriceSnapshotStoreShape;
    }),
  );

// ---------------------------------------------------------------------------
// PriceSnapshotStore — in-memory implementation (unit tests, 100 % offline)
// ---------------------------------------------------------------------------

export interface PriceSnapshotStoreMemory {
  readonly layer: Layer.Layer<PriceSnapshotStore>;
  /** Full history per `cardId|language|variant` key (insertion order). */
  readonly history: Map<string, Array<PriceSnapshot>>;
  /** Targets returned by `selectPriorityTargets` (priority-sorted then limited). */
  readonly targets: Array<PriceRefreshTarget>;
  /** Seeds the history directly (tests). */
  readonly seed: (snapshot: PriceSnapshot) => void;
}

const storeKey = (cardId: string, language: string, variant: string): string =>
  `${cardId}|${language}|${variant}`;

/** In-memory {@link PriceSnapshotStore} with a controllable target list. */
export const makePriceSnapshotStoreMemory = (): PriceSnapshotStoreMemory => {
  const history = new Map<string, Array<PriceSnapshot>>();
  const targets: Array<PriceRefreshTarget> = [];
  let nextId = 1;

  const latestOf = (list: ReadonlyArray<PriceSnapshot>): PriceSnapshot | null => {
    if (list.length === 0) return null;
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt) || a.id - b.id,
    );
    return sorted.at(-1) ?? null;
  };

  const impl: PriceSnapshotStoreShape = {
    getLatest: (cardId, language, variant) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const latest = latestOf(history.get(storeKey(cardId, language, variant)) ?? []);
        if (latest === null) return null;
        return { ...latest, isFresh: Date.parse(latest.expiresAt) > now };
      }),
    getLastFetchedAtMs: (cardId) =>
      Effect.sync(() => {
        let max: number | null = null;
        for (const [key, list] of history) {
          if (!key.startsWith(`${cardId}|`)) continue;
          for (const snapshot of list) {
            const ms = Date.parse(snapshot.fetchedAt);
            if (max === null || ms > max) max = ms;
          }
        }
        return max;
      }),
    insertSnapshot: (snapshot) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const stored: PriceSnapshot = {
          id: nextId++,
          cardId: snapshot.cardId,
          language: snapshot.language,
          variant: snapshot.variant,
          source: snapshot.source,
          trendCents: snapshot.trendCents,
          lowFrCents: snapshot.lowFrCents,
          avg30Cents: snapshot.avg30Cents,
          fetchedAt: snapshot.fetchedAt,
          expiresAt: snapshot.expiresAt,
          isFresh: Date.parse(snapshot.expiresAt) > now,
        };
        const key = storeKey(snapshot.cardId, snapshot.language, snapshot.variant);
        const list = history.get(key) ?? [];
        list.push(stored);
        history.set(key, list);
        return stored;
      }),
    selectPriorityTargets: (limit) =>
      Effect.sync(() =>
        [...targets]
          .sort(
            (a, b) =>
              PRICE_REFRESH_PRIORITY_RANK[a.priority] - PRICE_REFRESH_PRIORITY_RANK[b.priority],
          )
          .slice(0, limit),
      ),
    pruneExpiredSnapshots: () =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        let removed = 0;
        for (const [key, list] of history) {
          const sorted = [...list].sort(
            (a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt) || a.id - b.id,
          );
          const kept = sorted.filter((snapshot, index) => {
            const expired = Date.parse(snapshot.expiresAt) <= now;
            const isLatest = index === sorted.length - 1;
            if (expired && !isLatest) {
              removed += 1;
              return false;
            }
            return true;
          });
          history.set(key, kept);
        }
        return removed;
      }),
  };

  return {
    layer: Layer.succeed(PriceSnapshotStore, impl),
    history,
    targets,
    seed: (snapshot) => {
      const key = storeKey(snapshot.cardId, snapshot.language, snapshot.variant);
      const list = history.get(key) ?? [];
      list.push(snapshot);
      history.set(key, list);
    },
  };
};

// ---------------------------------------------------------------------------
// CardmarketFetcher port (Live fetch + fake)
// ---------------------------------------------------------------------------

export interface CardmarketFetcherShape {
  readonly fetchProductPage: (
    url: string,
  ) => Effect.Effect<string, CardmarketBlockedError | CardmarketNetworkError>;
}

/** Effect-TS service key of the Cardmarket HTML fetcher. */
export class CardmarketFetcher extends Context.Service<CardmarketFetcher, CardmarketFetcherShape>()(
  "@pokevault/services/CardmarketFetcher",
) {}

export interface CardmarketFetcherLiveOptions {
  readonly timeoutMs?: number | undefined;
  readonly userAgent?: string | undefined;
  readonly maxHtmlBytes?: number | undefined;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Reads a response body as UTF-8 while enforcing a strict byte ceiling. */
const readBoundedText = async (
  response: Response,
  maxBytes: number,
  url: string,
): Promise<string> => {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new CardmarketNetworkError({
        url,
        message: `Cardmarket response exceeded ${maxBytes} bytes (Content-Length: ${declaredLength})`,
      });
    }
  }
  if (response.body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new CardmarketNetworkError({
        url,
        message: `Cardmarket response exceeded ${maxBytes} bytes`,
      });
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let totalBytes = 0;
  let result = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new CardmarketNetworkError({
          url,
          message: `Cardmarket response exceeded ${maxBytes} bytes`,
        });
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
};

/**
 * Live fetcher over the global `fetch`. Every request is abortable (Effect
 * interruption signal + `AbortSignal.timeout`), redirects are handled manually
 * with SSRF validation on every `Location` hop (max 3 hops), Cloudflare
 * `cf-mitigated: challenge` headers and HTTP 403/429 map to
 * `CardmarketBlockedError`, and HTML body size is strictly capped at 2 MiB.
 */
export const CardmarketFetcherLive = (
  options?: CardmarketFetcherLiveOptions,
): Layer.Layer<CardmarketFetcher> => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CARDMARKET_TIMEOUT_MS;
  const userAgent = options?.userAgent ?? DEFAULT_CARDMARKET_USER_AGENT;
  const maxHtmlBytes = options?.maxHtmlBytes ?? MAX_CARDMARKET_HTML_BYTES;
  return Layer.succeed(CardmarketFetcher, {
    fetchProductPage: (initialUrl) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (!isAllowedCardmarketUrl(initialUrl)) {
            throw new CardmarketNetworkError({
              url: initialUrl,
              message: `Cardmarket URL rejected by SSRF guard: ${initialUrl}`,
            });
          }
          const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
          let currentUrl = initialUrl;

          for (let hops = 0; hops <= MAX_CARDMARKET_REDIRECTS; hops++) {
            const response = await fetch(currentUrl, {
              signal: combinedSignal,
              headers: {
                "user-agent": userAgent,
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
              },
              redirect: "manual",
            });

            if (REDIRECT_STATUSES.has(response.status)) {
              const location = response.headers.get("location");
              await response.body?.cancel();
              if (location === null || location.trim().length === 0) {
                throw new CardmarketNetworkError({
                  url: currentUrl,
                  message: `Cardmarket redirect HTTP ${response.status} without Location header`,
                });
              }
              if (hops === MAX_CARDMARKET_REDIRECTS) {
                throw new CardmarketNetworkError({
                  url: currentUrl,
                  message: `Cardmarket exceeded maximum redirects (${MAX_CARDMARKET_REDIRECTS})`,
                });
              }
              let nextUrl: string;
              try {
                nextUrl = new URL(location, currentUrl).toString();
              } catch {
                throw new CardmarketNetworkError({
                  url: currentUrl,
                  message: `Cardmarket redirect Location is invalid: ${location}`,
                });
              }
              if (!isAllowedCardmarketUrl(nextUrl)) {
                throw new CardmarketNetworkError({
                  url: currentUrl,
                  message: `Cardmarket redirect target rejected by SSRF guard: ${nextUrl}`,
                });
              }
              currentUrl = nextUrl;
              continue;
            }

            const nowMs = Date.now();
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), nowMs);
            const cfMitigated = response.headers.get("cf-mitigated")?.toLowerCase() ?? "";
            if (cfMitigated === "challenge") {
              await response.body?.cancel();
              throw new CardmarketBlockedError({
                status: "challenge",
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                message: `Cardmarket Cloudflare challenge (HTTP ${response.status}) for ${currentUrl}`,
              });
            }

            if (!response.ok) {
              // Release the socket instead of downloading an error page.
              await response.body?.cancel();
              if (response.status === 403 || response.status === 429) {
                throw new CardmarketBlockedError({
                  status: response.status,
                  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                  message: `Cardmarket returned HTTP ${response.status} for ${currentUrl}`,
                });
              }
              throw new CardmarketNetworkError({
                url: currentUrl,
                message: `Cardmarket returned HTTP ${response.status} for ${currentUrl}`,
              });
            }

            return await readBoundedText(response, maxHtmlBytes, currentUrl);
          }

          throw new CardmarketNetworkError({
            url: currentUrl,
            message: `Cardmarket exceeded maximum redirects (${MAX_CARDMARKET_REDIRECTS})`,
          });
        },
        catch: (cause): CardmarketBlockedError | CardmarketNetworkError =>
          cause instanceof CardmarketBlockedError || cause instanceof CardmarketNetworkError
            ? cause
            : new CardmarketNetworkError({
                url: initialUrl,
                message: `Cardmarket request failed for ${initialUrl}`,
                cause,
              }),
      }),
  });
};

/** Fake fetcher for tests: the handler decides the HTML (or the typed error) per URL. */
export const CardmarketFetcherFake = (
  handler: (url: string) => Effect.Effect<string, CardmarketBlockedError | CardmarketNetworkError>,
): Layer.Layer<CardmarketFetcher> =>
  Layer.succeed(CardmarketFetcher, { fetchProductPage: handler });

// ---------------------------------------------------------------------------
// TcgdexPriceFallback port (Live TCGdex pricing + fake)
// ---------------------------------------------------------------------------

export interface TcgdexPriceFallbackShape {
  readonly getFallbackPrices: (
    cardId: string,
    language: CardLanguage,
    variant: CardVariant,
  ) => Effect.Effect<TcgdexFallbackPrices | null, TcgdexError>;
}

/** Effect-TS service key of the TCGdex aggregated-price fallback. */
export class TcgdexPriceFallback extends Context.Service<
  TcgdexPriceFallback,
  TcgdexPriceFallbackShape
>()("@pokevault/services/TcgdexPriceFallback") {}

const NullablePriceNumber = Schema.NullOr(Schema.Number);

/**
 * Real TCGdex v2 `pricing.cardmarket` flat object (euros, float or null).
 * TCGdex does not distinguish card languages in its Cardmarket aggregate; all
 * snapshots persisted from this fallback are tagged `tcgdex_fallback` (stale).
 */
const TcgdexCardmarketPricing = Schema.Struct({
  unit: Schema.optional(Schema.NullOr(Schema.String)),
  avg: Schema.optional(NullablePriceNumber),
  low: Schema.optional(NullablePriceNumber),
  trend: Schema.optional(NullablePriceNumber),
  avg1: Schema.optional(NullablePriceNumber),
  avg7: Schema.optional(NullablePriceNumber),
  avg30: Schema.optional(NullablePriceNumber),
  "avg-holo": Schema.optional(NullablePriceNumber),
  "low-holo": Schema.optional(NullablePriceNumber),
  "trend-holo": Schema.optional(NullablePriceNumber),
  "avg1-holo": Schema.optional(NullablePriceNumber),
  "avg7-holo": Schema.optional(NullablePriceNumber),
  "avg30-holo": Schema.optional(NullablePriceNumber),
});

const TcgdexCardPricingPayload = Schema.Struct({
  pricing: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cardmarket: Schema.optional(Schema.NullOr(TcgdexCardmarketPricing)),
      }),
    ),
  ),
});

const eurosToCents = (value: number | null | undefined): number | null => {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents <= MAX_PRICE_CENTS ? cents : null;
};

/**
 * Extracts fallback prices from a TCGdex v2 card payload (`pricing.cardmarket`).
 *
 * TCGdex exposes language-agnostic flat Cardmarket aggregates (`trend`, `avg`,
 * `avg30`, `low`) and their foil counterparts (`*-holo`). For foil variants
 * (`variant !== "normal"`), the `*-holo` fields are preferred with fallback to
 * the base fields. Non-EUR currencies are ignored.
 */
export const pickTcgdexFallbackPrices = (
  payload: typeof TcgdexCardPricingPayload.Type,
  _language: CardLanguage,
  variant: CardVariant,
): TcgdexFallbackPrices | null => {
  const cm = payload.pricing?.cardmarket;
  if (cm === undefined || cm === null) return null;
  if (typeof cm.unit === "string" && cm.unit.trim().length > 0 && cm.unit.toUpperCase() !== "EUR") {
    return null;
  }
  const preferHolo = variant !== "normal";
  const trendCents = preferHolo
    ? (eurosToCents(cm["trend-holo"]) ??
      eurosToCents(cm["avg-holo"]) ??
      eurosToCents(cm.trend) ??
      eurosToCents(cm.avg))
    : (eurosToCents(cm.trend) ?? eurosToCents(cm.avg));
  const avg30Cents = preferHolo
    ? (eurosToCents(cm["avg30-holo"]) ?? eurosToCents(cm.avg30))
    : eurosToCents(cm.avg30);
  const lowFrCents = preferHolo
    ? (eurosToCents(cm["low-holo"]) ?? eurosToCents(cm.low))
    : eurosToCents(cm.low);

  if (trendCents === null && avg30Cents === null && lowFrCents === null) {
    return null;
  }
  return { trendCents, avg30Cents, lowFrCents };
};

export interface TcgdexPriceFallbackLiveOptions {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Live fallback over the TCGdex v2 API (`GET /v2/en/cards/{id}` → flat
 * `pricing.cardmarket.{unit, avg, low, trend, avg30, *-holo}`).
 */
export const TcgdexPriceFallbackLive = (
  options?: TcgdexPriceFallbackLiveOptions,
): Layer.Layer<TcgdexPriceFallback> => {
  const baseUrl = (options?.baseUrl ?? DEFAULT_TCGDEX_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options?.timeoutMs ?? 10_000;
  return Layer.succeed(TcgdexPriceFallback, {
    getFallbackPrices: (cardId, language, variant) => {
      const url = `${baseUrl}/en/cards/${encodeURIComponent(cardId)}`;
      const fetchBody = Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            headers: { accept: "application/json" },
          });
          const body = await response.text();
          if (!response.ok) {
            throw new TcgdexHttpError({
              url,
              status: response.status,
              retryable: response.status === 429 || response.status >= 500,
              body: body.length > 500 ? `${body.slice(0, 500)}…` : body,
            });
          }
          return body;
        },
        catch: (cause): TcgdexError =>
          cause instanceof TcgdexHttpError
            ? cause
            : new TcgdexHttpError({ url, status: 0, retryable: true, body: null, cause }),
      });
      return fetchBody.pipe(
        Effect.flatMap((body) =>
          Effect.try({
            try: () => JSON.parse(body) as unknown,
            catch: (cause) => new TcgdexDecodeError({ url, cause }),
          }),
        ),
        Effect.flatMap((value) => Schema.decodeUnknownEffect(TcgdexCardPricingPayload)(value)),
        Effect.map((payload) => pickTcgdexFallbackPrices(payload, language, variant)),
        Effect.mapError((error): TcgdexError => {
          if (error instanceof TcgdexHttpError || error instanceof TcgdexDecodeError) return error;
          return new TcgdexDecodeError({ url, cause: error });
        }),
      );
    },
  });
};

/** Fake TCGdex fallback for tests. */
export const TcgdexPriceFallbackFake = (
  handler: (
    cardId: string,
    language: CardLanguage,
    variant: CardVariant,
  ) => Effect.Effect<TcgdexFallbackPrices | null, TcgdexError>,
): Layer.Layer<TcgdexPriceFallback> =>
  Layer.succeed(TcgdexPriceFallback, { getFallbackPrices: handler });

// ---------------------------------------------------------------------------
// CardmarketPriceService
// ---------------------------------------------------------------------------

/** Result of reading the latest known price of a card. */
export interface LatestPrice {
  readonly snapshot: PriceSnapshot;
  readonly freshness: PriceFreshness;
}

/** Outcome of a single `refreshCardPrice`. */
export type PriceRefreshResult =
  | { readonly kind: "refreshed_cardmarket"; readonly snapshot: PriceSnapshot }
  | { readonly kind: "refreshed_fallback"; readonly snapshot: PriceSnapshot }
  | { readonly kind: "fresh_cache"; readonly snapshot: PriceSnapshot }
  | { readonly kind: "degraded"; readonly snapshot: PriceSnapshot };

export type PriceRefreshError =
  | PriceRefreshCooldownError
  | PriceCircuitOpenError
  | CardmarketScrapeError
  | DatabaseError;

export interface RefreshCardPriceOptions {
  /** Bypass the fresh-cache shortcut and scrape anyway. */
  readonly force?: boolean | undefined;
  /** Manual (user-triggered) refresh: enforces the global 5 min/carte cooldown. */
  readonly manual?: boolean | undefined;
}

export interface RunScheduledRefreshOptions {
  readonly batchLimit?: number | undefined;
  readonly manual?: boolean | undefined;
}

/** Observable state of the circuit breaker. */
export interface CircuitBreakerState {
  readonly status: "closed" | "open";
  readonly consecutiveBlocks: number;
  readonly openUntilMs: number;
  readonly openUntil: string | null;
}

export interface CardmarketPriceServiceShape {
  readonly getLatestPrice: (
    cardId: string,
    language?: CardLanguage,
    variant?: CardVariant,
  ) => Effect.Effect<LatestPrice | null, DatabaseError>;
  readonly refreshCardPrice: (
    target: PriceRefreshTarget,
    options?: RefreshCardPriceOptions,
  ) => Effect.Effect<PriceRefreshResult, PriceRefreshError>;
  readonly runScheduledRefresh: (
    options?: RunScheduledRefreshOptions,
  ) => Effect.Effect<PriceBatchReport, DatabaseError>;
  readonly getCircuitState: () => Effect.Effect<CircuitBreakerState>;
  readonly pruneExpiredSnapshots: () => Effect.Effect<number, DatabaseError>;
}

/** Effect-TS service key of the Cardmarket price service. */
export class CardmarketPriceService extends Context.Service<
  CardmarketPriceService,
  CardmarketPriceServiceShape
>()("@pokevault/services/CardmarketPriceService") {}

export interface CardmarketPriceServiceConfig {
  /** Max concurrent Cardmarket requests, clamped to 1..2 (default 1). */
  readonly maxConcurrency?: number | undefined;
  /** Jitter between requests, ms (default 1500..4000; 0 disables it, tests). */
  readonly jitterMinMs?: number | undefined;
  readonly jitterMaxMs?: number | undefined;
  readonly circuitBasePauseMs?: number | undefined;
  readonly circuitMaxPauseMs?: number | undefined;
  readonly batchLimit?: number | undefined;
}

interface CircuitInternal {
  readonly consecutiveBlocks: number;
  readonly openUntilMs: number;
}

type ScrapeOutcome =
  | { readonly kind: "ok"; readonly input: NewPriceSnapshot }
  | { readonly kind: "circuit_open"; readonly error: PriceCircuitOpenError }
  | { readonly kind: "error"; readonly error: CardmarketScrapeError };

const hasAtLeastOnePrice = (prices: {
  readonly trendCents: number | null;
  readonly lowFrCents: number | null;
  readonly avg30Cents: number | null;
}): boolean =>
  prices.trendCents !== null || prices.lowFrCents !== null || prices.avg30Cents !== null;

/**
 * Live service. Dependencies are injectable ports (`PriceSnapshotStore`,
 * `CardmarketFetcher`, `TcgdexPriceFallback`); `Clock`, `Effect.sleep` and
 * `Random` are Effect services, so tests run with `TestClock` + a seeded Random
 * and zero real waiting / network.
 */
export const CardmarketPriceServiceLive = (
  config?: CardmarketPriceServiceConfig,
): Layer.Layer<
  CardmarketPriceService,
  never,
  PriceSnapshotStore | CardmarketFetcher | TcgdexPriceFallback
> =>
  Layer.effect(
    CardmarketPriceService,
    Effect.gen(function* () {
      const store = yield* PriceSnapshotStore;
      const fetcher = yield* CardmarketFetcher;
      const fallback = yield* TcgdexPriceFallback;

      const maxConcurrency = Math.min(2, Math.max(1, Math.trunc(config?.maxConcurrency ?? 1)));
      const jitterMinMs = Math.max(0, Math.trunc(config?.jitterMinMs ?? MIN_JITTER_MS));
      const jitterMaxMs = Math.max(jitterMinMs, Math.trunc(config?.jitterMaxMs ?? MAX_JITTER_MS));
      const basePauseMs = config?.circuitBasePauseMs ?? CIRCUIT_BASE_PAUSE_MS;
      const maxPauseMs = config?.circuitMaxPauseMs ?? CIRCUIT_MAX_PAUSE_MS;
      const defaultBatchLimit = Math.max(
        1,
        Math.trunc(config?.batchLimit ?? DEFAULT_PRICE_BATCH_LIMIT),
      );

      const semaphore = yield* Semaphore.make(maxConcurrency);
      const circuitRef = yield* Ref.make<CircuitInternal>({ consecutiveBlocks: 0, openUntilMs: 0 });

      const readCircuit: Effect.Effect<CircuitBreakerState> = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const state = yield* Ref.get(circuitRef);
        const open = state.openUntilMs > now;
        return {
          status: open ? "open" : "closed",
          consecutiveBlocks: state.consecutiveBlocks,
          openUntilMs: open ? state.openUntilMs : 0,
          openUntil: open ? new Date(state.openUntilMs).toISOString() : null,
        } satisfies CircuitBreakerState;
      });

      const recordBlock = (retryAfterMs: number | undefined): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const previous = yield* Ref.get(circuitRef);
          const consecutiveBlocks = previous.consecutiveBlocks + 1;
          const pauseMs = computeCircuitPauseMs(
            consecutiveBlocks,
            retryAfterMs,
            basePauseMs,
            maxPauseMs,
          );
          const openUntilMs = now + pauseMs;
          yield* Ref.set(circuitRef, { consecutiveBlocks, openUntilMs });
          yield* Effect.logWarning("cardmarket.circuit_opened").pipe(
            Effect.annotateLogs({
              consecutiveBlocks,
              pauseMs,
              openUntilMs,
              openUntil: new Date(openUntilMs).toISOString(),
            }),
          );
        });

      const recordSuccess: Effect.Effect<void> = Effect.gen(function* () {
        const previous = yield* Ref.get(circuitRef);
        if (previous.consecutiveBlocks !== 0 || previous.openUntilMs !== 0) {
          yield* Ref.set(circuitRef, { consecutiveBlocks: 0, openUntilMs: 0 });
          yield* Effect.logInfo("cardmarket.circuit_closed").pipe(
            Effect.annotateLogs({ previousBlocks: previous.consecutiveBlocks }),
          );
        }
      });

      /** One Cardmarket scrape: jitter → circuit re-check → fetch → parse → snapshot input (TTL explicit). */
      const scrapeCardmarket = (
        target: PriceRefreshTarget,
        url: string,
      ): Effect.Effect<ScrapeOutcome> =>
        Effect.gen(function* () {
          if (jitterMaxMs > 0) {
            const delayMs = yield* Random.nextIntBetween(jitterMinMs, jitterMaxMs);
            yield* Effect.sleep(delayMs);
          }
          // Re-check circuit breaker after semaphore wait + jitter so a concurrent
          // 403/429 immediately halts sibling fibers before hitting Cardmarket.
          const circuit = yield* readCircuit;
          if (circuit.status === "open") {
            const outcome: ScrapeOutcome = {
              kind: "circuit_open",
              error: new PriceCircuitOpenError({
                openUntil: circuit.openUntil ?? new Date(circuit.openUntilMs).toISOString(),
                consecutiveBlocks: circuit.consecutiveBlocks,
                message: `circuit breaker open until ${circuit.openUntil ?? "?"}; no Cardmarket call for ${target.cardId}`,
              }),
            };
            return outcome;
          }
          const html = yield* fetcher.fetchProductPage(url);
          const prices = yield* parseCardmarketProductPage(html, { cardId: target.cardId, url });
          const fetchedAtMs = yield* Clock.currentTimeMillis;
          const outcome: ScrapeOutcome = {
            kind: "ok",
            input: {
              cardId: target.cardId,
              language: target.language,
              variant: target.variant,
              source: "cardmarket",
              trendCents: prices.trendCents,
              lowFrCents: prices.lowFrCents,
              avg30Cents: prices.avg30Cents,
              fetchedAt: new Date(fetchedAtMs).toISOString(),
              expiresAt: new Date(fetchedAtMs + PRICE_TTL_MS).toISOString(),
            },
          };
          return outcome;
        }).pipe(
          Effect.catchTags({
            CardmarketBlockedError: (error) =>
              Effect.succeed<ScrapeOutcome>({ kind: "error", error }),
            CardmarketParseError: (error) =>
              Effect.succeed<ScrapeOutcome>({ kind: "error", error }),
            CardmarketNetworkError: (error) =>
              Effect.succeed<ScrapeOutcome>({ kind: "error", error }),
          }),
        );

      const resolveFallbackPrices = (
        target: PriceRefreshTarget,
      ): Effect.Effect<TcgdexFallbackPrices | null> =>
        Effect.gen(function* () {
          if (target.tcgdexFallback !== undefined && hasAtLeastOnePrice(target.tcgdexFallback)) {
            return target.tcgdexFallback;
          }
          const fromApi = yield* fallback
            .getFallbackPrices(target.cardId, target.language, target.variant)
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning("cardmarket.fallback_failed").pipe(
                  Effect.annotateLogs({
                    cardId: target.cardId,
                    errorTag: error._tag,
                    message:
                      error._tag === "TcgdexHttpError"
                        ? `TCGdex HTTP ${error.status} on ${error.url}`
                        : `TCGdex payload decode failed on ${error.url}`,
                  }),
                ),
              ),
              Effect.option,
            );
          const prices = Option.getOrNull(fromApi);
          if (prices !== null && !hasAtLeastOnePrice(prices)) return null;
          return prices;
        });

      /** Fallback (TCGdex) first, then the last known snapshot in degraded mode. */
      const fallbackOrDegraded = (
        target: PriceRefreshTarget,
        latest: PriceSnapshot | null,
        failure: PriceRefreshError,
      ): Effect.Effect<PriceRefreshResult, PriceRefreshError> =>
        Effect.gen(function* () {
          const prices = yield* resolveFallbackPrices(target);
          if (prices !== null) {
            const fetchedAtMs = yield* Clock.currentTimeMillis;
            const snapshot = yield* store.insertSnapshot({
              cardId: target.cardId,
              language: target.language,
              variant: target.variant,
              source: "tcgdex_fallback",
              trendCents: prices.trendCents,
              lowFrCents: prices.lowFrCents,
              avg30Cents: prices.avg30Cents,
              fetchedAt: new Date(fetchedAtMs).toISOString(),
              expiresAt: new Date(fetchedAtMs + PRICE_TTL_MS).toISOString(),
            });
            yield* Effect.logInfo("cardmarket.refresh.fallback_persisted").pipe(
              Effect.annotateLogs({ cardId: target.cardId, snapshotId: snapshot.id }),
            );
            return { kind: "refreshed_fallback", snapshot } satisfies PriceRefreshResult;
          }
          if (latest !== null) {
            yield* Effect.logWarning("cardmarket.refresh.degraded").pipe(
              Effect.annotateLogs({ cardId: target.cardId, snapshotId: latest.id }),
            );
            return { kind: "degraded", snapshot: latest } satisfies PriceRefreshResult;
          }
          return yield* Effect.fail(failure);
        });

      const refreshCardPrice = (
        target: PriceRefreshTarget,
        options?: RefreshCardPriceOptions,
      ): Effect.Effect<PriceRefreshResult, PriceRefreshError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const force = options?.force ?? false;
          const manual = options?.manual ?? false;

          // 1. Manual refresh: global 5 min/carte cooldown, no Cardmarket call.
          if (manual) {
            const lastFetchedAtMs = yield* store.getLastFetchedAtMs(target.cardId);
            if (lastFetchedAtMs !== null && now - lastFetchedAtMs < PRICE_MANUAL_COOLDOWN_MS) {
              const retryAfterMs = PRICE_MANUAL_COOLDOWN_MS - (now - lastFetchedAtMs);
              return yield* Effect.fail(
                new PriceRefreshCooldownError({
                  cardId: target.cardId,
                  retryAfterMs,
                  nextAllowedAt: new Date(lastFetchedAtMs + PRICE_MANUAL_COOLDOWN_MS).toISOString(),
                  message: `manual refresh of card ${target.cardId} is in cooldown for ${Math.ceil(retryAfterMs / 1000)}s`,
                }),
              );
            }
          }

          // 2. Fresh-cache shortcut (unless forced).
          const latest = yield* store.getLatest(target.cardId, target.language, target.variant);
          if (!force && latest !== null && Date.parse(latest.expiresAt) > now) {
            return { kind: "fresh_cache", snapshot: latest } satisfies PriceRefreshResult;
          }

          // 3. Circuit breaker gate: while open, no Cardmarket network call at all.
          const circuit = yield* readCircuit;
          if (circuit.status === "open") {
            yield* Effect.logInfo("cardmarket.refresh.circuit_open").pipe(
              Effect.annotateLogs({ cardId: target.cardId, openUntil: circuit.openUntil ?? "" }),
            );
            return yield* fallbackOrDegraded(
              target,
              latest,
              new PriceCircuitOpenError({
                openUntil: circuit.openUntil ?? new Date(circuit.openUntilMs).toISOString(),
                consecutiveBlocks: circuit.consecutiveBlocks,
                message: `circuit breaker open until ${circuit.openUntil ?? "?"}; no Cardmarket call for ${target.cardId}`,
              }),
            );
          }

          // 4. Scrape Cardmarket (SSRF-guarded), inside the semaphore.
          if (isAllowedCardmarketUrl(target.cardmarketUrl)) {
            const url = target.cardmarketUrl;
            const outcome = yield* semaphore.withPermits(1)(scrapeCardmarket(target, url));
            if (outcome.kind === "ok") {
              yield* recordSuccess;
              const snapshot = yield* store.insertSnapshot(outcome.input);
              yield* Effect.logInfo("cardmarket.refresh.cardmarket_ok").pipe(
                Effect.annotateLogs({ cardId: target.cardId, snapshotId: snapshot.id }),
              );
              return { kind: "refreshed_cardmarket", snapshot } satisfies PriceRefreshResult;
            }
            if (outcome.kind === "circuit_open") {
              yield* Effect.logInfo("cardmarket.refresh.circuit_open").pipe(
                Effect.annotateLogs({
                  cardId: target.cardId,
                  openUntil: outcome.error.openUntil,
                }),
              );
              return yield* fallbackOrDegraded(target, latest, outcome.error);
            }
            if (outcome.error._tag === "CardmarketBlockedError") {
              yield* recordBlock(outcome.error.retryAfterMs);
              return yield* fallbackOrDegraded(target, latest, outcome.error);
            }
            yield* Effect.logWarning("cardmarket.refresh.scrape_failed").pipe(
              Effect.annotateLogs({
                cardId: target.cardId,
                errorTag: outcome.error._tag,
                url,
                message: outcome.error.message,
              }),
            );
            return yield* fallbackOrDegraded(target, latest, outcome.error);
          }

          // 5. SSRF guard rejected the URL: no network call, straight to fallback.
          yield* Effect.logWarning("cardmarket.refresh.url_rejected").pipe(
            Effect.annotateLogs({
              cardId: target.cardId,
              url: target.cardmarketUrl ?? "null",
              reason: "ssrf_guard",
            }),
          );
          return yield* fallbackOrDegraded(
            target,
            latest,
            new CardmarketParseError({
              cardId: target.cardId,
              url: target.cardmarketUrl ?? "",
              message:
                "cardmarketUrl is not an allowed https://www.cardmarket.com or https://cardmarket.com URL",
            }),
          );
        });

      const getLatestPrice: CardmarketPriceServiceShape["getLatestPrice"] = (
        cardId,
        language = "FR",
        variant = "normal",
      ) =>
        Effect.gen(function* () {
          const snapshot = yield* store.getLatest(cardId, language, variant);
          if (snapshot === null) return null;
          const now = yield* Clock.currentTimeMillis;
          return {
            snapshot,
            freshness: computePriceFreshness(snapshot, now),
          } satisfies LatestPrice;
        });

      interface Counters {
        readonly attempted: number;
        readonly refreshedCardmarket: number;
        readonly refreshedFallback: number;
        readonly skippedFresh: number;
        readonly skippedCooldown: number;
        readonly skippedCircuitOpen: number;
        readonly failed: number;
      }

      const increment = (
        counters: Counters,
        field: keyof Omit<Counters, "attempted">,
      ): Counters => {
        switch (field) {
          case "refreshedCardmarket":
            return { ...counters, refreshedCardmarket: counters.refreshedCardmarket + 1 };
          case "refreshedFallback":
            return { ...counters, refreshedFallback: counters.refreshedFallback + 1 };
          case "skippedFresh":
            return { ...counters, skippedFresh: counters.skippedFresh + 1 };
          case "skippedCooldown":
            return { ...counters, skippedCooldown: counters.skippedCooldown + 1 };
          case "skippedCircuitOpen":
            return { ...counters, skippedCircuitOpen: counters.skippedCircuitOpen + 1 };
          case "failed":
            return { ...counters, failed: counters.failed + 1 };
        }
      };

      const runScheduledRefresh = (
        options?: RunScheduledRefreshOptions,
      ): Effect.Effect<PriceBatchReport, DatabaseError> =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const limit = Math.max(1, Math.trunc(options?.batchLimit ?? defaultBatchLimit));
          const manual = options?.manual ?? false;
          const targets = yield* store.selectPriorityTargets(limit);
          const counters = yield* Ref.make<Counters>({
            attempted: targets.length,
            refreshedCardmarket: 0,
            refreshedFallback: 0,
            skippedFresh: 0,
            skippedCooldown: 0,
            skippedCircuitOpen: 0,
            failed: 0,
          });

          yield* Effect.forEach(
            targets,
            (target) =>
              Effect.gen(function* () {
                // Stop cleanly as soon as the circuit breaker is open: no network call.
                const circuit = yield* readCircuit;
                if (circuit.status === "open") {
                  yield* Ref.update(counters, (c) => increment(c, "skippedCircuitOpen"));
                  return;
                }
                const exit = yield* Effect.exit(refreshCardPrice(target, { manual }));
                if (Exit.isSuccess(exit)) {
                  const field =
                    exit.value.kind === "refreshed_cardmarket"
                      ? ("refreshedCardmarket" as const)
                      : exit.value.kind === "refreshed_fallback"
                        ? ("refreshedFallback" as const)
                        : exit.value.kind === "fresh_cache"
                          ? ("skippedFresh" as const)
                          : ("failed" as const); // degraded: served the old snapshot
                  yield* Ref.update(counters, (c) => increment(c, field));
                  return;
                }
                const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
                const field =
                  error instanceof PriceRefreshCooldownError ? "skippedCooldown" : "failed";
                yield* Ref.update(counters, (c) => increment(c, field));
              }),
            { concurrency: maxConcurrency, discard: true },
          );

          const circuit = yield* readCircuit;
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
          const report: PriceBatchReport = {
            ...(yield* Ref.get(counters)),
            circuitOpenUntil: circuit.openUntil,
            durationMs,
          };
          yield* Effect.logInfo("cardmarket.batch.completed").pipe(
            Effect.annotateLogs({ ...report }),
          );
          return report;
        });

      return {
        getLatestPrice,
        refreshCardPrice,
        runScheduledRefresh,
        getCircuitState: () => readCircuit,
        pruneExpiredSnapshots: () => store.pruneExpiredSnapshots(),
      } satisfies CardmarketPriceServiceShape;
    }),
  );

// ---------------------------------------------------------------------------
// Ready-made composition (worker bootstrap)
// ---------------------------------------------------------------------------

export interface CardmarketPriceLayerOptions {
  readonly databaseUrl: string;
  readonly tcgdexBaseUrl?: string | undefined;
  readonly fetcherTimeoutMs?: number | undefined;
  readonly service?: CardmarketPriceServiceConfig | undefined;
}

/**
 * Fully wired layer: `CardmarketPriceService` over the Postgres store, the live
 * Cardmarket fetcher and the live TCGdex fallback. The pool lifetime is bound to
 * the scope in which the layer is built (worker shutdown).
 */
export const CardmarketPriceLayer = (
  options: CardmarketPriceLayerOptions,
): Layer.Layer<CardmarketPriceService> =>
  CardmarketPriceServiceLive(options.service).pipe(
    Layer.provide(
      Layer.mergeAll(
        PriceSnapshotStoreLive.pipe(
          Layer.provide(DatabaseLive({ connectionString: options.databaseUrl })),
        ),
        CardmarketFetcherLive({ timeoutMs: options.fetcherTimeoutMs }),
        TcgdexPriceFallbackLive({ baseUrl: options.tcgdexBaseUrl }),
      ),
    ),
  );
