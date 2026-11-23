import { Data } from "effect";

/** Erreur typée de configuration d'un service (valide le câblage du workspace). */
export class ServiceConfigError extends Data.TaggedError("ServiceConfigError")<{
  readonly message: string;
  readonly key?: string;
}> {}
