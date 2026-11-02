'use strict';
// ═══ SOIVRE · Punto Único de Entrada (PUE) de la AEAT ═══
// Se carga después del script principal de taric.html y usa sus globales:
// sbT(), TARIC_DB, showToast(), copiarTexto(), PortalGuard, nav().
//
// La medida TARIC del código clasificado decide el servicio:
//   SOVEX / SOVIM  → CAL1  calidad comercial (exportación / importación)
//   ROHS / RAEE    → ROHS1 aparatos eléctricos y electrónicos
//   COM            → COM1  seguridad de productos industriales (incluye ROHS/RAEE)
// Cada solicitud lleva la factura comercial: se sube a Storage y el servidor
// la envía en .zip con PUE7 en cuanto la AEAT devuelve el nº de solicitud.
// Flujo: formulario → cola en Supabase (soivre_cola) → servidor AEAT Monitor
// (soivre_pue.py, certificado de la empresa) → AEAT → respuesta → pantalla.
// La fila y el fichero se borran tras el envío: el histórico oficial está en ESTACICE.

const SOIVRE_CFG_KEY = 'cw_soivre_cfg';
const SOIVRE_CFG_DEF = {
  codCice: '', codPI: '',
  email: '',
  envasador: { nif:'', nombre:'', localidad:'', provincia:'', pais:'ES' },
  codigoRaee: '', codigoPya: ''   // nº de registro RII del importador habitual
};
// sesion: envíos de esta pestaña (solo memoria) para ver XML, reintentar o aportar más datos
// grupos: líneas SOIVRE de la última factura leída por origen · mrnGrupo: MRN tecleado para cada grupo
const SOIVRE = { estado:null, productos:new Map(), envases:null, ctx:new Map(), seq:0, sesion:[], grupos:[], mrnGrupo:{} };
const SOIVRE_BUCKET = 'soivre-adjuntos';
const SOIVRE_MAX_FICHERO = 10 * 1024 * 1024;

const SOIVRE_SERVICIOS = {
  CAL1:  { nombre:'Calidad comercial',      icono:'🍊', adicional:'CAL3',  siglas:'CAL' },
  ROHS1: { nombre:'ROHS / RAEE',            icono:'🔌', adicional:'ROHS3', siglas:'ROHS' },
  COM1:  { nombre:'Productos industriales', icono:'🧸', adicional:'COM3',  siglas:'COM' }
};

// Valores de los XSD (ROHSTiposDeDatosV1 / COMTiposDeDatosV1 / PUETiposDeDatosV1)
const SOIVRE_ESPEC_ROHS = {
  '01':'Sin especificidad', '02':'Uso profesional según RII', '03':'Uso no profesional según RII', '04':'Paquetería',
  '05':'Sometido a exención ROHS', '06':'RII tramitado por SCRAP', '07':'Comercio electrónico a particular',
  '08':'AEE para reacondicionar', '09':'AEE con pilas o baterías extraíbles', '10':'AEE con pilas o baterías NO extraíbles',
  '11':'Componentes de AEE', '12':'Producto para reparar', '13':'Registro AEE o PyA en otro estado miembro',
  '14':'Retorno de mercancía', '15':'Repuesto/recambio de AEE', '16':'Usuario final - uso propio',
  '17':'Herramienta industrial fija de gran envergadura', '18':'Instalación fija de gran envergadura',
  '19':'Paneles fotovoltaicos > 50 cm', '20':'Maquinaria móvil de obras públicas'
};
const SOIVRE_ESPEC_COM = {
  '00':'No aplica ninguna', '01':'Uso menor 3 años', '02':'Imanes y/o ventosas', '03':'Calzado de niño', '04':'Sandalias',
  '05':'EPI cat I', '06':'EPI cat II', '07':'EPI cat III', '08':'Estampado plastisol', '09':'Con golosinas',
  '10':'Con cosméticos', '11':'Diseño ecológico', '12':'Uso construcción', '13':'Uso NO construcción',
  '14':'Uso estructural', '15':'Uso NO estructural', '16':'EPI microbiológico', '17':'Uso profesional',
  '18':'Uso consumidor', '19':'Aparato eléctrico o electrónico', '20':'Juguete eléctrico o electrónico',
  '21':'Contiene pilas y baterías', '22':'Uso privado eléctrico', '23':'Uso profesional eléctrico',
  '24':'Uso profesional según RII', '25':'Uso no profesional según RII', '26':'Paquetería',
  '27':'Sometido a exención ROHS', '28':'RII tramitado por SCRAP', '29':'Comercio electrónico a particular',
  '30':'AEE para reacondicionar', '31':'AEE con pilas o baterías extraíbles', '32':'AEE con pilas o baterías NO extraíbles',
  '33':'Componentes de AEE', '34':'Producto para reparar', '35':'Registro AEE o PyA en otro estado miembro',
  '36':'Retorno de mercancía', '37':'Repuesto/recambio de AEE', '38':'Usuario final - uso propio',
  '39':'AEE para investigación y desarrollo', '40':'AEE para instalar en AEE excluido', '41':'Comercio electrónico empresas',
  '42':'Muestrarios', '43':'Mercancías para ferias', '44':'Otras exenciones RAEE o RPyA', '45':'NO AEE, NO componente, NO repuesto'
};
const SOIVRE_TIPO_DOC = { FACTU:'Factura', JPAGO:'Justificante de pago', CERTIFICADO:'Certificado', DTPTE:'Documento de transporte',
                          DTECN:'Documentación técnica', COMPR:'Compromisos / cartas del operador', OTROS:'Otros' };
// Unidades de la guía ROHS-RAEE (también para COM)
const SOIVRE_UNIDADES_AEE = ['UNIDADES FÍSICAS','DOCENAS','JUEGOS','PARES','METROS','METROS CUADRADOS','METROS CUBICOS'];

function soivreCfg(){
  try{ return Object.assign({}, SOIVRE_CFG_DEF, JSON.parse(localStorage.getItem(SOIVRE_CFG_KEY) || '{}')); }
  catch(_){ return { ...SOIVRE_CFG_DEF }; }
}
function soivreGuardarCfg(c){ try{ localStorage.setItem(SOIVRE_CFG_KEY, JSON.stringify(c)); }catch(_){} }
const sEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sVal = id => (document.getElementById(id)?.value || '').trim();
const sMulti = id => [...(document.getElementById(id)?.selectedOptions || [])].map(o => o.value);
const sFichero = id => (document.getElementById(id)?.files || [])[0] || null;

// ── ¿Qué control SOIVRE aplica? ──────────────────────────────
// 1º las medidas del catálogo TARIC de Supabase: COM, ROHS/RAEE (importación).
//    Ese catálogo es el TARIC de la UE y NO trae las medidas nacionales de
//    calidad a la exportación (SOVEX), por eso:
// 2º la lista oficial de productos SOIVRE de ESTACICE (estacice_productos):
//    si la partida de 4 dígitos del código figura en ella con flujo de
//    exportación, hay control de calidad: F frutas y hortalizas, O otros
//    productos (aceite de oliva, aceitunas, hierbas aromáticas…).
// 3º sin catálogos, aviso orientativo para los capítulos 07 y 08.
function soivreAplica(codigo){
  const c = String(codigo || '').replace(/\D/g, '');
  if(c.length < 8) return null;
  if(typeof TARIC_DB !== 'undefined' && TARIC_DB.ok){
    const cats = [...(TARIC_DB.med.get(c.padEnd(10, '0')) || TARIC_DB.med.get(c) || [])].map(x => String(x).toUpperCase());
    const hay = re => cats.some(x => re.test(x));
    // COM1 lleva también los certificados ROHS y RAEE: tiene prioridad sobre ROHS1
    if(hay(/\bCOM\b/))              return { servicio:'COM1',  seguro:true, medidas:cats };
    if(hay(/\bROHS\b|\bRAEE\b/))    return { servicio:'ROHS1', seguro:true, medidas:cats };
    if(hay(/SOVEX/))                return { servicio:'CAL1',  seguro:true, medidas:cats, flujo:'02', tipoVua:'F' };
    if(hay(/SOVIM/))                return { servicio:'CAL1',  seguro:true, medidas:cats, flujo:'01' };
  }
  const oficial = SOIVRE.lista && SOIVRE.lista.get(c.slice(0, 4));
  if(oficial){
    const tipo = oficial.F ? 'F' : 'O';
    return { servicio: tipo === 'F' ? 'CAL1' : 'VUAO', seguro:true, flujo:'02', tipoVua: tipo, fuente:'lista',
             medidas:['Lista oficial de productos SOIVRE'], productos: oficial[tipo] };
  }
  if(typeof TARIC_DB !== 'undefined' && TARIC_DB.ok) return null;
  return /^0[78]/.test(c) ? { servicio:'CAL1', seguro:false, medidas:[], flujo:'02', tipoVua:'F' } : null;
}

// Lista oficial de productos SOIVRE a la exportación, por partida de 4 dígitos
function soivreCargarLista(){
  if(SOIVRE.lista) return Promise.resolve(SOIVRE.lista);
  if(SOIVRE._cargaLista) return SOIVRE._cargaLista;
  SOIVRE._cargaLista = sbT().from('estacice_productos').select('codigo,nombre,tipo,imex').in('tipo', ['F', 'O']).neq('imex', 'I')
    .then(({ data, error }) => {
      if(error) throw error;
      const m = new Map();
      (data || []).forEach(p => {
        const k = p.codigo.slice(0, 4);
        if(!m.has(k)) m.set(k, {});
        (m.get(k)[p.tipo] = m.get(k)[p.tipo] || []).push(p);
      });
      return (SOIVRE.lista = m);
    })
    .catch(e => { console.warn('Lista oficial SOIVRE no disponible (¿instalar_soivre.sql?):', e.message); return (SOIVRE.lista = new Map()); });
  return SOIVRE._cargaLista;
}

