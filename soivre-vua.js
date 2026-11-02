'use strict';
// ═══ SOIVRE · ESTACICE VUA (Ministerio de Comercio) ═══
// Frutas y hortalizas a la exportación y reexportación por el servicio web
// SOIVRE/Operador. Se carga después de soivre-cal.js y usa sus utilidades
// (sEsc, sCampo, soivreModal, soivreLlamar, soivreComprobarServidor…).
//
// Reglas (especificación WSESTACICE v3.1 y operativa de ALS):
//   · sin MRN; de 1 a 12 líneas por solicitud, una por línea de factura;
//   · una solicitud por factura y país de origen: España → exportación (E),
//     otro país → reexportación (R); más de 12 líneas → varias solicitudes;
//   · el agente económico es el exportador de la factura (no el titular del
//     certificado); el destinatario no tiene campo: va en la factura adjunta;
//   · destino Gibraltar → Centro COMEX La Línea/Gibraltar (5802) y aduana
//     La Línea Concepción (1167);
//   · la factura viaja dentro del XML como .zip de 2 MB como máximo.

const VUA_MAX_LINEAS = 12;
const VUA_MAX_ANEXO = 2 * 1024 * 1024;
const VUA_TRANSPORTES = { '01':'Camión', '02':'Buque (carga bodega)', '03':'Avión', '04':'Ferrocarril',
                          '05':'Contenedor en buque', '06':'Camión en buque', '07':'Correo postal/mensajería' };
const VUA_CATEGORIAS = { '1':'Extra', '2':'I', '3':'II', '4':'No aplica' };
const VUA_MONEDAS = { EUR:'EUR', USD:'DOL', DOL:'DOL', GBP:'GBP', JPY:'YEN', YEN:'YEN', CNY:'CNY' };
const VUA_CFG_DEF = {
  cicePI: '5801', aduana: '', transporte: '01', ubicacion: '',
  gibraltar: { cicePI: '5802', aduana: '1167' },
  marcas: {}                       // marca habitual por NIF de exportador
};
// sols: solicitudes preparadas en esta pestaña · cat: tablas oficiales cargadas de Supabase
const VUA = { sols: [], seq: 0, cat: null };

function vuaCfg(){
  const c = soivreCfg();
  return Object.assign({}, VUA_CFG_DEF, c.vua || {}, { gibraltar: Object.assign({}, VUA_CFG_DEF.gibraltar, (c.vua || {}).gibraltar) });
}
function vuaGuardarCfg(v){ const c = soivreCfg(); c.vua = v; soivreGuardarCfg(c); }

// ── tablas oficiales (estacice_productos / estacice_codigos) ─
async function vuaCatalogo(){
  if(VUA.cat) return VUA.cat;
  const [p, c] = await Promise.all([
    sbT().from('estacice_productos').select('codigo,nombre,imex').eq('tipo', 'F').order('codigo'),
    sbT().from('estacice_codigos').select('tabla,codigo,nombre,grupo').order('nombre')
  ]);
  if(p.error || c.error) throw new Error((p.error || c.error).message);
  const tabla = t => (c.data || []).filter(x => x.tabla === t);
  VUA.cat = {
    productos: p.data || [], envases: tabla('envase'), aduanas: tabla('aduana'), paises: tabla('pais'),
    provincias: tabla('provincia'), cices: tabla('cice_pi')
  };
  return VUA.cat;
}

