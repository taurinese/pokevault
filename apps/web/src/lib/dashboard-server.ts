/**
 * Accès serveur de l'écran `V2b · Accueil / Dashboard` : handler
 * `Request → Response` de la route `GET /api/dashboard`.
 *
 * ⚠️ Module SERVEUR UNIQUEMENT : il importe `@pokevault/services` (donc
 * `postgres` / `node:*`). Il ne doit être importé que par la route
 * `routes/api/dashboard.ts` (handler `server`, retiré du bundle client) —
 * jamais par un composant ou un module client (le client passe par
 * `dashboard-client.ts`).
 *
 * Sécurité : session SSR obligatoire (`getServerSession`, 401 sinon, cookies
 * rafraîchis propagés via `Set-Cookie` + `Cache-Control: no-store` sur TOUTES
 * les réponses). Requêtes dans la transaction `withUserRls` (pool
 * `role: "authenticated"`, `auth.uid() = user_id`) avec filtre explicite
 * `user_id = ${userId}` sur toutes les tables privées. Sans `DATABASE_URL` :
 * payload vide documenté (`emptyDashboardPayload()`) en HTTP 200, jamais 500.
 * Erreur SQL → 503 sans aucun détail. Garde-fou `to_regclass` sur les tables
 * M4 (`price_alerts`, `alert_events`, `share_links`) absentes tant que M4
 * n'est pas déployée. Réf. : docs/01 §3, docs/02, docs/06 §1–§2.
 */

import { type CardLanguage, type CardVariant, computePercent } from "@pokevault/domain";
import { Database, DatabaseLive, type Sql, withUserRls } from "@pokevault/services";
import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { type AuthDeps, defaultAuthDeps, getServerSession } from "./auth-server.ts";
import {
  computeDelta30dPercent,
  computePriceFreshness,
  type DashboardAlert,
  type DashboardBinder,
  type DashboardFeaturedCard,
  type DashboardPayload,
  type DashboardPriceSource,
  type DashboardSummary,
} from "./dashboard-client.ts";

// ---------------------------------------------------------------------------
// Dépendances injectables
// ---------------------------------------------------------------------------

export type DashboardLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface DashboardServerDeps {
  readonly auth: AuthDeps;
  /**
   * Pool SQL, ou `null` quand aucune base n'est configurée (`DATABASE_URL`
   * absent en dev/test) : la route répond alors 200 + payload vide.
   */
  readonly services: { readonly sql: Sql } | null;
  readonly log: DashboardLogger;
}

