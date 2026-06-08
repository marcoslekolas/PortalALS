/* ========================================================================
   Portal ALS — Auth Guard
   ------------------------------------------------------------------------
   Sistema centralizado de autenticación, autorización e inactividad.
   Único punto de verdad sobre quién está autenticado, qué puede hacer y
   cuándo expira la sesión. Cargado por TODOS los módulos del portal antes
   de cualquier otro código.

   Cómo lo usa CADA módulo (taric.html, airport_cargo.html, etc.):

     <script src="auth-guard.js"></script>
     <script>
       (async function init(){
         const ok = await PortalGuard.require('nombre_modulo');
         if (!ok) return;  // auth-guard ya redirigió o denegó
         // ... continúa con la inicialización del módulo
         const CU = PortalGuard.CU;
         if (PortalGuard.puedeAcceder('expediciones','crear')) { ... }
       })();
     </script>

   Cómo lo usa index.html (el hub que también gestiona el login):

     <script src="auth-guard.js"></script>
     <script>
       (async function init(){
         await PortalGuard.bootstrap();   // sin require, solo prepara sb
         if (PortalGuard.hasSession()) {
           const ok = await PortalGuard.require(null);  // sin módulo concreto
           if (ok) showHome();
         } else {
           showLoginScreen();
         }
       })();
     </script>

   ========================================================================= */
