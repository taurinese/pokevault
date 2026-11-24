import type {
  Binder,
  BinderCardEntry,
  OverviewSeriesInput,
  OverviewSetInput,
  UserCardCopy,
} from "@pokevault/domain";
import { Context, Layer } from "effect";

/** Carte du catalogue connue du store mémoire. */
export interface MemoryCatalogCard {
  readonly id: string;
  readonly setId: string;
  /** `catalog_cards.local_id_numeric` (secrète si `> officialCount`). */
  readonly localIdNumeric: number | null;
}

/** Catalogue (séries, extensions, cartes) servant de référentiel aux services mémoire. */
export interface MemoryCatalog {
  readonly series: ReadonlyArray<OverviewSeriesInput>;
  readonly sets: ReadonlyArray<OverviewSetInput>;
  readonly cards: ReadonlyArray<MemoryCatalogCard>;
}

/** État mutable partagé par `BinderServiceMemory` et `CollectionServiceMemory`. */
export interface CollectionMemoryState {
  readonly binders: Map<string, Binder>;
  binderCards: Array<BinderCardEntry>;
  readonly copies: Map<string, UserCardCopy>;
}

export interface CollectionMemoryStoreShape {
  readonly catalog: MemoryCatalog;
  readonly state: CollectionMemoryState;
}

/**
 * Store en mémoire (tests unitaires, sans Postgres) : classeurs, cartes de dossiers et
 * exemplaires de **tous** les utilisateurs, isolés par `userId` dans chaque service.
 */
export class CollectionMemoryStore extends Context.Service<
  CollectionMemoryStore,
  CollectionMemoryStoreShape
>()("@pokevault/services/CollectionMemoryStore") {}

/** Layer du store mémoire ; un état neuf est créé à chaque construction. */
export const CollectionMemoryStoreLayer = (
  catalog: MemoryCatalog,
): Layer.Layer<CollectionMemoryStore> =>
  Layer.sync(CollectionMemoryStore, () => ({
    catalog,
    state: { binders: new Map(), binderCards: [], copies: new Map() },
  }));