// Productos SOIVRE posibles para un TARIC: misma partida (4 dígitos) o, si no
// hay, mismo capítulo. Se preselecciona el que más palabras comparte con la
// descripción de la factura.
function vuaProductosPara(taric){
  const t = String(taric || '').replace(/\D/g, '');
  const prods = (VUA.cat && VUA.cat.productos || []).filter(p => p.imex !== 'I');
  const p4 = prods.filter(p => p.codigo.startsWith(t.slice(0, 4)));
  return p4.length ? p4 : prods.filter(p => p.codigo.startsWith(t.slice(0, 2)));
}
function vuaNormal(s){ return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }
function vuaElegirProducto(taric, descripcion){
  const opciones = vuaProductosPara(taric);
  const palabras = vuaNormal(descripcion).split(/[^A-Z]+/).filter(w => w.length > 3);
  let mejor = null, puntos = 0;
  opciones.forEach(p => {
    const n = vuaNormal(p.nombre);
    const pt = palabras.filter(w => n.includes(w.slice(0, 5))).length - (/LAS DEMAS|LOS DEMAS/.test(n) ? 0.5 : 0);
    if(pt > puntos){ puntos = pt; mejor = p.codigo; }
  });
  return mejor || (opciones.length === 1 ? opciones[0].codigo : '');
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

// lineas: las de la factura con medida SOVEX. Devuelve las solicitudes creadas.
function vuaPrepararDesdeFactura(lineas){
  const cfg = vuaCfg();
  const grupos = new Map();
  (lineas || []).forEach(l => {
    const cab = l._cab || (typeof FACTURA_CABECERA !== 'undefined' && FACTURA_CABECERA) || {};
    const origen = soivreOrigenDe(l) || 'ES';
    const clave = `${l.fichero || cab.numero_factura || ''}|${origen}`;
    if(!grupos.has(clave)) grupos.set(clave, { cab, origen, archivo: soivreArchivoDe(l), lineas: [] });
    grupos.get(clave).lineas.push(l);
  });
  const nuevas = [];
  grupos.forEach(g => {
    const agente = vuaAgenteDe(g.cab.exportador);
    const destinoTxt = g.cab.pais_destino || (g.cab.destinatario && g.cab.destinatario.pais) || '';
    const destino = destinoTxt ? (typeof _vtPaisISO === 'function' ? _vtPaisISO(destinoTxt) : destinoTxt) : '';
    const moneda = VUA_MONEDAS[String(g.cab.moneda || '').toUpperCase()] || '';
    const lineasVua = g.lineas.map(l => {
      const bruto = vuaNum(l.peso_bruto), neto = vuaNum(l.peso_neto);
      const envases = vuaNum(l.bultos);
      return {
        taric: String(l.codigo_taric || '').replace(/\D/g, ''),
        descripcion: l.descripcion_es || l.descripcion_original || '',
        envases: Number.isFinite(envases) ? String(Math.round(envases)) : (/caj|box|bult/i.test(l.unidad || '') ? vuaFmt(vuaNum(l.cantidad)) : ''),
        unidad: l.unidad || '', codEnvase: vuaEnvaseDe(l.unidad), marca: cfg.marcas[agente.nif] || '',
        producto: vuaElegirProducto(l.codigo_taric, l.descripcion_es || l.descripcion_original),
        categoria: '2', pesoBruto: vuaFmt(bruto), pesoNeto: vuaFmt(neto),
        importe: Number.isFinite(vuaNum(l.importe)) && moneda ? vuaFmt(vuaNum(l.importe)) : '', moneda,
        factura: String(g.cab.numero_factura || '').slice(0, 30)
      };
    });
    for(let i = 0; i < lineasVua.length; i += VUA_MAX_LINEAS){
      nuevas.push(vuaNuevaSolicitud({
        origen: g.origen, destino, agente, archivo: g.archivo, factura: g.cab.numero_factura || '',
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
    k: 'v' + (++VUA.seq), origen: 'ES', destino: '', agente: vuaAgenteDe({}), lineas: [], archivo: null,
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
      <td style="padding:6px 4px;white-space:nowrap">${s.flujo === 'E' ? 'Exportación' : 'Reexportación'}${s.parte ? ` <span style="color:var(--g400)">(${s.parte})</span>` : ''}</td>
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
      <div style="font-size:12px;font-weight:700;margin-bottom:2px">🍊 ESTACICE VUA · frutas y hortalizas <span style="font-weight:400;color:var(--g500)">· ${sols.length} solicitud${sols.length > 1 ? 'es' : ''} de hasta ${VUA_MAX_LINEAS} líneas</span></div>
      <div style="font-size:11px;color:var(--g500);margin-bottom:4px">Una por factura y país de origen (España = exportación, otro = reexportación). El agente económico es el exportador de cada factura. Sin MRN.</div>
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

function vuaFilaLinea(l, i){
  const prods = vuaProductosPara(l.taric);
  const c = 'style="width:100%;font-size:11px;padding:4px 5px"';
  return `<tr data-i="${i}" style="border-top:1px solid var(--g100);vertical-align:top">
    <td style="padding:4px 2px;text-align:center;font-weight:700">${i + 1}</td>
    <td style="padding:4px 2px;min-width:150px">
      <input class="fi vl-taric" ${c} value="${sEsc(l.taric)}" maxlength="10" onchange="vuaRefrescarProductos(this)" style="width:100%;font-size:11px;padding:4px 5px;font-family:var(--mono)">
      <select class="fi vl-producto" ${c}>${vuaOpc(prods, l.producto, prods.length ? '— producto SOIVRE —' : 'Sin productos para este TARIC')}</select>
      <div style="font-size:10px;color:var(--g400);margin-top:2px;max-width:220px">${sEsc(l.descripcion || '')}</div>
    </td>
    <td style="padding:4px 2px;width:70px"><input class="fi vl-envases" ${c} value="${sEsc(l.envases)}" inputmode="numeric"></td>
    <td style="padding:4px 2px;width:110px"><select class="fi vl-codenv" ${c}>${vuaOpc(VUA.cat.envases, l.codEnvase)}</select></td>
    <td style="padding:4px 2px;width:100px"><input class="fi vl-marca" ${c} value="${sEsc(l.marca)}" maxlength="20"></td>
    <td style="padding:4px 2px;width:70px"><select class="fi vl-cat" ${c}>${Object.entries(VUA_CATEGORIAS).map(([k, v]) => `<option value="${k}" ${k === l.categoria ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td style="padding:4px 2px;width:80px"><input class="fi vl-bruto" ${c} value="${sEsc(l.pesoBruto)}" inputmode="decimal"></td>
    <td style="padding:4px 2px;width:80px"><input class="fi vl-neto" ${c} value="${sEsc(l.pesoNeto)}" inputmode="decimal"></td>
    <td style="padding:4px 2px;width:110px"><input class="fi vl-factura" ${c} value="${sEsc(l.factura)}" maxlength="30"></td>
    <td style="padding:4px 2px"><button class="btn btn-s btn-sm" style="padding:2px 6px" title="Quitar línea" onclick="vuaQuitarLinea(this)">✕</button></td>
  </tr>`;
}

async function abrirSolicitudVua(k){
  const s = vuaSol(k);
  if(!s) return;
  soivreModal('🍊 Solicitud ESTACICE VUA · frutas y hortalizas', '<div class="loading-wrap"><div class="spinner"></div><span>Cargando tablas oficiales…</span></div>', 1020);
  soivreComprobarServidor().then(() => { const el = document.getElementById('vua-entorno'); if(el) el.innerHTML = soivreChipEntorno(SOIVRE.estado); });
  try{ await vuaCatalogo(); }
  catch(e){ document.getElementById('soivre-modal-body').innerHTML = sAviso(`No se pudieron leer las tablas ESTACICE de Supabase (${sEsc(e.message)}). ¿Se ha ejecutado instalar_soivre.sql?`); return; }
  // Recalcular productos si la solicitud se preparó antes de tener el catálogo
  s.lineas.forEach(l => {
    if(!l.producto) l.producto = vuaElegirProducto(l.taric, l.descripcion);
    if(l.unidad && !l._envRevisado){ l.codEnvase = vuaEnvaseDe(l.unidad); l._envRevisado = true; }
  });
  const cat = VUA.cat, a = s.agente, en = s.envasador || {};
  const paisOpc = sel => vuaOpc(cat.paises, sel);
  const provOpc = sel => vuaOpc(cat.provincias, sel, '—');
  document.getElementById('soivre-modal-body').innerHTML = `
    <div id="vua-entorno" style="margin-bottom:10px">${soivreChipEntorno(SOIVRE.estado)}</div>
    ${sGrid(170,
      sCampo('Centro y punto de inspección', `<select id="vua-cice" class="fi" style="width:100%">${vuaOpc(cat.cices.filter(c => c.grupo === 'Algeciras' || c.codigo === s.cicePI), s.cicePI)}<option value="" disabled>──────────</option>${vuaOpc(cat.cices.filter(c => c.grupo !== 'Algeciras' && c.codigo !== s.cicePI), '')}</select>`),
      sCampo('Tipo', `<select id="vua-flujo" class="fi" style="width:100%"><option value="E" ${s.flujo === 'E' ? 'selected' : ''}>Exportación</option><option value="R" ${s.flujo === 'R' ? 'selected' : ''}>Reexportación</option></select>`),
      sCampo('País de origen', `<select id="vua-origen" class="fi" style="width:100%" onchange="document.getElementById('vua-flujo').value=this.value==='ES'?'E':'R'">${paisOpc(s.origen || 'ES')}</select>`),
      sCampo('País de destino', `<select id="vua-destino" class="fi" style="width:100%" onchange="vuaDestinoCambiado(this.value)">${vuaOpc(cat.paises, s.destino, '— elegir —')}</select>`)
    )}
    ${sGrid(170,
      sCampo('Aduana de salida', `<select id="vua-aduana" class="fi" style="width:100%">${vuaOpc(cat.aduanas, s.aduana, '— elegir —')}</select>`),
      sCampo('Transporte', `<select id="vua-transporte" class="fi" style="width:100%">${Object.entries(VUA_TRANSPORTES).map(([k, v]) => `<option value="${k}" ${k === s.transporte ? 'selected' : ''}>${v}</option>`).join('')}</select>`),
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
        `<div style="grid-column:span 2">${sCampo('Dirección *', vuaIn('vua-ae-direccion', a.direccion, 'maxlength="45"'))}</div>`,
        sCampo('CP', vuaIn('vua-ae-cp', a.cp, 'maxlength="5" oninput="const p=document.getElementById(\'vua-ae-prov\');if(this.value.length===5&&p)p.value=this.value.slice(0,2)"')),
        sCampo('Localidad *', vuaIn('vua-ae-localidad', a.localidad, 'maxlength="45"')),
        sCampo('Provincia', `<select id="vua-ae-prov" class="fi" style="width:100%">${provOpc(a.provincia)}</select>`),
        sCampo('País', `<select id="vua-ae-pais" class="fi" style="width:100%">${paisOpc(a.pais || 'ES')}</select>`)
      )}
      ${s.destinatario ? `<div style="font-size:11px;color:var(--g500)">Destinatario según factura: <strong>${sEsc(s.destinatario)}</strong>. La solicitud de frutas no tiene campo para el destinatario; consta en la factura adjunta.</div>` : ''}
    </fieldset>
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
    </details>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <div style="font-size:12px;font-weight:700;color:var(--g600)">Productos <span id="vua-nlineas" style="font-weight:400;color:var(--g400)">(${s.lineas.length}/${VUA_MAX_LINEAS})</span></div>
      <button class="btn btn-s btn-sm" style="margin-left:auto" onclick="vuaAnadirLinea()">+ Línea</button>
    </div>
    <div style="overflow-x:auto;margin-bottom:10px"><table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="font-size:10px;color:var(--g500);text-transform:uppercase;text-align:left">
        <th>Lín</th><th>TARIC · producto SOIVRE</th><th>Nº env.</th><th>Envase</th><th>Marca</th><th>Cat.</th><th>P. bruto</th><th>P. neto</th><th>Nº factura</th><th></th>
      </tr></thead>
      <tbody id="vua-lineas">${s.lineas.map(vuaFilaLinea).join('')}</tbody>
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

function vuaDestinoCambiado(destino){
  const cfg = vuaCfg();
  const set = (id, v) => { const el = document.getElementById(id); if(el && v && el.querySelector(`option[value="${v}"]`)) el.value = v; };
  if(destino === 'GI'){ set('vua-cice', cfg.gibraltar.cicePI); set('vua-aduana', cfg.gibraltar.aduana); }
}
function vuaRefrescarProductos(input){
  const tr = input.closest('tr');
  const prods = vuaProductosPara(input.value);
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
  const base = { taric: '', descripcion: '', envases: '', codEnvase: '04', marca: prev ? prev.querySelector('.vl-marca').value : '',
                 producto: '', categoria: '2', pesoBruto: '', pesoNeto: '', factura: prev ? prev.querySelector('.vl-factura').value : '' };
  tb.insertAdjacentHTML('beforeend', vuaFilaLinea(base, tb.children.length));
  vuaContarLineas();
}
function vuaQuitarLinea(btn){ btn.closest('tr').remove(); vuaContarLineas(); }

// Vuelca el formulario en la solicitud (para no perder lo tecleado)
function vuaLeerFormulario(k){
  const s = vuaSol(k);
  const v = id => (document.getElementById(id)?.value || '').trim();
  if(!s || !document.getElementById('vua-flujo')) return s;
  Object.assign(s, {
    cicePI: v('vua-cice'), flujo: v('vua-flujo'), origen: v('vua-origen'), destino: v('vua-destino'),
    aduana: v('vua-aduana'), transporte: v('vua-transporte'), matricula: v('vua-matricula'),
    otrasMatriculas: v('vua-otras'), ubicacion: v('vua-ubicacion'), observaciones: v('vua-observaciones'),
    envasadorIgual: document.getElementById('vua-env-igual').checked,
    agente: { paisNif: v('vua-ae-paisnif'), nif: v('vua-ae-nif').toUpperCase(), nombre: v('vua-ae-nombre'), direccion: v('vua-ae-direccion'),
              cp: v('vua-ae-cp'), localidad: v('vua-ae-localidad'), provincia: v('vua-ae-prov'), pais: v('vua-ae-pais') },
    envasador: { nif: v('vua-env-nif').toUpperCase(), nombre: v('vua-env-nombre'), direccion: v('vua-env-direccion'), cp: v('vua-env-cp'),
                 localidad: v('vua-env-localidad'), provincia: v('vua-env-prov'), pais: v('vua-env-pais') },
    lineas: [...document.querySelectorAll('#vua-lineas tr')].map((tr, i) => {
      const q = c => (tr.querySelector(c)?.value || '').trim();
      const prev = s.lineas[+tr.dataset.i] || {};
      return { taric: q('.vl-taric').replace(/\D/g, ''), descripcion: prev.descripcion || '', producto: q('.vl-producto'),
               envases: q('.vl-envases'), codEnvase: q('.vl-codenv'), marca: q('.vl-marca'), categoria: q('.vl-cat'),
               pesoBruto: q('.vl-bruto').replace(',', '.'), pesoNeto: q('.vl-neto').replace(',', '.'), factura: q('.vl-factura'),
               importe: prev.importe || '', moneda: prev.moneda || '', unidad: prev.unidad || '', _envRevisado: true };
    })
  });
  const f = document.getElementById('vua-factura')?.files?.[0];
  if(f) s.archivo = f;
  return s;
}

function vuaDatos(s){
  const ae = s.agente;
  return {
    codCicePI: s.cicePI, exporImpor: s.flujo, ubicacion: s.ubicacion,
    agente: ae, envasador: s.envasadorIgual ? { nif: ae.nif, nombre: ae.nombre, direccion: ae.direccion, cp: ae.cp,
                                                 localidad: ae.localidad, provincia: ae.provincia, pais: ae.pais } : s.envasador,
    // En exportación el origen va vacío o ES: se envía ES
    origen: s.flujo === 'E' ? 'ES' : s.origen, destino: s.destino, transporte: s.transporte,
    matricula: s.matricula, otrasMatriculas: s.otrasMatriculas, aduana: s.aduana, observaciones: s.observaciones,
    lineas: s.lineas.map(l => ({ envases: l.envases, codEnvase: l.codEnvase, marca: l.marca, producto: l.producto, taric: l.taric,
                                 categoria: l.categoria, pesoBruto: l.pesoBruto, pesoNeto: l.pesoNeto, factura: l.factura,
                                 importe: l.importe, moneda: l.moneda }))
  };
}

// Comprobación previa en el navegador (el servidor vuelve a validar contra el XSD)
function vuaComprobar(s, d){
  const e = [];
  if(!/^\d{4}$/.test(d.codCicePI)) e.push('Elige el centro y punto de inspección');
  if(!d.destino || d.destino === 'ES') e.push('País de destino: obligatorio y distinto de España');
  if(d.exporImpor === 'R' && (!s.origen || s.origen === 'ES')) e.push('Reexportación: el país de origen no puede ser España');
  if(d.exporImpor === 'E' && s.origen && s.origen !== 'ES') e.push('Origen distinto de España: es una reexportación');
  if(!/^\d{4}$/.test(d.aduana)) e.push('Elige la aduana de salida');
  if((d.matricula || '').length < 3) e.push('Matrícula: obligatoria');
  if(!d.agente.nif || d.agente.nif.length < 7) e.push('Agente económico: NIF obligatorio');
  if(!d.agente.nombre || d.agente.nombre.length < 3) e.push('Agente económico: nombre fiscal obligatorio');
  if(!d.agente.direccion || !d.agente.localidad) e.push('Agente económico: dirección y localidad obligatorias');
  if(d.agente.pais === 'ES' && (!/^\d{5}$/.test(d.agente.cp) || !d.agente.provincia)) e.push('Agente económico español: CP y provincia obligatorios');
  if(!d.lineas.length || d.lineas.length > VUA_MAX_LINEAS) e.push(`Entre 1 y ${VUA_MAX_LINEAS} líneas`);
  d.lineas.forEach((l, i) => {
    const p = `Línea ${i + 1}`;
    if(!l.producto) e.push(`${p}: elige el producto SOIVRE`);
    if(!/^\d+$/.test(l.envases)) e.push(`${p}: nº de envases`);
    if((l.marca || '').length < 2) e.push(`${p}: marca (mín. 2 caracteres)`);
    const b = parseFloat(l.pesoBruto), n = parseFloat(l.pesoNeto);
    if(!(n > 0)) e.push(`${p}: peso neto`);
    if(!(b > n)) e.push(`${p}: el peso bruto debe ser mayor que el neto`);
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

async function vuaEnviar(k, soloXml){
  const s = vuaLeerFormulario(k);
  const d = vuaDatos(s);
  // Recordar centro/aduana habituales y la marca del exportador
  const cfg = vuaCfg();
  if(s.agente.nif && s.lineas[0] && s.lineas[0].marca) cfg.marcas[s.agente.nif] = s.lineas[0].marca;
  if(s.destino !== 'GI'){ cfg.cicePI = s.cicePI || cfg.cicePI; cfg.aduana = s.aduana || cfg.aduana; }
  cfg.transporte = s.transporte; cfg.ubicacion = s.ubicacion || cfg.ubicacion; cfg.ultimoAgente = s.agente;
  vuaGuardarCfg(cfg);

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
  vuaResultado(s);
  if(typeof soivrePanelFacturaRefrescar === 'function') soivrePanelFacturaRefrescar();
  if(document.getElementById('view-soivre')?.classList.contains('active')) vuaPintarSesion();
}

function vuaResultado(s){
  const env = s.env;
  const ok = env.estado === 'aceptada';
  soivreModal(`🍊 ESTACICE · ${ok ? 'solicitud registrada' : 'no registrada'}`, `
    <div style="text-align:center;padding:6px 0 12px">
      <div style="font-size:30px">${ok ? '✅' : env.estado === 'en cola' ? '⏳' : '❌'}</div>
      <div style="font-size:15px;font-weight:700;margin-top:4px">${ok ? 'Registrada en ESTACICE' : sEsc(env.descripcion || 'No registrada')}</div>
      ${env.entorno === 'pruebas' ? '<div style="font-size:11px;color:var(--am600);margin-top:2px">Entorno de PRUEBAS: no se inspecciona</div>' : ''}
    </div>
    <table style="width:100%;font-size:12px;margin-bottom:10px">
      <tr><td style="color:var(--g500);padding:4px 0;width:150px">Nº solicitud SOIVRE</td><td style="font-family:var(--mono);font-weight:700">${sEsc(env.numero || '—')}</td></tr>
      <tr><td style="color:var(--g500);padding:4px 0">Agente económico</td><td>${sEsc(s.agente.nombre)} · ${sEsc(s.agente.nif)}</td></tr>
      <tr><td style="color:var(--g500);padding:4px 0">Líneas</td><td>${s.lineas.length} · ${s.flujo === 'E' ? 'exportación' : 'reexportación'} ${sEsc(s.origen || 'ES')} → ${sEsc(s.destino)}</td></tr>
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
function vuaNuevaDesdeResultado(codigo, descripcion){
  const origen = document.getElementById('spg-pais')?.value || 'ES';
  const ult = vuaCfg().ultimoAgente;
  const s = vuaNuevaSolicitud({
    origen, agente: ult || vuaAgenteDe({}),
    lineas: [{ taric: String(codigo || '').replace(/\D/g, ''), descripcion: descripcion || '', envases: '', codEnvase: '04', marca: '',
               producto: '', categoria: '2', pesoBruto: '', pesoNeto: '', factura: '' }]
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
      <td>${s.env.numero ? `<button class="btn btn-s btn-sm" onclick="vuaConsultar('${s.k}')">Estado</button>` : `<button class="btn btn-s btn-sm" onclick="abrirSolicitudVua('${s.k}')">Revisar</button>`}</td>
    </tr>`).join('')}</tbody></table>`
    : '<div style="font-size:12px;color:var(--g400)">Sin envíos a ESTACICE en esta sesión.</div>';
}
