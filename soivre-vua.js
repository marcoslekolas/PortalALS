'use strict';
// ═══ SOIVRE · ESTACICE VUA (Ministerio de Comercio) ═══
// Control de calidad a la exportación y reexportación por el servicio web
// SOIVRE/Operador: frutas y hortalizas (tipo F) y otros productos (tipo O:
// aceite de oliva, aceitunas, hierbas aromáticas…). Se carga después de soivre-cal.js y usa sus utilidades
// (sEsc, sCampo, soivreModal, soivreLlamar, soivreComprobarServidor…).
//
// Reglas (especificación WSESTACICE v3.1 y operativa de ALS):
//   · sin MRN; de 1 a 12 líneas por solicitud, una por línea de factura;
//   · una solicitud por factura y país de origen: España → exportación (E),
//     otro país → reexportación (R); más de 12 líneas → varias solicitudes;
//   · F y O no se mezclan en una misma solicitud;
//   · el agente económico es el exportador de la factura (no el titular del
//     certificado). En F el destinatario no tiene campo (va en la factura
//     adjunta); en O es obligatorio (DestinatarioRemitente);
//   · destino Gibraltar → Centro COMEX La Línea/Gibraltar (5802) y aduana
//     La Línea Concepción (1167);
//   · la factura viaja dentro del XML como .zip de 2 MB como máximo.

const VUA_MAX_LINEAS = 12;
const VUA_MARCA_DEF = 'Rotuladas';   // casilla «Marca» por defecto en cada línea
const VUA_MAX_ANEXO = 2 * 1024 * 1024;
const VUA_TRANSPORTES = { '01':'Camión', '02':'Buque (carga bodega)', '03':'Avión', '04':'Ferrocarril',
                          '05':'Contenedor en buque', '06':'Camión en buque', '07':'Correo postal/mensajería' };
const VUA_CATEGORIAS = { '1':'Extra', '2':'I', '3':'II', '4':'No aplica' };
const VUA_MONEDAS = { EUR:'EUR', USD:'DOL', DOL:'DOL', GBP:'GBP', JPY:'YEN', YEN:'YEN', CNY:'CNY' };
// Moneda de la factura → código ESTACICE: también «€», «EUROS», «US$», «£»…
function vuaMonedaDe(m){
  const t = vuaNormal(m).replace(/[^A-Z€$£¥]/g, '');
  if(VUA_MONEDAS[t]) return VUA_MONEDAS[t];
  if(/^(€|EURO)/.test(t)) return 'EUR';
  if(/\$|DOLAR|DOLLAR/.test(t)) return 'DOL';
  if(/£|LIBRA|POUND|GBP/.test(t)) return 'GBP';
  if(/¥|YEN/.test(t)) return 'YEN';
  if(/YUAN|RMB|CNY/.test(t)) return 'CNY';
  return '';
}
const VUA_CFG_DEF = {
  cicePI: '5801', aduana: '', transporte: '01', ubicacion: '',
  gibraltar: { cicePI: '5802', aduana: '1167' }
};
// sols: solicitudes preparadas en esta pestaña · cat: tablas oficiales cargadas de Supabase
const VUA = { sols: [], seq: 0, cat: null };

function vuaCfg(){
  const c = soivreCfg();
  return Object.assign({}, VUA_CFG_DEF, c.vua || {}, { gibraltar: Object.assign({}, VUA_CFG_DEF.gibraltar, (c.vua || {}).gibraltar) });
}
function vuaGuardarCfg(v){ const c = soivreCfg(); c.vua = v; soivreGuardarCfg(c); }

// ── tablas oficiales (estacice_productos / estacice_codigos) ─
// Supabase devuelve como máximo 1000 filas por consulta: se pide por páginas
async function vuaTodas(consulta){
  const filas = [];
  for(let desde = 0; ; desde += 1000){
    const { data, error } = await consulta().range(desde, desde + 999);
    if(error) return { error };
    filas.push(...(data || []));
    if(!data || data.length < 1000) return { data: filas };
  }
}
async function vuaCatalogo(){
  if(VUA.cat) return VUA.cat;
  const [p, c] = await Promise.all([
    vuaTodas(() => sbT().from('estacice_productos').select('codigo,nombre,tipo,imex').in('tipo', ['F', 'O']).neq('imex', 'I').order('codigo')),
    vuaTodas(() => sbT().from('estacice_codigos').select('tabla,codigo,nombre,grupo').order('nombre').order('codigo'))
  ]);
  if(p.error || c.error) throw new Error((p.error || c.error).message);
  const tabla = t => (c.data || []).filter(x => x.tabla === t);
  VUA.cat = {
    productos: p.data || [], envases: tabla('envase'), aduanas: tabla('aduana'), paises: tabla('pais'),
    provincias: tabla('provincia'), cices: tabla('cice_pi')
  };
  return VUA.cat;
}

// Productos SOIVRE posibles para un TARIC: los del mismo capítulo (el XSD solo
// exige que coincidan las dos primeras cifras; p. ej. «072050 Perejil» va con
// el TARIC 0709). Se ordenan por parecido con la descripción de la factura.
// Nombres de factura que no coinciden con el nombre oficial de la tabla
const VUA_SINONIMOS = [
  // TARIC 1509 90: definición legal de la categoría «Aceite de oliva» (mezcla), no un aceite refinado ni virgen
  [/(CONTIENE|COMPUESTO DE|COMPOSED OF)? *EXCLUSIVAMENTE ACEITES? DE OLIVA REFINADOS? Y (ACEITES? DE OLIVA )?VIRGEN\w*/g, ' '],
  [/CHAMPI\w*/g, 'SETAS OTRAS ESPECIES'], [/BROCOLI\w*/g, 'BROCULI'], [/MEZCLUM/g, 'ENSALADAS'],
                       [/HIERBABUENA/g, 'MENTA HIERBABUENA']];
function vuaNormal(s){ return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }
const VUA_VACIAS = new Set(['QUE', 'CON', 'SIN', 'LOS', 'LAS', 'DEL', 'PARA', 'POR', 'UNA', 'UNO', 'THE', 'AND', 'WITH']);
function vuaPalabras(t){
  let n = vuaNormal(t);
  VUA_SINONIMOS.forEach(([re, sust]) => { n = n.replace(re, sust); });
  return n.split(/[^A-Z]+/).filter(w => w.length > 2 && !VUA_VACIAS.has(w));
}
// El código SOIVRE no siempre sigue al TARIC: SOIVRE filtra por la partida
// (6 o 4 dígitos) y después decide por la descripción. Por eso:
//  · la descripción manda: la 1ª palabra de la factura (el producto: «Calabaza»,
//    «Aceite»…) pesa más que el resto (variedad, calibre…), comparando por
//    prefijo de hasta 7 letras con cada palabra del nombre oficial
//    («CALABAZ» ≠ «CALABACINES»);
//  · a igualdad de descripción, desempata la coincidencia con el TARIC
//    (6 dígitos > 4 dígitos).
function vuaPuntos(p, desc, taric){
  const nombre = vuaPalabras(p.nombre);
  const esta = w => nombre.some(x => x.startsWith(w.slice(0, 7)));
  let pt = 0;
  vuaPalabras(desc).forEach((w, i) => { if(esta(w)) pt += i === 0 ? 3 : 1; });
  // Palabras del nombre oficial que la factura no menciona: mejor el más ajustado
  // («Aceite de oliva virgen extra» antes que «… virgen lampante»)
  if(pt){
    const enDesc = vuaPalabras(desc);
    pt -= 0.1 * nombre.filter(x => !enDesc.some(w => x.startsWith(w.slice(0, 7)) || w.startsWith(x.slice(0, 7)))).length;
  }
  // A igualdad, el genérico («Cebollas otras») antes que una variedad que la factura no nombra («Cebollas Lanzarote»)
  if(pt && /LAS DEMAS|LOS DEMAS|OTRAS|OTROS/.test(vuaNormal(p.nombre))) pt += 0.2;
  const t = String(taric || '').replace(/\D/g, '');
  if(pt && t.length >= 6 && p.codigo.slice(0, 6) === t.slice(0, 6)) pt += 0.3;
  if(pt && p.codigo.slice(0, 4) === t.slice(0, 4)) pt += 0.5;
  return pt;
}
// Productos del mismo tipo y capítulo; si el capítulo no tiene ninguno, todos los
// del tipo (el código SOIVRE puede no compartir capítulo con el TARIC). Sin
// descripción, primero los de la misma partida de 4 dígitos.
function vuaProductosPara(taric, tipo = 'F', desc = ''){
  const t = String(taric || '').replace(/\D/g, '');
  const delTipo = (VUA.cat && VUA.cat.productos || []).filter(p => p.imex !== 'I' && p.tipo === tipo);
  const cap = delTipo.filter(p => p.codigo.startsWith(t.slice(0, 2)));
  const prods = cap.length ? cap : delTipo;
  const partida = p => p.codigo.startsWith(t.slice(0, 4)) ? 0 : 1;
  if(!desc) return [...prods].sort((a, b) => partida(a) - partida(b) || a.codigo.localeCompare(b.codigo));
  return prods.map(p => [vuaPuntos(p, desc, t), p]).sort((a, b) => b[0] - a[0] || partida(a[1]) - partida(b[1]) || a[1].codigo.localeCompare(b[1].codigo)).map(x => x[1]);
}
// Solo se preselecciona si coincide el producto (1ª palabra); si no, queda
// «— producto SOIVRE —» para que el usuario lo elija o quite la línea.
function vuaElegirProducto(taric, descripcion, tipo = 'F'){
  const mejor = vuaProductosPara(taric, tipo, descripcion)[0];
  return mejor && vuaPuntos(mejor, descripcion, taric) >= 2.5 ? mejor.codigo : '';
}

// Origen por línea indicado en las observaciones de la factura:
// «NARANJA: SUDAFRICA / BANANA: COSTA RICA» → { NARANJA: 'ZA', BANANA: 'CR' }
function vuaOrigenesDeNotas(cab){
  const textos = [cab.observaciones, cab.notas, cab.observaciones_factura, ...(Array.isArray(cab.observaciones_importantes) ? cab.observaciones_importantes : [])]
    .filter(Boolean).join('\n');
  const paises = (VUA.cat && VUA.cat.paises) || [];
  const m = {};
  for(const [, prod, pais] of vuaNormal(textos).matchAll(/([A-Z]{3,})\s*:\s*([A-Z][A-Z ]{2,}?)(?=\s*(?:\n|,|;|\/|$|[A-Z]{3,}\s*:))/g)){
    const p = paises.find(x => vuaNormal(x.nombre) === pais.trim()) || paises.find(x => vuaNormal(x.nombre).startsWith(pais.trim()));
    if(p) m[prod] = p.codigo;
  }
  return m;
}

function vuaNombreEnvase(unidad){
  const u = String(unidad || '').trim();
  if(!u || /^(kg|kgs|kilos?|l|litros?|u|ud|uds|unidades?|pcs?|piezas?)$/i.test(u)) return 'Cajas';
  return (u.charAt(0).toUpperCase() + u.slice(1).toLowerCase()).slice(0, 20);
}
function vuaEnvaseDe(unidad){
  const u = vuaNormal(unidad).replace(/S$/, '');
  if(!u) return '04';
  const e = (VUA.cat && VUA.cat.envases || []).find(x => vuaNormal(x.nombre).replace(/S$/, '').startsWith(u.slice(0, 4)));
  return e ? e.codigo : '04';
}

// ── datos de la factura → agente económico ───────────────────
// «AV. JOSE MARTIN MENDEZ, 58 29680 ESTEPONA (MÁLAGA)» → dirección, CP,
// localidad y provincia (en España la provincia son los 2 primeros dígitos del CP).
function vuaDesglosarDireccion(dir){
  const t = String(dir || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/\b([0-5]\d{4})\b(.*)$/);
  if(!m) return { direccion: t.slice(0, 45), cp: '', localidad: '', provincia: '' };
  const localidad = m[2].replace(/^[\s,.-]+/, '').replace(/\(.*?\)/g, '').split(/[,;-]/)[0].trim();
  return { direccion: t.slice(0, m.index).replace(/[\s,.-]+$/, '').slice(0, 45), cp: m[1],
           localidad: localidad.slice(0, 45), provincia: m[1].slice(0, 2) };
}
function vuaAgenteDe(exp){
  exp = exp || {};
  const pais = (typeof _vtPaisISO === 'function' ? _vtPaisISO(exp.pais || 'ES') : 'ES') || 'ES';
  let nif = String(exp.nif || '').replace(/[\s.-]/g, '').toUpperCase();
  let paisNif = pais;
  // Un NIF español nunca empieza por dos letras: «ESB93462885» es el NIF-IVA → país ES + NIF B93462885
  const m = nif.match(/^([A-Z]{2})([0-9A-Z]{7,13})$/);
  if(m){ paisNif = m[1]; nif = m[2]; }
  return Object.assign({ paisNif, nif, nombre: String(exp.nombre || '').trim().slice(0, 66), pais }, vuaDesglosarDireccion(exp.direccion));
}

