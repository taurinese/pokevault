import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyServiceWorkerUpdate,
  clearPrivateServiceWorkerCache,
  detectStandaloneMode,
  isIosSafariNonStandalone,
  PWA_UPDATE_AVAILABLE_EVENT,
  readOnlineStatus,
  registerServiceWorker,
  resolveThemeColor,
  SW_CACHE_CONFIG,
  SW_MESSAGE_CLEAR_PRIVATE_CACHE,
  SW_MESSAGE_SKIP_WAITING,
  SW_SCOPE,
  SW_SCRIPT_URL,
  sanitizeNotificationUrl,
  subscribeOnlineStatus,
} from "./pwa.ts";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readPngDimensions = (
  filePath: string,
): { readonly width: number; readonly height: number } => {
  const bytes = readFileSync(filePath);
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  // IHDR chunk starts at byte 8: 4 bytes length, 4 bytes "IHDR", 4 bytes width, 4 bytes height.
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
};

// ---------------------------------------------------------------------------
// 1. Manifest PWA & Icônes réelles sur disque
// ---------------------------------------------------------------------------

describe("manifest.webmanifest & PNG icons", () => {
  interface ManifestIcon {
    readonly src: string;
    readonly sizes: string;
    readonly type: string;
    readonly purpose?: string;
  }
  interface ManifestShortcut {
    readonly name: string;
    readonly url: string;
  }
  interface WebManifest {
    readonly name: string;
    readonly short_name: string;
    readonly lang: string;
    readonly start_url: string;
    readonly scope: string;
    readonly display: string;
    readonly background_color: string;
    readonly theme_color: string;
    readonly icons: ReadonlyArray<ManifestIcon>;
    readonly shortcuts: ReadonlyArray<ManifestShortcut>;
  }

  const manifest = JSON.parse(
    readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf8"),
  ) as WebManifest;

  it("declares PokéVault standalone metadata in fr-FR", () => {
    expect(manifest.name).toBe("PokéVault");
    expect(manifest.short_name).toBe("PokéVault");
    expect(manifest.lang).toBe("fr-FR");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#0B0D12");
    expect(manifest.theme_color).toBe("#0B0D12");
  });

  it("references valid PNG icons on disk (192, 512 any, 512 maskable) + apple-touch-icon 180", () => {
    const icon192 = manifest.icons.find((icon) => icon.sizes === "192x192");
    const icon512 = manifest.icons.find(
      (icon) => icon.sizes === "512x512" && icon.purpose === "any",
    );
    const iconMaskable = manifest.icons.find(
      (icon) => icon.sizes === "512x512" && icon.purpose === "maskable",
    );

    expect(icon192).toBeDefined();
    expect(icon512).toBeDefined();
    expect(iconMaskable).toBeDefined();

    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/")).toBe(true);
      const dims = readPngDimensions(path.join(PUBLIC_DIR, icon.src.slice(1)));
      expect(`${dims.width}x${dims.height}`).toBe(icon.sizes);
    }

    const appleIcon = readPngDimensions(path.join(PUBLIC_DIR, "icons/apple-touch-icon.png"));
    expect(appleIcon).toEqual({ width: 180, height: 180 });
  });

  it("exposes the 3 documented shortcuts (/burst, /search, /wishlist)", () => {
    const urls = manifest.shortcuts.map((shortcut) => shortcut.url);
    expect(urls).toEqual(["/burst", "/search", "/wishlist"]);
    expect(manifest.shortcuts.map((s) => s.name)).toEqual([
      "Saisie rafale",
      "Recherche",
      "Wishlist",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Détection iOS Safari hors mode standalone
// ---------------------------------------------------------------------------

describe("isIosSafariNonStandalone", () => {
  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const IPAD_SAFARI =
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const IPADOS_DESKTOP_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const IPHONE_CHROME =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1";
  const IPHONE_FIREFOX =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15";
  const IPHONE_EDGE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/123.0 Mobile/15E148 Safari/605.1.15";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36";

  it("returns true on iPhone / iPad Safari when not installed (non-standalone)", () => {
    expect(isIosSafariNonStandalone(IPHONE_SAFARI, false)).toBe(true);
    expect(isIosSafariNonStandalone(IPAD_SAFARI, false)).toBe(true);
    expect(isIosSafariNonStandalone(IPADOS_DESKTOP_UA, false, 5)).toBe(true);
  });

  it("returns false when already running in standalone PWA mode", () => {
    expect(isIosSafariNonStandalone(IPHONE_SAFARI, true)).toBe(false);
    expect(isIosSafariNonStandalone(IPAD_SAFARI, true)).toBe(false);
    expect(isIosSafariNonStandalone(IPADOS_DESKTOP_UA, true, 5)).toBe(false);
  });

  it("excludes Chrome, Firefox, Edge on iOS as well as Android and desktop macOS", () => {
    expect(isIosSafariNonStandalone(IPHONE_CHROME, false)).toBe(false);
    expect(isIosSafariNonStandalone(IPHONE_FIREFOX, false)).toBe(false);
    expect(isIosSafariNonStandalone(IPHONE_EDGE, false)).toBe(false);
    expect(isIosSafariNonStandalone(ANDROID_CHROME, false)).toBe(false);
    expect(isIosSafariNonStandalone(IPADOS_DESKTOP_UA, false, 0)).toBe(false);
    expect(isIosSafariNonStandalone("", false)).toBe(false);
  });

  it("detects standalone mode from matchMedia or navigator.standalone", () => {
    expect(detectStandaloneMode(undefined)).toBe(false);
    expect(detectStandaloneMode({ navigator: { standalone: true } })).toBe(true);
    expect(
      detectStandaloneMode({
        navigator: { standalone: false },
        matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }),
      }),
    ).toBe(true);
    expect(
      detectStandaloneMode({
        navigator: { standalone: false },
        matchMedia: () => ({ matches: false }),
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Assainissement URL `notificationclick` (anti open-redirect)
// ---------------------------------------------------------------------------

describe("sanitizeNotificationUrl", () => {
  const ORIGIN = "https://pokevault.example";

  it("allows safe internal paths and same-origin URLs", () => {
    expect(sanitizeNotificationUrl("/alerts", ORIGIN)).toBe("/alerts");
    expect(sanitizeNotificationUrl("/binder/abc-123?card=sv03.5-199#top", ORIGIN)).toBe(
      "/binder/abc-123?card=sv03.5-199#top",
    );
    expect(sanitizeNotificationUrl("https://pokevault.example/alerts?from=push", ORIGIN)).toBe(
      "/alerts?from=push",
    );
  });

  it("blocks open redirects, protocol-relative URLs, dot-segment bypasses, backslashes, scripts and control chars", () => {
    const attacks: ReadonlyArray<unknown> = [
      "https://evil.example/phish",
      "http://evil.example/phish",
      "//evil.example/phish",
      "///evil.example/phish",
      "/.//evil.example/phish",
      "/a/..//evil.example/phish",
      "https://pokevault.example/.//evil.example/phish",
      "/\\evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/alerts\r\nLocation: https://evil.example",
      "",
      "   ",
      null,
      undefined,
      42,
    ];
    for (const attack of attacks) {
      expect(sanitizeNotificationUrl(attack, ORIGIN, "/")).toBe("/");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Theme color, réseau online/offline et cycle de vie SW côté client
// ---------------------------------------------------------------------------

describe("pwa client helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("re-exports resolveThemeColor aligned with Dark (#0B0D12) and Light (#F4F6FA)", () => {
    expect(resolveThemeColor("dark", false)).toBe("#0B0D12");
    expect(resolveThemeColor("light", false)).toBe("#F4F6FA");
    expect(resolveThemeColor("system", true)).toBe("#F4F6FA");
    expect(resolveThemeColor("system", false)).toBe("#0B0D12");
  });

  it("reads online status (true on SSR) and subscribes to online/offline events", () => {
    expect(readOnlineStatus(undefined)).toBe(true);
    expect(readOnlineStatus({ onLine: true })).toBe(true);
    expect(readOnlineStatus({ onLine: false })).toBe(false);

    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener: (type: "online" | "offline", fn: () => void) => {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: "online" | "offline", fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    const seen: boolean[] = [];
    const unsubscribe = subscribeOnlineStatus((online) => seen.push(online), target);

    for (const fn of listeners.get("offline") ?? []) fn();
    for (const fn of listeners.get("online") ?? []) fn();
    unsubscribe();
    for (const fn of listeners.get("offline") ?? []) fn();

    expect(seen).toEqual([false, true]);
  });

  it("is SSR-safe when navigator.serviceWorker is unavailable", async () => {
    expect(await registerServiceWorker()).toBeNull();
    expect(applyServiceWorkerUpdate(null)).toBe(false);
    expect(() => clearPrivateServiceWorkerCache()).not.toThrow();
  });

  it("registers /sw.js, detects waiting updates, sends SKIP_WAITING and CLEAR_PRIVATE_CACHE", async () => {
    const controllerPostMessage = vi.fn();
    const waitingPostMessage = vi.fn();
    const swListeners = new Map<string, Array<() => void>>();
    const windowEvents: string[] = [];

    const waiting = { postMessage: waitingPostMessage } as unknown as ServiceWorker;
    const regListeners = new Map<string, Array<() => void>>();
    const registration = {
      waiting,
      installing: null,
      addEventListener: (type: string, cb: () => void) => {
        const list = regListeners.get(type) ?? [];
        list.push(cb);
        regListeners.set(type, list);
      },
    } as unknown as ServiceWorkerRegistration;

    const register = vi.fn().mockResolvedValue(registration);

    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => windowEvents.push(event.type),
      location: { reload: vi.fn() },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: { postMessage: controllerPostMessage },
        register,
        addEventListener: (type: string, cb: () => void) => {
          const list = swListeners.get(type) ?? [];
          list.push(cb);
          swListeners.set(type, list);
        },
      },
    });

    const onUpdateAvailable = vi.fn();
    const reg = await registerServiceWorker({ onUpdateAvailable });
    expect(register).toHaveBeenCalledWith(SW_SCRIPT_URL, { scope: SW_SCOPE });
    expect(reg).toBe(registration);
    expect(onUpdateAvailable).toHaveBeenCalledWith(registration);
    expect(windowEvents).toContain(PWA_UPDATE_AVAILABLE_EVENT);

    const onReload = vi.fn();
    expect(applyServiceWorkerUpdate(registration, onReload)).toBe(true);
    expect(waitingPostMessage).toHaveBeenCalledWith({ type: SW_MESSAGE_SKIP_WAITING });
    for (const cb of swListeners.get("controllerchange") ?? []) cb();
    expect(onReload).toHaveBeenCalledTimes(1);

    clearPrivateServiceWorkerCache();
    expect(controllerPostMessage).toHaveBeenCalledWith({ type: SW_MESSAGE_CLEAR_PRIVATE_CACHE });
  });

  it("observes an already-installing Service Worker when register() resolves", async () => {
    let state = "installing";
    const stateListeners: Array<() => void> = [];
    const installingWorker = {
      get state() {
        return state;
      },
      addEventListener: (type: string, cb: () => void) => {
        if (type === "statechange") stateListeners.push(cb);
      },
    } as unknown as ServiceWorker;

    const registration = {
      waiting: null,
      installing: installingWorker,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration;

    const windowEvents: string[] = [];
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => windowEvents.push(event.type),
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: { postMessage: vi.fn() },
        register: vi.fn().mockResolvedValue(registration),
      },
    });

    const onUpdateAvailable = vi.fn();
    await registerServiceWorker({ onUpdateAvailable });
    expect(onUpdateAvailable).not.toHaveBeenCalled();

    state = "installed";
    for (const cb of stateListeners) cb();
    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(windowEvents).toContain(PWA_UPDATE_AVAILABLE_EVENT);
  });
});

// ---------------------------------------------------------------------------
// 5. Validation syntaxique, constantes & comportement réel de `public/sw.js`
// ---------------------------------------------------------------------------

describe("public/sw.js", () => {
  const swSource = readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8");

  it("parses cleanly as valid JavaScript and matches SW_CACHE_CONFIG constants", () => {
    expect(() => new Function(swSource)).not.toThrow();
    expect(swSource).toContain(`"${SW_CACHE_CONFIG.tcgdexImageOrigin}"`);
    expect(swSource).toContain(
      `TCGDEX_IMAGE_MAX_ENTRIES = ${SW_CACHE_CONFIG.tcgdexImageMaxEntries}`,
    );
    expect(swSource).toContain("TCGDEX_IMAGE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60");
    expect(swSource).toContain('"/api/auth/"');
    expect(swSource).toContain('"/api/shared/"');
    expect(swSource).toContain('addEventListener("push"');
    expect(swSource).toContain('addEventListener("notificationclick"');
    expect(swSource).toContain("SKIP_WAITING");
    expect(swSource).toContain("CLEAR_PRIVATE_CACHE");
  });

  const createSwSandbox = () => {
    const store = new Map<string, Map<string, Response>>();
    const getBucket = (name: string): Map<string, Response> => {
      let bucket = store.get(name);
      if (bucket === undefined) {
        bucket = new Map();
        store.set(name, bucket);
      }
      return bucket;
    };

    const cachesMock = {
      open: async (name: string) => {
        const bucket = getBucket(name);
        return {
          match: async (req: Request | string) => {
            const key = typeof req === "string" ? req : req.url;
            return bucket.get(key)?.clone();
          },
          put: async (req: Request | string, res: Response) => {
            const key = typeof req === "string" ? req : req.url;
            bucket.set(key, res.clone());
          },
          delete: async (req: Request | string) => {
            const key = typeof req === "string" ? req : req.url;
            return bucket.delete(key);
          },
          keys: async () => [...bucket.keys()].map((url) => new Request(url)),
          addAll: async (urls: ReadonlyArray<string>) => {
            for (const u of urls) {
              bucket.set(`https://pokevault.example${u}`, new Response("ok", { status: 200 }));
            }
          },
        };
      },
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
    };

    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue(null);
    const matchAll = vi.fn().mockResolvedValue([]);
    const claim = vi.fn().mockResolvedValue(undefined);
    const skipWaiting = vi.fn();
    const fetchMock = vi.fn();

    const selfMock = {
      location: { origin: "https://pokevault.example" },
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
        listeners.set(type, handler);
      },
      registration: { showNotification },
      clients: { claim, matchAll, openWindow },
      skipWaiting,
    };

    new Function("self", "caches", "fetch", swSource)(selfMock, cachesMock, fetchMock);

    return {
      store,
      listeners,
      showNotification,
      openWindow,
      matchAll,
      claim,
      skipWaiting,
      fetchMock,
    };
  };

  it("purges old caches on activate and claims clients", async () => {
    const sb = createSwSandbox();
    sb.store.set("pokevault-shell-v0", new Map());
    sb.store.set("pokevault-private-api-v0", new Map());
    sb.store.set("unrelated-cache", new Map());

    const promises: Array<Promise<unknown>> = [];
    sb.listeners.get("activate")?.({ waitUntil: (p: Promise<unknown>) => promises.push(p) });
    await Promise.all(promises);

    expect(sb.store.has("pokevault-shell-v0")).toBe(false);
    expect(sb.store.has("pokevault-private-api-v0")).toBe(false);
    expect(sb.store.has("unrelated-cache")).toBe(true);
    expect(sb.claim).toHaveBeenCalledTimes(1);
  });

  it("caches allowed GET private API calls, never caches /api/auth or /api/shared or POST, and purges on logout", async () => {
    const sb = createSwSandbox();

    const dispatchFetch = async (
      request: Request,
    ): Promise<{ readonly intercepted: boolean; readonly response: Response | undefined }> => {
      let responded: Promise<Response> | undefined;
      const waits: Array<Promise<unknown>> = [];
      sb.listeners.get("fetch")?.({
        request,
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      });
      const response = responded === undefined ? undefined : await responded;
      await Promise.all(waits);
      return { intercepted: responded !== undefined, response };
    };

    // 1. GET /api/dashboard succeeds -> cached in pokevault-private-api-v1
    const okRes = new Response(JSON.stringify({ totalCards: 42 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(okRes, "type", { value: "basic" });
    sb.fetchMock.mockResolvedValueOnce(okRes);

    const first = await dispatchFetch(
      new Request("https://pokevault.example/api/dashboard", { method: "GET" }),
    );
    expect(first.intercepted).toBe(true);
    expect(first.response?.status).toBe(200);
    expect(
      sb.store.get("pokevault-private-api-v1")?.has("https://pokevault.example/api/dashboard"),
    ).toBe(true);

    // 2. Offline fallback serves cached /api/dashboard
    sb.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offlineFallback = await dispatchFetch(
      new Request("https://pokevault.example/api/dashboard", { method: "GET" }),
    );
    expect(offlineFallback.intercepted).toBe(true);
    expect(await offlineFallback.response?.json()).toEqual({ totalCards: 42 });

    // 3. /api/auth/*, /api/shared/* and POST /api/binders are NEVER intercepted/cached
    for (const req of [
      new Request("https://pokevault.example/api/auth/login", { method: "GET" }),
      new Request("https://pokevault.example/api/shared/secret-token", { method: "GET" }),
      new Request("https://pokevault.example/api/binders", { method: "POST" }),
    ]) {
      const result = await dispatchFetch(req);
      expect(result.intercepted).toBe(false);
    }

    // 4. POST /api/auth/logout purges private caches
    const logoutResult = await dispatchFetch(
      new Request("https://pokevault.example/api/auth/logout", { method: "POST" }),
    );
    expect(logoutResult.intercepted).toBe(false);
    expect(sb.store.has("pokevault-private-api-v1")).toBe(false);
  });

  it("handles push notifications defensively and blocks open redirects in notificationclick", async () => {
    const sb = createSwSandbox();

    // Push event with valid JSON
    const pushWaits: Array<Promise<unknown>> = [];
    sb.listeners.get("push")?.({
      data: {
        json: () => ({
          title: "Florizarre-ex #198 · 46,90 €",
          body: "Passée sous ton seuil de 50,00 €",
          url: "https://pokevault.example/alerts",
          cardId: "sv03.5-198",
          alertId: "alert-1",
        }),
      },
      waitUntil: (p: Promise<unknown>) => pushWaits.push(p),
    });
    await Promise.all(pushWaits);

    expect(sb.showNotification).toHaveBeenCalledWith("Florizarre-ex #198 · 46,90 €", {
      body: "Passée sous ton seuil de 50,00 €",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "pokevault-alert-alert-1",
      data: { url: "/alerts", cardId: "sv03.5-198", alertId: "alert-1" },
    });

    // Notification click with malicious cross-origin and dot-segment URLs -> falls back safely to /alerts
    for (const maliciousUrl of [
      "https://evil.example/steal",
      "/.//evil.example/phish",
      "/a/..//evil.example/phish",
    ]) {
      const close = vi.fn();
      const clickWaits: Array<Promise<unknown>> = [];
      sb.listeners.get("notificationclick")?.({
        notification: { close, data: { url: maliciousUrl } },
        waitUntil: (p: Promise<unknown>) => clickWaits.push(p),
      });
      await Promise.all(clickWaits);

      expect(close).toHaveBeenCalledTimes(1);
      expect(sb.openWindow).toHaveBeenLastCalledWith("/alerts");
    }

    // SKIP_WAITING message triggers self.skipWaiting() inside event.waitUntil(...)
    const skipWaits: Array<Promise<unknown>> = [];
    sb.skipWaiting.mockResolvedValueOnce(undefined);
    sb.listeners.get("message")?.({
      data: { type: "SKIP_WAITING" },
      waitUntil: (p: Promise<unknown>) => skipWaits.push(p),
    });
    await Promise.all(skipWaits);
    expect(sb.skipWaiting).toHaveBeenCalledTimes(1);
    expect(skipWaits).toHaveLength(1);
  });

  it("never intercepts navigate requests to /api/* (OAuth login/callback) and purges private caches on callback and 401", async () => {
    const sb = createSwSandbox();

    const dispatchFetch = async (
      request: Request,
    ): Promise<{ readonly intercepted: boolean; readonly response: Response | undefined }> => {
      let responded: Promise<Response> | undefined;
      const waits: Array<Promise<unknown>> = [];
      sb.listeners.get("fetch")?.({
        request,
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      });
      const response = responded === undefined ? undefined : await responded;
      await Promise.all(waits);
      return { intercepted: responded !== undefined, response };
    };

    const makeNavRequest = (url: string): Request => {
      const req = new Request(url, { method: "GET" });
      Object.defineProperty(req, "mode", { value: "navigate" });
      return req;
    };

    // Seed private caches
    sb.store.set(
      "pokevault-private-api-v1",
      new Map([["https://pokevault.example/api/dashboard", new Response("{}")]]),
    );
    sb.store.set(
      "pokevault-pages-v1",
      new Map([["https://pokevault.example/", new Response("<html></html>")]]),
    );

    // Navigate to /api/auth/login and /api/shared/token must NOT be intercepted
    for (const url of [
      "https://pokevault.example/api/auth/login?provider=google",
      "https://pokevault.example/api/shared/some-token",
      "https://pokevault.example/api/dashboard",
    ]) {
      const res = await dispatchFetch(makeNavRequest(url));
      expect(res.intercepted).toBe(false);
    }
    expect(sb.store.has("pokevault-private-api-v1")).toBe(true);

    // Navigate to /api/auth/callback must NOT be intercepted AND must purge private caches
    const callbackRes = await dispatchFetch(
      makeNavRequest("https://pokevault.example/api/auth/callback?code=abc"),
    );
    expect(callbackRes.intercepted).toBe(false);
    expect(sb.store.has("pokevault-private-api-v1")).toBe(false);
    expect(sb.store.has("pokevault-pages-v1")).toBe(false);

    // 401 on cached private API purges both private caches; 403 deletes only the failing entry
    sb.store.set(
      "pokevault-private-api-v1",
      new Map([
        ["https://pokevault.example/api/dashboard", new Response("{}")],
        ["https://pokevault.example/api/wishlist", new Response("[]")],
      ]),
    );
    sb.store.set(
      "pokevault-pages-v1",
      new Map([["https://pokevault.example/", new Response("<html></html>")]]),
    );

    const forbidden = new Response("forbidden", { status: 403 });
    sb.fetchMock.mockResolvedValueOnce(forbidden);
    await dispatchFetch(new Request("https://pokevault.example/api/wishlist", { method: "GET" }));
    expect(
      sb.store.get("pokevault-private-api-v1")?.has("https://pokevault.example/api/wishlist"),
    ).toBe(false);
    expect(
      sb.store.get("pokevault-private-api-v1")?.has("https://pokevault.example/api/dashboard"),
    ).toBe(true);
    expect(sb.store.has("pokevault-pages-v1")).toBe(true);

    const unauthorized = new Response("unauthorized", { status: 401 });
    sb.fetchMock.mockResolvedValueOnce(unauthorized);
    await dispatchFetch(new Request("https://pokevault.example/api/dashboard", { method: "GET" }));
    expect(sb.store.has("pokevault-private-api-v1")).toBe(false);
    expect(sb.store.has("pokevault-pages-v1")).toBe(false);
  });

  it("caches TCGdex images with CacheFirst, handles opaque/206, prevents concurrent write/prune races, and enforces 30d TTL + 600 LRU", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    let currentTime = 1_700_000_000_000;
    nowSpy.mockImplementation(() => currentTime);

    try {
      const sb = createSwSandbox();

      const dispatchFetch = async (
        request: Request,
      ): Promise<{ readonly intercepted: boolean; readonly response: Response | undefined }> => {
        let responded: Promise<Response> | undefined;
        const waits: Array<Promise<unknown>> = [];
        sb.listeners.get("fetch")?.({
          request,
          respondWith: (p: Promise<Response>) => {
            responded = p;
          },
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        });
        const response = responded === undefined ? undefined : await responded;
        await Promise.all(waits);
        return { intercepted: responded !== undefined, response };
      };

      const metaKey = (url: string): string =>
        `https://pokevault.sw.meta/tcgdex?u=${encodeURIComponent(url)}`;

      // 1. Concurrent misses on 2 TCGdex images must keep BOTH images and BOTH meta entries
      const imgA = "https://assets.tcgdex.net/fr/sv/sv03.5/199/high.webp";
      const imgB = "https://assets.tcgdex.net/fr/sv/sv03.5/198/high.webp";
      sb.fetchMock
        .mockResolvedValueOnce(new Response("bytes-a", { status: 200 }))
        .mockResolvedValueOnce(new Response("bytes-b", { status: 200 }));

      await Promise.all([
        dispatchFetch(new Request(imgA, { method: "GET" })),
        dispatchFetch(new Request(imgB, { method: "GET" })),
      ]);

      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgA)).toBe(true);
      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgB)).toBe(true);
      expect(sb.store.get("pokevault-tcgdex-meta-v1")?.has(metaKey(imgA))).toBe(true);
      expect(sb.store.get("pokevault-tcgdex-meta-v1")?.has(metaKey(imgB))).toBe(true);

      // 2. CacheFirst hit serves cached bytes without network and updates lastAccessedAt
      currentTime += 60_000;
      const hitRes = await dispatchFetch(new Request(imgA, { method: "GET" }));
      expect(hitRes.intercepted).toBe(true);
      expect(await hitRes.response?.text()).toBe("bytes-a");
      expect(sb.fetchMock).toHaveBeenCalledTimes(2);
      const updatedMeta = (await sb.store
        .get("pokevault-tcgdex-meta-v1")
        ?.get(metaKey(imgA))
        ?.clone()
        .json()) as { readonly cachedAt: number; readonly lastAccessedAt: number };
      expect(updatedMeta.lastAccessedAt).toBe(currentTime);
      expect(updatedMeta.cachedAt).toBe(currentTime - 60_000);

      // 3. Opaque response is cached; 206 Partial Content is NOT cached
      const imgOpaque = "https://assets.tcgdex.net/fr/sv/sv03.5/001/high.webp";
      const opaqueRes = new Response("opaque-bytes", { status: 200 });
      Object.defineProperty(opaqueRes, "type", { value: "opaque" });
      sb.fetchMock.mockResolvedValueOnce(opaqueRes);
      await dispatchFetch(new Request(imgOpaque, { method: "GET" }));
      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgOpaque)).toBe(true);

      const imgPartial = "https://assets.tcgdex.net/fr/sv/sv03.5/002/high.webp";
      sb.fetchMock.mockResolvedValueOnce(new Response("part", { status: 206 }));
      await dispatchFetch(new Request(imgPartial, { method: "GET" }));
      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgPartial)).toBe(false);

      // 4. Orphan meta + >30d TTL expiration are cleaned up on next sweep
      const orphanMetaUrl = metaKey("https://assets.tcgdex.net/fr/sv/sv03.5/999/high.webp");
      sb.store
        .get("pokevault-tcgdex-meta-v1")
        ?.set(
          orphanMetaUrl,
          new Response(JSON.stringify({ cachedAt: currentTime, lastAccessedAt: currentTime })),
        );

      currentTime += 31 * 24 * 60 * 60 * 1000;
      sb.fetchMock.mockResolvedValueOnce(new Response("bytes-a-fresh", { status: 200 }));
      const refreshed = await dispatchFetch(new Request(imgA, { method: "GET" }));
      expect(await refreshed.response?.text()).toBe("bytes-a-fresh");
      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgA)).toBe(true);
      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgB)).toBe(false);
      expect(sb.store.get("pokevault-tcgdex-images-v1")?.has(imgOpaque)).toBe(false);
      expect(sb.store.get("pokevault-tcgdex-meta-v1")?.has(orphanMetaUrl)).toBe(false);

      // 5. LRU eviction strictly caps at 600 entries and preserves recently accessed entries
      const imgBucket = sb.store.get("pokevault-tcgdex-images-v1");
      const metaBucket = sb.store.get("pokevault-tcgdex-meta-v1");
      imgBucket?.clear();
      metaBucket?.clear();

      for (let i = 0; i < SW_CACHE_CONFIG.tcgdexImageMaxEntries; i += 1) {
        const url = `https://assets.tcgdex.net/fr/sv/sv04/${String(i).padStart(3, "0")}/high.webp`;
        const ts = currentTime - (SW_CACHE_CONFIG.tcgdexImageMaxEntries - i) * 1000;
        imgBucket?.set(url, new Response(`img-${i}`, { status: 200 }));
        metaBucket?.set(
          metaKey(url),
          new Response(JSON.stringify({ cachedAt: ts, lastAccessedAt: ts })),
        );
      }

      // Touch entry #0 so entry #1 becomes the true LRU victim
      const url0 = "https://assets.tcgdex.net/fr/sv/sv04/000/high.webp";
      const url1 = "https://assets.tcgdex.net/fr/sv/sv04/001/high.webp";
      const url600 = "https://assets.tcgdex.net/fr/sv/sv04/600/high.webp";
      currentTime += 10_000;
      await dispatchFetch(new Request(url0, { method: "GET" }));

      currentTime += 1_000;
      sb.fetchMock.mockResolvedValueOnce(new Response("img-600", { status: 200 }));
      await dispatchFetch(new Request(url600, { method: "GET" }));

      expect(imgBucket?.size).toBe(SW_CACHE_CONFIG.tcgdexImageMaxEntries);
      expect(metaBucket?.size).toBe(SW_CACHE_CONFIG.tcgdexImageMaxEntries);
      expect(imgBucket?.has(url0)).toBe(true);
      expect(imgBucket?.has(url600)).toBe(true);
      expect(imgBucket?.has(url1)).toBe(false);
      expect(metaBucket?.has(metaKey(url1))).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
