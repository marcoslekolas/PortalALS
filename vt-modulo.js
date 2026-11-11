// ═══════════════════════════════════════════════════════════════════════
// Módulo VisualTrans: un expediente por operación, con todos sus documentos.
// Entra desde una factura leída en el clasificador (con su SOIVRE) o desde la
// consulta de una G4. Cada documento se genera cuando el anterior tiene MRN:
//   factura · exportación a Gibraltar: EX → T2GI
//   factura · terceros a Gibraltar:    H1 → T1GI → (71.00) reexportación
//   factura · resto:                   EX o H1
//   G4 · terceros a Gibraltar:         H1 → T1GI → (71.00) reexportación
//   G4 · T1 (Málaga, Algeciras…):      T1
//   G4 · pertrechos a buque:           EX 31.00 F61
//   DAE de otra aduana (EX ajeno):     T2GI
// ═══════════════════════════════════════════════════════════════════════
const DUA = { x: null, t: null, t1Fichero: null };
const DUA_NOMBRE = { EX: 'Exportación', H1F: 'H1', H1: 'H1', T1GI: 'T1GI', T2GI: 'T2GI', REEXP: 'Reexportación 31.71', T1: 'T1', PERT: 'Pertrechos 31.00' };
const DUA_OPS_G4 = { h1_gi: 'H1 → T1GI (Gibraltar)', t1: 'T1', pertrechos: 'Pertrechos a buque (31.00 F61)' };
// Aduana de la mercancía. Casilla 30 = aduana + recinto: el EX la lleva con «ES00», tránsito y H1 sin él
const DUA_ADUANAS_G4 = { ES001131: { nombre: 'Algeciras Marítima', recinto: 'ADT015', puerto: 'ALGECIRAS', cp: '11201', provincia: '11', salida: 'ES001165', doc: 'N730' },
  ES002901: { nombre: 'Aeropuerto de Málaga', recinto: 'MLG001', puerto: 'ALGECIRAS', cp: '11201', provincia: '29', salida: 'ES001131', doc: 'N740' },
  ES001167: { nombre: 'La Línea', recinto: '000000', puerto: '', cp: '', provincia: '11', salida: 'ES001167', doc: 'N730' } };
const DUA_ALS = { nif: 'ESB72058449', nombre: '* ALGECIRAS LOGISTIC SOLUTIONS, S.L.', direccion: 'PLO. INDUST. PALMONES II. C/ MÁSTIL, N 8', cp: '11379', poblacion: 'LOS BARRIOS', pais: 'ES' };
const DUA_MRN = { EX: 'mrn_ex', H1F: 'mrn_h1', H1: 'mrn_h1', T1GI: 'mrn_t1gi', T2GI: 'mrn_t2gi' };
const DUA_OPERACIONES = { export_ue_gi: 'Exportación UE → Gibraltar', reexport_gi: 'Reexportación desde Gibraltar (tierra)', avituallamiento: 'Reexportación GI · avituallamiento',
  import_gi_ue: 'Importación Gibraltar → UE', terceros_gi: 'Terceros → Gibraltar (H1 + T1GI)', export: 'Exportación (sin escenario)', import: 'Importación H1 (sin escenario)' };
const DUA_MRN_RE = /^\d{2}[A-Z]{2}[A-Z0-9]{14}$/;
const duaMrnValido = m => DUA_MRN_RE.test(String(m || '').trim());

function duaPasos(x){
  if(x.origen === 'dae') return ['T2GI'];
  const con71 = p => x.regimen === '71.00' ? [...p, 'REEXP'] : p;
  if(x.origen === 'g4'){
    const op = x.datos.comun?.opG4;
    if(op === 't1') return ['T1'];
    if(op === 'pertrechos') return ['PERT'];
    return con71(['H1', 'T1GI']);
  }
  const op = x.datos.cfg?.operacion;
  if(op === 'export_ue_gi') return ['EX', 'T2GI'];
  if(op === 'terceros_gi') return con71(['H1F', 'T1GI']);
  if(op === 'import_gi_ue' || op === 'import') return ['H1F'];
  return ['EX'];
}
function duaEtapa(x){
  if(!x?.datos) return 'inicio';
  if(x.origen === 'g4' && !x.datos.lineas?.length) return 'inicio';
  const pasos = duaPasos(x), gen = x.datos.generado || {};
  for(let i = 0; i < pasos.length; i++){
    const p = pasos[i];
    if(!gen[p]) return p;
    if(i < pasos.length - 1 && !duaMrnValido(x[DUA_MRN[p]])) return p;
  }
  return 'fin';
}
const duaEtapaTexto = e => e === 'inicio' ? 'T1 y G4' : e === 'fin' ? 'Terminado' : DUA_NOMBRE[e];

// El MRN del T1 son los 18 primeros caracteres del conocimiento de la G4
const duaMrnT1 = g4 => { const c = String(g4?.partidas?.[0]?.conocimiento || '').slice(0, 18); return duaMrnValido(c) ? c : ''; };

