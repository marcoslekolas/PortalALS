// ── ALS Portal Operativo — Service Worker ────────────────────────────
// La versión se recibe en el query del registro: navigator.serviceWorker
// .register('./sw.js?v=' + APP_VERSION). Así APP_VERSION (en index.html)
// es la ÚNICA fuente de verdad: al subir versión, cambia el nombre de la
// caché, se purga la antigua y se detecta la actualización automáticamente.
const SW_VER = (function(){
  try { return new URL(self.location.href).searchParams.get('v') || 'v0'; }
  catch(e){ return 'v0'; }
})();
const CACHE_NAME = 'als-cw-' + SW_VER;

// Shell mínimo que se cachea en instalación
const PRECACHE = ['./', './index.html'];

// ── Instalación: cachear el shell y activar de inmediato ──────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE.map(u => new Request(u, {cache:'reload'}))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

// ── Activación: limpiar TODAS las caches que no sean la actual ─────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('openrouter.ai') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) return;
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // ¿Navegación / documento HTML? → SIEMPRE fresco de red (no-store)
  const isHTML =
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/');

  if (isHTML) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Resto de assets propios: Network First con actualización de caché
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Permitir que la página fuerce la activación del SW nuevo
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting' || (event.data && event.data.type === 'skipWaiting')) {
    self.skipWaiting();
  }
});

// ── Push notifications (si se implementan en el futuro) ───────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.titulo || 'ALS Portal', {
      body: data.cuerpo || '',
      icon: '/PortalALS/icon-192.png',
      badge: '/PortalALS/icon-192.png',
      tag: data.tag || 'als-notif',
    })
  );
});
