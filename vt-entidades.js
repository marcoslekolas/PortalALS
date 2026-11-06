// ═══════════════════════════════════════════════════════════════════════
// Enlace entre módulos. Lo cargan el clasificador (taric.html) y el módulo
// VisualTrans (visualtrans.html): entidades y clientes de VisualTrans, N003 de
// SOIVRE y paso de una factura leída al módulo.
// ═══════════════════════════════════════════════════════════════════════
function vtNormal(s){ return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }
function vtModal(titulo, html, ancho = 560){
  vtModalCerrar();
  const d = document.createElement('div');
  d.id = 'vt-modal';
  d.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
  d.innerHTML = `<div class="card" style="max-width:${ancho}px;width:100%;padding:18px 20px;max-height:90vh;overflow:auto"><div style="font-size:15px;font-weight:700;margin-bottom:12px">${sEsc(titulo)}</div>${html}</div>`;
  document.body.appendChild(d);
}
function vtModalCerrar(){ document.getElementById('vt-modal')?.remove(); }

// Clasificador / SOIVRE → módulo: la lectura se guarda como expediente y se abre.
// Una reclasificación de la misma lectura actualiza el mismo expediente.
async function vtEnviarFactura(cab, lineas){
  const cabs = {};
  const limpias = (lineas || []).map(l => {
    if(l._cab && l._numFactura && !cabs[l._numFactura]) cabs[l._numFactura] = l._cab;
    const c = Object.assign({}, l); delete c._cab; delete c._n003; delete c._n003s;
    // Casilla 44 según las medidas del catálogo: en el módulo ya no se calcula
    if(!c._c44 && typeof casilla44De === 'function') c._c44 = casilla44De(l) || [];
    return c;
  });
  const ventana = window.open('', '_blank');   // antes de esperar: si no, el navegador la bloquea
  const fila = {
    usuario: (window.PortalGuard && PortalGuard.CU && PortalGuard.CU.nombre) || null, origen: 'clasificador',
    referencia: cab.numero_factura || null, etapa: 'EX', updated_at: new Date().toISOString(),
    datos: { cab, cabs, factura: limpias }
  };
  const mismo = window._vtExpediente && window._vtExpediente.lineas === lineas ? window._vtExpediente.id : null;
  let r;
  if(mismo){   // conserva lo ya indicado en el módulo (operación, MRN…)
    const previo = await sbT().from('vt_expedientes').select('datos').eq('id', mismo).single();
    r = await sbT().from('vt_expedientes').update({ referencia: fila.referencia, updated_at: fila.updated_at, datos: Object.assign({}, previo.data?.datos, fila.datos) }).eq('id', mismo).select('id').single();
  } else r = await sbT().from('vt_expedientes').insert(Object.assign({ regimen: '' }, fila)).select('id').single();
  if(r.error){ if(ventana) ventana.close(); return showToast('No se pudo pasar la factura a VisualTrans: ' + r.error.message); }
  window._vtExpediente = { id: r.data.id, lineas };
  const url = 'visualtrans.html?exp=' + encodeURIComponent(r.data.id);
  if(ventana) ventana.location = url; else location.href = url;
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
  return vtNormal(n).replace(/^[\s*]+/, '').replace(/[^A-Z0-9 ]+/g, ' ')
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
  const cab = (filas.shift() || []).map(h => vtNormal(h).trim());
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
    window._vtElegido = c => { vtModalCerrar(); resolve(c); };
    const norm = vtNormNombre(parte.nombre);
    vtModal(`VisualTrans · ¿qué ${rol}?`, `
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
  if(avisos.length) showToast([...new Set(avisos)].join(' · '));
  return true;
}
// Tras descargar el CSV: los expedientes usados quedan como exportados (se borran a los 30 días)
async function vtTrasExportar(){
  if(!VT.expedientes.length) return;
  await sbT().from('vua_expedientes').update({ exportado_en: new Date().toISOString() }).in('id', VT.expedientes);
  VT.expedientes = [];
  if(document.getElementById('view-soivre')?.classList.contains('active')) vuaPintarExpedientes();
}

