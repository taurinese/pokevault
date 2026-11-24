import { Data, Schema } from "effect";
import { CardLanguage, CardVariant } from "./card.ts";

// ---------------------------------------------------------------------------
// Constants (docs/04-integrations.md §2.1)
// ---------------------------------------------------------------------------

/** TTL of a Cardmarket price snapshot: 15 minutes. */
export const PRICE_TTL_MS = 15 * 60 * 1000;

/** Above 6 hours of age, a price is considered stale (neutral dot in the UI). */
export const PRICE_STALE_AMBER_MS = 6 * 60 * 60 * 1000;

/** Global manual refresh cooldown: 5 minutes per card, shared instance-wide. */
export const PRICE_MANUAL_COOLDOWN_MS = 5 * 60 * 1000;

/** Maximum representable price in cents (Postgres `int4` max = 21,474,836.47 €). */
export const MAX_PRICE_CENTS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Where a price snapshot comes from. */
export const PriceSource = Schema.Literals(["cardmarket", "tcgdex_fallback"]);
export type PriceSource = typeof PriceSource.Type;

/** Freshness displayed as a colored dot in the UI (docs/04 §2.1). */
export const PriceFreshness = Schema.Literals(["fresh", "aging", "stale", "missing"]);
export type PriceFreshness = typeof PriceFreshness.Type;

/** Price in euro cents (Postgres int4 integer, never a float). */
const PriceCents = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_PRICE_CENTS)),
);

/** Row of `price_snapshots` / `card_latest_prices` (camelCase domain view). */
export const PriceSnapshot = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cardId: Schema.NonEmptyString,
  language: CardLanguage,
  variant: CardVariant,
  source: PriceSource,
  trendCents: PriceCents,
  lowFrCents: PriceCents,
  avg30Cents: PriceCents,
  /** ISO 8601 timestamp of the collection. */
  fetchedAt: Schema.String,
  /** ISO 8601 TTL limit: `fetchedAt + 15 min` (always set explicitly on INSERT). */
  expiresAt: Schema.String,
  /** `expiresAt > now()` at read time (column of the `card_latest_prices` view). */
  isFresh: Schema.Boolean,
});
export type PriceSnapshot = typeof PriceSnapshot.Type;

/** Cron refresh priority (docs/04 §2.1): active alerts → wishlists → featured cards. */
export const PriceRefreshPriority = Schema.Literals(["active_alert", "wishlist", "featured"]);
export type PriceRefreshPriority = typeof PriceRefreshPriority.Type;

/** Numeric rank of each priority (lower = refreshed first). */
export const PRICE_REFRESH_PRIORITY_RANK: Record<PriceRefreshPriority, number> = {
  active_alert: 1,
  wishlist: 2,
  featured: 3,
};

/** Aggregated Cardmarket prices exposed by TCGdex (`pricing.cardmarket`), in cents. */
export const TcgdexFallbackPrices = Schema.Struct({
  trendCents: PriceCents,
  avg30Cents: PriceCents,
  lowFrCents: PriceCents,
});
export type TcgdexFallbackPrices = typeof TcgdexFallbackPrices.Type;

/** One card the cron may refresh. */
export const PriceRefreshTarget = Schema.Struct({
  cardId: Schema.NonEmptyString,
  language: CardLanguage,
  variant: CardVariant,
  /** Cardmarket product page URL (SSRF-guarded: `https://www.cardmarket.com` / `https://cardmarket.com` only). */
  cardmarketUrl: Schema.NullOr(Schema.String),
  priority: PriceRefreshPriority,
  /** Pre-resolved TCGdex fallback prices, if already known. */
  tcgdexFallback: Schema.optional(TcgdexFallbackPrices),
});
export type PriceRefreshTarget = typeof PriceRefreshTarget.Type;

/** Counters of one scheduled refresh batch. */
export const PriceBatchReport = Schema.Struct({
  attempted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refreshedCardmarket: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refreshedFallback: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedFresh: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedCooldown: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedCircuitOpen: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** ISO 8601 instant until which the circuit breaker stays open (`null` when closed). */
  circuitOpenUntil: Schema.NullOr(Schema.String),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PriceBatchReport = typeof PriceBatchReport.Type;

// ---------------------------------------------------------------------------
// Pure freshness helper (client-safe: drives the green/amber/neutral dot)
// ---------------------------------------------------------------------------

export interface PriceFreshnessInput {
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly source: PriceSource;
}

const parseIsoMs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
};

/**
 * Computes the displayed freshness of a price snapshot (docs/04 §2.1):
 *
 * - `null` snapshot → `"missing"`;
 * - `tcgdex_fallback` source → always `"stale"` (indicative price only);
 * - age `< 15 min` and `now < expiresAt` → `"fresh"` (green dot);
 * - `15 min <= age <= 6 h` → `"aging"` (amber dot);
 * - age `> 6 h` (or unparseable dates) → `"stale"` (neutral dot + *indicatif*).
 */
export const computePriceFreshness = (
  snapshot: PriceFreshnessInput | null,
  nowMs: number,
): PriceFreshness => {
  if (snapshot === null) return "missing";
  if (snapshot.source === "tcgdex_fallback") return "stale";
  const fetchedAtMs = parseIsoMs(snapshot.fetchedAt);
  const expiresAtMs = parseIsoMs(snapshot.expiresAt);
  if (Number.isNaN(fetchedAtMs) || Number.isNaN(expiresAtMs)) return "stale";
  const ageMs = nowMs - fetchedAtMs;
  if (ageMs < PRICE_TTL_MS && nowMs < expiresAtMs) return "fresh";
  if (ageMs <= PRICE_STALE_AMBER_MS) return "aging";
  return "stale";
};

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Cardmarket refused the request (403 / 429 / anti-bot challenge page). */
export class CardmarketBlockedError extends Data.TaggedError("CardmarketBlockedError")<{
  readonly status: 403 | 429 | "challenge";
  readonly retryAfterMs?: number | undefined;
  readonly message: string;
}> {}

/** The product page HTML could not be parsed into prices (structure may have changed). */
export class CardmarketParseError extends Data.TaggedError("CardmarketParseError")<{
  readonly cardId: string;
  readonly url: string;
  readonly message: string;
}> {}

/** Transport-level failure of the Cardmarket HTTP request. */
export class CardmarketNetworkError extends Data.TaggedError("CardmarketNetworkError")<{
  readonly url: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Manual refresh refused by the global 5 min/carte cooldown. */
export class PriceRefreshCooldownError extends Data.TaggedError("PriceRefreshCooldownError")<{
  readonly cardId: string;
  readonly retryAfterMs: number;
  readonly nextAllowedAt: string;
  readonly message: string;
}> {}

/** Circuit breaker open: no Cardmarket network call was attempted. */
export class PriceCircuitOpenError extends Data.TaggedError("PriceCircuitOpenError")<{
  readonly openUntil: string;
  readonly consecutiveBlocks: number;
  readonly message: string;
}> {}

/** Every typed error a single Cardmarket scrape can end with. */
export type CardmarketScrapeError =
  | CardmarketBlockedError
  | CardmarketParseError
  | CardmarketNetworkError;