function soivreBloqueResultado(r){
  if(!SOIVRE.lista){
    const id = 'soivre-bloque-' + (++SOIVRE.seq);
    soivreCargarLista().then(() => { const el = document.getElementById(id); if(el) el.outerHTML = soivreBloqueResultado(r) || ''; });
    return `<div id="${id}"></div>`;
  }
  const a = soivreAplica(r && r.codigo_taric);
  if(!a) return '';
  if(a.tipoVua === 'O') return soivreBloqueVua(r, a);
  const s = SOIVRE_SERVICIOS[a.servicio];
  if(a.fuente === 'lista') return soivreBloqueVua(r, a);
  const k = soivreRegistrarCtx({ codigo_taric: r.codigo_taric, descripcion: r.descripcion_nc || '', ...a });
  const vua = a.tipoVua && a.flujo !== '01' && typeof vuaNuevaDesdeResultado === 'function';
  const titulo = a.seguro
    ? `Medida ${sEsc(a.medidas.filter(m => /SOVEX|SOVIM|ROHS|RAEE|\bCOM\b/.test(m)).join(' + '))} · control SOIVRE ${s.nombre.toLowerCase()}`
    : 'Posible control SOIVRE de calidad (catálogo TARIC no disponible: verificar medida SOVEX)';
  return `
    <div style="background:var(--gr50,#f0fdf4);border:1px solid #86efac;border-radius:8px;padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:18px">${s.icono}</span>
      <div style="flex:1;min-width:200px">
        <div style="font-size:12px;font-weight:700;color:var(--gr700,#15803d)">${titulo}</div>
        <div style="font-size:11px;color:var(--g600);margin-top:2px">${vua
          ? 'Exportación/reexportación: solicitud en ESTACICE VUA (sin MRN, hasta 12 líneas). El país de origen se toma de «Preferencias arancelarias»; si no hay ninguno, España.'
          : `Solicitud ${a.servicio} por la Ventanilla Única (PUE). Requiere la declaración ya presentada (MRN + partida) y la factura comercial.`}</div>
      </div>
      ${vua ? `<button class="btn btn-p btn-sm" onclick="vuaNuevaDesdeResultado('${sEsc(r.codigo_taric)}', ${sEsc(JSON.stringify(r.descripcion_nc || ''))}, 'F')">Solicitud ESTACICE</button>
               <button class="btn btn-s btn-sm" onclick="abrirSolicitudSoivre('${k}')" title="Por el PUE de la AEAT (con MRN)">Por PUE</button>`
             : `<button class="btn btn-p btn-sm" onclick="abrirSolicitudSoivre('${k}')">Solicitar control SOIVRE</button>`}
    </div>`;
}

// Producto de la lista oficial (frutas y hortalizas u otros productos) → ESTACICE VUA
function soivreBloqueVua(r, a){
  const tipoTxt = a.tipoVua === 'O' ? 'calidad comercial (otros productos)' : 'calidad de frutas y hortalizas';
  // Ejemplos de la partida: primero los que comparten palabras con la descripción («Limones…» antes que «Naranjas…»)
  const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const palabras = norm(r.descripcion_nc).split(/[^A-Z]+/).filter(w => w.length > 3).map(w => w.slice(0, 5));
  const puntos = p => palabras.filter(w => norm(p.nombre).includes(w)).length;
  const ejemplos = [...(a.productos || [])].sort((x, y) => puntos(y) - puntos(x)).slice(0, 3).map(p => p.nombre).join(' · ');
  return `
    <div style="background:var(--gr50,#f0fdf4);border:1px solid #86efac;border-radius:8px;padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:18px">${a.tipoVua === 'O' ? '🫒' : '🍊'}</span>
      <div style="flex:1;min-width:200px">
        <div style="font-size:12px;font-weight:700;color:var(--gr700,#15803d)">Control SOIVRE a la exportación · ${tipoTxt}</div>
        <div style="font-size:11px;color:var(--g600);margin-top:2px">La partida ${sEsc(String(r.codigo_taric || '').slice(0, 4))} figura en la lista oficial de productos SOIVRE (ESTACICE)${ejemplos ? ': ' + sEsc(ejemplos) + '…' : ''}. Solicitud en ESTACICE VUA, sin MRN. El país de origen se toma de «Preferencias arancelarias»; si no hay ninguno, España.</div>
      </div>
      <button class="btn btn-p btn-sm" onclick="vuaNuevaDesdeResultado('${sEsc(r.codigo_taric)}', ${sEsc(JSON.stringify(r.descripcion_nc || ''))}, '${a.tipoVua}')">Solicitud ESTACICE</button>
    </div>`;
}

// Botón compacto para la tabla de líneas de factura
function soivreBotonLinea(l){
  const a = soivreAplica(l && l.codigo_taric);
  if(!a) return '';
  if(a.tipoVua && a.flujo !== '01') return `<div style="margin-top:5px"><span class="badge" style="font-size:9px;background:var(--gr50,#f0fdf4);color:var(--gr700,#15803d)" title="Solicitud ESTACICE: recuadro «Control SOIVRE» de arriba">${a.tipoVua === 'O' ? '🫒' : '🍊'} SOIVRE · ESTACICE</span></div>`;
  const k = soivreRegistrarCtx({
    codigo_taric: l.codigo_taric, descripcion: l.descripcion_es || l.descripcion_original || '',
    cantidad: l.cantidad, unidad: l.unidad, factura: l._numFactura || '', archivo: soivreArchivoDe(l), ...a,
    origen: soivreOrigenDe(l), flujo: a.servicio === 'CAL1' ? soivreFlujoPorOrigen(soivreOrigenDe(l), a.flujo) : a.flujo
  });
  return `<div style="margin-top:5px"><button class="btn btn-s btn-sm" style="font-size:10px;padding:3px 8px" onclick="abrirSolicitudSoivre('${k}')" title="Solicitar control SOIVRE (${a.servicio})">${SOIVRE_SERVICIOS[a.servicio].icono} SOIVRE ${a.servicio}</button></div>`;
}

function soivreRegistrarCtx(o){ const k = 's' + (++SOIVRE.seq); SOIVRE.ctx.set(k, o); return k; }

// Fichero original de la factura de la que sale la línea (FACTURAS es global de taric.html)
function soivreArchivoDe(l){
  if(typeof FACTURAS === 'undefined' || !l) return null;
  const f = FACTURAS.find(x => x.fichero === l.fichero) || (FACTURAS.length === 1 ? FACTURAS[0] : null);
  return (f && f.archivo) || null;
}

// ── Panel tras leer factura ──────────────────────────────────
// Cada línea de la factura es una solicitud: aunque compartan código TARIC
// son variedades distintas (una partida del DUE y un certificado 1236 cada una).
// Las líneas CAL se agrupan por país de origen, porque cada origen va en su
// propia declaración: España → exportación (02), otro país → reexportación (03).
// No envía nada solo: el operador revisa cada formulario y pulsa Enviar.
function soivreOrigenDe(l){
  const p = (l && (l.pais_origen || (l._cab && l._cab.pais_origen))) ||
            (typeof FACTURA_CABECERA !== 'undefined' && FACTURA_CABECERA && FACTURA_CABECERA.pais_origen) || '';
  return typeof _vtPaisISO === 'function' ? _vtPaisISO(p) : String(p).trim().toUpperCase().slice(0, 2);
}
// SOVIM (01, importación) se respeta; SOVEX pasa a 02 o 03 según el origen
function soivreFlujoPorOrigen(origen, flujo){
  if(flujo === '01') return '01';
  return !origen || origen === 'ES' ? '02' : '03';
}
const SOIVRE_FLUJO_TXT = { '01':'Importación', '02':'Exportación', '03':'Reexportación' };