(function(){
  'use strict';

  // ── Configuración Supabase ─────────────────────────────────────────────
  const SUPABASE_URL  = 'https://bccqfqaehbmmqbisfbyv.supabase.co';
  const SUPABASE_KEY  = 'sb_publishable_tHKTtGyJmYQVnp66v1Dfjw_pCyyrLx1';
  const SUPABASE_JS   = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

  // ── Inactividad ────────────────────────────────────────────────────────
  const WARN_MS              = 30 * 60 * 1000;   // 30 min → mostrar aviso
  const CLOSE_MS             = 35 * 60 * 1000;   // 35 min → cierre forzado
  const ACTIVITY_KEY         = 'als_last_activity';
  const ACTIVITY_THROTTLE_MS = 5000;             // máx 1 escritura cada 5s

  // ── Estado interno ─────────────────────────────────────────────────────
  let sb            = null;
  let CU            = null;
  let permisos      = {};
  let esAdmin       = false;
  let ready         = false;
  let bootstrapping = false;
  let bootstrapped  = false;
  let lastBump      = 0;
  let warnTimer     = null;
  let closeTimer    = null;
  let warnDialog    = null;
  let inactivityActive = false;

  const listeners = { ready: [], logout: [] };

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 1. Carga del SDK Supabase + cliente                                  ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  function loadSdkScript(){
    return new Promise((resolve, reject) => {
      if (window.supabase && window.supabase.createClient) return resolve();
      const s = document.createElement('script');
      s.src = SUPABASE_JS;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('No se pudo cargar Supabase SDK'));
      document.head.appendChild(s);
    });
  }

  async function bootstrap(){
    if (bootstrapped) return sb;
    if (bootstrapping) {
      // Esperar a que termine el bootstrap en curso
      while (bootstrapping) await new Promise(r => setTimeout(r, 50));
      return sb;
    }
    bootstrapping = true;
    try {
      await loadSdkScript();
      if (window.sb && window.sb.auth) {
        sb = window.sb;
      } else {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
        window.sb = sb;
      }
      bootstrapped = true;
    } finally {
      bootstrapping = false;
    }
    return sb;
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 2. Carga de sesión (JWT + perfil + permisos)                         ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  async function hasSession(){
    await bootstrap();
    const { data: { session } } = await sb.auth.getSession();
    return !!session;
  }

  async function loadSession(){
    await bootstrap();

    // 1. JWT?
    const { data: { session }, error: sessErr } = await sb.auth.getSession();
    if (sessErr) {
      console.error('PortalGuard getSession error:', sessErr);
      return { ok: false, reason: 'session_error' };
    }
    if (!session) return { ok: false, reason: 'no_session' };

    // 2. Cargar perfil + roles + permisos via RPC
    const { data, error } = await sb.rpc('app_get_session_data');
    if (error) {
      console.error('PortalGuard rpc app_get_session_data:', error);
      // Si la función no existe aún, fallar limpiamente
      return { ok: false, reason: 'rpc_error', error };
    }
    if (!data) {
      // JWT válido pero usuario no encontrado en tabla usuarios o inactivo
      return { ok: false, reason: 'profile_not_found' };
    }

    CU      = data;
    permisos = data.permisos || {};
    esAdmin  = data.es_admin === true;
    ready    = true;

    // Compatibilidad con código existente que lee window.CU
    try { window.CU = CU; } catch(e) {}

    listeners.ready.forEach(fn => { try { fn(CU); } catch(e) { console.warn(e); } });
    return { ok: true, CU };
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 3. Chequeo de permisos (frontend, espejo de app_user_can en BD)      ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  function puedeAcceder(modulo, accion){
    if (!ready || !CU) return false;        // por defecto DENEGAR
    if (esAdmin) return true;

    accion = accion || 'ver';
    if (!['ver','crear','editar','eliminar','exportar'].includes(accion)) return false;

    // Restricción por modulos_permitidos
    const mp = CU.modulos_permitidos;
    if (Array.isArray(mp) && mp.length > 0 && !mp.includes(modulo)) return false;

    // Permiso granular (mezcla rol + overrides ya calculada en BD)
    const p = permisos[modulo];
    if (!p) return false;
    return p[accion] === true;
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 4. Gestor de inactividad (persistido en localStorage)                ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  function bumpActivity(force){
    const now = Date.now();
    if (!force && now - lastBump < ACTIVITY_THROTTLE_MS) return;
    lastBump = now;
    try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch(e) {}
    resetTimers();
  }

  function resetTimers(){
    if (warnTimer)  { clearTimeout(warnTimer);  warnTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }

    const lastStr = localStorage.getItem(ACTIVITY_KEY);
    const last = lastStr ? parseInt(lastStr, 10) : Date.now();
    const elapsed = Date.now() - last;

    if (elapsed >= CLOSE_MS) { forceLogout('inactivity'); return; }

    if (warnDialog && elapsed < WARN_MS) {
      // Si había aviso pero ahora hay actividad reciente → quitar
      warnDialog.remove(); warnDialog = null;
    }

    const warnIn  = Math.max(0, WARN_MS  - elapsed);
    const closeIn = Math.max(0, CLOSE_MS - elapsed);

    if (elapsed < WARN_MS) {
      warnTimer = setTimeout(showWarn, warnIn);
    } else {
      // Ya pasamos el warn pero no el close → mostrar aviso ya
      showWarn();
    }
    closeTimer = setTimeout(() => forceLogout('inactivity'), closeIn);
  }

  function showWarn(){
    if (warnDialog || !CU) return;
    warnDialog = document.createElement('div');
    warnDialog.id = '_pg_warn';
    warnDialog.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#1e293b;color:#fff;border-radius:14px;padding:16px 24px;display:flex;' +
      'align-items:center;gap:14px;box-shadow:0 8px 32px rgba(0,0,0,.45);font-size:14px;' +
      'max-width:420px;width:90%;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
    warnDialog.innerHTML =
      '<span style="font-size:22px">⏱️</span>' +
      '<div style="flex:1"><div style="font-weight:700;margin-bottom:2px">Sesión a punto de cerrarse</div>' +
      '<div style="opacity:.75;font-size:12px">Tu sesión se cerrará en 5 minutos por inactividad.</div></div>' +
      '<button id="_pg_warn_btn" style="background:#3b82f6;color:#fff;border:none;border-radius:8px;' +
      'padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer">Seguir</button>';
    document.body.appendChild(warnDialog);
    document.getElementById('_pg_warn_btn').addEventListener('click', () => bumpActivity(true));
  }

  async function logAuth(evento, detalle){
    if (!sb) return;
    try {
      await sb.from('als_auth_log').insert({
        evento,
        usuario_id: CU ? CU.id : null,
        usuario_nombre: CU ? CU.nombre : null,
        email_intentado: CU ? CU.email : null,
        detalles: detalle || null,
        user_agent: (navigator.userAgent || '').slice(0, 300)
      });
    } catch(e) { /* schema puede variar; ignorar fallos de log */ }
  }

  async function forceLogout(reason){
    if (warnTimer)  { clearTimeout(warnTimer);  warnTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (warnDialog) { warnDialog.remove(); warnDialog = null; }

    await logAuth(reason === 'inactivity' ? 'inactivity_logout' : 'logout', reason);

    try { if (sb) await sb.auth.signOut(); } catch(e) {}
    try { localStorage.removeItem(ACTIVITY_KEY); } catch(e) {}
    try { localStorage.removeItem('als_cu'); } catch(e) {}
    try { sessionStorage.removeItem('als_cu'); } catch(e) {}

    listeners.logout.forEach(fn => { try { fn(reason); } catch(e) {} });

    // Redirigir al login. URL relativa para funcionar en cualquier subpath.
    const path = window.location.pathname;
    const dir  = path.substring(0, path.lastIndexOf('/') + 1);
    const target = dir + 'index.html' + (reason ? ('?reason=' + encodeURIComponent(reason)) : '');
    window.location.replace(target);
  }

  function startInactivity(){
    if (inactivityActive) return;
    inactivityActive = true;

    // Si al cargar la página ya hemos rebasado CLOSE_MS desde el último bump,
    // cerrar inmediatamente (esto cubre el caso "dejé el portátil dormido").
    const lastStr = localStorage.getItem(ACTIVITY_KEY);
    const last = lastStr ? parseInt(lastStr, 10) : 0;
    if (last > 0 && Date.now() - last >= CLOSE_MS) {
      forceLogout('inactivity_on_load');
      return;
    }

    bumpActivity(true);  // marca el inicio como actividad

    const events = ['mousedown','keydown','touchstart','click','scroll'];
    events.forEach(ev => document.addEventListener(ev, () => bumpActivity(false), { passive: true }));

    // mousemove se trata aparte con throttle más agresivo (evento muy frecuente)
    document.addEventListener('mousemove', () => {
      if (Date.now() - lastBump < 30000) return;
      bumpActivity(false);
    }, { passive: true });

    // Sincronización entre pestañas — si actividad en otra pestaña, resetear timers aquí
    window.addEventListener('storage', (e) => {
      if (e.key === ACTIVITY_KEY) {
        if (e.newValue === null) {
          // Otra pestaña cerró sesión
          forceLogout('cross_tab_logout');
        } else {
          resetTimers();
        }
      }
    });

    resetTimers();
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 5. Pantalla de "acceso denegado"                                     ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  function showAccessDenied(modulo){
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;' +
      'height:100vh;font-family:-apple-system,sans-serif;background:#f9fafb">' +
      '<div style="text-align:center;max-width:480px;padding:32px;background:#fff;' +
      'border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.06)">' +
      '<div style="font-size:48px;margin-bottom:16px">🔒</div>' +
      '<h2 style="margin:0 0 12px 0;color:#1f2937">Acceso denegado</h2>' +
      '<p style="color:#6b7280;margin:0 0 24px 0">No tienes permiso para acceder al módulo <strong>' + modulo + '</strong>.</p>' +
      '<button id="_pg_back" style="background:#2563eb;color:#fff;border:0;padding:10px 24px;' +
      'border-radius:8px;cursor:pointer;font-size:14px;font-weight:500">Volver al portal</button></div></div>';
    const path = window.location.pathname;
    const dir  = path.substring(0, path.lastIndexOf('/') + 1);
    document.getElementById('_pg_back').addEventListener('click', () => {
      window.location.replace(dir + 'index.html');
    });
    setTimeout(() => window.location.replace(dir + 'index.html'), 5000);
  }

  function redirectToLogin(reason){
    const path = window.location.pathname;
    const dir  = path.substring(0, path.lastIndexOf('/') + 1);
    const target = dir + 'index.html' + (reason ? ('?reason=' + encodeURIComponent(reason)) : '');
    window.location.replace(target);
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 6. API pública                                                       ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  // require(moduloRequerido) — Para módulos secundarios (taric, etc.):
  //   1. Verifica que hay sesión, sino redirige al login
  //   2. Carga permisos
  //   3. Verifica acceso al módulo, sino muestra "Acceso denegado" y redirige
  //   4. Arranca inactividad
  //   5. Devuelve true si todo OK, false si redirigió
  async function require(moduloRequerido){
    const result = await loadSession();
    if (!result.ok) {
      if (result.reason === 'no_session') {
        redirectToLogin();
      } else {
        try { await sb.auth.signOut(); } catch(e) {}
        redirectToLogin(result.reason);
      }
      return false;
    }
    if (moduloRequerido && !puedeAcceder(moduloRequerido, 'ver')) {
      showAccessDenied(moduloRequerido);
      return false;
    }
    startInactivity();
    return true;
  }

  // refresh() — Recargar perfil + permisos sin recargar la página.
  // Útil tras editar el propio usuario o si el admin cambia permisos de alguien.
  async function refresh(){
    return await loadSession();
  }

  // logout() — Cierre manual de sesión.
  async function logout(){
    await forceLogout('manual');
  }

  // Exponer
  window.PortalGuard = {
    // núcleo
    bootstrap,
    require,
    refresh,
    logout,
    hasSession,
    // estado (getters dinámicos)
    get sb()        { return sb; },
    get CU()        { return CU; },
    get permisos()  { return permisos; },
    get esAdmin()   { return esAdmin; },
    get ready()     { return ready; },
    // chequeos
    puedeAcceder,
    // eventos
    onReady (fn){ listeners.ready.push(fn);  if (ready) try { fn(CU); } catch(e) {} },
    onLogout(fn){ listeners.logout.push(fn); },
    // constantes (por si index.html necesita conocerlas)
    WARN_MS, CLOSE_MS
  };
})();