// Dígitos 9 y 10: criterio del despacho, la terminación más alta del catálogo
function duaTaricMayor(codigos){
  const unicos = [...new Set((codigos || []).map(c => String(c).trim()).filter(c => /^\d{10}$/.test(c)))].sort();
  return { codigo: unicos[unicos.length - 1] || '', opciones: unicos.length };
}
// Solo códigos vigentes hoy (hora de Madrid), como en el clasificador
function duaFechaISO(v){
  const t = String(v ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}
function duaVigente(r){
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const ini = duaFechaISO(r.inicio), fin = duaFechaISO(r.fin);
  return !(ini && ini > hoy) && !(fin && fin < hoy);
}
async function duaCompletarTaric(lineas){
  const nc8s = [...new Set(lineas.map(l => l.taric))];
  const por = new Map();
  for(let i = 0; i < nc8s.length; i += 100){
    const { data, error } = await sbT().from('taric_nomenclatura').select('codigo,nc8,inicio,fin').in('nc8', nc8s.slice(i, i + 100)).eq('declarable', 1);
    if(error) throw error;
    (data || []).filter(duaVigente).forEach(r => { if(!por.has(r.nc8)) por.set(r.nc8, []); por.get(r.nc8).push(r.codigo); });
  }
  lineas.forEach(l => {
    if(l.taric10Manual) return;
    const m = duaTaricMayor(por.get(l.taric));
    l.taric10 = m.codigo; l.taricOpciones = m.opciones;
  });
}


const DUA_COMUN_DEF = {
  aduana: 'ES001167', claseBultos: 'BX', representanteNif: 'ESB72058449', moneda: 'EUR', naturaleza: 1, contenedor: 0,
  modoFrontera: 3, modoInterior: 3, importador: {}, exportadorReexp: {}, factura: {}, transporte: { tipo: '30', pais: 'ES', docTipo: 'N730', docRef: 'CMR' },
  // Casilla 30 en dos partes en VisualTrans: aduana de localización + recinto
  localizacion: { aduana: '1167', codigo: '000000' }, ubicacionGibraltar: { aduana: 'ES001167', codigo: 'GIHM00' },
  aduanaDestinoT1GI: 'GI000001', destinoReexp: 'QS', tipoMedioFrontera: '10', garantia: { grn: '23ES0001120000047' }
};
const duaHoy = () => new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
const duaComunNuevo = () => Object.assign(JSON.parse(JSON.stringify(DUA_COMUN_DEF)), { fechaDeclaracion: duaHoy() });
function duaNuevoG4(){
  DUA.x = { id: null, origen: 'g4', regimen: '71.00', mrn_h1: '', mrn_t1gi: '', mrn_ex: '', mrn_t2gi: '',
            datos: { t1: null, g4Mrn: '', lineas: [], generado: {}, cuotas: {}, comun: Object.assign(duaComunNuevo(), { regimen: '71.00', opG4: 'h1_gi' }) } };
  duaAplicarAduana('ES001167');
  duaPintar();
}
// Primera apertura de una factura que llega del clasificador: lo que se deduce de ella
function duaPrepararFactura(x){
  const d = x.datos, cab = d.cab || {};
  d.generado = d.generado || {}; d.cuotas = d.cuotas || {}; d.lineas = d.lineas || [];
  if(!d.comun){
    const c = duaComunNuevo();
    c.factura = { numero: _vtFactura(cab), fecha: cab.fecha || '' };
    c.referencia = cab.numero_factura || ''; c.moneda = cab.moneda || 'EUR'; c.incoterm = cab.incoterm || '';
    c.totalFactura = parseNum(cab.total_factura) || ''; c.claseBultos = 'PX'; c.transporte.docRef = '';
    c.lugarIncoterm = cab.lugar_incoterm || (_vtPaisISO(cab.destinatario?.pais || cab.pais_destino) === 'GI' ? 'GIBRALTAR' : '');
    d.comun = c;
  }
  if(!d.cfg){
    const esc = inferEscenarioVT(cab);
    const e = GUIA_ESC_VT[esc];
    const det = d.factura || [];
    d.cfg = { operacion: esc || 'export', origen: 'resumen', aduana: e?.aduana || 'lalinea', regimen: e?.regimenDefault || '10.00', transporte: e?.transporte || '3', docTransporteRef: '',
      ubicacion: 'ES001167', ubicacionCod: '000000', observaciones: '', c44: {},
      provincia: (String(cab.exportador?.cp || cab.exportador?.direccion || '').match(/\b(\d{2})\d{3}\b/) || [])[1] || '',
      // Factura sin bruto por línea: bultos y bruto totales en la primera partida, como se presenta
      concentrar: !det.every(l => parseNum(l.peso_bruto) > 0) };
    x.regimen = d.cfg.regimen;
  }
}
// Las líneas de factura con su cabecera (se guardan aparte para no repetirla)
function duaDetalle(x){
  const d = x.datos, cab = d.cab || {}, cabs = d.cabs || {};
  return (d.factura || []).map(l => Object.assign(l, { _cab: cabs[l._numFactura] || cab }));
}
const duaEsImport = x => { const p = duaPasos(x); return p.includes('H1F'); };

// Partidas de la factura tal como irán en el DUA: agrupadas o no, con los totales en
// la primera si procede y lo corregido a mano encima (se conserva por TARIC o línea).
function duaPartidasFactura(x){
  const d = x.datos, c = d.cfg, cab = d.cab || {}, det = duaDetalle(x);
  const base = c.origen === 'detalle' ? det.map(l => Object.assign({}, l)) : agruparLineasParaDUA(det, cab);
  base.forEach(l => { l.peso_neto = _vtNeto(l); });
  if(c.concentrar){
    const suma = k => base.reduce((a, l) => a + (parseNum(l[k]) || 0), 0);
    const bultos = parseNum(cab.bultos_totales) || suma('bultos'), bruto = parseNum(cab.peso_bruto_total) || suma('peso_bruto');
    base.forEach((l, i) => { l.bultos = i ? 0 : bultos; l.peso_bruto = i ? 0 : bruto; l.peso_estimado = ''; });
  }
  base.forEach((l, i) => {
    l._clave = c.origen === 'detalle' ? (l._claveVT || String(i)) : String(l.codigo_taric || '').slice(0, 4);
    Object.assign(l, d.ediciones?.[l._clave] || {});
  });
  return base;
}
function duaEditarPartida(clave, campo, v){
  const d = DUA.x.datos;
  d.ediciones = d.ediciones || {}; d.ediciones[clave] = d.ediciones[clave] || {};
  d.ediciones[clave][campo] = String(v).trim();
  duaGuardarLuego();
}
function duaConcentrar(v){ DUA.x.datos.cfg.concentrar = v; duaGuardarLuego(); duaPintar(); }
function duaTablaFactura(lineas){
  const ce = 'font-size:11px;padding:3px 4px', cab = DUA.x.datos.cab || {};
  const inp = (l, campo, w, extra = '') => `<input class="fi" style="width:${w};${ce}" value="${sEsc(l[campo] ?? '')}" ${extra} onchange="duaEditarPartida('${sEsc(l._clave)}','${campo}',this.value)">`;
  return `<div style="overflow-x:auto;max-height:380px;overflow-y:auto;margin-bottom:10px"><table class="tbl" style="width:100%;font-size:11px"><thead><tr><th>Part.</th><th>TARIC</th><th>Descripción</th><th>Bultos</th><th>Bruto</th><th>Neto</th><th>Valor</th><th>Origen</th><th>Prov.</th><th>Supl. tipo</th><th>Supl. cant.</th></tr></thead><tbody>
    ${lineas.map((l, i) => `<tr data-nc8="${sEsc(String(l.codigo_taric || '').slice(0, 8))}"><td>${i + 1}</td><td style="font-family:var(--mono)">${sEsc(l.codigo_taric)}</td>
      <td><input class="fi" style="min-width:240px;${ce}" value="${sEsc(l._casilla31 || l.descripcion_es || l.descripcion_original || '')}" onchange="duaEditarPartida('${sEsc(l._clave)}','_casilla31',this.value)"></td>
      <td>${inp(l, 'bultos', '56px')}</td><td>${inp(l, 'peso_bruto', '68px')}</td><td>${inp(l, 'peso_neto', '68px')}</td><td>${inp(l, 'importe', '76px')}</td>
      <td><input class="fi" style="width:44px;${ce}" maxlength="2" value="${sEsc(l._origen || _vtPaisISO((l._cab && l._cab.pais_origen) || cab.pais_origen) || '')}" onchange="duaEditarPartida('${sEsc(l._clave)}','_origen',this.value.toUpperCase())"></td>
      <td>${inp(l, '_provincia', '40px', `placeholder="${sEsc(DUA.x.datos.cfg.provincia || '')}"`)}</td>
      <td>${inp(l, '_suplTipo', '48px')}<div class="dua-supl" style="font-size:9px;color:var(--am600)"></div></td><td>${inp(l, '_suplCant', '56px')}</td></tr>`).join('')}</tbody></table></div>`;
}
// Marca las partidas cuyo TARIC pide unidad suplementaria (medidas del catálogo)
async function duaMarcarSupl(){
  const filas = [...document.querySelectorAll('tr[data-nc8]')];
  const nc8s = [...new Set(filas.map(f => f.dataset.nc8).filter(Boolean))];
  if(!nc8s.length) return;
  const { data, error } = await sbT().from('taric_medidas').select('nc8').in('nc8', nc8s).eq('categoria', 'UNIDAD_SUPL');
  if(error) return;
  const pide = new Set((data || []).map(r => r.nc8));
  filas.forEach(f => { const m = f.querySelector('.dua-supl'); if(m) m.textContent = pide.has(f.dataset.nc8) ? 'el TARIC la pide' : ''; });
}

// Partidas de un EX o H1 ya generado, en el formato de los tránsitos: mismo orden y número
function duaLineasDesdeDua(lineas, cab){
  return lineas.map((l, i) => {
    const bruto = parseNum(l.peso_bruto) || parseNum(l.peso_estimado) || 0;
    const neto = parseNum(l.peso_neto);
    const cod = String(l.codigo_taric || '').replace(/\D/g, '');
    return { partida: i + 1, mrn: '', bultos: parseNum(l.bultos) || 0, peso: bruto, neto: neto > 0 ? neto : bruto, taric: cod.slice(0, 8), taric10: cod,
             valor: parseNum(l.importe) || 0, origen: _vtPaisISO(l._origen || (l._cab && l._cab.pais_origen) || cab.pais_origen) || '',
             descripcion: (l._casilla31 || l.descripcion_es || l.descripcion_original || '').trim() };
  });
}
function duaLoteDe(x){
  // Lo tecleado puede venir con coma; lo del Excel ya es número (1.125 no son 1125)
  const num = v => typeof v === 'number' ? v : gibNumES(v);
  const d = x.datos;
  const c = Object.assign({}, d.comun, { regimen: x.regimen, totalFactura: num(d.comun.totalFactura) || 0, valorH1: num(d.comun.valorH1) || 0 });
  if(x.origen !== 'g4' && x.origen !== 'dae'){
    const cab = d.cab || {}, parte = e => e ? { nombre: e.nombre_vt || e.nombre || '', nif: e.nif_vt || e.nif || e.eori || '', direccion: e.direccion || '', pais: _vtPaisISO(e.pais) } : {};
    c.exportador = parte(cab.exportador); c.destinatario = parte(cab.destinatario);
    if(!c.importador?.nombre) c.importador = c.destinatario;
  }
  const datos = {};
  (d.lineas || []).forEach(l => { datos[l.partida] = { valor: num(l.valor), origen: l.origen, taric10: l.taric10, neto: num(l.neto), descripcion: l.descripcion,
    supl: l.suplTipo ? { tipo: l.suplTipo, cant: l.suplCant } : null }; });
  if(c.opG4 === 'pertrechos' && !c.descripcion && c.buque?.nombre) c.descripcion = `PERTRECHOS PARA EL BUQUE ${c.buque.nombre}`;
  const lote = gibPrepararLote({ mrn: d.g4Mrn, partidas: d.lineas || [] }, datos, c);
  return lote;
}

// ── Guardado y lista ─────────────────────────────────────────
function duaGuardarLuego(){ clearTimeout(DUA.t); DUA.t = setTimeout(duaGuardar, 700); }
async function duaGuardar(){
  const x = DUA.x;
  if(!x || (x.origen === 'g4' && !x.datos.lineas.length)) return;
  clearTimeout(DUA.t);
  const fila = { usuario: (window.PortalGuard && PortalGuard.CU && PortalGuard.CU.nombre) || null, origen: x.origen, referencia: x.datos.comun?.referencia || null, regimen: x.regimen || '',
    g4_mrn: x.datos.g4Mrn || null, t1_mrn: x.datos.t1Mrn || null, mrn_h1: x.mrn_h1 || null, mrn_t1gi: x.mrn_t1gi || null, mrn_ex: x.mrn_ex || null, mrn_t2gi: x.mrn_t2gi || null,
    etapa: duaEtapa(x), datos: JSON.parse(JSON.stringify(x.datos, (k, v) => k === '_cab' ? undefined : v)), updated_at: new Date().toISOString() };
  const r = x.id ? await sbT().from('vt_expedientes').update(fila).eq('id', x.id).select('id').single()
                 : await sbT().from('vt_expedientes').insert(fila).select('id').single();
  if(r.error) return showToast('No se pudo guardar el expediente: ' + r.error.message);
  x.id = r.data.id;
}
async function duaPintarLista(){
  const el = document.getElementById('dua-lista');
  if(!el) return;
  const { data, error } = await sbT().from('vt_expedientes').select('id,updated_at,origen,referencia,regimen,g4_mrn,mrn_ex,mrn_h1,mrn_t1gi,mrn_t2gi,etapa').order('updated_at', { ascending: false }).limit(60);
  if(error){ el.innerHTML = `<div style="font-size:12px;color:var(--g400)">${sEsc('Tabla vt_expedientes no disponible: ejecuta de nuevo instalar_soivre.sql en Supabase.')}</div>`; return; }
  const mrns = x => [['EX', x.mrn_ex], ['H1', x.mrn_h1], ['T1GI', x.mrn_t1gi], ['T2GI', x.mrn_t2gi]].filter(m => m[1]).map(m => `${m[0]} ${sEsc(m[1])}`).join('<br>') || '—';
  el.innerHTML = data.length ? `<table class="tbl" style="width:100%;font-size:12px"><thead><tr><th>Actualizado</th><th>Referencia</th><th>Entrada</th><th>MRN</th><th>Etapa</th><th></th></tr></thead><tbody>
    ${data.map(x => `<tr><td>${new Date(x.updated_at).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${sEsc(x.referencia || '—')}</td>
      <td>${x.origen === 'g4' ? 'G4 ' + sEsc(x.g4_mrn || '') : x.origen === 'dae' ? 'DAE ' + sEsc(x.mrn_ex || '') : 'Factura'}</td><td style="font-family:var(--mono);font-size:11px">${mrns(x)}</td>
      <td>${sEsc(duaEtapaTexto(x.etapa))}</td><td style="white-space:nowrap"><button class="btn btn-p btn-sm" onclick="duaAbrir('${x.id}')">Abrir</button> <button class="btn btn-s btn-sm" onclick="duaBorrar('${x.id}')">Borrar</button></td></tr>`).join('')}</tbody></table>`
    : '<div style="font-size:12px;color:var(--g400)">Sin expedientes. Se crean desde «VisualTrans (DUA)» en el clasificador, con «Nuevo desde G4» o con «T2GI desde DAE».</div>';
}
async function duaAbrir(id){
  const { data, error } = await sbT().from('vt_expedientes').select('*').eq('id', id).single();
  if(error || !data) return showToast('No se pudo abrir: ' + (error ? error.message : 'no existe'));
  DUA.x = data; window._vtCliente = null;
  if(data.origen !== 'g4' && data.origen !== 'dae') duaPrepararFactura(data);
  duaPintar();
}
async function duaBorrar(id){
  if(!confirm('¿Borrar este expediente del portal? Lo presentado en VisualTrans no se toca.')) return;
  const { data } = await sbT().from('vt_expedientes').select('datos').eq('id', id).single();
  if(data?.datos?.t1?.ruta) await sbT().storage.from(DUA_BUCKET).remove([data.datos.t1.ruta]);
  await sbT().from('vt_expedientes').delete().eq('id', id);
  if(DUA.x && DUA.x.id === id){ DUA.x = null; duaPintar(); }
  duaPintarLista();
}
function duaCerrar(){ duaGuardar().then(duaPintarLista); DUA.x = null; window._vtCliente = null; duaPintar(); }

// ── Entrada G4: T1 y consulta ────────────────────────────────
const DUA_BUCKET = 'soivre-adjuntos';
async function duaSubirT1(input){
  const f = input.files && input.files[0];
  if(!f) return;
  const nombre = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').slice(-80);
  const ruta = `gibraltar/${Date.now()}_${nombre}`;
  const { error } = await sbT().storage.from(DUA_BUCKET).upload(ruta, f, { upsert: false });
  if(error) return showToast('No se pudo subir el T1: ' + error.message);
  DUA.x.datos.t1 = { ruta, nombre: f.name }; DUA.t1Fichero = f;
  duaGuardarLuego(); duaPintar();
}
async function duaVerT1(){
  const r = await sbT().storage.from(DUA_BUCKET).download(DUA.x.datos.t1.ruta);
  if(!r.data) return showToast('No se pudo abrir el T1');
  window.open(URL.createObjectURL(r.data), '_blank');
}
async function duaSubirG4(input){
  const f = input.files && input.files[0];
  if(!f) return;
  const b = await f.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(b);
  if(t.includes('�')) t = new TextDecoder('windows-1252').decode(b);
  try{ await duaCargarG4(gibLeerG4(t)); }
  catch(e){ showToast(e.message); }
  input.value = '';
}
// Mismo destino para la consulta a la AEAT y para el CSV. Si una partida está datada
// en parte se usa lo que queda; si está saldada, lo declarado (avisa duaAvisos).
async function duaCargarG4(g4){
  const d = DUA.x.datos;
  const prev = new Map(d.lineas.map(l => [l.partida, l]));
  d.g4Mrn = g4.mrn; d.t1Mrn = duaMrnT1(g4);
  d.lineas = g4.partidas.map(p => {
    const parcial = p.bultosDisp > 0 && p.bultosDisp < p.bultos;
    return Object.assign({ valor: '', origen: '', taric10: '', taricOpciones: 0, suplTipo: '', suplCant: '', neto: '', descripcion: '' }, prev.get(p.partida) || {}, p,
      parcial ? { bultos: p.bultosDisp, peso: p.pesoDisp, bultosDec: p.bultos, parcial: true } : { parcial: false });
  });
  try{ await duaCompletarTaric(d.lineas); }
  catch(e){ showToast('No se pudo consultar el catálogo TARIC: ' + e.message); }
  await duaGuardar();
  duaPintar(); duaPintarLista();
}
// De lo que se pegue (MRN, enlace de la AEAT o nº de conocimiento) saca qué consultar
function duaLeerReferenciaG4(texto){
  const t = String(texto || '').trim().toUpperCase();
  const mrn = t.match(/\d{2}ESG4[A-Z0-9]{12}/);
  if(mrn) return { mrn: mrn[0] };
  if(/^HTTPS?:/.test(t)) return { error: 'Ese enlace no lleva el MRN de la G4: pega el MRN' };
  const conoc = t.replace(/[^A-Z0-9]/g, '');
  return conoc ? { conocimiento: conoc } : { error: 'Indica el MRN de la G4 o el número de conocimiento' };
}
const DUA_G4_ESPERA = 90000;
// Consulta en la AEAT a través del servidor (mismo circuito que SOIVRE): solo lee
async function duaConsultarG4(texto){
  const est = document.getElementById('dua-g4-estado');
  const pinta = (t, color = 'var(--g500)') => { if(est){ est.textContent = t; est.style.color = color; } };
  const ref = duaLeerReferenciaG4(texto);
  if(ref.error) return pinta(ref.error, 'var(--rd600)');
  if(ref.conocimiento) ref.recinto = DUA.x.datos.comun.aduana;
  const alta = await sbT().from('soivre_servidor').select('visto_en').order('visto_en', { ascending: false }).limit(1);
  const visto = alta.data?.[0]?.visto_en;
  if(!visto || Date.now() - new Date(visto).getTime() > 180000) return pinta('El servidor no da señal: sube la consulta en CSV.', 'var(--rd600)');
  pinta('Consultando en la AEAT…');
  const { data: fila, error } = await sbT().from('soivre_cola').insert({
    servicio: 'G4CONS', entorno: 'produccion', id_mensaje: `G4${Date.now()}${Math.floor(Math.random() * 1000)}`, datos: ref, contexto: {},
    usuario: (window.PortalGuard && PortalGuard.CU && PortalGuard.CU.nombre) || null
  }).select('id').single();
  if(error) return pinta('No se pudo pedir la consulta (¿instalar_soivre.sql actualizado?): ' + error.message, 'var(--rd600)');
  const limite = Date.now() + DUA_G4_ESPERA;
  let r = null;
  while(Date.now() < limite){
    await new Promise(res => setTimeout(res, 1500));
    const { data } = await sbT().from('soivre_cola').select('estado,descripcion_respuesta,errores,resultado').eq('id', fila.id).maybeSingle();
    if(data && !['pendiente', 'procesando'].includes(data.estado)){ r = data; break; }
  }
  if(!r) return pinta('El servidor no ha respondido a tiempo: inténtalo de nuevo o sube el CSV.', 'var(--rd600)');
  sbT().from('soivre_cola').delete().eq('id', fila.id).then(() => {});
  const partidas = r.resultado?.partidas || [];
  if(r.estado !== 'aceptada' || !partidas.length){
    const motivo = (r.errores || []).join(' · ') || r.descripcion_respuesta || 'La AEAT no ha devuelto partidas';
    return pinta(motivo + ' Puedes subir la consulta en CSV.', 'var(--rd600)');
  }
  if(DUA_ADUANAS_G4[r.resultado.recinto]) duaAplicarAduana(r.resultado.recinto);
  await duaCargarG4({ mrn: r.resultado.mrn, partidas });
  if(r.resultado.simulacion) showToast('SIMULACIÓN: partidas ficticias. Activa [g4] consulta = real en el servidor');
}
// Excel del cliente: una columna de partida y otra de valor; origen, opcional
function duaCargarXLSX(){
  if(window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar el lector de Excel'));
    document.head.appendChild(s);
  });
}
// Un solo botón: el PDF es la factura (se lee con IA), el resto, el Excel del cliente
async function duaSubirValores(input){
  const fs = [...(input.files || [])];
  input.value = '';
  if(!fs.length) return;
  const pdfs = fs.filter(f => /\.pdf$/i.test(f.name)), otros = fs.filter(f => !/\.pdf$/i.test(f.name));
  if(pdfs.length && otros.length) return showToast('Sube las facturas en PDF o el Excel, no los dos a la vez');
  if(pdfs.length) return duaLeerFacturaPdf(pdfs);
  try{
    await duaCargarXLSX();
    // Un CSV se lee como texto: «99,5» son 99,5 y no 995
    const f = otros[0], csv = /\.(csv|txt)$/i.test(f.name);
    const wb = csv ? XLSX.read(await f.text(), { type: 'string', raw: true }) : XLSX.read(await f.arrayBuffer());
    const n = duaAplicarValores(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true }));
    showToast(`${n} partida(s) con valor`);
    duaGuardarLuego(); duaPintar();
  }catch(e){ showToast('No se pudo leer el Excel: ' + e.message); }
}
function duaAplicarValores(filas){
  const norm = c => vtNormal(c ?? '');
  const iCab = filas.findIndex(f => f.some(c => /PARTIDA|^ITEM|^LINEA/.test(norm(c))) && f.some(c => /VALOR|IMPORTE|VALUE|AMOUNT/.test(norm(c))));
  if(iCab < 0) throw new Error('necesita una columna de partida y otra de valor');
  const cab = filas[iCab].map(norm);
  const iP = cab.findIndex(c => /PARTIDA|^ITEM|^LINEA/.test(c)), iV = cab.findIndex(c => /VALOR|IMPORTE|VALUE|AMOUNT/.test(c)), iO = cab.findIndex(c => /ORIGEN|ORIGIN/.test(c));
  let n = 0;
  filas.slice(iCab + 1).forEach(f => {
    const l = DUA.x.datos.lineas.find(x => x.partida === parseInt(f[iP], 10));
    if(!l) return;
    const v = typeof f[iV] === 'number' ? f[iV] : gibNumES(f[iV]);
    if(v > 0){ l.valor = v; n++; }
    if(iO >= 0 && /^[A-Za-z]{2}$/.test(String(f[iO] ?? '').trim())) l.origen = String(f[iO]).trim().toUpperCase();
  });
  return n;
}

