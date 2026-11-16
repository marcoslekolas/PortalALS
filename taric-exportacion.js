// ═══ Medidas TARIC en las que hay que ELEGIR el código de casilla 44 ═══
// · Exportación (EX): categorías EXP_* de taric_medidas: doble uso, residuos,
//   CITES, bienes culturales, gases fluorados, ozono, mercurio, químicos,
//   sanciones… Las carga el procesado TARIC (scripts/procesar_taric.py).
// · Importación (H1): acero «fusión y colada» (ACERO_FUSION, Reg. 2026/1963).
// Cada medida pide una licencia (C/E/X…) o un código Y («no afectado», cláusula
// contractual…). Sin ninguno, la aduana no autoriza el despacho.
// Lo usan el clasificador (taric.html) y el módulo VisualTrans (visualtrans.html).

const TEXP = { filas: new Map(), desc: new Map(), pedidos: new Set(), sinExcluidos: false };
// Grupos de países que incluyen a cualquier tercer país (también Gibraltar)
const TEXP_TERCEROS = new Set(['1011', '1008']);
// Respaldo por si taric_casilla44 no se puede leer: los «no afectado» habituales
const TEXP_NO_AFECTADO = {
  Y150: 'Exención art. 2.2 del Reg. 649/2012 (químicos)', Y160: 'No sujeto al Reg. 2024/573 (gases fluorados)',
  Y792: 'Fuera del ámbito del Reg. 2024/590 (ozono)', Y898: 'No afectado por el Reg. 2023/2833 (atún rojo)',
  Y900: 'No incluido en CITES', Y901: 'No es producto de doble uso', Y903: 'No figura en la lista de bienes culturales',
  Y904: 'Distinto de los productos de las notas «TR» (tortura)', Y906: 'Distinto de los productos de las notas «TR» (tortura)',
  Y909: 'No afectado por el Reg. 1984/2003 (pesca)', Y916: 'No sujeto al Reg. 649/2012 (químicos)', Y917: 'No sujeto al Reg. 649/2012 (químicos)',
  Y922: 'No es piel de perro o gato', Y923: 'No sujeto al Reg. 2024/1157 (residuos)', Y924: 'No afectado por el Reg. 2017/852 (mercurio)',
  Y934: 'No sujeto al Reg. 258/2012 (armas de fuego)', Y935: 'Fuera del ámbito del Reg. 1332/2013'
};
const TEXP_RE_NO_AFECTADO = /^(productos?|mercanc[ií]as|los bienes declarados|bienes|sustancias, productos y aparatos|recipientes)\b[^.]*?\b(no\s|distint|fuera del)|^excepto\b/i;

const texpCod = c => String(c || '').replace(/\D/g, '');
const texpEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Trae de Supabase las medidas con elección de los códigos indicados (una vez por código)
async function texpCargar(codigos){
  const cods = [...new Set((codigos || []).map(texpCod).filter(c => c.length === 10))].filter(c => !TEXP.pedidos.has(c));
  if(!cods.length || typeof sbT !== 'function') return;
  const base = 'codigo,categoria,etiqueta,tipo_medida,origen,origen_code,base_legal,derecho,certificados,exigencia';
  const leer = async (sel, trozo) => {
    const filas = [];
    for(let desde = 0; ; desde += 1000){
      const { data, error } = await sbT().from('taric_medidas').select(sel).in('codigo', trozo)
        .or('categoria.like.EXP_*,categoria.eq.ACERO_FUSION').range(desde, desde + 999);
      if(error) throw error;
      filas.push(...(data || []));
      if(!data || data.length < 1000) return filas;
    }
  };
  for(let i = 0; i < cods.length; i += 40){
    const trozo = cods.slice(i, i + 40);
    let filas;
    try{ filas = await leer(TEXP.sinExcluidos ? base : base + ',excluidos', trozo); }
    catch(e){
      if(TEXP.sinExcluidos || !/excluidos/.test(e.message || '')){ console.warn('Medidas con casilla 44 a elegir no disponibles:', e.message); return; }
      TEXP.sinExcluidos = true;               // columna aún no creada (controles_exportacion.sql)
      try{ filas = await leer(base, trozo); } catch(e2){ console.warn('Medidas con casilla 44 a elegir no disponibles:', e2.message); return; }
    }
    trozo.forEach(c => { TEXP.pedidos.add(c); TEXP.filas.set(c, []); });
    filas.forEach(f => TEXP.filas.get(f.codigo)?.push(f));
  }
  // Descripción oficial (ES) de los códigos de casilla 44 que aparecen
  const certs = [...new Set(cods.flatMap(c => (TEXP.filas.get(c) || []).flatMap(f => String(f.certificados || '').split('|'))))]
    .filter(c => c && !TEXP.desc.has(c));
  for(let i = 0; i < certs.length; i += 100){
    const { data, error } = await sbT().from('taric_casilla44').select('codigo,descripcion').in('codigo', certs.slice(i, i + 100));
    if(error){ console.warn('taric_casilla44 no legible:', error.message); break; }
    (data || []).forEach(r => TEXP.desc.set(r.codigo, r.descripcion || ''));
  }
}

