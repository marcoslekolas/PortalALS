// supabase/functions/send-notif/index.ts
// Envía un email HTML mediante Nylas v3 usando la cuenta ya conectada (NYLAS_GRANT_ID).
// Se invoca desde el portal (index.html -> _abrirEmailHTML) para notificar a cliente/aduana
// sin que el navegador descargue ningún fichero .eml.
//
// Secrets requeridos (Supabase -> Edge Functions -> Secrets):
//   NYLAS_API_KEY    (clave de API v3)
//   NYLAS_GRANT_ID   (grant del buzón emisor, p.ej. als@alsalgeciras.com)
//   NYLAS_API_URI    (opcional; por defecto https://api.us.nylas.com)

const ALLOWED_ORIGINS = [
  "https://portal.alsalgeciras.com",
  "https://portal.customsway.eu",
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function parseEmails(value: string): { email: string }[] {
  return (value || "")
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter((e) => e && e.includes("@"))
    .map((e) => ({ email: e }));
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const { to, cc, subject, html } = await req.json();

    if (!to || !subject || !html) {
      return new Response(JSON.stringify({ error: "Faltan campos (to, subject, html)" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const API_KEY = Deno.env.get("NYLAS_API_KEY") || "";
    const GRANT_ID = Deno.env.get("NYLAS_GRANT_ID") || "";
    const API_URI = (Deno.env.get("NYLAS_API_URI") || "https://api.us.nylas.com").replace(/\/$/, "");

    if (!API_KEY || !GRANT_ID) {
      return new Response(JSON.stringify({ error: "Nylas no configurado (faltan NYLAS_API_KEY / NYLAS_GRANT_ID)" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const toList = parseEmails(to);
    const ccList = parseEmails(cc || "");
    if (!toList.length) {
      return new Response(JSON.stringify({ error: "Destinatario inválido" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const payload: Record<string, unknown> = {
      to: toList,
      subject: String(subject),
      body: String(html),
    };
    if (ccList.length) payload.cc = ccList;

    const nylasResp = await fetch(`${API_URI}/v3/grants/${GRANT_ID}/messages/send`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const respText = await nylasResp.text();
    if (!nylasResp.ok) {
      console.error("Nylas send error:", nylasResp.status, respText);
      return new Response(JSON.stringify({ error: "Nylas error", status: nylasResp.status, detail: respText }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let data: unknown = null;
    try { data = JSON.parse(respText); } catch (_) { /* respuesta no-JSON */ }

    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-notif error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
