// Service Worker — Customs Way Clasificador TARIC
// Versión del cache — incrementar para invalidar al actualizar
const CACHE_VERSION = 'cw-taric-v3.2.0';
const STATIC_CACHE = [
  '/PortalALS/taric.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js',
];

// Instalar y cachear recursos estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return cache.addAll(STATIC_CACHE.filter(url => !url.includes('supabase')));
    }).catch(() => {}) // No fallar si algún recurso no está disponible
  );
  self.skipWaiting();
});

// Limpiar caches antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estrategia: Network first para HTML y API, Cache first para recursos estáticos
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Nunca cachear peticiones a APIs (OpenRouter, Supabase)
  if(url.hostname.includes('openrouter') || url.hostname.includes('supabase')){
    return; // deja pasar sin interceptar
  }

  // Para taric.html: network first (siempre la versión más reciente), fallback a cache
  if(url.pathname.endsWith('taric.html')){
    event.respondWith(
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Para CDN y recursos estáticos: cache first
  if(url.hostname.includes('cdn.') || url.hostname.includes('cdnjs.')){
    event.respondWith(
      caches.match(event.request).then(cached => {
        if(cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
  }
});
