import { Layer } from "effect";
import { type BinderService, BinderServiceMemory } from "./binder-service.ts";
import {
  type CollectionMemoryStore,
  CollectionMemoryStoreLayer,
  type MemoryCatalog,
} from "./collection-memory.ts";
import { type CollectionService, CollectionServiceMemory } from "./collection-service.ts";
import { CoverImageProcessorMemory } from "./cover-image.ts";
import { BinderCoverStorageMemory } from "./storage.ts";

/**
 * Pile mémoire complète (store + `BinderService` + `CollectionService` + Storage + processeur
 * d'images factices) : une seule `Layer` pour les tests unitaires des écrans / server functions.
 */
export const CollectionMemoryLayer = (
  catalog: MemoryCatalog,
): Layer.Layer<BinderService | CollectionService | CollectionMemoryStore> => {
  const store = CollectionMemoryStoreLayer(catalog);
  const infra = Layer.mergeAll(store, BinderCoverStorageMemory, CoverImageProcessorMemory);
  return Layer.mergeAll(BinderServiceMemory, CollectionServiceMemory).pipe(
    Layer.provideMerge(infra),
  );
};
