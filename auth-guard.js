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

    // CRÍTICO: eliminar cualquier header anterior. Pueden existir varios
    // mount-points (#pg-header-home, #pg-header-app, etc.) y si quedan dos
    // con los mismos IDs (pg-user-btn, pg-user-menu) el dropdown apunta al
    // header oculto y nada se despliega visualmente.
    document.querySelectorAll('.pg-header').forEach(h => h.remove());

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

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 8. ICONIZE — sustituye emojis por iconos SVG outline (Fase 3)        ║
  // ║ Solo en sidebar (.ni) y cards del home (.hm-card-icon).              ║
  // ║ Para DESACTIVAR: comentar la llamada _iconizeBoot() al final.        ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  function _svg(inner){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em;display:inline-block;vertical-align:-0.12em">' + inner + '</svg>';
  }
  const _ICONMAP = {
    '\u{1F3E0}': _svg('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),                                  // 🏠
    '\u{1F6F3}': _svg('<path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76"/><path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/><path d="M12 10v4"/><path d="M12 2v3"/>'), // 🛳
    '\u2693':    _svg('<circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>'),                          // ⚓
    '\u{1F4C5}': _svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'), // 📅
    '\u{1F5D3}\uFE0F': _svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'), // 🗓️
    '\u{1F4CA}': _svg('<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>'),                    // 📊
    '\u{1F4C8}': _svg('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>'),                                                 // 📈
    '\u{1F39B}': _svg('<rect x="3" y="3" width="6" height="18" rx="1"/><rect x="10" y="3" width="4" height="12" rx="1"/><rect x="15" y="3" width="6" height="8" rx="1"/>'), // 🎛 kanban
    '\u{1F69B}': _svg('<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18h-5"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>'), // 🚛
    '\u{1F4E6}': _svg('<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'), // 📦
    '\u{1F514}': _svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),                                       // 🔔
    '\u26A0\uFE0F': _svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'), // ⚠️
    '\u{1F3E2}': _svg('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>'), // 🏢
    '\u{1F4B6}': _svg('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>'),    // 💶
    '\u{1F4B0}': _svg('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>'),    // 💰
    '\u{1F4C4}': _svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'), // 📄
    '\u2708\uFE0F': _svg('<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'), // ✈️
    '\u26A1':    _svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),                                                                            // ⚡
    '\u{1F3DB}': _svg('<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>'), // 🏛
    '\u{1F465}': _svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'), // 👥
    '\u{1F464}': _svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),                                                   // 👤
    '\u{1F4CB}': _svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),  // 📋
    '\u{1F511}': _svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),                                      // 🔑
    '\u{1F3F7}\uFE0F': _svg('<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>'),              // 🏷️
    '\u{1F4F8}': _svg('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'), // 📸
    '\u{1F50E}': _svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),                                                          // 🔎
    '\u{1F50D}': _svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),                                                          // 🔍
    '\u2699\uFE0F': _svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'), // ⚙️
    '\u{1F4DD}': _svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),                                                     // 📝
    '\u{1F551}': _svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),                                                                 // 🕑
    '\u{1F1EA}\u{1F1FA}': _svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'), // 🇪🇺
    '\u{1F4DC}': _svg('<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/>'),                     // 📜
    '\u2705':    _svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),                                              // ✅
    '\u{1F4E7}': _svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
    '\u{1F4F0}': _svg('<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8V6Z"/>'),
    '\u{1F5C2}': _svg('<path d="M22 20V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z"/><path d="M2 10h20"/>'),
    '\u{1F4C1}': _svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
    '\u{1F9E0}': _svg('<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/>'),
    '\u{1F4D1}': _svg('<path d="M16 8.7c0-1-.8-1.7-1.7-1.7H6.7C5.8 7 5 7.8 5 8.7v10.6c0 .9.8 1.7 1.7 1.7h7.6c.9 0 1.7-.8 1.7-1.7Z"/><path d="M19 15.3V5.7c0-1-.8-1.7-1.7-1.7H9.7"/>'),
    '\u{1F0CF}': _svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h.01M15 16h.01M12 12h.01"/>'),
    '\u{1F5FA}': _svg('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/>'),
    '\u{1F4AC}': _svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    '\u{1F4E8}': _svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><path d="M2 7l4 4"/>')                                 // 📧
  };

  // ── Iconos DUOTONE para las cards del home (relleno suave + línea) ──────
  function _svgDuo(fillPaths, linePaths){
    return '<svg viewBox="0 0 24 24" style="width:1em;height:1em;display:inline-block;vertical-align:-0.12em">' +
      '<g fill="currentColor" opacity="0.22">' + fillPaths + '</g>' +
      '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + linePaths + '</g>' +
    '</svg>';
  }
  const _DUOMAP = {
    // 📦 paquete
    '\u{1F4E6}': _svgDuo(
      '<path d="M12 2 3 7v10l9 5 9-5V7z"/>',
      '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    // ✈️ avión
    '\u2708\uFE0F': _svgDuo(
      '<path d="M21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2 3.4 7.2 9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 4.8 5.6 1-1.4L14 16l3.5-3.5C19 11 21.5 9 21 3z"/>',
      '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'),
    // 🏛 / 🏛️ edificio institucional (aduanas/gibraltar)
    '\u{1F3DB}': _svgDuo(
      '<path d="M12 2 3 7h18z"/><rect x="5" y="10" width="14" height="8"/>',
      '<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>'),
    // 🏢 oficina
    '\u{1F3E2}': _svgDuo(
      '<rect x="4" y="2" width="16" height="20" rx="2"/>',
      '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>'),
    // 💰 dinero
    '\u{1F4B0}': _svgDuo(
      '<circle cx="8" cy="8" r="6"/>',
      '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>'),
    // 🔎 lupa
    '\u{1F50E}': _svgDuo(
      '<circle cx="11" cy="11" r="8"/>',
      '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    // 📄 documento
    '\u{1F4C4}': _svgDuo(
      '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/>',
      '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
    // 🏷️ etiqueta
    '\u{1F3F7}\uFE0F': _svgDuo(
      '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42z"/>',
      '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>'),
    // ⚙️ engranaje
    '\u2699\uFE0F': _svgDuo(
      '<circle cx="12" cy="12" r="9"/>',
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
    // 📅 calendario
    '\u{1F4C5}': _svgDuo(
      '<rect x="3" y="4" width="18" height="18" rx="2"/>',
      '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>')
  };
  function _duoLookup(t){
    return _DUOMAP[t] || _DUOMAP[t.replace(/\uFE0F/g,'')] || _DUOMAP[t + '\uFE0F'] || null;
  }

  function iconize(root){
    try {
      (root || document).querySelectorAll('.ni, .hm-card-icon, .ic').forEach(el => {
        if (el.querySelector('svg')) return;
        const t = (el.textContent || '').trim();
        // Cards del home → duotone; sidebar (.ni,.ic) → outline
        if (el.classList.contains('hm-card-icon')) {
          const duo = _duoLookup(t);
          if (duo) { el.innerHTML = duo; return; }
        }
        const svg = _ICONMAP[t] || _ICONMAP[t.replace(/\uFE0F/g,'')] || _ICONMAP[t + '\uFE0F'];
        if (svg) el.innerHTML = svg;
      });
    } catch(e) {}
  }
  window.PortalGuard.iconize = iconize;
  function _iconizeBoot(){
    iconize();
    // Reaplica tras renders dinámicos (cards del home, cambios de módulo)
    let _pend = null;
    const obs = new MutationObserver(() => {
      if (_pend) return;
      _pend = setTimeout(() => { _pend = null; iconize(); }, 250);
    });
    if (document.body) obs.observe(document.body, { childList:true, subtree:true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _iconizeBoot);
  else _iconizeBoot();


  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ 9. ALMACÉN MÓVIL — confirmaciones full-screen + háptica + alto contr. ║
  // ║ Activa la clase body.alm-movil solo en ≤768px dentro del almacén.    ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  const AlmMovil = {
    esMovil(){ return window.matchMedia('(max-width:768px)').matches; },
    activar(){
      if(document.body) document.body.classList.add('alm-movil');
      this._injectHCToggle();
    },
    desactivar(){
      if(document.body){ document.body.classList.remove('alm-movil'); document.body.classList.remove('alm-hc'); }
      const t = document.getElementById('alm-hc-toggle'); if(t) t.remove();
    },
    _injectHCToggle(){
      if(!this.esMovil() || document.getElementById('alm-hc-toggle')) return;
      const b = document.createElement('button');
      b.id = 'alm-hc-toggle';
      b.title = 'Alto contraste (sol)';
      b.textContent = '\u2600\uFE0F';
      b.onclick = () => {
        document.body.classList.toggle('alm-hc');
        try{ localStorage.setItem('als_alm_hc', document.body.classList.contains('alm-hc')?'1':'0'); }catch(e){}
        AlmMovil.vibrar(15);
      };
      document.body.appendChild(b);
      try{ if(localStorage.getItem('als_alm_hc')==='1') document.body.classList.add('alm-hc'); }catch(e){}
    },
    vibrar(ms){ try{ if(navigator.vibrate) navigator.vibrate(ms||20); }catch(e){} },
    // Confirmación a pantalla completa. Devuelve Promise<boolean>.
    confirmar(opts){
      opts = opts || {};
      return new Promise(resolve => {
        const ov = document.createElement('div');
        ov.className = 'alm-confirm-overlay';
        ov.innerHTML =
          '<div class="alm-confirm-card">' +
            '<div class="alm-confirm-icon">' + (opts.icon || '\u2753') + '</div>' +
            '<div class="alm-confirm-title">' + (opts.title || '\u00bfConfirmar?') + '</div>' +
            (opts.sub ? '<div class="alm-confirm-sub">' + opts.sub + '</div>' : '') +
            '<div class="alm-confirm-btns">' +
              '<button class="alm-cf-ok">' + (opts.okIcon||'') + ' ' + (opts.okText || 'Confirmar') + '</button>' +
              '<button class="alm-cf-cancel">' + (opts.cancelText || 'Cancelar') + '</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(ov);
        AlmMovil.vibrar(12);
        const close = (val) => { ov.remove(); resolve(val); };
        ov.querySelector('.alm-cf-ok').onclick = () => { AlmMovil.vibrar(25); close(true); };
        ov.querySelector('.alm-cf-cancel').onclick = () => close(false);
        ov.addEventListener('click', e => { if(e.target === ov) close(false); });
      });
    },
    // Flash de éxito a pantalla completa (se auto-cierra)
    exito(opts){
      opts = opts || {};
      const fl = document.createElement('div');
      fl.className = 'alm-success-flash';
      fl.innerHTML =
        '<div class="icon">' + (opts.icon || '\u2705') + '</div>' +
        '<div class="txt">' + (opts.text || 'Hecho') + '</div>' +
        (opts.sub ? '<div class="sub">' + opts.sub + '</div>' : '');
      document.body.appendChild(fl);
      AlmMovil.vibrar([20,40,20]);
      setTimeout(() => { fl.style.transition='opacity .25s'; fl.style.opacity='0'; setTimeout(()=>fl.remove(),250); }, opts.duration || 1100);
    }
  };
  window.PortalGuard.AlmMovil = AlmMovil;

})();
