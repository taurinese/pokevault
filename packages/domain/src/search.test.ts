import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  addRecentSearch,
  clearRecentSearches,
  emptyResultsPayload,
  escapeLikePattern,
  MAX_RECENT_SEARCHES,
  parseCardNumberQuery,
  removeRecentSearch,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SearchQuery,
  SearchQuickAccess,
  SearchScope,
  SearchSort,
  SearchViewMode,
  tcgdexCardImageUrl,
  tcgdexSetLogoUrl,
} from "./search.ts";

const decodeQuery = (input: unknown) => Schema.decodeUnknownSync(SearchQuery)(input);

describe("search literals", () => {
  it("accept only their documented values", () => {
    for (const scope of ["all", "cards", "sets", "illustrators"]) {
      expect(Schema.decodeUnknownSync(SearchScope)(scope)).toBe(scope);
    }
    for (const mode of ["grid", "list"]) {
      expect(Schema.decodeUnknownSync(SearchViewMode)(mode)).toBe(mode);
    }
    for (const sort of ["relevance", "number", "name"]) {
      expect(Schema.decodeUnknownSync(SearchSort)(sort)).toBe(sort);
    }
    for (const quick of ["sir", "ar", "ex", "tera", "promos"]) {
      expect(Schema.decodeUnknownSync(SearchQuickAccess)(quick)).toBe(quick);
    }
    expect(() => Schema.decodeUnknownSync(SearchScope)("everything")).toThrow();
    expect(() => Schema.decodeUnknownSync(SearchSort)("price")).toThrow();
    expect(() => Schema.decodeUnknownSync(SearchQuickAccess)("cheap")).toThrow();
    expect(() => Schema.decodeUnknownSync(SearchViewMode)("table")).toThrow();
  });
});