// ── Descripciones del T1 con IA; la partida que no se pueda leer usa la genérica ──
const DUA_ANON = 'sb_publishable_tHKTtGyJmYQVnp66v1Dfjw_pCyyrLx1';   // pública, igual que en auth-guard.js
const DUA_PROXY = 'https://bccqfqaehbmmqbisfbyv.supabase.co/functions/v1/openrouter-proxy';
const DUA_MODELO = 'mistralai/mistral-small-2603';
const DUA_PROMPT_T1 = `Esta es una página de una declaración de tránsito T1 (TRANSIT LIST OF ITEMS). Por cada partida que aparezca devuelve su número (Decl goods it. Nr.), su descripción completa de la mercancía (Description of goods) y su código de mercancía (Commodity code). Copia la descripción literal, sin traducir. Si la página no tiene partidas devuelve una lista vacía. Responde solo con JSON: {"partidas":[{"n":1,"descripcion":"...","taric":"31021090"}]}`;
// imagen: página en JPEG; o, si la página trae texto, ese texto (más exacto con los números)
async function duaLlamarIA(imagen, prompt = DUA_PROMPT_T1, texto = ''){
  const { data } = await sbT().auth.getSession();
  const tok = data?.session?.access_token;
  const content = texto ? [{ type: 'text', text: prompt + '\n\n' + texto }] : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imagen } }];
  const r = await fetch(DUA_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: DUA_ANON, Authorization: 'Bearer ' + (tok || '') },
    body: JSON.stringify({ model: DUA_MODELO, temperature: 0.1, max_tokens: 8192, messages: [{ role: 'user', content }] }) });
  const j = await r.json();
  if(!r.ok) throw new Error(j?.error?.message || j?.error || ('HTTP ' + r.status));
  return j.choices?.[0]?.message?.content || '';
}
function duaLeerRespuestaT1(texto){
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if(!m) return [];
  try{ return (JSON.parse(m[0]).partidas || []).filter(p => Number.isInteger(+p.n)); }catch(_){ return []; }
}
// Descripción a la partida de su número; un TARIC distinto del de la G4 solo avisa: manda la G4
function duaAplicarT1(lineas, partidas){
  let n = 0; const dif = [];
  partidas.forEach(p => {
    const l = lineas.find(x => x.partida === +p.n);
    if(!l) return;
    const d = String(p.descripcion || '').replace(/\s+/g, ' ').trim();
    if(d && !l.descripcionManual){ l.descripcion = d; n++; }
    const t = String(p.taric || '').replace(/\D/g, '');
    if(t.length >= 8 && t.slice(0, 8) !== l.taric) dif.push(`Partida ${l.partida}: el T1 dice ${t}, la G4 ${l.taric}`);
  });
  return { n, dif };
}
function duaCargarPdf(){
  if(window.pdfjsLib) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js';
    s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js'; res(); };
    s.onerror = () => rej(new Error('No se pudo cargar el lector de PDF'));
    document.head.appendChild(s);
  });
}
async function duaLeerT1(){
  const d = DUA.x.datos, est = document.getElementById('dua-t1-estado');
  const pinta = t => { if(est) est.textContent = t; };
  try{
    let blob = DUA.t1Fichero;
    if(!blob){ const r = await sbT().storage.from(DUA_BUCKET).download(d.t1.ruta); blob = r.data; }
    if(!blob) throw new Error('no se pudo recuperar el T1');
    await duaCargarPdf();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    let total = 0; const dif = [];
    for(let i = 1; i <= pdf.numPages; i++){
      pinta(`Leyendo página ${i} de ${pdf.numPages}…`);
      const page = await pdf.getPage(i), vp = page.getViewport({ scale: 2 });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const r = duaAplicarT1(d.lineas, duaLeerRespuestaT1(await duaLlamarIA(cv.toDataURL('image/jpeg', 0.85))));
      total += r.n; dif.push(...r.dif);
    }
    d.avisosT1 = dif;
    const sin = d.lineas.filter(l => !l.descripcion).length;
    pinta(`${total} descripción(es) leídas${sin ? ` · ${sin} partida(s) usarán la descripción genérica` : ''}. Revísalas: las ha leído la IA.`);
    duaGuardarLuego(); duaPintarTabla();
  }catch(e){ pinta('No se pudo leer el T1 (' + e.message + '): se usará la descripción genérica.'); }
}

