import type { SearchQuery } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  fetchDiscovery,
  fetchResults,
  fetchSuggestions,
  loadRecentSearches,
  RECENT_SEARCHES_STORAGE_KEY,
  type RecentsStorage,
  saveRecentSearches,
  searchQueryToParams,
} from "./search-client.ts";

const memoryStorage = (initial?: string): RecentsStorage & { value: string | null } => {
  const store = { value: initial ?? null };
  return {
    get value() {
      return store.value;
    },
    getItem: () => store.value,
    setItem: (_key, value) => {
      store.value = value;
    },
  };
};

describe("recent searches storage", () => {
  it("round-trips the history through localStorage", () => {
    const storage = memoryStorage();
    saveRecentSearches(["Mew", "Pikachu"], storage);
    expect(storage.value).toBe('["Mew","Pikachu"]');
    expect(loadRecentSearches(storage)).toEqual(["Mew", "Pikachu"]);
  });

  it("uses a namespaced key", () => {
    expect(RECENT_SEARCHES_STORAGE_KEY).toBe("pokevault.search.recents");
  });

  it("ignores corrupted, non-array and non-string content", () => {
    expect(loadRecentSearches(memoryStorage("{not json"))).toEqual([]);
    expect(loadRecentSearches(memoryStorage('{"a":1}'))).toEqual([]);
    expect(loadRecentSearches(memoryStorage('["ok", 3, "", "  ", null, "bon"]'))).toEqual([
      "ok",
      "bon",
    ]);
    expect(loadRecentSearches(memoryStorage())).toEqual([]);
  });

  it("caps the loaded history at 8 entries", () => {
    const many = JSON.stringify(Array.from({ length: 20 }, (_, index) => `q${index}`));
    expect(loadRecentSearches(memoryStorage(many))).toHaveLength(8);
  });

  it("never throws when storage is unavailable or throws (private mode, quota)", () => {
    const throwing: RecentsStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadRecentSearches(throwing)).toEqual([]);
    expect(() => saveRecentSearches(["a"], throwing)).not.toThrow();
    expect(loadRecentSearches(null)).toEqual([]);
    expect(() => saveRecentSearches(["a"], null)).not.toThrow();
  });
});

describe("searchQueryToParams", () => {
  it("serialises mandatory fields and omits inactive filters", () => {
    const query: SearchQuery = {
      q: "dracaufeu ex",
      scope: "cards",
      sort: "name",
      limit: 24,
      offset: 48,
    };
    expect(searchQueryToParams(query).toString()).toBe(
      "q=dracaufeu+ex&scope=cards&sort=name&limit=24&offset=48",
    );
  });

  it("includes quickAccess and setId when present", () => {
    const params = searchQueryToParams({
      q: "",
      scope: "all",
      sort: "relevance",
      limit: 24,
      offset: 0,
      quickAccess: "sir",
      setId: "sv03.5",
    });
    expect(params.get("quickAccess")).toBe("sir");
    expect(params.get("setId")).toBe("sv03.5");
  });
});

describe("API helpers", () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  it("fetchDiscovery returns data on 200 and sends same-origin credentials", async () => {
    const fetchMock = vi.fn(async () => json({ popularSets: [], featuredCards: [] }));
    const result = await fetchDiscovery(undefined, fetchMock);
    expect(result).toEqual({ kind: "ok", data: { popularSets: [], featuredCards: [] } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/catalog/discover",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
  });

  it("maps 401 to unauthorized and other failures to error", async () => {
    expect(await fetchSuggestions("a", undefined, async () => json({}, 401))).toEqual({
      kind: "unauthorized",
    });
    expect(await fetchSuggestions("a", undefined, async () => json({}, 503))).toEqual({
      kind: "error",
    });
    expect(
      await fetchResults(
        { q: "a", scope: "all", sort: "relevance", limit: 24, offset: 0 },
        undefined,
        async () => {
          throw new TypeError("network");
        },
      ),
    ).toEqual({ kind: "error" });
  });

  it("url-encodes the suggestion query", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      json({ query: "a&b", cards: [], sets: [] }),
    );
    await fetchSuggestions("a&b #1", undefined, fetchMock);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/catalog/suggest?q=a%26b+%231");
  });

  it("re-throws an aborted request so callers can ignore it", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortingFetch = async (_input: string, init?: RequestInit): Promise<Response> => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return json({});
    };
    await expect(fetchSuggestions("a", controller.signal, abortingFetch)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
