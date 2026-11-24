import { CardmarketBlockedError, CardmarketParseError, MAX_PRICE_CENTS } from "@pokevault/domain";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Pure Cardmarket product-page HTML parser (no DOM dependency, R2 mitigation)
//
// Cardmarket has no public API for personal use: the worker scrapes product
// pages. This parser is deliberately tolerant (whitespace, HTML entities,
// `,` / `.` decimal and thousand separators) and NEVER tries to bypass an
// anti-bot challenge — it just reports it so the circuit breaker can open.
// ---------------------------------------------------------------------------

/** Prices extracted from a Cardmarket product page, in euro cents (integers). */
export interface CardmarketProductPrices {
  /** « Tendance des prix » / « Price Trend ». */
  readonly trendCents: number | null;
  /** « À partir de » / « From » (lowest FR NM+ price of the info section). */
  readonly lowFrCents: number | null;
  /** « Prix moyen 30 jours » / « 30-days average price ». */
  readonly avg30Cents: number | null;
}

export interface CardmarketPageContext {
  readonly cardId: string;
  readonly url: string;
}

export type CardmarketPageParseError = CardmarketBlockedError | CardmarketParseError;

// ---------------------------------------------------------------------------
// Anti-bot challenge detection (Cloudflare / Turnstile / captcha)
// ---------------------------------------------------------------------------

/** Explicit interstitial page title served by Cloudflare / anti-bot gates. */
const CHALLENGE_TITLE_PATTERN =
  /<title[^>]*>[^<]*(attention required|just a moment|checking your browser|please verify|verify you are human|are you a robot|captcha|vérification de sécurité|security check)[^<]*<\/title>/i;

/**
 * Strict challenge interstitial signatures. Intentionally avoids matching
 * generic Cloudflare telemetry beacons (`/cdn-cgi/challenge-platform/scripts/jsd/...`
 * or unrelated `data-sitekey=` attributes) that Cloudflare injects on normal
 * product pages.
 */
const CHALLENGE_PATTERNS: ReadonlyArray<RegExp> = [
  CHALLENGE_TITLE_PATTERN,
  /cf-turnstile/i,
  /class="[^"]*cf-chl/i,
  /id="(?:challenge-form|cf-challenge-running)"/i,
  /name="captcha/i,
  /(?:google\.com\/recaptcha|hcaptcha\.com|arkoselabs)/i,
];

/** True when the HTML looks like an anti-bot challenge page (never bypassed). */
export const isChallengePage = (html: string): boolean =>
  CHALLENGE_PATTERNS.some((pattern) => pattern.test(html));

// ---------------------------------------------------------------------------
// HTML entities & tags
// ---------------------------------------------------------------------------

/** Decodes the common HTML entities found in Cardmarket price cells. */
export const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, "\u00a0")
    .replace(/&euro;/gi, "€")
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");

/**
 * Flattens HTML to text: block/cell boundaries become newlines (so a label and
 * its price stay on adjacent lines), every other tag becomes a space.
 */