// ── Valores desde la factura en PDF: se lee con IA y se reparte entre las partidas ──
const DUA_PROMPT_FACTURA = `Esto es una página de una factura comercial o de un packing list. Extrae TODAS las líneas de mercancía, en el orden en que aparecen, con:
- hs: código arancelario de la línea (HS code / commodity code), solo dígitos; vacío si no consta
- descripcion: descripción literal, sin traducir
- kg: peso en kg de la línea
- cantidad: cantidad o número de bultos de la línea
- precio: precio unitario
- importe: importe total de la línea, tal como figura (aunque no sea cantidad × precio)
- origen: país de origen en código ISO de 2 letras; vacío si no consta
Extrae también, si aparecen en esta página: número de factura, fecha (dd/mm/aaaa), país del emisor de la factura (vendedor o shipper, código ISO de 2 letras), moneda (código ISO de 3 letras) e importe total de la factura.
No inventes ni calcules nada: deja vacío lo que no conste. No incluyas líneas de totales, portes ni descuentos. Escribe los números con punto decimal y sin separador de miles (2500.00).
Responde solo con JSON: {"factura":{"numero":"","fecha":"","pais_emisor":"","moneda":"","total":null},"lineas":[{"hs":"600537","descripcion":"Dust screen","kg":13,"cantidad":1,"precio":65,"importe":65,"origen":""}]}`;
// Número tal como lo devuelva la IA: 2500 · "2.500,00" · "2,500.00" · "€ 65,00"
function duaNumFactura(v){
  if(typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if(!s) return NaN;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if(c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if(c >= 0) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if(/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, '');
  return parseFloat(s);
}
function duaLeerRespuestaFactura(texto){
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if(!m) return { factura: {}, lineas: [] };
  try{ const j = JSON.parse(m[0]); return { factura: j.factura || {}, lineas: Array.isArray(j.lineas) ? j.lineas : [] }; }
  catch(_){ return { factura: {}, lineas: [] }; }
}
// Texto de la página por renglones (si el PDF lo trae: no es un escaneo)
async function duaTextoPagina(page){
  const items = (await page.getTextContent()).items.filter(it => String(it.str || '').trim());
  const filas = [];
  items.forEach(it => {
    const y = it.transform[5], x = it.transform[4];
    let f = filas.find(r => Math.abs(r.y - y) < 3);
    if(!f){ f = { y, partes: [] }; filas.push(f); }
    f.partes.push({ x, t: it.str });
  });
  return filas.sort((a, b) => b.y - a.y).map(f => f.partes.sort((a, b) => a.x - b.x).map(p => p.t.trim()).join('  ')).join('\n');
}
function duaEstadoValores(t){ const el = document.getElementById('dua-t1-estado'); if(el) el.textContent = t; }
async function duaLeerFacturaPdf(files){
  const d = DUA.x.datos, r2 = v => Math.round(v * 100) / 100;
  try{
    await duaCargarPdf();
    const facturas = [], lineas = [];
    for(const f of files){
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      const fac = { nombre: f.name, numero: '', fecha: '', pais_emisor: '', moneda: '', total: null };
      for(let i = 1; i <= pdf.numPages; i++){
        duaEstadoValores(`Leyendo ${f.name}: página ${i} de ${pdf.numPages}…`);
        const page = await pdf.getPage(i);
        const texto = await duaTextoPagina(page);
        let resp;
        // Un escaneo no trae texto; una página con solo el total, poco pero sí
        if(texto.replace(/\s/g, '').length >= 20) resp = await duaLlamarIA('', DUA_PROMPT_FACTURA, texto);
        else {
          const vp = page.getViewport({ scale: 2 }), cv = document.createElement('canvas');
          cv.width = vp.width; cv.height = vp.height;
          await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
          resp = await duaLlamarIA(cv.toDataURL('image/jpeg', 0.85), DUA_PROMPT_FACTURA);
        }
        const j = duaLeerRespuestaFactura(resp);
        ['numero', 'fecha', 'pais_emisor', 'moneda'].forEach(k => { if(!fac[k] && j.factura[k]) fac[k] = String(j.factura[k]).trim(); });
        const tot = duaNumFactura(j.factura.total);
        if(tot > 0) fac.total = tot;      // el total suele ir en la última página
        j.lineas.forEach(l => {
          const kg = duaNumFactura(l.kg), cantidad = duaNumFactura(l.cantidad), precio = duaNumFactura(l.precio);
          let importe = duaNumFactura(l.importe), calculado = false;
          if(!(importe > 0) && cantidad > 0 && precio > 0){ importe = r2(cantidad * precio); calculado = true; }
          const origen = String(l.origen || '').trim().toUpperCase();
          if(!(importe > 0) && !(kg > 0)) return;
          lineas.push({ fac: facturas.length, hs: String(l.hs || '').replace(/\D/g, ''), descripcion: String(l.descripcion || '').replace(/\s+/g, ' ').trim(),
                        kg: kg > 0 ? kg : 0, cantidad: cantidad > 0 ? cantidad : 0, precio: precio > 0 ? precio : 0, importe: importe > 0 ? importe : 0,
                        calculado, origen: /^[A-Z]{2}$/.test(origen) ? origen : '' });
        });
      }
      facturas.push(fac);
    }
    if(!lineas.length) throw new Error('no se han encontrado líneas de mercancía');
    gibCruzarFactura(d.lineas, lineas).forEach((a, i) => Object.assign(lineas[i], a));
    d.facturaG4 = { facturas, lineas, leida: new Date().toISOString() };
    const c = d.comun, f0 = facturas.find(f => f.numero) || {};
    if(!c.factura?.numero && f0.numero) c.factura = { numero: duaNumeroN380(f0.numero, f0.pais_emisor), fecha: duaFechaFactura(f0.fecha) };
    else if(c.factura?.numero && !c.factura.fecha && f0.fecha) c.factura.fecha = duaFechaFactura(f0.fecha);
    if(facturas.every(f => f.total > 0)) c.totalFactura = r2(facturas.reduce((a, f) => a + f.total, 0));
    if(/^[A-Z]{3}$/.test(String(f0.moneda || facturas[0].moneda).toUpperCase())) c.moneda = String(f0.moneda || facturas[0].moneda).toUpperCase();
    duaFacturaAplicar();
    await duaGuardar();
    duaPintar();
    const sin = lineas.filter(l => !l.partida).length;
    showToast(`${lineas.length} líneas leídas${sin ? ` · ${sin} sin partida: revísalas` : ''}`);
  }catch(e){ duaEstadoValores('No se pudo leer la factura: ' + e.message); }
}
// N380: nº de factura con el país del emisor delante, como en el resto de DUA («725045 - 08», NL → «NL725045-08»)
function duaNumeroN380(numero, pais){
  const n = String(numero || '').trim().replace(/\s*([-/])\s*/g, '$1');
  const p = String(pais || '').trim().toUpperCase();
  return !n || /^[A-Z]{2}/.test(n) || !/^[A-Z]{2}$/.test(p) ? n : p + n;
}
// 9-10-2026, 09.10.2026 → 09/10/2026
function duaFechaFactura(t){
  const m = String(t || '').match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  return m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3].length === 2 ? '20' + m[3] : m[3]}` : String(t || '');
}
// Valor de cada partida = suma de los importes de sus líneas; origen, si todas dicen el mismo
function duaFacturaAplicar(){
  const d = DUA.x.datos, fg = d.facturaG4;
  if(!fg) return;
  gibResumenCruce(d.lineas, fg.lineas).forEach((s, k) => {
    const l = d.lineas[k];
    if(s.lineas){
      l.valor = s.importe; l.valorFactura = true;
      const ors = [...new Set(fg.lineas.filter(x => x.partida === l.partida).map(x => x.origen))];
      if(ors.length === 1 && ors[0] && (!l.origen || l.origenFactura)){ l.origen = ors[0]; l.origenFactura = true; }
    } else if(l.valorFactura){ l.valor = ''; l.valorFactura = false; }
  });
}
function duaAsignarLinea(i, v){
  const l = DUA.x.datos.facturaG4.lineas[i];
  l.partida = v ? parseInt(v, 10) : null; l.via = v ? 'manual' : '';
  duaFacturaAplicar(); duaGuardarLuego();
  const el = document.getElementById('dua-cuadre');
  if(el) el.innerHTML = duaCuadreHtml();
  duaPintarTabla();
}
function duaQuitarFactura(){
  const d = DUA.x.datos;
  if(!confirm('¿Quitar la factura leída? Los valores que puso se borran.')) return;
  d.lineas.forEach(l => { if(l.valorFactura){ l.valor = ''; l.valorFactura = false; } if(l.origenFactura){ l.origen = ''; l.origenFactura = false; } });
  delete d.facturaG4;
  duaGuardarLuego(); duaPintar();
}
// Cuadre de la factura con la G4: lo que no se ha podido asignar por código, para revisar
function duaCuadreHtml(){
  const d = DUA.x.datos, fg = d.facturaG4;
  if(!fg?.lineas?.length) return '';
  const r2 = v => Math.round(v * 100) / 100, n = v => Number(v || 0).toLocaleString('es-ES', { maximumFractionDigits: 2 });
  const res = gibResumenCruce(d.lineas, fg.lineas);
  const suma = (arr, k) => r2(arr.reduce((a, x) => a + (+x[k] || 0), 0));
  const kgF = suma(fg.lineas, 'kg'), bF = suma(fg.lineas, 'cantidad'), impF = suma(fg.lineas, 'importe');
  const kgG = suma(d.lineas, 'peso'), bG = suma(d.lineas, 'bultos');
  const totLeido = fg.facturas.every(f => f.total > 0) ? r2(fg.facturas.reduce((a, f) => a + f.total, 0)) : null;
  const precioRaro = l => l.precio > 0 && l.cantidad > 0 && Math.abs(l.precio * l.cantidad - l.importe) > 0.01;
  const porCodigo = res.filter(s => s.lineas && s.cuadraKg && fg.lineas.every(l => l.partida !== s.partida || l.via === 'codigo')).length;
  const sin = fg.lineas.filter(l => !l.partida), prop = fg.lineas.filter(l => l.via === 'peso');
  const mal = res.filter(s => !s.lineas || !s.cuadraKg || !s.cuadraBultos);
  const ok = (b, t) => `<span style="color:${b ? 'var(--gr600)' : 'var(--rd600)'};font-weight:600">${t}</span>`;
  const ce = 'font-size:11px;padding:3px 4px';
  const opciones = sel => `<option value="">— sin partida —</option>` + d.lineas.map(p => `<option value="${p.partida}" ${p.partida === sel ? 'selected' : ''}>${p.partida} · ${sEsc(p.taric)}</option>`).join('');
  const fila = (l, i) => {
    const nota = [l.via === 'peso' ? 'propuesta por peso' : l.via === 'manual' ? 'asignada a mano' : !l.partida ? 'sin partida' : '',
                  precioRaro(l) ? `importe ≠ ${n(l.cantidad)} × ${n(l.precio)}` : '', l.calculado ? 'importe calculado' : ''].filter(Boolean).join(' · ');
    return `<tr><td>${i + 1}</td><td style="font-family:var(--mono)">${sEsc(l.hs || '—')}</td><td>${sEsc(l.descripcion)}</td><td>${n(l.kg)}</td><td>${n(l.cantidad)}</td><td>${n(l.importe)}</td>
      <td><select class="fi" style="${ce};width:130px" onchange="duaAsignarLinea(${i},this.value)">${opciones(l.partida)}</select></td><td style="color:var(--am600)">${sEsc(nota)}</td></tr>`;
  };
  const tabla = filas => `<div style="overflow-x:auto;max-height:340px;overflow-y:auto"><table class="tbl" style="width:100%;font-size:11px"><thead><tr><th>Lín.</th><th>Código</th><th>Descripción</th><th>Kg</th><th>Cant.</th><th>Importe</th><th>Partida</th><th></th></tr></thead><tbody>${filas.join('')}</tbody></table></div>`;
  const revisar = fg.lineas.map((l, i) => [l, i]).filter(([l]) => l.via !== 'codigo' || precioRaro(l) || l.calculado);
  let h = `<div style="border:1px solid var(--g200);border-radius:8px;padding:10px 12px;margin:8px 0;font-size:12px">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>Factura${fg.facturas.length > 1 ? 's' : ''} ${sEsc(fg.facturas.map(f => f.numero || f.nombre).join(', '))}</strong>
      <button class="btn btn-s btn-sm" style="padding:1px 8px;font-size:10px" onclick="duaQuitarFactura()">Quitar factura</button></div>
    <div style="margin:6px 0">${fg.lineas.length} líneas · peso ${ok(Math.abs(kgF - kgG) < 0.005, `${n(kgF)} kg`)} (G4 ${n(kgG)}) · bultos ${ok(bF === bG, n(bF))} (G4 ${n(bG)}) · importe ${totLeido == null ? n(impF) : ok(Math.abs(impF - totLeido) < 0.005, n(impF))}${totLeido == null ? ' (sin total leído)' : ` (total factura ${n(totLeido)})`}</div>
    <div style="color:var(--g600)">${porCodigo} de ${d.lineas.length} partidas cuadran por código · ${prop.length} línea(s) propuestas por peso · ${sin.length ? ok(false, `${sin.length} sin partida`) : '0 sin partida'}. Las ha leído la IA: revisa las marcadas.</div>`;
  if(fg.facturas.length > 1) h += `<div style="color:var(--b700);margin-top:4px">El N380 lleva la factura ${sEsc(d.comun.factura?.numero || '')}: añade las demás en VisualTrans.</div>`;
  if(mal.length) h += `<div style="margin-top:8px;font-weight:600">Partidas que no cuadran</div><table class="tbl" style="width:100%;font-size:11px;margin-top:4px"><thead><tr><th>Partida</th><th>TARIC</th><th>G4 kg</th><th>Factura kg</th><th>G4 bultos</th><th>Factura cant.</th></tr></thead><tbody>
    ${mal.map(s => `<tr><td>${s.partida}</td><td style="font-family:var(--mono)">${sEsc(s.taric)}</td><td>${n(s.kgG4)}</td><td>${ok(s.cuadraKg, n(s.kg))}</td><td>${n(s.bultosG4)}</td><td>${ok(s.cuadraBultos, n(s.bultos))}</td></tr>`).join('')}</tbody></table>
    <div style="color:var(--g500);margin-top:2px">Si solo difieren los bultos puede ser normal: la cantidad de la factura no siempre son bultos.</div>`;
  if(revisar.length) h += `<div style="margin-top:8px;font-weight:600">Líneas a revisar</div>` + tabla(revisar.map(([l, i]) => fila(l, i)));
  h += `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--b600)">Ver las ${fg.lineas.length} líneas</summary>${tabla(fg.lineas.map(fila))}</details></div>`;
  return h;
}

