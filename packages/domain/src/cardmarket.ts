import { Schema } from "effect";
import {
  CardCondition,
  CardId,
  CardLanguage,
  CardVariant,
  MAX_CARD_COPY_QUANTITY,
} from "./card.ts";
import { CARD_VARIANT_ORDER, parseLocalIdNumeric } from "./catalog.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Header of the Cardmarket CSV export, aligned with docs/04-integrations.md §2.2:
 * `qty,name,set_code,number,language,min_condition,foil_only`.
 */
export const CARDMARKET_CSV_HEADERS = [
  "qty",
  "name",
  "set_code",
  "number",
  "language",
  "min_condition",
  "foil_only",
] as const;

/**
 * Cardmarket display name for each supported `CardLanguage`.
 *
 * Note: the CSV `language` column keeps the ISO code (`FR` / `EN` / `JP` / `ZH`)
 * as expected by the Cardmarket import; this mapping only exposes the human /
 * Cardmarket-facing name of each language (useful for previews and docs).
 */
export const CARDMARKET_LANGUAGE_NAMES: Readonly<Record<CardLanguage, string>> = {
  FR: "French",
  EN: "English",
  JP: "Japanese",
  ZH: "S-Chinese",
};

/**
 * Canonical order of card conditions, from best (`M`) to worst (`PO`).
 * Used by the `minCondition` export filter: an entry is kept when its own
 * `minCondition` is at least as good as (rank <=) the filter value.
 */
export const CARD_CONDITION_ORDER: ReadonlyArray<CardCondition> = [
  "M",
  "NM",
  "EX",
  "GD",
  "LP",
  "PL",
  "PO",
];

// ---------------------------------------------------------------------------
// Schemas (aligned with docs/02-modele-des-donnees.md & docs/04 §2.2)
// ---------------------------------------------------------------------------

/** Selectable export perimeter for the `06C` Export Cardmarket bottom sheet. */
export const CardmarketExportScope = Schema.Literals([
  "all",
  "below_threshold",
  "high_priority",
  "set",
]);
export type CardmarketExportScope = typeof CardmarketExportScope.Type;

/** `wishlist_items.priority` CHECK: `normal | high`. */
export const CardmarketPriority = Schema.Literals(["normal", "high"]);
export type CardmarketPriority = typeof CardmarketPriority.Type;

/**
 * One wishlist row enriched with its catalog & price data, ready to export.
 *
 * Pure data structure (client-safe): it carries everything the `06C` screen
 * needs to render a preview line and both export formats need to build a row.
 */
