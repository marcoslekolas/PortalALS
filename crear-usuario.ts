// ════════════════════════════════════════════════════════════════════
//  Edge Function: crear-usuario
//  Portal ALS / Customs Way — gestión de cuentas con Supabase Auth
// --------------------------------------------------------------------
//  Acciones (según el cuerpo JSON recibido):
//    • crear (por defecto):   { nombre, email, password, rol }
//         → crea la cuenta en auth.users (confirmada) y la ficha en 'usuarios'
//    • reset_password:        { accion:'reset_password', email, password }
//         → cambia la contraseña de la cuenta Auth de ese email
//
//  Seguridad: SOLO un administrador (app_es_admin()) puede invocarla.
//  Usa la SERVICE_ROLE_KEY (nunca expuesta al navegador).
//
//  Despliegue:  supabase functions deploy crear-usuario
//  (SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY
//   las inyecta Supabase automáticamente.)
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
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: 'Función mal configurada: faltan variables de entorno del proyecto' }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // ── 1) Autenticación + verificación de ADMIN ────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ error: 'No autorizado (falta token de sesión)' }, 401);

  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !caller?.user) return json({ error: 'No autorizado (token inválido o caducado)' }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: isAdmin, error: adminErr } = await userClient.rpc('app_es_admin');
  if (adminErr || isAdmin !== true) {
    return json({ error: 'Solo un administrador puede crear usuarios o cambiar contraseñas' }, 403);
  }

  // ── 2) Cuerpo ───────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Cuerpo JSON inválido' }, 400);
  }

  const accion = String(payload.accion ?? 'crear');
  const email = String(payload.email ?? '').trim().toLowerCase();
  const password = String(payload.password ?? '');

  if (!email) return json({ error: 'Falta el email' }, 400);
  if (!password || password.length < 6) {
    return json({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
  }

  async function findAuthIdByEmail(mail: string): Promise<string | null> {
    const { data: u } = await admin
      .from('usuarios').select('auth_user_id').ilike('email', mail).maybeSingle();
    if (u?.auth_user_id) return u.auth_user_id as string;

    let page = 1;
    while (page <= 50) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users?.length) return null;
      const hit = data.users.find((x) => (x.email ?? '').toLowerCase() === mail);
      if (hit) return hit.id;
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

  // ── 3a) CAMBIAR CONTRASEÑA ──────────────────────────────────────────
  if (accion === 'reset_password') {
    const authId = await findAuthIdByEmail(email);

    if (!authId) {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (cErr || !created?.user) {
        return json({ error: 'No se pudo localizar ni crear la cuenta: ' + (cErr?.message ?? 'desconocido') }, 400);
      }
      await enlazarFicha(email, created.user.id);
      return json({ ok: true, id: created.user.id, created: true });
    }

    const { error: uErr } = await admin.auth.admin.updateUserById(authId, {
      password, email_confirm: true,
    });
    if (uErr) return json({ error: 'No se pudo cambiar la contraseña: ' + uErr.message }, 400);

    await enlazarFicha(email, authId);
    return json({ ok: true, id: authId });
  }

  // ── 3b) CREAR USUARIO ───────────────────────────────────────────────
  const nombre = String(payload.nombre ?? '').trim();
  const rol = String(payload.rol ?? 'operativa').trim();
  if (!nombre) return json({ error: 'Falta el nombre' }, 400);

  const existing = await findAuthIdByEmail(email);
  let authId: string;

  if (existing) {
    authId = existing;
    const { error: uErr } = await admin.auth.admin.updateUserById(authId, {
      password, email_confirm: true,
    });
    if (uErr) return json({ error: 'La cuenta ya existía y no se pudo actualizar: ' + uErr.message }, 400);
  } else {
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { nombre },
    });
    if (cErr || !created?.user) {
      return json({ error: 'No se pudo crear la cuenta Auth: ' + (cErr?.message ?? 'desconocido') }, 400);
    }
    authId = created.user.id;
  }

  const { data: fichaExist } = await admin
    .from('usuarios').select('id').ilike('email', email).maybeSingle();

  if (fichaExist?.id) {
    await admin.from('usuarios')
      .update({ nombre, rol, activo: true, auth_user_id: authId }).eq('id', fichaExist.id);
  } else {
    const { error: insErr } = await admin.from('usuarios')
      .insert({ nombre, email, rol, activo: true, auth_user_id: authId });
    if (insErr) {
      return json({ error: 'Cuenta Auth creada, pero falló la ficha de usuario: ' + insErr.message }, 400);
    }
  }

  return json({ ok: true, id: authId });
});