// ── Edición ──────────────────────────────────────────────────
function duaRuta(o, ruta){ return ruta.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function duaSet(ruta, v){
  const ps = ruta.split('.'); let o = DUA.x;
  ps.slice(0, -1).forEach(k => { o = o[k] = o[k] || {}; });
  o[ps[ps.length - 1]] = String(v).trim();
  duaGuardarLuego(); duaPintarAvisos();
}
function duaLinea(i, campo, v){
  const l = DUA.x.datos.lineas[i];
  l[campo] = String(v).trim();
  if(campo === 'taric10') l.taric10Manual = true;
  if(campo === 'descripcion') l.descripcionManual = true;
  if(campo === 'valor') l.valorFactura = false;
  if(campo === 'origen') l.origenFactura = false;
  duaGuardarLuego(); duaPintarAvisos();
}
// Lo que suele llevar cada operación desde G4; una vez puesto se puede cambiar
function duaOperacionG4(v){
  const c = DUA.x.datos.comun;
  c.opG4 = v;
  if(v === 't1' && !c.expedidorT1?.nif) c.expedidorT1 = Object.assign({}, DUA_ALS);
  if(v === 'pertrechos'){
    if(!c.exportadorPertrechos?.nif) c.exportadorPertrechos = Object.assign({}, DUA_ALS);
    Object.assign(c, { naturaleza: 9, incoterm: c.incoterm || 'FOB', lugarIncoterm: c.lugarIncoterm || 'ALGECIRAS' });
    if(!c.transporte.matricula) c.transporte.matricula = 'CAMION';
  }
  duaGuardarLuego(); duaPintar();
}
function duaAplicarAduana(cod){
  const c = DUA.x.datos.comun, a = DUA_ADUANAS_G4[cod];
  c.aduana = cod;
  if(!a) return;
  c.localizacion = { aduana: cod.replace(/^ES00/, ''), codigo: a.recinto }; c.ubicacionEx = { aduana: cod, codigo: a.recinto };
  c.provincia = a.provincia; c.aduanaSalida = a.salida; c.transporte.docTipo = a.doc;
  c.buque = Object.assign({}, c.buque, { puerto: a.puerto, cp: a.cp });
}
// Cargo aéreo: el AWB trae marcas y documento de transporte; bultos y kilos se contrastan con la G4
async function duaBuscarAwb(v){
  const dig = String(v || '').replace(/\D/g, '');
  if(dig.length < 8) return showToast('Indica el AWB completo');
  const { data, error } = await sbT().from('airport_cargo').select('id,awb,bultos,kilos_tasables,consignatario,cliente,status').ilike('awb', `%${dig.slice(-8)}%`).limit(10);
  if(error) return showToast('No se pudo consultar cargo aéreo: ' + error.message);
  const e = (data || []).find(r => String(r.awb || '').replace(/\D/g, '') === dig);
  if(!e) return showToast('Ese AWB no está en cargo aéreo');
  const c = DUA.x.datos.comun;
  c.marcas = dig; c.transporte.docTipo = 'N740'; c.transporte.docRef = 'AWB ' + dig;
  c.awbCargo = { id: e.id, awb: dig, bultos: e.bultos, kilos: e.kilos_tasables, consignatario: e.consignatario || e.cliente || '', status: e.status || '' };
  duaGuardarLuego(); duaPintar();
}
const duaAwbHtml = () => { const a = DUA.x.datos.comun.awbCargo; return `<div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:10px"><div style="min-width:220px"><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">AWB de cargo aéreo</label><input class="fi" style="width:100%;font-family:var(--mono)" placeholder="724-90324452" value="${sEsc(a?.awb || '')}" onchange="duaBuscarAwb(this.value)"></div>${a ? `<div style="font-size:12px;color:var(--g600)">✈️ ${sEsc(a.consignatario)} · ${sEsc(a.bultos ?? '—')} bultos · ${sEsc(a.kilos ?? '—')} kg tasables${a.status ? ' · ' + sEsc(a.status) : ''}</div>` : ''}</div>`; };
function duaAduanaG4(v){ duaAplicarAduana(v); duaGuardarLuego(); duaPintar(); }
function duaRegimen(v){ DUA.x.regimen = v; DUA.x.datos.comun.regimen = v; if(DUA.x.datos.cfg) DUA.x.datos.cfg.regimen = v; duaGuardarLuego(); duaPintar(); }
function duaOperacion(v){
  const x = DUA.x, c = x.datos.cfg, e = GUIA_ESC_VT[v];
  c.operacion = v;
  if(e){ c.aduana = e.aduana || c.aduana; c.transporte = e.transporte || c.transporte; c.regimen = e.regimenDefault; }
  else c.regimen = v === 'import' ? '40.00' : '10.00';
  x.regimen = c.regimen; duaGuardarLuego(); duaPintar();
}
function duaMrn(campo, v){
  const m = String(v).trim().toUpperCase();
  if(m && !duaMrnValido(m)) return showToast('El MRN tiene 18 caracteres: ' + m);
  DUA.x[campo] = m;
  duaGuardar().then(() => { duaPintar(); duaPintarLista(); });
}
function duaAvisos(){
  const x = DUA.x, av = [];
  // Casilla 44 N380 (factura comercial y su fecha): va en todas las partidas de cualquier DUA
  const fac = x.datos.comun?.factura || {}, cab = x.datos.cab || {};
  const deFactura = x.origen !== 'g4' && x.origen !== 'dae';
  const nFac = fac.numero || (deFactura ? _vtFactura(cab) : ''), fFac = fac.fecha || (deFactura ? cab.fecha : '');
  if(!nFac || !fFac) av.push(`Casilla 44 N380: falta ${!nFac && !fFac ? 'el nº y la fecha' : !nFac ? 'el nº' : 'la fecha'} de la factura comercial`);
  else if(!/^[A-Z]{2}/.test(String(nFac).trim().toUpperCase())) av.push(`Casilla 44 N380: el nº de factura ${nFac} debe llevar delante el código ISO del país emisor (ej. NL${nFac})`);
  if(!x.datos.lineas?.length) return { lote: null, av };
  const lote = duaLoteDe(x);
  // El T1 no lleva valor ni origen; ni el T1 ni los pertrechos usan el TARIC a 10 dígitos
  const op = x.origen === 'g4' ? x.datos.comun?.opG4 : '';
  // El T2GI desde un DAE lleva el TARIC de 8 del DAE
  const fuera = op === 't1' ? /TARIC|valor|origen|suman/ : op === 'pertrechos' || x.origen === 'dae' ? /TARIC/ : null;
  av.push(...lote.avisos.filter(a => !fuera || !fuera.test(a)), ...(x.datos.avisosT1 || []));
  const sinPartida = (x.datos.facturaG4?.lineas || []).filter(l => !l.partida);
  if(sinPartida.length && op !== 't1' && op !== 'pertrechos') av.push(`${sinPartida.length} línea(s) de la factura sin partida (${Math.round(sinPartida.reduce((a, l) => a + l.importe, 0) * 100) / 100}): su importe no está en ningún valor`);
  const awb = x.datos.comun?.awbCargo;
  if(awb && parseInt(awb.bultos, 10) > 0 && parseInt(awb.bultos, 10) !== lote.bultos) av.push(`Cargo aéreo dice ${awb.bultos} bultos y la G4 ${lote.bultos}`);
  if(x.origen === 'dae'){
    const dae = x.datos.dae || {};
    if(!duaMrnValido(x.mrn_ex)) av.unshift('Falta el MRN del DAE (casilla 40: N830 + MRN), o no tiene 18 caracteres');
    if(dae.aduana_salida && !/^ES/i.test(dae.aduana_salida)) av.push(`El DAE declara como aduana de salida ${dae.aduana_salida}, no una aduana española: comprueba que el T2GI desde ${x.datos.comun.aduana} procede`);
    if(dae.pais_destino && dae.pais_destino !== 'GI') av.push(`El DAE declara como destino ${dae.pais_destino}, no Gibraltar`);
    if(dae.peso_bruto_total && Math.abs(dae.peso_bruto_total - lote.peso) > 0.5) av.push(`Las partidas suman ${lote.peso} kg y el DAE declara ${dae.peso_bruto_total} kg de masa bruta`);
    const raros = [['exportador', x.datos.comun.exportador], ['destinatario', x.datos.comun.destinatario]].filter(([, e]) => Object.values(e || {}).some(duaNoLatino)).map(([k]) => k);
    if(x.datos.lineas.some(l => duaNoLatino(l.descripcion))) raros.push('descripción');
    if(raros.length) av.push(`Hay texto en otro alfabeto (${raros.join(', ')}): VisualTrans no lo admite, escríbelo en caracteres latinos o déjalo vacío`);
    if(!x.datos.comun.exportador?.nombre) av.push('Falta el exportador del DAE (si el nombre venía en otro alfabeto, escríbelo en latino)');
    if(!x.datos.comun.destinatario?.nombre) av.push('Falta el destinatario del DAE');
  }
  if(x.origen === 'g4' && !x.mrn_h1 && x.datos.lineas.some(l => l.estado === 'Saldado')) av.unshift('La G4 figura como saldada: comprueba que no esté ya datada');
  x.datos.lineas.filter(l => l.parcial).forEach(l => av.unshift(`Partida ${l.partida} datada en parte: se usa el saldo, ${l.bultos} de ${l.bultosDec} bultos`));
  return { lote, av };
}
function duaPintarAvisos(){
  const el = document.getElementById('dua-avisos');
  if(!el) return;
  const { av } = duaAvisos();
  el.innerHTML = av.length ? `<div style="background:var(--am50);color:var(--am600);border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:10px">${av.map(a => '• ' + sEsc(a)).join('<br>')}</div>` : '';
}

// ── Generar ──────────────────────────────────────────────────
function duaDescargar(tipo, filas){
  const x = DUA.x;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gibCsv(filas)], { type: 'text/csv;charset=utf-8' }));
  a.download = `VisualTrans_${tipo}_${String(x.datos.comun?.referencia || x.datos.g4Mrn || 'dua').replace(/[^\w-]/g, '_')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  x.datos.generado = x.datos.generado || {}; x.datos.generado[tipo] = new Date().toISOString();
  duaGuardar().then(() => { duaPintar(); duaPintarLista(); });
  showToast('Fichero generado: ' + a.download);
}
function duaConfirmar(av){ return !av.length || confirm(`Hay ${av.length} aviso(s) sin resolver:\n\n${av.slice(0, 12).join('\n')}\n\n¿Generar el fichero igualmente?`); }
function duaGenerarH1(){ const { lote, av } = duaAvisos(); if(duaConfirmar(av)) duaDescargar('H1', gibFilasH1(lote)); }
function duaGenerarT1GI(){
  const x = DUA.x, { lote, av } = duaAvisos();
  if(x.regimen === '40.00'){ const f = x.datos.lineas.filter(l => !x.datos.cuotas?.[l.partida] && x.datos.cuotas?.[l.partida] !== 0).length; if(f) av.unshift(`${f} partida(s) sin la cuota de arancel del H1 (1247)`); }
  if(duaConfirmar(av)) duaDescargar('T1GI', gibFilasT1GI(lote, x.mrn_h1, x.datos.cuotas));
}
function duaGenerarT2GI(){ const x = DUA.x, { lote, av } = duaAvisos(); if(duaConfirmar(av)) duaDescargar('T2GI', gibFilasT2GI(lote, x.mrn_ex)); }
function duaGenerarT1(){ const { lote, av } = duaAvisos(); if(duaConfirmar(av)) duaDescargar('T1', gibFilasT1(lote)); }
function duaGenerarPertrechos(){ const { lote, av } = duaAvisos(); if(duaConfirmar(av)) duaDescargar('PERT', gibFilasPertrechos(lote)); }
function duaGenerarReexp(){ const x = DUA.x, { lote, av } = duaAvisos(); if(duaConfirmar(av)) duaDescargar('REEXP', gibFilasReexp(lote, x.mrn_h1, x.mrn_t1gi, x.datos.comun.fechaT1GI)); }
// EX o H1 desde la factura: entidades, cliente y N003 de SOIVRE; deja fijadas las partidas para el tránsito
async function duaGenerarDesdeFactura(){
  const x = DUA.x, d = x.datos, c = d.cfg, esImport = duaEsImport(x), detalle = duaDetalle(x), cab = d.cab || {};
  const esc = GUIA_ESC_VT[c.operacion];
  if(!duaConfirmar(duaAvisos().av.filter(a => a.startsWith('Casilla 44 N380')))) return;
  if(!(await vtPrepararExportacion(detalle, cab, esImport))) return;
  const docsEscenario = esc ? (esc.c44 || []).map(k => ({ codigo: k.codigo, valor: k.pedir ? (c.c44?.[k.codigo] || '') : '' })) : [];
  const t = d.comun.transporte || {};
  const cfg = { origen: c.origen, tipo: esImport ? 'import' : 'export', aduana: c.aduana, regimen: c.regimen, transporte: c.transporte, docTransporteRef: c.docTransporteRef, ubicacion: c.ubicacion, ubicacionCod: c.ubicacionCod,
    incoterm: d.comun.incoterm, lugarIncoterm: d.comun.lugarIncoterm, matricula: t.matricula, paisMatricula: t.pais, tipoMedioFrontera: { 1: '10', 3: '30' }[c.transporte] || '', claseBultos: d.comun.claseBultos,
    provincia: c.provincia, representante_nif: d.comun.representanteNif,
    observaciones: c.observaciones, escenario: esc ? c.operacion : '', preferencia: esc ? (esc.preferencia || '') : '', adicionales: esc ? adicionalesVT(esc, c.regimen) : [], docsEscenario, cliente: window._vtCliente || null };
  const lineas = duaPartidasFactura(x);
  d.lineas = duaLineasDesdeDua(lineas, cab);
  d.comun.aduana = (VT_ADUANAS[c.aduana] || {}).cod || c.aduana;
  if(cfg.cliente?.nif) d.comun.clienteNif = cfg.cliente.nif;
  if(c.docTransporteRef) d.comun.transporte.docRef = c.docTransporteRef;
  duaDescargar(esImport ? 'H1F' : 'EX', esImport ? construirFilasImport(cab, lineas, cfg) : construirFilasExport(cab, lineas, cfg));
  vtTrasExportar();
  if(cfg.cliente) vtRecordarCliente(cfg.cliente);
}

// ── T2GI desde el DAE de un EX presentado en otra aduana ─────
// No hay factura ni EX propio: el único precedente es el DAE (Documento de
// Acompañamiento de Exportación, de cualquier país de la UE). Se lee con IA y
// sus partidas pasan tal cual al T2GI, con N830 + MRN del DAE en la casilla 40.
const DUA_PROMPT_DAE = `Esta es una página de un documento de acompañamiento de exportación de la UE (DAE, EAD, Export Accompanying Document, Documento de Acompanhamento de Exportação…), en cualquier idioma y formato (casillas clásicas o numeración del CAU «12 03 000 000»…). Extrae sus datos tal como aparecen. Responde solo con JSON:
{"mrn":"","fecha_aceptacion":"dd/mm/aaaa","aduana_exportacion":"","aduana_salida":"","pais_exportacion":"ISO2","pais_destino":"ISO2",
"exportador":{"nombre":"","nif":"","direccion":"","cp":"","poblacion":"","pais":"ISO2"},
"destinatario":{"nombre":"","nif":"","direccion":"","cp":"","poblacion":"","pais":"ISO2"},
"factura":{"numero":"","fecha":"dd/mm/aaaa"},"bultos_totales":0,"peso_bruto_total":0,"matricula":"","pais_matricula":"ISO2",
"partidas":[{"n":1,"taric":"","descripcion":"","descripcion_es":"","bultos":0,"clase_bultos":"","bruto":0,"neto":0,"valor":0,"origen":"","otros_documentos":[{"codigo":"","ref":""}]}]}
Reglas:
- Números con punto decimal y sin separador de miles: «1 720,00» → 1720; «2491.5» → 2491.5.
- factura: el documento N380 (factura comercial) de la casilla 44, 40 o 12 03; solo su número, sin «N380». Fecha solo si figura; si no, vacía.
- valor: el valor estadístico de la partida (casilla 46 o 99 06).
- taric: el código de mercancía de la partida (casilla 33 o 18 09), solo dígitos.
- descripcion: literal, sin traducir. descripcion_es: la misma descripción traducida al español, breve y en mayúsculas.
- bultos y clase_bultos: número y código de 2 caracteres de los bultos de la partida (casilla 31 o 18 06; p. ej. ZZ, PC, PK, CT).
- Nombre, dirección y población del exportador y del destinatario: copiados tal cual, en el alfabeto del documento.
- matricula y pais_matricula: identidad y nacionalidad del medio de transporte a la salida (casilla 18 o 19 05), tal cual.
- otros_documentos: los demás documentos de la partida con código (casillas 40, 44 o 12 03), p. ej. {"codigo":"C651","ref":"26NL298962311770262S7"}; sin el N380.
- Lo que no aparezca en esta página, vacío o 0. Si la página no tiene partidas, "partidas":[].`;

const duaNumDae = v => { if(typeof v === 'number') return v; const s = String(v ?? '').replace(/\s/g, ''); const n = /,\d{1,3}$/.test(s) || /\.\d{3}(,|$)/.test(s) ? gibNumES(s) : parseFloat(s); return isFinite(n) ? n : 0; };
const duaNoLatino = t => /[Ͱ-ϿЀ-ӿἀ-῿]/.test(String(t || ''));
// Descripción del T2GI: la original del DAE y su traducción al español («ORIGINAL / TRADUCCIÓN»).
// Si la original no está en alfabeto latino, solo la traducción. Máximo 512 caracteres (NCTS).
function duaDescDae(orig, es){
  const o = String(orig || '').trim().toUpperCase(), t = String(es || '').trim().toUpperCase();
  const norm = v => v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
  const d = !o || duaNoLatino(o) ? t : !t || norm(o) === norm(t) ? o : `${o} / ${t}`;
  return d.slice(0, 512);
}
function duaLeerRespuestaDae(texto){
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if(!m) throw new Error('la IA no devolvió datos del DAE');
  return JSON.parse(m[0]);
}
// Une lo leído de cada página: la cabecera, el primer valor que aparezca; las partidas, por número
function duaUnirDae(paginas){
  const vacio = v => v == null || v === '' || v === 0 || (typeof v === 'object' && !Object.values(v).some(w => !vacio(w)));
  const r = { partidas: [] };
  paginas.forEach(p => {
    Object.entries(p).forEach(([k, v]) => {
      if(k === 'partidas') return;
      if(v && typeof v === 'object'){ r[k] = r[k] || {}; Object.entries(v).forEach(([kk, vv]) => { if(vacio(r[k][kk]) && !vacio(vv)) r[k][kk] = vv; }); }
      else if(vacio(r[k]) && !vacio(v)) r[k] = v;
    });
    (p.partidas || []).forEach((pt, i) => {
      const n = parseInt(pt.n, 10) || (r.partidas.length + i + 1);
      let o = r.partidas.find(x => x.n === n);
      if(!o){ o = { n }; r.partidas.push(o); }
      Object.entries(pt).forEach(([k, v]) => { if(vacio(o[k]) && !vacio(v)) o[k] = v; });
    });
  });
  r.partidas.sort((a, b) => a.n - b.n);
  return r;
}
async function duaNuevoDesdeDae(input){
  const files = [...(input.files || [])];
  input.value = '';
  if(!files.length) return;
  const est = t => { const el = document.getElementById('dua-dae-estado'); if(el) el.textContent = t; };
  try{
    const paginas = [];
    for(const f of files){
      if(/\.pdf$/i.test(f.name) || f.type === 'application/pdf'){
        await duaCargarPdf();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
        for(let i = 1; i <= pdf.numPages; i++){
          est(`Leyendo ${f.name}, página ${i} de ${pdf.numPages}…`);
          const page = await pdf.getPage(i), texto = await duaTextoPagina(page);
          let img = '';
          if(texto.replace(/\s/g, '').length < 20){
            const vp = page.getViewport({ scale: 2 }), cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            img = cv.toDataURL('image/jpeg', 0.85);
          }
          paginas.push(duaLeerRespuestaDae(await duaLlamarIA(img, DUA_PROMPT_DAE, img ? '' : texto)));
        }
      } else {
        est(`Leyendo ${f.name}…`);
        const img = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
        paginas.push(duaLeerRespuestaDae(await duaLlamarIA(img, DUA_PROMPT_DAE)));
      }
    }
    const dae = duaUnirDae(paginas);
    if(!dae.partidas.length) throw new Error('no se ha encontrado ninguna partida en el DAE');
    const mrn = String(dae.mrn || '').replace(/\s/g, '').toUpperCase();
    const pais = _vtPaisISO(dae.pais_exportacion) || _vtPaisISO(dae.exportador?.pais) || '';
    // VisualTrans y NCTS no admiten otros alfabetos (griego, cirílico): ese campo se deja vacío y la dirección se elige en VisualTrans
    const lat = v => { const t = String(v || '').trim(); return duaNoLatino(t) ? '' : t; };
    const ent = e => ({ nombre: lat(e?.nombre), nif: String(e?.nif || '').replace(/\s/g, ''), direccion: lat(e?.direccion), cp: lat(e?.cp), poblacion: lat(e?.poblacion), pais: _vtPaisISO(e?.pais) || '' });
    const c = duaComunNuevo();
    c.referencia = mrn; c.claseBultos = (dae.partidas.find(p => p.clase_bultos)?.clase_bultos || c.claseBultos).toUpperCase().slice(0, 2);
    c.exportador = ent(dae.exportador); c.destinatario = ent(dae.destinatario);
    if(!c.destinatario.pais && _vtPaisISO(dae.pais_destino) === 'GI') c.destinatario.pais = 'GI';
    // N380 con el ISO del país emisor delante, aunque el número empiece por letras (FAT 80126/108 → PTFAT 80126/108)
    const pEmisor = c.exportador.pais || pais, nFac = String(dae.factura?.numero || '').trim().replace(/^N380[\s\-:]*/i, '');
    c.factura = { numero: !nFac ? '' : nFac.toUpperCase().startsWith(pEmisor) ? duaNumeroN380(nFac, '') : duaNumeroN380(pEmisor + nFac, ''), fecha: duaFechaFactura(dae.factura?.fecha || '') };
    // Matrícula del DAE (casilla 18 / 19 05): suele ser el mismo camión que cruza; se puede cambiar
    const mat = String(dae.matricula || '').trim().toUpperCase();
    c.transporte.matricula = /^(CAMIAO|CAMION|TRUCK|LKW|---?|-)$/.test(mat) ? '' : mat;
    if(c.transporte.matricula && _vtPaisISO(dae.pais_matricula)) c.transporte.pais = _vtPaisISO(dae.pais_matricula);
    const lineas = dae.partidas.map((p, i) => {
      const taric = String(p.taric || '').replace(/\D/g, '').slice(0, 8);
      const bruto = duaNumDae(p.bruto), neto = duaNumDae(p.neto);
      const desc = duaDescDae(p.descripcion, p.descripcion_es);
      return { partida: i + 1, mrn: '', taric, taric10: '', bultos: Math.round(duaNumDae(p.bultos)) || 0, peso: bruto, neto: neto > 0 ? neto : bruto,
               valor: duaNumDae(p.valor), origen: _vtPaisISO(p.origen) || pais, descripcion: desc, descripcionDae: String(p.descripcion || '').trim(),
               otrosDocs: (Array.isArray(p.otros_documentos) ? p.otros_documentos : []).map(o => ({ codigo: String(o?.codigo || '').trim().toUpperCase(), ref: String(o?.ref || '').trim() })).filter(o => o.codigo && o.codigo !== 'N380') };
    });
    DUA.x = { id: null, origen: 'dae', regimen: '', mrn_h1: '', mrn_t1gi: '', mrn_ex: mrn, mrn_t2gi: '',
              datos: { dae: { mrn, fecha: dae.fecha_aceptacion || '', aduana_exportacion: dae.aduana_exportacion || '', aduana_salida: String(dae.aduana_salida || '').toUpperCase(),
                              pais_exportacion: pais, pais_destino: _vtPaisISO(dae.pais_destino) || '', bultos_totales: duaNumDae(dae.bultos_totales), peso_bruto_total: duaNumDae(dae.peso_bruto_total),
                              ficheros: files.map(f => f.name) },
                       lineas, generado: {}, cuotas: {}, comun: c } };
    est('');
    duaPintar();
    await duaGuardar(); duaPintarLista();
    showToast(`DAE leído: ${lineas.length} partida(s). Revísalo: lo ha leído la IA.`);
  }catch(e){ est('No se pudo leer el DAE: ' + e.message); showToast('No se pudo leer el DAE: ' + e.message); }
}
// Corrección a mano de una partida del DAE (los números se guardan como número)
function duaLineaDae(i, campo, v){
  const l = DUA.x.datos.lineas[i];
  if(['bultos', 'peso', 'neto', 'valor'].includes(campo)) l[campo] = duaNumDae(v) || 0;
  else if(campo === 'taric') l.taric = String(v).replace(/\D/g, '').slice(0, 8);
  else if(campo === 'origen') l.origen = String(v).trim().toUpperCase();
  else l[campo] = String(v).trim();
  if(campo === 'bultos') l.bultos = Math.round(l.bultos);
  duaGuardarLuego(); duaPintarAvisos();
}
function duaSeccionDae(){
  const x = DUA.x, d = x.datos, dae = d.dae || {}, ce = 'font-size:11px;padding:3px 4px';
  const lote = duaLoteDe(x);
  const inp = (i, campo, w, v, extra = '') => `<input class="fi" style="width:${w};${ce}" value="${sEsc(v ?? '')}" ${extra} onchange="duaLineaDae(${i},'${campo}',this.value)">`;
  let h = duaTit('DAE de la exportación') + `<div style="font-size:12px;color:var(--g600);margin-bottom:10px">${dae.pais_exportacion ? `Exportación en ${sEsc(dae.pais_exportacion)}` : 'Exportación'}${dae.aduana_exportacion ? ` (${sEsc(dae.aduana_exportacion)})` : ''}${dae.fecha ? ` el ${sEsc(dae.fecha)}` : ''}${dae.aduana_salida ? ` · salida declarada ${sEsc(dae.aduana_salida)}` : ''} · ${d.lineas.length} partida(s) · ${lote.bultos} bultos · ${lote.peso} kg · valor ${lote.valor} EUR${(dae.ficheros || []).length ? ` · ${sEsc(dae.ficheros.join(', '))}` : ''}</div>`;
  h += `<div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:10px">${duaMrnHtml('MRN del DAE (casilla 40: N830)', 'mrn_ex')}</div>`;
  h += duaRejilla(duaIn('Factura (N380)', 'datos.comun.factura.numero') + duaIn('Fecha factura', 'datos.comun.factura.fecha', 'placeholder="dd/mm/aaaa"') + duaIn('Clase de bultos', 'datos.comun.claseBultos', 'maxlength="2"') + duaIn('Referencia', 'datos.comun.referencia'));
  h += duaEntidadHtml('Exportador (el del DAE)', 'datos.comun.exportador') + duaEntidadHtml('Destinatario', 'datos.comun.destinatario');
  h += `<div style="overflow-x:auto;max-height:380px;overflow-y:auto;margin-bottom:10px"><table class="tbl" style="width:100%;font-size:11px"><thead><tr><th>Part.</th><th>TARIC</th><th>Descripción</th><th>Bultos</th><th>Bruto</th><th>Neto</th><th>Valor estad.</th><th>Origen</th></tr></thead><tbody>
    ${d.lineas.map((l, i) => `<tr><td>${l.partida}</td><td>${inp(i, 'taric', '82px', l.taric, 'maxlength="8" style="font-family:var(--mono)"')}</td>
      <td><input class="fi" style="min-width:240px;${ce}" value="${sEsc(l.descripcion)}" title="${sEsc(l.descripcionDae || '')}" onchange="duaLineaDae(${i},'descripcion',this.value)">${l.descripcionDae && l.descripcionDae.toUpperCase() !== l.descripcion ? `<div style="font-size:9px;color:var(--g400)">DAE: ${sEsc(l.descripcionDae.slice(0, 90))}</div>` : ''}</td>
      <td>${inp(i, 'bultos', '56px', l.bultos)}</td><td>${inp(i, 'peso', '70px', l.peso)}</td><td>${inp(i, 'neto', '70px', l.neto)}</td><td>${inp(i, 'valor', '80px', l.valor)}</td>
      <td>${inp(i, 'origen', '44px', l.origen, 'maxlength="2"')}</td></tr>${(l.otrosDocs || []).length ? `<tr><td></td><td colspan="7" style="font-size:10px;color:var(--g500)">Otros documentos del DAE (no pasan al T2GI): ${l.otrosDocs.map(o => sEsc(o.codigo + ' ' + o.ref)).join(' · ')}</td></tr>` : ''}`).join('')}</tbody></table></div>`;
  h += `<div style="font-size:11px;color:var(--g500);margin-bottom:10px">Lo ha leído la IA: revisa MRN, pesos y valores con el DAE. El 7020 de cada partida es su valor estadístico. La descripción lleva la original del DAE y su traducción. Los datos en otro alfabeto (griego, cirílico) se dejan vacíos: la dirección se elige o teclea en VisualTrans. Si el exportador o el destinatario no están en las entidades de VisualTrans con ese NIF, VisualTrans no los rellenará.</div>`;
  return h + `<div id="dua-avisos"></div>`;
}