// Grupos de condiciones del campo «derecho»: «Cond:  E cert: C-672 (29):; E 20.000/KGM(29):; I cert: …»
function texpGrupos(derecho){
  const g = new Map();
  String(derecho || '').replace(/^\s*Cond:\s*/, '').split(';').forEach(p => {
    const m = p.trim().match(/^([A-Z]{1,2})\s+(?:cert:\s*([A-Z])-?(\d{3})|([\d.,]+\s*\/\s*[A-Z]+))?/);
    if(!m) return;
    if(!g.has(m[1])) g.set(m[1], { cond: m[1], certs: [], umbral: '' });
    if(m[2]) g.get(m[1]).certs.push(m[2] + m[3]);
    else if(m[4]) g.get(m[1]).umbral = m[4].replace(/\s+/g, '');
  });
  return [...g.values()].filter(x => x.certs.length);
}
const texpDesc = c => TEXP.desc.get(c) || TEXP_NO_AFECTADO[c] || '';
const texpNoAfectado = c => /^Y/.test(c) && (c in TEXP_NO_AFECTADO || TEXP_RE_NO_AFECTADO.test(texpDesc(c)));

// ¿La medida alcanza al país de destino? Grupos «todos los terceros países» o el
// propio país, salvo que figure entre los excluidos. Otros grupos (p. ej. OCDE) se
// muestran como «puede aplicar».
function texpAlcance(f, destino){
  if(String(f.excluidos || '').split('|').includes(destino)) return '';
  if(TEXP_TERCEROS.has(f.origen_code) || f.origen_code === destino) return 'si';
  if(/^\d{4}$/.test(f.origen_code)) return 'grupo';
  return '';
}

