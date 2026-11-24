import { Effect, Layer } from "effect";
import { BinderService, BinderServiceMemory, type BinderServiceShape } from "./binder-service.ts";
import { COLLECTION_MEMORY_CATALOG } from "./collection.fixture.ts";
import { CollectionMemoryStoreLayer } from "./collection-memory.ts";
import {
  CollectionService,
  CollectionServiceMemory,
  type CollectionServiceShape,
} from "./collection-service.ts";
import { CoverImageProcessorMemory } from "./cover-image.ts";
import {
  BinderCoverStorage,
  type MemoryBinderCoverStorage,
  makeMemoryBinderCoverStorage,
} from "./storage.ts";

export interface MemoryScenario {
  readonly binders: BinderServiceShape;
  readonly collection: CollectionServiceShape;
  readonly storage: MemoryBinderCoverStorage;
}

/**
 * Exécute `body` avec une pile Memory neuve (store, services, Storage inspectable, processeur
 * d'images factice) : chaque scénario démarre sur un état vide.
 */
export const runMemoryScenario = <A>(
  body: (scenario: MemoryScenario) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const storage = makeMemoryBinderCoverStorage();
  const layer = Layer.mergeAll(BinderServiceMemory, CollectionServiceMemory).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CollectionMemoryStoreLayer(COLLECTION_MEMORY_CATALOG),
        Layer.succeed(BinderCoverStorage, storage.service),
        CoverImageProcessorMemory,
      ),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const binders = yield* BinderService;
      const collection = yield* CollectionService;
      return yield* body({ binders, collection, storage });
    }).pipe(Effect.provide(layer)),
  );
};

/** Échec attendu d'un effet (échoue le test si l'effet réussit). */
export const failureOf = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<E, A> =>
  Effect.flip(effect);
