// ═══ Notas explicativas de la Nomenclatura Combinada (NENC) ═══
// Texto oficial de la Comisión: versión consolidada en español de EUR-Lex
// (CELEX 02019XC0329(02), a 13.2.2026) más las modificaciones publicadas después,
// troceado por sección, capítulo y código en notas-nc.json
// (scripts/construir_notas_nc.py y scripts/modificaciones_notas_nc.py).
// Es un fichero estático del repo: no ocupa Supabase ni gasta IA al consultarlo.
// No son jurídicamente vinculantes, pero son el criterio oficial de la UE para
// interpretar la NC. Las notas que citan un código que ya no existe en la NC
// vigente se marcan.
// Lo usa el clasificador (taric.html).

const NCN = { datos: null, cargando: null, error: '' };
const NCN_VERSION = '2026111803';
const ncnEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Carga el fichero una sola vez (1,2 MB; GitHub Pages lo sirve comprimido)
function ncnCargar(){
  if(NCN.datos) return Promise.resolve(NCN.datos);
  if(!NCN.cargando) NCN.cargando = fetch(`notas-nc.json?v=${NCN_VERSION}`)
    .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => (NCN.datos = d))
    .catch(e => { NCN.error = e.message; NCN.cargando = null; console.warn('Notas explicativas NC no disponibles:', e.message); return null; });
  return NCN.cargando;
}

// ¿La nota (lista de códigos o rangos [R, desde, hasta]) cubre este código?
function ncnCubre(c, cod){
  return c.some(x => Array.isArray(x)
    ? (cod.slice(0, x[1].length) >= x[1] && cod.slice(0, x[2].length) <= x[2])
    : cod.startsWith(x));
}

// Notas que afectan a un código de 4 a 10 dígitos: sección, capítulo y las de
// partida/subpartida, de lo general a lo particular
function ncnDe(codigo){
  const d = NCN.datos, cod = String(codigo || '').replace(/\D/g, '');
  if(!d || cod.length < 4) return null;
  const cap = cod.slice(0, 2), sec = d.seccionDe[cap];
  const largo = n => Array.isArray(n.c[0]) ? n.c[0][1].length : Math.max(...n.c.map(x => String(x).length));
  const notas = d.notas.filter(n => n.cap === cap && ncnCubre(n.c, cod)).sort((a, b) => largo(a) - largo(b));
  return { cap, sec, seccion: sec ? d.secciones[sec] || '' : '', capitulo: d.capitulos[cap] || '', notas };
}

const ncnParrafos = t => ncnEsc(t).split('\n').filter(Boolean).map(p => `<p style="margin:0 0 4px">${p}</p>`).join('');

// Bloque desplegable para el clasificador. compacto=true en la tabla de facturas.
function ncnHtml(codigo, { compacto = false } = {}){
  const r = ncnDe(codigo);
  if(!r || (!r.notas.length && !r.capitulo)) return '';
  const caja = 'font-size:11px;color:var(--g700);line-height:1.5;padding:6px 8px;background:var(--w);border:1px solid var(--g200);border-radius:6px;margin-top:4px;max-height:320px;overflow-y:auto';
  const nota = n => n.mod
    ? `<div style="margin-top:6px;padding:4px 6px;background:var(--am50,#fffbeb);border-left:3px solid var(--am600);border-radius:4px">
      <div style="font-weight:700;color:var(--am600)">${ncnEsc(n.tit)} · <span style="font-family:var(--mono)">${ncnEsc(n.cel)}</span> · <a href="${ncnEsc(n.mod.url)}" target="_blank" rel="noopener" style="color:var(--am600)">DO ↗</a></div>
      ${ncnParrafos(n.t)}</div>`
    : `<div style="margin-top:6px">
      <div style="font-weight:700;color:var(--b700)"><span style="font-family:var(--mono)">${ncnEsc(n.cel)}</span> ${ncnEsc(n.tit)}</div>
      ${n.obs.length ? `<div style="font-size:10px;color:var(--am600)">⚠ Cita ${n.obs.map(ncnEsc).join(', ')}, que ya no existe en la NC vigente; compruébalo con la nomenclatura actual</div>` : ''}
      ${ncnParrafos(n.t)}</div>`;
  const general = r.capitulo
    ? `<details style="margin-top:4px"><summary style="cursor:pointer;color:var(--g600)">Consideraciones generales del capítulo ${ncnEsc(r.cap)}</summary><div style="${caja}">${ncnParrafos(r.capitulo)}</div></details>` : '';
  const n = r.notas.length;
  return `<details style="margin-top:${compacto ? 4 : 8}px;font-size:${compacto ? 10 : 11}px">
    <summary style="cursor:pointer;font-weight:700;color:var(--b600,#2563eb)">📘 Notas explicativas NC${n ? ` (${n})` : ''}</summary>
    ${n ? `<div style="${caja}">${r.notas.map(nota).join('')}</div>` : '<div style="color:var(--g500);margin-top:3px">Sin notas propias para este código; solo las generales del capítulo.</div>'}
    ${general}
    <div style="font-size:9px;color:var(--g400);margin-top:3px">Fuente: <a href="${ncnEsc(NCN.datos.url)}" target="_blank" rel="noopener" style="color:var(--g400)">versión consolidada de EUR-Lex a 13.2.2026</a>${(NCN.datos.modificaciones || []).length ? ` y modificaciones hasta el ${ncnEsc(NCN.datos.modificaciones[NCN.datos.modificaciones.length - 1].fecha)}` : ''} · no vinculantes</div>
  </details>`;
}

