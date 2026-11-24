import type { CardLanguage } from "@pokevault/domain";
import { Data } from "effect";

/** Typed configuration error for infrastructure services. */
export class ServiceConfigError extends Data.TaggedError("ServiceConfigError")<{
  readonly message: string;
  readonly key?: string;
}> {}

/** Minimal shared service config proving workspace wiring to `@pokevault/domain`. */
export interface CatalogSyncConfig {
  readonly defaultLanguage: CardLanguage;
}

export * from "./binder-service.ts";
export * from "./burst-import.ts";
export * from "./catalog-repo.ts";
export * from "./catalog-search.ts";
export * from "./catalog-sync.ts";
export * from "./collection-memory.ts";
export * from "./collection-memory-layer.ts";
export * from "./collection-service.ts";
export * from "./cover-image.ts";
export * from "./db.ts";
export * from "./rls.ts";
export * from "./storage.ts";
export * from "./tcgdex.ts";
