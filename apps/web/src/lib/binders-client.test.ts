import type { BinderSummary } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  type BindersPayload,
  binderCoverUrl,
  type CatalogSetEntry,
  createBinder,
  fetchBinders,
  filterTrackableSets,
  followSet,
  submitCustomFolder,
  trackedSetIdsOf,
  validateFolderTitle,
} from "./binders-client.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const setEntry = (overrides: Partial<CatalogSetEntry> = {}): CatalogSetEntry => ({
  id: "sv08",
  code: "SSP",
  nameFr: "Étincelles Déferlantes",
  logoUrl: null,
  seriesId: "sv",
  seriesNameFr: "Écarlate et Violet",
  seriesReleaseOrder: 20,
  releaseDate: "2024-11-08",
  officialCount: 191,
  totalCount: 252,
  ...overrides,
});

const summary = (kind: "set" | "custom", setId: string | null): BinderSummary => ({
  binder: {
    id: "33333333-3333-4333-8333-333333333333",
    userId: "11111111-1111-4111-8111-111111111111",
    kind,
    setId,
    title: "T",
    coverType: "set_logo",
    coverCardId: null,
    coverStoragePath: null,
    isPinned: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  set: null,
  completion: null,
  cardCount: 0,
  ownedCount: 0,
});

describe("binderCoverUrl", () => {
  it("targets the secure proxy and busts the cache with the encoded updatedAt", () => {
    expect(binderCoverUrl({ id: "abc", updatedAt: "2026-01-01T00:00:00.000+00:00" })).toBe(
      "/api/binders/abc/cover?v=2026-01-01T00%3A00%3A00.000%2B00%3A00",
    );
  });
});

describe("validateFolderTitle", () => {
  it("normalises whitespace and accepts 1..80 characters", () => {
    expect(validateFolderTitle("  Évolitions   Favs ")).toEqual({
      ok: true,
      title: "Évolitions Favs",
    });
    expect(validateFolderTitle("x".repeat(80))).toEqual({ ok: true, title: "x".repeat(80) });
  });

  it("rejects blank and too long titles", () => {
    expect(validateFolderTitle("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateFolderTitle("x".repeat(81))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("filterTrackableSets / trackedSetIdsOf", () => {
  const sets = [
    setEntry(),
    setEntry({ id: "sv03.5", code: "151", nameFr: "151" }),
    setEntry({
      id: "swsh12",
      code: "SIT",
      nameFr: "Tempête Argentée",
      seriesNameFr: "Épée et Bouclier",
    }),
  ];

  it("collects tracked set ids from set binders only", () => {
    expect(trackedSetIdsOf([summary("set", "sv08"), summary("custom", null)])).toEqual(
      new Set(["sv08"]),
    );
  });

  it("hides already tracked sets and keeps the catalogue order", () => {
    expect(filterTrackableSets(sets, new Set(["sv08"]), "").map((s) => s.id)).toEqual([
      "sv03.5",
      "swsh12",
    ]);
  });

  it("filters case- and accent-insensitively on name, code and series", () => {
    expect(filterTrackableSets(sets, new Set(), "etincelles").map((s) => s.id)).toEqual(["sv08"]);
    expect(filterTrackableSets(sets, new Set(), "SIT").map((s) => s.id)).toEqual(["swsh12"]);
    expect(filterTrackableSets(sets, new Set(), "epee").map((s) => s.id)).toEqual(["swsh12"]);
    expect(filterTrackableSets(sets, new Set(), "zzz")).toEqual([]);
  });
});

describe("fetchBinders", () => {
  const payload: BindersPayload = {
    binders: [],
    overview: {
      global: {
        trackedSetCount: 0,
        completedSetCount: 0,
        trackedOwnedDistinct: 0,
        trackedTargetCount: 0,
        percent: 0,
        ownedDistinct: 0,
        totalCopies: 0,
        duplicateCount: 0,
        duplicateCardCount: 0,
      },
      series: [],
      sets: [],
    },
    coverCardImageById: {},
    catalogSets: [],
  };

  it("returns the payload with same-origin credentials", async () => {
    const fetchImpl = vi.fn(async () => json(payload));
    const result = await fetchBinders(undefined, fetchImpl);
    expect(result).toEqual({ kind: "ok", data: payload });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/binders",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("maps 401 to unauthorized and other failures to error", async () => {
    expect(await fetchBinders(undefined, async () => json({}, 401))).toEqual({
      kind: "unauthorized",
    });
    expect(await fetchBinders(undefined, async () => json({}, 503))).toEqual({ kind: "error" });
    expect(
      await fetchBinders(undefined, async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ kind: "error" });
  });

  it("rethrows aborts so callers stay silent", async () => {
    await expect(
      fetchBinders(undefined, async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("createBinder / followSet / submitCustomFolder", () => {
  const created = summary("custom", null);

  it("POSTs JSON and returns the created summary on 201", async () => {
    const fetchImpl = vi.fn(async () => json(created, 201));
    const result = await createBinder({ kind: "custom", title: "Favs", isPinned: true }, fetchImpl);
    expect(result).toEqual({ kind: "ok", summary: created });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/binders");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "custom",
      title: "Favs",
      isPinned: true,
    });
  });

  it.each([
    [401, "unauthorized"],
    [400, "invalid"],
    [404, "not_found"],
    [409, "conflict"],
    [503, "error"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const result = await createBinder({ kind: "set", setId: "sv08" }, async () => json({}, status));
    expect(result.kind).toBe(kind);
  });

  it("maps a network failure to error", async () => {
    const result = await createBinder({ kind: "set", setId: "sv08" }, async () => {
      throw new TypeError("offline");
    });
    expect(result).toEqual({ kind: "error" });
  });

  it("followSet sends a set payload", async () => {
    const fetchImpl = vi.fn(async () => json(created, 201));
    await followSet("sv08", fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ kind: "set", setId: "sv08" });
  });

  it("submitCustomFolder validates locally without any network call", async () => {
    const fetchImpl = vi.fn(async () => json(created, 201));
    expect(await submitCustomFolder("   ", false, fetchImpl)).toEqual({
      kind: "invalid_title",
      reason: "empty",
    });
    expect(await submitCustomFolder("x".repeat(81), false, fetchImpl)).toEqual({
      kind: "invalid_title",
      reason: "too_long",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("submitCustomFolder sends the normalised title and pin flag", async () => {
    const fetchImpl = vi.fn(async () => json(created, 201));
    const result = await submitCustomFolder("  Doublons   Échange ", true, fetchImpl);
    expect(result.kind).toBe("ok");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "custom",
      title: "Doublons Échange",
      isPinned: true,
    });
  });
});
