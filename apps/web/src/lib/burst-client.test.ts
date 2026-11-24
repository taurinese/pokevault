import type { BurstImportBatchInput } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  addToBurstSession,
  appendBurstNumberChar,
  type BurstAddInput,
  type BurstCatalogCard,
  type BurstSessionState,
  type BurstSetOption,
  type BurstSetupConfig,
  backspaceBurstNumber,
  buildBurstCommitPayload,
  burstBatchQuantity,
  burstCardStatus,
  burstKeypadKeyAction,
  burstOwnedByCard,
  burstRecentLines,
  burstRemainingCapacity,
  burstVariantChoices,
  canUndoBurstSession,
  clearBurstSession,
  commitBurstImport,
  DEFAULT_BURST_SETUP,
  decrementBurstCard,
  decrementBurstLine,
  emptyBurstSession,
  fetchBurstSetCards,
  fetchBurstSets,
  filterBurstCards,
  filterBurstSets,
  MAX_BURST_NUMBER_LENGTH,
  MAX_BURST_UNDO,
  matchBurstCardNumber,
  normalizeBurstText,
  parseBurstSearchParams,
  previewBurstImport,
  resolveBurstVariantForCard,
  serializeBurstSearchParams,
  summarizeBurstSession,
  undoBurstSession,
} from "./burst-client.ts";

const set = (overrides: Partial<BurstSetOption> = {}): BurstSetOption => ({
  id: "sv03.5",
  code: "MEV",
  nameFr: "Évolution à Méga-Éclat",
  seriesNameFr: "Écarlate & Violet",
  logoUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
  officialCount: 198,
  totalCount: 207,
  releaseDate: "2024-01-19",
  ...overrides,
});

const sets = (): ReadonlyArray<BurstSetOption> => [
  set(),
  set({ id: "swsh12", code: "PAF", nameFr: "Défaite Parlante", seriesNameFr: "Épée & Bouclier" }),
  set({ id: "xy7", code: null, nameFr: "Origines Antiques", seriesNameFr: "XY", logoUrl: null }),
];

describe("normalizeBurstText", () => {
  it("supprime accents et casse", () => {
    expect(normalizeBurstText("Évolution à Méga-Éclat")).toBe("evolution a mega-eclat");
  });
});

describe("filterBurstSets (recherche locale insensible aux accents)", () => {
  it("retourne la liste complète sans requête", () => {
    expect(filterBurstSets(sets(), "  ")).toHaveLength(3);
  });

  it("filtre sur nameFr insensible aux accents et à la casse", () => {
    expect(filterBurstSets(sets(), "evolution a mega")).toHaveLength(1);
    expect(filterBurstSets(sets(), "DEFAITE")).toHaveLength(1); // Épée & Bouclier
  });

  it("filtre sur le code (insensible à la casse) et sur la série", () => {
    expect(filterBurstSets(sets(), "paf").map((s) => s.id)).toEqual(["swsh12"]);
    expect(filterBurstSets(sets(), "epee").map((s) => s.id)).toEqual(["swsh12"]); // Épée
  });

  it("filtre sur l'identifiant TCGdex", () => {
    expect(filterBurstSets(sets(), "sv03.5").map((s) => s.id)).toEqual(["sv03.5"]);
  });

  it("retourne une liste vide quand rien ne correspond", () => {
    expect(filterBurstSets(sets(), "zzzz")).toEqual([]);
  });
});