/** Log structuré JSON (une ligne par évènement) sur la sortie d'erreur. */
export const logWarning: DashboardLogger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`);
};

// ---------------------------------------------------------------------------
// Pool Postgres live, mis en cache sur globalThis (pattern `wishlist-server.ts`)
// ---------------------------------------------------------------------------

type LiveServices = NonNullable<DashboardServerDeps["services"]>;

interface LiveRuntimeEntry {
  readonly url: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<Database, never>;
  readonly services: Promise<LiveServices>;
}

const GLOBAL_RUNTIME_KEY = "__pokevaultDashboardRuntime" as const;

const readCachedRuntime = (): LiveRuntimeEntry | undefined =>
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] as LiveRuntimeEntry | undefined;

const writeCachedRuntime = (entry: LiveRuntimeEntry | undefined): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_RUNTIME_KEY] = entry;
};

/**
 * Pool `postgres.js` paresseux (`role: "authenticated"` : RLS à moindre
 * privilège, max 5 connexions), mis en cache sur `globalThis` pour survivre au
 * HMR Vite sans fuir de pools ; une promesse rejetée est immédiatement purgée
 * du cache et le runtime éliminé.
 */
const getLiveServices = (databaseUrl: string): Promise<LiveServices> => {
  const existing = readCachedRuntime();
  if (existing !== undefined && existing.url === databaseUrl) return existing.services;
  if (existing !== undefined) {
    void existing.runtime.dispose();
    writeCachedRuntime(undefined);
  }
  const layer = DatabaseLive({
    connectionString: databaseUrl,
    maxConnections: 5,
    role: "authenticated",
  });
  const runtime = ManagedRuntime.make(layer);
  const services = runtime
    .runPromise(
      Effect.gen(function* () {
        const { sql } = yield* Database;
        return { sql };
      }),
    )
    .catch((error: unknown) => {
      if (readCachedRuntime()?.runtime === runtime) writeCachedRuntime(undefined);
      void runtime.dispose();
      throw error;
    });
  writeCachedRuntime({ url: databaseUrl, runtime, services });
  return services;
};

/** Dépendances de production : session GoTrue + Postgres (`DATABASE_URL`). */
export const defaultDashboardDeps = async (): Promise<DashboardServerDeps> => {
  const auth = defaultAuthDeps();
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  return {
    auth,
    services:
      databaseUrl === undefined || databaseUrl === "" ? null : await getLiveServices(databaseUrl),
    log: logWarning,
  };
};

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------

const json = (body: unknown, status: number, cookies: ReadonlyArray<string> = []): Response => {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
};

const unauthorized = (): Response => json({ error: "unauthorized" }, 401);

const unavailable = (cookies: ReadonlyArray<string>): Response =>
  json({ error: "dashboard_unavailable" }, 503, cookies);

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

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

/** postgres.js renvoie les `bigint` (count, sum) en `number | string | bigint`. */
const toInt = (value: number | string | bigint | null | undefined): number => Number(value ?? 0);

// ---------------------------------------------------------------------------
// Payload vide (sans DATABASE_URL) — jamais de 500
// ---------------------------------------------------------------------------

/** Payload documenté renvoyé en HTTP 200 quand aucune base n'est configurée. */
export const emptyDashboardPayload = (): DashboardPayload => ({
  summary: {
    totalValueCents: 0,
    delta30dPercent: null,
    globalFreshness: "missing",
    priceFetchedAt: null,
    ownedCardsCount: 0,
    globalCompletionPercent: 0,
  },
  featuredCards: [],
  binders: [],
  latestAlert: null,
});

// ---------------------------------------------------------------------------
// Lignes SQL
// ---------------------------------------------------------------------------

interface GuardRow {
  readonly has_alerts: boolean;
  readonly has_share_links: boolean;
}

interface SummaryRow {
  readonly owned_cards_count: number | string | bigint;
  readonly total_value_cents: number | string | bigint;
  readonly sum_current_cents: number | string | bigint;
  readonly sum_avg30_cents: number | string | bigint;
  readonly priced_cards_count: number | string | bigint;
  readonly oldest_price_fetched_at: Date | string | null;
  readonly oldest_price_expires_at?: Date | string | null | undefined;
  readonly has_fallback_price: boolean | null;
}

interface FeaturedRow {
  readonly card_id: string;
  readonly name: string;
  readonly local_id: string;
  readonly image_base_url: string | null;
  readonly set_code: string | null;
  readonly set_name: string;
  readonly language: CardLanguage;
  readonly variant: CardVariant;
  readonly quantity: number | string | bigint;
  readonly effective_price_cents: number | null;
  readonly spot_price_cents?: number | null | undefined;
  readonly avg30_cents: number | null;
  readonly price_source: DashboardPriceSource | null;
  readonly price_fetched_at: Date | string | null;
  readonly price_expires_at: Date | string | null;
}

interface BinderRow {
  readonly id: string;
  readonly title: string;
  readonly kind: "set" | "custom";
  readonly cover_type: "set_logo" | "card" | "upload";
  readonly updated_at: Date | string;
  readonly set_code: string | null;
  readonly cover_logo_url: string | null;
  readonly cover_card_image_base_url: string | null;
}

interface SetAggregateRow {
  readonly binder_id: string;
  readonly owned_count: number | string | bigint;
  readonly total_count: number | string | bigint;
  readonly value_cents: number | string | bigint;
}

interface CustomAggregateRow {
  readonly binder_id: string;
  readonly card_count: number | string | bigint;
  readonly owned_count: number | string | bigint;
  readonly value_cents: number | string | bigint;
}

interface SharedBinderRow {
  readonly binder_id: string;
}

interface AlertRow {
  readonly alert_id: string;
  readonly card_id: string;
  readonly card_name: string;
  readonly observed_price_cents: number | string | bigint;
  readonly threshold_cents: number | string | bigint;
  readonly triggered_at: Date | string;
}

// ---------------------------------------------------------------------------
// Requêtes (toutes les jointures prix passent par LEFT JOIN LATERAL … LIMIT 1)
// ---------------------------------------------------------------------------

/**
 * Garde-fou M4 : `price_alerts` / `alert_events` / `share_links` n'existent pas
 * tant que la migration M4 n'est pas déployée — `to_regclass` évite toute
 * erreur « relation does not exist ».
 */
const queryGuard = (tx: Sql): Promise<GuardRow[]> =>
  tx<GuardRow[]>`
    select to_regclass('public.alert_events') is not null
           and to_regclass('public.price_alerts') is not null as has_alerts,
           to_regclass('public.share_links') is not null as has_share_links`;

/**
 * Synthèse : valeur totale, base 30 j, fraîcheur globale et compteur
 * d'exemplaires. Le prix effectif d'un exemplaire est
 * `coalesce(trend_cents, low_fr_cents, avg30_cents)` du dernier snapshot du
 * slot `(card_id, language, variant)` (LATERAL `LIMIT 1` → pushdown sur
 * `idx_price_snapshots_lookup`).
 */
const querySummary = (tx: Sql, userId: string): Promise<SummaryRow[]> =>
  tx<SummaryRow[]>`
    select coalesce(sum(c.quantity), 0)::bigint as owned_cards_count,
           coalesce(sum(c.quantity * coalesce(lp.trend_cents, lp.low_fr_cents, lp.avg30_cents)), 0)::bigint as total_value_cents,
           coalesce(sum(c.quantity * coalesce(lp.trend_cents, lp.low_fr_cents))
             filter (where coalesce(lp.trend_cents, lp.low_fr_cents) is not null and lp.avg30_cents is not null and lp.avg30_cents > 0), 0)::bigint as sum_current_cents,
           coalesce(sum(c.quantity * lp.avg30_cents)
             filter (where coalesce(lp.trend_cents, lp.low_fr_cents) is not null and lp.avg30_cents is not null and lp.avg30_cents > 0), 0)::bigint as sum_avg30_cents,
           count(*) filter (where lp.trend_cents is not null or lp.low_fr_cents is not null or lp.avg30_cents is not null)::bigint as priced_cards_count,
           min(lp.fetched_at) filter (where lp.trend_cents is not null or lp.low_fr_cents is not null or lp.avg30_cents is not null) as oldest_price_fetched_at,
           min(lp.expires_at) filter (where lp.trend_cents is not null or lp.low_fr_cents is not null or lp.avg30_cents is not null) as oldest_price_expires_at,
           bool_or(lp.source <> 'cardmarket') filter (where lp.trend_cents is not null or lp.low_fr_cents is not null or lp.avg30_cents is not null) as has_fallback_price
      from public.user_card_copies c
      left join lateral (
        select lp.trend_cents, lp.low_fr_cents, lp.avg30_cents, lp.source, lp.fetched_at, lp.expires_at
          from public.card_latest_prices lp
         where lp.card_id = c.card_id and lp.language = c.language and lp.variant = c.variant
         limit 1
      ) lp on true
     where c.user_id = ${userId}`;

/**
 * Cartes phares : top 3 des cartes possédées les plus valorisées, groupées par
 * `(card_id, language, variant)`, ordonnées par prix effectif `DESC NULLS
 * LAST`, quantité `DESC`, puis `card_id ASC`.
 */
const queryFeatured = (tx: Sql, userId: string): Promise<FeaturedRow[]> =>
  tx<FeaturedRow[]>`
    select c.card_id,
           cc.name_fr as name,
           cc.local_id,
           cc.image_base_url,
           s.code as set_code,
           s.name_fr as set_name,
           c.language,
           c.variant,
           sum(c.quantity)::bigint as quantity,
           coalesce(lp.trend_cents, lp.low_fr_cents, lp.avg30_cents) as effective_price_cents,
           coalesce(lp.trend_cents, lp.low_fr_cents) as spot_price_cents,
           lp.avg30_cents,
           lp.source as price_source,
           lp.fetched_at as price_fetched_at,
           lp.expires_at as price_expires_at
      from public.user_card_copies c
      join public.catalog_cards cc on cc.id = c.card_id
      join public.catalog_sets s on s.id = cc.set_id
      left join lateral (
        select lp.trend_cents, lp.low_fr_cents, lp.avg30_cents, lp.source, lp.fetched_at, lp.expires_at
          from public.card_latest_prices lp
         where lp.card_id = c.card_id and lp.language = c.language and lp.variant = c.variant
         limit 1
      ) lp on true
     where c.user_id = ${userId}
     group by c.card_id, c.language, c.variant, cc.name_fr, cc.local_id, cc.image_base_url,
              s.code, s.name_fr, lp.trend_cents, lp.low_fr_cents, lp.avg30_cents,
              lp.source, lp.fetched_at, lp.expires_at
     order by effective_price_cents desc nulls last, quantity desc, c.card_id asc
     limit 3`;

/** Classeurs récemment mis à jour (max 4) + métadonnées cover / extension. */
const queryBinders = (tx: Sql, userId: string): Promise<BinderRow[]> =>
  tx<BinderRow[]>`
    select b.id, b.title, b.kind, b.cover_type, b.updated_at,
           s.code as set_code,
           s.logo_url as cover_logo_url,
           cc.image_base_url as cover_card_image_base_url
      from public.binders b
      left join public.catalog_sets s on s.id = b.set_id
      left join public.catalog_cards cc on cc.id = b.cover_card_id
     where b.user_id = ${userId}
     order by b.updated_at desc, b.created_at desc
     limit 4`;

/** Agrégats (possédées distinctes, total, valeur estimée) de TOUS les classeurs d'extension. */
const querySetAggregates = (tx: Sql, userId: string): Promise<SetAggregateRow[]> =>
  tx<SetAggregateRow[]>`
    select b.id as binder_id,
           count(distinct c.card_id)::bigint as owned_count,
           s.total_count::bigint as total_count,
           coalesce(sum(c.quantity * coalesce(lp.trend_cents, lp.low_fr_cents, lp.avg30_cents)), 0)::bigint as value_cents
      from public.binders b
      join public.catalog_sets s on s.id = b.set_id
      left join public.catalog_cards cc on cc.set_id = b.set_id
      left join public.user_card_copies c on c.card_id = cc.id and c.user_id = ${userId}
      left join lateral (
        select lp.trend_cents, lp.low_fr_cents, lp.avg30_cents
          from public.card_latest_prices lp
         where lp.card_id = c.card_id and lp.language = c.language and lp.variant = c.variant
         limit 1
      ) lp on true
     where b.user_id = ${userId} and b.kind = 'set'
     group by b.id, s.total_count`;

/** Agrégats des dossiers perso (cartes du dossier, possédées, valeur estimée). */
const queryCustomAggregates = (tx: Sql, userId: string): Promise<CustomAggregateRow[]> =>
  tx<CustomAggregateRow[]>`
    select b.id as binder_id,
           count(distinct bc.card_id)::bigint as card_count,
           count(distinct c.card_id)::bigint as owned_count,
           coalesce(sum(c.quantity * coalesce(lp.trend_cents, lp.low_fr_cents, lp.avg30_cents)), 0)::bigint as value_cents
      from public.binders b
      join public.binder_cards bc on bc.binder_id = b.id
      left join public.user_card_copies c on c.card_id = bc.card_id and c.user_id = ${userId}
      left join lateral (
        select lp.trend_cents, lp.low_fr_cents, lp.avg30_cents
          from public.card_latest_prices lp
         where lp.card_id = c.card_id and lp.language = c.language and lp.variant = c.variant
         limit 1
      ) lp on true
     where b.user_id = ${userId} and b.kind = 'custom'
     group by b.id`;

/** Classeurs actuellement partagés (lien actif non révoqué) — table M4. */
const querySharedBinderIds = (tx: Sql, userId: string): Promise<SharedBinderRow[]> =>
  tx<SharedBinderRow[]>`
    select binder_id
      from public.share_links
     where user_id = ${userId} and is_active and revoked_at is null`;

/** Alerte déclenchée la plus récente (tables M4). */
const queryLatestAlert = (tx: Sql, userId: string): Promise<AlertRow[]> =>
  tx<AlertRow[]>`
    select e.alert_id,
           pa.card_id,
           coalesce(cc.name_fr, pa.card_id) as card_name,
           e.observed_price_cents,
           e.threshold_cents,
           e.triggered_at
      from public.alert_events e
      join public.price_alerts pa on pa.id = e.alert_id
      left join public.catalog_cards cc on cc.id = pa.card_id
     where e.user_id = ${userId}
     order by e.triggered_at desc, e.id desc
     limit 1`;

// ---------------------------------------------------------------------------
// Assemblage du payload
// ---------------------------------------------------------------------------

const toSummary = (row: SummaryRow | undefined, nowMs: number): DashboardSummary => {
  const sumCurrent = toInt(row?.sum_current_cents);
  const sumAvg30 = toInt(row?.sum_avg30_cents);
  const pricedCount = toInt(row?.priced_cards_count);
  const priceFetchedAt = isoOrNull(row?.oldest_price_fetched_at ?? null);
  const priceExpiresAt = isoOrNull(row?.oldest_price_expires_at ?? null);
  return {
    totalValueCents: toInt(row?.total_value_cents),
    delta30dPercent: computeDelta30dPercent(sumCurrent, sumAvg30),
    globalFreshness: computePriceFreshness(
      {
        hasPrice: pricedCount > 0,
        source: row?.has_fallback_price === true ? "tcgdex_fallback" : "cardmarket",
        fetchedAt: priceFetchedAt,
        expiresAt: priceExpiresAt,
      },
      nowMs,
    ),
    priceFetchedAt,
    ownedCardsCount: toInt(row?.owned_cards_count),
    globalCompletionPercent: 0, // renseigné par l'appelant (agrégats classeurs)
  };
};

const toFeaturedCard = (row: FeaturedRow): DashboardFeaturedCard => {
  const unitPriceCents =
    row.effective_price_cents === null ? null : Number(row.effective_price_cents);
  // Exige trend ou low_fr pour calculer une variation réelle (un prix issu
  // uniquement d'avg30 produirait autrement un faux « 0,0 % »).
  const spotPriceCents =
    row.spot_price_cents === undefined
      ? unitPriceCents
      : row.spot_price_cents === null
        ? null
        : Number(row.spot_price_cents);
  return {
    cardId: row.card_id,
    name: row.name,
    setCode: row.set_code,
    setName: row.set_name,
    localId: row.local_id,
    imageUrl: row.image_base_url,
    quantity: toInt(row.quantity),
    language: row.language,
    variant: row.variant,
    unitPriceCents,
    delta30dPercent: computeDelta30dPercent(spotPriceCents, row.avg30_cents),
    priceSource: row.price_source,
    priceFetchedAt: isoOrNull(row.price_fetched_at),
    priceExpiresAt: isoOrNull(row.price_expires_at),
  };
};

const toBinder = (
  row: BinderRow,
  setAgg: SetAggregateRow | undefined,
  customAgg: CustomAggregateRow | undefined,
  sharedBinderIds: ReadonlySet<string>,
): DashboardBinder => {
  const isSet = row.kind === "set";
  const ownedCount = toInt(isSet ? setAgg?.owned_count : customAgg?.owned_count);
  const totalCards = toInt(isSet ? setAgg?.total_count : customAgg?.card_count);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    setCode: isSet ? row.set_code : null,
    coverType: row.cover_type,
    coverLogoUrl: row.cover_logo_url,
    coverCardImageUrl: row.cover_card_image_base_url,
    coverCustomUrl:
      row.cover_type === "upload"
        ? `/api/binders/${row.id}/cover?v=${encodeURIComponent(iso(row.updated_at))}`
        : null,
    ownedCount,
    totalCards,
    completionPercent: computePercent(ownedCount, totalCards),
    estimatedValueCents: toInt(isSet ? setAgg?.value_cents : customAgg?.value_cents),
    isShared: sharedBinderIds.has(row.id),
  };
};

const toAlert = (row: AlertRow): DashboardAlert => ({
  alertId: row.alert_id,
  cardId: row.card_id,
  cardName: row.card_name,
  triggeredPriceCents: toInt(row.observed_price_cents),
  thresholdCents: toInt(row.threshold_cents),
  triggeredAt: iso(row.triggered_at),
});

/**
 * Charge tout le payload dans la transaction RLS (requêtes séquentielles : la
 * transaction tient UNE connexion du pool). Filtre explicite `user_id` sur
 * chaque table privée, en plus de la RLS.
 */
const loadDashboard = async (tx: Sql, userId: string): Promise<DashboardPayload> => {
  const nowMs = Date.now();
  const guardRows = await queryGuard(tx);
  const guard = guardRows[0] ?? { has_alerts: false, has_share_links: false };

  const summaryRows = await querySummary(tx, userId);
  const featuredRows = await queryFeatured(tx, userId);
  const binderRows = await queryBinders(tx, userId);
  const setRows = await querySetAggregates(tx, userId);
  const customRows = await queryCustomAggregates(tx, userId);
  const sharedRows = guard.has_share_links ? await querySharedBinderIds(tx, userId) : [];
  const alertRows = guard.has_alerts ? await queryLatestAlert(tx, userId) : [];

  const sharedBinderIds = new Set(sharedRows.map((row) => row.binder_id));
  const setAggById = new Map(setRows.map((row) => [row.binder_id, row]));
  const customAggById = new Map(customRows.map((row) => [row.binder_id, row]));

  const summary = toSummary(summaryRows[0], nowMs);
  // Complétion globale sur les classeurs d'extension suivis (0 si aucun).
  const trackedOwned = setRows.reduce((sum, row) => sum + toInt(row.owned_count), 0);
  const trackedTotal = setRows.reduce((sum, row) => sum + toInt(row.total_count), 0);

  const firstAlert = alertRows[0];
  return {
    summary: { ...summary, globalCompletionPercent: computePercent(trackedOwned, trackedTotal) },
    featuredCards: featuredRows.map(toFeaturedCard),
    binders: binderRows.map((row) =>
      toBinder(row, setAggById.get(row.id), customAggById.get(row.id), sharedBinderIds),
    ),
    latestAlert: firstAlert === undefined ? null : toAlert(firstAlert),
  };
};

// ---------------------------------------------------------------------------
// GET /api/dashboard
// ---------------------------------------------------------------------------

/**
 * Handler `GET /api/dashboard` : 401 sans session ; 200 + payload
 * (`Cache-Control: no-store`, cookies rafraîchis propagés) ; 200 + payload vide
 * sans `DATABASE_URL` ; 503 sans détail SQL sur erreur.
 */
export const handleGetDashboard = async (
  request: Request,
  deps: DashboardServerDeps,
): Promise<Response> => {
  const session = await getServerSession(request, deps.auth);
  if (session === null) return unauthorized();
  const cookies = session.refreshedCookies ?? [];
  const userId = session.user.id;

  if (deps.services === null) {
    deps.log("dashboard.database_url_missing", {
      operation: "get",
      hint: "DATABASE_URL is not set: serving an empty dashboard payload",
    });
    return json(emptyDashboardPayload(), 200, cookies);
  }
  const exit = await Effect.runPromiseExit(
    withUserRls(deps.services.sql, userId, (tx) => loadDashboard(tx, userId)),
  );
  if (Exit.isFailure(exit)) {
    deps.log("dashboard.query_failed", { operation: "get", ...extractErrorMeta(exit.cause) });
    return unavailable(cookies);
  }
  return json(exit.value, 200, cookies);
};
