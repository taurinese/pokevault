import type { BurstImportBatchInput } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  type BurstSetOption,
  type BurstSetupConfig,
  commitBurstImport,
  DEFAULT_BURST_SETUP,
  fetchBurstSets,
  filterBurstSets,
  normalizeBurstText,
  parseBurstSearchParams,
  previewBurstImport,
  serializeBurstSearchParams,
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
