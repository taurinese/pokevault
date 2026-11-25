/**
 * PokéVault — Service Worker autonome (docs/05-pwa-mobile.md §1).
 *
 * Stratégies :
 * - App Shell statique (`/assets/*`, `.woff2`) : CacheFirst ; `/icons/*`, manifest : StaleWhileRevalidate.
 * - Images cartes TCGdex (`https://assets.tcgdex.net`) : CacheFirst avec éviction LRU réelle
 *   (600 entrées max, TTL 30 jours) via un cache de métadonnées léger.
 * - Lectures API privées autorisées (GET uniquement) : NetworkFirst avec repli cache hors-ligne.
 *   JAMAIS de mise en cache sur `/api/auth/*`, `/api/shared/*` ni sur les mutations POST/PATCH/DELETE.
 *   Purge immédiate sur `POST /api/auth/logout` ou message `CLEAR_PRIVATE_CACHE`.
 * - Navigation HTML : NetworkFirst avec page de repli hors-ligne propre.
 * - Web Push : gestionnaires `push` et `notificationclick` avec validation anti open-redirect.
 */

const CACHE_VERSION = "v1";
const APP_SHELL_CACHE = `pokevault-shell-${CACHE_VERSION}`;
const CARD_IMAGE_CACHE = `pokevault-tcgdex-images-${CACHE_VERSION}`;
const CARD_IMAGE_META_CACHE = `pokevault-tcgdex-meta-${CACHE_VERSION}`;
const PRIVATE_API_CACHE = `pokevault-private-api-${CACHE_VERSION}`;
const HTML_CACHE = `pokevault-pages-${CACHE_VERSION}`;

const ACTIVE_CACHES = new Set([
  APP_SHELL_CACHE,
  CARD_IMAGE_CACHE,
  CARD_IMAGE_META_CACHE,
  PRIVATE_API_CACHE,
  HTML_CACHE,
]);

const TCGDEX_IMAGE_ORIGIN = "https://assets.tcgdex.net";
const TCGDEX_IMAGE_MAX_ENTRIES = 600;
const TCGDEX_IMAGE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const TCGDEX_IMAGE_MAX_AGE_MS = TCGDEX_IMAGE_MAX_AGE_SECONDS * 1000;

const PRECACHE_URLS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

const PRIVATE_API_ALLOWLIST_PREFIXES = [
  "/api/dashboard",
  "/api/binders",
  "/api/binder-grid/",
  "/api/wishlist",
  "/api/alerts",
  "/api/catalog/",
];

const NEVER_CACHE_API_PREFIXES = [
  "/api/auth/",
  "/api/shared/",
  "/api/push-subscriptions",
  "/api/share-links",
];

const NEVER_CACHE_NAV_PREFIXES = ["/s/", "/login", "/api/"];

const DEFAULT_NOTIFICATION_ICON = "/icons/icon-192.png";
const DEFAULT_NOTIFICATION_BADGE = "/icons/icon-192.png";
const DEFAULT_NOTIFICATION_URL = "/alerts";

const OFFLINE_HTML = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0B0D12" />
    <title>Hors-ligne — PokéVault</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: #0B0D12;
        color: #F4F6FA;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      main {
        max-width: 360px;
        width: 100%;
        padding: 24px;
        border-radius: 16px;
        background: #121620;
        border: 1px solid rgba(255, 255, 255, 0.08);
        text-align: center;
      }
      h1 { margin: 0 0 8px; font-size: 1.25rem; }
      p { margin: 0 0 20px; color: #94A0B8; font-size: 0.925rem; line-height: 1.5; }
      button {
        min-height: 44px;
        padding: 0 20px;
        border-radius: 999px;
        border: 1px solid rgba(245, 196, 61, 0.35);
        background: rgba(245, 196, 61, 0.15);
        color: #F5C43D;
        font-weight: 600;
        font-size: 0.925rem;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Mode hors-ligne</h1>
      <p>Cette page n'est pas encore en cache. Vérifiez votre connexion puis réessayez.</p>
      <button type="button" onclick="window.location.reload()">Réessayer</button>
    </main>
  </body>
</html>`;

/** Vérifie qu'un chemin API est éligible au cache lecture seule (GET uniquement). */
function isCacheablePrivateApiPath(pathname) {
  for (const denied of NEVER_CACHE_API_PREFIXES) {
    if (pathname === denied || pathname.startsWith(denied)) {
      return false;
    }
  }
  for (const allowed of PRIVATE_API_ALLOWLIST_PREFIXES) {
    if (allowed.endsWith("/")) {
      if (pathname.startsWith(allowed)) return true;
    } else if (pathname === allowed || pathname.startsWith(`${allowed}/`)) {
      return true;
    }
  }
  return false;
}

/** Vérifie qu'une route HTML peut être conservée en cache de navigation hors-ligne. */
function isCacheableNavigationPath(pathname) {
  for (const denied of NEVER_CACHE_NAV_PREFIXES) {
    if (pathname === denied || pathname.startsWith(denied)) {
      return false;
    }
  }
  return true;
}

/** Indique si l'asset statique est immuable (hashé par Vite ou police woff2). */
function isImmutableStaticAsset(pathname) {
  return pathname.startsWith("/assets/") || pathname.endsWith(".woff2");
}

/** Indique si l'asset appartient aux fichiers statiques PWA rafraîchis en arrière-plan. */
function isSwrStaticAsset(pathname) {
  return pathname.startsWith("/icons/") || pathname === "/manifest.webmanifest";
}

/**
 * Valide l'URL cible d'une notification (anti open-redirect) :
 * - autorise les chemins internes commençant par `/` (jamais `//`, sans `\` ni caractères de contrôle) ;
 * - convertit une URL absolue de même origine (`self.location.origin`) en chemin interne ;
 * - rejette tout le reste et replie sur `fallback`.
 */
function hasForbiddenUrlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function sanitizeNotificationUrl(rawUrl, origin, fallback = DEFAULT_NOTIFICATION_URL) {
  if (typeof rawUrl !== "string") return fallback;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return fallback;
  if (hasForbiddenUrlChars(trimmed)) return fallback;

  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//")) return fallback;
    try {
      const parsed = new URL(trimmed, "https://pokevault.local");
      if (parsed.origin !== "https://pokevault.local") return fallback;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return fallback;
    }
  }

  if (typeof origin === "string" && origin.length > 0) {
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.origin === origin
      ) {
        const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        return path.startsWith("/") && !path.startsWith("//") ? path : fallback;
      }
    } catch {
      return fallback;
    }
  }

  return fallback;
}

