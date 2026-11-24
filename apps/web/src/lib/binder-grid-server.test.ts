import type { Sql } from "@pokevault/services";
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, type AuthConfig, REFRESH_TOKEN_COOKIE } from "./auth.ts";
import type { BinderGridPayload } from "./binder-grid-client.ts";
import { type BinderGridServerDeps, handleBinderGrid } from "./binder-grid-server.ts";

// ---------------------------------------------------------------------------
// Auth factice (même pattern que catalog-server.test.ts)
// ---------------------------------------------------------------------------

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const config: AuthConfig = {
  publicUrl: "http://localhost:54321",
  internalAuthBase: "http://auth:9999",
  anonKey: "anon-key",
  appUrl: "http://localhost:3000",
  isProduction: false,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const gotrueUser = {
  id: USER_A,
  email: "ada@pokevault.test",
  app_metadata: { provider: "google" },
};

/** GoTrue factice : `old` expiré, `fresh`/`valid` valides ; le refresh renvoie `fresh`. */
const gotrue = (url: string, init?: RequestInit): Response => {
  if (url.endsWith("/user")) {
    const bearer = new Headers(init?.headers).get("Authorization");
    return bearer === "Bearer fresh" || bearer === "Bearer valid"
      ? jsonResponse(gotrueUser)
      : jsonResponse({}, 401);
  }
  return jsonResponse({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 });
};

const request = (path: string, cookie?: string): Request =>
  new Request(`http://localhost:3000${path}`, cookie === undefined ? {} : { headers: { cookie } });
const signedIn = `${ACCESS_TOKEN_COOKIE}=valid`;

// ---------------------------------------------------------------------------
// Fausse base Postgres (même contrat que `postgres` : tag de template + begin)
// ---------------------------------------------------------------------------

const BINDER_SET = "aaaaaaaa-0000-4000-8000-000000000001";
const BINDER_CUSTOM = "aaaaaaaa-0000-4000-8000-000000000002";
const BINDER_OTHER_USER = "aaaaaaaa-0000-4000-8000-000000000003";

interface FakeDataset {
  readonly binders: ReadonlyArray<Record<string, unknown>>;
  readonly sets: ReadonlyArray<Record<string, unknown>>;
  readonly cards: ReadonlyArray<Record<string, unknown>>;
  readonly binderCards: ReadonlyArray<Record<string, unknown>>;
  readonly copies: ReadonlyArray<Record<string, unknown>>;
  /** Prix par défaut de chaque carte (lignes `card_id` + colonnes `price_*`). */
  readonly defaultPrices?: ReadonlyArray<Record<string, unknown>> | undefined;
}

const dataset: FakeDataset = {
  binders: [
    { id: BINDER_SET, user_id: USER_A, kind: "set", set_id: "sv03.5", title: "Prisme Évolutif" },
    {
      id: BINDER_CUSTOM,
      user_id: USER_A,
      kind: "custom",
      set_id: null,
      title: "Doublons d'échange",
    },
    {
      id: BINDER_OTHER_USER,
      user_id: USER_B,
      kind: "set",
      set_id: "sv03.5",
      title: "Classeur de B",
    },
  ],
  sets: [
    {
      id: "sv03.5",
      code: "SV03.5",
      name_fr: "Prismatic Evolutions",
      official_count: 2,
      total_count: 4,
    },
  ],
  cards: [
    {
      id: "sv03.5-4",
      set_id: "sv03.5",
      local_id: "4",
      local_id_numeric: 4,
      name_fr: "Salamèche",
      rarity: "Rare",
      types: ["Feu"],
      image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/4",
    },
    {
      id: "sv03.5-1",
      set_id: "sv03.5",
      local_id: "1",
      local_id_numeric: 1,
      name_fr: "Bulbizarre",
      rarity: "Commune",
      types: ["Plante"],
      image_base_url: "https://assets.tcgdex.net/fr/sv/sv03.5/1",
    },
    {
      id: "sv03.5-25",
      set_id: "sv03.5",
      local_id: "25",
      local_id_numeric: 25,
      name_fr: "Pikachu",
      rarity: "Commune",
      types: ["Électrik"],
      image_base_url: null,
    },
    {
      id: "sv03.5-TG01",
      set_id: "sv03.5",
      local_id: "TG01",
      local_id_numeric: null,
      name_fr: "Professeur",
      rarity: null,
      types: ["Dresseur"],
      image_base_url: null,
    },
    {
      id: "sv08-10",
      set_id: "sv08",
      local_id: "10",
      local_id_numeric: 10,
      name_fr: "Évoli",
      rarity: "Rare",
      types: ["Incolore"],
      image_base_url: null,
    },
  ],
  binderCards: [
    { binder_id: BINDER_CUSTOM, card_id: "sv08-10", position: 1, added_at: "2025-01-02T00:00:00Z" },
    {
      binder_id: BINDER_CUSTOM,
      card_id: "sv03.5-4",
      position: 0,
      added_at: "2025-01-01T00:00:00Z",
    },
  ],
  copies: [
    {
      id: "copy-1",
      user_id: USER_A,
      card_id: "sv03.5-4",
      language: "FR",
      variant: "normal",
      condition: "NM",
      quantity: 2,
      grading_company: null,
      grading_score: null,
      purchase_price_cents: 1500,
      notes: "secret note",
    },
    {
      id: "copy-2",
      user_id: USER_A,
      card_id: "sv03.5-4",
      language: "EN",
      variant: "holo",
      condition: "M",
      quantity: 1,
      grading_company: "PSA",
      grading_score: "10",
      purchase_price_cents: null,
      notes: null,
    },
    {
      id: "copy-3",
      user_id: USER_A,
      card_id: "sv03.5-1",
      language: "FR",
      variant: "normal",
      condition: "EX",
      quantity: 1,
      grading_company: null,
      grading_score: null,
      purchase_price_cents: null,
      notes: null,
    },
    // Exemplaires d'un AUTRE utilisateur sur la même carte : jamais comptés (isolation).
    {
      id: "copy-b1",
      user_id: USER_B,
      card_id: "sv03.5-4",
      language: "FR",
      variant: "normal",
      condition: "NM",
      quantity: 9,
      grading_company: null,
      grading_score: null,
      purchase_price_cents: null,
      notes: null,
    },
    {
      id: "copy-4",
      user_id: USER_A,
      card_id: "sv08-10",
      language: "JP",
      variant: "promo",
      condition: "NM",
      quantity: 2,
      grading_company: null,
      grading_score: null,
      purchase_price_cents: null,
      notes: null,
    },
  ],
};

type QueryHook = (text: string, values: ReadonlyArray<unknown>) => unknown;

/** Fausse `Sql` : tag de template + `begin` + appel tableau (`tx(ids)` → identité). */
const makeFakeSql = (ds: FakeDataset, onQuery?: QueryHook): Sql => {
  const run = (text: string, values: ReadonlyArray<unknown>): Promise<unknown> => {
    if (onQuery !== undefined) onQuery(text, values);
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("from public.binders") && text.includes("left join public.catalog_sets")) {
      const binderId = String(values[0]);
      const userId = String(values[1]);
      return Promise.resolve(
        ds.binders
          .filter((row) => row["id"] === binderId && row["user_id"] === userId)
          .map((row) => {
            const set = ds.sets.find((entry) => entry["id"] === row["set_id"]);
            return {
              ...row,
              set_code: set?.["code"] ?? null,
              set_name_fr: set?.["name_fr"] ?? null,
              set_official_count: set?.["official_count"] ?? null,
              set_total_count: set?.["total_count"] ?? null,
            };
          }),
      );
    }
    // Jointure latérale du prix par défaut des cartes (`tx(cardIds)` = tableau d'ids).
    if (text.includes("from public.card_latest_prices") && text.includes("catalog_cards c")) {
      const cardIds = new Set((values[0] as ReadonlyArray<string>).map(String));
      return Promise.resolve(
        (ds.defaultPrices ?? []).filter((row) => cardIds.has(String(row["card_id"]))),
      );
    }
    if (text.includes("public.binder_cards")) {
      const binderId = String(values[0]);
      return Promise.resolve(
        ds.binderCards
          .filter((row) => row["binder_id"] === binderId)
          .map(
            (row): Record<string, unknown> => ({
              ...row,
              card: ds.cards.find((card) => card["id"] === row["card_id"]),
            }),
          )
          .sort(
            (a, b) =>
              Number(a["position"]) - Number(b["position"]) ||
              String(a["added_at"]).localeCompare(String(b["added_at"])),
          )
          .map((row) => row["card"]),
      );
    }
    if (text.includes("from public.catalog_cards")) {
      const setId = String(values[0]);
      return Promise.resolve(
        ds.cards
          .filter((row) => row["set_id"] === setId)
          .sort(
            (a, b) =>
              (Number(a["local_id_numeric"]) || Number.POSITIVE_INFINITY) -
                (Number(b["local_id_numeric"]) || Number.POSITIVE_INFINITY) ||
              String(a["local_id"]).localeCompare(String(b["local_id"])),
          ),
      );
    }
    if (text.includes("from public.user_card_copies")) {
      const userId = String(values[0]);
      const cardIds = new Set((values[1] as ReadonlyArray<string>).map(String));
      return Promise.resolve(
        ds.copies.filter((row) => row["user_id"] === userId && cardIds.has(String(row["card_id"]))),
      );
    }
    return Promise.resolve([]);
  };
  const fake = (strings: unknown, ...values: ReadonlyArray<unknown>): unknown => {
    if (Array.isArray(strings) && "raw" in (strings as { raw?: unknown })) {
      return run((strings as unknown as TemplateStringsArray).join(" ? "), values);
    }
    // `tx(array)` : paramètre tableau (postgres.js) — identité pour le fake.
    return strings;
  };
  const sql = Object.assign(fake, {
    begin: (cb: (tx: unknown) => Promise<unknown>) => Promise.resolve(cb(sql)),
  });
  return sql as unknown as Sql;
};

