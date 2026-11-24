import { binderCoverStoragePath, isUuid, StorageServiceError } from "@pokevault/domain";
import { Context, Effect, Layer } from "effect";

/** Bucket Supabase Storage privé des covers (migration 004). */
export const BINDER_COVERS_BUCKET = "binder-covers";

export interface BinderCoverObject {
  readonly userId: string;
  readonly binderId: string;
}

export interface UploadBinderCoverParams extends BinderCoverObject {
  /** JWT de l'utilisateur (access token Supabase) : les policies `storage.objects` s'appliquent. */
  readonly accessToken: string;
  /** WebP déjà recompressé (voir `CoverImageProcessor`). */
  readonly bytes: Uint8Array;
}

export interface RemoveBinderCoverParams extends BinderCoverObject {
  readonly accessToken: string;
}

/**
 * Client du bucket `binder-covers`. Le chemin est toujours `<userId>/<binderId>.webp` ; la
 * policy Storage RLS refuse tout autre chemin ou tout autre utilisateur.
 */
export interface BinderCoverStorageShape {
  /** Écrit (ou remplace, `x-upsert: true`) l'objet de cover. */
  readonly upload: (params: UploadBinderCoverParams) => Effect.Effect<void, StorageServiceError>;
  /** Supprime l'objet ; un objet déjà absent (404) est un succès. */
  readonly remove: (params: RemoveBinderCoverParams) => Effect.Effect<void, StorageServiceError>;
}

/** Effect-TS service key of the binder cover storage client. */
export class BinderCoverStorage extends Context.Service<
  BinderCoverStorage,
  BinderCoverStorageShape
>()("@pokevault/services/BinderCoverStorage") {}

// ---------------------------------------------------------------------------
// Live — API HTTP Supabase Storage
// ---------------------------------------------------------------------------

export interface BinderCoverStorageLiveOptions {
  /** URL de base de l'API Supabase (ex. `http://kong:8000` ou `https://x.supabase.co`). */
  readonly supabaseUrl: string;
  /** Clé publique (`anon`) : header `apikey`. */
  readonly anonKey: string;
  /** Timeout par requête (défaut 15 s). */
  readonly timeoutMs?: number | undefined;
  /** `fetch` injectable (tests). */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

const objectUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/storage/v1/object/${BINDER_COVERS_BUCKET}/${path}`;

const checkParams = (
  params: BinderCoverObject & { readonly accessToken: string },
): StorageServiceError | undefined => {
  if (!isUuid(params.userId) || !isUuid(params.binderId)) {
    return new StorageServiceError({ message: "userId and binderId must be valid UUIDs" });
  }
  if (params.accessToken.trim() === "") {
    return new StorageServiceError({ message: "missing user access token for Storage" });
  }
  return undefined;
};

/**
 * Layer {@link BinderCoverStorage} basé sur `fetch` : `POST /object/binder-covers/<path>` avec
 * `x-upsert: true` et `Content-Type: image/webp`, `DELETE` pour la suppression, toujours avec
 * `Authorization: Bearer <accessToken>` + `apikey`.
 */
export const BinderCoverStorageLive = (
  options: BinderCoverStorageLiveOptions,
): Layer.Layer<BinderCoverStorage> => {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const request = (
    method: "POST" | "DELETE",
    path: string,
    accessToken: string,
    body?: Uint8Array,
  ): Effect.Effect<Response, StorageServiceError> =>
    Effect.tryPromise({
      try: (signal) =>
        doFetch(objectUrl(options.supabaseUrl, path), {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: options.anonKey,
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "image/webp",
                  "x-upsert": "true",
                  "Cache-Control": "max-age=3600",
                }),
          },
          ...(body === undefined ? {} : { body: new Uint8Array(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        }),
      catch: (cause) => new StorageServiceError({ message: `storage ${method} failed`, cause }),
    });

  const failure = (method: string, response: Response): StorageServiceError =>
    new StorageServiceError({
      message: `storage ${method} returned HTTP ${response.status}`,
      status: response.status,
    });

  return Layer.succeed(BinderCoverStorage, {
    upload: (params) => {
      const invalid = checkParams(params);
      if (invalid !== undefined) return Effect.fail(invalid);
      const path = binderCoverStoragePath(params.userId, params.binderId);
      return request("POST", path, params.accessToken, params.bytes).pipe(
        Effect.flatMap((response) => {
          void response.body?.cancel().catch(() => {});
          return response.ok ? Effect.void : Effect.fail(failure("POST", response));
        }),
      );
    },
    remove: (params) => {
      const invalid = checkParams(params);
      if (invalid !== undefined) return Effect.fail(invalid);
      const path = binderCoverStoragePath(params.userId, params.binderId);
      return request("DELETE", path, params.accessToken).pipe(
        Effect.flatMap((response) => {
          void response.body?.cancel().catch(() => {});
          return response.ok || response.status === 404
            ? Effect.void
            : Effect.fail(failure("DELETE", response));
        }),
      );
    },
  });
};

// ---------------------------------------------------------------------------
// Memory — tests
// ---------------------------------------------------------------------------

export interface MemoryBinderCoverStorage {
  readonly service: BinderCoverStorageShape;
  /** Objets stockés : `<userId>/<binderId>.webp` → octets. */
  readonly objects: Map<string, Uint8Array>;
  /** Injection de pannes (`true` : la prochaine opération échoue avec `StorageServiceError`). */
  readonly failures: { upload: boolean; remove: boolean };
}

/** Fabrique un faux Storage en mémoire dont les objets sont inspectables. */
export const makeMemoryBinderCoverStorage = (): MemoryBinderCoverStorage => {
  const objects = new Map<string, Uint8Array>();
  const failures = { upload: false, remove: false };
  const service: BinderCoverStorageShape = {
    upload: (params) =>
      Effect.suspend(() => {
        const invalid = checkParams(params);
        if (invalid !== undefined) return Effect.fail(invalid);
        if (failures.upload) {
          return Effect.fail(new StorageServiceError({ message: "upload failed", status: 503 }));
        }
        objects.set(binderCoverStoragePath(params.userId, params.binderId), params.bytes);
        return Effect.void;
      }),
    remove: (params) =>
      Effect.suspend(() => {
        const invalid = checkParams(params);
        if (invalid !== undefined) return Effect.fail(invalid);
        if (failures.remove) {
          return Effect.fail(new StorageServiceError({ message: "remove failed", status: 503 }));
        }
        objects.delete(binderCoverStoragePath(params.userId, params.binderId));
        return Effect.void;
      }),
  };
  return { service, objects, failures };
};

/** Layer {@link BinderCoverStorage} en mémoire (état neuf à chaque construction). */
export const BinderCoverStorageMemory: Layer.Layer<BinderCoverStorage> = Layer.sync(
  BinderCoverStorage,
  () => makeMemoryBinderCoverStorage().service,
);