// ── Pantalla ─────────────────────────────────────────────────
const duaIn = (etq, ruta, extra = '') => `<div><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">${etq}</label>
  <input class="fi" style="width:100%" value="${sEsc(duaRuta(DUA.x, ruta) ?? '')}" onchange="duaSet('${ruta}',this.value)" ${extra}></div>`;
const duaSel = (etq, valor, opciones, accion) => `<div><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">${etq}</label>
  <select class="fi" style="width:100%" onchange="${accion}">${opciones.map(([v, t]) => `<option value="${sEsc(v)}" ${String(v) === String(valor) ? 'selected' : ''}>${sEsc(t)}</option>`).join('')}</select></div>`;
const duaRejilla = html => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:10px">${html}</div>`;
const duaTit = t => `<div style="font-size:13px;font-weight:700;color:var(--g700);margin:4px 0 8px">${t}</div>`;
const duaTeclear = lista => `<div style="background:var(--b50);color:var(--b700);border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:10px"><strong>A teclear en VisualTrans:</strong> ${lista.map(sEsc).join(' · ')}</div>`;
const duaAvisoCambio = m => m && m !== 'EUR' ? duaTeclear([`Tipo de cambio ${m} (casilla 23)`]) : '';
const duaEntidadHtml = (etq, base) => `<div style="font-size:11px;font-weight:700;color:var(--g600);margin:6px 0 4px">${etq} <button class="btn btn-s btn-sm" style="padding:1px 6px;font-size:10px" onclick="duaBuscarEntidad('${base}')">Buscar por NIF</button></div>`
  + duaRejilla(duaIn('NIF', base + '.nif') + duaIn('Nombre', base + '.nombre') + duaIn('Dirección', base + '.direccion') + duaIn('CP', base + '.cp') + duaIn('Población', base + '.poblacion') + duaIn('País', base + '.pais', 'maxlength="2"'));