function soivrePanelFactura(lineas){
  if(!SOIVRE.lista) return soivreCargarLista().then(() => soivrePanelFactura(lineas));
  // Clave estable de cada línea («nº factura|posición»): enlaza la línea de la
  // solicitud ESTACICE con la del CSV de VisualTrans para poner su N003
  const cont = {};
  (lineas || []).forEach(l => {
    const nf = l._numFactura || (typeof FACTURA_CABECERA !== 'undefined' && FACTURA_CABECERA && FACTURA_CABECERA.numero_factura) || 'factura';
    if(!l._claveVT){ cont[nf] = (cont[nf] || 0) + 1; l._claveVT = `${nf}|${cont[nf]}`; }
  });
  SOIVRE.grupos = [];
  SOIVRE.vuaLineas = [];
  const porClave = new Map();
  const posicion = new Map();   // clave de grupo -> nº de líneas de la factura con ese origen vistas
  (lineas || []).forEach(l => {
    const origen = soivreOrigenDe(l);
    const a = soivreAplica(l.codigo_taric);
    // La partida sugerida cuenta TODAS las líneas del mismo origen, sujetas o no
    const pos = (posicion.get(origen) || 0) + 1; posicion.set(origen, pos);
    if(!a) return;
    // Frutas y hortalizas a la exportación/reexportación → ESTACICE VUA (soivre-vua.js)
    if(a.tipoVua && a.flujo !== '01' && typeof vuaPrepararDesdeFactura === 'function'){ SOIVRE.vuaLineas.push(l); return; }
    if(a.servicio === 'VUAO') return;   // otros productos: solo por ESTACICE
    const esCal = a.servicio === 'CAL1';
    const flujo = esCal ? soivreFlujoPorOrigen(origen, a.flujo) : null;
    const clave = esCal ? `CAL|${flujo}|${origen}` : 'IMP';
    if(!porClave.has(clave)){
      const g = { clave, esCal, flujo, origen, lineas: [] };
      porClave.set(clave, g); SOIVRE.grupos.push(g);
    }
    const item = {
      ...a, flujo: flujo || a.flujo, origen, l, partida: pos, archivo: soivreArchivoDe(l),
      descripcion: l.descripcion_es || l.descripcion_original || soivreDescTaric(l.codigo_taric)
    };
    item.k = soivreRegistrarCtx({
      codigo_taric: l.codigo_taric, descripcion: item.descripcion, cantidad: l.cantidad, unidad: l.unidad,
      factura: l._numFactura || '', archivo: item.archivo, partida: pos, origen, grupo: clave, servicio: a.servicio,
      seguro: a.seguro, medidas: a.medidas, flujo: item.flujo
    });
    porClave.get(clave).lineas.push(item);
  });
  const info = document.getElementById('factura-info');
  document.getElementById('soivre-panel-factura')?.remove();
  SOIVRE.vuaSols = [];
  if(!info || (!SOIVRE.grupos.length && !SOIVRE.vuaLineas.length)) return;
  info.insertAdjacentHTML('afterbegin', '<div id="soivre-panel-factura"></div>');
  if(!SOIVRE.vuaLineas.length) return soivrePanelFacturaRefrescar();
  // Las tablas oficiales afinan producto SOIVRE y envase; sin ellas se prepara igual
  const preparar = () => { SOIVRE.vuaSols = vuaPrepararDesdeFactura(SOIVRE.vuaLineas); soivrePanelFacturaRefrescar(); };
  vuaCatalogo().then(preparar, preparar);
}
const soivreDescTaric = c => (typeof TARIC_DB !== 'undefined' && TARIC_DB.desc && TARIC_DB.desc.get(c)) || '';

function soivrePanelFacturaRefrescar(){
  const cont = document.getElementById('soivre-panel-factura');
  const vuaSols = SOIVRE.vuaSols || [];
  if(!cont || (!SOIVRE.grupos.length && !vuaSols.length)) return;
  const total = SOIVRE.grupos.reduce((n, g) => n + g.lineas.length, 0) + vuaSols.reduce((n, v) => n + v.lineas.length, 0);
  const grupoHtml = g => {
    const titulo = g.esCal
      ? `${SOIVRE_FLUJO_TXT[g.flujo]} · origen ${sEsc(g.origen || '—')}`
      : 'ROHS / RAEE / COM (importación)';
    const filas = g.lineas.map(it => {
      const s = SOIVRE_SERVICIOS[it.servicio];
      const env = SOIVRE.sesion.find(x => x.ctxKey === it.k);
      const estado = env
        ? `<span class="badge" style="${SOIVRE_ESTADO_ESTILO[env.estado] || ''}">${sEsc(env.estado)}</span>${env.numeroSolicitud ? `<div style="font-family:var(--mono);font-size:10px;margin-top:2px">${sEsc(env.numeroSolicitud)}</div>` : ''}`
        : '<span class="badge" style="background:var(--am50);color:var(--am600)">por solicitar</span>';
      return `<tr style="border-top:1px solid var(--g100)">
        <td style="padding:6px 4px;text-align:center">${it.partida}</td>
        <td style="padding:6px 4px;white-space:nowrap">${s.icono} ${it.servicio}</td>
        <td style="padding:6px 4px;font-family:var(--mono);white-space:nowrap">${sEsc(it.l.codigo_taric)}</td>
        <td style="padding:6px 4px;max-width:260px">${sEsc(it.descripcion)}<div style="font-size:10px;color:var(--g400)">${sEsc(it.l._numFactura || '—')}${it.archivo ? ' · 📎' : ''}</div></td>
        <td style="padding:6px 4px;white-space:nowrap">${sEsc(it.l.cantidad || '—')} ${sEsc(it.l.unidad || '')}</td>
        <td style="padding:6px 4px">${estado}</td>
        <td style="padding:6px 4px;text-align:right">${env && env.estado === 'aceptada' ? '' : `<button class="btn ${env ? 'btn-s' : 'btn-p'} btn-sm" onclick="abrirSolicitudSoivre('${it.k}')">${env ? 'Revisar' : 'Preparar'}</button>`}</td>
      </tr>`;
    }).join('');
    return `
      <div style="background:var(--w);border:1px solid var(--g200);border-radius:8px;padding:8px 10px;margin-top:8px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px">
          <div style="flex:1;min-width:200px;font-size:12px;font-weight:700">${titulo} <span style="font-weight:400;color:var(--g500)">· ${g.lineas.length} solicitud${g.lineas.length > 1 ? 'es' : ''}</span></div>
          <div style="min-width:210px"><input class="fi" style="width:100%;font-family:var(--mono);font-size:12px" maxlength="18" placeholder="MRN de su declaración (18)"
            value="${sEsc(SOIVRE.mrnGrupo[g.clave] || '')}" oninput="this.value=this.value.toUpperCase();SOIVRE.mrnGrupo['${g.clave}']=this.value.trim()"></div>
        </div>
        <div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead><tr style="font-size:10px;color:var(--g500);text-transform:uppercase;text-align:left">
            <th style="padding:4px;text-align:center" title="Posición de la línea entre las de este origen; compruébala con la declaración">Partida</th><th style="padding:4px">Servicio</th><th style="padding:4px">TARIC</th><th style="padding:4px">Mercancía</th><th style="padding:4px">Cantidad</th><th style="padding:4px">Estado</th><th></th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table></div>
      </div>`;
  };
  cont.innerHTML = `
    <div class="card" style="padding:12px 16px;margin-bottom:12px;border:1px solid #86efac;background:var(--gr50,#f0fdf4)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">🛂</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--gr700,#15803d)">Control SOIVRE: ${total} línea${total > 1 ? 's' : ''} de esta factura con medida SOIVRE</div>
          <div style="font-size:11px;color:var(--g600)">Revisa cada solicitud y envíala. La factura leída se adjunta sola.</div>
        </div>
      </div>
      ${typeof vuaPanelHtml === 'function' ? vuaPanelHtml(vuaSols) : ''}
      ${SOIVRE.grupos.length ? `<div style="font-size:11px;color:var(--g500);margin-top:10px">Por el PUE de la AEAT (una solicitud por línea, con el MRN de la declaración):</div>` : ''}
      ${SOIVRE.grupos.map(grupoHtml).join('')}
    </div>`;
}

// ── servidor AEAT Monitor ────────────────────────────────────
const SOIVRE_LATIDO_MAX = 90;   // segundos sin latido para darlo por caído

async function soivreComprobarServidor(){
  try{
    const { data, error } = await sbT().from('soivre_servidor')
      .select('id,entorno,simulacion,titular,caduca,visto_en').order('visto_en', { ascending:false }).limit(1);
    if(error) throw error;
    const s = data && data[0];
    if(!s) SOIVRE.estado = { ok:false, error:'El servidor SOIVRE no se ha conectado nunca' };
    else{
      const seg = Math.round((Date.now() - new Date(s.visto_en).getTime()) / 1000);
      SOIVRE.estado = seg <= SOIVRE_LATIDO_MAX
        ? { ok:true, servidor:s.id, entorno:s.entorno, simulacion:s.simulacion, titular:s.titular, caduca:s.caduca }
        : { ok:false, servidor:s.id, error:`Servidor ${s.id} sin señal desde hace ${seg > 3600 ? Math.round(seg/3600)+' h' : Math.round(seg/60)+' min'}` };
    }
  }catch(e){ SOIVRE.estado = { ok:false, error:'No se pudo consultar el estado del servidor: ' + e.message }; }
  soivrePintarEstado();
  soivreActualizarEntornoModal();
  return SOIVRE.estado;
}

// Sube el fichero a Storage (bucket privado). El servidor lo descarga, lo envía
// y lo borra.
async function soivreSubirFichero(idMensaje, fichero){
  const nombre = fichero.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').slice(-80);
  const ruta = `${idMensaje}/${Date.now()}_${nombre}`;
  const { error } = await sbT().storage.from(SOIVRE_BUCKET).upload(ruta, fichero, { upsert:false });
  if(error) throw new Error('No se pudo subir la factura: ' + error.message);
  return { ruta, nombre: fichero.name };
}