/** Purge les caches contenant des données privées de session (déconnexion / changement de compte). */
async function clearPrivateCaches() {
  await Promise.all([caches.delete(PRIVATE_API_CACHE), caches.delete(HTML_CACHE)]);
}

/** Crée une clé normalisée pour le cache de métadonnées LRU d'une image TCGdex. */
function metaKeyForUrl(url) {
  return new Request(`https://pokevault.sw.meta/tcgdex?u=${encodeURIComponent(url)}`);
}

async function readImageMeta(metaCache, url) {
  const response = await metaCache.match(metaKeyForUrl(url));
  if (!response) return null;
  try {
    const data = await response.json();
    if (data && typeof data.cachedAt === "number" && typeof data.lastAccessedAt === "number") {
      return data;
    }
  } catch {
    // Métadonnée corrompue : traitée comme absente.
  }
  return null;
}

async function writeImageMeta(metaCache, url, meta) {
  await metaCache.put(
    metaKeyForUrl(url),
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** Éviction TTL (30 jours) puis LRU (600 entrées max) sur le cache d'images TCGdex. */
async function pruneCardImageCache(nowMs) {
  const [imageCache, metaCache] = await Promise.all([
    caches.open(CARD_IMAGE_CACHE),
    caches.open(CARD_IMAGE_META_CACHE),
  ]);
  const keys = await imageCache.keys();
  const entries = [];

  for (const req of keys) {
    const meta = await readImageMeta(metaCache, req.url);
    const cachedAt = meta ? meta.cachedAt : 0;
    const lastAccessedAt = meta ? meta.lastAccessedAt : cachedAt;
    if (cachedAt === 0 || nowMs - cachedAt > TCGDEX_IMAGE_MAX_AGE_MS) {
      await Promise.all([imageCache.delete(req), metaCache.delete(metaKeyForUrl(req.url))]);
    } else {
      entries.push({ req, lastAccessedAt });
    }
  }

  if (entries.length > TCGDEX_IMAGE_MAX_ENTRIES) {
    entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const overflow = entries.length - TCGDEX_IMAGE_MAX_ENTRIES;
    const toEvict = entries.slice(0, overflow);
    await Promise.all(
      toEvict.map((item) =>
        Promise.all([imageCache.delete(item.req), metaCache.delete(metaKeyForUrl(item.req.url))]),
      ),
    );
  }
}

/** CacheFirst + LRU (600 entrées / 30 jours) pour les images `assets.tcgdex.net`. */
async function handleTcgdexImageRequest(request, event) {
  const [imageCache, metaCache] = await Promise.all([
    caches.open(CARD_IMAGE_CACHE),
    caches.open(CARD_IMAGE_META_CACHE),
  ]);
  const nowMs = Date.now();
  const cached = await imageCache.match(request);

  if (cached) {
    const meta = await readImageMeta(metaCache, request.url);
    const isFresh = meta !== null && nowMs - meta.cachedAt <= TCGDEX_IMAGE_MAX_AGE_MS;
    if (isFresh) {
      event.waitUntil(
        writeImageMeta(metaCache, request.url, {
          cachedAt: meta.cachedAt,
          lastAccessedAt: nowMs,
        }),
      );
      return cached;
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      const clone = response.clone();
      event.waitUntil(
        (async () => {
          await imageCache.put(request, clone);
          await writeImageMeta(metaCache, request.url, {
            cachedAt: nowMs,
            lastAccessedAt: nowMs,
          });
          await pruneCardImageCache(nowMs);
        })(),
      );
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

/** CacheFirst pour les assets statiques immuables (`/assets/*`, `.woff2`). */
async function handleImmutableAssetRequest(request) {
  const cache = await caches.open(APP_SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}

/** StaleWhileRevalidate pour les icônes et le manifeste. */
async function handleSwrAssetRequest(request, event) {
  const cache = await caches.open(APP_SHELL_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  if (cached) {
    event.waitUntil(networkPromise);
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;
  return new Response(null, { status: 503 });
}

/** NetworkFirst avec repli cache pour les lectures API privées autorisées (GET uniquement). */
async function handlePrivateApiRequest(request) {
  const cache = await caches.open(PRIVATE_API_CACHE);
  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === "basic") {
      await cache.put(request, response.clone());
    } else if (response.status === 401 || response.status === 403) {
      await cache.delete(request);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** NetworkFirst avec page de repli hors-ligne propre pour les navigations HTML. */
async function handleNavigationRequest(request, pathname) {
  const cache = await caches.open(HTML_CACHE);
  const canCache = isCacheableNavigationPath(pathname);

  try {
    const response = await fetch(request);
    if (canCache && response.ok && response.type === "basic" && !response.redirected) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (canCache) {
      const cached = (await cache.match(request)) || (await cache.match("/"));
      if (cached) return cached;
    }
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("pokevault-") && !ACTIVE_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const payload = event.data;
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (payload.type === "CLEAR_PRIVATE_CACHE") {
    event.waitUntil(clearPrivateCaches());
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Purge défensive des caches privés lors d'une déconnexion.
  if (
    url.origin === self.location.origin &&
    request.method === "POST" &&
    url.pathname === "/api/auth/logout"
  ) {
    event.waitUntil(clearPrivateCaches());
    return;
  }

  // Jamais de cache sur les mutations (POST, PATCH, PUT, DELETE, etc.).
  if (request.method !== "GET") {
    return;
  }

  // 1. Images cartes TCGdex (origine externe autorisée uniquement).
  if (url.origin === TCGDEX_IMAGE_ORIGIN) {
    event.respondWith(handleTcgdexImageRequest(request, event));
    return;
  }

  // Ignorer toutes les autres origines externes.
  if (url.origin !== self.location.origin) {
    return;
  }

  // 2. Navigations HTML (mode hors-ligne lecture seule).
  if (request.mode === "navigate") {
    event.respondWith(handleNavigationRequest(request, url.pathname));
    return;
  }

  // 3. Assets statiques de l'App Shell.
  if (isImmutableStaticAsset(url.pathname)) {
    event.respondWith(handleImmutableAssetRequest(request));
    return;
  }
  if (isSwrStaticAsset(url.pathname)) {
    event.respondWith(handleSwrAssetRequest(request, event));
    return;
  }

  // 4. Lectures API privées autorisées (jamais /api/auth/* ni /api/shared/*).
  if (isCacheablePrivateApiPath(url.pathname)) {
    event.respondWith(handlePrivateApiRequest(request));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = parsed;
      }
    } catch {
      try {
        const text = event.data.text();
        if (typeof text === "string" && text.trim().length > 0) {
          payload = { body: text.trim() };
        }
      } catch {
        payload = {};
      }
    }
  }

  const title =
    typeof payload.title === "string" && payload.title.trim().length > 0
      ? payload.title.trim()
      : "PokéVault";
  const body = typeof payload.body === "string" ? payload.body : "";
  const cardId = typeof payload.cardId === "string" ? payload.cardId : undefined;
  const alertId = typeof payload.alertId === "string" ? payload.alertId : undefined;
  const url = sanitizeNotificationUrl(payload.url, self.location.origin, DEFAULT_NOTIFICATION_URL);
  const tag =
    typeof payload.tag === "string" && payload.tag.trim().length > 0
      ? payload.tag.trim()
      : alertId
        ? `pokevault-alert-${alertId}`
        : "pokevault-notification";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: DEFAULT_NOTIFICATION_ICON,
      badge: DEFAULT_NOTIFICATION_BADGE,
      tag,
      data: { url, cardId, alertId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data =
    event.notification.data && typeof event.notification.data === "object"
      ? event.notification.data
      : {};
  const safeUrl = sanitizeNotificationUrl(data.url, self.location.origin, DEFAULT_NOTIFICATION_URL);

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (sameOrigin && "focus" in client) {
          if (typeof client.navigate === "function") {
            try {
              await client.navigate(safeUrl);
            } catch {
              // Certains navigateurs restreignent `navigate` : on focalise quand même l'onglet.
            }
          }
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(safeUrl);
    })(),
  );
});