describe("parseBurstSearchParams", () => {
  it("pré-sélectionne l'extension via ?setId=", () => {
    expect(parseBurstSearchParams({ setId: "sv03.5" })).toEqual({ setId: "sv03.5" });
  });

  it("ignore les valeurs vides, non-chaînes et inconnues", () => {
    expect(parseBurstSearchParams({})).toEqual({});
    expect(parseBurstSearchParams({ setId: "" })).toEqual({});
    expect(parseBurstSearchParams({ setId: 42 })).toEqual({});
    expect(parseBurstSearchParams({ language: "XX" })).toEqual({});
    expect(parseBurstSearchParams({ mode: "grid", variant: "holo" })).toEqual({
      mode: "grid",
      variant: "holo",
    });
  });

  it("parse la config complète (round-trip avec serializeBurstSearchParams)", () => {
    const config: BurstSetupConfig = {
      setId: "sv03.5",
      language: "ZH" as never,
      variant: "holo",
      condition: "EX",
      removeFromWishlist: false,
      mode: "keypad",
    };
    const roundTrip = parseBurstSearchParams(
      Object.fromEntries(serializeBurstSearchParams(config).entries()),
    );
    expect(roundTrip).toEqual(config);
  });
});

describe("serializeBurstSearchParams", () => {
  it("applique la config par défaut et sérialise tous les champs", () => {
    const config: BurstSetupConfig = { setId: "sv03.5", ...DEFAULT_BURST_SETUP };
    const params = serializeBurstSearchParams(config);
    expect(params.get("setId")).toBe("sv03.5");
    expect(params.get("language")).toBe("FR");
    expect(params.get("variant")).toBe("normal");
    expect(params.get("condition")).toBe("NM");
    expect(params.get("removeFromWishlist")).toBe("1");
    expect(params.get("mode")).toBe("grid");
  });
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("fetchBurstSets", () => {
  it("GET en same-origin avec options et décode le payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sets: [set()], warning: "database_not_configured" }),
    );
    const result = await fetchBurstSets(undefined, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/burst/sets", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    expect(result).toEqual({
      kind: "ok",
      data: { sets: [set()], warning: "database_not_configured" },
    });
  });

  it.each([
    [401, { kind: "unauthorized" }],
    [403, { kind: "error" }],
    [500, { kind: "error" }],
  ])("mappe %s sur %j", async (status, expected) => {
    const result = await fetchBurstSets(undefined, async () => jsonResponse({}, status));
    expect(result).toEqual(expected);
  });

  it("relève l'AbortError sans le convertir en erreur", async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.reject(new DOMException("aborted", "AbortError"));
    await expect(fetchBurstSets(undefined, fetchImpl)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("previewBurstImport / commitBurstImport", () => {
  const payload: BurstImportBatchInput = {
    defaults: {
      setId: "sv03.5",
      language: "FR",
      variant: "normal",
      condition: "NM",
      removeFromWishlist: true,
    },
    items: [{ cardId: "sv03.5-199", quantity: 2 }],
  };
  const report = {
    totalAddedQuantity: 2,
    distinctCardsCount: 1,
    newCardsCount: 1,
    duplicateCardsCount: 0,
    wishlistRemovedCount: 0,
    adjustedVariantsCount: 0,
    items: [],
  };

  it.each([
    ["POST", "/api/burst/preview", previewBurstImport],
    ["POST", "/api/burst/commit", commitBurstImport],
  ])("%s %s envoie le corps JSON en same-origin", async (_method, url, action) => {
    const fetchImpl = vi.fn(async () => jsonResponse(report));
    const result = await action(payload, undefined, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify(payload),
      }),
    );
    expect(result).toEqual({ kind: "ok", data: report });
  });

  it("retourne error pour un 409 / 404 / 500 (jamais lancé)", async () => {
    expect(await commitBurstImport(payload, undefined, async () => jsonResponse({}, 409))).toEqual({
      kind: "error",
    });
    expect(await commitBurstImport(payload, undefined, async () => jsonResponse({}, 404))).toEqual({
      kind: "error",
    });
    expect(await commitBurstImport(payload, undefined, async () => jsonResponse({}, 401))).toEqual({
      kind: "unauthorized",
    });
  });
});

// ---------------------------------------------------------------------------
// Catalogue d'une extension
// ---------------------------------------------------------------------------

const card = (overrides: Partial<BurstCatalogCard> = {}): BurstCatalogCard => ({
  id: "sv03.5-25",
  localId: "025",
  localIdNumeric: 25,
  nameFr: "Pikachu",
  rarity: "Commune",
  imageBaseUrl: "https://assets.tcgdex.net/fr/sv/sv03.5/025",
  availableVariants: ["normal", "reverse"],
  holoEffect: "none",
  ownedQuantity: 0,
  ...overrides,
});

const catalog = (): ReadonlyArray<BurstCatalogCard> => [
  card({
    id: "sv03.5-1",
    localId: "001",
    localIdNumeric: 1,
    nameFr: "Bulbizarre",
    ownedQuantity: 2,
  }),
  card({ id: "sv03.5-25", localId: "025", localIdNumeric: 25, nameFr: "Pikachu" }),
  card({
    id: "sv03.5-100",
    localId: "100",
    localIdNumeric: 100,
    nameFr: "Évoli",
    availableVariants: ["holo"],
    holoEffect: "holo",
  }),
  card({
    id: "sv03.5-SV001",
    localId: "SV001",
    localIdNumeric: 1,
    nameFr: "Promo Mew",
    availableVariants: ["promo"],
  }),
  card({
    id: "sv03.5-GG01",
    localId: "GG01",
    localIdNumeric: 1,
    nameFr: "Galerie Mewtwo",
    availableVariants: [],
  }),
];

describe("fetchBurstSetCards (GET /api/burst/cards)", () => {
  const payload = { set: { id: "sv03.5" }, cards: [], binderId: null };

  it("appelle l'endpoint avec setId encodé et renvoie le payload", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload));
    const result = await fetchBurstSetCards("sv03.5", undefined, fetchImpl);
    expect(result).toEqual({ kind: "ok", data: payload });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/burst/cards?setId=sv03.5",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    await fetchBurstSetCards("a b&c", undefined, fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith("/api/burst/cards?setId=a+b%26c", expect.anything());
  });

  it("distingue 401, 404, autres erreurs HTTP et erreurs réseau", async () => {
    const respond = (status: number) => async () => new Response("{}", { status });
    expect(await fetchBurstSetCards("x", undefined, respond(401))).toEqual({
      kind: "unauthorized",
    });
    expect(await fetchBurstSetCards("x", undefined, respond(404))).toEqual({ kind: "not-found" });
    expect(await fetchBurstSetCards("x", undefined, respond(503))).toEqual({ kind: "error" });
    expect(
      await fetchBurstSetCards("x", undefined, async () => {
        throw new TypeError("network");
      }),
    ).toEqual({ kind: "error" });
  });

  it("remonte une requête annulée à l'appelant", async () => {
    await expect(
      fetchBurstSetCards("x", undefined, async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toBeInstanceOf(DOMException);
  });
});

