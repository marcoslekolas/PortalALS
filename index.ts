// ═══════════════════════════════════════════════════════════════════
// Customs Way · Edge Function: briefing-gibraltar
// ALS · Algeciras Logistic Solutions
// ═══════════════════════════════════════════════════════════════════
//
// QUÉ HACE:
//   Genera el briefing diario de actualidad aduanera Gibraltar/AEAT,
//   lo guarda en la tabla cw_briefings de Supabase y opcionalmente
//   envía un email de notificación al administrador vía Resend.
//
// DESPLIEGUE:
//   supabase functions deploy briefing-gibraltar
//
// SECRETS NECESARIOS (Supabase → Settings → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   → tu clave de Anthropic
//   RESEND_API_KEY      → (opcional) para recibir el briefing por email
//   ADMIN_EMAIL         → (opcional) email del administrador
//
// VARIABLES DE ENTORNO AUTOMÁTICAS (Supabase las inyecta solas):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// CRON (ya configurado en tu proyecto):
//   Brexit-Gibraltar-Briefing-Diario → 0 8 * * 1-7
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Supabase client ───────────────────────────────────────────────
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb     = createClient(SB_URL, SB_KEY);

// ── Anthropic API key ─────────────────────────────────────────────
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// ── Resend (opcional) ─────────────────────────────────────────────
const RESEND_KEY  = Deno.env.get('RESEND_API_KEY');
const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'als@alsalgeciras.com';

// ═══════════════════════════════════════════════════════════════════
// PROMPT DEL BRIEFING
// ═══════════════════════════════════════════════════════════════════
function buildPrompt(today: string): string {
  return `Eres un analista experto en derecho aduanero y comercio exterior. Hoy es ${today}.

Realiza un briefing diario exhaustivo buscando noticias e información publicada en los últimos 7 días sobre los siguientes temas específicos:

1. ENTRADA EN VIGOR DEL ACUERDO UE-RU SOBRE GIBRALTAR: novedades sobre la fecha de aplicación provisional (15/07/2026), condiciones cumplidas/pendientes (trazabilidad tabaco, transaction tax 15%), comunicados Comisión Europea, declaraciones España/UK/Gibraltar, textos publicados en el DOUE.

2. VIALES DE ACCESO Y SALIDA: cambios en La Verja, estado de adaptaciones infraestructurales, nuevos protocolos en el paso fronterizo, noticias sobre el Puerto de Algeciras en relación con Gibraltar, actualizaciones sobre los controles Schengen en puerto/aeropuerto de Gibraltar.

3. RECINTO DE ADUANAS LA LÍNEA: noticias sobre la DCP La Línea de la Concepción, nuevos procedimientos, comunicados AEAT, cambios en el recinto aduanero.

4. OPERATIVA ADUANERA — FUNCIONARIOS: nuevas instrucciones internas AEAT, cambios en competencias del Resguardo Fiscal (Guardia Civil), Oficial de Aduanas o Administrador de Aduanas en el Campo de Gibraltar.

5. HORARIOS Y PROCEDIMIENTOS: cambios en horarios de despacho en La Línea, Algeciras, La Verja. Nuevos procedimientos T1GI/T2GI/H1. Actualizaciones en NCTS o AES relacionadas con Gibraltar.

6. AEAT GENERAL: notas informativas de aduanas publicadas esta semana, actualizaciones de sistemas (NCTS, AES, EDIFACT), circulares del Departamento de Aduanas e IIEE.

7. COMISIÓN EUROPEA: normativa UE relevante para aduanas y Brexit/Gibraltar publicada en el DOUE o comunicados oficiales.

8. SECTOR TRANSITARIO Y OPERATIVO: noticias ATEIA Campo de Gibraltar, impacto del Acuerdo en representantes aduaneros y transitarios, avisos de navieras o terminales portuarias.

INSTRUCCIÓN IMPORTANTE: Si no encuentras noticias verificadas sobre algún tema, escribe explícitamente "Sin novedades verificadas esta semana." No inventes ni supongas información. Solo incluye lo que hayas encontrado en fuentes fiables.

Responde ESTRICTAMENTE con este formato (sin texto fuera de él):

### 📌 RESUMEN EJECUTIVO
[2-3 líneas con lo más relevante del día. Si no hay novedades significativas, indícalo.]

### 🏛 ACUERDO · ENTRADA EN VIGOR
[Novedades sobre el Acuerdo UE-RU Gibraltar]

### 🗺 VIALES, VERJA Y ACCESOS
[Novedades sobre La Verja, Puerto Algeciras, accesos]

### 🏗 RECINTO LA LÍNEA · DCP
[Novedades sobre la Aduana de La Línea como DCP]

### 👮 OPERATIVA · FUNCIONARIOS
[Novedades sobre protocolos, competencias, instrucciones]

### 📋 AEAT · NORMATIVA
[Notas informativas, circulares, actualizaciones de sistemas]

### 🌐 COMISIÓN EUROPEA · DOUE
[Normativa UE relevante]

### 🏢 SECTOR TRANSITARIO
[ATEIA, representantes aduaneros, operadores portuarios]

### 📎 FUENTES CONSULTADAS
[Lista de URLs verificados]`;
}

