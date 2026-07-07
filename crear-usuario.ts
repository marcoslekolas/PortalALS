// ════════════════════════════════════════════════════════════════════
//  Edge Function: crear-usuario
//  Portal ALS / Customs Way — gestión de cuentas con Supabase Auth
// --------------------------------------------------------------------
//  Acciones (según el cuerpo JSON recibido):
//    • crear (por defecto):   { nombre, email, password, rol }
//    • reset_password:        { accion:'reset_password', email, password }
//
//  Maneja cuentas "fantasma" (soft-deleted): las localiza con la función
//  SQL app_find_auth_user() y las recupera automáticamente.
//
//  Seguridad: SOLO un administrador (app_es_admin()) puede invocarla.
//  Requiere desplegar antes: 13-app-find-auth-user.sql
//  Despliegue: supabase functions deploy crear-usuario
// ════════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Metodo no permitido' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: 'Funcion mal configurada: faltan variables de entorno del proyecto' }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── 1) Autenticacion + verificacion de ADMIN ────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ error: 'No autorizado (falta token de sesion)' }, 401);

  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !caller?.user) return json({ error: 'No autorizado (token invalido o caducado)' }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: isAdmin, error: adminErr } = await userClient.rpc('app_es_admin');
  if (adminErr || isAdmin !== true) {
    return json({ error: 'Solo un administrador puede crear usuarios o cambiar contrasenas' }, 403);
  }

  // ── 2) Cuerpo ───────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Cuerpo JSON invalido' }, 400);
  }

  const accion = String(payload.accion ?? 'crear');
  const email = String(payload.email ?? '').trim().toLowerCase();
  const password = String(payload.password ?? '');

  if (!email) return json({ error: 'Falta el email' }, 400);
  if (!password || password.length < 6) {
    return json({ error: 'La contrasena debe tener al menos 6 caracteres' }, 400);
  }

  // Localiza la cuenta Auth por email, INCLUIDAS las soft-deleted (fantasma).
  // Devuelve { id, deleted } o null.
  async function findAuth(mail: string): Promise<{ id: string; deleted: boolean } | null> {
    // 1º RPC SQL (ve incluso las borradas) = fuente de verdad
    try {
      const { data, error } = await admin.rpc('app_find_auth_user', { p_email: mail });
      if (!error) {
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.id) return { id: row.id as string, deleted: !!row.deleted_at };
      }
    } catch (_) { /* si la RPC no esta desplegada, seguimos con los respaldos */ }

    // 2º Ficha ya enlazada
    const { data: u } = await admin
      .from('usuarios').select('auth_user_id').ilike('email', mail).maybeSingle();
    if (u?.auth_user_id) return { id: u.auth_user_id as string, deleted: false };

    // 3º Recorrer auth.users (no ve las borradas)
    let page = 1;
    while (page <= 50) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users?.length) return null;
      const hit = data.users.find((x) => (x.email ?? '').toLowerCase() === mail);
      if (hit) return { id: hit.id, deleted: false };
      if (data.users.length < 200) return null;
      page++;
    }
    return null;
  }

  async function enlazarFicha(mail: string, authId: string): Promise<void> {
    try {
      await admin.from('usuarios').update({ auth_user_id: authId }).ilike('email', mail);
    } catch (_) { /* no bloquear por esto */ }
  }

  // Crea una cuenta Auth confirmada (borrando antes un posible fantasma)
  async function crearAuth(nombre?: string): Promise<{ id?: string; error?: string }> {
    const prev = await findAuth(email);
    if (prev?.deleted) {
      // Fantasma soft-deleted: borrarlo en firme para liberar el email
      try { await admin.auth.admin.deleteUser(prev.id, false); } catch (_) { /* continuar */ }
    }
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: nombre ? { nombre } : undefined,
    });
    if (cErr || !created?.user) return { error: cErr?.message ?? 'desconocido' };
    return { id: created.user.id };
  }

  // ── 3a) CAMBIAR CONTRASENA ──────────────────────────────────────────
  if (accion === 'reset_password') {
    const found = await findAuth(email);

    // Cuenta activa: actualizar contrasena
    if (found && !found.deleted) {
      const { error: uErr } = await admin.auth.admin.updateUserById(found.id, {
        password, email_confirm: true,
      });
      if (uErr) return json({ error: 'No se pudo cambiar la contrasena: ' + uErr.message }, 400);
      await enlazarFicha(email, found.id);
      return json({ ok: true, id: found.id });
    }

    // No existe o esta borrada: (re)crear confirmada
    const r = await crearAuth();
    if (r.error || !r.id) return json({ error: 'No se pudo localizar ni recrear la cuenta: ' + r.error }, 400);
    await enlazarFicha(email, r.id);
    return json({ ok: true, id: r.id, created: true });
  }

  // ── 3b) CREAR USUARIO ───────────────────────────────────────────────
  const nombre = String(payload.nombre ?? '').trim();
  const rol = String(payload.rol ?? 'operativa').trim();
  if (!nombre) return json({ error: 'Falta el nombre' }, 400);

  const found = await findAuth(email);
  let authId: string;

  if (found && !found.deleted) {
    // Cuenta activa ya existente: actualizar (idempotente)
    authId = found.id;
    const { error: uErr } = await admin.auth.admin.updateUserById(authId, {
      password, email_confirm: true,
    });
    if (uErr) return json({ error: 'La cuenta ya existia y no se pudo actualizar: ' + uErr.message }, 400);
  } else {
    // No existe o fantasma borrado: crear (crearAuth limpia el fantasma)
    const r = await crearAuth(nombre);
    if (r.error || !r.id) return json({ error: 'No se pudo crear la cuenta Auth: ' + r.error }, 400);
    authId = r.id;
  }

  // Ficha en 'usuarios': idempotente por email (por si un trigger ya la creo)
  const { data: fichaExist } = await admin
    .from('usuarios').select('id').ilike('email', email).maybeSingle();

  if (fichaExist?.id) {
    await admin.from('usuarios')
      .update({ nombre, rol, activo: true, auth_user_id: authId }).eq('id', fichaExist.id);
  } else {
    const { error: insErr } = await admin.from('usuarios')
      .insert({ nombre, email, rol, activo: true, auth_user_id: authId });
    if (insErr) {
      return json({ error: 'Cuenta Auth creada, pero fallo la ficha de usuario: ' + insErr.message }, 400);
    }
  }

  return json({ ok: true, id: authId });
});
