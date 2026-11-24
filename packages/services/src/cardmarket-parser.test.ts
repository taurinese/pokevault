import { CardmarketBlockedError, CardmarketParseError } from "@pokevault/domain";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  findFirstPriceCents,
  isChallengePage,
  parseCardmarketProductPage,
  parseEuroAmountToCents,
} from "./cardmarket-parser.ts";

const CTX = { cardId: "sv10-094", url: "https://www.cardmarket.com/fr/Pokemon/Products/Singles/x" };

const run = (html: string) => Effect.runSync(Effect.exit(parseCardmarketProductPage(html, CTX)));

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrNull(Cause.findErrorOption(exit.cause)) : null;

// ---------------------------------------------------------------------------
// Fixtures HTML réalistes
// ---------------------------------------------------------------------------

/** Page produit FR complète (table d'infos + tendance). */
const FIXTURE_FR_FULL = `<!DOCTYPE html>
<html lang="fr">
<head><title>Pikachu ex 238/131 — Carte Pokémon — Cardmarket</title></head>
<body>
<main>
  <h1>Pikachu ex 238/131</h1>
  <div class="row">
    <div class="col-md-6">
      <table class="table table-striped info-table">
        <tbody>
          <tr>
            <td><strong>Tendance des prix</strong></td>
            <td class="text-right"><span class="price">124,90&nbsp;&euro;</span></td>
          </tr>
          <tr>
            <td><strong>À partir de</strong></td>
            <td class="text-right"><span class="price-tag">1.250,50&nbsp;€</span></td>
          </tr>
          <tr>
            <td><strong>Prix moyen 30 jours</strong></td>
            <td class="text-right">98,00&nbsp;€</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</main>
</body>
</html>`;

/** Page produit EN complète (montants avant le symbole €). */
const FIXTURE_EN_FULL = `<!DOCTYPE html>
<html lang="en">
<head><title>Charizard ex 199/165 - Pokemon Card - Cardmarket</title></head>
<body>
<main>
  <h1>Charizard ex 199/165</h1>
  <dl class="price-info">
    <dt>Price Trend</dt>
    <dd><span class="price">€1,250.50</span></dd>
    <dt>From</dt>
    <dd>12.90 €</dd>
    <dt>30-days average price</dt>
    <dd>98.00 EUR</dd>
  </dl>
</main>
</body>
</html>`;

/** Page partielle : seule la tendance est renseignée, le reste est N/A. */
const FIXTURE_PARTIAL = `<!DOCTYPE html>
<html lang="en">
<head><title>Card - Cardmarket</title></head>
<body>
  <table class="table">
    <tr><td>Price Trend</td><td><span class="price">7,49&nbsp;€</span></td></tr>
    <tr><td>From</td><td>N/A</td></tr>
    <tr><td>30-days average price</td><td>N/A</td></tr>
  </table>
</body>
</html>`;

/** Page de challenge anti-bot Cloudflare / Turnstile. */
const FIXTURE_CHALLENGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Attention Required! | Cloudflare</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
  <h1>Just a moment...</h1>
  <div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div>
  <div id="challenge-platform"></div>
</body>
</html>`;

/** Page cassée : aucun prix exploitable. */
const FIXTURE_BROKEN = `<!DOCTYPE html>
<html lang="fr">
<head><title>Erreur - Cardmarket</title></head>
<body>
  <h1>Cette page n'existe pas</h1>
  <p>Le produit demandé est indisponible.</p>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseEuroAmountToCents", () => {
  it.each([
    ["124,90", 12490],
    ["1.250,50", 125050],
    ["98,00", 9800],
    ["12.90", 1290],
    ["1,250.50", 125050],
    ["98.00", 9800],
    ["1.250", 125000],
    ["1,250", 125000],
    ["12.5", 1250],
    ["7", 700],
    ["1 250,50", 125050],
    ["1.234.567,89", 123456789],
    ["0,01", 1],
  ])("parses %s → %d cents", (raw, expected) => {
    expect(parseEuroAmountToCents(raw)).toBe(expected);
  });

  it.each([
    ["abc"],
    [""],
    ["-5,00"],
    ["12,9,0"],
    ["NaN"],
    ["1,2,3,4,5,6,7"],
    ["21.474.836,48"], // exceeds Postgres int4 max (2_147_483_647)
  ])("rejects %s", (raw) => {
    expect(parseEuroAmountToCents(raw)).toBeNull();
  });

  it("accepts Postgres int4 maximum (21.474.836,47 €)", () => {
    expect(parseEuroAmountToCents("21.474.836,47")).toBe(2_147_483_647);
  });
});