// ---------------------------------------------------------------------------
// État du lot : ajouts, plafonds, Undo
// ---------------------------------------------------------------------------

const add = (state: BurstSessionState, overrides: Partial<BurstAddInput> = {}): BurstSessionState =>
  addToBurstSession(state, {
    cardId: "sv03.5-25",
    ownedQuantity: 0,
    language: "FR",
    variant: "normal",
    condition: "NM",
    ...overrides,
  });

describe("addToBurstSession (clé canonique, quantités)", () => {
  it("indexe par (cardId, language, variant, condition) et cumule les quantités", () => {
    let state = add(emptyBurstSession);
    state = add(state);
    state = add(state, { variant: "reverse" });
    state = add(state, { language: "EN" });
    state = add(state, { condition: "EX" });
    expect(state.lines).toHaveLength(4);
    expect(state.lines[0]).toMatchObject({
      key: "sv03.5-25 FR normal NM",
      quantity: 2,
      explicit: false,
    });
    expect(burstBatchQuantity(state.lines, "sv03.5-25")).toBe(5);
    expect(burstBatchQuantity(state.lines, "sv03.5-1")).toBe(0);
  });

  it("ajoute plusieurs exemplaires (×2) et mémorise le choix explicite de variante", () => {
    let state = add(emptyBurstSession, { quantity: 2 });
    expect(state.lines[0]?.quantity).toBe(2);
    state = add(state, { explicit: true });
    expect(state.lines[0]).toMatchObject({ quantity: 3, explicit: true });
  });

  it("plafonne à 999 en tenant compte des exemplaires déjà possédés", () => {
    const owned = 997;
    let state = add(emptyBurstSession, { ownedQuantity: owned, quantity: 2 });
    expect(burstRemainingCapacity(state.lines, "sv03.5-25", owned)).toBe(0);
    const capped = add(state, { ownedQuantity: owned });
    expect(capped).toBe(state); // même référence : rien ajouté, aucune entrée Undo
    // ×2 avec une seule place : borné à 1.
    state = add(emptyBurstSession, { ownedQuantity: 998, quantity: 2 });
    expect(state.lines[0]?.quantity).toBe(1);
    expect(burstRemainingCapacity(state.lines, "sv03.5-25", 998)).toBe(0);
  });

  it("applique le plafond à la carte entière (toutes variantes confondues)", () => {
    const state = add(emptyBurstSession, { ownedQuantity: 998, variant: "normal" });
    const refused = add(state, { ownedQuantity: 998, variant: "reverse" });
    expect(refused).toBe(state);
    expect(burstBatchQuantity(state.lines, "sv03.5-25")).toBe(1);
  });

  it("refuse une 501e ligne distincte mais accepte d'incrémenter une ligne existante", () => {
    let state: BurstSessionState = emptyBurstSession;
    for (let index = 0; index < 500; index += 1) {
      state = add(state, { cardId: `card-${index}` });
    }
    expect(state.lines).toHaveLength(500);
    const refused = add(state, { cardId: "card-extra" });
    expect(refused).toBe(state);
    const incremented = add(state, { cardId: "card-0" });
    expect(incremented.lines).toHaveLength(500);
    expect(incremented.lines[0]?.quantity).toBe(2);
  });
});