// Encola la petición y espera a que el servidor la resuelva. Devuelve el
// resultado y borra la fila (la cola no guarda histórico).
async function soivreLlamar(servicio, datos, idMensaje, soloXml, contexto, fichero){
  const e = SOIVRE.estado || {};
  let adj = null;
  if(fichero && !soloXml){
    try{ adj = await soivreSubirFichero(idMensaje, fichero); }
    catch(err){ return { ok:false, error: err.message + '. No se ha enviado nada.' }; }
  }
  const { data: fila, error } = await sbT().from('soivre_cola').insert({
    servicio, entorno: e.entorno || 'pruebas', id_mensaje: idMensaje, solo_xml: !!soloXml,
    datos, contexto: contexto || {},
    adjunto: adj && adj.ruta, adjunto_nombre: adj && adj.nombre,
    usuario: (window.PortalGuard && PortalGuard.CU && PortalGuard.CU.nombre) || null
  }).select('id').single();
  if(error) return { ok:false, error:'No se pudo encolar en Supabase: ' + error.message + '. No se ha enviado nada.' };

  const limite = Date.now() + 120000;
  let r = null;
  while(Date.now() < limite){
    await new Promise(res => setTimeout(res, 1500));
    const { data } = await sbT().from('soivre_cola').select('*').eq('id', fila.id).maybeSingle();
    if(data && !['pendiente','procesando'].includes(data.estado)){ r = data; break; }
  }
  if(!r) return { ok:false, pendiente:true,
    error:'El servidor no ha respondido en 2 minutos. La petición sigue en cola: si el servidor la procesa más tarde, la AEAT la recibirá. Comprueba en ESTACICE antes de reintentar.' };

  sbT().from('soivre_cola').delete().eq('id', r.id).then(() => {});
  return {
    ok: r.estado === 'aceptada' || r.estado === 'generado',
    validacion: r.codigo_respuesta === 'VALID', errores: r.errores || [],
    fault: r.estado === 'error', codigo: r.codigo_respuesta, descripcion: r.descripcion_respuesta,
    numeroSolicitud: r.numero_solicitud, xmlEnviado: r.xml_enviado, xmlRespuesta: r.xml_respuesta,
    estado: r.estado,
    adjuntoEstado: r.adjunto_estado, adjuntoCsv: r.adjunto_csv, adjuntoDescripcion: r.adjunto_descripcion,
    resultado: r.resultado || null
  };
}

function soivreChipEntorno(e){
  if(!e || !e.ok) return '<span class="badge" style="background:var(--rd50);color:var(--rd600)">Servidor SOIVRE sin conexión</span>';
  if(e.simulacion) return '<span class="badge" style="background:var(--g100);color:var(--g600)">SIMULACIÓN</span>';
  return e.entorno === 'produccion'
    ? '<span class="badge" style="background:var(--rd50);color:var(--rd600);font-weight:800">⚠️ PRODUCCIÓN</span>'
    : '<span class="badge" style="background:var(--am50);color:var(--am600);font-weight:800">PRUEBAS · prewww1</span>';
}

