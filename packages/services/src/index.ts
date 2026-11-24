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

export * from "./catalog-repo.ts";
export * from "./catalog-sync.ts";
export * from "./db.ts";
export * from "./tcgdex.ts";