// Medidas que hay que resolver en casilla 44 para estos códigos y este destino.
// importacion=true → solo el acero; si no, solo las de exportación.
function texpMedidas(codigos, { destino = 'GI', importacion = false } = {}){
  const vistas = new Map();
  [].concat(codigos || []).map(texpCod).forEach(cod => (TEXP.filas.get(cod) || []).forEach(f => {
    if(importacion ? f.categoria !== 'ACERO_FUSION' : !String(f.categoria).startsWith('EXP_')) return;
    const alcance = importacion ? 'si' : texpAlcance(f, destino);
    if(!alcance) return;
    const clave = `${f.tipo_medida}|${f.base_legal}|${f.origen_code}`.replace(/[^\w|-]/g, '');
    if(vistas.has(clave)){ vistas.get(clave).codigos.push(cod); return; }
    const grupos = texpGrupos(f.derecho);
    const certs = [...new Set(grupos.flatMap(g => g.certs).concat(String(f.certificados || '').split('|').filter(Boolean)))];
    // «No afectado» marcado de entrada solo si vale para todos los grupos de condiciones.
    // En sanciones, solo si no hay otra opción (cláusula contractual, licencia…): ahí se elige siempre.
    const sancion = f.categoria === 'EXP_SANCION' && certs.some(c => !texpNoAfectado(c));
    const porDefecto = grupos.length && !sancion ? certs.filter(c => texpNoAfectado(c) && grupos.every(g => g.certs.includes(c))) : [];
    vistas.set(clave, {
      clave, codigos: [cod], tipo: f.tipo_medida, categoria: f.categoria, etiqueta: f.etiqueta || f.categoria,
      origen: f.origen, alcance, informativa: f.exigencia === 'INFORMATIVA', prohibicion: f.exigencia === 'PROHIBICION' && !certs.length,
      grupos, certs: certs.map(c => ({ codigo: c, desc: texpDesc(c), noAfectado: texpNoAfectado(c) })), porDefecto,
      umbral: [...new Set(grupos.map(g => g.umbral).filter(Boolean))].join(' · ')
    });
  }));
  return [...vistas.values()].sort((a, b) => a.informativa - b.informativa || a.etiqueta.localeCompare(b.etiqueta));
}

// Países con sanciones a la exportación para estos códigos (si el destino no es Gibraltar)
function texpOtrosDestinos(codigos){
  const p = new Set();
  [].concat(codigos || []).map(texpCod).forEach(cod => (TEXP.filas.get(cod) || [])
    .forEach(f => { if(String(f.categoria).startsWith('EXP_') && /^[A-Z]{2}$/.test(f.origen_code) && f.exigencia !== 'INFORMATIVA') p.add(f.origen_code); }));
  return [...p].sort();
}

// Bloque compacto para el clasificador (sin elección: solo informa)
function texpHtmlLinea(codigo){
  const cod = texpCod(codigo);
  if(!TEXP.pedidos.has(cod)) return '';
  const acero = texpMedidas(cod, { importacion: true });
  const exp = texpMedidas(cod).filter(m => !m.informativa);
  const otros = texpOtrosDestinos(cod).filter(p => p !== 'GI');
  if(!acero.length && !exp.length && !otros.length) return '';
  const opc = m => m.certs.map(c => `<span class="badge" style="font-size:9px;margin:1px;background:${c.noAfectado ? 'var(--g100)' : 'var(--am50)'};color:${c.noAfectado ? 'var(--g600)' : 'var(--am600)'}" title="${texpEsc(c.desc)}">${texpEsc(c.codigo)}</span>`).join('');
  const fila = m => `<div style="margin-top:3px"><span style="font-size:10px;color:var(--g700)">${texpEsc(m.etiqueta)}${m.alcance === 'grupo' ? ` <span style="color:var(--g400)">(${texpEsc(m.origen)})</span>` : ''}${m.umbral ? ` <span style="color:var(--g400)">· umbral ${texpEsc(m.umbral)}</span>` : ''}</span><br>${m.prohibicion ? '<span class="badge badge-red" style="font-size:9px">Prohibida</span>' : opc(m)}</div>`;
  return `<div style="margin-top:5px;padding-top:5px;border-top:1px dashed var(--g200)">
    ${exp.length ? `<div style="font-size:9px;font-weight:700;color:var(--b600,#2563eb)">EXPORTACIÓN · CASILLA 44 (uno de)</div>${exp.map(fila).join('')}` : ''}
    ${acero.length ? `<div style="font-size:9px;font-weight:700;color:var(--am600);margin-top:3px">IMPORTACIÓN · ACERO</div>${acero.map(fila).join('')}` : ''}
    ${otros.length ? `<div style="font-size:9px;color:var(--g500);margin-top:3px" title="Medidas restrictivas a la exportación con destino a estos países">Sanciones a la exportación si el destino es: ${otros.map(texpEsc).join(', ')}</div>` : ''}
  </div>`;
}