function soivrePintarEstado(){
  const el = document.getElementById('soivre-estado');
  if(!el) return;
  const e = SOIVRE.estado;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${soivreChipEntorno(e)}
      ${e && e.ok
        ? `<span style="font-size:12px;color:var(--g600)">Servidor <strong>${sEsc(e.servidor)}</strong> · certificado <strong>${sEsc(e.titular)}</strong>${e.caduca ? ' · caduca ' + sEsc(e.caduca) : ''}</span>`
        : `<span style="font-size:12px;color:var(--g500)">${sEsc(e && e.error || '')} — revisa que soivre_pue.py esté en marcha en el servidor AEAT Monitor.</span>`}
      <button class="btn btn-s btn-sm" onclick="soivreComprobarServidor()">↻ Comprobar</button>
    </div>`;
}

function soivreActualizarEntornoModal(){
  const el = document.getElementById('soivre-entorno-modal');
  if(el) el.innerHTML = soivreChipEntorno(SOIVRE.estado);
}

// ── catálogos en Supabase ────────────────────────────────────
async function soivreProductosDe(certificado, codigoTaric){
  const p4 = String(codigoTaric || '').replace(/\D/g, '').substring(0, 4);
  const clave = certificado + p4;
  if(SOIVRE.productos.has(clave)) return SOIVRE.productos.get(clave);
  const { data, error } = await sbT().from('soivre_productos')
    .select('codigo,descripcion').eq('certificado', certificado).eq('partida4', p4).order('codigo');
  if(error) throw error;
  SOIVRE.productos.set(clave, data || []);
  return data || [];
}

async function soivreEnvases(){
  if(SOIVRE.envases) return SOIVRE.envases;
  const { data, error } = await sbT().from('soivre_envases').select('codigo,descripcion').order('descripcion');
  if(error) throw error;
  return (SOIVRE.envases = data || []);
}

// ── modal propio (inyección dinámica, sin display:none) ─────
function soivreModal(titulo, html, ancho = 720){
  soivreCerrarModal();
  const d = document.createElement('div');
  d.id = 'soivre-modal';
  d.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto';
  d.innerHTML = `
    <div class="card" style="max-width:${ancho}px;width:100%;padding:18px 20px;background:var(--w,#fff);box-shadow:0 20px 50px rgba(0,0,0,.25)" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px">
        <div style="font-size:15px;font-weight:700">${titulo}</div>
        <button onclick="soivreCerrarModal()" style="border:0;background:none;cursor:pointer;font-size:16px;color:var(--g400)">✕</button>
      </div>
      <div id="soivre-modal-body">${html}</div>
    </div>`;
  d.onclick = soivreCerrarModal;
  document.body.appendChild(d);
}
function soivreCerrarModal(){ document.getElementById('soivre-modal')?.remove(); }

const sLbl = t => `<label style="font-size:11px;font-weight:700;color:var(--g500);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px">${t}</label>`;
const sCampo = (lbl, inner) => `<div>${sLbl(lbl)}${inner}</div>`;
const sInput = (id, v = '', extra = '') => `<input id="${id}" class="fi" style="width:100%" value="${sEsc(v)}" ${extra}>`;
// Las listas de códigos van en orden numérico: JS enumera antes las claves '10'…'99'
// que las '00'…'09'. Las listas cortas (flujo…) conservan el orden en que se escriben.
const sOpciones = obj => { const e = Object.entries(obj); return e.length > 4 && e.every(([k]) => /^\d+$/.test(k)) ? e.sort(([a],[b]) => a.localeCompare(b)) : e; };
const sSelect = (id, obj, sel) => `<select id="${id}" class="fi" style="width:100%">${sOpciones(obj).map(([k,v]) => `<option value="${k}" ${k===sel?'selected':''}>${k} · ${v}</option>`).join('')}</select>`;
const sMultiSel = (id, obj, sel) => `<select id="${id}" class="fi" multiple size="5" style="width:100%;height:auto">${sOpciones(obj).map(([k,v]) => `<option value="${k}" ${sel.includes(k)?'selected':''}>${k} · ${v}</option>`).join('')}</select><div style="font-size:10px;color:var(--g400);margin-top:2px">Ctrl/Cmd + clic para marcar varias</div>`;
const sGrid = (cols, ...h) => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(${cols}px,1fr));gap:10px;margin-bottom:10px">${h.join('')}</div>`;
const sAviso = t => `<div style="background:var(--rd50);color:var(--rd600);padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px">${t}</div>`;
const SOIVRE_CERT_OPC = { '01':'Declaración normal', '02':'No procede', '03':'Consulta si procede' };
const SOIVRE_TDECL = { '01':'Expediente nuevo', '02':'Relacionado', '03':'Mercancía en demora', '04':'No conformidades', '05':'Revisión conformidad', '06':'Consolidación', '07':'Reactivación', '99':'Otros' };

// Selector de fichero (factura .zip; si no es .zip, el servidor lo comprime)
function soivreCampoFichero(id, etiqueta, obligatorio, previo){
  return `
    <div style="background:var(--b50);border:1px dashed var(--b500);border-radius:8px;padding:10px 12px;margin-bottom:10px">
      ${sLbl(etiqueta + (obligatorio ? ' *' : ''))}
      ${previo ? `<div style="font-size:12px;margin-bottom:6px">📎 <strong>${sEsc(previo.name)}</strong> <span style="color:var(--g500)">(factura leída, ${(previo.size/1048576).toFixed(1)} MB). Se adjunta sola; elige otro fichero solo si quieres sustituirla.</span></div>` : ''}
      <input type="file" id="${id}" accept=".zip,.7z,.pdf,.jpg,.jpeg,.tif,.tiff,.doc,.docx,.xls,.xlsx" style="font-size:12px;width:100%">
      <div style="font-size:11px;color:var(--g500);margin-top:4px">Se envía a la AEAT en <strong>.zip</strong> (PUE-7). Si eliges un PDF u otro formato, el servidor lo comprime. Máx. 10 MB.</div>
    </div>`;
}

function soivreComprobarFichero(f, obligatorio){
  if(!f) return obligatorio ? ['Adjunta la factura comercial (.zip)'] : [];
  if(f.size > SOIVRE_MAX_FICHERO) return [`El fichero pesa ${(f.size/1048576).toFixed(1)} MB (máx. 10 MB)`];
  if(!/\.(zip|7z|pdf|jpe?g|tiff?|docx?|xlsx?)$/i.test(f.name)) return ['Formato de fichero no admitido por la AEAT'];
  return [];
}

// Bloque común a CAL1, ROHS1 y COM1 (declaración, cantidades, inspección)
function soivreCamposComunes(ctx, cfg, unidadHtml){
  return `
    ${sGrid(160,
      sCampo('Documento', sSelect('sv-tipodoc', { DUA:'DUA/DUE', DVD:'DVD' }, 'DUA')),
      sCampo('Operación', sSelect('sv-op', { ALT:'Alta', MOD:'Modificación' }, 'ALT')),
      sCampo(ctx.servicio === 'CAL1' && ctx.flujo !== '01' ? 'MRN de la declaración o predeclaración B1' : 'MRN de la declaración (18)', sInput('sv-mrn', (ctx.grupo && SOIVRE.mrnGrupo[ctx.grupo]) || '', 'placeholder="26ES00110010000001" maxlength="23" oninput="this.value=this.value.toUpperCase()" style="width:100%;font-family:var(--mono)"')),
      sCampo('Nº partida', sInput('sv-partida', ctx.partida || '1', 'type="number" min="1" max="99999"'))
    )}
    ${sGrid(160,
      sCampo('Unidad', unidadHtml),
      sCampo('Cantidad', sInput('sv-cant', ctx.cantidad || '', 'inputmode="decimal"')),
      sCampo('Tipo declaración', sSelect('sv-tdecl', SOIVRE_TDECL, '01'))
    )}
    ${sGrid(140,
      sCampo('Cód. CICE', sInput('sv-cice', cfg.codCice, 'maxlength="2" placeholder="2 dígitos"')),
      sCampo('Cód. puesto insp.', sInput('sv-pi', cfg.codPI, 'maxlength="2" placeholder="2 dígitos"')),
      sCampo('Email de avisos', sInput('sv-email', cfg.email || (window.PortalGuard && PortalGuard.CU && PortalGuard.CU.email) || '', 'maxlength="40"'))
    )}
    <details style="margin-bottom:10px" ${ctx.flujo === '03' ? 'open' : ''}>
      <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--g600)">Expediente precedente ${ctx.flujo === '03' ? '(reexportación: declaración de entrada, si procede)' : '(solo si procede)'}</summary>
      <div style="height:8px"></div>
      ${sGrid(200,
        sCampo('MRN-partida precedente', sInput('sv-mrnprec', '', 'maxlength="23"')),
        sCampo('Id solicitud SOIVRE precedente', sInput('sv-solprec', '', 'maxlength="20"'))
      )}
    </details>`;
}

function soivreDatosComunes(){
  return {
    tipoOperacion: sVal('sv-op'), tipoDocumento: sVal('sv-tipodoc'),
    mrn: sVal('sv-mrn'), partida: sVal('sv-partida'),
    unidad: sVal('sv-unidad'), cantidad: sVal('sv-cant'),
    mrnPrecedente: sVal('sv-mrnprec'), idSolSoivrePrecedente: sVal('sv-solprec'),
    codCice: sVal('sv-cice'), codPI: sVal('sv-pi'), email: sVal('sv-email'),
    tipoDeclaracion: sVal('sv-tdecl')
  };
}

// Certificados ROHS / RAEE y registros RII (ROHS1 y COM1)
function soivreCamposAEE(cfg){
  return sGrid(150,
    sCampo('Certificado ROHS', sSelect('sv-cert-rohs', SOIVRE_CERT_OPC, '01')),
    sCampo('Certificado RAEE', sSelect('sv-cert-raee', SOIVRE_CERT_OPC, '01')),
    sCampo('Nº RII RAEE', sInput('sv-raee', cfg.codigoRaee, 'maxlength="6" placeholder="Registro del importador"')),
    sCampo('Nº registro pilas (PyA)', sInput('sv-pya', cfg.codigoPya, 'maxlength="20"'))
  );
}

function soivreBotonera(k){
  return `
    <div id="sv-errores"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid var(--g100);padding-top:12px">
      <button class="btn btn-s btn-sm" onclick="soivreCerrarModal()">Cancelar</button>
      <button class="btn btn-s btn-sm" onclick="soivreEnviarSolicitud('${k}', true)">👁 Ver XML</button>
      <button class="btn btn-p" id="sv-enviar" onclick="soivreEnviarSolicitud('${k}', false)">Enviar solicitud</button>
    </div>`;
}

// ── formularios de alta (CAL1 / ROHS1 / COM1) ────────────────
async function abrirSolicitudSoivre(k){
  const ctx = SOIVRE.ctx.get(k) || {};
  const servicio = ctx.servicio || 'CAL1';
  const s = SOIVRE_SERVICIOS[servicio];
  const cfg = soivreCfg();
  soivreModal(`${s.icono} Solicitud de control SOIVRE · ${servicio}`, '<div class="loading-wrap"><div class="spinner"></div><span>Cargando catálogos SOIVRE…</span></div>');
  soivreComprobarServidor();

  let cuerpo = '';
  try{ cuerpo = await (servicio === 'CAL1' ? soivreFormCAL1 : servicio === 'ROHS1' ? soivreFormROHS1 : soivreFormCOM1)(ctx, cfg); }
  catch(e){ cuerpo = sAviso(`No se pudieron leer los catálogos SOIVRE de Supabase (${sEsc(e.message)}). ¿Se ha ejecutado instalar_soivre.sql?`); }

  document.getElementById('soivre-modal-body').innerHTML = `
    <div id="soivre-entorno-modal" style="margin-bottom:10px">${soivreChipEntorno(SOIVRE.estado)}</div>
    <div style="background:var(--g50);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:var(--g600)">
      <strong style="font-family:var(--mono)">${sEsc(ctx.codigo_taric || '—')}</strong> · ${sEsc(ctx.descripcion || '')}
      ${ctx.medidas && ctx.medidas.length ? `<div style="margin-top:3px;font-size:11px;color:var(--g500)">Medidas TARIC: ${sEsc(ctx.medidas.join(', '))}</div>` : ''}
    </div>
    ${cuerpo}
    ${soivreCampoFichero('sv-factura', 'Factura comercial', true, ctx.archivo)}
    ${soivreBotonera(k)}`;
}

async function soivreFormCAL1(ctx, cfg){
  let productos = [], envases = [], aviso = '';
  try{ [productos, envases] = await Promise.all([soivreProductosDe('CAL', ctx.codigo_taric), soivreEnvases()]); }
  catch(e){ aviso = sAviso(`Catálogos SOIVRE no disponibles (${sEsc(e.message)}). ¿Se ha ejecutado instalar_soivre.sql?`); }
  const grupoDef = productos.length && productos.every(p => /industrial/i.test(p.descripcion)) ? '02' : '01';
  const unidad = envases.length
    ? `<select id="sv-unidad" class="fi" style="width:100%">${envases.map(e => {
        const v = e.descripcion;   // la AEAT espera la unidad en texto (CAJAS), no el código
        const sel = ctx.unidad && new RegExp('^' + e.descripcion.slice(0,3), 'i').test(ctx.unidad) ? 'selected' : '';
        return `<option value="${sEsc(v)}" ${sel}>${sEsc(e.descripcion)} (${sEsc(e.codigo)})</option>`;
      }).join('')}</select>`
    : sInput('sv-unidad', ctx.unidad || '');
  const env = cfg.envasador || {};
  // Origen: el de la línea de factura; en búsqueda libre, el país elegido en preferencias o España
  const origen = ctx.origen || document.getElementById('spg-pais')?.value || (typeof ORIGEN_POR_DEFECTO !== 'undefined' ? ORIGEN_POR_DEFECTO : 'ES');
  ctx.flujo = soivreFlujoPorOrigen(origen, ctx.flujo);
  return `${aviso}
    ${sGrid(160,
      sCampo('País de origen', sInput('sv-origen', origen, `maxlength="2" style="width:100%;font-family:var(--mono)" title="España → exportación · otro país → reexportación"
        oninput="this.value=this.value.toUpperCase();const f=document.getElementById('sv-flujo');if(f&&f.value!=='01'&&this.value.length===2)f.value=soivreFlujoPorOrigen(this.value,'')"`)),
      sCampo('Flujo', sSelect('sv-flujo', { '02':'Exportación', '03':'Reexportación', '01':'Importación' }, ctx.flujo)),
      sCampo('Grupo producto', sSelect('sv-grupo', { '01':'F&H frescas', '02':'F&H uso industrial', '03':'Otros' }, grupoDef)),
      sCampo('Categoría', sSelect('sv-cat', { '01':'Extra', '02':'I', '03':'II', '04':'N/A' }, '02')),
      sCampo('Envase > 5 kg', sSelect('sv-env5', { Si:'Sí', No:'No' }, 'Si'))
    )}
    ${sCampo('Producto SOIVRE', productos.length
        ? `<select id="sv-producto" class="fi" style="width:100%">${productos.map(p => `<option value="${sEsc(p.codigo)}">${sEsc(p.codigo)} · ${sEsc(p.descripcion)}</option>`).join('')}</select>`
        : sInput('sv-producto', '', 'placeholder="Código SOIVRE de calidad"'))}
    <div style="height:10px"></div>
    ${soivreCamposComunes(ctx, cfg, unidad)}
    ${sGrid(200, sCampo('Certificado solicitado', sSelect('sv-certsol', SOIVRE_CERT_OPC, '01')))}
    <details style="margin-bottom:10px" ${env.nif ? '' : 'open'}>
      <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--g600)">Envasador</summary>
      <div style="height:8px"></div>
      ${sGrid(140,
        sCampo('NIF', sInput('sv-env-nif', env.nif, 'maxlength="17"')),
        sCampo('Nombre', sInput('sv-env-nom', env.nombre, 'maxlength="35"')),
        sCampo('Localidad', sInput('sv-env-loc', env.localidad, 'maxlength="35"')),
        sCampo('Provincia', sInput('sv-env-prov', env.provincia, 'maxlength="35"')),
        sCampo('País', sInput('sv-env-pais', env.pais || 'ES', 'maxlength="2"'))
      )}
      <label style="font-size:11px;color:var(--g500)"><input type="checkbox" id="sv-env-guardar"> Recordar como envasador habitual</label>
    </details>`;
}

function soivreSelectUnidadAEE(ctx){
  return `<select id="sv-unidad" class="fi" style="width:100%">${SOIVRE_UNIDADES_AEE.map(u => {
    const sel = ctx.unidad && /par/i.test(ctx.unidad) ? u === 'PARES' : u === 'UNIDADES FÍSICAS';
    return `<option ${sel ? 'selected' : ''}>${u}</option>`;
  }).join('')}</select>`;
}

async function soivreFormROHS1(ctx, cfg){
  return `
    ${sCampo('Especificidades', sMultiSel('sv-espec', SOIVRE_ESPEC_ROHS, ['01']))}
    <div style="height:10px"></div>
    ${soivreCamposComunes(ctx, cfg, soivreSelectUnidadAEE(ctx))}
    ${soivreCamposAEE(cfg)}
    ${sGrid(200, sCampo('Referencia DOCUCICE (obligatoria en PDI, DVD y sumaria)', sInput('sv-docucice', '', 'placeholder="Separar varias con comas"')))}`;
}

async function soivreFormCOM1(ctx, cfg){
  let productos = [], aviso = '';
  try{ productos = await soivreProductosDe('COM', ctx.codigo_taric); }
  catch(e){ aviso = sAviso(`Catálogo SOIVRE no disponible (${sEsc(e.message)}). ¿Se ha ejecutado instalar_soivre.sql?`); }
  const c10 = String(ctx.codigo_taric || '').replace(/\D/g, '');
  return `${aviso}
    ${sCampo('Producto SOIVRE industrial', productos.length
        ? `<select id="sv-producto" class="fi" style="width:100%">${productos.map(p => `<option value="${sEsc(p.codigo)}" ${p.codigo === c10 ? 'selected' : ''}>${sEsc(p.codigo)} · ${sEsc(p.descripcion.slice(0,110))}</option>`).join('')}</select>`
        : sInput('sv-producto', c10, 'placeholder="Código SOIVRE industrial (10 dígitos)"'))}
    <div style="height:10px"></div>
    ${sCampo('Especificidades', sMultiSel('sv-espec', SOIVRE_ESPEC_COM, ['00']))}
    <div style="height:10px"></div>
    ${soivreCamposComunes(ctx, cfg, soivreSelectUnidadAEE(ctx))}
    ${sGrid(200, sCampo('Certificado COM', sSelect('sv-cert-com', SOIVRE_CERT_OPC, '01')))}
    ${soivreCamposAEE(cfg)}
    ${sGrid(200, sCampo('Referencia DOCUCICE (opcional)', sInput('sv-docucice', '', 'placeholder="Separar varias con comas"')))}`;
}

function soivreDatosSolicitud(servicio){
  const d = soivreDatosComunes();
  if(servicio === 'CAL1') return { ...d,
    flujo: sVal('sv-flujo'), grupoProducto: sVal('sv-grupo'), especificidades: ['01'],
    certificadoSolicitado: sVal('sv-certsol'), codigoSoivre: sVal('sv-producto'),
    categoria: sVal('sv-cat'), envaseMas5kg: sVal('sv-env5'),
    envasador: { nif: sVal('sv-env-nif'), nombre: sVal('sv-env-nom'), localidad: sVal('sv-env-loc'),
                 provincia: sVal('sv-env-prov'), pais: sVal('sv-env-pais') }
  };
  const aee = { certificadoRohs: sVal('sv-cert-rohs'), certificadoRaee: sVal('sv-cert-raee'),
                codigoRaee: sVal('sv-raee'), codigoPya: sVal('sv-pya'),
                especificidades: sMulti('sv-espec'), referenciaDocucice: sVal('sv-docucice') };
  if(servicio === 'ROHS1') return { ...d, ...aee };
  return { ...d, ...aee, codigoSoivre: sVal('sv-producto'), certificadoCom: sVal('sv-cert-com') };
}

function soivreMostrarErrores(lista){
  const el = document.getElementById('sv-errores');
  if(el) el.innerHTML = lista && lista.length
    ? `<div style="background:var(--rd50);color:var(--rd600);border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:10px">${lista.map(e => '• ' + sEsc(e)).join('<br>')}</div>` : '';
}

function soivreIdMensaje(tipo){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${tipo}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}

async function soivreEnviarSolicitud(k, soloXml){
  const ctx = SOIVRE.ctx.get(k) || {};
  const servicio = ctx.servicio || 'CAL1';
  const datos = soivreDatosSolicitud(servicio);
  if(ctx.factura) datos.factura = ctx.factura;   // solo para precargar los datos adicionales; no viaja en el XML
  const fichero = sFichero('sv-factura') || ctx.archivo || null;
  if(ctx.grupo && datos.mrn) SOIVRE.mrnGrupo[ctx.grupo] = datos.mrn.slice(0, 18);
  // Recordar valores habituales en este navegador
  const cfg = soivreCfg();
  cfg.codCice = datos.codCice; cfg.codPI = datos.codPI; cfg.email = datos.email;
  if(datos.codigoRaee !== undefined){ cfg.codigoRaee = datos.codigoRaee; cfg.codigoPya = datos.codigoPya; }
  if(document.getElementById('sv-env-guardar')?.checked) cfg.envasador = datos.envasador;
  soivreGuardarCfg(cfg);

  const e = await soivreComprobarServidor();
  if(!e.ok) return soivreMostrarErrores([e.error || 'Servidor SOIVRE sin conexión']);

  if(soloXml){
    soivreMostrarErrores(['Generando XML en el servidor…']);
    const r = await soivreLlamar(servicio, datos, soivreIdMensaje('XML'), true);
    if(!r.ok) return soivreMostrarErrores(r.validacion ? r.errores : [r.error || r.descripcion]);
    soivreMostrarErrores([]);
    return soivreVerXml(`XML ${servicio} (no enviado)`, r.xmlEnviado);
  }
  const errFich = soivreComprobarFichero(fichero, true);
  if(errFich.length) return soivreMostrarErrores(errFich);
  if(e.entorno === 'produccion' && !e.simulacion &&
     !confirm(`Vas a enviar una solicitud ${servicio} REAL a la AEAT (producción) firmada con ${e.titular}, con la factura ${fichero.name}. ¿Continuar?`)) return;

  await soivreEnviar(servicio, datos, {
    codigo_taric: ctx.codigo_taric, descripcion: ctx.descripcion, ctxKey: k,
    mrn_partida: (datos.mrn.length === 23 ? datos.mrn : datos.mrn + String(parseInt(datos.partida,10)||0).padStart(5,'0'))
  }, null, fichero);
}

// Envío común. El Id del mensaje se conserva en memoria: «Reintentar» reenvía
// con el mismo Id y la AEAT devuelve la respuesta original en vez de duplicar.
async function soivreEnviar(tipo, datos, extra, previo, fichero){
  const btn = document.getElementById('sv-enviar');
  const txtBtn = btn && btn.textContent;
  if(btn){ btn.disabled = true; btn.textContent = fichero ? 'Subiendo factura y enviando…' : 'Enviando…'; }
  const e = SOIVRE.estado || {};
  const env = previo || {
    n: SOIVRE.sesion.length + 1, tipo, datos, ...extra, fichero,
    idMensaje: soivreIdMensaje(tipo), entorno: e.entorno || 'pruebas', simulacion: !!e.simulacion
  };

  let r;
  try{ r = await soivreLlamar(tipo, env.datos, env.idMensaje, false,
                              { codigo_taric: env.codigo_taric, descripcion: env.descripcion }, env.fichero); }
  catch(err){ r = { ok:false, error:'Sin conexión con Supabase: ' + err.message }; }

  if(r.validacion){
    if(btn){ btn.disabled = false; btn.textContent = txtBtn; }
    return soivreMostrarErrores(r.errores);
  }

  Object.assign(env, {
    fecha: new Date(),
    estado: r.ok ? 'aceptada' : r.pendiente ? 'en cola' : (r.estado === 'rechazada' ? 'rechazada' : 'error'),
    numeroSolicitud: r.numeroSolicitud || env.numeroSolicitud || null,
    codigo: r.codigo || null, descripcionRespuesta: r.descripcion || r.error || null,
    xmlEnviado: r.xmlEnviado || null, xmlRespuesta: r.xmlRespuesta || null,
    adjuntoEstado: r.adjuntoEstado || null, adjuntoCsv: r.adjuntoCsv || null, adjuntoDescripcion: r.adjuntoDescripcion || null
  });
  if(!previo) SOIVRE.sesion.unshift(env);
  soivreResultado(env);
  soivrePanelFacturaRefrescar();
  if(document.getElementById('view-soivre')?.classList.contains('active')) soivrePintarSesion();
}

function soivreResultado(env){
  const tipo = env.tipo;
  const alta = SOIVRE_SERVICIOS[tipo];
  const facturaOk = env.adjuntoEstado === 'aceptada';
  const filaFactura = env.fichero && tipo !== 'PUE7' ? `
      <tr><td style="color:var(--g500);padding:4px 0;vertical-align:top">Factura (PUE-7)</td><td>
        <span class="badge" style="${facturaOk ? SOIVRE_ESTADO_ESTILO.aceptada : SOIVRE_ESTADO_ESTILO.error}">${sEsc(env.adjuntoEstado || 'sin enviar')}</span>
        ${env.adjuntoCsv ? ` CSV <strong style="font-family:var(--mono)">${sEsc(env.adjuntoCsv)}</strong>` : ''}
        ${!facturaOk && env.adjuntoDescripcion ? `<div style="font-size:11px;color:var(--g500)">${sEsc(env.adjuntoDescripcion)}</div>` : ''}
      </td></tr>` : '';
  const filaCsv = tipo === 'PUE7' && env.adjuntoCsv
    ? `<tr><td style="color:var(--g500);padding:4px 0">CSV documento</td><td style="font-family:var(--mono);font-weight:700">${sEsc(env.adjuntoCsv)}</td></tr>` : '';

  soivreModal(env.estado === 'aceptada' ? (env.fichero && tipo !== 'PUE7' && !facturaOk ? '⚠️ Solicitud aceptada · factura pendiente' : '✅ Envío aceptado')
              : env.estado === 'rechazada' ? '❌ Envío rechazado' : env.estado === 'en cola' ? '⏳ Sin respuesta todavía' : '⚠️ Error en el envío', `
    <div style="margin-bottom:10px">${soivreChipEntorno(SOIVRE.estado)}</div>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="color:var(--g500);padding:4px 0;width:170px">Servicio</td><td><strong>${tipo}</strong></td></tr>
      ${env.numeroSolicitud ? `<tr><td style="color:var(--g500);padding:4px 0">Nº solicitud AEAT</td><td style="font-family:var(--mono);font-weight:700">${sEsc(env.numeroSolicitud)} <button onclick="copiarTexto(this,'${sEsc(env.numeroSolicitud)}')" style="border:0;background:none;cursor:pointer" title="Copiar">📋</button></td></tr>` : ''}
      <tr><td style="color:var(--g500);padding:4px 0">Código respuesta</td><td style="font-family:var(--mono)">${sEsc(env.codigo || '—')}</td></tr>
      <tr><td style="color:var(--g500);padding:4px 0;vertical-align:top">Descripción</td><td>${sEsc(env.descripcionRespuesta || '—')}</td></tr>
      ${filaFactura}${filaCsv}
      <tr><td style="color:var(--g500);padding:4px 0">Id mensaje</td><td style="font-family:var(--mono);font-size:11px">${sEsc(env.idMensaje)}</td></tr>
    </table>
    <div style="font-size:11px;color:var(--g500);margin-top:10px">${env.estado === 'error'
      ? 'Reintentar reenvía con el mismo Id, así la AEAT no duplica la solicitud.'
      : 'El seguimiento queda en ESTACICE. Anota el nº de solicitud por si SOIVRE pide datos o documentos adicionales.'}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px">
      ${env.xmlEnviado ? `<button class="btn btn-s btn-sm" onclick="soivreVerEnvio(${env.n})">Ver XML</button>` : ''}
      ${env.estado === 'error' ? `<button class="btn btn-s btn-sm" onclick="soivreReintentar(${env.n})">↻ Reintentar</button>` : ''}
      ${alta && env.estado === 'aceptada' && env.numeroSolicitud && !facturaOk ? `<button class="btn btn-p btn-sm" onclick="abrirEnvioDocumento('${alta.siglas}','${sEsc(env.numeroSolicitud)}','FACTU')">Reenviar factura</button>` : ''}
      ${alta && env.estado === 'aceptada' && env.numeroSolicitud ? `<button class="btn btn-s btn-sm" onclick="abrirDatosAdicionales('${alta.adicional}','${sEsc(env.numeroSolicitud)}')">+ Datos adicionales</button>` : ''}
      <button class="btn btn-p btn-sm" onclick="soivreCerrarModal()">Cerrar</button>
    </div>`, 560);
}

const soivreEnvio = n => SOIVRE.sesion.find(x => x.n === n);

// ── datos adicionales: CAL3 / ROHS3 / COM3 ───────────────────
function abrirDatosAdicionales(servicio = 'CAL3', numeroSolicitud = ''){
  const origen = SOIVRE.sesion.find(x => x.numeroSolicitud === numeroSolicitud && SOIVRE_SERVICIOS[x.tipo]?.adicional === servicio);
  const factura = (origen && origen.datos.factura) || '';
  soivreComprobarServidor();
  const fabricante = sGrid(140,
    sCampo('NIF fabricante', sInput('c3-f-nif', '', 'maxlength="17"')), sCampo('Nombre fabricante', sInput('c3-f-nom', '', 'maxlength="35"')),
    sCampo('Localidad', sInput('c3-f-loc', '', 'maxlength="35"')), sCampo('País', sInput('c3-f-pais', '', 'maxlength="250"'))
  );
  const especificos = servicio === 'CAL3' ? `
    ${sGrid(160, sCampo('Marca', sInput('c3-marca', '', 'maxlength="35"')), sCampo('Lote', sInput('c3-lote', '', 'maxlength="35"')), sCampo('Nº factura', sInput('c3-fact', factura, 'maxlength="35"')))}
    <details style="margin-bottom:10px"><summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--g600)">Transformador (opcional)</summary><div style="height:8px"></div>
      ${sGrid(140,
        sCampo('Nombre', sInput('c3-t-nom', '', 'maxlength="35"')), sCampo('NIF', sInput('c3-t-nif', '', 'maxlength="17"')),
        sCampo('Dirección', sInput('c3-t-dir', '', 'maxlength="35"')), sCampo('Localidad', sInput('c3-t-loc', '', 'maxlength="35"')),
        sCampo('CP', sInput('c3-t-cp', '', 'maxlength="9"')), sCampo('País', sInput('c3-t-pais', 'ES', 'maxlength="2"'))
      )}
    </details>` : `
    ${fabricante}
    ${sCampo('Localización adicional de la mercancía', sInput('c3-locad', '', 'maxlength="250" placeholder="Almacén, muelle, dirección…"'))}
    <div style="height:10px"></div>
    ${sGrid(140, sCampo('Marca', sInput('c3-marca', '', 'maxlength="35"')), sCampo('Modelo', sInput('c3-modelo', '', 'maxlength="35"')),
                 sCampo('Lote', sInput('c3-lote', '', 'maxlength="35"')), sCampo('Nº factura', sInput('c3-fact', factura, 'maxlength="35"')))}`;

  soivreModal(`Datos adicionales · ${servicio}`, `
    <div id="soivre-entorno-modal" style="margin-bottom:10px">${soivreChipEntorno(SOIVRE.estado)}</div>
    <div style="font-size:12px;color:var(--g600);margin-bottom:12px">Solo cuando SOIVRE los pide (filtro naranja o rojo).</div>
    ${sGrid(160,
      sCampo('Servicio', `<select id="c3-serv" class="fi" style="width:100%" onchange="abrirDatosAdicionales(this.value, document.getElementById('c3-sol').value)">${['CAL3','ROHS3','COM3'].map(x => `<option ${x===servicio?'selected':''}>${x}</option>`).join('')}</select>`),
      sCampo('Nº solicitud AEAT', sInput('c3-sol', numeroSolicitud, 'maxlength="16" style="width:100%;font-family:var(--mono)"'))
    )}
    ${especificos}
    <div id="sv-errores"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--g100);padding-top:12px">
      <button class="btn btn-s btn-sm" onclick="soivreCerrarModal()">Cancelar</button>
      <button class="btn btn-p" id="sv-enviar" onclick="soivreEnviarAdicionales('${servicio}')">Enviar</button>
    </div>`, 660);
}

async function soivreEnviarAdicionales(servicio){
  const idSolAEAT = sVal('c3-sol');
  const datos = servicio === 'CAL3' ? {
    idSolAEAT, marca: sVal('c3-marca'), lote: sVal('c3-lote'), numFactura: sVal('c3-fact'),
    transformador: { nombre: sVal('c3-t-nom'), nif: sVal('c3-t-nif'), direccion: sVal('c3-t-dir'),
                     localidad: sVal('c3-t-loc'), cp: sVal('c3-t-cp'), pais: sVal('c3-t-pais') }
  } : {
    idSolAEAT, locAdicional: sVal('c3-locad'), marca: sVal('c3-marca'), modelo: sVal('c3-modelo'),
    lote: sVal('c3-lote'), numFactura: sVal('c3-fact'),
    fabricante: { nif: sVal('c3-f-nif'), nombre: sVal('c3-f-nom'), localidad: sVal('c3-f-loc'), pais: sVal('c3-f-pais') }
  };
  const e = await soivreComprobarServidor();
  if(!e.ok) return soivreMostrarErrores([e.error || 'Servidor SOIVRE sin conexión']);
  if(e.entorno === 'produccion' && !e.simulacion && !confirm(`Envío ${servicio} REAL a la AEAT (producción) firmado con ${e.titular}. ¿Continuar?`)) return;
  const origen = SOIVRE.sesion.find(x => x.numeroSolicitud === idSolAEAT);
  await soivreEnviar(servicio, datos, {
    codigo_taric: origen && origen.codigo_taric, descripcion: origen && origen.descripcion,
    mrn_partida: origen && origen.mrn_partida, numeroSolicitud: idSolAEAT
  });
}

// ── documento suelto (PUE-7) a una solicitud existente ───────
function abrirEnvioDocumento(siglas = 'CAL', numeroSolicitud = '', tipoDoc = 'FACTU'){
  soivreComprobarServidor();
  soivreModal('📎 Enviar documento · PUE-7', `
    <div id="soivre-entorno-modal" style="margin-bottom:10px">${soivreChipEntorno(SOIVRE.estado)}</div>
    <div style="font-size:12px;color:var(--g600);margin-bottom:12px">Adjunta un documento a una solicitud ya dada de alta (por ejemplo, cuando SOIVRE pide más documentación).</div>
    ${sGrid(160,
      sCampo('Tipo de solicitud', sSelect('d7-siglas', { CAL:'Calidad', ROHS:'ROHS/RAEE', COM:'Industriales' }, siglas)),
      sCampo('Nº solicitud AEAT', sInput('d7-sol', numeroSolicitud, 'maxlength="35" style="width:100%;font-family:var(--mono)"'))
    )}
    ${sGrid(160,
      sCampo('Tipo de documento', sSelect('d7-tipo', SOIVRE_TIPO_DOC, tipoDoc)),
      sCampo('Descripción', sInput('d7-desc', tipoDoc === 'FACTU' ? 'Factura comercial' : '', 'maxlength="35"'))
    )}
    ${soivreCampoFichero('d7-fichero', 'Fichero', true)}
    <div id="sv-errores"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--g100);padding-top:12px">
      <button class="btn btn-s btn-sm" onclick="soivreCerrarModal()">Cancelar</button>
      <button class="btn btn-p" id="sv-enviar" onclick="soivreEnviarDocumento()">Enviar documento</button>
    </div>`, 620);
}

async function soivreEnviarDocumento(){
  const fichero = sFichero('d7-fichero');
  const datos = { operacion:'01', docuCertiAutoriz: sVal('d7-siglas'), referenciaSolicitud: sVal('d7-sol'),
                  tipoDocumento: sVal('d7-tipo'), descripcion: sVal('d7-desc') };
  const err = soivreComprobarFichero(fichero, true);
  if(!datos.referenciaSolicitud) err.push('Indica el nº de solicitud AEAT');
  if(!datos.descripcion) err.push('Indica una descripción');
  if(err.length) return soivreMostrarErrores(err);
  const e = await soivreComprobarServidor();
  if(!e.ok) return soivreMostrarErrores([e.error || 'Servidor SOIVRE sin conexión']);
  if(e.entorno === 'produccion' && !e.simulacion && !confirm(`Envío PUE-7 REAL a la AEAT (producción) firmado con ${e.titular}. ¿Continuar?`)) return;
  const origen = SOIVRE.sesion.find(x => x.numeroSolicitud === datos.referenciaSolicitud);
  await soivreEnviar('PUE7', datos, {
    codigo_taric: origen && origen.codigo_taric, descripcion: datos.descripcion,
    mrn_partida: origen && origen.mrn_partida, numeroSolicitud: datos.referenciaSolicitud
  }, null, fichero);
}

async function soivreReintentar(n){
  const env = soivreEnvio(n);
  if(!env) return;
  const e = await soivreComprobarServidor();
  if(!e.ok) return showToast('Servidor SOIVRE sin conexión');
  if((e.entorno || 'pruebas') !== env.entorno || !!e.simulacion !== !!env.simulacion)
    return showToast('El servidor está en un entorno distinto al del envío original');
  soivreModal('Reintentando…', '<div class="loading-wrap"><div class="spinner"></div><span>Reenviando con el mismo Id…</span></div><div id="sv-errores"></div>', 420);
  await soivreEnviar(env.tipo, env.datos, {}, env);
}

// ── vista SOIVRE: servidor, valores por defecto y envíos de esta sesión ──
function soivreIrAVista(){ nav('soivre', document.querySelector('.nav-item[data-view="soivre"]')); }

const SOIVRE_ESTADO_ESTILO = {
  aceptada:  'background:var(--gr50);color:var(--gr700)',
  rechazada: 'background:var(--rd50);color:var(--rd600)',
  error:     'background:var(--am50);color:var(--am600)',
  'en cola': 'background:var(--b50);color:var(--b700)'
};

function loadSoivre(){
  if(typeof vuaPintarSesion === 'function') setTimeout(vuaPintarSesion, 0);
  soivreComprobarServidor();
  const cfg = soivreCfg();
  const cf = document.getElementById('soivre-config');
  if(cf) cf.innerHTML = sGrid(170,
    sCampo('Cód. CICE por defecto', sInput('svc-cice', cfg.codCice, 'maxlength="2"')),
    sCampo('Cód. puesto inspección', sInput('svc-pi', cfg.codPI, 'maxlength="2"')),
    sCampo('Email de avisos', sInput('svc-email', cfg.email, 'maxlength="40"')),
    sCampo('Nº RII RAEE habitual', sInput('svc-raee', cfg.codigoRaee, 'maxlength="6"'))
  ) + (typeof vuaCfg === 'function' ? `<div style="font-size:12px;font-weight:700;color:var(--g600);margin:4px 0 6px">ESTACICE VUA</div>` + sGrid(170,
    sCampo('Centro y punto habitual (4 dígitos)', sInput('svc-vua-cice', vuaCfg().cicePI, 'maxlength="4" placeholder="5801 Algeciras"')),
    sCampo('Aduana habitual', sInput('svc-vua-aduana', vuaCfg().aduana, 'maxlength="4" placeholder="4 dígitos"')),
    sCampo('Gibraltar · centro y punto', sInput('svc-vua-gi-cice', vuaCfg().gibraltar.cicePI, 'maxlength="4"')),
    sCampo('Gibraltar · aduana', sInput('svc-vua-gi-aduana', vuaCfg().gibraltar.aduana, 'maxlength="4"'))
  ) : '') + `<div style="display:flex;justify-content:flex-end"><button class="btn btn-p btn-sm" onclick="soivreGuardarConfigVista()">Guardar</button></div>`;
  soivrePintarSesion();
}

function soivrePintarSesion(){
  const lista = document.getElementById('soivre-lista');
  if(!lista) return;
  if(!SOIVRE.sesion.length){
    lista.innerHTML = '<div style="padding:28px;text-align:center;color:var(--g400);font-size:13px">Sin envíos en esta sesión. Clasifica una mercancía con medida SOVEX, ROHS, RAEE o COM y pulsa «Solicitar control SOIVRE».<br>El histórico de solicitudes está en ESTACICE.</div>';
    return;
  }
  lista.innerHTML = `<div style="overflow-x:auto"><table class="tbl" style="width:100%;font-size:12px">
    <thead><tr><th>Hora</th><th>Servicio</th><th>Entorno</th><th>MRN-partida</th><th>Mercancía</th><th>Estado</th><th>Factura</th><th>Nº solicitud</th><th></th></tr></thead>
    <tbody>${SOIVRE.sesion.map(x => {
      const alta = SOIVRE_SERVICIOS[x.tipo];
      const fact = x.tipo === 'PUE7' ? (x.adjuntoCsv ? 'CSV ' + x.adjuntoCsv : '—')
                 : x.fichero ? (x.adjuntoEstado === 'aceptada' ? '✅ ' + (x.adjuntoCsv || '') : '⚠️ ' + (x.adjuntoEstado || 'sin enviar')) : '—';
      return `<tr>
      <td style="white-space:nowrap">${x.fecha.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })}</td>
      <td><strong>${x.tipo}</strong></td>
      <td>${x.simulacion ? 'Simulación' : (x.entorno === 'produccion' ? '<strong style="color:var(--rd600)">Producción</strong>' : 'Pruebas')}</td>
      <td style="font-family:var(--mono);font-size:11px">${sEsc(x.mrn_partida || '—')}</td>
      <td><span style="font-family:var(--mono)">${sEsc(x.codigo_taric || '')}</span> ${sEsc((x.descripcion || '').slice(0,40))}</td>
      <td><span class="badge" style="${SOIVRE_ESTADO_ESTILO[x.estado] || ''}" title="${sEsc(x.descripcionRespuesta || '')}">${x.estado}</span>${x.codigo && x.codigo !== '0000' ? `<div style="font-size:10px;color:var(--g500);max-width:220px">${sEsc(x.codigo)} · ${sEsc((x.descripcionRespuesta || '').slice(0,90))}</div>` : ''}</td>
      <td style="font-size:11px;font-family:var(--mono)">${sEsc(fact)}</td>
      <td style="font-family:var(--mono);font-weight:700">${sEsc(x.numeroSolicitud || '—')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-s btn-sm" onclick="soivreVerEnvio(${x.n})">XML</button>
        ${alta && x.estado === 'aceptada' && x.numeroSolicitud ? `<button class="btn btn-s btn-sm" onclick="abrirDatosAdicionales('${alta.adicional}','${sEsc(x.numeroSolicitud)}')">+ ${alta.adicional}</button>
          <button class="btn btn-s btn-sm" onclick="abrirEnvioDocumento('${alta.siglas}','${sEsc(x.numeroSolicitud)}','${x.adjuntoEstado === 'aceptada' ? 'OTROS' : 'FACTU'}')">📎</button>` : ''}
        ${x.estado === 'error' ? `<button class="btn btn-s btn-sm" onclick="soivreReintentar(${x.n})" title="Reenvía con el mismo Id de mensaje">↻</button>` : ''}
      </td></tr>`; }).join('')}</tbody></table></div>
    <div style="font-size:11px;color:var(--g400);margin-top:6px">Solo en memoria: se pierde al cerrar la pestaña.</div>`;
}