export const flattenHtml = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<\s*(?:br|\/tr|\/td|\/th|\/div|\/dt|\/dd|\/li|\/p|\/h[1-6])[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    // Collapse plain whitespace runs, but keep narrow no-break spaces (\u00a0):
    // they are thousand separators inside amounts ("1\u00a0250,50 €").
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n");

// ---------------------------------------------------------------------------
// Euro amount → integer cents
// ---------------------------------------------------------------------------

/**
 * Parses a euro amount string into integer cents (`Math.round(euros * 100)`
 * semantics, but computed exactly on the decimal string — never a float).
 *
 * Handles both locales:
 * - FR: `124,90` → 12490, `1.250,50` → 125050, `1.250` → 125000 (dot = thousands);
 * - EN: `12.90` → 1290, `1,250.50` → 125050, `1,250` → 125000 (comma = thousands).
 *
 * When both separators are present, the last one is the decimal separator.
 * A single separator followed by exactly 1–2 digits is a decimal separator,
 * otherwise it is a thousands separator. Returns `null` for anything that is
 * not a plain non-negative amount (rejects NaN / negatives).
 */
export const parseEuroAmountToCents = (raw: string): number | null => {
  const cleaned = raw.replace(/[\s\u00a0\u200b']/g, "");
  if (!/^\d+(?:[.,]\d+)*$/.test(cleaned)) return null;
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let intPart: string;
  let fracPart: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators: the last one is the decimal separator (1–2 digits).
    const decimalIsComma = lastComma > lastDot;
    const lastSep = decimalIsComma ? lastComma : lastDot;
    fracPart = cleaned.slice(lastSep + 1);
    if (fracPart.length < 1 || fracPart.length > 2) return null;
    intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
  } else if (lastComma >= 0) {
    const digitsAfter = cleaned.length - lastComma - 1;
    if (cleaned.indexOf(",") === lastComma && digitsAfter >= 1 && digitsAfter <= 2) {
      // Single comma with 1–2 trailing digits: decimal separator.
      intPart = cleaned.slice(0, lastComma);
      fracPart = cleaned.slice(lastComma + 1);
    } else if (digitsAfter === 3) {
      // Thousands separator(s) only.
      intPart = cleaned.replace(/,/g, "");
      fracPart = "";
    } else {
      return null;
    }
  } else if (lastDot >= 0) {
    const digitsAfter = cleaned.length - lastDot - 1;
    if (cleaned.indexOf(".") === lastDot && digitsAfter >= 1 && digitsAfter <= 2) {
      intPart = cleaned.slice(0, lastDot);
      fracPart = cleaned.slice(lastDot + 1);
    } else if (digitsAfter === 3) {
      intPart = cleaned.replace(/\./g, "");
      fracPart = "";
    } else {
      return null;
    }
  } else {
    intPart = cleaned;
    fracPart = "";
  }
  const cents =
    Number(intPart) * 100 + (fracPart.length > 0 ? Number(fracPart.padEnd(2, "0").slice(0, 2)) : 0);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_PRICE_CENTS) return null;
  return cents;
};

/**
 * One euro amount token, in either order (`124,90 €` or `€1,250.50`, `98.00 EUR`).
 * The digit class deliberately excludes `\s` (newlines) so a match never spans
 * two flattened lines; only narrow thousand separators (nbsp, thin space) are allowed.
 * Optional leading minus signs are captured so negative amounts (`-5,00 €`, `-€5.00`,
 * `€-5.00`) are consumed whole and rejected rather than partially matched.
 */
const PRICE_TOKEN =
  /(?<![\d.,])([-\u2212]?)(?:€\s*([-\u2212]?)(\d[\d.,\u00a0\u200b']*)|(\d[\d.,\u00a0\u200b']*)\s*(?:€|eur\b|euros?\b))/gi;

/** First euro amount found in `text` (nearest to the start), in integer cents (`null` when none). */
export const findFirstPriceCents = (text: string): number | null => {
  PRICE_TOKEN.lastIndex = 0;
  for (;;) {
    const match = PRICE_TOKEN.exec(text);
    if (match === null) return null;
    if ((match[1] ?? "") !== "" || (match[2] ?? "") !== "") continue;
    const cents = parseEuroAmountToCents(match[3] ?? match[4] ?? "");
    if (cents !== null) return cents;
  }
};

// ---------------------------------------------------------------------------
// Labeled price extraction
// ---------------------------------------------------------------------------

const TREND_LABELS: ReadonlyArray<RegExp> = [
  /tendance (?:des |du )?prix/i,
  /cours du prix/i,
  /price trend/i,
  /trend price/i,
];

const LOW_LABELS: ReadonlyArray<RegExp> = [
  /à partir de/i,
  /a partir de/i,
  /dès\s/i,
  /\bfrom\b/i,
  /\blowest\b/i,
];

const AVG30_LABELS: ReadonlyArray<RegExp> = [
  /prix moyen(?: sur)? 30 jours/i,
  /moyenne(?: des prix)?(?: sur)? 30 jours/i,
  /30[-\s]days? average price/i,
  /average price/i,
  /avg\.?\s*30/i,
];

/** Window (in flattened-text lines) searched after a label for its price. */
const LABEL_LOOKAHEAD_LINES = 3;

/**
 * Finds the price attached to any of the given labels. The flattened text is
 * split into lines; the price is searched on the label line and the following
 * {@link LABEL_LOOKAHEAD_LINES} lines (table row / definition list layout).
 */
const extractLabeledPrice = (html: string, labels: ReadonlyArray<RegExp>): number | null => {
  const lines = flattenHtml(html).split("\n");
  for (const label of labels) {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      label.lastIndex = 0;
      const match = label.exec(line);
      if (match === null) continue;
      const window = lines.slice(index, index + LABEL_LOOKAHEAD_LINES + 1).join("\n");
      const cents = findFirstPriceCents(window.slice(match.index));
      if (cents !== null) return cents;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses a Cardmarket product page into integer-cent prices.
 *
 * - Anti-bot challenge pages → `CardmarketBlockedError` with `status: "challenge"`
 *   (never bypassed; opens the circuit breaker upstream).
 * - At least one of the three prices must be found, otherwise
 *   `CardmarketParseError` (structured logging detects Cardmarket HTML drift fast).
 */
export const parseCardmarketProductPage = (
  html: string,
  context: CardmarketPageContext,
): Effect.Effect<CardmarketProductPrices, CardmarketPageParseError> => {
  if (CHALLENGE_TITLE_PATTERN.test(html)) {
    return Effect.fail(
      new CardmarketBlockedError({
        status: "challenge",
        message: `anti-bot challenge page detected for card ${context.cardId} (${context.url})`,
      }),
    );
  }
  const trendCents = extractLabeledPrice(html, TREND_LABELS);
  const lowFrCents = extractLabeledPrice(html, LOW_LABELS);
  const avg30Cents = extractLabeledPrice(html, AVG30_LABELS);
  if (trendCents !== null || lowFrCents !== null || avg30Cents !== null) {
    return Effect.succeed({ trendCents, lowFrCents, avg30Cents });
  }
  if (isChallengePage(html)) {
    return Effect.fail(
      new CardmarketBlockedError({
        status: "challenge",
        message: `anti-bot challenge page detected for card ${context.cardId} (${context.url})`,
      }),
    );
  }
  return Effect.fail(
    new CardmarketParseError({
      cardId: context.cardId,
      url: context.url,
      message:
        "no usable price found on the Cardmarket product page (HTML structure may have changed)",
    }),
  );
};