async function duaBuscarEntidad(base){
  const p = duaRuta(DUA.x, base) || {};
  const nif = vtNormNif(p.nif);
  if(!nif) return showToast('Indica primero el NIF');
  const { data, error } = await sbT().from('vt_entidades').select('nombre,nif,direccion,cp,localidad,pais_iso,preferida').eq('nif_norm', nif);
  if(error || !data || !data.length) return showToast('No está en las entidades de VisualTrans');
  const e = data.find(d => d.preferida) || data[0];
  Object.assign(p, { nombre: e.nombre, nif: e.nif || p.nif, direccion: e.direccion || '', cp: e.cp || '', poblacion: e.localidad || '', pais: e.pais_iso || '' });
  duaGuardarLuego(); duaPintar();
}
const duaMrnHtml = (etq, campo) => `<div style="min-width:240px"><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">${etq}</label><input class="fi" style="width:100%;font-family:var(--mono)" maxlength="18" value="${sEsc(DUA.x[campo] || '')}" onchange="duaMrn('${campo}',this.value)"></div>`;
const duaBoton = (texto, accion, mrn) => `<div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:14px"><button class="btn btn-p" onclick="${accion}">${texto}</button>${mrn || ''}</div>`;

// Tabla de partidas de una G4: lo que no trae la consulta se completa aquí
function duaTablaG4(){
  const d = DUA.x.datos, ce = 'font-size:11px;padding:3px 4px';
  return `<div style="overflow-x:auto;max-height:420px;overflow-y:auto;margin-bottom:10px"><table class="tbl" style="width:100%;font-size:11px"><thead><tr><th>Part.</th><th>TARIC G4</th><th>TARIC 10</th><th>Bultos</th><th>Bruto</th><th>Neto</th><th>Valor</th><th>Origen</th><th>Descripción</th><th>Supl. tipo</th><th>Supl. cant.</th></tr></thead><tbody>
    ${d.lineas.map((l, i) => `<tr><td>${l.partida}</td><td style="font-family:var(--mono)">${sEsc(l.taric)}</td>
      <td><input class="fi" style="width:105px;${ce};font-family:var(--mono)" maxlength="10" value="${sEsc(l.taric10)}" onchange="duaLinea(${i},'taric10',this.value)">${!l.taric10Manual && l.taricOpciones > 1 ? `<div style="font-size:9px;color:var(--am600)">mayor de ${l.taricOpciones}</div>` : ''}</td>
      <td>${l.bultos}</td><td>${l.peso}</td>
      <td><input class="fi" style="width:70px;${ce}" value="${sEsc(l.neto)}" placeholder="${l.peso}" onchange="duaLinea(${i},'neto',this.value)"></td>
      <td><input class="fi" style="width:80px;${ce}" value="${sEsc(l.valor)}" onchange="duaLinea(${i},'valor',this.value)"></td>
      <td><input class="fi" style="width:44px;${ce}" maxlength="2" value="${sEsc(l.origen)}" onchange="duaLinea(${i},'origen',this.value.toUpperCase())"></td>
      <td><input class="fi" style="min-width:220px;${ce}" value="${sEsc(l.descripcion)}" placeholder="genérica" onchange="duaLinea(${i},'descripcion',this.value)"></td>
      <td><input class="fi" style="width:48px;${ce}" value="${sEsc(l.suplTipo)}" onchange="duaLinea(${i},'suplTipo',this.value)"></td>
      <td><input class="fi" style="width:56px;${ce}" value="${sEsc(l.suplCant)}" onchange="duaLinea(${i},'suplCant',this.value)"></td></tr>`).join('')}</tbody></table></div>`;
}
function duaPintarTabla(){ const el = document.getElementById('dua-tabla'); if(el) el.innerHTML = duaTablaG4(); duaPintarAvisos(); }

