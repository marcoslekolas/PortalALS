// Service Worker — Portal Operativo ALS · Customs Way
// v3.2.0 — Cache offline para todos los módulos

const CACHE_NAME = 'als-portal-v3.2.0';

// Recursos estáticos a pre-cachear
const STATIC_ASSETS = [
  '/PortalALS/index.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
];

// ── Instalación: pre-cachear recursos estáticos ───────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Solo cachear el HTML principal — las librerías pueden fallar en CDN
      return cache.add('/PortalALS/index.html').catch(() => {});
    })
  );
});

// ── Activación: limpiar caches antiguas ──────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== 'cw-taric-v3.2.0')
            .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: estrategia por tipo de recurso ────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // NUNCA cachear: APIs, Supabase, OpenRouter, autenticación
  if(
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('openrouter.ai') ||
    url.hostname.includes('aeat.es') ||
    url.hostname.includes('ec.europa.eu') ||
    url.pathname.includes('/rest/v1/') ||
    url.pathname.includes('/functions/v1/') ||
    url.pathname.includes('/auth/') ||
    event.request.method !== 'GET'
  ){
    return; // dejar pasar sin interceptar
  }

  // HTML principal: Network First (siempre la versión más reciente)
  if(url.pathname.endsWith('.html') || url.pathname.endsWith('/')){
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          // Guardar copia fresca en cache
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request)) // offline: usar cache
    );
    return;
  }

  // JS/CSS de CDN: Cache First (cambian con versión)
  if(
    url.hostname.includes('cdn.jsdelivr') ||
    url.hostname.includes('cdnjs.cloudflare')
  ){
    event.respondWith(
      caches.match(event.request).then(cached => {
        if(cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Imágenes/fuentes de GitHub Pages: Cache First
  if(url.hostname.includes('github.io')){
    event.respondWith(
      caches.match(event.request).then(cached => {
        if(cached) return cached;
        return fetch(event.request).then(response => {
          if(response.ok){
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => caches.match(event.request));
      })
    );
    return;
  }

  // Todo lo demás: Network First con fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Notificaciones push (preparado para futuro) ──────────────
self.addEventListener('push', event => {
  if(!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'ALS Portal', {
    body: data.body || '',
    icon: '/PortalALS/icon-192.png',
    badge: '/PortalALS/icon-192.png',
    tag: data.tag || 'als-notif',
    data: { url: data.url || '/PortalALS/' }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || '/PortalALS/')
  );
});
