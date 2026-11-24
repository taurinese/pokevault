import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  BinderCoverStorage,
  BinderCoverStorageLive,
  BinderCoverStorageMemory,
  makeMemoryBinderCoverStorage,
} from "./storage.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const BINDER = "22222222-2222-4222-8222-222222222222";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

const fakeFetch = (respond: (call: Recorded) => Response | Promise<Response>) => {
  const calls: Array<Recorded> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, BinderCoverStorage>,
  layer: ReturnType<typeof live>,
) => Effect.runPromise(Effect.result(effect.pipe(Effect.provide(layer))));
const live = (fetch: typeof globalThis.fetch) =>
  BinderCoverStorageLive({ supabaseUrl: "http://kong:8000/", anonKey: "anon-key", fetch });

describe("BinderCoverStorageLive", () => {
  it("upload : POST /object/binder-covers/<userId>/<binderId>.webp avec JWT, apikey et upsert", async () => {
    const { calls, fetch } = fakeFetch(() => new Response("{}", { status: 200 }));
    const result = await run(
      Effect.flatMap(BinderCoverStorage, (storage) =>
        storage.upload({ userId: USER, binderId: BINDER, accessToken: "jwt-1", bytes: WEBP }),
      ),
      live(fetch),
    );
    expect(result._tag).toBe("Success");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(
      `http://kong:8000/storage/v1/object/binder-covers/${USER}/${BINDER}.webp`,
    );
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer jwt-1");
    expect(headers["apikey"]).toBe("anon-key");
    expect(headers["x-upsert"]).toBe("true");
    expect(headers["Content-Type"]).toBe("image/webp");
    expect(call?.init.body).toEqual(WEBP);
  });

  it.each([
    ["http://storage:5000", `http://storage:5000/object/binder-covers/${USER}/${BINDER}.webp`],
    ["http://storage:5000///", `http://storage:5000/object/binder-covers/${USER}/${BINDER}.webp`],
    [
      "http://localhost:54321/storage/v1",
      `http://localhost:54321/storage/v1/object/binder-covers/${USER}/${BINDER}.webp`,
    ],
  ])(
    "storageUrl %s est utilisée telle quelle (sans /storage/v1 ajouté)",
    async (storageUrl, expected) => {
      const { calls, fetch } = fakeFetch(() => new Response("{}", { status: 200 }));
      const result = await run(
        Effect.flatMap(BinderCoverStorage, (storage) =>
          storage.upload({ userId: USER, binderId: BINDER, accessToken: "jwt-1", bytes: WEBP }),
        ),
        BinderCoverStorageLive({ storageUrl, anonKey: "anon-key", fetch }),
      );
      expect(result._tag).toBe("Success");
      expect(calls[0]?.url).toBe(expected);
    },
  );

  it("remove : DELETE du même chemin ; 404 = succès", async () => {
    const { calls, fetch } = fakeFetch(() => new Response("not found", { status: 404 }));
    const result = await run(
      Effect.flatMap(BinderCoverStorage, (storage) =>
        storage.remove({ userId: USER, binderId: BINDER, accessToken: "jwt-1" }),
      ),
      live(fetch),
    );
    expect(result._tag).toBe("Success");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url).toContain(`/binder-covers/${USER}/${BINDER}.webp`);
    expect(((calls[0]?.init.headers ?? {}) as Record<string, string>)["Authorization"]).toBe(
      "Bearer jwt-1",
    );
  });

  it("HTTP 4xx / 5xx → StorageServiceError avec le status", async () => {
    for (const status of [400, 403, 500]) {
      const { fetch } = fakeFetch(() => new Response("nope", { status }));
      const upload = await run(
        Effect.flatMap(BinderCoverStorage, (storage) =>
          storage.upload({ userId: USER, binderId: BINDER, accessToken: "t", bytes: WEBP }),
        ),
        live(fetch),
      );
      expect(upload._tag === "Failure" && upload.failure).toMatchObject({
        _tag: "StorageServiceError",
        status,
      });
      const remove = await run(
        Effect.flatMap(BinderCoverStorage, (storage) =>
          storage.remove({ userId: USER, binderId: BINDER, accessToken: "t" }),
        ),
        live(fetch),
      );
      expect(remove._tag === "Failure" && remove.failure).toMatchObject({ status });
    }
  });

  it("erreur réseau → StorageServiceError ; jeton ou UUID invalide refusés sans appel réseau", async () => {
    const boom = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const network = await run(
      Effect.flatMap(BinderCoverStorage, (storage) =>
        storage.upload({ userId: USER, binderId: BINDER, accessToken: "t", bytes: WEBP }),
      ),
      live(boom.fetch),
    );
    expect(network._tag === "Failure" && network.failure._tag).toBe("StorageServiceError");

    const idle = fakeFetch(() => new Response("{}"));
    const noToken = await run(
      Effect.flatMap(BinderCoverStorage, (storage) =>
        storage.upload({ userId: USER, binderId: BINDER, accessToken: " ", bytes: WEBP }),
      ),
      live(idle.fetch),
    );
    expect(noToken._tag).toBe("Failure");
    const badId = await run(
      Effect.flatMap(BinderCoverStorage, (storage) =>
        storage.remove({ userId: "../x", binderId: BINDER, accessToken: "t" }),
      ),
      live(idle.fetch),
    );
    expect(badId._tag).toBe("Failure");
    expect(idle.calls).toHaveLength(0);
  });
});

describe("BinderCoverStorageMemory", () => {
  it("stocke et supprime par chemin canonique, avec pannes injectables", async () => {
    const memory = makeMemoryBinderCoverStorage();
    await Effect.runPromise(
      memory.service.upload({
        userId: USER.toUpperCase(),
        binderId: BINDER,
        accessToken: "t",
        bytes: WEBP,
      }),
    );
    expect([...memory.objects.keys()]).toEqual([`${USER}/${BINDER}.webp`]);
    memory.failures.remove = true;
    const failed = await Effect.runPromise(
      Effect.result(memory.service.remove({ userId: USER, binderId: BINDER, accessToken: "t" })),
    );
    expect(failed._tag).toBe("Failure");
    memory.failures.remove = false;
    await Effect.runPromise(
      memory.service.remove({ userId: USER, binderId: BINDER, accessToken: "t" }),
    );
    expect(memory.objects.size).toBe(0);
  });

  it("le layer fournit un service utilisable", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(BinderCoverStorage, (storage) =>
        storage.upload({ userId: USER, binderId: BINDER, accessToken: "t", bytes: WEBP }),
      ).pipe(Effect.provide(BinderCoverStorageMemory)),
    );
    expect(result).toBeUndefined();
  });
});
