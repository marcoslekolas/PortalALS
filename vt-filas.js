// ═══════════════════════════════════════════════════════════════════════
// Filas de los ficheros de importación de VisualTrans (sin pantalla).
// · Desde factura: construirFilasExport (EX) y construirFilasImport (H1).
// · Cadena Gibraltar: H1 desde G4, T1GI, T2GI y reexportación 31.71.
// Columnas: guías «Estructura Importación Dossieres» de VisualTrans (28/04/2026).
// Códigos: guía de tránsito NCTS (1.19) e información complementaria H1 (3.25).
// ═══════════════════════════════════════════════════════════════════════
function parseNum(v){
  let s = String(v == null ? '' : v).trim().replace(/[^\d.,-]/g,'');
  if(!s) return null;
  const ultimaComa = s.lastIndexOf(','), ultimoPunto = s.lastIndexOf('.');
  if(ultimaComa > -1 && ultimoPunto > -1){
    // el que está más a la derecha es el decimal; el otro, miles
    if(ultimaComa > ultimoPunto) s = s.replace(/\./g,'').replace(',','.');
    else s = s.replace(/,/g,'');
  } else if(ultimaComa > -1){
    // solo comas: decimal si hay 1-2 dígitos tras la última, si no son miles
    const dec = s.length - ultimaComa - 1;
    s = (dec === 3 && !s.slice(0,ultimaComa).includes(',')) ? s.replace(/,/g,'') : s.replace(/\./g,'').replace(',','.');
  } else if(ultimoPunto > -1){
    // solo puntos: decimal salvo que parezca separador de miles (grupos de 3)
    const dec = s.length - ultimoPunto - 1;
    if(dec === 3 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g,'');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Aduanas de despacho habituales de Customs Way
const VT_ADUANAS = {
  'lalinea':   { cod:'ES001167', nombre:'La Línea' },
  'algeciras': { cod:'ES001131', nombre:'Algeciras Marítima' },
  'malaga':    { cod:'ES002901', nombre:'Aeropuerto de Málaga' },
  'cernaval':  { cod:'ES001167OOLL03', nombre:'Cernaval' },
};
// Regímenes que usa Customs Way
const VT_REGIMENES_EXP = ['10.00','23.00','31.00','31.51'];   // exportación
const VT_REGIMENES_IMP = ['40.00','61.23'];                    // importación

// ─────────────────────────────────────────────────────────────────────────
// ESCENARIOS GIBRALTAR (guía técnica DUAs). Autocompletan la config del DUA
// para VisualTrans. Rellenan SOLO campos con posición segura en el CSV (tipo
// declaración, aduana, régimen). La preferencia (36), el régimen adicional
// (37.2) y los documentos de casilla 44 se muestran en el asistente para
// teclearlos en VisualTrans: sus posiciones en el fichero no están confirmadas
// y no se inyectan para no corromper el formato de importación.
// ─────────────────────────────────────────────────────────────────────────
const GUIA_ESC_VT = {
  'export_ue_gi': {
    label:'Exportación UE → Gibraltar (EX/H1)',
    tipo:'export', aduana:'lalinea', transporte:'3',
    regimenes:['10.00','21.00','22.00','23.00'], regimenDefault:'10.00',
    preferencia:'',
    adicionalPorRegimen:{},
    c44:[],
    notas:['NO se declara IVA (solo deuda aduanera).','Requiere T2GI de acompañamiento.','Exportación por mar: solo Algeciras.'],
    checklist:['C1 tipo: EX','C15a país destino: GI','T2GI obligatorio']
  },
  'reexport_gi': {
    label:'Reexportación desde Gibraltar (EX, tierra)',
    tipo:'export', aduana:'lalinea', transporte:'3',
    regimenes:['31.00','31.21','31.22','31.23'], regimenDefault:'31.00',
    preferencia:'300',
    adicionalPorRegimen:{},
    c44:[{codigo:'1240', ref:'MRN/partida T2GI o T1GI de entrada', pedir:true}],
    notas:['Preferencia 300 (libre circulación en GI).','C44 1240 obligatorio: MRN del T2GI/T1GI de entrada.'],
    checklist:['C1 tipo: EX','C15 exp: GI · C15a: ES','C36 preferencia: 300','C37 régimen: 3100','C44: 1240 + MRN T2GI']
  },
  'avituallamiento': {
    label:'Reexportación GI — Avituallamiento (mar/aire)',
    tipo:'export', aduana:'lalinea', transporte:'1',
    regimenes:['31.00'], regimenDefault:'31.00',
    preferencia:'300',
    adicionalPorRegimen:{ '31.00':['F61'] },
    c44:[{codigo:'1241', ref:'MRN T1/T2GI de entrada', pedir:true},{codigo:'5012', ref:'IMO del buque (5013 si no hay IMO)', pedir:true},{codigo:'1005', ref:'OSRE', pedir:false}],
    notas:['Solo aduana La Línea (ES001167).','C37 adicional F61 obligatorio.','5013 + identificación compañía si no hay IMO.','País destino: Q + código (excepto Qatar).'],
    checklist:['C1 tipo: A','C29 aduana: La Línea','C36: 300','C37: 3100 + F61','C44: 1241 + 5012 (IMO)']
  },
  'import_gi_ue': {
    label:'Importación Gibraltar → UE (IM/H1, libre circulación)',
    tipo:'import', aduana:'algeciras', transporte:'3',
    regimenes:['40.00','01.00','07.00','42.00','44.00','51.00','53.00','61.00','63.00','71.00'], regimenDefault:'40.00',
    preferencia:'400',
    adicionalPorRegimen:{ '44.00':['5GS'], '51.00':['5GS'], '53.00':['5GS'] },
    c44:[{codigo:'1240', ref:'MRN T2GI de vuelta', pedir:true}],
    notas:['Preferencia 400 obligatoria (unión aduanera).','C40 documento precedente: MRN del T2GI de vuelta.','Si la mercancía necesita PIF: aduana Algeciras.'],
    checklist:['C1 tipo: IM','C15 exp: GI','C36 preferencia: 400','C37 adicional: 5GS si 44/51/53','C44: 1240 + MRN T2GI']
  },
  'terceros_gi': {
    label:'Terceros → Gibraltar (IM/H1, no comunitaria)',
    tipo:'import', aduana:'algeciras', transporte:'1',
    regimenes:['40.00','51.00','53.00','71.00'], regimenDefault:'40.00',
    preferencia:'100',
    adicionalPorRegimen:{ '40.00':['5GI'], '51.00':['5GP'], '53.00':['5GT'], '71.00':['5GD'] },
    c44:[{codigo:'1249', ref:'Circunstancias excepcionales (entrada por mar)', pedir:false},{codigo:'9ZZZ', ref:'Documento precedente genérico', pedir:false}],
    notas:['Destino GI (subcabecera).','NO se declara IVA · NO contingentes.','Requiere T1GI de acompañamiento.','Régimen 7100 → adicional 5GD · casilla 44: 7018 y 7025.'],
    checklist:['C1 tipo: IM','C15a destino: GI','C36: 100','C37 adicional según régimen','T1GI obligatorio']
  }
};

// Códigos de régimen adicional (casilla 37.2) que aplican al régimen elegido.
function adicionalesVT(esc, regimen){
  if(!esc || !esc.adicionalPorRegimen) return [];
  return (esc.adicionalPorRegimen[regimen] || []).slice(0,3);
}

// Deduce el escenario a partir de los países de la factura (editable por el usuario).
function inferEscenarioVT(cab){
  cab = cab || {};
  const pais = o => _vtPaisISO(((cab[o]||{}).pais)||'').toUpperCase();
  const exp = pais('exportador'), des = pais('destinatario');
  const org = _vtPaisISO(cab.pais_origen||'').toUpperCase();
  if(des === 'GI'){ return (exp === 'ES' || org === 'ES' || !exp) ? 'export_ue_gi' : 'terceros_gi'; }
  if(exp === 'GI') return 'import_gi_ue';
  return '';
}

function _vtNum(v){ const n = parseNum(v); return (n==null) ? '' : n; }
function _vtTaric(t){
  const s = String(t||'').replace(/\D/g,'');
  return s.length===10 ? s : '';
}
function _vtPaisISO(p){
  const s = String(p||'').trim().toUpperCase();
  if(/^[A-Z]{2}$/.test(s)) return s;
  const m = {'ESPAÑA':'ES','ESPANA':'ES','GIBRALTAR':'GI','REINO UNIDO':'GB',
    'PORTUGAL':'PT','FRANCIA':'FR','MARRUECOS':'MA','EGIPTO':'EG','CHILE':'CL',
    'ECUADOR':'EC','SUDAFRICA':'ZA','SUDÁFRICA':'ZA','CHINA':'CN','ITALIA':'IT'};
  return m[s] || s.substring(0,2);
}

// N380: nº de factura con el país del emisor delante («ES4756/2026»)
function _vtFactura(cab){
  const n = String(cab.numero_factura || '').trim();
  if(!n || /^[A-Z]{2}/.test(n)) return n;
  return (_vtPaisISO((cab.exportador || {}).pais) || '') + n;
}
// Masa neta: la de la línea; si la factura solo da cantidad en kg, esa; si no, el bruto
function _vtNeto(l){
  const n = _vtNum(l.peso_neto);
  if(n) return n;
  if(/^(kg|kgs|kilo)/i.test(String(l.unidad || '').trim()) && _vtNum(l.cantidad)) return _vtNum(l.cantidad);
  return _vtNum(l.peso_bruto) || _vtNum(l.peso_estimado) || '';
}
// Casilla 44: los códigos Y van con la referencia «ESCRITO»
const _vtDoc44 = (d, fecha) => [d.codigo_doc, /^Y/.test(d.codigo_doc) ? 'ESCRITO' : '', fecha || ''];

// ── EXPORTACIÓN (EX-A). exportador = proveedor de la factura ──
function construirFilasExport(cab, lineas, cfg){
  cab = cab || {}; cfg = cfg || {};
  const exp = cab.exportador || {};   // proveedor emisor de la factura
  const des = cab.destinatario || {}; // cliente en Gibraltar
  const modoTr = cfg.transporte || '1';
  const docTr = { '1':'N705','2':'N720','3':'N730','4':'N740' }[modoTr] || 'N705';
  const aduana = (VT_ADUANAS[cfg.aduana] || {}).cod || cfg.aduana || 'ES001167';

  const C = new Array(87).fill('');
  C[0]='AES'; C[1]='E';
  C[2]=cfg.casilla1a||'EX'; C[3]=cfg.casilla1b||'A'; C[4]=cfg.casilla1c||'';
  C[5]=aduana;
  C[6]=exp.nombre_vt||exp.nombre||''; C[7]=exp.nif_vt||exp.nif||exp.eori||''; C[8]=exp.direccion||'';
  C[11]=_vtPaisISO(exp.pais)||'ES';
  C[12]=des.nombre_vt||des.nombre||''; C[13]=des.nif_vt||des.nif||des.eori||''; C[14]=des.direccion||'';
  C[17]=_vtPaisISO(des.pais)||'GI';
  C[18]=_vtPaisISO(cab.pais_origen)||'ES';           // C.15 país expedición
  C[19]=_vtPaisISO(des.pais||cab.pais_destino)||'GI';// C.17a país destino
  C[21]=cfg.contenedor??0;
  C[22]=cfg.incoterm||cab.incoterm||''; C[23]=cfg.lugarIncoterm||'';
  C[24]=cfg.buque||cab.buque||cfg.matricula||''; C[25]=cfg.paisMatricula||'';   // C.21 medio en frontera
  C[26]=cab.moneda||'EUR'; C[27]=cfg.naturaleza??1;
  C[28]=modoTr; C[29]=aduana;
  C[30]=cfg.ubicacion||''; C[31]=cfg.ubicacionCod||'';  // C.30: aduana de localización + recinto
  C[63]=C[19]; C[66]=cfg.tipoMedioFrontera||'';
  const totBultos=lineas.reduce((a,l)=>a+(_vtNum(l.bultos)||0),0);
  const totBruto=_vtNum(cab.peso_bruto_total)||lineas.reduce((a,l)=>a+(_vtNum(l.peso_bruto)||_vtNum(l.peso_estimado)||0),0);
  const totNeto=_vtNum(cab.peso_neto_total)||(Math.round(lineas.reduce((a,l)=>a+(_vtNeto(l)||0),0)*1000)/1000)||totBruto;
  C[32]=totBultos||''; C[33]=totBruto||''; C[34]=totNeto||'';
  C[35]=cab.numero_factura||'';
  C[36]=(cfg.cliente&&cfg.cliente.nif)||'';            // Entidad que paga = cliente del dossier
  C[37]=_vtNum(cab.total_factura)||'';
  C[39]=cfg.representante_nif||'';
  C[40]=cfg.refInterna||cab.numero_factura||'';
  C[57]=cfg.observaciones||'';

  const filas=[C];
  const nFra=_vtFactura(cab);
  if(nFra) filas.push(['DOCS','N380',nFra]);
  if(cfg.docTransporteRef) filas.push(['DOCS',docTr,cfg.docTransporteRef]);

  lineas.forEach(l=>{
    const P=new Array(77).fill('');
    const c44=(l._c44||[]);
    P[0]=_vtNum(l.bultos)||'';
    P[1]=_vtNum(l.peso_bruto)||_vtNum(l.peso_estimado)||'';
    P[2]=_vtNeto(l);
    P[3]=(l._casilla31||l.descripcion_es||l.descripcion_original||'').trim();
    // Unidades suplementarias: solo donde el TARIC las pide
    P[4]=l._suplTipo||''; P[5]=l._suplTipo?(_vtNum(l._suplCant)||''):'';
    P[6]=_vtTaric(l.codigo_taric);
    P[7]=_vtNum(l.importe)||'';   // valor = importe factura, sin ajustes
    P[9]=_vtPaisISO(l._origen||(l._cab&&l._cab.pais_origen)||cab.pais_origen)||'ES';
    P[10]=l._provincia||cfg.provincia||''; P[68]=cfg.claseBultos||'';
    P[13]=cfg.regimen||'10.00';
    // 37.2 (adicional → col 65-67). La exportación no lleva preferencia.
    const _adic=cfg.adicionales||[]; if(_adic[0])P[65]=_adic[0]; if(_adic[1])P[66]=_adic[1]; if(_adic[2])P[67]=_adic[2];
    const docs=[['N380',nFra,cab.fecha||'']];
    if(cfg.docTransporteRef) docs.push([docTr,cfg.docTransporteRef,'']);
    c44.forEach(d=>{ if(d.codigo_doc) docs.push(_vtDoc44(d,cab.fecha)); });
    // SOIVRE: N003 · nº certificado + línea en el certificado (2 dígitos) · fecha del certificado
    (l._n003s || (l._n003 ? [l._n003] : [])).forEach(n=>docs.push(['N003', n.num, n.fecha]));
    (cfg.docsEscenario||[]).forEach(d=>{ if(d.codigo) docs.push([d.codigo, d.valor||'', cab.fecha||'']); });
    docs.slice(0,15).forEach((d,k)=>{ const b=17+k*3; P[b]=d[0]||''; P[b+1]=d[1]||''; P[b+2]=d[2]||''; });
    filas.push(P);
  });
  return filas;
}

// ── IMPORTACIÓN (H1). exportador(C2)=proveedor, importador(C8)=cliente ──
function construirFilasImport(cab, lineas, cfg){
  cab = cab || {}; cfg = cfg || {};
  const exp = cab.exportador || {};    // proveedor extranjero (casilla 2 expedidor)
  const imp = cab.destinatario || {};  // cliente español = importador (casilla 8)
  const modoTr = cfg.transporte || '1';
  const docTr = { '1':'N705','2':'N720','3':'N730','4':'N740' }[modoTr] || 'N705';
  const aduana = (VT_ADUANAS[cfg.aduana] || {}).cod || cfg.aduana || 'ES001131';

  const C = new Array(87).fill('');
  C[0]='H'; C[1]='H';                                   // H = cabecera de H1 (guía VisualTrans; I = DVD)
  C[2]=cfg.casilla1a||'IM'; C[3]=cfg.casilla1b||'A'; C[4]=cfg.casilla1c||'';
  C[5]=aduana;
  C[6]=exp.nombre_vt||exp.nombre||''; C[7]=exp.nif_vt||exp.nif||exp.eori||''; C[8]=exp.direccion||'';
  C[11]=_vtPaisISO(exp.pais)||'';
  C[12]=imp.nombre_vt||imp.nombre||''; C[13]=imp.nif_vt||imp.nif||imp.eori||''; C[14]=imp.direccion||'';
  C[17]=_vtPaisISO(imp.pais)||'ES';
  C[18]=_vtPaisISO(cab.pais_origen)||_vtPaisISO(exp.pais)||''; // C.15
  C[19]='ES';                                                  // C.17a destino
  C[22]=cfg.incoterm||cab.incoterm||'';
  C[26]=cab.moneda||'EUR';
  C[28]=modoTr;
  C[30]=cfg.ubicacion||''; C[31]=cfg.ubicacionCod||'';
  const totBultos=lineas.reduce((a,l)=>a+(_vtNum(l.bultos)||0),0);
  const totBruto=_vtNum(cab.peso_bruto_total)||lineas.reduce((a,l)=>a+(_vtNum(l.peso_bruto)||_vtNum(l.peso_estimado)||0),0);
  const totNeto=_vtNum(cab.peso_neto_total)||totBruto;
  C[32]=totBultos||''; C[33]=totBruto||''; C[34]=totNeto||'';
  C[35]=cab.numero_factura||'';
  C[36]=(cfg.cliente&&cfg.cliente.nif)||'';            // Entidad que paga = cliente del dossier
  C[37]=_vtNum(cab.total_factura)||'';
  C[39]=cfg.representante_nif||'';
  C[40]=cfg.refInterna||cab.numero_factura||'';
  C[46]=cfg.garantiaH1||'';                            // Garantía (tipo GRN) del H1 — col 47 «Garantía VX»

  const filas=[C];
  const nFra=_vtFactura(cab);
  if(nFra) filas.push(['DOCS','N380',nFra]);
  if(cfg.docTransporteRef) filas.push(['DOCS',docTr,cfg.docTransporteRef]);

  // Casilla 40 · documento de cargo: el G4 (depósito temporal) y su partida
  const cargo=cfg.docCargo&&String(cfg.docCargo.mrn||'').trim()?cfg.docCargo:null;
  lineas.forEach(l=>{
    const P=new Array(105).fill('');
    const c44=(l._c44||[]);
    P[0]=_vtNum(l.bultos)||'';
    P[1]=_vtNum(l.peso_bruto)||_vtNum(l.peso_estimado)||'';
    P[2]=_vtNeto(l);
    P[3]=(l._casilla31||l.descripcion_es||l.descripcion_original||'').trim();
    P[4]=l._suplTipo||''; P[5]=l._suplTipo?(_vtNum(l._suplCant)||''):'';
    P[6]=_vtTaric(l.codigo_taric);
    P[7]=_vtNum(l.importe)||'';
    P[9]=_vtPaisISO(l._origen||(l._cab&&l._cab.pais_origen)||cab.pais_origen)||'';
    if(cargo){ P[11]=String(cargo.mrn).trim().toUpperCase(); P[12]=String(cargo.partida||'1').trim(); }
    P[13]=cfg.regimen||'40.00';
    P[103]='1';   // método valoración: 1 = valor de transacción
    // Escenario Gibraltar: casilla 36 (preferencia → col 63) y 37.2 (adicional → col 65-67)
    if(cfg.preferencia) P[63]=cfg.preferencia;
    const _adic=cfg.adicionales||[]; if(_adic[0])P[65]=_adic[0]; if(_adic[1])P[66]=_adic[1]; if(_adic[2])P[67]=_adic[2];
    const docs=[['N380',nFra,cab.fecha||'']];
    if(cfg.docTransporteRef) docs.push([docTr,cfg.docTransporteRef,'']);
    c44.forEach(d=>{ if(d.codigo_doc) docs.push(_vtDoc44(d,cab.fecha)); });
    (cfg.docsEscenario||[]).forEach(d=>{ if(d.codigo) docs.push([d.codigo, d.valor||'', cab.fecha||'']); });
    docs.slice(0,15).forEach((d,k)=>{ const b=17+k*3; P[b]=d[0]||''; P[b+1]=d[1]||''; P[b+2]=d[2]||''; });
    filas.push(P);
  });
  return filas;
}

// Agrupa las líneas por partida de 4 dígitos igual que la hoja Resumen, y
// devuelve "líneas" consolidadas en el formato que consume el generador VT.
// Suma bultos/pesos/cantidad/importe, usa la moda del TARIC, concatena las
// descripciones con ' + ' y une los códigos de casilla 44 del grupo.
function agruparLineasParaDUA(lineas, cabGlobal){
  // parseNum: «57.78» son 57,78 kg, no 5778
  const num = v => parseNum(v) || 0;
  const grupos = {};
  lineas.forEach(l => {
    const k = (l.codigo_taric||'').substring(0,4) || '----';
    if(!grupos[k]) grupos[k] = { bultos:0, bruto:0, neto:0, cantidad:0, importe:0, frec:{}, descs:[], c44:new Map(), n003:[], _cab:l._cab||null, unidad:l.unidad||'' };
    const g = grupos[k];
    (l._n003s || (l._n003 ? [l._n003] : [])).forEach(n => g.n003.push(n));
    (l._c44 || (typeof casilla44De==='function'?casilla44De(l):[]) || []).forEach(d => { if(d.codigo_doc && !g.c44.has(d.codigo_doc)) g.c44.set(d.codigo_doc, d); });
    g.bultos += num(l.bultos)||0;
    const pReal = num(l.peso_bruto);
    if(pReal) g.bruto += pReal; else if(num(l.peso_estimado)) g.bruto += num(l.peso_estimado);
    g.neto += num(_vtNeto(l));
    g.cantidad += num(l.cantidad)||0;
    g.importe += num(l.importe)||0;
    if(l.codigo_taric && l.codigo_taric.length===10){
      const f = g.frec[l.codigo_taric] || (g.frec[l.codigo_taric]={n:0,kg:0,imp:0});
      f.n++; f.kg += num(l.cantidad)||0; f.imp += num(l.importe)||0;
    }
    const d = (l._casilla31 || l.descripcion_es || l.descripcion_original || '').trim();
    if(d && !g.descs.includes(d)) g.descs.push(d);
  });
  const moda = g => {
    const c = Object.keys(g.frec);
    if(!c.length) return '';
    c.sort((a,b)=>(g.frec[b].n-g.frec[a].n)||(g.frec[b].kg-g.frec[a].kg)||(g.frec[b].imp-g.frec[a].imp)||(a<b?1:-1));
    return c[0];
  };
  // Devolver como "líneas" en el formato del generador VT
  return Object.keys(grupos).sort().map(k => {
    const g = grupos[k];
    const cod = moda(g);
    return {
      bultos: g.bultos || '',
      peso_bruto: g.bruto || '',
      peso_neto: g.neto || '',
      cantidad: g.cantidad || '',
      importe: g.importe || '',
      unidad: g.unidad || '',
      codigo_taric: cod,
      _casilla31: g.descs.join(' + '),
      descripcion_original: g.descs.join(' + '),
      _c44: [...g.c44.values()],
      _n003s: g.n003,
      _cab: g._cab,
    };
  });
}

const GIB_REGIMENES = {
  '40.00': { adicional: '5GI', docTransito: '1240' },
  '71.00': { adicional: '5GD', docTransito: '1241' },
  '53.00': { adicional: '5GT', docTransito: '1242' },
  '51.00': { adicional: '5GP', docTransito: '1243' }
};

// La consulta de la G4 mezcla formatos: «1.150» son 1150 kg y «13,2» son 13,2 kg
function gibNumES(t){
  const s = String(t ?? '').trim();
  if(s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  if(/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, ''));
  return parseFloat(s);
}
// «0 / 1.150» → lo declarado es lo que hay tras la barra
const gibDeclarado = t => gibNumES(String(t ?? '').split('/').pop());

function gibLeerG4(texto){
  const filas = String(texto || '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.split(';'));
  const cab = (filas.shift() || []).map(h => h.trim());
  const col = n => cab.findIndex(h => h.startsWith(n));
  const ix = { mrn: col('MRN'), partida: col('Partida Global'), con: col('Conocimiento'), bultos: col('Bultos'),
               peso: col('Peso bruto'), sit: col('Situación'), taric: col('Código arancelario'), estado: col('Estado') };
  if(Object.values(ix).some(i => i < 0)) throw new Error('No parece la consulta de una G4 (faltan columnas)');
  const partidas = filas.filter(f => (f[ix.mrn] || '').trim()).map(f => ({
    mrn: f[ix.mrn].trim(), partida: parseInt(f[ix.partida], 10), conocimiento: f[ix.con].trim(), situacion: f[ix.sit].trim(),
    estado: f[ix.estado].trim(), bultos: gibDeclarado(f[ix.bultos]), peso: gibDeclarado(f[ix.peso]), taric: f[ix.taric].trim(),
    bultosDisp: gibNumES(String(f[ix.bultos] ?? '').split('/')[0]), pesoDisp: gibNumES(String(f[ix.peso] ?? '').split('/')[0])
  }));
  if(!partidas.length) throw new Error('La G4 no trae partidas');
  return { mrn: partidas[0].mrn, partidas };
}

// Une la G4 con los datos de cada partida que no trae: valor, origen, TARIC a 10
// dígitos y unidades suplementarias. datos: { [partida]: { valor, origen, taric10, supl:{tipo,cant}, neto, descripcion } }
function gibPrepararLote(g4, datos, comun){
  const avisos = [];
  const lineas = g4.partidas.map(p => {
    const d = (datos || {})[p.partida] || {};
    const taric10 = d.taric10 || '';
    if(!taric10) avisos.push(`Partida ${p.partida}: falta el TARIC a 10 dígitos (la G4 solo trae ${p.taric})`);
    else if(taric10.slice(0, 8) !== p.taric) avisos.push(`Partida ${p.partida}: el TARIC ${taric10} no coincide con el de la G4 (${p.taric})`);
    if(!(d.valor > 0)) avisos.push(`Partida ${p.partida}: falta el valor`);
    if(!d.origen) avisos.push(`Partida ${p.partida}: falta el país de origen`);
    return Object.assign({}, p, { valor: d.valor, origen: d.origen || '', taric10, supl: d.supl || null,
                                  neto: d.neto > 0 ? d.neto : p.peso, descripcion: d.descripcion || comun.descripcion || '' });
  });
  const suma = c => Math.round(lineas.reduce((a, l) => a + (l[c] || 0), 0) * 1000) / 1000;
  const lote = { g4: g4.mrn, lineas, comun, bultos: suma('bultos'), peso: suma('peso'), valor: Math.round(suma('valor') * 100) / 100, avisos };
  if(comun.totalFactura && Math.abs(lote.valor - comun.totalFactura) > 0.005)
    avisos.push(`Los valores suman ${lote.valor} y la factura ${comun.totalFactura}`);
  return lote;
}

// Reparte las líneas de una factura entre las partidas de la G4:
// 1) mismo código de 6 dígitos, si solo hay una partida con él;
// 2) lo que quede, a la partida a la que le falte justo ese peso, empezando por las
//    líneas que más dígitos comparten con ella (6, luego 4, luego capítulo).
// lineas: [{ hs, kg, cantidad }]. Devuelve, por línea, la partida y cómo se ha asignado.
function gibCruzarFactura(partidas, lineas){
  const cg = v => Math.round((+v || 0) * 100);           // kg en centésimas, sin errores de coma flotante
  const dig = v => String(v ?? '').replace(/\D/g, '');
  const comunes = (a, b) => { let i = 0; while(i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const asig = lineas.map(() => ({ partida: null, via: '' }));
  lineas.forEach((l, i) => {
    const h = dig(l.hs).slice(0, 6);
    if(h.length < 6) return;
    const cand = partidas.filter(p => dig(p.taric).slice(0, 6) === h);
    if(cand.length === 1) asig[i] = { partida: cand[0].partida, via: 'codigo' };
  });
  const asignado = p => lineas.reduce((a, l, i) => asig[i].partida === p.partida ? a + cg(l.kg) : a, 0);
  // Subconjunto de líneas que suma exactamente «falta» (y, si puede ser, también los bultos)
  const buscar = (idx, falta, bultos) => {
    if(idx.length > 22) return null;
    let mejor = null;
    const ir = (k, resto, elegidas) => {
      if(mejor && mejor.bultos) return;
      if(resto === 0 && elegidas.length){
        const b = elegidas.reduce((a, i) => a + (+lineas[i].cantidad || 0), 0) === bultos;
        if(!mejor || b) mejor = { elegidas: elegidas.slice(), bultos: b };
        return;
      }
      if(k >= idx.length || resto < 0) return;
      const i = idx[k], kg = cg(lineas[i].kg);
      if(kg > 0 && kg <= resto){ elegidas.push(i); ir(k + 1, resto - kg, elegidas); elegidas.pop(); }
      ir(k + 1, resto, elegidas);
    };
    ir(0, falta, []);
    return mejor && mejor.elegidas;
  };
  [6, 4, 2].forEach(nivel => {
    partidas.forEach(p => {
      const falta = cg(p.peso) - asignado(p);
      if(falta <= 0) return;
      const t = dig(p.taric);
      const idx = lineas.map((l, i) => i).filter(i => !asig[i].partida && cg(lineas[i].kg) > 0 && comunes(dig(lineas[i].hs), t) >= nivel);
      if(!idx.length) return;
      const ya = lineas.reduce((a, l, i) => asig[i].partida === p.partida ? a + (+l.cantidad || 0) : a, 0);
      const total = idx.reduce((a, i) => a + cg(lineas[i].kg), 0);
      const elegidas = total === falta ? idx : buscar(idx, falta, (p.bultos || 0) - ya);
      (elegidas || []).forEach(i => { asig[i] = { partida: p.partida, via: 'peso' }; });
    });
  });
  return asig;
}
// Peso, bultos e importe de la factura que caen en cada partida, y si cuadran con la G4
function gibResumenCruce(partidas, lineas){
  const r2 = v => Math.round(v * 100) / 100;
  return partidas.map(p => {
    const ls = lineas.filter(l => l.partida === p.partida);
    const kg = r2(ls.reduce((a, l) => a + (+l.kg || 0), 0)), bultos = ls.reduce((a, l) => a + (+l.cantidad || 0), 0);
    return { partida: p.partida, taric: p.taric, lineas: ls.length, kg, bultos, importe: r2(ls.reduce((a, l) => a + (+l.importe || 0), 0)),
             kgG4: p.peso, bultosG4: p.bultos, cuadraKg: Math.abs(kg - p.peso) < 0.005, cuadraBultos: bultos === p.bultos };
  });
}

// Fecha del día (hora de Madrid) en el formato de VisualTrans
const gibHoy = () => new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

function gibDocs(P, docs){ docs.slice(0, 15).forEach((d, k) => { const b = 17 + k * 3; P[b] = d[0] || ''; P[b + 1] = d[1] ?? ''; P[b + 2] = d[2] || ''; }); }
const gibParte = (C, ini, e) => { if(!e) return; C[ini] = e.nombre || ''; C[ini + 1] = e.nif || ''; C[ini + 2] = e.direccion || ''; C[ini + 3] = e.cp || ''; C[ini + 4] = e.poblacion || ''; C[ini + 5] = e.pais || ''; };
function gibCabeceraComun(C, lote, c){
  C[32] = lote.bultos; C[33] = lote.peso; C[34] = Math.round(lote.lineas.reduce((a, l) => a + l.neto, 0) * 1000) / 1000;
  C[35] = c.referencia || ''; C[36] = c.clienteNif || ''; C[39] = c.representanteNif || ''; C[40] = c.refInterna || c.referencia || '';
}

// H1 de importación con destino Gibraltar. valorH1: pendiente de criterio; si no se indica, el de la línea.
function gibFilasH1(lote){
  const c = lote.comun, reg = GIB_REGIMENES[c.regimen];
  const C = new Array(87).fill('');
  C[0] = 'H'; C[1] = 'H'; C[2] = 'IM'; C[3] = 'A'; C[5] = c.aduana;
  gibParte(C, 6, c.exportadorH1); gibParte(C, 12, c.importador);
  C[18] = c.paisExpedicionH1 || 'ES'; C[19] = 'GI'; C[21] = c.contenedor ?? 0; C[22] = c.incoterm || ''; C[23] = c.lugarIncoterm || '';
  C[26] = c.moneda || 'EUR'; C[27] = c.naturaleza ?? 1; C[28] = c.modoFrontera ?? 3; C[30] = c.localizacion?.aduana || ''; C[31] = c.localizacion?.codigo || '';
  gibCabeceraComun(C, lote, c);
  C[37] = c.totalFactura || '';
  const filas = [C, ['DOCS', 'N380', c.factura?.numero || '']];
  lote.lineas.forEach(l => {
    const P = new Array(105).fill('');
    P[0] = l.bultos; P[1] = l.peso; P[2] = l.neto; P[3] = l.descripcion;
    if(l.supl){ P[4] = l.supl.tipo; P[5] = l.supl.cant; }
    P[6] = l.taric10; P[7] = c.valorH1 > 0 ? c.valorH1 : l.valor; P[9] = l.origen;
    P[11] = l.mrn; P[12] = l.partida; P[13] = c.regimen; P[63] = '100'; P[65] = reg ? reg.adicional : '';
    P[68] = c.claseBultos || ''; P[103] = '1';
    const docs = [['N380', c.factura?.numero, c.factura?.fecha]];
    if(c.regimen === '71.00') docs.push(['7025', l.neto, c.fechaDeclaracion], ['7018', 'ES0', c.fechaDeclaracion]);
    if(c.imo) docs.push(['5012', c.imo, c.fechaDeclaracion]);
    gibDocs(P, docs);
    filas.push(P);
  });
  return filas;
}

// T1GI: se genera con el H1 ya presentado. cuotas: arancel por partida, solo en régimen 40 (1247).
function gibFilasT1GI(lote, mrnH1, cuotas = {}){
  const c = lote.comun, reg = GIB_REGIMENES[c.regimen];
  if(!mrnH1) throw new Error('El T1GI necesita el MRN del H1');
  const C = new Array(87).fill('');
  C[0] = 'NCTS5'; C[1] = 'T'; C[2] = 'T1GI'; C[3] = 'A'; C[5] = c.aduana;
  gibParte(C, 12, c.importador);
  C[18] = 'ES'; C[19] = 'GI'; C[21] = c.contenedor ?? 0; C[28] = ''; C[29] = c.aduanaDestinoT1GI || '';
  C[30] = c.localizacion?.aduana || ''; C[31] = c.localizacion?.codigo || '';
  gibCabeceraComun(C, lote, c);
  C[38] = c.modoInterior ?? 3; C[65] = c.transporte?.tipo || ''; C[71] = '0'; C[78] = c.transporte?.matricula || ''; C[79] = c.transporte?.pais || '';
  const filas = [C];
  if(c.transporte?.docRef) filas.push(['DOCS', c.transporte.docTipo, c.transporte.docRef]);
  if(c.garantia?.grn) filas.push(['GARANT', c.garantia.grn, c.garantia.importe ?? '']);
  if(c.precinto) filas.push(['CTNPREC', c.transporte?.matricula || '', c.precinto]);
  lote.lineas.forEach(l => {
    const P = new Array(77).fill('');
    P[0] = l.bultos; P[1] = l.peso; P[2] = l.neto; P[3] = l.descripcion; P[6] = l.taric; P[7] = l.valor; P[9] = l.origen;
    P[11] = mrnH1; P[68] = c.claseBultos || ''; P[76] = 'T1GI';
    const docs = [['N380', c.factura?.numero, c.factura?.fecha]];
    if(c.imo) docs.push(['5012', c.imo, c.fechaDeclaracion]);
    docs.push([reg.docTransito, 'NO MRN', '']);
    if(c.regimen === '40.00') docs.push(['1247', gibNumES(cuotas[l.partida]) || 0, '']);
    docs.push(['7020', l.valor, gibHoy()], ['7022', 0, ''], ['7024', 0, '']);
    gibDocs(P, docs);
    filas.push(P);
  });
  return filas;
}

// Reexportación 31.71 tras un H1 71.00 y su T1GI (avituallamiento: F61)
function gibFilasReexp(lote, mrnH1, mrnT1GI, fechaT1GI){
  const c = lote.comun;
  if(!mrnH1 || !mrnT1GI) throw new Error('La reexportación necesita el MRN del H1 y el del T1GI');
  const C = new Array(87).fill('');
  C[0] = 'AES'; C[1] = 'E'; C[2] = 'EX'; C[3] = 'A'; C[5] = c.aduana;
  gibParte(C, 6, c.exportadorReexp); gibParte(C, 12, c.destinatarioReexp || c.exportadorReexp);
  C[18] = 'GI'; C[19] = c.destinoReexp || 'QS'; C[21] = c.contenedor ?? 0; C[22] = c.incoterm || ''; C[23] = c.lugarIncoterm || '';
  C[24] = c.imo || ''; C[25] = c.banderaBuque || ''; C[26] = c.moneda || 'EUR'; C[27] = c.naturaleza ?? 1; C[28] = c.modoFronteraReexp ?? 1;
  C[29] = c.aduana; C[30] = c.ubicacionGibraltar?.aduana || ''; C[31] = c.ubicacionGibraltar?.codigo || '';
  gibCabeceraComun(C, lote, c);
  C[37] = c.totalFactura || ''; C[66] = c.tipoMedioFrontera || '';
  const filas = [C, ['DOCS', 'N380', c.factura?.numero || '']];
  lote.lineas.forEach(l => {
    const P = new Array(77).fill('');
    P[0] = l.bultos; P[1] = l.peso; P[2] = l.neto; P[3] = l.descripcion;
    if(l.supl){ P[4] = l.supl.tipo; P[5] = l.supl.cant; }
    P[6] = l.taric; P[7] = l.valor; P[9] = l.origen; P[11] = mrnH1; P[13] = '31.71'; P[65] = 'F61'; P[68] = c.claseBultos || '';
    const docs = [['N380', c.factura?.numero, c.factura?.fecha]];
    if(c.imo) docs.push(['5012', c.imo, c.fechaDeclaracion]);
    docs.push(['1241', mrnT1GI, fechaT1GI || c.fechaDeclaracion]);
    gibDocs(P, docs);
    filas.push(P);
  });
  return filas;
}

// Mismo formato que el resto de ficheros de VisualTrans: punto y coma, sin ; ni saltos dentro de un campo
function gibCsv(filas){
  const esc = v => String(v ?? '').replace(/;/g, ',').replace(/[\r\n]+/g, ' ');
  return '﻿' + filas.map(f => f.map(esc).join(';')).join('\r\n');
}

// T2GI tras una exportación (factura leída): mismas partidas que el EX, con su valor
// y gastos (7020/7022/7024) y el MRN del EX como documento precedente (casilla 40, N830).
function gibFilasT2GI(lote, mrnEx){
  const c = lote.comun;
  if(!mrnEx) throw new Error('El T2GI necesita el MRN de la exportación');
  const C = new Array(87).fill('');
  C[0] = 'NCTS5'; C[1] = 'T'; C[2] = 'T2GI'; C[3] = 'A'; C[5] = c.aduana;
  gibParte(C, 6, c.exportador); gibParte(C, 12, c.destinatario);
  C[18] = 'ES'; C[19] = 'GI'; C[21] = c.contenedor ?? 0; C[29] = c.aduanaDestinoT1GI || '';
  C[30] = c.localizacion?.aduana || ''; C[31] = c.localizacion?.codigo || '';
  gibCabeceraComun(C, lote, c);
  C[38] = c.modoInterior ?? 3; C[65] = c.transporte?.tipo || ''; C[71] = '0'; C[78] = c.transporte?.matricula || ''; C[79] = c.transporte?.pais || '';
  const filas = [C];
  if(c.transporte?.docRef) filas.push(['DOCS', c.transporte.docTipo, c.transporte.docRef]);
  if(c.garantia?.grn) filas.push(['GARANT', c.garantia.grn, c.garantia.importe ?? '']);
  if(c.precinto) filas.push(['CTNPREC', c.transporte?.matricula || '', c.precinto]);
  lote.lineas.forEach(l => {
    const P = new Array(77).fill('');
    P[0] = l.bultos; P[1] = l.peso; P[2] = l.neto; P[3] = l.descripcion; P[6] = l.taric; P[7] = l.valor; P[9] = l.origen;
    P[11] = mrnEx; P[68] = c.claseBultos || ''; P[76] = 'T2GI';
    gibDocs(P, [['N380', c.factura?.numero, c.factura?.fecha], ['7020', l.valor, gibHoy()], ['7022', 0, ''], ['7024', 0, '']]);
    filas.push(P);
  });
  return filas;
}

// T1 desde una G4 (Málaga → Algeciras, Algeciras → otro país…): cada partida data su partida de la G4.
function gibFilasT1(lote){
  const c = lote.comun, t = c.transporte || {};
  const C = new Array(87).fill('');
  C[0] = 'NCTS5'; C[1] = 'T'; C[2] = 'T1'; C[3] = 'A'; C[5] = c.aduana;
  gibParte(C, 6, c.expedidorT1); gibParte(C, 12, c.destinatarioT1);
  C[18] = 'ES'; C[19] = c.paisDestino || 'ES'; C[21] = c.contenedor ?? 0; C[29] = c.aduanaDestino || '';
  C[30] = c.localizacion?.aduana || ''; C[31] = c.localizacion?.codigo || '';
  gibCabeceraComun(C, lote, c);
  C[38] = c.modoInterior ?? 3; C[65] = t.tipo || ''; C[71] = '0'; C[78] = t.matricula || ''; C[79] = t.pais || '';
  const filas = [C];
  // El AWB va en cada partida; el CMR, en la cabecera
  const enPartida = t.docTipo === 'N740';
  if(t.docRef && !enPartida) filas.push(['DOCS', t.docTipo, t.docRef]);
  if(c.garantia?.grn) filas.push(['GARANT', c.garantia.grn, c.garantia.importe ?? '']);
  if(c.precinto) filas.push(['CTNPREC', t.matricula || '', c.precinto]);
  lote.lineas.forEach(l => {
    const P = new Array(77).fill('');
    P[0] = l.bultos; P[1] = l.peso; P[2] = l.neto; P[3] = l.descripcion; P[6] = l.taric; P[8] = c.marcas || '';
    P[11] = l.mrn; P[12] = l.partida; P[68] = c.claseBultos || ''; P[76] = 'T1';
    const docs = [['N380', c.factura?.numero, c.factura?.fecha]];
    if(t.docRef && enPartida) docs.push([t.docTipo, t.docRef, '']);
    gibDocs(P, docs);
    filas.push(P);
  });
  return filas;
}

// Pertrechos a un buque en puerto: exportación 31.00 F61 desde una G4
function gibFilasPertrechos(lote){
  const c = lote.comun, b = c.buque || {};
  const C = new Array(87).fill('');
  C[0] = 'AES'; C[1] = 'E'; C[2] = 'EX'; C[3] = 'A'; C[5] = c.aduana;
  gibParte(C, 6, c.exportadorPertrechos);
  gibParte(C, 12, { nombre: b.nombre, direccion: `BUQUE SURTO EN EL PUERTO DE ${b.puerto || ''} IMO ${b.imo || ''}`, cp: b.cp, poblacion: b.puerto, pais: 'ES' });
  C[18] = 'ES'; C[19] = 'QS'; C[21] = c.contenedor ?? 0; C[22] = c.incoterm || ''; C[23] = c.lugarIncoterm || ''; C[63] = 'ES';
  C[24] = b.nombre || ''; C[25] = b.bandera || ''; C[26] = c.moneda || 'EUR'; C[27] = c.naturaleza ?? 9; C[28] = 1;
  C[29] = c.aduanaSalida || c.aduana; C[30] = c.ubicacionEx?.aduana || ''; C[31] = c.ubicacionEx?.codigo || '';
  gibCabeceraComun(C, lote, c);
  C[37] = c.totalFactura || ''; C[38] = c.modoInterior ?? 3; C[65] = c.transporte?.tipo || ''; C[66] = '11'; C[78] = c.transporte?.matricula || ''; C[79] = c.transporte?.pais || '';
  const filas = [C, ['DOCS', 'N380', c.factura?.numero || '']];
  lote.lineas.forEach(l => {
    const P = new Array(77).fill('');
    P[0] = l.bultos; P[1] = l.peso; P[2] = l.neto; P[3] = l.descripcion; P[6] = c.taricPertrechos || '99309900'; P[7] = l.valor; P[8] = c.marcas || ''; P[9] = l.origen; P[10] = c.provincia || '';
    // Tantas partidas como la G4. Con una sola, casilla 40 sin nº de partida, como se presenta
    P[11] = l.mrn; if(lote.lineas.length > 1) P[12] = l.partida; P[13] = '31.00'; P[65] = 'F61'; P[68] = c.claseBultos || '';
    gibDocs(P, [['N380', c.factura?.numero, c.factura?.fecha], ['5012', `${b.bandera || ''} ${b.imo || ''}`.trim(), c.fechaDeclaracion], ['1410', 'NO VETER', c.fechaDeclaracion]]);
    filas.push(P);
  });
  return filas;
}
