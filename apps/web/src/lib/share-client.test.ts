import type { SharedBinderCard, SharedBinderPayload } from "@pokevault/domain";
import { describe, expect, it, vi } from "vitest";
import {
  activeShareLinks,
  copyToClipboard,
  countSharedFilter,
  createShareLink,
  fetchSharedBinder,
  fetchShareLinks,
  filterSharedCards,
  formatShareDate,
  revokeShareLink,
  type ShareLinkEntry,
  sharedBinderApiPath,
  sharedBinderCoverPath,
  sharedCardBadge,
  sharedCompletionPercent,
  sharedPagePath,
  sharedPageUrl,
  updateShareLinkQuantities,
} from "./share-client.ts";

const TOKEN = "A".repeat(43);
const LINK_ID = "44444444-4444-4444-8444-444444444444";

const entry = (overrides: Partial<ShareLinkEntry> = {}): ShareLinkEntry => ({
  id: LINK_ID,
  binderId: "33333333-3333-4333-8333-333333333333",
  binderTitle: "Prisme Évolutif",
  token: TOKEN,
  isActive: true,
  showQuantities: true,
  createdAt: "2026-03-01T10:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

const card = (overrides: Partial<SharedBinderCard> = {}): SharedBinderCard => ({
  cardId: "sv08.5-1",
  localId: "1",
  localIdNumeric: 1,
  nameFr: "Carte 1",
  setCode: "SV08.5",
  rarity: "Commune",
  holoEffect: "none",
  imageBaseUrl: null,
  owned: true,
  quantity: 1,
  copies: [{ language: "FR", variant: "normal", quantity: 1 }],
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("paths & URLs", () => {
  it("builds the public API, cover and page paths", () => {
    expect(sharedBinderApiPath(TOKEN)).toBe(`/api/shared/${TOKEN}`);
    expect(sharedBinderCoverPath(TOKEN)).toBe(`/api/shared/${TOKEN}/cover`);
    expect(sharedPagePath(TOKEN)).toBe(`/s/${TOKEN}`);
  });

  it("encodes a hostile token instead of altering the path", () => {
    expect(sharedBinderApiPath("../x?y")).toBe("/api/shared/..%2Fx%3Fy");
  });

  it("builds the full URL to copy, with or without a known origin", () => {
    expect(sharedPageUrl("https://pokevault.example/", TOKEN)).toBe(
      `https://pokevault.example/s/${TOKEN}`,
    );
    expect(sharedPageUrl("", TOKEN)).toBe(`/s/${TOKEN}`);
    expect(sharedPageUrl(undefined, TOKEN)).toBe(`/s/${TOKEN}`);
  });
});

describe("formatShareDate / activeShareLinks", () => {
  it("formats an ISO date in fr-FR and tolerates garbage", () => {
    expect(formatShareDate("2026-03-12T10:00:00.000Z")).toBe("12 mars 2026");
    expect(formatShareDate("not a date")).toBe("");
  });

  it("keeps only active, non revoked links (order preserved)", () => {
    const links = [
      entry({ id: "a" }),
      entry({ id: "b", isActive: false, revokedAt: "2026-03-02T00:00:00.000Z" }),
      entry({ id: "c" }),
    ];
    expect(activeShareLinks(links).map((link) => link.id)).toEqual(["a", "c"]);
  });
});

describe("filters of the public view", () => {
  const cards = [
    card({ cardId: "a", quantity: 1 }),
    card({ cardId: "b", quantity: 3 }),
    card({ cardId: "c", owned: false, quantity: 0, copies: [] }),
    card({ cardId: "d", quantity: 2 }),
  ];

  it("Toutes keeps every card, Manquantes keeps !owned, Doublons keeps quantity >= 2", () => {
    expect(filterSharedCards(cards, "all", true)).toHaveLength(4);
    expect(filterSharedCards(cards, "missing", true).map((c) => c.cardId)).toEqual(["c"]);
    expect(filterSharedCards(cards, "duplicates", true).map((c) => c.cardId)).toEqual(["b", "d"]);
  });

  it("never infers duplicates when quantities are hidden", () => {
    const hidden = cards.map((c) => ({ ...c, quantity: null }));
    expect(filterSharedCards(hidden, "duplicates", false)).toEqual([]);
    expect(filterSharedCards(cards, "duplicates", false)).toEqual([]);
    expect(countSharedFilter(hidden, "missing", false)).toBe(1);
  });

  it("counts like it filters", () => {
    expect(countSharedFilter(cards, "all", true)).toBe(4);
    expect(countSharedFilter(cards, "duplicates", true)).toBe(2);
    expect(countSharedFilter(cards, "missing", true)).toBe(1);
  });

  it("badge ×N only for quantity >= 2 with visible quantities", () => {
    expect(sharedCardBadge(card({ quantity: 3 }), true)).toBe(3);
    expect(sharedCardBadge(card({ quantity: 1 }), true)).toBeNull();
    expect(sharedCardBadge(card({ quantity: null }), true)).toBeNull();
    expect(sharedCardBadge(card({ quantity: 5 }), false)).toBeNull();
    expect(sharedCardBadge(card({ owned: false, quantity: 0 }), true)).toBeNull();
  });

  it("computes a bounded completion percentage", () => {
    expect(sharedCompletionPercent(1, 3)).toBe(33);
    expect(sharedCompletionPercent(0, 0)).toBe(0);
    expect(sharedCompletionPercent(9, 3)).toBe(100);
  });
});

describe("fetchSharedBinder (public)", () => {
  const payload = { owner: { displayName: "Ada", avatarInitials: "A" } } as SharedBinderPayload;

  it("returns not-found WITHOUT any request for a malformed token", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchSharedBinder("short", undefined, fetchImpl)).toEqual({ kind: "not-found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the public endpoint without credentials and decodes the payload", async () => {
    const fetchImpl = vi.fn(async () => json(payload));
    const result = await fetchSharedBinder(TOKEN, undefined, fetchImpl);
    expect(result).toEqual({ kind: "ok", payload });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/shared/${TOKEN}`);
    expect(init.credentials).toBe("omit");
  });

  it("maps 404 to not-found and other failures to error", async () => {
    expect(await fetchSharedBinder(TOKEN, undefined, async () => json({}, 404))).toEqual({
      kind: "not-found",
    });
    expect(await fetchSharedBinder(TOKEN, undefined, async () => json({}, 503))).toEqual({
      kind: "error",
    });
    expect(
      await fetchSharedBinder(TOKEN, undefined, async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ kind: "error" });
  });

  it("rethrows an abort", async () => {
    await expect(
      fetchSharedBinder(TOKEN, undefined, async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("owner API client", () => {
  it("fetchShareLinks filters by binder and maps 401 / errors", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ links: [entry()], owner: { displayName: "Ada" } }),
    );
    const result = await fetchShareLinks({ binderId: "b-1" }, fetchImpl);
    expect(result.kind).toBe("ok");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/share-links?binderId=b-1");
    expect(await fetchShareLinks({}, async () => json({}, 401))).toEqual({ kind: "unauthorized" });
    expect(await fetchShareLinks({}, async () => json({}, 503))).toEqual({ kind: "error" });
    expect(
      await fetchShareLinks({}, async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ kind: "error" });
  });

  it("createShareLink POSTs JSON and decodes the created link", async () => {
    const fetchImpl = vi.fn(async () => json({ link: entry() }, 201));
    const result = await createShareLink({ binderId: "b-1", showQuantities: false }, fetchImpl);
    expect(result).toEqual({ kind: "ok", link: entry() });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/share-links");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ binderId: "b-1", showQuantities: false });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
  });

  it("createShareLink omits showQuantities when unspecified", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ link: entry() }, 201),
    );
    await createShareLink({ binderId: "b-1" }, fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ binderId: "b-1" });
  });

  it("updateShareLinkQuantities PATCHes and revokeShareLink DELETEs the link", async () => {
    const patchFetch = vi.fn(async () => json({ link: entry({ showQuantities: false }) }));
    const patched = await updateShareLinkQuantities(LINK_ID, false, patchFetch);
    expect(patched.kind).toBe("ok");
    const [patchUrl, patchInit] = patchFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(patchUrl).toBe(`/api/share-links/${LINK_ID}`);
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(String(patchInit.body))).toEqual({ showQuantities: false });

    const deleteFetch = vi.fn(async () =>
      json({ link: entry({ isActive: false, revokedAt: "2026-03-02T00:00:00.000Z" }) }),
    );
    const revoked = await revokeShareLink(LINK_ID, deleteFetch);
    expect(revoked.kind).toBe("ok");
    const [deleteUrl, deleteInit] = deleteFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(deleteUrl).toBe(`/api/share-links/${LINK_ID}`);
    expect(deleteInit.method).toBe("DELETE");
    expect(deleteInit.body).toBeUndefined();
  });

  it("maps mutation statuses to typed results", async () => {
    expect(await revokeShareLink(LINK_ID, async () => json({}, 401))).toEqual({
      kind: "unauthorized",
    });
    expect(await revokeShareLink(LINK_ID, async () => json({}, 404))).toEqual({
      kind: "not-found",
    });
    expect(await revokeShareLink(LINK_ID, async () => json({}, 403))).toEqual({ kind: "error" });
    expect(
      await revokeShareLink(LINK_ID, async () => {
        throw new TypeError("offline");
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("copyToClipboard", () => {
  it("copies and reports success", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyToClipboard("https://x/s/y", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://x/s/y");
  });

  it("reports failure instead of throwing (refused or unavailable)", async () => {
    expect(
      await copyToClipboard("x", {
        writeText: async () => {
          throw new Error("denied");
        },
      }),
    ).toBe(false);
    // Hors navigateur (Node) : aucune API presse-papiers.
    expect(await copyToClipboard("x")).toBe(false);
  });
});
