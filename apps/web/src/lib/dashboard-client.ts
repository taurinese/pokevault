/**
 * Client de l'écran `V2b · Accueil / Dashboard` : types du payload
 * `GET /api/dashboard`, helpers purs (fraîcheur, âge relatif, variation 30 j,
 * formatage `fr-FR`, état vide) et fetch typé vers `/api/dashboard`.
 *
 * Module CLIENT-SAFE : n'importe que des types / helpers purs de
 * `@pokevault/domain`, de `../i18n/index.ts` et de `./card-detail-client.ts`
 * (jamais `@pokevault/services`, `postgres` ni `node:*` — l'accès base vit
 * dans `dashboard-server.ts`, module serveur uniquement).
 */

import type { CardLanguage, CardVariant } from "@pokevault/domain";
import { DEFAULT_LOCALE } from "../i18n/index.ts";
import { type FetchLike, formatPriceCents } from "./card-detail-client.ts";

// ---------------------------------------------------------------------------
// Chemins
// ---------------------------------------------------------------------------

/** Route de l'écran d'accueil (protection SSR dans `routes/index.tsx`). */
export const DASHBOARD_PATH = "/";
export const DASHBOARD_API_PATH = "/api/dashboard";
export const ALERTS_PATH = "/alerts";

export { formatPriceCents };

// ---------------------------------------------------------------------------
// Payload `GET /api/dashboard`
// ---------------------------------------------------------------------------

/** Source du dernier prix connu (`price_snapshots.source`). */
export type DashboardPriceSource = "cardmarket" | "tcgdex_fallback";

/** Fraîcheur agrégée des prix Cardmarket (docs/04 §2.1 : 15 min / 6 h). */
export type DashboardFreshness = "fresh" | "aging" | "stale" | "missing";

/** Barre synthèse 1 ligne de l'écran d'accueil. */
export interface DashboardSummary {
  /** Somme `quantity * prix effectif` sur tous les exemplaires (centimes). */
  readonly totalValueCents: number;
  /** Variation 30 j réelle en pourcent (1 décimale) ; `null` sans base `avg30`. */
  readonly delta30dPercent: number | null;
  readonly globalFreshness: DashboardFreshness;
  /** Snapshot le plus ancien parmi les cartes valorisées (ISO 8601). */
  readonly priceFetchedAt: string | null;
  /** Somme des quantités (`SUM(quantity)`) des exemplaires possédés. */
  readonly ownedCardsCount: number;
  /** Complétion globale sur les classeurs d'extension suivis (0 si aucun). */
  readonly globalCompletionPercent: number;
}

/** Carte phare (top 3 des cartes possédées les plus valorisées). */
export interface DashboardFeaturedCard {
  readonly cardId: string;
  readonly name: string;
  readonly setCode: string | null;
  readonly setName: string;
  readonly localId: string;
  /** Base d'image TCGdex (sans suffixe) ; `null` : visuel de repli. */
  readonly imageUrl: string | null;
  readonly quantity: number;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  /** `coalesce(trend, low_fr, avg30)` en centimes ; `null` si aucun prix. */
  readonly unitPriceCents: number | null;
  readonly delta30dPercent: number | null;
  readonly priceSource: DashboardPriceSource | null;
  readonly priceFetchedAt: string | null;
  readonly priceExpiresAt: string | null;
}

/** Classeur récent (grandes cards « Mes classeurs », max 4). */
export interface DashboardBinder {
  readonly id: string;
  readonly title: string;
  readonly kind: "set" | "custom";
  readonly setCode: string | null;
  readonly coverType: "set_logo" | "card" | "upload";
  /** Logo officiel TCGdex de l'extension (`cover_type = 'set_logo'`). */
  readonly coverLogoUrl: string | null;
  /** Base d'image TCGdex de la carte de couverture (`cover_type = 'card'`). */
  readonly coverCardImageUrl: string | null;
  /** URL du proxy de cover uploadée (`cover_type = 'upload'`). */
  readonly coverCustomUrl: string | null;
  readonly ownedCount: number;
  readonly totalCards: number;
  readonly completionPercent: number;
  readonly estimatedValueCents: number;
  readonly isShared: boolean;
}

/** Dernière alerte prix déclenchée (tables M4, `null` si absentes ou vides). */
export interface DashboardAlert {
  readonly alertId: string;
  readonly cardId: string;
  readonly cardName: string;
  readonly triggeredPriceCents: number;
  readonly thresholdCents: number;
  readonly triggeredAt: string;
}

/** Réponse de `GET /api/dashboard`. */
export interface DashboardPayload {
  readonly summary: DashboardSummary;
  readonly featuredCards: ReadonlyArray<DashboardFeaturedCard>;
  readonly binders: ReadonlyArray<DashboardBinder>;
  readonly latestAlert: DashboardAlert | null;
}

/** `true` quand le tableau de bord n'a encore aucune donnée à valoriser. */
export const isDashboardEmpty = (payload: DashboardPayload): boolean =>
  payload.summary.ownedCardsCount === 0 &&
  payload.featuredCards.length === 0 &&
  payload.binders.length === 0;

// ---------------------------------------------------------------------------
// Helpers purs — fraîcheur & variation 30 j
// ---------------------------------------------------------------------------

