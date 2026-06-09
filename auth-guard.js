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
    if (!session) return false;
    // El JWT está vivo, pero ¿ha expirado por INACTIVIDAD según nuestro reloj?
    // Si sí, lo invalidamos AHORA para evitar el bug del "auto-relogin tras dormir".
    const lStr = localStorage.getItem(ACTIVITY_KEY);
    const lLast = lStr ? parseInt(lStr, 10) : 0;
    if (lLast > 0 && Date.now() - lLast >= CLOSE_MS) {
      // Marcar el motivo del cierre para que la próxima carga muestre mensaje claro
      try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
      try { await sb.auth.signOut({ scope: 'local' }); } catch(e) {}
      try { localStorage.removeItem(ACTIVITY_KEY); } catch(e) {}
      try {
        const claves = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('sb-') || k === 'als_cu' || k.startsWith('supabase.auth.'))) claves.push(k);
        }
        claves.forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });
      } catch(e) {}
      return false;
    }
    return true;
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

    // 1b. Aunque el JWT siga vivo, ¿ha expirado por inactividad?
    const lStr = localStorage.getItem(ACTIVITY_KEY);
    const lLast = lStr ? parseInt(lStr, 10) : 0;
    if (lLast > 0 && Date.now() - lLast >= CLOSE_MS) {
      try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
      try { await sb.auth.signOut({ scope: 'local' }); } catch(e) {}
      try { localStorage.removeItem(ACTIVITY_KEY); } catch(e) {}
      return { ok: false, reason: 'inactivity_expired' };
    }

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
    // CRÍTICO: comprobar EXPIRACIÓN antes de cualquier actualización.
    const lastStr0 = localStorage.getItem(ACTIVITY_KEY);
    const last0 = lastStr0 ? parseInt(lastStr0, 10) : 0;
    if (last0 > 0 && (now - last0) >= CLOSE_MS) {
      try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
      forceLogout('inactivity_bump');
      return;
    }
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

    if (elapsed >= CLOSE_MS) {
      try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
      forceLogout('inactivity');
      return;
    }

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

    // 1. Cerrar sesión en Supabase Auth (scope=local elimina solo este cliente)
    try { if (sb) await sb.auth.signOut({ scope: 'local' }); } catch(e) {}

    // 2. Limpieza AGRESIVA: borrar TODAS las keys que Supabase Auth pueda
    // haber dejado en localStorage. Si signOut() falló silenciosamente, esto
    // garantiza que la siguiente carga no vea un JWT válido.
    try {
      const claves = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('sb-') ||
            k === ACTIVITY_KEY ||
            k === 'als_cu' ||
            k.startsWith('supabase.auth.')) {
          claves.push(k);
        }
      }
      claves.forEach(k => { try { localStorage.removeItem(k); } catch(e) {} });
    } catch(e) {}
    try { sessionStorage.removeItem('als_cu'); } catch(e) {}

    listeners.logout.forEach(fn => { try { fn(reason); } catch(e) {} });

    // 3. Redirigir al login. URL relativa para funcionar en cualquier subpath.
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

    // VISIBILITY: cuando la pestaña vuelve a estar visible tras estar en
    // background, comprobar la expiración INMEDIATAMENTE sin esperar a que
    // el usuario interactúe. Los setTimeout pueden estar suspendidos.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const lStr = localStorage.getItem(ACTIVITY_KEY);
      const lLast = lStr ? parseInt(lStr, 10) : 0;
      if (lLast > 0 && Date.now() - lLast >= CLOSE_MS) {
        try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
        forceLogout('inactivity_visibility');
      } else {
        resetTimers();
      }
    });

    // Mismo chequeo en focus (algunos browsers no disparan visibilitychange)
    window.addEventListener('focus', () => {
      const lStr = localStorage.getItem(ACTIVITY_KEY);
      const lLast = lStr ? parseInt(lStr, 10) : 0;
      if (lLast > 0 && Date.now() - lLast >= CLOSE_MS) {
        try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
        forceLogout('inactivity_focus');
      }
    });

    // RED DE SEGURIDAD: verificación periódica cada 60 seg.
    setInterval(() => {
      const lStr = localStorage.getItem(ACTIVITY_KEY);
      const lLast = lStr ? parseInt(lStr, 10) : 0;
      if (lLast > 0 && Date.now() - lLast >= CLOSE_MS) {
        try { localStorage.setItem('als_logout_reason', 'inactivity'); } catch(e) {}
        forceLogout('inactivity_periodic');
      }
    }, 60000);

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

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 7. Header unificado — mountHeader()                                  ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  // Renderiza el mismo header en todos los módulos. Llama una sola vez por
  // página. Uso:
  //   PortalGuard.mountHeader({ mount:'#portal-header', module:'TARIC' });
  //   PortalGuard.mountHeader({ mount:'#portal-header', home:true });

  let _headerStylesInjected = false;
  let _headerCurrentMount   = null;

  function _injectHeaderStyles(){
    if (_headerStylesInjected) return;
    _headerStylesInjected = true;
    const s = document.createElement('style');
    s.id = 'pg-header-styles';
    s.textContent =
      '.pg-header{background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:100;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      ':root.dark .pg-header{background:#0f172a;border-bottom-color:#1e293b}' +
      '.pg-header-inner{display:flex;align-items:center;gap:12px;padding:8px 16px;min-height:56px;max-width:100%}' +
      '.pg-btn-icon{width:38px;height:38px;border-radius:8px;border:1px solid #e5e7eb;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#374151;transition:background .15s,transform .1s;flex-shrink:0;padding:0}' +
      '.pg-btn-icon:hover{background:#f3f4f6}' +
      '.pg-btn-icon:active{transform:scale(.96)}' +
      '.pg-btn-icon svg{width:20px;height:20px}' +
      ':root.dark .pg-btn-icon{border-color:#334155;color:#e5e7eb}' +
      ':root.dark .pg-btn-icon:hover{background:#1e293b}' +
      '.pg-btn-logout{color:#dc2626;border-color:#fecaca}' +
      '.pg-btn-logout:hover{background:#fef2f2}' +
      ':root.dark .pg-btn-logout{border-color:#7f1d1d;color:#fca5a5}' +
      ':root.dark .pg-btn-logout:hover{background:#450a0a}' +
      '.pg-brand{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:#111827;cursor:pointer;padding:6px 10px;border-radius:8px;transition:background .15s}' +
      '.pg-brand:hover{background:#f3f4f6}' +
      ':root.dark .pg-brand{color:#f3f4f6}' +
      ':root.dark .pg-brand:hover{background:#1e293b}' +
      '.pg-brand-pill{background:linear-gradient(135deg,#1e3a8a,#312e81);color:#fff;padding:3px 8px;border-radius:5px;font-size:11px;font-weight:700;letter-spacing:.3px}' +
      '.pg-brand-pill.cw{background:linear-gradient(135deg,#0c4a6e,#0369a1)}' +
      '.pg-breadcrumb{display:flex;align-items:center;gap:6px;font-size:13px;color:#4b5563;flex:1;min-width:0;overflow:hidden}' +
      '.pg-bc-module{font-weight:600;color:#111827;cursor:pointer;white-space:nowrap}' +
      '.pg-bc-module:hover{color:#2563eb}' +
      ':root.dark .pg-bc-module{color:#f3f4f6}' +
      '.pg-bc-sep{width:14px;height:14px;color:#d1d5db;flex-shrink:0}' +
      '.pg-bc-section{color:#4b5563;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      ':root.dark .pg-bc-section{color:#94a3b8}' +
      '.pg-header-right{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:auto}' +
      '.pg-user-wrap{position:relative}' +
      '.pg-user-btn{background:transparent;border:1px solid #e5e7eb;padding:4px 10px 4px 4px;border-radius:10px;display:flex;align-items:center;gap:8px;cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s}' +
      '.pg-user-btn:hover{background:#f9fafb}' +
      '.pg-user-btn.open{background:#eef2ff;border-color:#c7d2fe}' +
      ':root.dark .pg-user-btn{border-color:#334155}' +
      ':root.dark .pg-user-btn:hover{background:#1e293b}' +
      ':root.dark .pg-user-btn.open{background:#1e3a8a;border-color:#3b82f6}' +
      '.pg-avatar{width:30px;height:30px;border-radius:50%;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}' +
      '.pg-user-name{font-size:13px;font-weight:600;color:#1f2937;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}' +
      ':root.dark .pg-user-name{color:#e5e7eb}' +
      '.pg-chevron{width:14px;height:14px;color:#9ca3af;flex-shrink:0;transition:transform .15s}' +
      '.pg-user-btn.open .pg-chevron{transform:rotate(180deg)}' +
      '.pg-user-menu{position:absolute;top:calc(100% + 6px);right:0;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.12);min-width:260px;padding:6px;z-index:200;animation:pg-menu-in .15s ease-out}' +
      ':root.dark .pg-user-menu{background:#0f172a;border-color:#334155;box-shadow:0 12px 32px rgba(0,0,0,.5)}' +
      '@keyframes pg-menu-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}' +
      '.pg-menu-header{padding:12px 14px;border-bottom:1px solid #f3f4f6;margin-bottom:6px}' +
      ':root.dark .pg-menu-header{border-bottom-color:#1e293b}' +
      '.pg-menu-name{font-size:14px;font-weight:600;color:#111827}' +
      ':root.dark .pg-menu-name{color:#f3f4f6}' +
      '.pg-menu-role{font-size:11px;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}' +
      '.pg-menu-email{font-size:12px;color:#6b7280;margin-top:4px}' +
      '.pg-menu-item{width:100%;background:transparent;border:none;padding:9px 14px;display:flex;align-items:center;gap:12px;font-family:inherit;font-size:13px;color:#374151;cursor:pointer;border-radius:7px;text-align:left;transition:background .1s}' +
      '.pg-menu-item:hover{background:#f9fafb}' +
      ':root.dark .pg-menu-item{color:#e5e7eb}' +
      ':root.dark .pg-menu-item:hover{background:#1e293b}' +
      '.pg-menu-item svg{width:18px;height:18px;color:#6b7280;flex-shrink:0}' +
      '.pg-menu-value{margin-left:auto;font-size:11px;color:#6b7280;font-weight:500;text-transform:lowercase}' +
      '.pg-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:30000;display:flex;align-items:center;justify-content:center;padding:20px;animation:pg-overlay-in .15s}' +
      '@keyframes pg-overlay-in{from{opacity:0}to{opacity:1}}' +
      '.pg-modal{background:#fff;border-radius:16px;width:100%;max-width:440px;box-shadow:0 16px 60px rgba(0,0,0,.25);overflow:hidden;animation:pg-modal-in .2s}' +
      '@keyframes pg-modal-in{from{transform:translateY(20px);opacity:0}to{transform:none;opacity:1}}' +
      ':root.dark .pg-modal{background:#0f172a;border:1px solid #334155}' +
      '.pg-modal-hdr{padding:18px 22px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between}' +
      ':root.dark .pg-modal-hdr{border-bottom-color:#1e293b}' +
      '.pg-modal-title{font-size:16px;font-weight:700;color:#111827}' +
      ':root.dark .pg-modal-title{color:#f3f4f6}' +
      '.pg-modal-close{background:transparent;border:none;font-size:22px;color:#9ca3af;cursor:pointer;padding:0;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:6px}' +
      '.pg-modal-close:hover{background:#f3f4f6;color:#374151}' +
      '.pg-modal-body{padding:20px 22px}' +
      '.pg-modal-foot{padding:12px 22px 20px;display:flex;justify-content:flex-end;gap:10px}' +
      '.pg-field{margin-bottom:14px}' +
      '.pg-field label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px}' +
      ':root.dark .pg-field label{color:#e5e7eb}' +
      '.pg-field input{width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit;background:#fff;color:#111827;box-sizing:border-box}' +
      ':root.dark .pg-field input{background:#1e293b;border-color:#334155;color:#f3f4f6}' +
      '.pg-field input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}' +
      '.pg-field .pg-info{font-size:11px;color:#6b7280;margin-top:4px}' +
      '.pg-btn{padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid;transition:all .15s}' +
      '.pg-btn-p{background:#2563eb;color:#fff;border-color:#2563eb}' +
      '.pg-btn-p:hover{background:#1d4ed8}' +
      '.pg-btn-s{background:#fff;color:#374151;border-color:#d1d5db}' +
      '.pg-btn-s:hover{background:#f9fafb}' +
      ':root.dark .pg-btn-s{background:#1e293b;color:#e5e7eb;border-color:#334155}' +
      '@media (max-width:640px){' +
        '.pg-user-name{display:none}' +
        '.pg-bc-section{display:none}' +
        '.pg-header-inner{padding:8px 12px;gap:8px}' +
      '}';
    document.head.appendChild(s);
  }

  // SVG icons inline (no dependencias externas)
  const _ICONS = {
    home:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    logout:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    chevRight:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    user:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    key:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>',
    moon:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    bell:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'
  };

  function _iniciales(nombre){
    if (!nombre) return '?';
    return nombre.split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
  }

  function _nombreCorto(nombre){
    if (!nombre) return '—';
    const parts = nombre.split(' ').filter(Boolean);
    if (parts.length <= 2) return nombre;
    return parts[0] + ' ' + parts[1].charAt(0).toUpperCase() + '.';
  }

  function _temaActual(){
    try {
      const stored = localStorage.getItem('als_theme');
      if (stored === 'dark') return 'oscuro';
      if (stored === 'light') return 'claro';
      return 'auto';
    } catch(e) { return 'claro'; }
  }

  function _notifsActual(){
    if (!('Notification' in window)) return 'no soportadas';
    if (Notification.permission === 'granted') return 'activadas';
    if (Notification.permission === 'denied') return 'bloqueadas';
    return 'por activar';
  }

  function _goHome(){
    // Si estamos en index.html y existe la función volverHome, usarla.
    // Si estamos en un módulo, navegar a index.html.
    if (typeof window.volverHome === 'function') {
      try { window.volverHome(); return; } catch(e) {}
    }
    const path = window.location.pathname;
    const dir  = path.substring(0, path.lastIndexOf('/') + 1);
    window.location.href = dir + 'index.html';
  }

  function _toggleUserMenu(ev){
    if (ev) ev.stopPropagation();
    const btn  = document.getElementById('pg-user-btn');
    const menu = document.getElementById('pg-user-menu');
    if (!btn || !menu) return;
    const isOpen = !menu.hasAttribute('hidden');
    if (isOpen) {
      menu.setAttribute('hidden', '');
      btn.classList.remove('open');
    } else {
      // Actualizar valores dinámicos antes de mostrar
      const tEl = document.getElementById('pg-menu-tema');
      if (tEl) tEl.textContent = _temaActual();
      const nEl = document.getElementById('pg-menu-notifs');
      if (nEl) nEl.textContent = _notifsActual();
      menu.removeAttribute('hidden');
      btn.classList.add('open');
    }
  }

  // Cerrar menú al hacer click fuera
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.pg-user-wrap');
    if (!wrap || wrap.contains(e.target)) return;
    const menu = document.getElementById('pg-user-menu');
    const btn  = document.getElementById('pg-user-btn');
    if (menu && !menu.hasAttribute('hidden')) {
      menu.setAttribute('hidden', '');
      if (btn) btn.classList.remove('open');
    }
  });

  // ── Modales ─────────────────────────────────────────────────────────────
  function _closeModal(){
    const m = document.getElementById('pg-modal-overlay');
    if (m) m.remove();
  }
  function _renderModal(title, bodyHtml, footHtml){
    _closeModal();
    const overlay = document.createElement('div');
    overlay.id = 'pg-modal-overlay';
    overlay.className = 'pg-modal-overlay';
    overlay.innerHTML =
      '<div class="pg-modal" onclick="event.stopPropagation()">' +
        '<div class="pg-modal-hdr"><div class="pg-modal-title">' + title + '</div>' +
        '<button class="pg-modal-close" onclick="PortalGuard._closeModal()" aria-label="Cerrar">×</button></div>' +
        '<div class="pg-modal-body">' + bodyHtml + '</div>' +
        (footHtml ? '<div class="pg-modal-foot">' + footHtml + '</div>' : '') +
      '</div>';
    overlay.addEventListener('click', _closeModal);
    document.body.appendChild(overlay);
  }

  function openProfile(){
    _toggleUserMenu();
    const cu = CU || {};
    const body =
      '<div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">' +
        '<div class="pg-avatar" style="width:48px;height:48px;font-size:16px">' + _iniciales(cu.nombre) + '</div>' +
        '<div><div style="font-size:16px;font-weight:700">' + (cu.nombre||'—') + '</div>' +
        '<div style="font-size:12px;color:#6b7280;margin-top:2px">' + (cu.rol||'usuario') + (esAdmin?' · admin':'') + '</div></div>' +
      '</div>' +
      '<div style="font-size:13px;color:#374151;line-height:1.7">' +
        '<div><strong>Email:</strong> ' + (cu.email||'—') + '</div>' +
        '<div><strong>Roles:</strong> ' + (cu.roles||[]).join(', ') + '</div>' +
        '<div><strong>Activo:</strong> ' + (cu.activo?'Sí':'No') + '</div>' +
      '</div>';
    _renderModal('Mi perfil', body,
      '<button class="pg-btn pg-btn-s" onclick="PortalGuard._closeModal()">Cerrar</button>');
  }

  function openChangePassword(){
    _toggleUserMenu();
    const body =
      '<div class="pg-field"><label>Contraseña actual</label>' +
        '<input type="password" id="pg-pwd-curr" autocomplete="current-password"/></div>' +
      '<div class="pg-field"><label>Nueva contraseña</label>' +
        '<input type="password" id="pg-pwd-new" autocomplete="new-password"/>' +
        '<div class="pg-info">Mínimo 8 caracteres.</div></div>' +
      '<div class="pg-field"><label>Confirmar nueva contraseña</label>' +
        '<input type="password" id="pg-pwd-new2" autocomplete="new-password"/></div>' +
      '<div id="pg-pwd-msg" style="font-size:12px;margin-top:8px;display:none"></div>';
    _renderModal('Cambiar contraseña', body,
      '<button class="pg-btn pg-btn-s" onclick="PortalGuard._closeModal()">Cancelar</button>' +
      '<button class="pg-btn pg-btn-p" onclick="PortalGuard._submitChangePwd()">Cambiar</button>');
  }

  async function _submitChangePwd(){
    const curr = document.getElementById('pg-pwd-curr').value;
    const n1   = document.getElementById('pg-pwd-new').value;
    const n2   = document.getElementById('pg-pwd-new2').value;
    const msg  = document.getElementById('pg-pwd-msg');
    function show(text, color){ msg.style.display='block'; msg.style.color=color; msg.textContent=text; }
    if (!curr || !n1 || !n2) { show('Rellena todos los campos', '#dc2626'); return; }
    if (n1.length < 8)        { show('La nueva contraseña debe tener al menos 8 caracteres', '#dc2626'); return; }
    if (n1 !== n2)            { show('Las contraseñas nuevas no coinciden', '#dc2626'); return; }
    if (n1 === curr)          { show('La nueva debe ser diferente a la actual', '#dc2626'); return; }
    show('Verificando contraseña actual…', '#6b7280');
    try {
      // Re-autenticar para validar la actual (Supabase no expone validate-only)
      const reauth = await sb.auth.signInWithPassword({ email: (CU && CU.email)||'', password: curr });
      if (reauth.error) { show('Contraseña actual incorrecta', '#dc2626'); return; }
      show('Actualizando…', '#6b7280');
      const upd = await sb.auth.updateUser({ password: n1 });
      if (upd.error) { show('Error: ' + upd.error.message, '#dc2626'); return; }
      show('✅ Contraseña actualizada', '#059669');
      setTimeout(_closeModal, 1500);
    } catch(e) {
      show('Error inesperado: ' + e.message, '#dc2626');
    }
  }

  function toggleTheme(){
    let current;
    try { current = localStorage.getItem('als_theme') || 'auto'; } catch(e) { current = 'auto'; }
    const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
    try { localStorage.setItem('als_theme', next); } catch(e) {}
    _applyTheme(next);
    const tEl = document.getElementById('pg-menu-tema');
    if (tEl) tEl.textContent = _temaActual();
  }

  function _applyTheme(mode){
    const root = document.documentElement;
    if (mode === 'dark')  { root.classList.add('dark'); return; }
    if (mode === 'light') { root.classList.remove('dark'); return; }
    // auto: seguir el sistema
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) root.classList.add('dark'); else root.classList.remove('dark');
  }

  async function toggleNotifs(){
    if (!('Notification' in window)) {
      alert('Tu navegador no soporta notificaciones del sistema.');
      return;
    }
    if (Notification.permission === 'granted') {
      // Ya activadas: no se pueden desactivar programáticamente; explicar al usuario
      alert('Las notificaciones ya están activadas.\n\nPara desactivarlas: usa el icono del candado junto a la URL del navegador y ajusta los permisos.');
      return;
    }
    if (Notification.permission === 'denied') {
      alert('Las notificaciones están bloqueadas por el navegador.\n\nPara activarlas: usa el icono del candado junto a la URL del navegador y permite las notificaciones.');
      return;
    }
    const result = await Notification.requestPermission();
    const nEl = document.getElementById('pg-menu-notifs');
    if (nEl) nEl.textContent = _notifsActual();
    if (result === 'granted') {
      new Notification('Portal ALS', { body: 'Notificaciones activadas' });
    }
  }

  function mountHeader(opts){
    opts = opts || {};
    _injectHeaderStyles();

    // Aplicar tema persistido al cargar
    try {
      const t = localStorage.getItem('als_theme') || 'auto';
      _applyTheme(t);
    } catch(e) {}

    // Buscar el contenedor donde inyectar el header
    let mount;
    if (typeof opts.mount === 'string') {
      mount = document.querySelector(opts.mount);
    } else if (opts.mount instanceof Element) {
      mount = opts.mount;
    }
    if (!mount) {
      // Crear uno automáticamente al inicio del body
      mount = document.createElement('div');
      mount.id = 'pg-header-auto-mount';
      document.body.insertBefore(mount, document.body.firstChild);
    }
    _headerCurrentMount = mount;

    const cu = CU || {};
    const initiales = _iniciales(cu.nombre);
    const nombreCorto = _nombreCorto(cu.nombre);

    // Izquierda: en home muestra brand pills, en módulo muestra home + breadcrumb
    let leftHtml;
    if (opts.home) {
      leftHtml =
        '<div class="pg-brand" onclick="window.location.reload()">' +
          '<span class="pg-brand-pill">ALS</span>' +
          '<span class="pg-brand-pill cw">CW</span>' +
          '<span>Portal Operativo</span>' +
        '</div>';
    } else {
      const mod = opts.module || 'Módulo';
      const sec = opts.section || '';
      leftHtml =
        '<button class="pg-btn-icon" onclick="PortalGuard._goHome()" title="Inicio" aria-label="Volver al inicio">' + _ICONS.home + '</button>' +
        '<div class="pg-breadcrumb">' +
          '<span class="pg-bc-module" onclick="PortalGuard._goHome()">' + mod + '</span>' +
          (sec ? '<span class="pg-bc-sep">' + _ICONS.chevRight + '</span><span class="pg-bc-section">' + sec + '</span>' : '') +
        '</div>';
    }

    // Header HTML
    mount.innerHTML =
      '<header class="pg-header"><div class="pg-header-inner">' +
        leftHtml +
        '<div class="pg-header-right">' +
          '<div class="pg-user-wrap">' +
            '<button id="pg-user-btn" class="pg-user-btn" onclick="PortalGuard._toggleUserMenu(event)">' +
              '<span class="pg-avatar">' + initiales + '</span>' +
              '<span class="pg-user-name">' + nombreCorto + '</span>' +
              '<span class="pg-chevron">' + _ICONS.chevDown + '</span>' +
            '</button>' +
            '<div id="pg-user-menu" class="pg-user-menu" hidden>' +
              '<div class="pg-menu-header">' +
                '<div class="pg-menu-name">' + (cu.nombre||'—') + '</div>' +
                '<div class="pg-menu-role">' + (cu.rol||'usuario') + (esAdmin?' · admin':'') + '</div>' +
                '<div class="pg-menu-email">' + (cu.email||'') + '</div>' +
              '</div>' +
              '<button class="pg-menu-item" onclick="PortalGuard.openProfile()">' +
                _ICONS.user + '<span>Mi perfil</span></button>' +
              '<button class="pg-menu-item" onclick="PortalGuard.openChangePassword()">' +
                _ICONS.key + '<span>Cambiar contraseña</span></button>' +
              '<button class="pg-menu-item" onclick="PortalGuard.toggleTheme()">' +
                _ICONS.moon + '<span>Tema</span><span class="pg-menu-value" id="pg-menu-tema">' + _temaActual() + '</span></button>' +
              '<button class="pg-menu-item" onclick="PortalGuard.toggleNotifs()">' +
                _ICONS.bell + '<span>Notificaciones</span><span class="pg-menu-value" id="pg-menu-notifs">' + _notifsActual() + '</span></button>' +
            '</div>' +
          '</div>' +
          '<button class="pg-btn-icon pg-btn-logout" onclick="PortalGuard.logout()" title="Cerrar sesión" aria-label="Cerrar sesión">' +
            _ICONS.logout +
          '</button>' +
        '</div>' +
      '</div></header>';
  }

  // Re-render solo del breadcrumb (al cambiar de vista dentro del mismo módulo)
  function updateBreadcrumb(module, section){
    const modEl = document.querySelector('.pg-bc-module');
    const secEl = document.querySelector('.pg-bc-section');
    if (modEl && module) modEl.textContent = module;
    if (secEl) secEl.textContent = section || '';
  }

  // Exponer
  window.PortalGuard = {
    // núcleo
    bootstrap,
    require,
    refresh,
    logout,
    hasSession,
    _startInactivity: startInactivity,
    // header unificado
    mountHeader,
    updateBreadcrumb,
    openProfile,
    openChangePassword,
    toggleTheme,
    toggleNotifs,
    _goHome,
    _toggleUserMenu,
    _closeModal,
    _submitChangePwd,
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