function soivreGuardarConfigVista(){
  const cfg = soivreCfg();
  cfg.codCice = sVal('svc-cice');
  cfg.codPI = sVal('svc-pi');
  cfg.email = sVal('svc-email');
  cfg.codigoRaee = sVal('svc-raee');
  if(typeof vuaCfg === 'function'){
    const v = vuaCfg();
    v.cicePI = sVal('svc-vua-cice') || v.cicePI; v.aduana = sVal('svc-vua-aduana');
    v.gibraltar = { cicePI: sVal('svc-vua-gi-cice') || '5802', aduana: sVal('svc-vua-gi-aduana') || '1167' };
    cfg.vua = v;
  }
  soivreGuardarCfg(cfg);
  showToast('Valores SOIVRE guardados');
  soivreComprobarServidor();
}

function soivreVerEnvio(n){
  const x = soivreEnvio(n);
  if(x) soivreVerXml(`${x.tipo} · ${x.idMensaje}`, x.xmlEnviado, x.xmlRespuesta);
}

function soivreVerXml(titulo, envio, respuesta){
  const bloque = (t, x) => x ? `<div style="font-size:11px;font-weight:700;color:var(--g500);margin:8px 0 4px">${t}</div><pre style="background:var(--g50);border:1px solid var(--g200);border-radius:6px;padding:10px;font-size:11px;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all">${sEsc(x)}</pre>` : '';
  soivreModal(sEsc(titulo), (bloque('Enviado', envio) + bloque('Respuesta AEAT', respuesta)) || 'Sin XML', 760);
}
