import type { CatalogCard, CatalogSet } from "@pokevault/domain";
import type { MemoryCatalog } from "./collection-memory.ts";

/** Fixture partagée par les tests Memory (hors-ligne) et Postgres (conteneur jetable). */

export const COLLECTION_FIXTURE_SERIES = [
  { id: "t32-sv", name_fr: "Série T32 récente", name_en: null, release_order: 12 },
  { id: "t32-old", name_fr: "Série T32 ancienne", name_en: null, release_order: 5 },
] as const;

const set = (
  id: string,
  seriesId: string,
  official: number,
  total: number,
  releaseDate: string,
): CatalogSet => ({
  id,
  series_id: seriesId,
  code: id.toUpperCase(),
  cardmarket_code: null,
  name_fr: `Extension ${id}`,
  name_en: null,
  logo_url: `https://assets.tcgdex.net/fr/${id}/logo`,
  symbol_url: null,
  release_date: releaseDate as CatalogSet["release_date"],
  official_count: official,
  total_count: total,
});

export const COLLECTION_FIXTURE_SETS: ReadonlyArray<CatalogSet> = [
  set("t32-a", "t32-sv", 3, 4, "2024-01-10"),
  set("t32-b", "t32-sv", 2, 2, "2023-05-05"),
  set("t32-c", "t32-old", 1, 1, "2015-03-03"),
];

const card = (setId: string, localId: string): CatalogCard => ({
  id: `${setId}-${localId}`,
  set_id: setId,
  local_id: localId,
  local_id_numeric: Number.parseInt(localId, 10),
  name_fr: `Carte ${setId} ${localId}`,
  name_en: null,
  rarity: null,
  holo_effect: "none",
  category: "Pokemon",
  types: [],
  hp: null,
  illustrator: null,
  image_base_url: null,
  available_variants: ["normal", "reverse", "holo", "promo"],
  cardmarket_product_id: null,
  cardmarket_url: null,
});

export const COLLECTION_FIXTURE_CARDS: ReadonlyArray<CatalogCard> = [
  card("t32-a", "001"),
  card("t32-a", "002"),
  card("t32-a", "003"),
  card("t32-a", "004"), // secrète : n° 4 > officialCount 3
  card("t32-b", "001"),
  card("t32-b", "002"),
  card("t32-c", "001"),
];

/** Catalogue au format du store mémoire. */
export const COLLECTION_MEMORY_CATALOG: MemoryCatalog = {
  series: COLLECTION_FIXTURE_SERIES.map((row) => ({
    id: row.id,
    nameFr: row.name_fr,
    releaseOrder: row.release_order,
  })),
  sets: COLLECTION_FIXTURE_SETS.map((row) => ({
    id: row.id,
    seriesId: row.series_id,
    nameFr: row.name_fr,
    code: row.code,
    logoUrl: row.logo_url,
    releaseDate: row.release_date,
    officialCount: row.official_count,
    totalCount: row.total_count,
  })),
  cards: COLLECTION_FIXTURE_CARDS.map((row) => ({
    id: row.id,
    setId: row.set_id,
    localIdNumeric: row.local_id_numeric,
  })),
};

export const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
export const BOB = "bbbbbbbb-0000-4000-8000-0000000000b1";