export const CardmarketExportEntry = Schema.Struct({
  cardId: CardId,
  localId: Schema.NonEmptyString,
  nameFr: Schema.String,
  nameEn: Schema.NullOr(Schema.String),
  setId: Schema.NonEmptyString,
  setCode: Schema.NullOr(Schema.String),
  cardmarketSetCode: Schema.NullOr(Schema.String),
  setNameFr: Schema.String,
  language: CardLanguage,
  variant: CardVariant,
  minCondition: CardCondition,
  priority: CardmarketPriority,
  targetPriceCents: Schema.NullOr(Schema.Int),
  currentPriceCents: Schema.optional(Schema.NullOr(Schema.Int)),
  quantity: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type CardmarketExportEntry = typeof CardmarketExportEntry.Type;

/** Language filter of the export: a single `CardLanguage` or `"ALL"`. */
export const CardmarketExportLanguageFilter = Schema.Literals(["FR", "EN", "JP", "ZH", "ALL"]);
export type CardmarketExportLanguageFilter = typeof CardmarketExportLanguageFilter.Type;

/**
 * Filters applied before generating either export format (screen `06C`).
 *
 * - `scope` (default `"all"`): export perimeter. `"set"` additionally uses
 *   `setId`; when `scope === "set"` but no `setId` is provided, no set
 *   restriction is applied (behaves like `"all"`).
 * - `minCondition`: **filters** entries — only entries whose own `minCondition`
 *   is at least as good as (rank <=) this value are kept (see
 *   {@link CARD_CONDITION_ORDER}). It does NOT change the exported value.
 * - `minConditionOverride`: **imposes** this condition as the `min_condition`
 *   column of every exported CSV row, regardless of each entry's own value.
 *   When both are set, `minCondition` filters first, then the override is
 *   written to the CSV.
 * - `language`: keeps only entries in this language; `"ALL"` (or undefined)
 *   keeps every language.
 * - `foilOnly`: when `true`, keeps only foil variants (see
 *   {@link isFoilVariant}). This is a row filter only — the per-row `foil_only`
 *   CSV column is always derived from the entry's own `variant`.
 */
export const CardmarketExportFilters = Schema.Struct({
  scope: Schema.optional(CardmarketExportScope),
  setId: Schema.optional(Schema.NonEmptyString),
  minCondition: Schema.optional(CardCondition),
  minConditionOverride: Schema.optional(CardCondition),
  language: Schema.optional(CardmarketExportLanguageFilter),
  foilOnly: Schema.optional(Schema.Boolean),
});
export type CardmarketExportFilters = typeof CardmarketExportFilters.Type;

/** Non-blocking warning emitted alongside an export (previewed in `06C`). */
export const MissingCardmarketCodeWarning = Schema.Struct({
  kind: Schema.Literal("missing_cardmarket_code"),
  setId: Schema.NonEmptyString,
  setNameFr: Schema.String,
  fallbackCode: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type MissingCardmarketCodeWarning = typeof MissingCardmarketCodeWarning.Type;

export const MissingEnglishNameWarning = Schema.Struct({
  kind: Schema.Literal("missing_english_name"),
  cardId: CardId,
  nameFr: Schema.String,
});
export type MissingEnglishNameWarning = typeof MissingEnglishNameWarning.Type;

export const CardmarketExportWarning = Schema.Union([
  MissingCardmarketCodeWarning,
  MissingEnglishNameWarning,
]);
export type CardmarketExportWarning = typeof CardmarketExportWarning.Type;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of {@link generateCardmarketCsv}. */
export interface CardmarketExportResult {
  /** Full CSV file content (UTF-8, RFC 4180, `\r\n` line endings). */
  readonly content: string;
  /** Number of data rows (header excluded). */
  readonly rowCount: number;
  /** Suggested download filename, e.g. `wants-cardmarket-2025-01-31.csv`. */
  readonly filename: string;
  readonly warnings: ReadonlyArray<CardmarketExportWarning>;
}

/** Result of {@link generateCardmarketAddCardList}. */
export interface CardmarketAddCardListResult {
  /** Plain-text content, one card per line (`\n` separated, trailing `\n`). */
  readonly content: string;
  /** Number of card lines. */
  readonly lineCount: number;
  readonly warnings: ReadonlyArray<CardmarketExportWarning>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `true` for every foil variant (`variant !== "normal"`). */
export const isFoilVariant = (variant: CardVariant): boolean => variant !== "normal";

/** Rank of a condition in {@link CARD_CONDITION_ORDER} (0 = best, `M`). */
export const cardConditionRank = (condition: CardCondition): number =>
  CARD_CONDITION_ORDER.indexOf(condition);

const nonBlank = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * Normalizes a card quantity before export: only strictly positive safe
 * integers are kept (clamped to `MAX_CARD_COPY_QUANTITY`); any invalid value
 * (`undefined`, `0`, negative, non-integer, `NaN`, `Infinity`) falls back to `1`.
 */
export const normalizeCardmarketQuantity = (quantity: number | undefined): number =>
  quantity !== undefined && Number.isSafeInteger(quantity) && quantity > 0
    ? Math.min(quantity, MAX_CARD_COPY_QUANTITY)
    : 1;

/** Exported card name: non-blank English name when available, French name otherwise. */
export const cardmarketEntryName = (entry: CardmarketExportEntry): string =>
  nonBlank(entry.nameEn) ?? entry.nameFr;

/**
 * Exported `set_code`: non-blank `cardmarketSetCode` (`catalog_sets.cardmarket_code`)
 * first, then the displayed `setCode` (e.g. `EV3.5`), then `setId` as last
 * resort.
 */
export const cardmarketEntrySetCode = (entry: CardmarketExportEntry): string =>
  nonBlank(entry.cardmarketSetCode) ?? nonBlank(entry.setCode) ?? entry.setId;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic, strictly transitive total order used by
 * {@link filterCardmarketEntries}:
 * exported `set_code`, then numeric `localId` before non-numeric `localId`
 * (lexicographic key `(num === null ? 1 : 0, num ?? 0, localId)`), then
 * `language`, then `variant` (canonical {@link CARD_VARIANT_ORDER}), then name,
 * then `cardId`.
 */
const compareEntries = (a: CardmarketExportEntry, b: CardmarketExportEntry): number => {
  const bySetCode = compareStrings(cardmarketEntrySetCode(a), cardmarketEntrySetCode(b));
  if (bySetCode !== 0) return bySetCode;
  const numA = parseLocalIdNumeric(a.localId);
  const numB = parseLocalIdNumeric(b.localId);
  const rankA = numA === null ? 1 : 0;
  const rankB = numB === null ? 1 : 0;
  if (rankA !== rankB) return rankA - rankB;
  if (numA !== null && numB !== null && numA !== numB) return numA - numB;
  const byLocalId = compareStrings(a.localId, b.localId);
  if (byLocalId !== 0) return byLocalId;
  const byLanguage = compareStrings(a.language, b.language);
  if (byLanguage !== 0) return byLanguage;
  const byVariant = CARD_VARIANT_ORDER.indexOf(a.variant) - CARD_VARIANT_ORDER.indexOf(b.variant);
  if (byVariant !== 0) return byVariant;
  const byName = compareStrings(cardmarketEntryName(a), cardmarketEntryName(b));
  if (byName !== 0) return byName;
  return compareStrings(a.cardId, b.cardId);
};

/**
 * Applies {@link CardmarketExportFilters} to raw entries and returns a
 * deterministically sorted copy (see {@link compareEntries}). The input array
 * is never mutated.
 */
export const filterCardmarketEntries = (
  entries: ReadonlyArray<CardmarketExportEntry>,
  filters?: CardmarketExportFilters | undefined,
): ReadonlyArray<CardmarketExportEntry> => {
  const scope = filters?.scope ?? "all";
  const kept = entries.filter((entry) => {
    switch (scope) {
      case "below_threshold":
        // `targetPriceCents !== null && currentPriceCents !== null && current <= target`
        if (entry.targetPriceCents === null) return false;
        if (entry.currentPriceCents === null || entry.currentPriceCents === undefined) {
          return false;
        }
        if (entry.currentPriceCents > entry.targetPriceCents) return false;
        break;
      case "high_priority":
        if (entry.priority !== "high") return false;
        break;
      case "set":
        if (filters?.setId !== undefined && entry.setId !== filters.setId) return false;
        break;
      case "all":
        break;
    }
    if (
      filters?.language !== undefined &&
      filters.language !== "ALL" &&
      entry.language !== filters.language
    ) {
      return false;
    }
    if (
      filters?.minCondition !== undefined &&
      cardConditionRank(entry.minCondition) > cardConditionRank(filters.minCondition)
    ) {
      return false;
    }
    if (filters?.foilOnly === true && !isFoilVariant(entry.variant)) return false;
    return true;
  });
  return [...kept].sort(compareEntries);
};

/**
 * Collects the non-blocking warnings for a (already filtered) entry list:
 * one aggregated `missing_cardmarket_code` per set without
 * `cardmarketSetCode` (with `count` = number of affected entries and
 * `fallbackCode` = the code actually exported), and one
 * `missing_english_name` per card without `nameEn`.
 */
export const collectCardmarketWarnings = (
  entries: ReadonlyArray<CardmarketExportEntry>,
): ReadonlyArray<CardmarketExportWarning> => {
  type MutableCodeWarning = {
    kind: "missing_cardmarket_code";
    setId: string;
    setNameFr: string;
    fallbackCode: string;
    count: number;
  };
  const codeWarnings: MutableCodeWarning[] = [];
  const codeWarningIndexBySetId = new Map<string, number>();
  const nameWarnings: MissingEnglishNameWarning[] = [];
  const seenCardIds = new Set<string>();
  for (const entry of entries) {
    if (nonBlank(entry.cardmarketSetCode) === null) {
      const index = codeWarningIndexBySetId.get(entry.setId);
      if (index === undefined) {
        codeWarningIndexBySetId.set(entry.setId, codeWarnings.length);
        codeWarnings.push({
          kind: "missing_cardmarket_code",
          setId: entry.setId,
          setNameFr: entry.setNameFr,
          fallbackCode: nonBlank(entry.setCode) ?? entry.setId,
          count: 1,
        });
      } else {
        const warning = codeWarnings[index];
        if (warning !== undefined) warning.count += 1;
      }
    }
    if (nonBlank(entry.nameEn) === null && !seenCardIds.has(entry.cardId)) {
      seenCardIds.add(entry.cardId);
      nameWarnings.push({
        kind: "missing_english_name",
        cardId: entry.cardId,
        nameFr: entry.nameFr,
      });
    }
  }
  return [...codeWarnings, ...nameWarnings];
};

// ---------------------------------------------------------------------------
// CSV export (RFC 4180 + formula-injection hardening)
// ---------------------------------------------------------------------------

/** Characters that force RFC 4180 quoting of a CSV field. */
const CSV_SPECIAL_CHARS = /[",\r\n]/;

/**
 * Leading characters interpreted as formulas by Excel / LibreOffice, including
 * when preceded by leading whitespace / NBSP (stripped by some spreadsheet
 * importers).
 */
const CSV_FORMULA_PREFIX = /^[\s\u00A0]*[=+@-]|^[\t\r]/;

/**
 * Neutralizes CSV formula injection (Excel / LibreOffice): a field starting
 * with `=`, `+`, `-`, `@` (optionally preceded by whitespace) or `\t`/`\r` is
 * prefixed with an apostrophe `'` so spreadsheet apps treat it as text.
 *
 * Trade-off: the leading `'` remains in raw CSV data if a card name ever
 * started with `-` or `+` (negligible for Pokémon TCG names). Positive numbers
 * (`qty`, `number`) are left untouched.
 */
export const sanitizeCsvCell = (value: string): string =>
  CSV_FORMULA_PREFIX.test(value) ? `'${value}` : value;

/**
 * Escapes one CSV field per RFC 4180: the value is first hardened against
 * formula injection (see {@link sanitizeCsvCell}), then wrapped in `"..."`
 * with inner `"` doubled when it contains `,`, `"`, `\r` or `\n`.
 */
export const escapeCsvField = (value: string): string => {
  const sanitized = sanitizeCsvCell(value);
  if (!CSV_SPECIAL_CHARS.test(sanitized)) return sanitized;
  return `"${sanitized.replace(/"/g, '""')}"`;
};

/**
 * Builds the download filename `wants-cardmarket-YYYY-MM-DD.csv`.
 * The date is rendered in **UTC** so the result is deterministic and
 * identical on every client for a given instant.
 */
export const buildCardmarketCsvFilename = (date: Date = new Date()): string => {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `wants-cardmarket-${year}-${month}-${day}.csv`;
};

/**
 * Generates the Cardmarket CSV export (docs/04 §2.2):
 *
 * - header `qty,name,set_code,number,language,min_condition,foil_only` always present;
 * - `name` = `nameEn ?? nameFr` (blank `nameEn` falls back to `nameFr`),
 *   `set_code` = `cardmarketSetCode ?? setCode ?? setId`,
 *   `number` = `localId`, `language` = ISO code, `foil_only` = `true`/`false`
 *   from the entry's own variant;
 * - `min_condition` = `filters.minConditionOverride ?? entry.minCondition`;
 * - `qty` = normalized positive integer (`normalizeCardmarketQuantity`);
 * - `now` (optional, default `new Date()`): UTC date used for `filename` so
 *   callers and tests get a 100 % deterministic output when passing a `Date`;
 * - every field goes through {@link escapeCsvField}; lines are `\r\n`-terminated
 *   (RFC 4180, including the last row — no trailing empty line beyond the final CRLF).
 */
export const generateCardmarketCsv = (
  entries: ReadonlyArray<CardmarketExportEntry>,
  filters?: CardmarketExportFilters | undefined,
  now: Date = new Date(),
): CardmarketExportResult => {
  const filtered = filterCardmarketEntries(entries, filters);
  const warnings = collectCardmarketWarnings(filtered);
  const header = CARDMARKET_CSV_HEADERS.map(escapeCsvField).join(",");
  const rows = filtered.map((entry) => {
    const fields = [
      String(normalizeCardmarketQuantity(entry.quantity)),
      cardmarketEntryName(entry),
      cardmarketEntrySetCode(entry),
      entry.localId,
      entry.language,
      filters?.minConditionOverride ?? entry.minCondition,
      isFoilVariant(entry.variant) ? "true" : "false",
    ];
    return fields.map(escapeCsvField).join(",");
  });
  const content = [header, ...rows].map((line) => `${line}\r\n`).join("");
  return {
    content,
    rowCount: filtered.length,
    filename: buildCardmarketCsvFilename(now),
    warnings,
  };
};

// ---------------------------------------------------------------------------
// « Add Card List » text export (Cardmarket Wants List / Shopping Wizard)
// ---------------------------------------------------------------------------

/**
 * Collapses all Unicode control characters (`\p{Cc}`, incl. `\r`, `\n`, `\t`,
 * `\v`, `\f`, `\u0085`) plus line/paragraph separators (`\u2028`, `\u2029`)
 * into single spaces and trims so every exported card stays strictly on 1 line.
 */
const sanitizeAddCardListToken = (value: string): string =>
  value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();

/**
 * Generates the plain-text « Add Card List » export (docs/04 §2.2), directly
 * paste-able into Cardmarket's Wants List / Shopping Wizard:
 *
 * - one card per line: `${qty} ${name} (${setCode} ${localId})` when a non-empty
 *   sanitized set code is available (`cardmarketSetCode ?? setCode`), otherwise
 *   `${qty} ${name} (${localId})` (a `missing_cardmarket_code` warning is emitted);
 * - `name`, `setCode`, and `localId` are sanitized via {@link sanitizeAddCardListToken}
 *   so no control character or line separator can ever break the 1-card-per-line rule;
 * - entries that produce the exact same line are aggregated by summing their
 *   normalized quantities (note: because Cardmarket's plain-text Add Card List
 *   format does not encode language or variant, two entries differing only by
 *   language/variant merge into a single line);
 * - lines are `\n`-separated with a single trailing `\n` (empty export → `""`).
 */
export const generateCardmarketAddCardList = (
  entries: ReadonlyArray<CardmarketExportEntry>,
  filters?: CardmarketExportFilters | undefined,
): CardmarketAddCardListResult => {
  const filtered = filterCardmarketEntries(entries, filters);
  const warnings = collectCardmarketWarnings(filtered);
  const quantitiesByLine = new Map<string, number>();
  const lineOrder: string[] = [];
  for (const entry of filtered) {
    const name = sanitizeAddCardListToken(cardmarketEntryName(entry));
    const localId = sanitizeAddCardListToken(entry.localId);
    const rawSetCode = nonBlank(entry.cardmarketSetCode) ?? nonBlank(entry.setCode);
    const setCode = rawSetCode === null ? null : nonBlank(sanitizeAddCardListToken(rawSetCode));
    const key = setCode === null ? `${name} (${localId})` : `${name} (${setCode} ${localId})`;
    const quantity = normalizeCardmarketQuantity(entry.quantity);
    const previous = quantitiesByLine.get(key);
    if (previous === undefined) {
      lineOrder.push(key);
      quantitiesByLine.set(key, quantity);
    } else {
      quantitiesByLine.set(key, previous + quantity);
    }
  }
  const lines = lineOrder.map((key) => `${quantitiesByLine.get(key) ?? 1} ${key}`);
  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return { content, lineCount: lines.length, warnings };
};