/** Seuils de fraîcheur de docs/04 §2.1 : `< 15 min` / `15 min – 6 h` / `> 6 h`. */
export const FRESH_MAX_AGE_MS = 15 * 60 * 1000;
export const AGING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface PriceFreshnessInput {
  /** `false` quand aucune carte valorisée n'a de prix connu. */
  readonly hasPrice: boolean;
  readonly source: DashboardPriceSource | null;
  /** ISO 8601 du snapshot (le plus ancien si agrégé). */
  readonly fetchedAt: string | null;
}

/**
 * Fraîcheur d'un prix affiché :
 * - `missing` : aucun prix connu ;
 * - `stale` : repli TCGdex (indicatif), date illisible, ou prix de plus de 6 h ;
 * - `fresh` : source Cardmarket de moins de 15 min ;
 * - `aging` : source Cardmarket entre 15 min et 6 h.
 */
export const computePriceFreshness = (
  input: PriceFreshnessInput,
  nowMs: number,
): DashboardFreshness => {
  if (!input.hasPrice) return "missing";
  if (input.source !== "cardmarket" || input.fetchedAt === null) return "stale";
  const fetchedMs = Date.parse(input.fetchedAt);
  if (Number.isNaN(fetchedMs)) return "stale";
  const age = Math.max(0, nowMs - fetchedMs);
  if (age < FRESH_MAX_AGE_MS) return "fresh";
  if (age <= AGING_MAX_AGE_MS) return "aging";
  return "stale";
};

/**
 * Variation 30 j en pourcent à 1 décimale :
 * `Math.round(((current - avg30) / avg30) * 1000) / 10` ;
 * `null` si le prix courant ou la base `avg30_cents > 0` manque.
 */
export const computeDelta30dPercent = (
  currentCents: number | null,
  avg30Cents: number | null,
): number | null => {
  if (currentCents === null || avg30Cents === null || avg30Cents <= 0) return null;
  return Math.round(((currentCents - avg30Cents) / avg30Cents) * 1000) / 10;
};

// ---------------------------------------------------------------------------
// Helpers purs — âge relatif (docs/04 §2.1)
// ---------------------------------------------------------------------------

/** Âge relatif structuré d'un horodatage ISO (`À l'instant`, `il y a N min/h/j`). */
export type DashboardAge =
  | { readonly kind: "just_now" }
  | { readonly kind: "minutes"; readonly count: number }
  | { readonly kind: "hours"; readonly count: number }
  | { readonly kind: "days"; readonly count: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const computeRelativeAge = (iso: string | null, nowMs: number): DashboardAge | null => {
  if (iso === null) return null;
  const fetchedMs = Date.parse(iso);
  if (Number.isNaN(fetchedMs)) return null;
  const ageMs = Math.max(0, nowMs - fetchedMs);
  if (ageMs < MINUTE_MS) return { kind: "just_now" };
  if (ageMs < HOUR_MS) return { kind: "minutes", count: Math.floor(ageMs / MINUTE_MS) };
  if (ageMs < DAY_MS) return { kind: "hours", count: Math.floor(ageMs / HOUR_MS) };
  return { kind: "days", count: Math.floor(ageMs / DAY_MS) };
};

// ---------------------------------------------------------------------------
// Helpers purs — formatage fr-FR (chiffres en `tabular-nums` côté UI)
// ---------------------------------------------------------------------------

/**
 * Variation 30 j affichée (`+4,2 %` / `-1,3 %`) ; `null` si inconnue.
 * Le pourcentage est stocké en unités pourcent (4.2 = 4,2 %).
 */
export const formatDeltaPercent = (
  delta30dPercent: number | null,
  locale: string = DEFAULT_LOCALE,
): string | null => {
  if (delta30dPercent === null) return null;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(delta30dPercent / 100);
};

/** Compteur formaté `fr-FR` (`1248` → `1 248`). */
export const formatCount = (count: number, locale: string = DEFAULT_LOCALE): string =>
  new Intl.NumberFormat(locale).format(count);

/** Pourcentage entier formaté `fr-FR` (`58` → `58 %`, espace insécable fine). */
export const formatPercent = (percent: number, locale: string = DEFAULT_LOCALE): string =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    percent / 100,
  );

// ---------------------------------------------------------------------------
// Fetch typé
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export type DashboardFetchResult =
  | { readonly kind: "ok"; readonly payload: DashboardPayload }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error" };

/** `GET /api/dashboard` : 401 → `unauthorized`, 200 → payload, sinon `error`. */
export const fetchDashboard = async (
  signal?: AbortSignal,
  fetchImpl: FetchLike = defaultFetch,
): Promise<DashboardFetchResult> => {
  try {
    const response = await fetchImpl(DASHBOARD_API_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "error" };
    const body = (await response.json()) as Partial<DashboardPayload> | null;
    if (
      body === null ||
      typeof body !== "object" ||
      body.summary === undefined ||
      !Array.isArray(body.featuredCards) ||
      !Array.isArray(body.binders)
    ) {
      return { kind: "error" };
    }
    return { kind: "ok", payload: body as DashboardPayload };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "error" };
  }
};
