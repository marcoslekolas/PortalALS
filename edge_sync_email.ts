// ═══════════════════════════════════════════════════════════════════
// Customs Way · Edge Function: sync-email
// Supabase → Edge Functions → New function → "sync-email"
// ═══════════════════════════════════════════════════════════════════
//
// DESPLIEGUE:
//   supabase functions deploy sync-email
//
// CRON (cada 15 min): Supabase → Database → Cron jobs
//   select cron.schedule('sync-email-cron','*/15 * * * *',
//     $$select net.http_post(
//       url := 'https://bccqfqaehbmmqbisfbyv.supabase.co/functions/v1/sync-email',
//       headers := '{"Content-Type":"application/json","Authorization":"Bearer TU_SERVICE_ROLE_KEY"}',
//       body := '{}'
//     )$$
//   );
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SB_URL, SB_KEY);

// ── Clasificación por keywords ────────────────────────────────────
const KEYWORDS: Record<string,string[]> = {
  requerimiento: ['requerimiento','requiriendo','plazo 10','requerimiento de información'],
  liquidacion:   ['liquidación','liquidacion','deuda tributaria','carta de pago','acta de liquidación'],
  recurso:       ['recurso','impugna','recurrir','reposición','recurso de reposición'],
  alegacion:     ['alegación','alegacion','audiencia','trámite de audiencia','propuesta de resolución'],
  rpa:           ['rpa','régimen 51','perfeccionamiento','ultimación','ultime el régimen']
};

function clasificar(asunto: string, cuerpo: string): string {
  const txt = (asunto + ' ' + cuerpo).toLowerCase();
  for (const [tipo, kws] of Object.entries(KEYWORDS)) {
    if (kws.some(k => txt.includes(k))) return tipo;
  }
  return 'email';
}

function extraerDossier(txt: string): string | null {
  const m = txt.match(/\b(17\d{4}|18\d{4}|19\d{4})\b/);
  return m ? m[0] : null;
}

// ── Envío de email de notificación vía Supabase Auth SMTP ─────────
async function enviarNotif(titulo: string, mensaje: string, email: string) {
  // Usar Resend / Supabase SMTP — configura en Supabase → Settings → Auth → SMTP
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) { console.log('Sin RESEND_API_KEY — notificación no enviada'); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Customs Way <notificaciones@customsway.eu>',
      to: email,
      subject: `[Customs Way] ${titulo}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <div style="background:#0ea5e9;color:#fff;padding:12px 20px;border-radius:8px 8px 0 0">
            <strong>Customs Way · Notificación</strong>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px">
            <h2 style="color:#0f172a;font-size:16px;margin-bottom:10px">${titulo}</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6">${mensaje}</p>
            <div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
              Portal Operativo · <a href="https://portal.alsalgeciras.com" style="color:#0ea5e9">portal.alsalgeciras.com</a>
            </div>
          </div>
        </div>`
    })
  });
}

// ── Leer IMAP (usando librería imap-simple vía CDN) ───────────────
async function syncIMAP() {
  // Leer config de Supabase
  const { data: cfgs } = await sb.from('als_config')
    .select('clave,valor')
    .in('clave', ['email_imap_host','email_imap_port','email_imap_user','email_imap_pass']);

  const cfg: Record<string,string> = {};
  (cfgs || []).forEach((r: any) => { cfg[r.clave] = r.valor; });

  if (!cfg.email_imap_user || !cfg.email_imap_pass) {
    console.log('Credenciales IMAP no configuradas');
    return { count: 0 };
  }

  // NOTA: Las Edge Functions de Supabase (Deno) no soportan IMAP TCP nativo.
  // La alternativa es usar la Microsoft Graph API (si hay Azure AD) o
  // un servicio intermedio como Nylas / Cloudmailin que hace webhook HTTP.
  //
  // OPCIÓN RECOMENDADA SIN AZURE AD:
  // 1. Crear cuenta Nylas gratuita en nylas.com
  // 2. Conectar la cuenta mvalencia@customsway.eu
  // 3. Obtener NYLAS_API_KEY y NYLAS_GRANT_ID
  // 4. Usar la API REST de Nylas desde aquí:

  const nylasKey  = Deno.env.get('NYLAS_API_KEY');
  const nylasGrant = Deno.env.get('NYLAS_GRANT_ID');

  if (!nylasKey || !nylasGrant) {
    console.log('Nylas no configurado — usando modo demo');
    return { count: 0, nota: 'Configurar NYLAS_API_KEY y NYLAS_GRANT_ID en secrets' };
  }

  // Leer últimos 20 emails no leídos vía Nylas
  const resp = await fetch(
    `https://api.us.nylas.com/v3/grants/${nylasGrant}/messages?limit=20&unread=true`,
    { headers: { 'Authorization': `Bearer ${nylasKey}`, 'Content-Type': 'application/json' } }
  );
  const { data: msgs } = await resp.json();
  if (!msgs?.length) return { count: 0 };

  let nuevos = 0;
  for (const msg of msgs) {
    // Comprobar si ya existe
    const { data: existe } = await sb.from('cw_emails')
      .select('id').eq('message_id', msg.id).single();
    if (existe) continue;

    const asunto = msg.subject || '';
    const cuerpo = msg.body || msg.snippet || '';
    const tipo   = clasificar(asunto, cuerpo);
    const dos    = extraerDossier(asunto + ' ' + cuerpo);
    const de     = msg.from?.[0]?.email || '';
    const deNom  = msg.from?.[0]?.name  || '';

    await sb.from('cw_emails').insert({
      message_id: msg.id,
      fecha:      new Date(msg.date * 1000).toISOString(),
      de, de_nombre: deNom,
      asunto, cuerpo: cuerpo.substring(0, 2000),
      tipo, dossier: dos,
      leido: false
    });
    nuevos++;
  }
  return { count: nuevos };
}

// ── Procesar notificaciones pendientes ────────────────────────────
async function procesarNotifs() {
  const { data: pendientes } = await sb.rpc('get_notifs_pendientes');
  if (!pendientes?.length) return;

  for (const n of pendientes) {
    await enviarNotif(n.titulo, n.mensaje, n.email_destino);
    await sb.from('cw_notifs').update({ enviado: true }).eq('id', n.id);
    console.log('Notificación enviada:', n.titulo);
  }
}

// ── Handler principal ─────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }});
  }

  try {
    const [emailResult] = await Promise.all([
      syncIMAP(),
      procesarNotifs()
    ]);

    return new Response(JSON.stringify({ ok: true, ...emailResult }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    console.error('sync-email error:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});