describe("findFirstPriceCents", () => {
  it("finds amounts after or before the € symbol and rejects negative prices", () => {
    expect(findFirstPriceCents("124,90 €")).toBe(12490);
    expect(findFirstPriceCents("€1,250.50")).toBe(125050);
    expect(findFirstPriceCents("98.00 EUR")).toBe(9800);
    expect(findFirstPriceCents("-5,00 €")).toBeNull();
    expect(findFirstPriceCents("-€12.90")).toBeNull();
    expect(findFirstPriceCents("€-12.90")).toBeNull();
    expect(findFirstPriceCents("−5,00 €")).toBeNull();
    expect(findFirstPriceCents("Variation -5,00 € · 12,00 €")).toBe(1200);
    expect(findFirstPriceCents("N/A")).toBeNull();
    expect(findFirstPriceCents("")).toBeNull();
  });
});

describe("isChallengePage", () => {
  it("detects Cloudflare / Turnstile / captcha pages", () => {
    expect(isChallengePage(FIXTURE_CHALLENGE)).toBe(true);
    expect(isChallengePage("<html><head><title>Just a moment...</title></head></html>")).toBe(true);
    expect(isChallengePage('<div class="cf-turnstile" data-sitekey="x"></div>')).toBe(true);
    expect(isChallengePage("<title>Checking your browser</title>")).toBe(true);
  });

  it("does not flag a normal product page", () => {
    expect(isChallengePage(FIXTURE_FR_FULL)).toBe(false);
    expect(isChallengePage(FIXTURE_EN_FULL)).toBe(false);
  });
});

describe("parseCardmarketProductPage", () => {
  it("parses a full FR product page (Tendance / À partir de / Prix moyen 30 jours)", () => {
    const result = run(FIXTURE_FR_FULL);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual({ trendCents: 12490, lowFrCents: 125050, avg30Cents: 9800 });
    }
  });

  it("parses a full EN product page (Price Trend / From / 30-days average price)", () => {
    const result = run(FIXTURE_EN_FULL);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual({ trendCents: 125050, lowFrCents: 1290, avg30Cents: 9800 });
    }
  });

  it("parses a partial page (only Price Trend, others N/A)", () => {
    const result = run(FIXTURE_PARTIAL);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual({ trendCents: 749, lowFrCents: null, avg30Cents: null });
    }
  });

  it("detects an anti-bot challenge page and never tries to bypass it", () => {
    const result = run(FIXTURE_CHALLENGE);
    expect(Exit.isFailure(result)).toBe(true);
    const error = failureOf(result);
    expect(error).toBeInstanceOf(CardmarketBlockedError);
    expect((error as CardmarketBlockedError).status).toBe("challenge");
  });

  it("fails with CardmarketParseError when no price is usable", () => {
    const result = run(FIXTURE_BROKEN);
    expect(Exit.isFailure(result)).toBe(true);
    const error = failureOf(result);
    expect(error).toBeInstanceOf(CardmarketParseError);
    expect((error as CardmarketParseError).cardId).toBe(CTX.cardId);
    expect((error as CardmarketParseError).url).toBe(CTX.url);
  });

  it("tolerates HTML entities, extra whitespace and messy separators", () => {
    const messy = `<table><tr><td>Tendance des prix</td>
      <td><span>  1&nbsp;250,50&nbsp;&euro; </span></td></tr></table>`;
    const result = run(messy);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.trendCents).toBe(125050);
    }
  });

  it("parses a valid product page that includes Cloudflare telemetry scripts or unrelated data-sitekey", () => {
    const withCfTelemetry = `<!DOCTYPE html>
<html lang="fr">
<head>
  <title>Pikachu ex 238/131 — Cardmarket</title>
  <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
</head>
<body>
  <div data-sitekey="0x4-newsletter"></div>
  <table>
    <tr><td>Tendance des prix</td><td>124,90&nbsp;€</td></tr>
    <tr><td>À partir de</td><td>110,00&nbsp;€</td></tr>
    <tr><td>Prix moyen 30 jours</td><td>119,50&nbsp;€</td></tr>
  </table>
</body>
</html>`;
    expect(isChallengePage(withCfTelemetry)).toBe(false);
    const result = run(withCfTelemetry);
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual({ trendCents: 12490, lowFrCents: 11000, avg30Cents: 11950 });
    }
  });
});