function duaSeccionG4(){
  const x = DUA.x, d = x.datos, hay = d.lineas.length > 0;
  let h = duaTit('T1 de origen y G4') + duaRejilla(`<div><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">T1 de origen (PDF)</label>
      ${d.t1 ? `<div style="font-size:12px">📎 <a href="#" onclick="duaVerT1();return false">${sEsc(d.t1.nombre)}</a></div>` : ''}<input type="file" accept=".pdf" style="font-size:12px;width:100%" onchange="duaSubirT1(this)"></div>
    <div><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">O sube la consulta de la G4 (CSV)</label><input type="file" accept=".csv,.txt" style="font-size:12px;width:100%" onchange="duaSubirG4(this)"></div>`);
  h = `<div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-bottom:10px"><div style="flex:1;min-width:260px"><label style="font-size:10px;font-weight:700;color:var(--g500);text-transform:uppercase">MRN de la G4, enlace o nº de conocimiento</label><input id="dua-g4-ref" class="fi" style="width:100%;font-family:var(--mono)" value="${sEsc(d.g4Mrn || '')}" placeholder="26ESG4A004041386U9" onkeydown="if(event.key==='Enter')duaConsultarG4(this.value)"></div><button class="btn btn-p" onclick="duaConsultarG4(document.getElementById('dua-g4-ref').value)">Consultar en la AEAT</button></div><div id="dua-g4-estado" style="font-size:11px;margin:-4px 0 10px"></div>` + h;
  h += duaRejilla(duaSel('Operación', d.comun.opG4 || 'h1_gi', Object.entries(DUA_OPS_G4), 'duaOperacionG4(this.value)')
    + duaSel('Aduana de la mercancía', d.comun.aduana, Object.entries(DUA_ADUANAS_G4).map(([k, v]) => [k, `${k} · ${v.nombre}`]), 'duaAduanaG4(this.value)'));
  if(!hay) return h;
  if(d.comun.opG4 === 't1') return h + duaSeccionT1();
  if(d.comun.opG4 === 'pertrechos') return h + duaSeccionPertrechos();
  const lote = duaLoteDe(x), t = d.lineas.filter(l => !l.taric10Manual && l.taricOpciones > 1).length;
  h += `<div style="font-size:12px;color:var(--g600);margin-bottom:12px">G4 <strong style="font-family:var(--mono)">${sEsc(d.g4Mrn)}</strong>${d.t1Mrn ? ` · T1 <strong style="font-family:var(--mono)">${sEsc(d.t1Mrn)}</strong>` : ''} · ${d.lineas.length} partidas · ${lote.bultos} bultos · ${lote.peso} kg · valores ${lote.valor} ${sEsc(d.comun.moneda)}${t ? ` · ${t} TARIC con varias terminaciones: se ha puesto la más alta` : ''}</div>`;
  h += duaTit('H1') + duaRejilla(duaSel('Régimen', x.regimen, [['71.00', '71.00'], ['40.00', '40.00']], 'duaRegimen(this.value)')
    + duaIn('Referencia', 'datos.comun.referencia') + duaIn('Fecha declaración', 'datos.comun.fechaDeclaracion') + duaIn('Cliente · NIF entidad que paga', 'datos.comun.clienteNif')
    + duaIn('Factura', 'datos.comun.factura.numero') + duaIn('Fecha factura', 'datos.comun.factura.fecha') + duaIn('Total factura', 'datos.comun.totalFactura') + duaIn('Incoterm', 'datos.comun.incoterm') + duaIn('Lugar incoterm', 'datos.comun.lugarIncoterm')
    + duaIn('IMO buque (5012)', 'datos.comun.imo') + duaIn('Descripción genérica', 'datos.comun.descripcion') + duaIn('Valor único en H1 (vacío = el de cada partida)', 'datos.comun.valorH1')
    + duaIn('Casilla 30 · aduana', 'datos.comun.localizacion.aduana') + duaIn('Casilla 30 · recinto', 'datos.comun.localizacion.codigo'))
    + duaEntidadHtml('Importador / destinatario', 'datos.comun.importador');
  h += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0"><label class="btn btn-s btn-sm" style="cursor:pointer">📥 Valores desde factura PDF o Excel<input type="file" accept=".pdf,.xlsx,.xls,.csv" multiple style="display:none" onchange="duaSubirValores(this)"></label>
    ${d.t1 ? `<button class="btn btn-s btn-sm" onclick="duaLeerT1()">🔎 Leer descripciones del T1</button>` : ''}<span id="dua-t1-estado" style="font-size:11px;color:var(--g500)">PDF: la factura, o todas las de la G4 a la vez. Excel: columnas partida, valor y, si lo trae, origen.</span></div>
    <div id="dua-cuadre">${duaCuadreHtml()}</div>
    <div id="dua-tabla">${duaTablaG4()}</div>`;
  if(x.regimen === '71.00') h += duaTeclear([`Casilla 49: ${d.comun.ubicacionGibraltar.aduana}${d.comun.ubicacionGibraltar.codigo}`]);
  h += `<div id="dua-avisos"></div>` + duaBoton('Generar CSV del H1', 'duaGenerarH1()', d.generado?.H1 ? duaMrnHtml('MRN del H1 (al presentarlo en VisualTrans)', 'mrn_h1') : '');
  return h;
}
const duaResumenG4 = () => { const d = DUA.x.datos, l = duaLoteDe(DUA.x); return `<div style="font-size:12px;color:var(--g600);margin-bottom:12px">G4 <strong style="font-family:var(--mono)">${sEsc(d.g4Mrn)}</strong> · ${d.lineas.length} partida(s) · ${l.bultos} bultos · ${l.peso} kg</div>`; };
function duaSeccionT1(){
  return duaResumenG4() + duaTit('T1') + duaAwbHtml() + duaRejilla(duaIn('Referencia', 'datos.comun.referencia') + duaIn('Factura', 'datos.comun.factura.numero') + duaIn('Fecha factura', 'datos.comun.factura.fecha')
      + duaIn('Descripción genérica', 'datos.comun.descripcion') + duaIn('Aduana de destino', 'datos.comun.aduanaDestino', 'placeholder="ES001131"') + duaIn('País de destino', 'datos.comun.paisDestino', 'maxlength="2" placeholder="ES"')
      + duaIn('Matrícula', 'datos.comun.transporte.matricula') + duaIn('País matrícula', 'datos.comun.transporte.pais', 'maxlength="2"') + duaIn('Tipo documento transporte', 'datos.comun.transporte.docTipo') + duaIn('Referencia transporte (AWB, CMR…)', 'datos.comun.transporte.docRef')
      + duaIn('Marcas', 'datos.comun.marcas') + duaIn('Clase de bultos', 'datos.comun.claseBultos') + duaIn('Precintos', 'datos.comun.precinto') + duaIn('Garantía (GRN)', 'datos.comun.garantia.grn')
      + duaIn('Casilla 30 · aduana', 'datos.comun.localizacion.aduana') + duaIn('Casilla 30 · recinto', 'datos.comun.localizacion.codigo'))
    + duaEntidadHtml('Expedidor', 'datos.comun.expedidorT1') + duaEntidadHtml('Destinatario', 'datos.comun.destinatarioT1')
    + `<div id="dua-tabla">${duaTablaG4()}</div><div id="dua-avisos"></div>` + duaBoton('Generar CSV del T1', 'duaGenerarT1()');
}
function duaSeccionPertrechos(){
  const n = DUA.x.datos.comun.buque?.nombre;
  return duaResumenG4() + duaTit('Pertrechos a buque') + duaAwbHtml() + duaRejilla(duaIn('Buque', 'datos.comun.buque.nombre') + duaIn('IMO', 'datos.comun.buque.imo') + duaIn('Bandera', 'datos.comun.buque.bandera', 'maxlength="2"') + duaIn('Puerto', 'datos.comun.buque.puerto') + duaIn('CP puerto', 'datos.comun.buque.cp')
      + duaIn('Referencia', 'datos.comun.referencia') + duaIn('Factura', 'datos.comun.factura.numero') + duaIn('Fecha factura', 'datos.comun.factura.fecha') + duaIn('Moneda', 'datos.comun.moneda', 'maxlength="3"') + duaIn('Total factura', 'datos.comun.totalFactura')
      + duaIn('Incoterm', 'datos.comun.incoterm') + duaIn('Lugar incoterm', 'datos.comun.lugarIncoterm') + duaIn('Naturaleza transacción', 'datos.comun.naturaleza') + duaIn('Descripción', 'datos.comun.descripcion', `placeholder="PERTRECHOS PARA EL BUQUE ${sEsc(n || '')}"`) + duaIn('Marcas', 'datos.comun.marcas')
      + duaIn('Clase de bultos', 'datos.comun.claseBultos') + duaIn('Provincia', 'datos.comun.provincia', 'maxlength="2"') + duaIn('Aduana de salida', 'datos.comun.aduanaSalida') + duaIn('Casilla 30 · aduana', 'datos.comun.ubicacionEx.aduana') + duaIn('Casilla 30 · recinto', 'datos.comun.ubicacionEx.codigo')
      + duaIn('Fecha declaración', 'datos.comun.fechaDeclaracion') + duaIn('Transporte hasta el buque', 'datos.comun.transporte.matricula') + duaIn('TARIC', 'datos.comun.taricPertrechos', 'placeholder="99309900"'))
    + duaEntidadHtml('Exportador', 'datos.comun.exportadorPertrechos')
    + `<div id="dua-tabla">${duaTablaG4()}</div><div id="dua-avisos"></div>` + duaAvisoCambio(DUA.x.datos.comun.moneda) + duaBoton('Generar CSV de pertrechos', 'duaGenerarPertrechos()');
}
function duaSeccionFactura(){
  const x = DUA.x, d = x.datos, c = d.cfg, cab = d.cab || {}, esImport = duaEsImport(x), esc = GUIA_ESC_VT[c.operacion];
  const regs = esc ? esc.regimenes : (esImport ? VT_REGIMENES_IMP : VT_REGIMENES_EXP);
  const pedir = (esc?.c44 || []).filter(k => k.pedir);
  const lineas = duaPartidasFactura(x);
  let h = duaTit(`Factura ${sEsc(cab.numero_factura || '')}`) + `<div style="font-size:12px;color:var(--g600);margin-bottom:10px">${sEsc(cab.exportador?.nombre || '—')} → ${sEsc(cab.destinatario?.nombre || '—')} · ${(d.factura || []).length} líneas leídas · ${lineas.length} partidas en el DUA</div>`;
  h += duaRejilla(duaSel('Operación', c.operacion, Object.entries(DUA_OPERACIONES), 'duaOperacion(this.value)')
    + duaSel('Generar desde', c.origen, [['resumen', 'Resumen (agrupado por partida)'], ['detalle', 'Detalle (línea a línea)']], "duaSet('datos.cfg.origen',this.value);duaPintar()")
    + duaSel('Aduana', c.aduana, Object.entries(VT_ADUANAS).map(([k, v]) => [k, v.nombre]), "duaSet('datos.cfg.aduana',this.value)")
    + duaSel('Régimen', c.regimen, regs.map(r => [r, r]), 'duaRegimen(this.value)')
    + duaSel('Transporte frontera', c.transporte, [['1', '1 · Marítimo (N705 B/L)'], ['3', '3 · Carretera (N730 CMR)'], ['4', '4 · Aéreo (N740 AWB)'], ['2', '2 · Ferroviario (N720)']], "duaSet('datos.cfg.transporte',this.value)")
    + duaIn('Matrícula', 'datos.comun.transporte.matricula') + duaIn('País matrícula', 'datos.comun.transporte.pais', 'maxlength="2"') + duaIn('Ref. transporte', 'datos.cfg.docTransporteRef')
    + duaIn('Casilla 30 · aduana', 'datos.cfg.ubicacion') + duaIn('Casilla 30 · recinto', 'datos.cfg.ubicacionCod') + duaIn('Incoterm', 'datos.comun.incoterm') + duaIn('Lugar incoterm', 'datos.comun.lugarIncoterm')
    + duaIn('Clase de bultos', 'datos.comun.claseBultos') + duaIn('Provincia de origen', 'datos.cfg.provincia', 'maxlength="2"') + duaIn('Observaciones', 'datos.cfg.observaciones')
    + pedir.map(k => duaIn(`${k.codigo} · ${k.ref}`, `datos.cfg.c44.${k.codigo}`)).join(''));
  if(esc) h += `<div style="font-size:11px;color:var(--g500);margin-bottom:10px">${esc.notas.map(sEsc).join(' · ')}</div>`;
  h += `<label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:8px;cursor:pointer"><input type="checkbox" ${c.concentrar ? 'checked' : ''} onchange="duaConcentrar(this.checked)"> Bultos y peso bruto totales solo en la primera partida</label>${duaTablaFactura(lineas)}`;
  h += `<div id="vt-cliente" style="margin-bottom:10px"></div><div id="dua-soivre" style="font-size:12px;margin-bottom:10px"></div>`;
  h += duaAvisoCambio(d.comun.moneda);
  const tipo = esImport ? 'H1F' : 'EX';
  h += duaBoton(`Generar CSV ${esImport ? 'del H1' : 'de la exportación'}`, 'duaGenerarDesdeFactura()',
    d.generado?.[tipo] && duaPasos(x).length > 1 ? duaMrnHtml(`MRN ${esImport ? 'del H1' : 'de la exportación'}`, esImport ? 'mrn_h1' : 'mrn_ex') : '');
  return h;
}
const duaCamposTransito = () => duaRejilla(duaIn('Matrícula', 'datos.comun.transporte.matricula') + duaIn('País matrícula', 'datos.comun.transporte.pais', 'maxlength="2"') + duaIn('Tipo documento transporte', 'datos.comun.transporte.docTipo') + duaIn('Referencia transporte', 'datos.comun.transporte.docRef')
  + duaIn('Precinto', 'datos.comun.precinto') + duaIn('Garantía (GRN)', 'datos.comun.garantia.grn') + duaIn('Importe garantía', 'datos.comun.garantia.importe') + duaIn('Aduana destino', 'datos.comun.aduanaDestinoT1GI')
  + duaIn('Casilla 30 · aduana', 'datos.comun.localizacion.aduana') + duaIn('Casilla 30 · recinto', 'datos.comun.localizacion.codigo'))
  + duaTeclear(['Agente adicional (CS)']);
function duaSeccionT1GI(){
  const x = DUA.x, d = x.datos;
  let h = duaTit('T1GI') + duaCamposTransito();
  if(x.regimen === '40.00') h += `<div style="font-size:11px;color:var(--g600);margin-bottom:6px">Cuota de arancel del H1 por partida (código 1247):</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${d.lineas.map(l => `<label style="font-size:11px">${l.partida} <input class="fi" style="width:70px;font-size:11px;padding:3px 4px" value="${sEsc(d.cuotas?.[l.partida] ?? '')}" onchange="duaSet('datos.cuotas.${l.partida}',this.value)"></label>`).join('')}</div>`;
  const hayMas = duaPasos(x).includes('REEXP');
  return h + duaBoton('Generar CSV del T1GI', 'duaGenerarT1GI()', d.generado?.T1GI && hayMas ? duaMrnHtml('MRN del T1GI', 'mrn_t1gi') : '');
}
function duaSeccionT2GI(){
  return duaTit('T2GI') + `<div style="font-size:11px;color:var(--g500);margin-bottom:8px">Mismas partidas que la exportación. Casilla 40: N830 + MRN de la exportación.</div>` + duaCamposTransito()
    + duaBoton('Generar CSV del T2GI', 'duaGenerarT2GI()', DUA.x.datos.generado?.T2GI ? duaMrnHtml('MRN del T2GI (opcional, para el seguimiento)', 'mrn_t2gi') : '');
}
function duaSeccionReexp(){
  return duaTit('Reexportación 31.71') + duaRejilla(duaIn('Fecha T1GI', 'datos.comun.fechaT1GI') + duaIn('País destino', 'datos.comun.destinoReexp', 'maxlength="2"') + duaIn('Bandera buque', 'datos.comun.banderaBuque', 'maxlength="2"')
    + duaIn('Casilla 30 · aduana', 'datos.comun.ubicacionGibraltar.aduana') + duaIn('Casilla 30 · recinto', 'datos.comun.ubicacionGibraltar.codigo')) + duaEntidadHtml('Exportador', 'datos.comun.exportadorReexp')
    + duaBoton('Generar CSV de la reexportación', 'duaGenerarReexp()');
}
// Estado de las solicitudes SOIVRE de la factura: el N003 entra solo al generar la exportación
async function duaPintarSoivre(){
  const el = document.getElementById('dua-soivre'), x = DUA.x;
  if(!el || !x || x.origen === 'g4') return;
  const facturas = [...new Set((x.datos.factura || []).map(l => l._numFactura).filter(Boolean))];
  if(x.datos.cab?.numero_factura && !facturas.includes(x.datos.cab.numero_factura)) facturas.push(x.datos.cab.numero_factura);
  if(!facturas.length) return;
  const claves = new Set((x.datos.factura || []).map(l => l._claveVT).filter(Boolean));
  const { data } = await sbT().from('vua_expedientes').select('numero_solicitud,estado,n003,lineas_sol').in('numero_factura', facturas);
  const sols = (data || []).filter(s => (s.lineas_sol || []).some(ls => claves.has(ls.clave)));
  if(!sols.length){ el.innerHTML = ''; return; }
  const esp = sols.filter(s => s.estado !== 'certificado').length;
  el.innerHTML = `<span style="color:${esp ? 'var(--am600)' : 'var(--gr600)'}">🍊 SOIVRE: ${sols.length} solicitud(es) de esta factura${esp ? `, ${esp} aún sin certificado` : ', todas certificadas'}. El N003 se añade solo a sus partidas.</span>`;
}
function duaPintar(){
  const el = document.getElementById('dua-expediente');
  if(!el) return;
  const x = DUA.x;
  if(!x){ el.innerHTML = ''; return; }
  const etapa = duaEtapa(x), pasos = duaPasos(x), d = x.datos, iActual = etapa === 'fin' ? pasos.length : pasos.indexOf(etapa);
  const chip = (t, activo) => `<span class="badge" style="${activo ? 'background:var(--b600);color:var(--w)' : 'background:var(--g100);color:var(--g600)'}">${sEsc(t)}</span>`;
  let h = `<div class="card" style="padding:12px 14px;margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
    <div>${x.origen === 'g4' ? chip('T1 y G4', etapa === 'inicio') + ' ' : x.origen === 'dae' ? chip('DAE', false) + ' ' : ''}${pasos.map(p => chip(DUA_NOMBRE[p], p === etapa)).join(' ')} ${chip('Terminado', etapa === 'fin')}</div><button class="btn btn-s btn-sm" onclick="duaCerrar()">Guardar y cerrar</button></div>`;
  h += x.origen === 'g4' ? duaSeccionG4() : x.origen === 'dae' ? duaSeccionDae() : duaSeccionFactura();
  if(etapa !== 'inicio'){
    const sec = { T1GI: duaSeccionT1GI, T2GI: duaSeccionT2GI, REEXP: duaSeccionReexp };
    pasos.forEach((p, i) => { if(sec[p] && i <= iActual) h += sec[p](); });
    if(etapa === 'fin') h += `<div style="font-size:12px;color:var(--gr600);margin-top:10px">✔ Expediente terminado.</div>`;
  }
  el.innerHTML = h + '</div>';
  duaPintarAvisos();
  if(x.origen !== 'g4' && x.origen !== 'dae'){
    // Repintar no pierde el cliente elegido
    if(window._vtCliente) d.cliente = window._vtCliente;
    vtPintarCliente(d.cab || {}, duaEsImport(x)).then(() => { if(d.cliente && DUA.x === x) vtElegirCliente(d.cliente); });
    duaPintarSoivre();
    duaMarcarSupl();
  }
}
function loadVisualTrans(){
  duaPintarLista();
  const id = new URLSearchParams(location.search).get('exp');
  if(id) duaAbrir(id); else duaPintar();
}
