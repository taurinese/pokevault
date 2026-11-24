import { type BinderSummary, COVER_MAX_BYTES, type SetCompletionStats } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  applyCollectionFiltersAndSort,
  type BindersPayload,
  binderCoverUrl,
  type CatalogSetEntry,
  COVER_ACCEPT_ATTRIBUTE,
  type CollectionFilters,
  countActiveCollectionFilters,
  createBinder,
  DEFAULT_COLLECTION_FILTERS,
  deleteBinder,
  fetchBinders,
  filterTrackableSets,
  followSet,
  setBinderCover,
  submitBinderInfo,
  submitCustomFolder,
  toggleInSelection,
  trackedSetIdsOf,
  updateBinder,
  uploadBinderCover,
  validateCoverFile,
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

// ---------------------------------------------------------------------------
// Filtres & tri (02C)
// ---------------------------------------------------------------------------

const stats = (
  setId: string,
  percent: number,
  ownedDistinct: number,
  status: SetCompletionStats["status"],
): SetCompletionStats => ({
  setId,
  officialCount: 100,
  totalCount: 120,
  targetCount: 120,
  ownedDistinct,
  missingCount: 120 - ownedDistinct,
  percent,
  totalCopies: ownedDistinct,
  duplicateCount: 0,
  duplicateCardCount: 0,
  status,
});

let counter = 0;
const setSummary = (
  title: string,
  seriesId: string,
  releaseDate: string | null,
  completion: SetCompletionStats,
  isPinned = false,
): BinderSummary => {
  counter += 1;
  const base = summary("set", completion.setId);
  return {
    ...base,
    binder: {
      ...base.binder,
      id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      title,
      isPinned,
    },
    set: {
      id: completion.setId,
      nameFr: title,
      code: null,
      logoUrl: null,
      seriesId,
      releaseDate,
      officialCount: 100,
      totalCount: 120,
    },
    completion,
    cardCount: 120,
    ownedCount: completion.ownedDistinct,
  };
};

const folderSummary = (title: string, cardCount: number, ownedCount: number): BinderSummary => {
  counter += 1;
  const base = summary("custom", null);
  return {
    ...base,
    binder: {
      ...base.binder,
      id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      title,
    },
    cardCount,
    ownedCount,
  };
};

const COLLECTION: ReadonlyArray<BinderSummary> = [
  setSummary("Zénith Suprême", "sv", "2025-01-17", stats("sv8.5", 50, 60, "in_progress")),
  setSummary("Étincelles Déferlantes", "sv", "2024-11-08", stats("sv08", 100, 120, "completed")),
  setSummary("Tempête Argentée", "swsh", "2022-11-11", stats("swsh12", 0, 0, "not_started")),
  setSummary("151", "sv", "2023-09-22", stats("sv03.5", 25, 30, "in_progress")),
];

const titles = (list: ReadonlyArray<BinderSummary>): ReadonlyArray<string> =>
  list.map(({ binder }) => binder.title);

const withFilters = (overrides: Partial<CollectionFilters>): CollectionFilters => ({
  ...DEFAULT_COLLECTION_FILTERS,
  ...overrides,
});

