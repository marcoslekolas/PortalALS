// ── ALS Portal Operativo — Service Worker ────────────────────────────
// Versión: actualizar este string al desplegar cambios importantes
const CACHE_NAME = 'als-cw-v1';

// Recursos que se cachean en instalación (shell de la app)
const PRECACHE = [
  './',
  './index.html',
];

// ── Instalación: cachear el shell ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activación: limpiar caches antiguas ───────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: estrategia según tipo de recurso ───────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase, OpenRouter, CDN externos → siempre Network (sin caché)
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('openrouter.ai') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    return; // dejar pasar al browser sin interceptar
  }

  // Solo manejar GET
  if (event.request.method !== 'GET') return;

  // Para el index.html y assets propios: Network First, fallback a caché
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Actualizar caché con la respuesta fresca
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Sin red → servir desde caché
        return caches.match(event.request)
          .then(cached => cached || caches.match('./index.html'));
      })
  );
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