// Texto plano de las notas de varios códigos, para pasárselo a la IA (fase 2).
// maxChars limita el tamaño: primero lo particular, luego lo general del capítulo.
function ncnTextoIA(codigos, maxChars = 12000){
  const partes = [];
  [...new Set([].concat(codigos || []).map(c => String(c || '').replace(/\D/g, '')).filter(c => c.length >= 4))].forEach(cod => {
    const r = ncnDe(cod);
    if(!r) return;
    r.notas.forEach(n => partes.push(n.mod ? `[${n.tit}, afecta a ${n.cel}]\n${n.t}` : `[${n.cel}] ${n.tit}\n${n.t}`));
    if(r.capitulo) partes.push(`[Capítulo ${r.cap}, consideraciones generales]\n${r.capitulo}`);
  });
  let txt = '';
  for(const p of [...new Set(partes)]){ if(txt.length + p.length > maxChars) break; txt += p + '\n\n'; }
  return txt.trim();
}

// ── Revisión con IA de las líneas dudosas (función clasificar-factura, modo revisar_notas) ──
// Dudosa: confianza del modelo por debajo de 80, o NC8 corregida/inexistente.
function ncnDudosa(l){
  const nc8 = String(l.nc8 || l.codigo_taric || '').replace(/\D/g, '').slice(0, 8);
  if(nc8.length !== 8) return false;
  const est = l._verif && l._verif.estado;
  return (Number(l.confianza) > 0 && Number(l.confianza) < 80) || est === 'reclasificado' || est === 'nc8_invalido';
}
// items: [{ id, descripcion, nc8 }] → Map(id → { dictamen, nc8, motivo, cita })
async function ncnRevisar(items){
  await ncnCargar();
  const revision = items.slice(0, 15).map(x => ({ id: String(x.id), descripcion: x.descripcion, nc8: x.nc8, notas: ncnTextoIA([x.nc8], 9000) }));
  const r = await fetch(FACTURA_ENDPOINT, { method: 'POST', headers: await cabecerasTaric(), body: JSON.stringify({ modo: 'revisar_notas', revision }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok || d.error) throw new Error(d.error || ('Error ' + r.status));
  if(typeof logUsoIA === 'function') logUsoIA('taric-notas-nc', 'gemini').catch(() => {});
  return new Map((d.revisiones || []).map(x => [String(x.id), x]));
}
// Dictamen de una línea. aplicar: código JS del botón que aplica la NC8 propuesta.
function ncnRevHtml(rev, aplicar){
  if(!rev) return '';
  const col = { CONFIRMA: ['var(--gr600,#16a34a)', '#f0fdf4', '✔ Las notas explicativas confirman la partida'],
                CAMBIA: ['var(--am600)', '#fffbeb', `⚠ Las notas apuntan a la NC8 ${rev.nc8}`],
                DUDA: ['var(--g600)', 'var(--g50,#f8f9fa)', '? Las notas piden un dato más'] }[rev.dictamen] || ['var(--g600)', '#fff', rev.dictamen];
  return `<div style="margin-top:4px;padding:5px 7px;border-radius:6px;background:${col[1]};border:1px solid ${col[0]};font-size:10px;line-height:1.45">
    <div style="font-weight:700;color:${col[0]}">${ncnEsc(col[2])}${rev.aplicada ? ' · aplicada' : ''}</div>
    <div style="color:var(--g700)">${ncnEsc(rev.motivo)}</div>
    ${rev.cita ? `<div style="color:var(--g500);font-style:italic;margin-top:2px">«${ncnEsc(rev.cita)}»</div>` : ''}
    ${rev.dictamen === 'CAMBIA' && !rev.aplicada && aplicar ? `<button class="btn btn-s btn-sm" style="margin-top:4px;font-size:10px;padding:2px 8px" onclick="${aplicar}">Aplicar ${ncnEsc(rev.nc8)}</button>` : ''}
  </div>`;
}