describe("DEFAULT_COLLECTION_FILTERS / countActiveCollectionFilters", () => {
  it("defaults to completion ↓, no filter, secrets and promos included", () => {
    expect(DEFAULT_COLLECTION_FILTERS).toEqual({
      sort: "completion_desc",
      progress: [],
      seriesIds: [],
      hideEmptySets: false,
      includeSecretsAndPromos: true,
    });
    expect(countActiveCollectionFilters(DEFAULT_COLLECTION_FILTERS)).toBe(0);
  });

  it("counts each active criterion once (a non-default sort counts as one)", () => {
    expect(countActiveCollectionFilters(withFilters({ sort: "name_asc" }))).toBe(1);
    expect(
      countActiveCollectionFilters(withFilters({ progress: ["completed", "in_progress"] })),
    ).toBe(1);
    expect(countActiveCollectionFilters(withFilters({ seriesIds: ["sv", "swsh"] }))).toBe(1);
    expect(countActiveCollectionFilters(withFilters({ hideEmptySets: true }))).toBe(1);
    expect(countActiveCollectionFilters(withFilters({ includeSecretsAndPromos: false }))).toBe(1);
    expect(
      countActiveCollectionFilters({
        sort: "release_date_desc",
        progress: ["completed"],
        seriesIds: ["sv"],
        hideEmptySets: true,
        includeSecretsAndPromos: false,
      }),
    ).toBe(5);
  });

  it("toggles values in a multi-selection without mutating it", () => {
    const selection = ["a"] as const;
    expect(toggleInSelection(selection, "b")).toEqual(["a", "b"]);
    expect(toggleInSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(selection).toEqual(["a"]);
  });
});

describe("applyCollectionFiltersAndSort — tri 2×2", () => {
  it("sorts by completion ↓ (title as tie-breaker)", () => {
    const result = applyCollectionFiltersAndSort(COLLECTION, DEFAULT_COLLECTION_FILTERS);
    expect(titles(result)).toEqual([
      "Étincelles Déferlantes",
      "Zénith Suprême",
      "151",
      "Tempête Argentée",
    ]);
  });

  it("sorts by release date, most recent first", () => {
    const result = applyCollectionFiltersAndSort(
      COLLECTION,
      withFilters({ sort: "release_date_desc" }),
    );
    expect(titles(result)).toEqual([
      "Zénith Suprême",
      "Étincelles Déferlantes",
      "151",
      "Tempête Argentée",
    ]);
  });

  it("sorts by name A–Z, accent and case insensitive", () => {
    const result = applyCollectionFiltersAndSort(COLLECTION, withFilters({ sort: "name_asc" }));
    expect(titles(result)).toEqual([
      "151",
      "Étincelles Déferlantes",
      "Tempête Argentée",
      "Zénith Suprême",
    ]);
  });

  it("falls back to a stable completion order for value ↓ until prices exist (M3)", () => {
    const value = applyCollectionFiltersAndSort(COLLECTION, withFilters({ sort: "value_desc" }));
    const completion = applyCollectionFiltersAndSort(COLLECTION, DEFAULT_COLLECTION_FILTERS);
    expect(titles(value)).toEqual(titles(completion));
  });

  it("keeps pinned binders on top whatever the sort, and never mutates its input", () => {
    const pinned = setSummary(
      "Pinned low",
      "sv",
      "2020-01-01",
      stats("sv0", 1, 1, "in_progress"),
      true,
    );
    const input = [...COLLECTION, pinned];
    const snapshot = titles(input);
    const result = applyCollectionFiltersAndSort(input, withFilters({ sort: "name_asc" }));
    expect(result[0]?.binder.title).toBe("Pinned low");
    expect(titles(input)).toEqual(snapshot);
  });

  it("sorts custom folders by owned ratio, creation date and name", () => {
    const folders = [
      folderSummary("B", 10, 5),
      folderSummary("A", 10, 1),
      folderSummary("C", 0, 0),
    ];
    expect(titles(applyCollectionFiltersAndSort(folders, DEFAULT_COLLECTION_FILTERS))).toEqual([
      "B",
      "A",
      "C",
    ]);
    expect(
      titles(applyCollectionFiltersAndSort(folders, withFilters({ sort: "name_asc" }))),
    ).toEqual(["A", "B", "C"]);
  });
});

describe("applyCollectionFiltersAndSort — filtres", () => {
  it("filters by progress (multi-selection)", () => {
    const inProgress = applyCollectionFiltersAndSort(
      COLLECTION,
      withFilters({ progress: ["in_progress"] }),
    );
    expect(titles(inProgress)).toEqual(["Zénith Suprême", "151"]);
    const several = applyCollectionFiltersAndSort(
      COLLECTION,
      withFilters({ progress: ["completed", "not_started"] }),
    );
    expect([...titles(several)].sort()).toEqual(
      ["Tempête Argentée", "Étincelles Déferlantes"].sort(),
    );
  });

  it("filters by block (multi-blocs)", () => {
    expect(
      titles(applyCollectionFiltersAndSort(COLLECTION, withFilters({ seriesIds: ["swsh"] }))),
    ).toEqual(["Tempête Argentée"]);
    expect(
      applyCollectionFiltersAndSort(COLLECTION, withFilters({ seriesIds: ["sv", "swsh"] })),
    ).toHaveLength(4);
    expect(applyCollectionFiltersAndSort(COLLECTION, withFilters({ seriesIds: ["xy"] }))).toEqual(
      [],
    );
  });

  it("hides binders with 0 owned cards when asked", () => {
    const result = applyCollectionFiltersAndSort(COLLECTION, withFilters({ hideEmptySets: true }));
    expect(titles(result)).not.toContain("Tempête Argentée");
    expect(result).toHaveLength(3);
  });

  it("combines progress, block and hide-empty with AND semantics", () => {
    const result = applyCollectionFiltersAndSort(
      COLLECTION,
      withFilters({
        progress: ["in_progress", "not_started"],
        seriesIds: ["sv"],
        hideEmptySets: true,
      }),
    );
    expect(titles(result)).toEqual(["Zénith Suprême", "151"]);
  });

  it("never excludes custom folders by progress or block, but hides empty folders", () => {
    const folders = [folderSummary("Vide", 0, 0), folderSummary("Plein", 3, 1)];
    const filtered = applyCollectionFiltersAndSort(
      folders,
      withFilters({ progress: ["completed"], seriesIds: ["sv"] }),
    );
    expect(filtered).toHaveLength(2);
    expect(
      titles(applyCollectionFiltersAndSort(folders, withFilters({ hideEmptySets: true }))),
    ).toEqual(["Plein"]);
  });
});

describe("fetchBinders — option « inclure promos / secrètes »", () => {
  it("adds ?extras=0 only when secrets and promos are excluded", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ binders: [] }));
    await fetchBinders(undefined, fetchImpl);
    await fetchBinders(undefined, fetchImpl, { includeSecretsAndPromos: true });
    await fetchBinders(undefined, fetchImpl, { includeSecretsAndPromos: false });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/binders",
      "/api/binders",
      "/api/binders?extras=0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Validation de l'image de cover
// ---------------------------------------------------------------------------

describe("validateCoverFile", () => {
  const file = (name: string, type: string, size = 1000) => ({ name, type, size });

  it("accepts JPEG, PNG and WebP up to 2 MiB included", () => {
    expect(validateCoverFile(file("a.jpg", "image/jpeg"))).toEqual({ ok: true });
    expect(validateCoverFile(file("a.png", "image/png"))).toEqual({ ok: true });
    expect(validateCoverFile(file("a.webp", "image/webp", COVER_MAX_BYTES))).toEqual({ ok: true });
  });

  it("refuses files over 2 MiB, empty files and unknown formats", () => {
    expect(validateCoverFile(file("a.png", "image/png", COVER_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(validateCoverFile(file("a.png", "image/png", 0))).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(validateCoverFile(file("a.gif", "image/gif"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(validateCoverFile(file("a.txt", ""))).toEqual({ ok: false, reason: "unsupported" });
  });

  it("refuses SVG by media type or by extension, even with a spoofed type", () => {
    expect(validateCoverFile(file("a.svg", "image/svg+xml"))).toEqual({ ok: false, reason: "svg" });
    expect(validateCoverFile(file("a.SVG", "image/png"))).toEqual({ ok: false, reason: "svg" });
  });

  it("exposes an accept attribute without SVG", () => {
    expect(COVER_ACCEPT_ATTRIBUTE).toBe("image/jpeg,image/png,image/webp");
  });
});

// ---------------------------------------------------------------------------
// Mutations : PATCH / DELETE / PUT cover
// ---------------------------------------------------------------------------

const BINDER = "33333333-3333-4333-8333-333333333333";

describe("updateBinder / submitBinderInfo", () => {
  it("PATCHes /api/binders/:id with a JSON patch and parses the summary", async () => {
    const updated = summary("custom", null);
    const fetchImpl = vi.fn(async () => json(updated));
    const result = await updateBinder(BINDER, { title: "Neuf", isPinned: true }, fetchImpl);
    expect(result).toEqual({ kind: "ok", data: updated });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/binders/${BINDER}`);
    expect(init.method).toBe("PATCH");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Neuf", isPinned: true });
  });

  it.each([
    [401, "unauthorized"],
    [400, "invalid"],
    [404, "not_found"],
    [500, "error"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const result = await updateBinder(BINDER, { title: "x" }, async () => json({}, status));
    expect(result.kind).toBe(kind);
  });

  it("maps a network failure to error", async () => {
    const result = await updateBinder(BINDER, { title: "x" }, async () => {
      throw new TypeError("offline");
    });
    expect(result).toEqual({ kind: "error" });
  });

  it("validates the title (1..80) before any request", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    expect(await submitBinderInfo(BINDER, "   ", false, fetchImpl)).toEqual({
      kind: "invalid_title",
      reason: "empty",
    });
    expect(await submitBinderInfo(BINDER, "x".repeat(81), false, fetchImpl)).toEqual({
      kind: "invalid_title",
      reason: "too_long",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await submitBinderInfo(BINDER, "  Mon   dossier ", true, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: "Mon dossier", isPinned: true });
  });
});

describe("deleteBinder", () => {
  it("DELETEs /api/binders/:id and accepts 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await deleteBinder(BINDER, fetchImpl)).toEqual({ kind: "ok" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/binders/${BINDER}`);
    expect(init.method).toBe("DELETE");
  });

  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [503, "error"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const result = await deleteBinder(BINDER, async () => json({}, status));
    expect(result.kind).toBe(kind);
  });
});

describe("setBinderCover / uploadBinderCover", () => {
  it("PUTs the logo / card choice as JSON on /cover", async () => {
    const updated = summary("set", "sv08");
    const fetchImpl = vi.fn(async () => json(updated));
    expect(await setBinderCover(BINDER, { type: "set_logo" }, fetchImpl)).toEqual({
      kind: "ok",
      data: updated,
    });
    await setBinderCover(BINDER, { type: "card", cardId: "sv08-001" }, fetchImpl);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe(`/api/binders/${BINDER}/cover`);
    expect(calls[0]?.[1].method).toBe("PUT");
    expect(new Headers(calls[0]?.[1].headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual({ type: "set_logo" });
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({ type: "card", cardId: "sv08-001" });
  });

  it.each([
    [400, "invalid"],
    [404, "not_found"],
    [413, "too_large"],
    [415, "unsupported"],
    [502, "error"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const result = await setBinderCover(BINDER, { type: "set_logo" }, async () => json({}, status));
    expect(result.kind).toBe(kind);
  });

  it("uploads multipart/form-data with the `image` field and no manual Content-Type", async () => {
    const updated = summary("custom", null);
    const fetchImpl = vi.fn(async () => json(updated));
    const image = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    expect(await uploadBinderCover(BINDER, image, fetchImpl)).toEqual({
      kind: "ok",
      data: updated,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/binders/${BINDER}/cover`);
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const sent = form.get("image");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("cover.png");
  });

  it("never sends a refused file (SVG, too large) to the server", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    expect(await uploadBinderCover(BINDER, svg, fetchImpl)).toEqual({
      kind: "invalid_file",
      reason: "svg",
    });
    const big = new File([new Uint8Array(COVER_MAX_BYTES + 1)], "big.png", { type: "image/png" });
    expect(await uploadBinderCover(BINDER, big, fetchImpl)).toEqual({
      kind: "invalid_file",
      reason: "too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