describe("SearchQuery", () => {
  it("fills every default from an empty object", () => {
    expect(decodeQuery({})).toEqual({
      q: "",
      scope: "all",
      sort: "relevance",
      limit: SEARCH_DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it("keeps optional filters absent unless provided", () => {
    const decoded = decodeQuery({ q: "pika", quickAccess: "sir", setId: "sv03.5", limit: 60 });
    expect(decoded).toEqual({
      q: "pika",
      scope: "all",
      quickAccess: "sir",
      setId: "sv03.5",
      sort: "relevance",
      limit: 60,
      offset: 0,
    });
    expect("setId" in decodeQuery({})).toBe(false);
    expect("quickAccess" in decodeQuery({})).toBe(false);
  });

  it("bounds limit to 1..60 and offset to >= 0 (integers only)", () => {
    expect(() => decodeQuery({ limit: 0 })).toThrow();
    expect(() => decodeQuery({ limit: SEARCH_MAX_LIMIT + 1 })).toThrow();
    expect(() => decodeQuery({ limit: 1.5 })).toThrow();
    expect(() => decodeQuery({ offset: -1 })).toThrow();
    expect(() => decodeQuery({ offset: 0.5 })).toThrow();
    expect(decodeQuery({ limit: 1, offset: 120 })).toMatchObject({ limit: 1, offset: 120 });
  });

  it("rejects unknown enums, empty setId and over-long queries", () => {
    expect(() => decodeQuery({ scope: "foo" })).toThrow();
    expect(() => decodeQuery({ sort: "price" })).toThrow();
    expect(() => decodeQuery({ quickAccess: "cheap" })).toThrow();
    expect(() => decodeQuery({ setId: "" })).toThrow();
    expect(() => decodeQuery({ q: "x".repeat(101) })).toThrow();
  });

  it("decodes through Effect with a typed failure", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Schema.decodeUnknownEffect(SearchQuery)({ limit: "many" })),
    );
    expect(failure._tag).toBe("SchemaError");
  });

  it("builds an empty results payload echoing the query", () => {
    const query = decodeQuery({ q: "mew" });
    expect(emptyResultsPayload(query)).toEqual({
      query,
      totalCards: 0,
      totalSets: 0,
      cards: [],
      sets: [],
    });
  });
});

describe("tcgdexCardImageUrl", () => {
  it("appends low/high.webp to the image base URL", () => {
    expect(tcgdexCardImageUrl("https://assets.tcgdex.net/fr/sv/sv03.5/199", "low")).toBe(
      "https://assets.tcgdex.net/fr/sv/sv03.5/199/low.webp",
    );
    expect(tcgdexCardImageUrl("https://assets.tcgdex.net/fr/sv/sv03.5/199", "high")).toBe(
      "https://assets.tcgdex.net/fr/sv/sv03.5/199/high.webp",
    );
  });

  it("ignores trailing slashes and whitespace", () => {
    expect(tcgdexCardImageUrl("https://x.test/a/1///", "low")).toBe("https://x.test/a/1/low.webp");
    expect(tcgdexCardImageUrl("  https://x.test/a/1/ ", "low")).toBe("https://x.test/a/1/low.webp");
  });

  it("returns undefined for null / empty / blank bases", () => {
    expect(tcgdexCardImageUrl(null, "low")).toBeUndefined();
    expect(tcgdexCardImageUrl("", "low")).toBeUndefined();
    expect(tcgdexCardImageUrl("   ", "high")).toBeUndefined();
    expect(tcgdexCardImageUrl("///", "high")).toBeUndefined();
  });
});

describe("tcgdexSetLogoUrl", () => {
  it("adds .webp to the extension-less TCGdex logo URL", () => {
    expect(tcgdexSetLogoUrl("https://assets.tcgdex.net/fr/sv/sv03.5/logo")).toBe(
      "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
    );
    expect(tcgdexSetLogoUrl("https://assets.tcgdex.net/fr/sv/sv03.5/logo/")).toBe(
      "https://assets.tcgdex.net/fr/sv/sv03.5/logo.webp",
    );
  });

  it("keeps an already suffixed URL and handles null / empty", () => {
    expect(tcgdexSetLogoUrl("https://x.test/logo.png")).toBe("https://x.test/logo.png");
    expect(tcgdexSetLogoUrl(null)).toBeUndefined();
    expect(tcgdexSetLogoUrl("  ")).toBeUndefined();
  });
});

describe("parseCardNumberQuery", () => {
  it("parses plain, hashed and zero-padded numbers", () => {
    expect(parseCardNumberQuery("#199")).toEqual({ numeric: 199, normalized: "199" });
    expect(parseCardNumberQuery("199")).toEqual({ numeric: 199, normalized: "199" });
    expect(parseCardNumberQuery("025")).toEqual({ numeric: 25, normalized: "025" });
    expect(parseCardNumberQuery("  # 7 ")).toEqual({ numeric: 7, normalized: "7" });
  });

  it("parses prefixed ids and set-total notation", () => {
    expect(parseCardNumberQuery("TG01")).toEqual({ numeric: 1, normalized: "tg01" });
    expect(parseCardNumberQuery("#sv025")).toEqual({ numeric: 25, normalized: "sv025" });
    expect(parseCardNumberQuery("199/191")).toEqual({ numeric: 199, normalized: "199" });
  });

  it("returns null for words and empty input", () => {
    expect(parseCardNumberQuery("Dracaufeu")).toBeNull();
    expect(parseCardNumberQuery("ex")).toBeNull();
    expect(parseCardNumberQuery("")).toBeNull();
    expect(parseCardNumberQuery("#")).toBeNull();
    expect(parseCardNumberQuery("Pikachu 25")).toBeNull();
    expect(parseCardNumberQuery("12345")).toBeNull();
  });
});

describe("escapeLikePattern", () => {
  it("escapes backslash, percent and underscore", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("%_\\")).toBe("\\%\\_\\\\");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("Dracaufeu ex")).toBe("Dracaufeu ex");
    expect(escapeLikePattern("")).toBe("");
  });
});

describe("recent searches", () => {
  it("adds trimmed entries first and ignores blanks", () => {
    expect(addRecentSearch([], "  Pikachu  ")).toEqual(["Pikachu"]);
    expect(addRecentSearch(["Mew"], "Pikachu")).toEqual(["Pikachu", "Mew"]);
    expect(addRecentSearch(["Mew"], "   ")).toEqual(["Mew"]);
    expect(addRecentSearch(["Mew"], "")).toEqual(["Mew"]);
  });

  it("deduplicates case-insensitively, moving the entry to the front", () => {
    expect(addRecentSearch(["Mew", "Pikachu"], "pikachu")).toEqual(["pikachu", "Mew"]);
    expect(addRecentSearch(["Mew", "Pikachu"], " MEW ")).toEqual(["MEW", "Pikachu"]);
  });

  it("caps the list at 8 entries, dropping the oldest", () => {
    let recents: ReadonlyArray<string> = [];
    for (let index = 1; index <= 12; index += 1) recents = addRecentSearch(recents, `q${index}`);
    expect(recents).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recents[0]).toBe("q12");
    expect(recents.at(-1)).toBe("q5");
  });

  it("removes one entry (case-insensitive) or clears everything", () => {
    expect(removeRecentSearch(["Mew", "Pikachu"], "mew")).toEqual(["Pikachu"]);
    expect(removeRecentSearch(["Mew"], "Absent")).toEqual(["Mew"]);
    expect(clearRecentSearches()).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = Object.freeze(["Mew"]);
    expect(addRecentSearch(input, "Pikachu")).toEqual(["Pikachu", "Mew"]);
    expect(removeRecentSearch(input, "Mew")).toEqual([]);
    expect(input).toEqual(["Mew"]);
  });
});