describe("décrément, suppression et Undo exact", () => {
  it("décrémente le DERNIER ajout de la carte et supprime la ligne à 0", () => {
    let state = add(emptyBurstSession); // normal
    state = add(state, { variant: "reverse" }); // reverse (plus récent)
    state = decrementBurstCard(state, "sv03.5-25");
    expect(state.lines.map((line) => line.variant)).toEqual(["normal"]);
    state = decrementBurstCard(state, "sv03.5-25");
    expect(state.lines).toEqual([]);
    expect(decrementBurstCard(state, "sv03.5-25")).toBe(state);
  });

  it("décrémente une ligne précise du ruban (−1 exemplaire)", () => {
    let state = add(emptyBurstSession, { quantity: 2 });
    state = decrementBurstLine(state, "sv03.5-25 FR normal NM");
    expect(state.lines[0]?.quantity).toBe(1);
    expect(decrementBurstLine(state, "inconnue")).toBe(state);
  });

  it("annule exactement chaque action (+1, ×2, −1, suppression), dans l'ordre inverse", () => {
    const snapshots: Array<BurstSessionState["lines"]> = [emptyBurstSession.lines];
    let state: BurstSessionState = emptyBurstSession;
    const step = (next: BurstSessionState) => {
      state = next;
      snapshots.push(state.lines);
    };
    step(add(state));
    step(add(state, { quantity: 2, variant: "reverse" }));
    step(add(state, { cardId: "sv03.5-1" }));
    step(decrementBurstCard(state, "sv03.5-25"));
    step(decrementBurstLine(state, "sv03.5-1 FR normal NM"));
    expect(canUndoBurstSession(state)).toBe(true);
    for (let index = snapshots.length - 2; index >= 0; index -= 1) {
      state = undoBurstSession(state);
      expect(state.lines).toEqual(snapshots[index]);
    }
    expect(canUndoBurstSession(state)).toBe(false);
    expect(undoBurstSession(state)).toBe(state);
  });

  it("borne la pile Undo à 200 entrées (les plus anciennes sont abandonnées)", () => {
    let state: BurstSessionState = emptyBurstSession;
    for (let index = 0; index < MAX_BURST_UNDO + 25; index += 1) state = add(state);
    expect(state.history).toHaveLength(MAX_BURST_UNDO);
    expect(burstBatchQuantity(state.lines, "sv03.5-25")).toBe(MAX_BURST_UNDO + 25);
    for (let index = 0; index < MAX_BURST_UNDO; index += 1) state = undoBurstSession(state);
    expect(burstBatchQuantity(state.lines, "sv03.5-25")).toBe(25);
    expect(canUndoBurstSession(state)).toBe(false);
  });

  it("vide le lot et l'historique (clearBurstSession)", () => {
    expect(clearBurstSession()).toEqual(emptyBurstSession);
  });
});