const makeDeps = (
  sql: Sql | null,
  overrides: Partial<BinderGridServerDeps> = {},
): { deps: BinderGridServerDeps; log: ReturnType<typeof vi.fn> } => {
  const log = vi.fn();
  return {
    deps: {
      auth: { config, fetch: async (url, init) => gotrue(url, init) },
      sql,
      log,
      ...overrides,
    },
    log,
  };
};

// ---------------------------------------------------------------------------
// GET /api/binder-grid/$id
// ---------------------------------------------------------------------------

describe("GET /api/binder-grid/$id", () => {
  it("401 sans session, sans toucher la base", async () => {
    const queries: Array<string> = [];
    const { deps } = makeDeps(makeFakeSql(dataset, (text) => queries.push(text)));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_SET}`),
      BINDER_SET,
      deps,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(queries).toEqual([]);
  });

  it("401 avec un jeton invalide", async () => {
    const { deps } = makeDeps(makeFakeSql(dataset));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_SET}`, `${ACCESS_TOKEN_COOKIE}=expired`),
      BINDER_SET,
      deps,
    );
    expect(response.status).toBe(401);
  });

  it("404 si $id n'est pas un UUID", async () => {
    const queries: Array<string> = [];
    const { deps } = makeDeps(makeFakeSql(dataset, (text) => queries.push(text)));
    const response = await handleBinderGrid(
      request("/api/binder-grid/not-a-uuid", signedIn),
      "not-a-uuid",
      deps,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "binder_not_found" });
    expect(queries).toEqual([]);
  });

  it("404 si le classeur appartient à un autre utilisateur (isolation RLS)", async () => {
    const { deps } = makeDeps(makeFakeSql(dataset));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_OTHER_USER}`, signedIn),
      BINDER_OTHER_USER,
      deps,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404 si le classeur est inconnu", async () => {
    const unknown = "aaaaaaaa-0000-4000-8000-000000000099";
    const { deps } = makeDeps(makeFakeSql(dataset));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${unknown}`, signedIn),
      unknown,
      deps,
    );
    expect(response.status).toBe(404);
  });

  it("200 classeur `set` : cartes ordonnées, agrégation des exemplaires, stats computeSetCompletion", async () => {
    const { deps } = makeDeps(makeFakeSql(dataset));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_SET}`, signedIn),
      BINDER_SET,
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = (await response.json()) as BinderGridPayload;

    expect(payload.binder).toMatchObject({
      id: BINDER_SET,
      title: "Prisme Évolutif",
      kind: "set",
      setId: "sv03.5",
      setCode: "SV03.5",
      setNameFr: "Prismatic Evolutions",
      // computeSetCompletion({ official: 2, total: 4 }, copies) : 2 cartes possédées sur 4.
      stats: { cardCount: 4, ownedCount: 2, percent: 50, totalCopies: 4, duplicateCardCount: 1 },
    });

    // Ordre : local_id_numeric ASC NULLS LAST, puis local_id ASC.
    expect(payload.cards.map((card) => card.id)).toEqual([
      "sv03.5-1",
      "sv03.5-4",
      "sv03.5-25",
      "sv03.5-TG01",
    ]);

    const salameche = payload.cards.find((card) => card.id === "sv03.5-4");
    expect(salameche).toMatchObject({
      nameFr: "Salamèche",
      rarity: "Rare",
      types: ["Feu"],
      imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/4",
      inWishlist: false,
      // 2 (FR normal) + 1 (EN holo) = 3 ; les 9 exemplaires de USER_B sont exclus.
      totalQuantity: 3,
      languages: ["FR", "EN"],
      variants: ["normal", "holo"],
    });
    expect(salameche?.copies).toEqual([
      {
        id: "copy-1",
        language: "FR",
        variant: "normal",
        condition: "NM",
        quantity: 2,
        gradingCompany: null,
        gradingScore: null,
      },
      {
        id: "copy-2",
        language: "EN",
        variant: "holo",
        condition: "M",
        quantity: 1,
        gradingCompany: "PSA",
        gradingScore: "10",
      },
    ]);

    const bulbizarre = payload.cards.find((card) => card.id === "sv03.5-1");
    expect(bulbizarre).toMatchObject({ totalQuantity: 1, languages: ["FR"], variants: ["normal"] });
    const manquantes = payload.cards.filter((card) => card.totalQuantity === 0).map((c) => c.id);
    expect(manquantes).toEqual(["sv03.5-25", "sv03.5-TG01"]);

    // Aucun champ strictement privé (prix d'achat, notes) dans le payload.
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("purchase");
    expect(raw).not.toContain("secret note");
    expect(raw).not.toContain("copy-b1");
  });

  it("200 classeur `custom` : cartes du dossier par position, stats ownedCount/cardCount", async () => {
    const { deps } = makeDeps(makeFakeSql(dataset));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_CUSTOM}`, signedIn),
      BINDER_CUSTOM,
      deps,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as BinderGridPayload;
    expect(payload.binder).toMatchObject({
      id: BINDER_CUSTOM,
      title: "Doublons d'échange",
      kind: "custom",
      setId: null,
      setCode: null,
      // position 0 → sv03.5-4 (qty 3), position 1 → sv08-10 (qty 2) : 2 possédées sur 2.
      stats: { cardCount: 2, ownedCount: 2, percent: 100, totalCopies: 5, duplicateCardCount: 2 },
    });
    expect(payload.cards.map((card) => card.id)).toEqual(["sv03.5-4", "sv08-10"]);
    expect(payload.cards[1]).toMatchObject({
      totalQuantity: 2,
      languages: ["JP"],
      variants: ["promo"],
    });
  });

  it("propage les cookies rafraîchis (Set-Cookie) avec Cache-Control: no-store", async () => {
    const { deps } = makeDeps(makeFakeSql(dataset));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_SET}`, `${REFRESH_TOKEN_COOKIE}=old-refresh`),
      BINDER_SET,
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${ACCESS_TOKEN_COOKIE}=fresh`);
    expect(cookies[1]).toContain(`${REFRESH_TOKEN_COOKIE}=fresh-refresh`);
  });

  it("200 + payload vide documenté quand DATABASE_URL est absent (jamais de 500)", async () => {
    const { deps, log } = makeDeps(null);
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_SET}`, signedIn),
      BINDER_SET,
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ binder: null, cards: [] });
    expect(log).toHaveBeenCalledWith(
      "binderGrid.database_url_missing",
      expect.objectContaining({ operation: "binder-grid", binderId: BINDER_SET }),
    );
  });

  it("503 sans fuite du message SQL en cas d'échec Postgres", async () => {
    const failing = makeFakeSql(dataset, (text) => {
      if (text.includes("from public.catalog_cards")) {
        throw new Error("relation public.secret_table does not exist");
      }
    });
    const { deps, log } = makeDeps(failing);
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${BINDER_SET}`, signedIn),
      BINDER_SET,
      deps,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "binder_grid_unavailable" });
    expect(body).not.toContain("secret_table");
    expect(log).toHaveBeenCalledWith(
      "binderGrid.query_failed",
      expect.objectContaining({ operation: "binder-grid", binderId: BINDER_SET }),
    );
  });

  it("la transaction RLS pose les claims auth.uid() avant les requêtes (ordre des requêtes)", async () => {
    const queries: Array<string> = [];
    const { deps } = makeDeps(makeFakeSql(dataset, (text) => queries.push(text)));
    await handleBinderGrid(request(`/api/binder-grid/${BINDER_SET}`, signedIn), BINDER_SET, deps);
    expect(queries[0]).toContain("set_config");
    expect(queries.some((text) => text.includes("from public.binders"))).toBe(true);
    expect(queries.some((text) => text.includes("from public.user_card_copies"))).toBe(true);
    // Toutes les requêtes filtrent explicitement par user_id (défense en profondeur).
    const dataQueries = queries.filter(
      (text) => !text.includes("set_config") && text.includes(" ? "),
    );
    expect(dataQueries.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Prix : jointure latérale, prix par carte, valeur réelle du classeur
// ---------------------------------------------------------------------------

const priceColumns = (
  source: "cardmarket" | "tcgdex_fallback",
  trend: number | null,
  fetchedAt: string,
  extra: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  price_source: source,
  price_trend_cents: trend,
  price_low_fr_cents: null,
  price_avg30_cents: null,
  price_fetched_at: new Date(fetchedAt),
  price_expires_at: new Date(Date.parse(fetchedAt) + 15 * 60_000),
  ...extra,
});

const NO_PRICE = {
  price_source: null,
  price_trend_cents: null,
  price_low_fr_cents: null,
  price_avg30_cents: null,
  price_fetched_at: null,
  price_expires_at: null,
};

const priced: FakeDataset = {
  ...dataset,
  // Salamèche : copy-1 (FR normal ×2) a SON prix (2000), copy-2 (EN holo ×1) n'en a pas.
  copies: dataset.copies.map((row) => {
    if (row["id"] === "copy-1") {
      return { ...row, ...priceColumns("cardmarket", 2000, "2026-06-01T11:58:00.000Z") };
    }
    if (row["id"] === "copy-2") return { ...row, ...NO_PRICE };
    if (row["id"] === "copy-3") {
      // Bulbizarre : repli TCGdex indicatif.
      return { ...row, ...priceColumns("tcgdex_fallback", 150, "2026-06-01T08:00:00.000Z") };
    }
    return { ...row, ...NO_PRICE };
  }),
  defaultPrices: [
    { card_id: "sv03.5-4", ...priceColumns("cardmarket", 1900, "2026-06-01T11:00:00.000Z") },
    { card_id: "sv03.5-1", ...priceColumns("cardmarket", 120, "2026-06-01T10:00:00.000Z") },
    // Pikachu (non possédée) : prix par défaut ; Professeur : aucun snapshot.
    { card_id: "sv03.5-25", ...priceColumns("cardmarket", 500, "2026-06-01T11:59:00.000Z") },
    { card_id: "sv03.5-TG01", ...NO_PRICE },
  ],
};

describe("GET /api/binder-grid/$id — prix", () => {
  const load = async (
    ds: FakeDataset,
    binderId: string,
    onQuery?: QueryHook,
  ): Promise<BinderGridPayload> => {
    const { deps } = makeDeps(makeFakeSql(ds, onQuery));
    const response = await handleBinderGrid(
      request(`/api/binder-grid/${binderId}`, signedIn),
      binderId,
      deps,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as BinderGridPayload;
  };

  it("joint card_latest_prices en LEFT JOIN LATERAL … LIMIT 1 (copies et cartes)", async () => {
    const queries: Array<string> = [];
    await load(priced, BINDER_SET, (text) => queries.push(text));
    const lateral = queries.filter((text) => text.includes("from public.card_latest_prices"));
    expect(lateral).toHaveLength(2);
    for (const text of lateral) {
      expect(text).toContain("left join lateral");
      expect(text).toMatch(/limit 1\s*\) p on true/);
    }
    const copies = lateral.find((text) => text.includes("from public.user_card_copies")) ?? "";
    expect(copies).toContain("lp.language = c.language");
    expect(copies).toContain("lp.variant = c.variant");
    const cards = lateral.find((text) => !text.includes("from public.user_card_copies")) ?? "";
    expect(cards).toContain("lp.language = 'FR' and lp.variant = 'normal'");
    // Le filtre user_id reste explicite sur les exemplaires.
    expect(copies).toContain("c.user_id =");
  });

  it("expose le prix de l'exemplaire possédé (prioritaire) sinon le prix par défaut de la carte", async () => {
    const payload = await load(priced, BINDER_SET);
    const byId = new Map(payload.cards.map((card) => [card.id, card] as const));
    // Salamèche : le prix de la copie FR normal (2000) prime sur le défaut (1900).
    expect(byId.get("sv03.5-4")?.price).toEqual({
      trendCents: 2000,
      lowFrCents: null,
      avg30Cents: null,
      source: "cardmarket",
      fetchedAt: "2026-06-01T11:58:00.000Z",
      expiresAt: "2026-06-01T12:13:00.000Z",
    });
    // Bulbizarre : le repli TCGdex de la copie possédée est exposé tel quel.
    expect(byId.get("sv03.5-1")?.price?.source).toBe("tcgdex_fallback");
    // Pikachu (manquante) : prix par défaut ; Professeur : aucun snapshot → null.
    expect(byId.get("sv03.5-25")?.price?.trendCents).toBe(500);
    expect(byId.get("sv03.5-TG01")?.price).toBeNull();
  });

  it("calcule la valeur réelle du classeur : Σ quantité × prix de l'exemplaire (repli prix de la carte)", async () => {
    const payload = await load(priced, BINDER_SET);
    // copy-1 : 2 × 2000 = 4000 ; copy-2 (EN holo, sans snapshot) : repli 1 × 1900 = 1900 ;
    // copy-3 (Bulbizarre) : 1 × 150 = 150 ; USER_B exclu ; cartes manquantes non comptées.
    expect(payload.binder?.stats.totalValueCents).toBe(4000 + 1900 + 150);
  });

  it("valeur du classeur custom : exemplaires de ses seules cartes", async () => {
    const payload = await load(
      {
        ...priced,
        defaultPrices: [
          ...(priced.defaultPrices ?? []),
          { card_id: "sv08-10", ...priceColumns("cardmarket", 700, "2026-06-01T11:00:00.000Z") },
        ],
      },
      BINDER_CUSTOM,
    );
    // sv03.5-4 : 4000 + 1900 ; sv08-10 (JP promo ×2, sans prix exact) : repli 2 × 700.
    expect(payload.binder?.stats.totalValueCents).toBe(4000 + 1900 + 1400);
  });

  it("totalValueCents est null et price null quand aucun snapshot n'existe (jamais 0 trompeur)", async () => {
    const payload = await load(dataset, BINDER_SET);
    expect(payload.binder?.stats.totalValueCents).toBeNull();
    expect(payload.cards.every((card) => card.price === null)).toBe(true);
  });

  it("n'expose jamais le prix d'achat privé avec les prix de marché", async () => {
    const raw = JSON.stringify(await load(priced, BINDER_SET));
    expect(raw).not.toContain("purchase");
    expect(raw).not.toContain("secret note");
  });
});