// ── preparación desde «Leer factura» ─────────────────────────
function vuaNum(v){
  if(typeof v === 'number') return v;
  let t = String(v ?? '').replace(/[^\d.,]/g, '');
  if(!t) return NaN;
  if(/^\d{1,3}([.,]\d{3})+$/.test(t)) return parseFloat(t.replace(/[.,]/g, ''));
  if(t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else t = t.replace(',', '.');
  return parseFloat(t);
}
const vuaFmt = n => Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';

// ESTACICE exige peso bruto > neto. El neto manda (es el de la factura): si el
// bruto falta o no lo supera (líneas «S/P» de la factura), solo se toca el
// bruto, al mínimo admitido: neto + 0,01 kg. La línea queda marcada.
function vuaAjustarBruto(l){
  const neto = vuaNum(l.pesoNeto), bruto = vuaNum(l.pesoBruto);
  if(!(neto > 0) || bruto > neto) return false;
  l.pesoBruto = vuaFmt(neto + 0.01);
  l.brutoAjustado = true;
  return true;
}

// Peso neto de una línea de factura, en este orden:
//  1º el neto de la línea; 2º la cantidad si está en kg;
//  3º el único peso de la línea (la lectura lo deja en peso_bruto; en estas
//     facturas suele ser el neto, y el bruto ya se ajusta solo si no lo supera);
//  4º el peso estimado por la lectura (reparto del total de la factura).
// netoDe dice de dónde sale para avisar en la línea cuando no es el neto declarado.
function vuaNetoDe(l){
  const n = vuaNum(l.peso_neto);
  if(n > 0) return { neto: n, netoDe: '' };
  if(/^(kg|kgs|kilo)/i.test(String(l.unidad || '').trim()) && vuaNum(l.cantidad) > 0) return { neto: vuaNum(l.cantidad), netoDe: '' };
  if(vuaNum(l.peso_bruto) > 0) return { neto: vuaNum(l.peso_bruto), netoDe: 'peso de la línea de factura' };
  if(vuaNum(l.peso_estimado) > 0) return { neto: vuaNum(l.peso_estimado), netoDe: 'estimado por la lectura' + (l.peso_estimado_base ? ': ' + l.peso_estimado_base : '') };
  return { neto: NaN, netoDe: '' };
}

// lineas: las de la factura con medida SOVEX. Devuelve las solicitudes creadas.
function vuaPrepararDesdeFactura(lineas){
  const cfg = vuaCfg();
  const grupos = new Map();
  (lineas || []).forEach(l => {
    const cab = l._cab || (typeof FACTURA_CABECERA !== 'undefined' && FACTURA_CABECERA) || {};
    const notas = cab._origenesNotas || (cab._origenesNotas = vuaOrigenesDeNotas(cab));
    const primera = vuaPalabras(l.descripcion_es || l.descripcion_original || '')[0] || '';
    const deNota = Object.keys(notas).find(k => k.slice(0, 5) === primera.slice(0, 5));
    const origen = (l.pais_origen && soivreOrigenDe(l)) || (deNota && notas[deNota]) || soivreOrigenDe(l) || 'ES';
    l._origenVua = origen;
    const tipo = (soivreAplica(l.codigo_taric) || {}).tipoVua || 'F';
    const clave = `${l.fichero || cab.numero_factura || ''}|${origen}|${tipo}`;
    if(!grupos.has(clave)) grupos.set(clave, { cab, origen, tipo, archivo: soivreArchivoDe(l), lineas: [] });
    grupos.get(clave).lineas.push(l);
  });
  const nuevas = [];
  grupos.forEach(g => {
    const agente = vuaAgenteDe(g.cab.exportador);
    const destinoTxt = g.cab.pais_destino || (g.cab.destinatario && g.cab.destinatario.pais) || '';
    const destino = destinoTxt ? (typeof _vtPaisISO === 'function' ? _vtPaisISO(destinoTxt) : destinoTxt) : '';
    // Sin moneda reconocible en la factura: EUR (se ve y se cambia en el formulario)
    const moneda = vuaMonedaDe(g.cab.moneda) || 'EUR';
    const lineasVua = g.lineas.map(l => {
      const bruto = vuaNum(l.peso_bruto);
      const { neto, netoDe } = vuaNetoDe(l);
      const envases = vuaNum(l.bultos), cantidad = vuaNum(l.cantidad);
      const desc = l.descripcion_es || l.descripcion_original || '';
      return {
        taric: String(l.codigo_taric || '').replace(/\D/g, ''), origen: l._origenVua, clave: l._claveVT || '',
        descripcion: l.descripcion_es || l.descripcion_original || '',
        envases: Number.isFinite(envases) ? String(Math.round(envases)) : (/caj|box|bult/i.test(l.unidad || '') ? vuaFmt(vuaNum(l.cantidad)) : ''),
        unidad: l.unidad || '', codEnvase: vuaEnvaseDe(l.unidad), marca: VUA_MARCA_DEF,
        producto: vuaElegirProducto(l.codigo_taric, desc, g.tipo),
        // Otros productos: nombre del envase en texto, unidades físicas y envase > 5 kg (obligatorio en aceites)
        nombreEnvase: vuaNombreEnvase(l.unidad), envaseMas5kg: 'N',
        unidades: Number.isFinite(cantidad) && !/kg|kilo|litro|^l$/i.test(l.unidad || '') ? String(Math.round(cantidad)) : '',
        categoria: '2', pesoBruto: vuaFmt(bruto), pesoNeto: vuaFmt(neto), netoDe,
        importe: vuaNum(l.importe) > 0 ? vuaFmt(vuaNum(l.importe)) : '', moneda,
        factura: String(g.cab.numero_factura || '').slice(0, 30)
      };
    });
    if(g.tipo === 'F') lineasVua.forEach(vuaAjustarBruto);
    for(let i = 0; i < lineasVua.length; i += VUA_MAX_LINEAS){
      nuevas.push(vuaNuevaSolicitud({
        tipo: g.tipo, origen: g.origen, destino, agente, archivo: g.archivo, factura: g.cab.numero_factura || '', cabFactura: g.cab,
        fabricanteEnvasador: agente.nombre,
        destinatario: g.cab.destinatario && g.cab.destinatario.nombre || '',
        lineas: lineasVua.slice(i, i + VUA_MAX_LINEAS),
        parte: lineasVua.length > VUA_MAX_LINEAS ? `${i / VUA_MAX_LINEAS + 1}/${Math.ceil(lineasVua.length / VUA_MAX_LINEAS)}` : ''
      }));
    }
  });
  return nuevas;
}

function vuaNuevaSolicitud(o){
  const cfg = vuaCfg();
  const gib = o.destino === 'GI';
  const s = Object.assign({
    k: 'v' + (++VUA.seq), tipo: 'F', origen: 'ES', destinatario: '', fabricanteEnvasador: '', destino: '', agente: vuaAgenteDe({}), lineas: [], archivo: null,
    envasadorIgual: true, envasador: {}, transporte: cfg.transporte, matricula: '', otrasMatriculas: '',
    ubicacion: cfg.ubicacion, observaciones: '', env: null, info: null
  }, o);
  s.cicePI = o.cicePI || (gib ? cfg.gibraltar.cicePI : cfg.cicePI);
  s.aduana = o.aduana || (gib ? cfg.gibraltar.aduana : cfg.aduana);
  s.flujo = !s.origen || s.origen === 'ES' ? 'E' : 'R';
  VUA.sols.push(s);
  return s;
}
const vuaSol = k => VUA.sols.find(s => s.k === k);

// Panel en «Leer factura» (lo pinta soivrePanelFactura de soivre-cal.js)
function vuaPanelHtml(sols){
  if(!sols.length) return '';
  const filas = sols.map(s => {
    const est = s.env
      ? `<span class="badge" style="${SOIVRE_ESTADO_ESTILO[s.env.estado] || ''}">${sEsc(s.env.estado)}</span>${s.env.numero ? `<div style="font-family:var(--mono);font-size:10px;margin-top:2px">Nº ${sEsc(s.env.numero)}</div>` : ''}`
      : '<span class="badge" style="background:var(--am50);color:var(--am600)">por enviar</span>';
    return `<tr style="border-top:1px solid var(--g100)">
      <td style="padding:6px 4px;white-space:nowrap">${s.tipo === 'O' ? '🫒' : '🍊'} ${s.flujo === 'E' ? 'Exportación' : 'Reexportación'}${s.parte ? ` <span style="color:var(--g400)">(${s.parte})</span>` : ''}<div style="font-size:10px;color:var(--g400)">${s.tipo === 'O' ? 'Otros productos' : 'Frutas y hortalizas'}</div></td>
      <td style="padding:6px 4px">${sEsc(s.agente.nombre || '—')}<div style="font-size:10px;color:var(--g400);font-family:var(--mono)">${sEsc(s.agente.nif || 'sin NIF')} · ${sEsc(s.factura || '—')}${s.archivo ? ' · 📎' : ''}</div></td>
      <td style="padding:6px 4px;white-space:nowrap">${sEsc(s.origen || 'ES')} → ${sEsc(s.destino || '¿?')}</td>
      <td style="padding:6px 4px;text-align:center">${s.lineas.length}</td>
      <td style="padding:6px 4px">${est}</td>
      <td style="padding:6px 4px;text-align:right;white-space:nowrap">${s.env && s.env.numero
        ? `<button class="btn btn-s btn-sm" onclick="vuaConsultar('${s.k}')">Estado</button>`
        : `<button class="btn btn-p btn-sm" onclick="abrirSolicitudVua('${s.k}')">${s.env ? 'Revisar' : 'Preparar'}</button>`}</td>
    </tr>`;
  }).join('');
  return `
    <div style="background:var(--w);border:1px solid var(--g200);border-radius:8px;padding:8px 10px;margin-top:8px">
      <div style="font-size:12px;font-weight:700;margin-bottom:2px">🍊 ESTACICE VUA · control de calidad a la exportación <span style="font-weight:400;color:var(--g500)">· ${sols.length} solicitud${sols.length > 1 ? 'es' : ''} de hasta ${VUA_MAX_LINEAS} líneas</span></div>
      <div style="font-size:11px;color:var(--g500);margin-bottom:4px">Una por factura, país de origen (España = exportación, otro = reexportación) y tipo (frutas y hortalizas / otros productos). El agente económico es el exportador de cada factura. Sin MRN.</div>
      <div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="font-size:10px;color:var(--g500);text-transform:uppercase;text-align:left">
          <th style="padding:4px">Tipo</th><th style="padding:4px">Agente económico</th><th style="padding:4px">Origen → destino</th><th style="padding:4px;text-align:center">Líneas</th><th style="padding:4px">Estado</th><th></th>
        </tr></thead><tbody>${filas}</tbody>
      </table></div>
    </div>`;
}

// ── formulario ───────────────────────────────────────────────
const vuaOpc = (lista, sel, vacio) => (vacio ? `<option value="">${vacio}</option>` : '') +
  lista.map(x => `<option value="${sEsc(x.codigo)}" ${x.codigo === sel ? 'selected' : ''}>${sEsc(x.codigo)} · ${sEsc(x.nombre)}</option>`).join('');
const vuaIn = (id, v, extra = '') => `<input id="${id}" class="fi" style="width:100%" value="${sEsc(v ?? '')}" ${extra}>`;

// Columnas de producto según el tipo: F (frutas y hortalizas) u O (otros productos)
const VUA_COLUMNAS = {
  F: ['Lín', 'TARIC · producto SOIVRE', 'Nº env.', 'Envase', 'Marca', 'Cat.', 'P. bruto', 'P. neto', 'Valor', 'Moneda', 'Nº factura', ''],
  O: ['Lín', 'TARIC · producto SOIVRE', 'Nº env.', 'Nombre envase', '> 5 kg', 'Marca', 'P. neto', 'Unidades', 'Valor', 'Moneda', 'Nº factura', '']
};
function vuaFilaLinea(l, i, tipo = 'F', origenSol = 'ES'){
  const prods = vuaProductosPara(l.taric, tipo, l.descripcion);
  const origen = l.origen || origenSol || 'ES';
  const c = 'style="width:100%;font-size:11px;padding:4px 5px"';
  const celda = (w, html) => `<td style="padding:4px 2px;width:${w}px">${html}</td>`;
  // Valor de la línea (importe de factura) y su moneda: opcionales en ESTACICE
  const monedas = [...new Set(Object.values(VUA_MONEDAS))];
  const comunesFin = celda(90, `<input class="fi vl-importe" ${c} value="${sEsc(l.importe || '')}" inputmode="decimal">`)
    + celda(66, `<select class="fi vl-moneda" ${c}>${monedas.map(m => `<option ${m === (l.moneda || 'EUR') ? 'selected' : ''}>${m}</option>`).join('')}</select>`)
    + celda(110, `<input class="fi vl-factura" ${c} value="${sEsc(l.factura)}" maxlength="30">`)
    + '<td style="padding:4px 2px"><button class="btn btn-s btn-sm" style="padding:2px 6px" title="Quitar línea" onclick="vuaQuitarLinea(this)">✕</button></td>';
  const especificas = tipo === 'O'
    ? celda(100, `<input class="fi vl-nomenv" ${c} value="${sEsc(l.nombreEnvase || '')}" maxlength="20" placeholder="Botellas">`)
      + celda(70, `<select class="fi vl-mas5" ${c}><option value="N">No</option><option value="S" ${l.envaseMas5kg === 'S' ? 'selected' : ''}>Sí</option></select>`)
      + celda(120, `<input class="fi vl-marca" ${c} value="${sEsc(l.marca)}" maxlength="40">`)
      + celda(80, `<input class="fi vl-neto" ${c} value="${sEsc(l.pesoNeto)}" inputmode="decimal">`)
      + celda(80, `<input class="fi vl-unidades" ${c} value="${sEsc(l.unidades || '')}" inputmode="numeric">`)
    : celda(110, `<select class="fi vl-codenv" ${c}>${vuaOpc(VUA.cat.envases, l.codEnvase)}</select>`)
      + celda(100, `<input class="fi vl-marca" ${c} value="${sEsc(l.marca)}" maxlength="20">`)
      + celda(70, `<select class="fi vl-cat" ${c}>${Object.entries(VUA_CATEGORIAS).map(([k, v]) => `<option value="${k}" ${k === l.categoria ? 'selected' : ''}>${v}</option>`).join('')}</select>`)
      + celda(80, `<input class="fi vl-bruto" ${c} value="${sEsc(l.pesoBruto)}" inputmode="decimal">${l.brutoAjustado ? '<div style="font-size:9px;color:var(--am600)" title="La factura no trae un bruto mayor que el neto: se ha puesto neto + 0,01 kg">ajustado</div>' : ''}`)
      + celda(80, `<input class="fi vl-neto" ${c} value="${sEsc(l.pesoNeto)}" inputmode="decimal">`);
  return `<tr data-i="${i}" style="border-top:1px solid var(--g100);vertical-align:top">
    <td style="padding:4px 2px;text-align:center;font-weight:700">${i + 1}</td>
    <td style="padding:4px 2px;min-width:150px">
      <input class="fi vl-taric" value="${sEsc(l.taric)}" maxlength="10" onchange="vuaRefrescarProductos(this)" style="width:100%;font-size:11px;padding:4px 5px;font-family:var(--mono)">
      <select class="fi vl-producto" ${c}>${vuaOpc(prods, l.producto, prods.length ? '— producto SOIVRE —' : 'Sin productos para este TARIC')}</select>
      <div style="display:flex;align-items:center;gap:4px;margin-top:2px">
        <span style="font-size:10px;color:var(--g400)">Origen</span>
        <select class="fi vl-origen" style="width:auto;font-size:10px;padding:1px 3px" title="Si es distinto del de la solicitud, la línea pasa a otra solicitud al enviar">${vuaOpc(VUA.cat.paises.map(p => ({ codigo: p.codigo, nombre: p.codigo })), origen)}</select>
        <span style="font-size:10px;color:var(--g400);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${sEsc(l.descripcion || '')}">${sEsc(l.descripcion || '')}</span>
      </div>
      ${l.producto ? '' : `<div style="font-size:10px;color:var(--am600)">⚠ Elige el producto SOIVRE o quita la línea si no lleva control</div>`}
      ${l.netoDe && l.pesoNeto ? `<div style="font-size:10px;color:var(--am600)" title="${sEsc(l.netoDe)}">ℹ Peso neto ${sEsc(l.pesoNeto)} kg tomado del ${sEsc(l.netoDe.split(':')[0])}: revísalo</div>` : ''}
    </td>
    ${celda(70, `<input class="fi vl-envases" ${c} value="${sEsc(l.envases)}" inputmode="numeric">`)}
    ${especificas}${comunesFin}
  </tr>`;
}

async function abrirSolicitudVua(k){
  const s = vuaSol(k);
  if(!s) return;
  const esO = s.tipo === 'O';
  soivreModal(`${esO ? '🫒' : '🍊'} Solicitud ESTACICE VUA · ${esO ? 'otros productos (calidad comercial)' : 'frutas y hortalizas'}`,
              '<div class="loading-wrap"><div class="spinner"></div><span>Cargando tablas oficiales…</span></div>', 1020);
  soivreComprobarServidor().then(() => { const el = document.getElementById('vua-entorno'); if(el) el.innerHTML = soivreChipEntorno(SOIVRE.estado); });
  try{ await vuaCatalogo(); }
  catch(e){ document.getElementById('soivre-modal-body').innerHTML = sAviso(`No se pudieron leer las tablas ESTACICE de Supabase (${sEsc(e.message)}). ¿Se ha ejecutado instalar_soivre.sql?`); return; }
  // Recalcular productos si la solicitud se preparó antes de tener el catálogo
  s.lineas.forEach(l => {
    if(!l.producto) l.producto = vuaElegirProducto(l.taric, l.descripcion, s.tipo);
    if(l.unidad && !l._envRevisado){ l.codEnvase = vuaEnvaseDe(l.unidad); l._envRevisado = true; }
  });
  const cat = VUA.cat, a = s.agente, en = s.envasador || {};
  const paisOpc = sel => vuaOpc(cat.paises, sel);
  const provOpc = sel => vuaOpc(cat.provincias, sel, '—');
  const envasadorF = `
    <details style="margin-bottom:10px" ${s.envasadorIgual ? '' : 'open'}>
      <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--g600)">Envasador <label style="font-weight:400;margin-left:8px" onclick="event.stopPropagation()"><input type="checkbox" id="vua-env-igual" ${s.envasadorIgual ? 'checked' : ''}> el mismo que el agente económico</label></summary>
      <div style="height:8px"></div>
      ${sGrid(150,
        sCampo('NIF', vuaIn('vua-env-nif', en.nif, 'maxlength="15"')),
        `<div style="grid-column:span 2">${sCampo('Nombre', vuaIn('vua-env-nombre', en.nombre, 'maxlength="66"'))}</div>`,
        sCampo('Dirección', vuaIn('vua-env-direccion', en.direccion, 'maxlength="45"')),
        sCampo('CP', vuaIn('vua-env-cp', en.cp, 'maxlength="5"')),
        sCampo('Localidad', vuaIn('vua-env-localidad', en.localidad, 'maxlength="45"')),
        sCampo('Provincia', `<select id="vua-env-prov" class="fi" style="width:100%">${provOpc(en.provincia)}</select>`),
        sCampo('País', `<select id="vua-env-pais" class="fi" style="width:100%">${vuaOpc(cat.paises, en.pais || '', '—')}</select>`)
      )}
    </details>`;
  const partesO = sGrid(220,
    sCampo('Destinatario * (según factura)', vuaIn('vua-destinatario', s.destinatario, 'maxlength="66"')),
    sCampo('Fabricante / envasador', vuaIn('vua-fabenv', s.fabricanteEnvasador, 'maxlength="66"')));
  document.getElementById('soivre-modal-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <div id="vua-entorno">${soivreChipEntorno(SOIVRE.estado)}</div>
      <label style="font-size:12px;margin-left:auto">Tipo de solicitud
        <select id="vua-tiposol" class="fi" style="width:auto;margin-left:6px" onchange="vuaCambiarTipo('${k}', this.value)">
          <option value="F" ${!esO ? 'selected' : ''}>Frutas y hortalizas frescas</option>
          <option value="O" ${esO ? 'selected' : ''}>Otros productos (aceite, aceitunas…)</option>
        </select></label>
    </div>
    ${sGrid(170,
      sCampo('Centro y punto de inspección', `<select id="vua-cice" class="fi" style="width:100%">${vuaOpc(cat.cices.filter(c => c.grupo === 'Algeciras' || c.codigo === s.cicePI), s.cicePI)}<option value="" disabled>──────────</option>${vuaOpc(cat.cices.filter(c => c.grupo !== 'Algeciras' && c.codigo !== s.cicePI), '')}</select>`),
      sCampo('Flujo', `<select id="vua-flujo" class="fi" style="width:100%"><option value="E" ${s.flujo === 'E' ? 'selected' : ''}>Exportación</option><option value="R" ${s.flujo === 'R' ? 'selected' : ''}>Reexportación</option></select>`),
      sCampo('País de origen', `<select id="vua-origen" class="fi" style="width:100%" onchange="document.getElementById('vua-flujo').value=this.value==='ES'?'E':'R'">${paisOpc(s.origen || 'ES')}</select>`),
      sCampo('País de destino', `<select id="vua-destino" class="fi" style="width:100%" onchange="vuaDestinoCambiado(this.value)">${vuaOpc(cat.paises, s.destino, '— elegir —')}</select>`)
    )}
    ${sGrid(170,
      sCampo('Aduana de salida', `<select id="vua-aduana" class="fi" style="width:100%">${vuaOpc(cat.aduanas, s.aduana, '— elegir —')}</select>`),
      sCampo('Transporte', `<select id="vua-transporte" class="fi" style="width:100%">${Object.entries(VUA_TRANSPORTES).map(([kk, v]) => `<option value="${kk}" ${kk === s.transporte ? 'selected' : ''}>${v}</option>`).join('')}</select>`),
      sCampo('Matrícula *', vuaIn('vua-matricula', s.matricula, 'maxlength="15" oninput="this.value=this.value.toUpperCase()"')),
      sCampo('Otras matrículas', vuaIn('vua-otras', s.otrasMatriculas, 'maxlength="85"'))
    )}
    ${sGrid(220, sCampo('Ubicación de la mercancía', vuaIn('vua-ubicacion', s.ubicacion, 'maxlength="40" placeholder="La Línea"')),
                 sCampo('Observaciones', vuaIn('vua-observaciones', s.observaciones, 'maxlength="255"')))}
    <fieldset style="border:1px solid var(--g200);border-radius:8px;padding:8px 12px;margin-bottom:10px">
      <legend style="font-size:12px;font-weight:700;color:var(--g600);padding:0 6px">Agente económico (exportador de la factura)</legend>
      ${sGrid(150,
        sCampo('País NIF', `<select id="vua-ae-paisnif" class="fi" style="width:100%">${paisOpc(a.paisNif || 'ES')}</select>`),
        sCampo('NIF *', vuaIn('vua-ae-nif', a.nif, 'maxlength="15" style="width:100%;font-family:var(--mono)"')),
        `<div style="grid-column:span 2">${sCampo('Nombre fiscal *', vuaIn('vua-ae-nombre', a.nombre, 'maxlength="66"'))}</div>`
      )}
      ${sGrid(150,
        `<div style="grid-column:span 2">${sCampo(esO ? 'Dirección' : 'Dirección *', vuaIn('vua-ae-direccion', a.direccion, 'maxlength="45"'))}</div>`,
        sCampo('CP', vuaIn('vua-ae-cp', a.cp, 'maxlength="5" oninput="const p=document.getElementById(\'vua-ae-prov\');if(this.value.length===5&&p)p.value=this.value.slice(0,2)"')),
        sCampo('Localidad *', vuaIn('vua-ae-localidad', a.localidad, 'maxlength="45"')),
        sCampo('Provincia', `<select id="vua-ae-prov" class="fi" style="width:100%">${provOpc(a.provincia)}</select>`),
        sCampo('País', `<select id="vua-ae-pais" class="fi" style="width:100%">${paisOpc(a.pais || 'ES')}</select>`)
      )}
      ${!esO && s.destinatario ? `<div style="font-size:11px;color:var(--g500)">Destinatario según factura: <strong>${sEsc(s.destinatario)}</strong>. La solicitud de frutas no tiene campo para el destinatario; consta en la factura adjunta.</div>` : ''}
    </fieldset>
    ${esO ? partesO : envasadorF}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <div style="font-size:12px;font-weight:700;color:var(--g600)">Productos <span id="vua-nlineas" style="font-weight:400;color:var(--g400)">(${s.lineas.length}/${VUA_MAX_LINEAS})</span></div>
      <button class="btn btn-s btn-sm" style="margin-left:auto" onclick="vuaAnadirLinea('${k}')">+ Línea</button>
    </div>
    <div style="overflow-x:auto;margin-bottom:10px"><table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="font-size:10px;color:var(--g500);text-transform:uppercase;text-align:left">${VUA_COLUMNAS[s.tipo].map(t => `<th>${t}</th>`).join('')}</tr></thead>
      <tbody id="vua-lineas" data-tipo="${s.tipo}" data-origen="${sEsc(s.origen || 'ES')}">${s.lineas.map((l, i) => vuaFilaLinea(l, i, s.tipo, s.origen)).join('')}</tbody>
    </table></div>
    <div style="background:var(--b50);border:1px dashed var(--b500);border-radius:8px;padding:10px 12px;margin-bottom:10px">
      ${sLbl('Factura comercial (anexo)')}
      ${s.archivo ? `<div style="font-size:12px;margin-bottom:6px">📎 <strong>${sEsc(s.archivo.name)}</strong> <span style="color:var(--g500)">(factura leída, ${(s.archivo.size / 1048576).toFixed(2)} MB). Se adjunta sola; elige otro fichero solo para sustituirla.</span></div>` : ''}
      <input type="file" id="vua-factura" accept=".zip,.pdf,.jpg,.jpeg,.tif,.tiff" style="font-size:12px;width:100%">
      <div style="font-size:11px;color:var(--g500);margin-top:4px">Va dentro de la solicitud como <strong>.zip</strong>. ESTACICE admite como máximo <strong>2 MB</strong> comprimido.</div>
    </div>
    <div id="sv-errores"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid var(--g100);padding-top:12px">
      <button class="btn btn-s btn-sm" onclick="vuaLeerFormulario('${k}');soivreCerrarModal();if(typeof soivrePanelFacturaRefrescar==='function')soivrePanelFacturaRefrescar()">Guardar y cerrar</button>
      <button class="btn btn-s btn-sm" onclick="vuaEnviar('${k}', true)">👁 Ver XML</button>
      <button class="btn btn-p" id="sv-enviar" onclick="vuaEnviar('${k}', false)">Enviar a ESTACICE</button>
    </div>`;
}

// Cambiar entre F y O conserva cabecera y lo común de cada línea
function vuaCambiarTipo(k, tipo){
  const s = vuaLeerFormulario(k);
  s.tipo = tipo;
  s.lineas.forEach(l => { l.producto = vuaElegirProducto(l.taric, l.descripcion, tipo); });
  if(tipo === 'O' && !s.fabricanteEnvasador) s.fabricanteEnvasador = s.agente.nombre;
  abrirSolicitudVua(k);
}
function vuaDestinoCambiado(destino){
  const cfg = vuaCfg();
  const set = (id, v) => { const el = document.getElementById(id); if(el && v && el.querySelector(`option[value="${v}"]`)) el.value = v; };
  if(destino === 'GI'){ set('vua-cice', cfg.gibraltar.cicePI); set('vua-aduana', cfg.gibraltar.aduana); }
}
function vuaRefrescarProductos(input){
  const tr = input.closest('tr');
  const prods = vuaProductosPara(input.value, document.getElementById('vua-lineas').dataset.tipo, tr.querySelector('span[title]')?.title || '');
  tr.querySelector('.vl-producto').innerHTML = vuaOpc(prods, '', prods.length ? '— producto SOIVRE —' : 'Sin productos para este TARIC');
}
function vuaContarLineas(){
  const n = document.querySelectorAll('#vua-lineas tr').length;
  const el = document.getElementById('vua-nlineas'); if(el) el.textContent = `(${n}/${VUA_MAX_LINEAS})`;
  document.querySelectorAll('#vua-lineas tr').forEach((tr, i) => { tr.firstElementChild.textContent = i + 1; });
}
function vuaAnadirLinea(){
  const tb = document.getElementById('vua-lineas');
  if(tb.children.length >= VUA_MAX_LINEAS) return showToast(`Máximo ${VUA_MAX_LINEAS} líneas por solicitud`);
  const prev = tb.lastElementChild;
  const base = { taric: '', descripcion: '', envases: '', codEnvase: '04', marca: VUA_MARCA_DEF,
                 producto: '', categoria: '2', pesoBruto: '', pesoNeto: '', nombreEnvase: '', envaseMas5kg: 'N', unidades: '',
                 factura: prev ? prev.querySelector('.vl-factura').value : '' };
  tb.insertAdjacentHTML('beforeend', vuaFilaLinea(base, tb.children.length, tb.dataset.tipo, document.getElementById('vua-origen')?.value));
  vuaContarLineas();
}
function vuaQuitarLinea(btn){ btn.closest('tr').remove(); vuaContarLineas(); }

// Vuelca el formulario en la solicitud (para no perder lo tecleado)
function vuaLeerFormulario(k){
  const s = vuaSol(k);
  const v = id => (document.getElementById(id)?.value || '').trim();
  if(!s || !document.getElementById('vua-flujo')) return s;
  const esO = s.tipo === 'O';
  Object.assign(s, {
    cicePI: v('vua-cice'), flujo: v('vua-flujo'), origen: v('vua-origen'), destino: v('vua-destino'),
    aduana: v('vua-aduana'), transporte: v('vua-transporte'), matricula: v('vua-matricula'),
    otrasMatriculas: v('vua-otras'), ubicacion: v('vua-ubicacion'), observaciones: v('vua-observaciones'),
    agente: { paisNif: v('vua-ae-paisnif'), nif: v('vua-ae-nif').toUpperCase(), nombre: v('vua-ae-nombre'), direccion: v('vua-ae-direccion'),
              cp: v('vua-ae-cp'), localidad: v('vua-ae-localidad'), provincia: v('vua-ae-prov'), pais: v('vua-ae-pais') }
  });
  if(esO) Object.assign(s, { destinatario: v('vua-destinatario'), fabricanteEnvasador: v('vua-fabenv') });
  else Object.assign(s, {
    envasadorIgual: document.getElementById('vua-env-igual').checked,
    envasador: { nif: v('vua-env-nif').toUpperCase(), nombre: v('vua-env-nombre'), direccion: v('vua-env-direccion'), cp: v('vua-env-cp'),
                 localidad: v('vua-env-localidad'), provincia: v('vua-env-prov'), pais: v('vua-env-pais') }
  });
  s.lineas = [...document.querySelectorAll('#vua-lineas tr')].map(tr => {
    const q = c => (tr.querySelector(c)?.value || '').trim();
    const prev = s.lineas[+tr.dataset.i] || {};
    const l = Object.assign({}, prev, {
      taric: q('.vl-taric').replace(/\D/g, ''), producto: q('.vl-producto'), envases: q('.vl-envases'), origen: q('.vl-origen'),
      marca: q('.vl-marca'), pesoNeto: q('.vl-neto').replace(',', '.'), factura: q('.vl-factura'), _envRevisado: true,
      importe: q('.vl-importe').replace(',', '.'), moneda: q('.vl-moneda')
    });
    if(l.pesoNeto !== prev.pesoNeto) l.netoDe = '';   // tocado a mano: ya no es una deducción
    if(esO) Object.assign(l, { nombreEnvase: q('.vl-nomenv'), envaseMas5kg: q('.vl-mas5'), unidades: q('.vl-unidades') });
    else Object.assign(l, { codEnvase: q('.vl-codenv'), categoria: q('.vl-cat'), pesoBruto: q('.vl-bruto').replace(',', '.') });
    return l;
  });
  const f = document.getElementById('vua-factura')?.files?.[0];
  if(f) s.archivo = f;
  return s;
}

function vuaDatos(s){
  const ae = s.agente;
  const comun = {
    tipo: s.tipo, codCicePI: s.cicePI, exporImpor: s.flujo, ubicacion: s.ubicacion, agente: ae,
    // En exportación el origen va vacío o ES: se envía ES
    origen: s.flujo === 'E' ? 'ES' : s.origen, destino: s.destino, transporte: s.transporte,
    matricula: s.matricula, otrasMatriculas: s.otrasMatriculas, aduana: s.aduana, observaciones: s.observaciones
  };
  if(s.tipo === 'O') return Object.assign(comun, {
    destinatario: s.destinatario, fabricanteEnvasador: s.fabricanteEnvasador,
    lineas: s.lineas.map(l => ({ envases: l.envases, nombreEnvase: l.nombreEnvase, envaseMas5kg: l.envaseMas5kg, marca: l.marca,
                                 producto: l.producto, taric: l.taric, pesoNeto: l.pesoNeto, unidades: l.unidades,
                                 factura: l.factura, importe: l.importe, moneda: l.moneda }))
  });
  return Object.assign(comun, {
    envasador: s.envasadorIgual ? { nif: ae.nif, nombre: ae.nombre, direccion: ae.direccion, cp: ae.cp,
                                    localidad: ae.localidad, provincia: ae.provincia, pais: ae.pais } : s.envasador,
    lineas: s.lineas.map(l => ({ envases: l.envases, codEnvase: l.codEnvase, marca: l.marca, producto: l.producto, taric: l.taric,
                                 categoria: l.categoria, pesoBruto: l.pesoBruto, pesoNeto: l.pesoNeto, factura: l.factura,
                                 importe: l.importe, moneda: l.moneda }))
  });
}

// Comprobación previa en el navegador (el servidor vuelve a validar contra el XSD)
function vuaComprobar(s, d){
  const e = [];
  const esO = d.tipo === 'O';
  if(!/^\d{4}$/.test(d.codCicePI)) e.push('Elige el centro y punto de inspección');
  if(!d.destino || d.destino === 'ES') e.push('País de destino: obligatorio y distinto de España');
  if(d.exporImpor === 'R' && (!s.origen || s.origen === 'ES')) e.push('Reexportación: el país de origen no puede ser España');
  if(d.exporImpor === 'E' && s.origen && s.origen !== 'ES') e.push('Origen distinto de España: es una reexportación');
  if(!/^\d{4}$/.test(d.aduana)) e.push('Elige la aduana de salida');
  if((d.matricula || '').length < 3) e.push('Matrícula: obligatoria');
  if(!d.agente.nif || d.agente.nif.length < 7) e.push('Agente económico: NIF obligatorio');
  if(!d.agente.nombre || d.agente.nombre.length < 3) e.push('Agente económico: nombre fiscal obligatorio');
  if(!d.agente.localidad || (!esO && !d.agente.direccion)) e.push(esO ? 'Agente económico: localidad obligatoria' : 'Agente económico: dirección y localidad obligatorias');
  if(d.agente.pais === 'ES' && !d.agente.provincia) e.push('Agente económico español: provincia obligatoria');
  if(!esO && d.agente.pais === 'ES' && !/^\d{5}$/.test(d.agente.cp)) e.push('Agente económico español: CP obligatorio');
  if(esO && (d.destinatario || '').length < 3) e.push('Destinatario: obligatorio');
  if(!d.lineas.length || d.lineas.length > VUA_MAX_LINEAS) e.push(`Entre 1 y ${VUA_MAX_LINEAS} líneas`);
  d.lineas.forEach((l, i) => {
    const p = `Línea ${i + 1}`;
    if(!l.producto) e.push(`${p}: elige el producto SOIVRE`);
    if(!/^\d+$/.test(l.envases)) e.push(`${p}: nº de envases`);
    if((l.marca || '').length < 2) e.push(`${p}: marca (mín. 2 caracteres)`);
    const n = parseFloat(l.pesoNeto);
    if(!(n > 0)) e.push(`${p}: peso neto`);
    if(esO){
      if((l.nombreEnvase || '').length < 2) e.push(`${p}: nombre del envase`);
      if(!l.envaseMas5kg && String(l.producto).startsWith('15')) e.push(`${p}: indica si el envase pesa más de 5 kg (obligatorio en aceites)`);
      if(l.unidades && !/^\d+$/.test(l.unidades)) e.push(`${p}: unidades, número entero`);
    } else if(!(parseFloat(l.pesoBruto) > n)) e.push(`${p}: el peso bruto debe ser mayor que el neto`);
    if(l.importe && !(parseFloat(l.importe) >= 0.01 && /^\d+(\.\d{1,2})?$/.test(l.importe))) e.push(`${p}: valor, importe con 2 decimales como máximo`);
    if((l.factura || '').length < 3) e.push(`${p}: nº de factura`);
  });
  if(s.archivo && /\.zip$/i.test(s.archivo.name) && s.archivo.size > VUA_MAX_ANEXO) e.push('La factura .zip supera 2 MB');
  if(s.archivo && s.archivo.size > SOIVRE_MAX_FICHERO) e.push('La factura supera 10 MB');
  return e;
}

function vuaIdMensaje(){
  // TIdSolicitud: máx. 20 caracteres. V + aammddhhmmss + 6 aleatorios
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `V${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')}`;
}

// Las líneas con otro país de origen no pueden ir en esta solicitud: pasan a
// otra (España → exportación; otro país → reexportación) con la misma cabecera.
function vuaSepararPorOrigen(s){
  const propio = s.origen || 'ES';
  const otras = s.lineas.filter(l => (l.origen || propio) !== propio);
  if(!otras.length) return [];
  s.lineas = s.lineas.filter(l => (l.origen || propio) === propio);
  const porOrigen = new Map();
  otras.forEach(l => { if(!porOrigen.has(l.origen)) porOrigen.set(l.origen, []); porOrigen.get(l.origen).push(l); });
  const nuevas = [];
  porOrigen.forEach((lineas, origen) => {
    const { k: _k, env: _e, info: _i, idMensaje: _id, flujo: _f, ...cabecera } = s;
    nuevas.push(vuaNuevaSolicitud(Object.assign({}, cabecera, { origen, lineas, parte: '' })));
  });
  if(SOIVRE.vuaSols) SOIVRE.vuaSols.push(...nuevas);
  return nuevas;
}

async function vuaEnviar(k, soloXml){
  const s = vuaLeerFormulario(k);
  const separadas = vuaSepararPorOrigen(s);
  if(separadas.length){
    if(typeof soivrePanelFacturaRefrescar === 'function') soivrePanelFacturaRefrescar();
    showToast(`${separadas.reduce((n, x) => n + x.lineas.length, 0)} línea(s) de otro origen pasan a ${separadas.length} solicitud(es) aparte (${separadas.map(x => x.origen).join(', ')})`);
    if(!s.lineas.length){ soivreCerrarModal(); return abrirSolicitudVua(separadas[0].k); }
  }
  const d = vuaDatos(s);
  // Recordar centro/aduana habituales
  const cfg = vuaCfg();
  if(s.destino !== 'GI'){ cfg.cicePI = s.cicePI || cfg.cicePI; cfg.aduana = s.aduana || cfg.aduana; }
  cfg.transporte = s.transporte; cfg.ubicacion = s.ubicacion || cfg.ubicacion; cfg.ultimoAgente = s.agente;
  vuaGuardarCfg(cfg);

  // Bruto ≤ neto tras editar: se corrige el bruto, nunca el neto
  if(s.tipo === 'F'){
    const n = s.lineas.filter(vuaAjustarBruto).length;
    if(n){ d.lineas = vuaDatos(s).lineas; showToast(`Peso bruto ajustado a neto + 0,01 kg en ${n} línea(s)`); }
  }
  const errores = vuaComprobar(s, d);
  if(errores.length && !soloXml) return soivreMostrarErrores(errores);
  const e = await soivreComprobarServidor();
  if(!e.ok) return soivreMostrarErrores([e.error || 'Servidor SOIVRE sin conexión']);

  if(soloXml){
    soivreMostrarErrores(['Generando XML en el servidor…']);
    const r = await soivreLlamar('VUA', d, vuaIdMensaje(), true);
    if(!r.ok) return soivreMostrarErrores(r.validacion ? r.errores : [r.error || r.descripcion]);
    soivreMostrarErrores([]);
    return soivreVerXml('XML ESTACICE (no enviado)', r.xmlEnviado);
  }
  if(e.entorno === 'produccion' && !e.simulacion &&
     !confirm(`Vas a enviar a ESTACICE (PRODUCCIÓN) una solicitud REAL de ${s.lineas.length} línea(s) del exportador ${s.agente.nombre}, firmada con ${e.titular}. ¿Continuar?`)) return;

  const btn = document.getElementById('sv-enviar');
  if(btn){ btn.disabled = true; btn.textContent = 'Enviando a ESTACICE…'; }
  // El Id se conserva: si se reintenta, el servidor pregunta antes a ESTACICE
  // si ya existe y no la duplica
  if(!(s.idMensaje && s.env && ['error', 'en cola'].includes(s.env.estado))) s.idMensaje = vuaIdMensaje();
  let r;
  try{ r = await soivreLlamar('VUA', d, s.idMensaje, false, { agente: s.agente.nombre, lineas: s.lineas.length }, s.archivo); }
  catch(err){ r = { ok: false, error: 'Sin conexión con Supabase: ' + err.message }; }
  if(btn){ btn.disabled = false; btn.textContent = 'Enviar a ESTACICE'; }
  if(r.validacion) return soivreMostrarErrores(r.errores);
  s.env = { estado: r.ok ? 'aceptada' : r.pendiente ? 'en cola' : (r.estado === 'rechazada' ? 'rechazada' : 'error'),
            numero: r.numeroSolicitud || null, descripcion: r.descripcion || r.error || '', errores: r.errores || [],
            xmlEnviado: r.xmlEnviado, xmlRespuesta: r.xmlRespuesta, adjunto: r.adjuntoEstado, fecha: new Date(), entorno: e.entorno };
  if(r.ok && r.numeroSolicitud) vuaGuardarExpediente(s, r.numeroSolicitud, e.entorno, d);
  vuaResultado(s);
  if(typeof soivrePanelFacturaRefrescar === 'function') soivrePanelFacturaRefrescar();
  if(document.getElementById('view-soivre')?.classList.contains('active')) vuaPintarSesion();
}

function vuaResultado(s){
  const env = s.env;
  const ok = env.estado === 'aceptada';
  soivreModal(`${s.tipo === 'O' ? '🫒' : '🍊'} ESTACICE · ${ok ? 'solicitud registrada' : 'no registrada'}`, `
    <div style="text-align:center;padding:6px 0 12px">
      <div style="font-size:30px">${ok ? '✅' : env.estado === 'en cola' ? '⏳' : '❌'}</div>
      <div style="font-size:15px;font-weight:700;margin-top:4px">${ok ? 'Registrada en ESTACICE' : sEsc(env.descripcion || 'No registrada')}</div>
      ${env.entorno === 'pruebas' ? '<div style="font-size:11px;color:var(--am600);margin-top:2px">Entorno de PRUEBAS: no se inspecciona</div>' : ''}
    </div>
    <table style="width:100%;font-size:12px;margin-bottom:10px">
      <tr><td style="color:var(--g500);padding:4px 0;width:150px">Nº solicitud SOIVRE</td><td style="font-family:var(--mono);font-weight:700">${sEsc(env.numero || '—')}</td></tr>
      <tr><td style="color:var(--g500);padding:4px 0">Agente económico</td><td>${sEsc(s.agente.nombre)} · ${sEsc(s.agente.nif)}</td></tr>
      <tr><td style="color:var(--g500);padding:4px 0">Líneas</td><td>${s.lineas.length} · ${s.tipo === 'O' ? 'otros productos' : 'frutas y hortalizas'} · ${s.flujo === 'E' ? 'exportación' : 'reexportación'} ${sEsc(s.origen || 'ES')} → ${sEsc(s.destino)}</td></tr>
      <tr><td style="color:var(--g500);padding:4px 0">Factura</td><td>${s.archivo ? sEsc(s.archivo.name) + ' · ' + sEsc(env.adjunto || '—') : 'sin anexo'}</td></tr>
      ${ok ? '' : `<tr><td style="color:var(--g500);padding:4px 0;vertical-align:top">Respuesta</td><td>${sEsc(env.descripcion || '')}</td></tr>`}
    </table>
    ${env.errores && env.errores.length ? `<div style="background:var(--rd50);color:var(--rd600);border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:10px">${env.errores.map(x => '• ' + sEsc(x)).join('<br>')}</div>` : ''}
    <div style="font-size:11px;color:var(--g500);margin-bottom:10px">${ok ? 'SOIVRE emitirá un certificado por cada 3 líneas cuando inspeccione. Consulta el estado aquí o en la web de ESTACICE.' : 'Corrige los datos y vuelve a enviar.'}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-s btn-sm" onclick='soivreVerXml("XML ESTACICE", ${JSON.stringify(env.xmlEnviado || '')}, ${JSON.stringify(env.xmlRespuesta || '')})'>👁 Ver XML</button>
      ${ok && env.numero ? `<button class="btn btn-s btn-sm" onclick="vuaConsultar('${s.k}')">Consultar estado</button>`
                         : `<button class="btn btn-p btn-sm" onclick="abrirSolicitudVua('${s.k}')">Corregir y reenviar</button>`}
      <button class="btn btn-s btn-sm" onclick="soivreCerrarModal()">Cerrar</button>
    </div>`, 640);
}

// ── estado y certificados (PedirInfoSolicitudV2) ─────────────
async function vuaConsultar(k, numero, cicePI){
  const s = k ? vuaSol(k) : null;
  numero = numero || (s && s.env && String(s.env.numero).split(',')[0].trim());
  cicePI = cicePI || (s && s.cicePI) || vuaCfg().cicePI;
  if(!numero) return showToast('Sin nº de solicitud');
  soivreModal(`🍊 ESTACICE · solicitud ${sEsc(numero)}`, '<div class="loading-wrap"><div class="spinner"></div><span>Consultando ESTACICE…</span></div>', 680);
  const e = await soivreComprobarServidor();
  if(!e.ok) return document.getElementById('soivre-modal-body').innerHTML = sAviso(sEsc(e.error || 'Servidor SOIVRE sin conexión'));
  let r;
  try{ r = await soivreLlamar('VUAINFO', { numeroSolicitud: numero, codCicePI: cicePI }, vuaIdMensaje(), false); }
  catch(err){ r = { ok: false, error: err.message }; }
  const info = r.resultado || {};
  if(s){ s.info = info; }
  const certs = info.certificados || [];
  document.getElementById('soivre-modal-body').innerHTML = `
    <table style="width:100%;font-size:12px;margin-bottom:10px">
      <tr><td style="color:var(--g500);padding:4px 0;width:140px">Estado</td><td><strong>${sEsc(info.estado || r.descripcion || r.error || '—')}</strong></td></tr>
      ${info.error ? `<tr><td style="color:var(--g500);padding:4px 0">Aviso</td><td>${sEsc(info.error)}</td></tr>` : ''}
      ${(info.info_aeat || []).length ? `<tr><td style="color:var(--g500);padding:4px 0;vertical-align:top">AEAT</td><td>${info.info_aeat.map(sEsc).join('<br>')}</td></tr>` : ''}
      ${(info.info_operador || []).length ? `<tr><td style="color:var(--g500);padding:4px 0;vertical-align:top">Inspector</td><td>${info.info_operador.map(sEsc).join('<br>')}</td></tr>` : ''}
    </table>
    ${certs.length ? `<table style="width:100%;font-size:12px;border-collapse:collapse">
      <thead><tr style="font-size:10px;color:var(--g500);text-transform:uppercase;text-align:left"><th>Certificado</th><th>Resultado</th><th>Líneas solicitud</th><th>Fecha</th><th>Válido hasta</th></tr></thead>
      <tbody>${certs.map(c => `<tr style="border-top:1px solid var(--g100)">
        <td style="padding:5px 4px;font-family:var(--mono)">${sEsc(c.numero)} <button style="border:0;background:none;cursor:pointer" onclick="copiarTexto(this,'${sEsc(c.numero)}')">📋</button></td>
        <td style="padding:5px 4px"><span class="badge" style="${/^CONFORME/.test(c.resultado) ? SOIVRE_ESTADO_ESTILO.aceptada : SOIVRE_ESTADO_ESTILO.rechazada}">${sEsc(c.resultado)}</span></td>
        <td style="padding:5px 4px">${(c.lineas || []).map(l => sEsc(l.linea_solicitud)).join(', ')}</td>
        <td style="padding:5px 4px">${sEsc(c.fecha || '')}</td><td style="padding:5px 4px">${sEsc(c.valido_hasta || '—')}</td>
      </tr>`).join('')}</tbody></table>`
      : '<div style="font-size:12px;color:var(--g500)">Aún no hay certificados: aparecen cuando la solicitud está «Inspeccionada». En el entorno de pruebas siempre figura «En espera AEAT».</div>'}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-s btn-sm" onclick="vuaConsultar(${k ? `'${k}'` : 'null'}, '${sEsc(numero)}', '${sEsc(cicePI)}')">↻ Actualizar</button>
      <button class="btn btn-s btn-sm" onclick="soivreCerrarModal()">Cerrar</button>
    </div>`;
}

// ── entradas desde la búsqueda libre y la vista SOIVRE ───────
function vuaNuevaDesdeResultado(codigo, descripcion, tipo = 'F'){
  const origen = document.getElementById('spg-pais')?.value || 'ES';
  const ult = vuaCfg().ultimoAgente;
  const s = vuaNuevaSolicitud({
    tipo, origen, agente: ult || vuaAgenteDe({}), fabricanteEnvasador: ult ? ult.nombre : '',
    lineas: [{ taric: String(codigo || '').replace(/\D/g, ''), descripcion: descripcion || '', envases: '', codEnvase: '04', marca: VUA_MARCA_DEF,
               producto: '', categoria: '2', pesoBruto: '', pesoNeto: '', nombreEnvase: '', envaseMas5kg: 'N', unidades: '', factura: '' }]
  });
  abrirSolicitudVua(s.k);
}
function vuaNuevaManual(){
  const s = vuaNuevaSolicitud({ lineas: [] });
  abrirSolicitudVua(s.k).then(() => vuaAnadirLinea());
}
function vuaConsultarPorNumero(){
  const n = prompt('Nº de solicitud SOIVRE (ESTACICE):');
  if(n && /^\d+$/.test(n.trim())) vuaConsultar(null, n.trim());
}

// Lista de esta pestaña en la vista SOIVRE (sin histórico: el oficial está en ESTACICE)
function vuaPintarSesion(){
  vuaPintarExpedientes();
  vtPintarEntidades();
  const el = document.getElementById('vua-sesion');
  if(!el) return;
  const enviadas = VUA.sols.filter(s => s.env);
  el.innerHTML = enviadas.length ? `<table class="tbl" style="width:100%;font-size:12px">
    <thead><tr><th>Hora</th><th>Entorno</th><th>Agente económico</th><th>Tipo</th><th>Líneas</th><th>Estado</th><th>Nº solicitud</th><th></th></tr></thead>
    <tbody>${enviadas.map(s => `<tr>
      <td>${s.env.fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</td>
      <td>${sEsc(s.env.entorno || '')}</td><td>${sEsc(s.agente.nombre)}</td><td>${s.flujo === 'E' ? 'Exportación' : 'Reexportación'}</td>
      <td>${s.lineas.length}</td><td><span class="badge" style="${SOIVRE_ESTADO_ESTILO[s.env.estado] || ''}">${sEsc(s.env.estado)}</span></td>
      <td style="font-family:var(--mono)">${sEsc(s.env.numero || '—')}</td>
      <td style="white-space:nowrap">${s.env.numero ? `<button class="btn btn-s btn-sm" onclick="vuaVerContenido(vuaDatos(vuaSol('${s.k}')), '${sEsc(s.env.numero)}')">Ver</button> <button class="btn btn-s btn-sm" onclick="vuaConsultar('${s.k}')">Estado</button>` : `<button class="btn btn-s btn-sm" onclick="abrirSolicitudVua('${s.k}')">Revisar</button>`}</td>
    </tr>`).join('')}</tbody></table>`
    : '<div style="font-size:12px;color:var(--g400)">Sin envíos a ESTACICE en esta sesión.</div>';
}

// ═══ Certificados → CSV de VisualTrans ═══
// Al registrarse una solicitud que viene de una factura leída se guarda su
// expediente (vua_expedientes): la factura y qué línea de factura va en cada
// línea de la solicitud. El servidor consulta ESTACICE cada cierto tiempo y,
// cuando SOIVRE emite los certificados, guarda el N003 de cada línea. Al
// generar el CSV de VisualTrans se añaden a la casilla 44 de cada partida.
// Todas las líneas de la lectura, no solo las que van a SOIVRE: el CSV de
// VisualTrans es el DUA completo. Si la lectura tenía varias facturas (un DUA
// con varias), van todas, con la cabecera de cada una aparte (cabs).
function vuaFacturaParaGuardar(){
  const todas = window._facturaLineas || [];
  const cabs = {};
  todas.forEach(l => { if(l._cab && l._numFactura && !cabs[l._numFactura]) cabs[l._numFactura] = l._cab; });
  // Sin referencias circulares ni campos de pantalla; las cabeceras van aparte
  const lineas = todas.map(l => { const c = Object.assign({}, l); delete c._cab; delete c._n003; delete c._n003s; return c; });
  return { lineas, cabs };
}
// d: los datos tal como se enviaron (vuaDatos), para poder consultar el contenido.
// Las solicitudes manuales también se guardan (sin factura): se sigue su estado
// y sus certificados, aunque no haya líneas de factura a las que llevar el N003.
async function vuaGuardarExpediente(s, numero, entorno, d){
  const conFactura = s.lineas.find(l => l.clave);
  const fila = {
    usuario: (window.PortalGuard && PortalGuard.CU && PortalGuard.CU.nombre) || null,
    entorno: entorno || 'pruebas', numero_solicitud: String(numero), cice_pi: s.cicePI, tipo: s.tipo,
    numero_factura: s.factura || null, exportador: s.agente.nombre, nif_exportador: s.agente.nif,
    factura: conFactura ? Object.assign({ cab: s.cabFactura || (typeof FACTURA_CABECERA !== 'undefined' ? FACTURA_CABECERA : {}) || {},
                                          cabLote: (typeof FACTURA_CABECERA !== 'undefined' && FACTURA_CABECERA) || null },
                                        vuaFacturaParaGuardar()) : {},
    lineas_sol: s.lineas.map((l, i) => ({ linea: i + 1, clave: l.clave || null, descripcion: l.descripcion || '' })),
    solicitud: Object.assign({}, d || vuaDatos(s), { idMensaje: s.idMensaje || null, enviadaEn: new Date().toISOString() })
  };
  if(!fila.numero_factura) fila.numero_factura = [...new Set(s.lineas.map(l => l.factura).filter(Boolean))].join(', ') || null;
  const { error } = await sbT().from('vua_expedientes').insert(fila);
  if(error) showToast('Solicitud registrada, pero no se pudo guardar su seguimiento para VisualTrans: ' + error.message);
}

// ── Entidades de VisualTrans: nombre exacto por NIF ──────────
// «ESB-93.462.885» → «B93462885»: sin signos y sin prefijo de país (un NIF
// español nunca empieza por dos letras).
function vtNormNif(n){
  const t = String(n || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[A-Z]{2}[0-9A-Z]{6,}$/.test(t) ? t.slice(2) : t;
}
// Para buscar sin NIF: sin asterisco, acentos, signos, forma jurídica ni
// espacios («BON FOOD LTD» = «BONFOOD LTD»)
function vtNormNombre(n){
  return vuaNormal(n).replace(/^[\s*]+/, '').replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\b(S ?L ?U?|S ?A ?U?|S ?L ?L|S ?C ?P|S ?COOP|C ?B|LTD|LIMITED|SARL|SAS|GMBH|BV|SRL|SPA|INC|LLC|CO)\b/g, ' ')
    .replace(/\s+/g, '');
}
// Entidades.txt exportado de VisualTrans: ; y comillas, Windows-1252
function vtParsearEntidades(texto){
  const filas = [];
  let campo = '', fila = [], dentro = false;
  for(let i = 0; i < texto.length; i++){
    const ch = texto[i];
    if(dentro){
      if(ch === '"'){ if(texto[i + 1] === '"'){ campo += '"'; i++; } else dentro = false; }
      else campo += ch;
    } else if(ch === '"') dentro = true;
    else if(ch === ';'){ fila.push(campo); campo = ''; }
    else if(ch === '\n' || ch === '\r'){
      if(ch === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += ch;
  }
  if(campo || fila.length){ fila.push(campo); filas.push(fila); }
  const cab = (filas.shift() || []).map(h => vuaNormal(h).trim());
  const col = re => cab.findIndex(h => re.test(h));
  const ix = { nombre: col(/^NOMBRE FISCAL/), dir: col(/^DIRECCION/), pais: col(/CODIGO ISO/), prov: col(/^PROVINCIA/),
               loc: col(/^LOCALIDAD -> NOMBRE/), cp: col(/CODIGO POSTAL/), nif: col(/NIF/), cod: col(/^CODIGO$/) };
  if(ix.nombre < 0 || ix.nif < 0 || ix.cod < 0) throw new Error('No parece el fichero Entidades.txt de VisualTrans (faltan columnas Nombre fiscal, NIF o Código)');
  return filas.filter(f => f.length > ix.cod && (f[ix.cod] || '').trim() && (f[ix.nombre] || '').length)
    .map(f => ({
      codigo: f[ix.cod].trim(), nombre: f[ix.nombre],                 // el nombre NO se recorta: VisualTrans lo compara tal cual
      nif: (f[ix.nif] || '').trim() || null, nif_norm: vtNormNif(f[ix.nif]) || null, nombre_norm: vtNormNombre(f[ix.nombre]) || null,
      direccion: (f[ix.dir] || '').trim() || null, cp: (f[ix.cp] || '').trim() || null, localidad: (f[ix.loc] || '').trim() || null,
      provincia: (f[ix.prov] || '').trim() || null, pais_iso: (f[ix.pais] || '').trim() || null, importado_en: new Date().toISOString()
    }));
}
async function vtImportarEntidades(input){
  const f = input.files && input.files[0];
  if(!f) return;
  const el = document.getElementById('vt-entidades-estado');
  const pinta = t => { if(el) el.innerHTML = t; };
  try{
    const texto = new TextDecoder('windows-1252').decode(await f.arrayBuffer());
    const filas = vtParsearEntidades(texto);
    for(let i = 0; i < filas.length; i += 500){
      pinta(`Importando ${Math.min(i + 500, filas.length)} / ${filas.length}…`);
      // upsert por código: no toca «preferida» de las ya existentes
      const { error } = await sbT().from('vt_entidades').upsert(filas.slice(i, i + 500), { onConflict: 'codigo' });
      if(error) throw error;
    }
    VT.cache.clear();
    showToast(`${filas.length} entidades de VisualTrans importadas`);
  }catch(e){ showToast('No se pudo importar: ' + e.message); }
  input.value = '';
  vtPintarEntidades();
}
async function vtPintarEntidades(){
  const el = document.getElementById('vt-entidades');
  if(!el) return;
  // El botón se pinta ya; el recuento llega después (o el aviso si falta la tabla)
  let count = '…', error = null;
  const pinta = () => { el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px;font-size:12px;color:var(--g600)">
        ${error ? sEsc('Tabla vt_entidades no disponible: ejecuta de nuevo instalar_soivre.sql en Supabase.') : `<strong>${count ?? 0}</strong> entidades de VisualTrans cargadas.`}
        El CSV escribe exportador y destinatario con el nombre exacto de VisualTrans, buscándolos por NIF.
        <div id="vt-entidades-estado" style="font-size:11px;color:var(--g500);margin-top:2px"></div>
      </div>
      <label class="btn btn-p btn-sm" style="cursor:pointer">📥 Importar Entidades.txt<input type="file" accept=".txt,.csv" style="display:none" onchange="vtImportarEntidades(this)"></label>
    </div>`; };
  pinta();
  try{ const r = await sbT().from('vt_entidades').select('codigo', { count: 'exact', head: true }); count = r.count; error = r.error; }
  catch(e){ error = e; }
  pinta();
}

const VT = { cache: new Map(), expedientes: [] };
async function vtBuscarEntidades(nif, nombre){
  const k = vtNormNif(nif) || ('N:' + vtNormNombre(nombre));
  if(VT.cache.has(k)) return VT.cache.get(k);
  let res = [];
  if(vtNormNif(nif)){
    const r = await sbT().from('vt_entidades').select('codigo,nombre,nif,preferida,cliente').eq('nif_norm', vtNormNif(nif));
    if(r.error) throw r.error;
    res = r.data || [];
  }
  if(!res.length && vtNormNombre(nombre)){
    const r = await sbT().from('vt_entidades').select('codigo,nombre,nif,preferida,cliente').eq('nombre_norm', vtNormNombre(nombre));
    if(!r.error) res = r.data || [];
  }
  VT.cache.set(k, res);
  return res;
}
// Varias entidades con el mismo NIF (p. ej. «* AMSPEC IBERIA, S.L.» y «AMSPEC
// IBERIA S.L.»): la marcada como preferida o, si no hay, se pregunta una vez.
function vtElegir(rol, parte, candidatas){
  return new Promise(resolve => {
    window._vtElegido = c => { soivreCerrarModal(); resolve(c); };
    const norm = vtNormNombre(parte.nombre);
    soivreModal(`VisualTrans · ¿qué ${rol}?`, `
      <div style="font-size:12px;color:var(--g600);margin-bottom:10px">En VisualTrans hay ${candidatas.length} entidades con el NIF <strong>${sEsc(parte.nif)}</strong>. La factura dice <strong>${sEsc(parte.nombre)}</strong>. Elige la que debe ir en el CSV (se recordará).</div>
      ${candidatas.map((c, i) => `<button class="btn btn-s" style="display:block;width:100%;text-align:left;margin-bottom:6px;white-space:pre" onclick="window._vtElegido(${i})">${sEsc(c.nombre)}  <span style="color:var(--g400);font-size:11px">· cód. ${sEsc(c.codigo)}${vtNormNombre(c.nombre) === norm ? ' · coincide con la factura' : ''}</span></button>`).join('')}
      <button class="btn btn-s btn-sm" onclick="window._vtElegido(-1)">Usar el nombre de la factura</button>`, 560);
  }).then(async i => {
    if(i < 0) return null;
    const c = candidatas[i];
    await sbT().from('vt_entidades').update({ preferida: false }).eq('nif_norm', vtNormNif(parte.nif));
    await sbT().from('vt_entidades').update({ preferida: true }).eq('codigo', c.codigo);
    candidatas.forEach(x => { x.preferida = x.codigo === c.codigo; });
    return c;
  });
}
async function vtResolverParte(rol, parte, avisos){
  if(!parte || (!parte.nif && !parte.nombre)) return;
  let cand = [];
  try{ cand = await vtBuscarEntidades(parte.nif, parte.nombre); }
  catch(_){ return; }                                  // sin tabla: el CSV sale como antes
  const elegida = cand.length === 1 ? cand[0] : (cand.find(c => c.preferida) || (cand.length > 1 ? await vtElegir(rol, parte, cand) : null));
  if(elegida){ parte.nombre_vt = elegida.nombre; if(elegida.nif) parte.nif_vt = elegida.nif; }
  else{ delete parte.nombre_vt; delete parte.nif_vt; if(!cand.length) avisos.push(`${rol} «${parte.nombre || parte.nif}» no está en las entidades de VisualTrans: va con el nombre de la factura`); }
}

// ── Cliente del dossier («Entidad que paga», columna 37 de la cabecera) ──
// Entidades.txt no dice qué entidades son clientes: el portal lo aprende. La
// entidad elegida como cliente al generar un CSV queda marcada (cliente = true)
// y la próxima vez se propone sola si es el exportador o el destinatario.
// El destinatario de una exportación (o el exportador de una importación)
// suele venir sin NIF en la factura: se busca por nombre («BON FOOD LTD» →
// «BONFOOD LTD»).
async function vtPintarCliente(cab, esImport){
  const el = document.getElementById('vt-cliente');
  if(!el) return;
  window._vtCliente = null;
  const partes = [['Exportador', cab.exportador], [esImport ? 'Importador' : 'Destinatario', cab.destinatario]];
  if(esImport) partes.reverse();
  const cand = [];
  for(const [rol, p] of partes){
    if(!p || (!p.nif && !p.nombre)) continue;
    let ents = [];
    try{ ents = await vtBuscarEntidades(p.nif, p.nombre); }catch(_){ el.innerHTML = ''; return; }   // sin tabla: no hay campo
    const e = ents.find(x => x.cliente) || ents.find(x => x.preferida) || ents[0];
    if(e && !cand.some(c => c.codigo === e.codigo)) cand.push(Object.assign({ rol }, e));
  }
  window._vtClienteCand = cand;
  const propuesto = cand.find(c => c.cliente);
  el.innerHTML = `
    <label style="font-size:11px;font-weight:700;color:var(--g500);text-transform:uppercase">Cliente · entidad que paga</label>
    <div style="position:relative">
      <input id="vt-cliente-q" class="fi" style="width:100%" autocomplete="off" placeholder="Busca por nombre, NIF o código de VisualTrans"
        oninput="vtBuscarCliente(this.value)">
      <div id="vt-cliente-res" style="position:absolute;left:0;right:0;top:100%;z-index:2;background:var(--w);border:1px solid var(--g200);border-radius:var(--r);box-shadow:var(--shl);display:none;max-height:220px;overflow:auto"></div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
      ${cand.map((c, i) => `<button type="button" class="btn btn-s btn-sm" style="font-size:11px" onclick="vtElegirCliente(window._vtClienteCand[${i}])">${sEsc(c.rol)}: ${sEsc(c.nombre)}${c.cliente ? ' ★' : ''}</button>`).join('')}
    </div>
    <div id="vt-cliente-info" style="font-size:11px;color:var(--g500);margin-top:4px"></div>`;
  if(propuesto) vtElegirCliente(propuesto, true);
  else vtInfoCliente(cand.length ? 'Ninguna de las dos está marcada como cliente: elige una o búscala.' : 'Exportador y destinatario no están en las entidades de VisualTrans: busca el cliente.');
}
function vtInfoCliente(t){ const i = document.getElementById('vt-cliente-info'); if(i) i.innerHTML = t; }
function vtElegirCliente(c, auto){
  window._vtCliente = c || null;
  const q = document.getElementById('vt-cliente-q'), r = document.getElementById('vt-cliente-res');
  if(q) q.value = c ? c.nombre : '';
  if(r) r.style.display = 'none';
  if(!c) return vtInfoCliente('Sin cliente: la columna «Entidad que paga» irá vacía.');
  vtInfoCliente(`${auto ? 'Propuesto (ya es cliente) · ' : ''}cód. ${sEsc(c.codigo)} · NIF ${c.nif ? sEsc(c.nif) : '<span style="color:var(--am600)">sin NIF en VisualTrans: la columna irá vacía</span>'}`);
}
let _vtClienteT = null;
function vtBuscarCliente(texto){
  clearTimeout(_vtClienteT);
  window._vtCliente = null;
  const t = String(texto || '').trim();
  const r = document.getElementById('vt-cliente-res');
  if(t.length < 2){ if(r) r.style.display = 'none'; vtInfoCliente(t ? '' : 'Sin cliente: la columna «Entidad que paga» irá vacía.'); return; }
  _vtClienteT = setTimeout(async () => {
    const nif = vtNormNif(t), nom = vtNormNombre(t);
    const ors = [`nombre.ilike.*${t.replace(/[*,()]/g, ' ')}*`];
    if(nom) ors.push(`nombre_norm.like.*${nom}*`);
    if(/\d/.test(nif)) ors.push(`nif_norm.eq.${nif}`, `codigo.eq.${t.replace(/[^0-9A-Za-z]/g, '')}`);
    const { data, error } = await sbT().from('vt_entidades').select('codigo,nombre,nif,cliente,pais_iso')
      .or(ors.join(',')).order('cliente', { ascending: false }).order('nombre').limit(12);
    if(error || !r) return;
    window._vtClienteRes = data || [];
    r.innerHTML = (data || []).map((c, i) => `<div style="padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--g100)" onmousedown="vtElegirCliente(window._vtClienteRes[${i}])">
        ${c.cliente ? '★ ' : ''}${sEsc(c.nombre)} <span style="color:var(--g400);font-size:11px">· ${sEsc(c.nif || 'sin NIF')} · ${sEsc(c.pais_iso || '')} · cód. ${sEsc(c.codigo)}</span></div>`).join('')
      || '<div style="padding:6px 10px;font-size:12px;color:var(--g400)">Sin resultados</div>';
    r.style.display = 'block';
  }, 250);
}
// Tras generar el CSV: el cliente elegido queda marcado para proponerlo la próxima vez
async function vtRecordarCliente(c){
  if(!c || c.cliente) return;
  const { error } = await sbT().from('vt_entidades').update({ cliente: true }).eq('codigo', c.codigo);
  if(!error){ c.cliente = true; VT.cache.clear(); }
}

// Llamada por exportarVisualTrans (taric.html) antes de construir el CSV
async function vtPrepararExportacion(detalle, cab, esImport){
  const avisos = [];
  const cabs = [...new Set([cab, ...detalle.map(l => l._cab).filter(Boolean)])];
  for(const c of cabs){
    await vtResolverParte('Exportador', c.exportador, avisos);
    await vtResolverParte(esImport ? 'Importador' : 'Destinatario', c.destinatario, avisos);
  }
  VT.expedientes = [];
  if(!esImport){
    const claves = new Set(detalle.map(l => l._claveVT).filter(Boolean));
    const facturas = [...new Set(detalle.map(l => l._numFactura || (l._cab && l._cab.numero_factura) || cab.numero_factura).filter(Boolean))];
    let exps = [];
    if(facturas.length){
      const r = await sbT().from('vua_expedientes').select('id,numero_factura,numero_solicitud,estado,n003,lineas_sol').in('numero_factura', facturas);
      if(!r.error) exps = r.data || [];
    }
    // Mismo nº de factura de otro proveedor: sus claves llevan otro NIF y no se tocan
    exps = exps.filter(x => (x.lineas_sol || []).some(ls => claves.has(ls.clave)));
    const n003 = {}, esperando = new Set();
    exps.forEach(x => {
      Object.assign(n003, x.n003 || {});
      if(x.estado !== 'certificado') (x.lineas_sol || []).forEach(ls => ls.clave && esperando.add(ls.clave));
    });
    let sin = 0;
    detalle.forEach(l => {
      l._n003 = n003[l._claveVT] || null;
      if(!l._n003 && esperando.has(l._claveVT)) sin++;
    });
    VT.expedientes = exps.filter(x => x.estado === 'certificado').map(x => x.id);
    if(sin && !confirm(`${sin} línea(s) con solicitud SOIVRE aún no tienen certificado (la casilla 44 N003 saldría vacía).\n\n¿Generar el CSV igualmente?`)) return false;
    const con = detalle.filter(l => l._n003).length;
    if(con) avisos.push(`${con} línea(s) con N003 del certificado SOIVRE`);
  }
  if(avisos.length) showToast(avisos.join(' · '));
  return true;
}
// Tras descargar el CSV: los expedientes usados quedan como exportados (se borran a los 30 días)
async function vtTrasExportar(){
  if(!VT.expedientes.length) return;
  await sbT().from('vua_expedientes').update({ exportado_en: new Date().toISOString() }).in('id', VT.expedientes);
  VT.expedientes = [];
  if(document.getElementById('view-soivre')?.classList.contains('active')) vuaPintarExpedientes();
}

// ── Vista SOIVRE: expedientes a la espera de certificado ─────
async function vuaPintarExpedientes(){
  const el = document.getElementById('vua-expedientes');
  if(!el) return;
  const { data, error } = await sbT().from('vua_expedientes')
    .select('id,created_at,entorno,numero_solicitud,cice_pi,numero_factura,exportador,estado,estado_soivre,certificados,consultado_en,exportado_en,lineas_sol')
    .order('created_at', { ascending: false }).limit(60);
  if(error){ el.innerHTML = `<div style="font-size:12px;color:var(--g400)">${sEsc('Tabla vua_expedientes no disponible (¿instalar_soivre.sql?)')}</div>`; return; }
  if(!data.length){ el.innerHTML = '<div style="font-size:12px;color:var(--g400)">Sin solicitudes en seguimiento.</div>'; return; }
  const estilo = { pendiente: 'background:var(--am50);color:var(--am600)', certificado: SOIVRE_ESTADO_ESTILO.aceptada, caducado: 'background:var(--g100);color:var(--g600)' };
  el.innerHTML = `<table class="tbl" style="width:100%;font-size:12px">
    <thead><tr><th>Fecha</th><th>Factura</th><th>Exportador</th><th>Nº solicitud</th><th>Estado</th><th>Certificados</th><th></th></tr></thead>
    <tbody>${data.map(x => `<tr>
      <td>${new Date(x.created_at).toLocaleDateString('es-ES')}${x.entorno === 'pruebas' ? ' <span style="color:var(--am600);font-size:10px">pruebas</span>' : ''}</td>
      <td>${sEsc(x.numero_factura || '—')}</td><td>${sEsc(x.exportador || '')}</td>
      <td style="font-family:var(--mono)">${sEsc(x.numero_solicitud)}</td>
      <td><span class="badge" style="${estilo[x.estado] || ''}">${sEsc(x.estado)}</span><div style="font-size:10px;color:var(--g400)">${sEsc(x.estado_soivre || '')}${x.consultado_en ? ' · ' + new Date(x.consultado_en).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''}</div></td>
      <td style="font-family:var(--mono);font-size:11px">${(x.certificados || []).map(c => sEsc(c.numero)).join('<br>') || '—'}${x.exportado_en ? '<div style="font-size:10px;color:var(--gr600)">✔ en CSV</div>' : ''}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-s btn-sm" onclick="vuaVerExpediente('${x.id}')">Ver</button>
        ${(x.lineas_sol || []).some(l => l.clave) ? `<button class="btn ${x.estado === 'certificado' && !x.exportado_en ? 'btn-p' : 'btn-s'} btn-sm" onclick="vtCsvDesdeExpediente('${x.id}')">CSV VisualTrans</button>` : '<span style="font-size:10px;color:var(--g400)">manual</span>'}
        <button class="btn btn-s btn-sm" onclick="vuaConsultar(null, '${sEsc(String(x.numero_solicitud).split(',')[0])}', '${sEsc(x.cice_pi)}')">Estado</button>
      </td></tr>`).join('')}</tbody></table>`;
}
// Contenido de una solicitud enviada. Las guardadas antes de existir la columna
// «solicitud» se recuperan de la cola (soivre_cola) mientras no se haya purgado.
async function vuaVerExpediente(id){
  const { data: x, error } = await sbT().from('vua_expedientes').select('*').eq('id', id).single();
  if(error || !x) return showToast('No se pudo recuperar la solicitud: ' + (error ? error.message : 'sin datos'));
  let d = x.solicitud, xml = '';
  const cola = await sbT().from('soivre_cola').select('datos,xml_enviado').eq('servicio', 'VUA').eq('numero_solicitud', x.numero_solicitud).limit(1);
  if(!cola.error && cola.data && cola.data[0]){ d = d || cola.data[0].datos; xml = cola.data[0].xml_enviado || ''; }
  vuaVerContenido(d || vuaReconstruir(x), x.numero_solicitud, x, xml);
}
// Solicitudes enviadas antes de guardar su contenido (y ya fuera de la cola):
// se rehace lo posible con la factura del expediente. No es lo enviado exactamente
// (faltan matrícula, aduana, producto SOIVRE…): se avisa en pantalla.
function vuaReconstruir(x){
  const cab = (x.factura && x.factura.cab) || {};
  const fl = (x.factura && x.factura.lineas) || [];
  const des = cab.destinatario || {};
  return {
    _reconstruida: true, tipo: x.tipo, codCicePI: x.cice_pi,
    agente: { nombre: x.exportador, nif: x.nif_exportador },
    destinatario: des.nombre || '', destino: cab.pais_destino || des.pais || '',
    lineas: (x.lineas_sol || []).map(ls => {
      const l = fl.find(f => f._claveVT && f._claveVT === ls.clave) || {};
      return { taric: l.codigo_taric || '', envases: l.bultos || '', nombreEnvase: l.unidad || '', descripcion: ls.descripcion || l.descripcion_original || '',
               pesoNeto: l.peso_neto || l.peso_bruto || '', pesoBruto: l.peso_bruto || '', unidades: l.cantidad || '',
               factura: cab.numero_factura || x.numero_factura || '', importe: l.importe || '', moneda: cab.moneda || '' };
    })
  };
}
function vuaVerContenido(d, numero, x, xml, sinCatalogo){
  // Con el catálogo se muestran los nombres de productos, centros y aduanas; sin él, solo los códigos
  if(!VUA.cat && !sinCatalogo) return vuaCatalogo().catch(() => {}).then(() => vuaVerContenido(d, numero, x, xml, true));
  const cat = VUA.cat || {};
  const nom = (lista, c) => { const f = (lista || []).find(p => p.codigo === String(c || '')); return f ? f.nombre : ''; };
  const esO = d.tipo === 'O';
  const ae = d.agente || {};
  const fila = (k, v) => v ? `<tr><td style="color:var(--g500);white-space:nowrap;padding:3px 10px 3px 0;vertical-align:top">${k}</td><td style="padding:3px 0">${v}</td></tr>` : '';
  const dir = o => sEsc([o.direccion, [o.cp, o.localidad].filter(Boolean).join(' '), o.provincia && nom(cat.provincias, o.provincia), o.pais].filter(Boolean).join(' · '));
  const cert = x && (x.certificados || []).length ? x.certificados.map(c => `${sEsc(c.numero)}${c.resultado ? ' · ' + sEsc(c.resultado) : ''}${c.fecha ? ' · ' + sEsc(c.fecha) : ''}`).join('<br>') : '';
  const cab = `<table style="font-size:12px;border-collapse:collapse;width:100%">
    ${fila('Nº solicitud', `<b style="font-family:var(--mono)">${sEsc(numero || '')}</b>${x ? ` · ${sEsc(x.estado)}${x.estado_soivre ? ' (' + sEsc(x.estado_soivre) + ')' : ''} · ${sEsc(x.entorno)}` : ''}`)}
    ${fila('Enviada', d.enviadaEn ? new Date(d.enviadaEn).toLocaleString('es-ES') : (x ? new Date(x.created_at).toLocaleString('es-ES') : ''))}
    ${fila('Tipo', (esO ? 'Otros productos' : 'Frutas y hortalizas') + (d.exporImpor ? ' · ' + (d.exporImpor === 'R' ? 'Reexportación' : 'Exportación') : ''))}
    ${fila('Centro / PI', d.codCicePI ? sEsc(d.codCicePI + ' ' + nom(cat.cices, d.codCicePI)) : '')}
    ${fila('Aduana de salida', d.aduana ? sEsc(d.aduana + ' ' + nom(cat.aduanas, d.aduana)) : '')}
    ${fila('Origen → destino', d.destino ? sEsc(`${d.origen || 'ES'} ${nom(cat.paises, d.origen || 'ES')} → ${d.destino} ${nom(cat.paises, d.destino)}`) : '')}
    ${fila('Transporte', sEsc([VUA_TRANSPORTES[d.transporte] || d.transporte, d.matricula, d.otrasMatriculas].filter(Boolean).join(' · ')))}
    ${fila('Ubicación', sEsc(d.ubicacion || ''))}
    ${fila('Agente económico', `<b>${sEsc(ae.nombre || '')}</b> · ${sEsc(ae.nif || '')}${dir(ae) ? `<br><span style="color:var(--g500)">${dir(ae)}</span>` : ''}`)}
    ${!esO && d.envasador && d.envasador.nif && d.envasador.nif !== ae.nif ? fila('Envasador', `${sEsc(d.envasador.nombre || '')} · ${sEsc(d.envasador.nif)}<br><span style="color:var(--g500)">${dir(d.envasador)}</span>`) : ''}
    ${esO ? fila('Destinatario', sEsc(d.destinatario || '')) : ''}
    ${esO ? fila('Fabricante / envasador', sEsc(d.fabricanteEnvasador || '')) : ''}
    ${fila('Observaciones', sEsc(d.observaciones || ''))}
    ${fila('Certificados', cert)}
  </table>`;
  const th = esO ? ['Lín', 'Producto SOIVRE', 'TARIC', 'Envases', 'Envase', '> 5 kg', 'Marca', 'Neto kg', 'Unid.', 'Factura', 'Valor']
                 : ['Lín', 'Producto SOIVRE', 'TARIC', 'Envases', 'Envase', 'Cat.', 'Marca', 'Bruto kg', 'Neto kg', 'Factura', 'Valor'];
  const td = v => `<td style="padding:3px 6px">${v}</td>`;
  const lineas = (d.lineas || []).map((l, i) => `<tr style="border-top:1px solid var(--g200)">${td(i + 1)}${td(l.producto ? `${sEsc(l.producto)} <span style="color:var(--g500)">${sEsc(nom(cat.productos, l.producto))}</span>` : `<span style="color:var(--g500)">${sEsc(l.descripcion || '—')}</span>`)}${td(`<span style="font-family:var(--mono)">${sEsc(l.taric || '')}</span>`)}${td(sEsc(l.envases || ''))}`
    + (esO ? td(sEsc(l.nombreEnvase || '')) + td(l.envaseMas5kg === 'S' ? 'Sí' : 'No') + td(sEsc(l.marca || '')) + td(sEsc(l.pesoNeto || '')) + td(sEsc(l.unidades || ''))
           : td(sEsc(nom(cat.envases, l.codEnvase) || l.codEnvase || '')) + td(sEsc(VUA_CATEGORIAS[l.categoria] || l.categoria || '')) + td(sEsc(l.marca || '')) + td(sEsc(l.pesoBruto || '')) + td(sEsc(l.pesoNeto || '')))
    + td(sEsc(l.factura || '')) + td(l.importe ? sEsc(l.importe + ' ' + (l.moneda || '')) : '') + '</tr>').join('');
  window._vuaXmlVer = xml || '';
  const aviso = d._reconstruida ? `<div style="background:var(--am50);color:var(--am600);border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:10px">
    Esta solicitud se envió antes de que el portal guardara su contenido. Se muestra lo que se puede rehacer con la factura (sin matrícula, aduana ni producto SOIVRE). El contenido exacto está en ESTACICE.</div>` : '';
  soivreModal(`📄 Solicitud ESTACICE ${sEsc(numero || '')}`, `${aviso}${cab}
    <div style="font-weight:600;font-size:13px;margin:14px 0 6px">Productos (${(d.lineas || []).length})</div>
    <div style="overflow-x:auto"><table style="font-size:11.5px;border-collapse:collapse;width:100%"><thead><tr>${th.map(h => `<th style="text-align:left;padding:3px 6px;color:var(--g500);font-weight:600">${h}</th>`).join('')}</tr></thead><tbody>${lineas}</tbody></table></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      ${xml ? `<button class="btn btn-s btn-sm" onclick="soivreVerXml('XML enviado a ESTACICE', window._vuaXmlVer)">Ver XML enviado</button>` : ''}
      <button class="btn btn-s btn-sm" onclick="soivreCerrarModal()">Cerrar</button>
    </div>`, 1020);
}

// Regenera el CSV de una factura ya leída (sin volver a pasarla por la IA)
async function vtCsvDesdeExpediente(id){
  const { data, error } = await sbT().from('vua_expedientes').select('factura').eq('id', id).single();
  if(error || !data) return showToast('No se pudo recuperar la factura: ' + (error ? error.message : 'sin datos'));
  // DUA completo: todas las líneas de la lectura (también las que no van a SOIVRE),
  // cada una con la cabecera de su factura. Expedientes antiguos: solo «cab».
  const cab = data.factura.cab || {}, cabs = data.factura.cabs || {};
  window._facturaLineas = (data.factura.lineas || []).map(l => Object.assign(l, { _cab: cabs[l._numFactura] || cab }));
  FACTURA_CABECERA = data.factura.cabLote || cab;
  abrirModalVT();
}