describe("résumé en direct, ruban et statut des cartes", () => {
  it("compte exemplaires, cartes distinctes et nouvelles (jamais possédées)", () => {
    const owned = burstOwnedByCard(catalog());
    let state = add(emptyBurstSession, { cardId: "sv03.5-1", ownedQuantity: 2 }); // doublon
    state = add(state, { cardId: "sv03.5-25", quantity: 2 }); // nouvelle
    state = add(state, { cardId: "sv03.5-25", variant: "reverse" }); // même carte, autre variante
    state = add(state, { cardId: "sv03.5-100", variant: "holo" }); // nouvelle
    expect(summarizeBurstSession(state.lines, owned)).toEqual({
      totalQuantity: 5,
      distinctCards: 3,
      newCards: 2,
    });
    expect(summarizeBurstSession([], owned)).toEqual({
      totalQuantity: 0,
      distinctCards: 0,
      newCards: 0,
    });
  });

  it("liste les ajouts récents du plus récent au plus ancien", () => {
    let state = add(emptyBurstSession, { cardId: "a" });
    state = add(state, { cardId: "b" });
    state = add(state, { cardId: "c" });
    state = add(state, { cardId: "a" }); // re-touche a
    expect(burstRecentLines(state.lines).map((line) => line.cardId)).toEqual(["a", "c", "b"]);
  });

  it("distingue Nouvelle / Doublon / aucun", () => {
    expect(burstCardStatus(0, 0)).toBe("none");
    expect(burstCardStatus(3, 0)).toBe("none");
    expect(burstCardStatus(0, 1)).toBe("new");
    expect(burstCardStatus(2, 1)).toBe("duplicate");
  });
});