// ═══════════════════════════════════════════════════════════════════
// LLAMADA A ANTHROPIC CON WEB SEARCH
// ═══════════════════════════════════════════════════════════════════
async function generarBriefing(today: string): Promise<string> {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY no configurada en los secrets de la Edge Function.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':         'application/json',
      'x-api-key':            ANTHROPIC_KEY,
      'anthropic-version':    '2023-06-01',
      'anthropic-beta':       'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: buildPrompt(today) }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  // Extraer solo los bloques de texto de la respuesta
  const texto = (data.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n')
    .trim();

  if (!texto) throw new Error('La API devolvió una respuesta sin texto.');
  return texto;
}

// ═══════════════════════════════════════════════════════════════════
// GUARDAR EN SUPABASE
// ═══════════════════════════════════════════════════════════════════
async function guardarBriefing(fecha: string, contenido: string): Promise<void> {
  // Comprobar si ya existe un briefing para hoy (evitar duplicados si el cron se ejecuta dos veces)
  const { data: existente } = await sb
    .from('cw_briefings')
    .select('id')
    .eq('fecha', fecha)
    .single();

  if (existente) {
    // Actualizar el existente
    await sb
      .from('cw_briefings')
      .update({ contenido, creado_en: new Date().toISOString() })
      .eq('fecha', fecha);
    console.log(`Briefing actualizado para ${fecha}`);
  } else {
    // Insertar nuevo
    await sb.from('cw_briefings').insert({
      fecha,
      contenido,
      creado_en: new Date().toISOString(),
    });
    console.log(`Briefing guardado para ${fecha}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// NOTIFICACIÓN POR EMAIL (opcional — requiere RESEND_API_KEY)
// ═══════════════════════════════════════════════════════════════════
async function enviarEmail(fecha: string, contenido: string): Promise<void> {
  if (!RESEND_KEY) {
    console.log('RESEND_API_KEY no configurada — email omitido.');
    return;
  }

  // Extraer resumen ejecutivo para el asunto
  const resumenMatch = contenido.match(/### 📌 RESUMEN EJECUTIVO\n([\s\S]*?)(?=###|$)/);
  const resumen = resumenMatch ? resumenMatch[1].trim().substring(0, 200) : 'Análisis diario disponible.';

  // Convertir el markdown básico a HTML para el email
  const htmlContenido = contenido
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/### (.+)/g, '<h3 style="color:#1e3a8a;font-size:13px;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid #e2e8f0">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'Customs Way Gibraltar <notificaciones@customsway.eu>',
      to:      ADMIN_EMAIL,
      subject: `[Gibraltar] Briefing ${fecha} · ALS`,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:680px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#0f2d6e,#1e3a8a,#312e81);padding:18px 24px;border-radius:10px 10px 0 0">
            <div style="color:#fff;font-size:16px;font-weight:700">Gibraltar · Briefing Diario</div>
            <div style="color:rgba(255,255,255,.6);font-size:11px;margin-top:3px">ALS · Algeciras Logistic Solutions · ${fecha}</div>
          </div>
          <div style="background:#f8f9fa;border:1px solid #e2e8f0;border-top:none;padding:6px 24px 10px;border-radius:0 0 0 0">
            <p style="font-size:13px;color:#475569;font-style:italic;margin:10px 0">${resumen}</p>
          </div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:20px 24px;border-radius:0 0 10px 10px;font-size:13px;line-height:1.8;color:#475569">
            ${htmlContenido}
          </div>
          <div style="text-align:center;padding:16px;font-size:11px;color:#adb5bd">
            ALS · Algeciras Logistic Solutions · 
            <a href="https://portal.alsalgeciras.com" style="color:#2563eb">portal.alsalgeciras.com</a>
          </div>
        </div>
      `,
    }),
  });

  console.log(`Email enviado a ${ADMIN_EMAIL}`);
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const headers = {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
  };

  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`Iniciando briefing Gibraltar para ${today}...`);

    // 1. Generar el briefing con Anthropic + web search
    const contenido = await generarBriefing(today);
    console.log(`Briefing generado (${contenido.length} caracteres)`);

    // 2. Guardar en Supabase
    await guardarBriefing(today, contenido);

    // 3. Enviar email (si está configurado)
    await enviarEmail(today, contenido);

    return new Response(
      JSON.stringify({
        ok:       true,
        fecha:    today,
        chars:    contenido.length,
        mensaje:  'Briefing generado y guardado correctamente.',
      }),
      { status: 200, headers }
    );

  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error('briefing-gibraltar error:', mensaje);

    return new Response(
      JSON.stringify({ ok: false, error: mensaje }),
      { status: 500, headers }
    );
  }
});