describe("résolution de variante et corps de validation", () => {
  it("ajuste automatiquement la variante absente, sauf choix explicite", () => {
    const holoOnly = card({ availableVariants: ["holo"], holoEffect: "holo" });
    expect(resolveBurstVariantForCard(holoOnly, "normal", false)).toEqual({
      variant: "holo",
      adjusted: true,
    });
    expect(resolveBurstVariantForCard(holoOnly, "normal", true)).toEqual({
      variant: "normal",
      adjusted: false,
    });
    expect(resolveBurstVariantForCard(card(), "reverse", false)).toEqual({
      variant: "reverse",
      adjusted: false,
    });
  });

  it("construit le corps de POST /api/burst/commit dans l'ordre chronologique", () => {
    let state = add(emptyBurstSession, { cardId: "sv03.5-1", quantity: 2 });
    state = add(state, { cardId: "sv03.5-25", variant: "reverse", explicit: true, language: "EN" });
    expect(
      buildBurstCommitPayload(
        {
          setId: "sv03.5",
          language: "FR",
          variant: "normal",
          condition: "NM",
          removeFromWishlist: false,
        },
        state.lines,
      ),
    ).toEqual({
      defaults: {
        setId: "sv03.5",
        language: "FR",
        variant: "normal",
        condition: "NM",
        removeFromWishlist: false,
      },
      items: [
        {
          cardId: "sv03.5-1",
          quantity: 2,
          language: "FR",
          variant: "normal",
          condition: "NM",
          variantExplicit: false,
        },
        {
          cardId: "sv03.5-25",
          quantity: 1,
          language: "EN",
          variant: "reverse",
          condition: "NM",
          variantExplicit: true,
        },
      ],
    });
  });

  it("renvoie null pour un lot vide", () => {
    expect(
      buildBurstCommitPayload(
        {
          setId: "x",
          language: "FR",
          variant: "normal",
          condition: "NM",
          removeFromWishlist: true,
        },
        [],
      ),
    ).toBeNull();
  });

  it("envoie la variante demandée avant ajustement auto afin que le serveur remonte adjusted: true", () => {
    const holoOnly = card({
      id: "sv03.5-100",
      availableVariants: ["holo"],
      holoEffect: "holo",
    });
    // Simulation exacte de `applyAdd` : variante résolue = "holo", demandée = "normal", explicit = false.
    const resolved = resolveBurstVariantForCard(holoOnly, "normal", false);
    expect(resolved).toEqual({ variant: "holo", adjusted: true });
    const state = add(emptyBurstSession, {
      cardId: holoOnly.id,
      variant: resolved.variant,
      requestedVariant: "normal",
      explicit: false,
    });
    expect(state.lines[0]?.variant).toBe("holo");
    const payload = buildBurstCommitPayload(
      {
        setId: "sv03.5",
        language: "FR",
        variant: "normal",
        condition: "NM",
        removeFromWishlist: true,
      },
      state.lines,
    );
    expect(payload?.items[0]).toMatchObject({
      cardId: "sv03.5-100",
      variant: "normal",
      variantExplicit: false,
    });
    // En repassant exactement ce que le serveur reçoit dans la résolution domaine, `adjusted` vaut `true`.
    const serverItem = payload?.items[0];
    expect(serverItem).toBeDefined();
    if (serverItem !== undefined) {
      const serverResolution = resolveBurstVariantForCard(
        holoOnly,
        serverItem.variant ?? "normal",
        serverItem.variantExplicit ?? false,
      );
      expect(serverResolution).toEqual({ variant: "holo", adjusted: true });
    }

    // Avec un choix explicite (`explicit: true`), la variante reste explicite → `adjusted: false`.
    const explicitState = add(emptyBurstSession, {
      cardId: holoOnly.id,
      variant: "holo",
      requestedVariant: "holo",
      explicit: true,
    });
    const explicitPayload = buildBurstCommitPayload(
      {
        setId: "sv03.5",
        language: "FR",
        variant: "normal",
        condition: "NM",
        removeFromWishlist: true,
      },
      explicitState.lines,
    );
    expect(explicitPayload?.items[0]).toMatchObject({
      variant: "holo",
      variantExplicit: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Pavé numéros `#`
// ---------------------------------------------------------------------------

describe("matchBurstCardNumber (pavé #)", () => {
  const cards = catalog();

  it("renvoie empty pour une saisie vide (ou #)", () => {
    expect(matchBurstCardNumber(cards, "")).toEqual({ kind: "empty" });
    expect(matchBurstCardNumber(cards, "#")).toEqual({ kind: "empty" });
  });

  it("apparie 25 et 025 sur localIdNumeric", () => {
    for (const input of ["25", "025", "0025", "#25"]) {
      const match = matchBurstCardNumber(cards, input);
      expect(match.kind).toBe("match");
      if (match.kind === "match") expect(match.card.id).toBe("sv03.5-25");
    }
  });

  it("préfère l'identifiant exact au numéro tolérant", () => {
    const match = matchBurstCardNumber(cards, "001");
    expect(match.kind === "match" && match.card.id).toBe("sv03.5-1");
  });

  it("apparie les identifiants alphanumériques (insensible à la casse) puis par préfixe", () => {
    const exact = matchBurstCardNumber(cards, "sv001");
    expect(exact).toMatchObject({ kind: "match", quality: "exact" });
    expect(exact.kind === "match" && exact.card.id).toBe("sv03.5-SV001");
    const gg = matchBurstCardNumber(cards, "GG01");
    expect(gg.kind === "match" && gg.card.id).toBe("sv03.5-GG01");
    const prefix = matchBurstCardNumber(cards, "GG");
    expect(prefix).toMatchObject({ kind: "match", quality: "prefix" });
  });

  it("n'apparie jamais une saisie numérique par préfixe et signale l'absence de carte", () => {
    expect(matchBurstCardNumber(cards, "10")).toEqual({ kind: "none", query: "10" });
    expect(matchBurstCardNumber(cards, "999")).toEqual({ kind: "none", query: "999" });
    expect(matchBurstCardNumber(cards, "zz")).toEqual({ kind: "none", query: "ZZ" });
  });
});

describe("saisie du numéro (pavé et clavier)", () => {
  it("ajoute en majuscule, plafonne la longueur, ignore les caractères invalides", () => {
    let input = "";
    for (const char of "sv0-1") input = appendBurstNumberChar(input, char);
    expect(input).toBe("SV01");
    for (const char of "123456789") input = appendBurstNumberChar(input, char);
    expect(input).toHaveLength(MAX_BURST_NUMBER_LENGTH);
    expect(appendBurstNumberChar("", " ")).toBe("");
    expect(appendBurstNumberChar("", "Enter")).toBe("");
    // Les promos à 7+ caractères comme SWSH001 ne sont pas tronquées.
    let promo = "";
    for (const char of "swsh001") promo = appendBurstNumberChar(promo, char);
    expect(promo).toBe("SWSH001");
  });

  it("efface le dernier caractère", () => {
    expect(backspaceBurstNumber("025")).toBe("02");
    expect(backspaceBurstNumber("")).toBe("");
  });

  it("traduit les touches du clavier physique", () => {
    const key = (
      value: string,
      target: "text-field" | "interactive" | "keypad" | "other" = "other",
    ) => burstKeypadKeyAction({ key: value, target });
    expect(key("5")).toEqual({ type: "char", char: "5" });
    expect(key("g")).toEqual({ type: "char", char: "g" });
    expect(key("Backspace")).toEqual({ type: "backspace" });
    expect(key("Escape")).toEqual({ type: "clear" });
    expect(key("Enter")).toEqual({ type: "add" });
    expect(key("Enter", "keypad")).toEqual({ type: "add" });
    expect(key("Enter", "interactive")).toBeNull(); // comportement natif des boutons / liens
    expect(key("5", "text-field")).toBeNull();
    expect(key("Tab")).toBeNull();
    expect(key(" ")).toBeNull();
    expect(burstKeypadKeyAction({ key: "5", ctrlKey: true, target: "other" })).toBeNull();
    expect(burstKeypadKeyAction({ key: "5", metaKey: true, target: "other" })).toBeNull();
  });

  it("propose les variantes listées (ordre canonique), sinon les 4 courantes", () => {
    expect(burstVariantChoices(card({ availableVariants: ["holo", "normal"] }))).toEqual([
      "normal",
      "holo",
    ]);
    expect(burstVariantChoices(card({ availableVariants: [] }))).toEqual([
      "normal",
      "reverse",
      "holo",
      "promo",
    ]);
  });
});

describe("filterBurstCards (grille)", () => {
  const cards = catalog();
  it("filtre par nom sans accents ni casse, par numéro tolérant ou par identifiant", () => {
    expect(filterBurstCards(cards, "")).toBe(cards);
    expect(filterBurstCards(cards, "evoli").map((entry) => entry.id)).toEqual(["sv03.5-100"]);
    expect(filterBurstCards(cards, "#25").map((entry) => entry.id)).toEqual(["sv03.5-25"]);
    expect(filterBurstCards(cards, "sv0").map((entry) => entry.id)).toEqual(["sv03.5-SV001"]);
    expect(filterBurstCards(cards, "zzz")).toEqual([]);
  });
});
