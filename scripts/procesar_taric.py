#!/usr/bin/env python3
"""
Procesa una extracción TARIC de CIRCABC y la carga en Supabase.

Lo ejecuta GitHub Actions cuando el portal sube los ficheros al bucket
'taric-updates'. La carga va dentro de UNA transacción: si algo falla,
el catálogo antiguo sigue intacto.
"""
import os, re, sys, csv, json, subprocess, collections
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import requests
import openpyxl

def _env(nombre):
    v = os.environ.get(nombre, '').strip()
    if not v:
        print(f'[taric] FALTA la variable {nombre}. Revisa los secrets del repo '
              f'y que el campo id/extraccion del "Run workflow" no vaya vacío.', flush=True)
        sys.exit(2)
    return v

SB   = _env('SUPABASE_URL').rstrip('/')
SRV  = _env('SUPABASE_SERVICE_ROLE_KEY')
DB   = _env('SUPABASE_DB_URL')
ACT  = _env('ACT_ID')
EXTR = _env('EXTRACCION')

# Con la clave publishable, RLS se aplica y todo devuelve 200 con cero filas:
# ni error ni datos. Es el fallo más difícil de diagnosticar, así que se corta aquí.
if SRV.startswith('sb_publishable_') or SRV.startswith('sbp_'):
    print('[taric] ERROR: SUPABASE_SERVICE_ROLE_KEY contiene la clave PUBLISHABLE, '
          'no la service role. Con esa clave el Action no ve ni las filas ni los '
          'ficheros del bucket. Cópiala de Project Settings → API Keys → service_role '
          '(empieza por sb_secret_ o eyJ).', flush=True)
    sys.exit(2)

H = {'apikey': SRV, 'Authorization': f'Bearer {SRV}'}
WORK = 'taric_work'
os.makedirs(WORK, exist_ok=True)


def estado(**campos):
    """Actualiza la fila de control. Avisa si no llega a escribir nada:
    un id inexistente devolvería 200 sin tocar ninguna fila."""
    try:
        r = requests.patch(f'{SB}/rest/v1/taric_actualizaciones?id=eq.{ACT}',
                           headers={**H, 'Content-Type': 'application/json',
                                    'Prefer': 'return=representation'},
                           json=campos, timeout=30)
        if r.status_code >= 300:
            print(f'[taric] aviso: no se pudo escribir el estado ({r.status_code}) {r.text[:200]}', flush=True)
        elif r.json() == []:
            print(f'[taric] AVISO: no existe ninguna fila con id={ACT} en '
                  f'taric_actualizaciones. El proceso sigue, pero el portal no '
                  f'verá el progreso.', flush=True)
    except Exception as e:
        print(f'[taric] aviso: fallo al escribir estado: {e}', flush=True)


def log(msg):
    print(f'[taric] {msg}', flush=True)


def listar_bucket(prefijo=''):
    """Lista lo que hay realmente en el bucket, para diagnosticar rutas."""
    try:
        r = requests.post(f'{SB}/storage/v1/object/list/taric-updates',
                          headers={**H, 'Content-Type': 'application/json'},
                          json={'prefix': prefijo, 'limit': 100,
                                'sortBy': {'column': 'name', 'order': 'asc'}},
                          timeout=60)
        if r.status_code >= 300:
            return f'(no se pudo listar: {r.status_code} {r.text[:150]})'
        items = r.json()
        if not items:
            return '(vacío)'
        return ', '.join(i.get('name', '?') for i in items)
    except Exception as e:
        return f'(error al listar: {e})'


def _items_bucket(prefijo=''):
    """Devuelve la lista de nombres de ficheros del bucket bajo un prefijo."""
    try:
        r = requests.post(f'{SB}/storage/v1/object/list/taric-updates',
                          headers={**H, 'Content-Type': 'application/json'},
                          json={'prefix': prefijo, 'limit': 1000,
                                'sortBy': {'column': 'name', 'order': 'asc'}},
                          timeout=60)
        if r.status_code >= 300:
            return []
        return [i.get('name', '') for i in r.json() if i.get('name')]
    except Exception:
        return []


def ficheros_de_la_actualizacion():
    """Qué ficheros procesar en esta tanda. Primero la lista registrada por el
    portal (taric_actualizaciones.ficheros); si no está, lo que haya en la carpeta
    del bucket. Así el usuario sube los que quiera, con el nombre que sea."""
    try:
        r = requests.get(f'{SB}/rest/v1/taric_actualizaciones?id=eq.{ACT}&select=ficheros',
                         headers=H, timeout=30)
        if r.ok and r.json():
            fs = r.json()[0].get('ficheros') or []
            fs = [n for n in fs if str(n).lower().endswith('.xlsx')]
            if fs:
                return fs
    except Exception:
        pass
    return [n for n in _items_bucket(EXTR + '/') if str(n).lower().endswith('.xlsx')]


def _norm(s):
    return re.sub(r'\s+', ' ', str(s or '').strip().lower())


def detectar_tipo(ruta):
    """Identifica QUÉ es el fichero por su CONTENIDO (cabeceras / hojas), no por su
    nombre. Devuelve 'nomenclatura' | 'medidas' | 'casilla44' | 'correlacion' | None.
    None = fichero sin contenido relevante (footnotes, conditions, additional...) → se descarta.
    Firmas únicas verificadas contra los ficheros oficiales de CIRCABC:
      · Nomenclature_EN      → cabecera con 'goods code' + 'indent'
      · TARIC_measures       → cabecera con 'red_ind'
      · Box_44_codes_...     → cabecera con 'certificate code'
      · Correlation tables   → hojas 'New codes' + 'Old codes'
    """
    try:
        wb = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    except Exception as e:
        log(f'  no se pudo abrir {os.path.basename(ruta)}: {e}')
        return None
    try:
        nombres = [str(s).lower() for s in wb.sheetnames]
        if any(n.startswith('new') for n in nombres) and any(n.startswith('old') for n in nombres):
            return 'correlacion'
        ws = wb[wb.sheetnames[0]]
        cab = set()
        for r in ws.iter_rows(values_only=True):
            cab = {_norm(c) for c in r}
            break
        if 'certificate code' in cab:
            return 'casilla44'
        if 'red_ind' in cab:
            return 'medidas'
        if 'indent' in cab and 'goods code' in cab:
            return 'nomenclatura'
        return None
    finally:
        wb.close()


def descargar(nombre):
    """Baja un fichero del bucket privado. Devuelve None si no está."""
    url = f'{SB}/storage/v1/object/taric-updates/{EXTR}/{nombre}'
    destino = f'{WORK}/{nombre}'
    log(f'descargando {nombre}...')
    with requests.get(url, headers=H, stream=True, timeout=900) as r:
        if r.status_code in (400, 404):
            cuerpo = r.content[:200].decode('utf-8', 'replace')
            log(f'  no encontrado ({r.status_code}) {cuerpo}')
            return None
        r.raise_for_status()
        with open(destino, 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    log(f'  {os.path.getsize(destino)/1e6:.1f} MB')
    return destino


# ══════════ Categorías paraduaneras ══════════
CAT = {
    '726': ('OZONO', 'Sustancias que agotan la capa de ozono'),
    '724': ('FGAS', 'Gases fluorados de efecto invernadero'),
    '711': ('DOBLE_USO', 'Productos y tecnologías de doble uso'),
    '738': ('MILITAR', 'Lista Común Militar (CML)'),
    '755': ('RESIDUOS', 'Traslado de residuos'),
    '734': ('PATRIMONIO', 'Bienes culturales / patrimonio'),
    '710': ('CITES', 'CITES - especies protegidas'),
    '410': ('VETERINARIO', 'Control veterinario (CHED-A/P)'),
    '415': ('FITOSANITARIO', 'Control oficial de vegetales (CHED-PP)'),
    '722': ('ALIMENTARIO', 'Restricción alimentos y piensos'),
    '750': ('ECOLOGICO', 'Control de productos ecológicos'),
    '761': ('REACH', 'REACH - sustancias químicas'),
    '769': ('POP', 'Contaminantes orgánicos persistentes'),
    '748': ('MERCURIO', 'Mercurio'),
    '713': ('OMG', 'Organismos modificados genéticamente'),
    '747': ('FLEGT', 'Madera - licencia FLEGT'),
    '770': ('FLEGT', 'Madera - licencia FLEGT (Ghana)'),
    '719': ('PESCA_INDNR', 'Pesca ilegal no declarada (INDNR)'),
    '746': ('FOCA', 'Productos derivados de la foca'),
    '745': ('PIEL_PERRO_GATO', 'Piel de perro y gato'),
    '728': ('LUJO', 'Bienes de lujo (sanciones)'),
    '705': ('TORTURA', 'Bienes para tortura o represión'),
    '712': ('EEI', 'Especies exóticas invasoras'),
    '775': ('CBAM', 'Mecanismo de ajuste en frontera por carbono'),
    '730': ('PRE_EXPORT', 'Verificación previa a la exportación'),
    '277': ('PROHIBICION', 'Prohibición de importación'),
    '465': ('RESTRICCION', 'Restricción de despacho a libre práctica'),
    '475': ('RESTRICCION', 'Restricción de despacho a libre práctica'),
    '474': ('LIMITE_CUANT', 'Limitación cuantitativa'),
    '552': ('ANTIDUMPING', 'Derecho antidumping definitivo'),
    '551': ('ANTIDUMPING', 'Derecho antidumping provisional'),
    '554': ('ANTISUBVENCION', 'Derecho compensatorio definitivo'),
    '564': ('ANTIDUMPING_REG', 'Registro antidumping/compensatorio'),
    '109': ('UNIDAD_SUPL', 'Unidad suplementaria'),
    '110': ('UNIDAD_SUPL', 'Unidad suplementaria (importación)'),
}
SANCIONES = {'707', '714', '731', '732', '760', '762', '763'}


def categoria_de(codigo, base):
    if codigo in CAT:
        return CAT[codigo]
    if codigo in SANCIONES:
        b = base or ''
        if any(x in b for x in ('0833/14', '0263/22', '0692/14', '0813/25')):
            return ('SANCION_RU', 'Sanciones Rusia / territorios ocupados de Ucrania')
        if '0267/12' in b:  return ('SANCION_IR', 'Sanciones Irán')
        if '1509/17' in b:  return ('SANCION_KP', 'Sanciones Corea del Norte')
        if '0765/06' in b or '1793/19' in b: return ('SANCION_BY', 'Sanciones Bielorrusia')
        return ('SANCION', 'Sanciones / medidas restrictivas')
    return None


def _fecha_iso(v):
    """Normaliza una fecha (datetime, 'YYYY-MM-DD…', 'DD-MM-YYYY', 'DD/MM/YYYY') a
    'YYYY-MM-DD'. Vacío/None → None. Así inicio/fin se comparan bien como texto."""
    if v is None:
        return None
    if hasattr(v, 'date'):
        return v.date().isoformat()
    t = str(v).strip()
    if not t:
        return None
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', t)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
    m = re.match(r'^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})', t)
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    return None


def _se_solapan(ini_a, fin_a, ini_b, fin_b):
    """¿Coinciden en algún día las vigencias [ini_a, fin_a] y [ini_b, fin_b]?"""
    if fin_a and ini_b and ini_b > fin_a:
        return False
    if fin_b and ini_a and ini_a > fin_b:
        return False
    return True


def procesar_nomenclatura(ruta):
    wb = openpyxl.load_workbook(ruta, read_only=True)
    ws = wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True); next(it)
    # Primero se recogen las filas en orden, con su nivel jerárquico (r[4] = "Hier.
    # Pos."), para poder decidir cuáles son HOJA. Un código no es declarable solo por
    # tener sufijo 80: si la fila SIGUIENTE baja un nivel (nivel mayor), es una
    # CABECERA con subdivisiones (p. ej. 0702000000 "Tomatoes" o 0702001000 "Whole
    # tomatoes") y NO debe ofrecerse como código despachable. Solo las hojas reales
    # (0702001007 cherry, 0702001099 los demás…) son declarables.
    crudas = []
    for r in it:
        m = re.match(r'^(\d{10})\s+(\d{2})$', str(r[0] or '').strip())
        if not m:
            continue
        cod, suf = m.group(1), m.group(2)
        nivel = r[4]
        crudas.append((cod, suf, nivel, (r[5] or '').strip(),
                       (r[6] or '').strip(), _fecha_iso(r[1]), _fecha_iso(r[2])))

    def _niv(x):
        try: return int(str(x).strip())
        except Exception: return None

    filas = []
    n_hoja = n_cabecera = 0
    for i, (cod, suf, nivel, indent, desc, ini, fin) in enumerate(crudas):
        declarable = 0
        if suf == '80':
            cur = _niv(nivel)
            # Es CABECERA si tiene algún hijo (fila siguiente de nivel más profundo)
            # cuya vigencia coincida con la suya. Un hijo que nace cuando el padre ya
            # ha muerto (p. ej. 0201300000 vigente hasta 31/12/2026 y sus nuevos
            # 0201301000/0201309000 desde 01/01/2027) NO lo convierte en cabecera:
            # el padre sigue siendo despachable hasta su fecha de fin.
            tiene_hijo = False
            if cur is not None:
                j = i + 1
                while j < len(crudas):
                    nj = _niv(crudas[j][2])
                    if nj is None or nj <= cur:
                        break
                    if _se_solapan(ini, fin, crudas[j][5], crudas[j][6]):
                        tiene_hijo = True
                        break
                    j += 1
            if not tiene_hijo:
                declarable = 1; n_hoja += 1
            else:
                n_cabecera += 1   # cabecera con subdivisiones → no despachable
        filas.append([cod, suf, cod[:8], cod[:4], cod[:2],
                      declarable, nivel, indent, desc, ini, fin])
    wb.close()
    ruta_csv = f'{WORK}/nom.csv'
    with open(ruta_csv, 'w', newline='', encoding='utf-8') as f:
        csv.writer(f).writerows(filas)
    log(f'nomenclatura: {len(filas):,} filas · {n_hoja:,} hojas declarables · '
        f'{n_cabecera:,} cabeceras no despachables')
    hoy = datetime.now(ZoneInfo('Europe/Madrid')).date().isoformat()
    futuros = sum(1 for f in filas if f[5] == 1 and f[9] and f[9] > hoy)
    vencidos = sum(1 for f in filas if f[5] == 1 and f[10] and f[10] < hoy)
    if futuros or vencidos:
        log(f'vigencia por fecha: {futuros:,} códigos aún no vigentes (se activarán solos) · '
            f'{vencidos:,} ya vencidos (el portal no los ofrece)')
    return ruta_csv, len(filas)


def procesar_medidas(ruta):
    wb = openpyxl.load_workbook(ruta, read_only=True)
    vistos, filas, n = set(), [], 0
    for sh in wb:
        it = sh.iter_rows(values_only=True); next(it, None)
        for r in it:
            n += 1
            # Latido cada 200.000 filas: sin esto el proceso pasa 10 minutos
            # mudo y no hay forma de saber si avanza o está colgado.
            if n % 200000 == 0:
                log(f'  ...{n:,} filas leídas, {len(filas):,} retenidas')
                estado(mensaje=f'Procesando medidas: {n:,} filas leídas')
            tipo = str(r[11]).strip() if r[11] else ''
            c = categoria_de(tipo, r[8])
            if not c:
                continue
            cod = str(r[0] or '').strip()
            if not re.match(r'^\d{10}$', cod):
                continue
            origen = (r[6] or '').strip()
            k = (cod, c[0], origen)
            if k in vistos:
                continue
            vistos.add(k)
            derecho = (r[9] or '').strip()
            certs = sorted({m.group(1) + m.group(2)
                            for m in re.finditer(r'\b([A-Z])-?(\d{3})\b', derecho)})
            reales = [x for x in certs if x[0] in 'NCLAU']
            erga = 1 if origen.upper() in ('ERGA OMNES', '', 'ALL THIRD COUNTRIES') else 0
            if reales:                              exig = 'DOCUMENTO'
            elif certs:                             exig = 'ATESTACION_Y'
            elif c[0] in ('PROHIBICION', 'RESTRICCION', 'LIMITE_CUANT'): exig = 'PROHIBICION'
            elif c[0] in ('ANTIDUMPING', 'ANTISUBVENCION', 'UNIDAD_SUPL'): exig = 'ARANCELARIA'
            else:                                   exig = 'REVISAR'
            filas.append([cod, cod[:8], c[0], c[1], tipo, (r[7] or '').strip(),
                          origen, (r[10] or '').strip(), (r[8] or '').strip(), derecho,
                          r[3].date().isoformat() if hasattr(r[3], 'date') else None,
                          r[4].date().isoformat() if hasattr(r[4], 'date') else None,
                          '|'.join(certs), erga, exig])
    wb.close()
    ruta_csv = f'{WORK}/med.csv'
    with open(ruta_csv, 'w', newline='', encoding='utf-8') as f:
        csv.writer(f).writerows(filas)
    log(f'medidas: {n:,} leídas, {len(filas):,} retenidas')
    return ruta_csv, len(filas)


def procesar_casilla44(ruta):
    wb = openpyxl.load_workbook(ruta, read_only=True)
    it = wb[wb.sheetnames[0]].iter_rows(values_only=True); next(it)
    filas = [[str(r[0]).strip(), (r[2] or '').strip(), r[3], r[5]]
             for r in it if r[1] == 'ES' and not r[5]]
    wb.close()
    ruta_csv = f'{WORK}/c44.csv'
    with open(ruta_csv, 'w', newline='', encoding='utf-8') as f:
        csv.writer(f).writerows(filas)
    log(f'casilla 44: {len(filas):,} códigos')
    return ruta_csv, len(filas)


def retirados_de_correlaciones(rutas):
    """Lee las tablas de correlación CN y devuelve {codigo10: fecha_fin_iso|None}
    de los códigos RETIRADOS que deben cerrarse (declarable=0).

    Regla de seguridad: solo se cierran los retirados que NO reaparecen como
    'New codes' en ninguna tabla. Los 'circulares' (nuevo en una tabla y retirado
    en otra, según el periodo) se DEJAN activos para no matar un código que vuelve
    a ser válido; se registran en el log para revisión manual."""
    nuevos = set()
    retirados = {}   # codigo -> fecha_fin_iso|None
    for ruta in rutas:
        try:
            wb = openpyxl.load_workbook(ruta, data_only=True, read_only=True)
        except Exception as e:
            log(f'  aviso: no se pudo abrir {os.path.basename(ruta)}: {e}')
            continue
        for name in wb.sheetnames:
            low = name.lower()
            it = wb[name].iter_rows(values_only=True)
            next(it, None)   # cabecera
            if low.startswith('new'):
                for r in it:
                    c = str(r[0] or '').split()[0] if r and r[0] else ''
                    if c.isdigit() and len(c) == 10:
                        nuevos.add(c)
            elif low.startswith('old'):
                for r in it:
                    if not r or not r[0]:
                        continue
                    c = str(r[0]).split()[0]
                    if not (c.isdigit() and len(c) == 10):
                        continue
                    fin = r[2] if len(r) > 2 else None
                    fin = fin.date().isoformat() if hasattr(fin, 'date') else None
                    # si el mismo código aparece varias veces, nos quedamos con una fecha
                    if c not in retirados or (fin and not retirados[c]):
                        retirados[c] = fin
        wb.close()

    muertos = {c: f for c, f in retirados.items() if c not in nuevos}
    circulares = sorted(c for c in retirados if c in nuevos)
    # Nota: 'muertos' son candidatos; el UPDATE solo afecta a los que existan como
    # declarables en la nomenclatura recién cargada (el resto son no-ops).
    log(f'correlaciones: {len(retirados)} retirados · {len(muertos)} candidatos a cerrar · '
        f'{len(circulares)} circulares (se dejan activos)')
    if circulares:
        log(f'  circulares (revisar a mano): {", ".join(circulares)}')
    return muertos


def cargar(nom_csv=None, med_csv=None, c44_csv=None, muertos=None):
    """Carga PARCIAL y atómica: actualiza SOLO las tablas cuyos ficheros se han
    aportado en esta tanda. Todo en una transacción (o entra completo o nada).
      · nom_csv  → reconstruye taric_nomenclatura
      · muertos  → cierra (declarable=0) los códigos retirados sobre la nomenclatura
                   que quede en la tabla (la recién cargada, o la existente si no se
                   subió nomenclatura: así valen las correlaciones por sí solas)
      · med_csv  → reconstruye taric_medidas
      · c44_csv  → reconstruye taric_casilla44
    """
    sql = ['\\set ON_ERROR_STOP on', 'BEGIN;']
    if nom_csv:
        sql.append('DELETE FROM public.taric_nomenclatura;')
        sql.append(f"\\copy public.taric_nomenclatura (codigo,sufijo,nc8,partida4,capitulo,declarable,nivel,indent,descripcion,inicio,fin) FROM '{nom_csv}' WITH (FORMAT csv)")
    # Cierre de códigos NC retirados (tablas de correlación): el loader del portal
    # solo filtra por 'declarable', así que se pone declarable=0 (y fin, para el
    # registro). Se aplica sobre la nomenclatura recién cargada, o sobre la ya
    # existente si esta tanda es SOLO correlaciones.
    if muertos:
        # Vigencia por FECHA: un código con fin futuro (p. ej. 31/12/2026) NO se
        # retira hoy; solo se le anota la fecha de fin y el portal deja de ofrecerlo
        # automáticamente al día siguiente. Solo se marca declarable=0 lo que ya ha
        # vencido o no trae fecha.
        hoy = datetime.now(ZoneInfo('Europe/Madrid')).date().isoformat()
        porfin = collections.defaultdict(list)
        for cod, fin in muertos.items():
            porfin[fin].append(str(cod).replace("'", ""))   # saneado defensivo
        for fin, cods in porfin.items():
            lista = "','".join(cods)
            valfin = f"'{fin}'" if fin else "fin"
            if fin and fin >= hoy:
                sql.append(f"UPDATE public.taric_nomenclatura SET "
                           f"fin=COALESCE(NULLIF(fin,''),{valfin}) "
                           f"WHERE sufijo='80' AND codigo IN ('{lista}');")
            else:
                sql.append(f"UPDATE public.taric_nomenclatura SET declarable=0, "
                           f"fin=COALESCE(NULLIF(fin,''),{valfin}) "
                           f"WHERE sufijo='80' AND codigo IN ('{lista}');")
    if med_csv:
        sql.append('DELETE FROM public.taric_medidas;')
        sql.append(f"\\copy public.taric_medidas (codigo,nc8,categoria,etiqueta,tipo_medida,desc_medida,origen,origen_code,base_legal,derecho,inicio,fin,certificados,erga_omnes,exigencia) FROM '{med_csv}' WITH (FORMAT csv)")
    if c44_csv:
        sql.append('DELETE FROM public.taric_casilla44;')
        sql.append(f"\\copy public.taric_casilla44 (codigo,descripcion,inicio,fin) FROM '{c44_csv}' WITH (FORMAT csv)")
    sql.append('COMMIT;')

    ruta = f'{WORK}/carga.sql'
    open(ruta, 'w', encoding='utf-8').write('\n'.join(sql) + '\n')
    log('cargando en Supabase...')
    r = subprocess.run(['psql', DB, '-v', 'ON_ERROR_STOP=1', '-f', ruta],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'psql falló: {r.stderr[-1500:]}')
    log('carga completada')


def main():
    log(f'parámetros · id={ACT} · extracción={EXTR} · proyecto={SB}')
    estado(estado='procesando', mensaje='Comprobando conexión')

    # Fallar rápido: mejor un error a los 2 segundos que tras 10 minutos
    # de parseo. Verifica de paso que el pooler y la contraseña son buenos.
    r = subprocess.run(['psql', DB, '-tAc', 'SELECT count(*) FROM public.taric_medidas;'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'No se pudo conectar a la base: {r.stderr.strip()[-400:]}')
    log(f'conexión OK · medidas actuales: {r.stdout.strip()}')

    estado(mensaje='Descargando ficheros del bucket')

    # Descarga TODO lo que haya en la tanda e identifica cada fichero por su
    # CONTENIDO (no por el nombre). Lo irrelevante se descarta.
    nombres = ficheros_de_la_actualizacion()
    if not nombres:
        log(f'contenido de taric-updates/{EXTR}/ : {listar_bucket(EXTR + "/")}')
        raise RuntimeError(f'No hay ficheros .xlsx en taric-updates/{EXTR}/.')

    tipos = {'nomenclatura': None, 'medidas': None, 'casilla44': None}
    correlaciones = []
    descartados = []
    for n in nombres:
        ruta = descargar(n)
        if not ruta:
            continue
        t = detectar_tipo(ruta)
        if t == 'correlacion':
            correlaciones.append(ruta)
            log(f'  → {n}: tabla de correlación')
        elif t in tipos:
            if tipos[t]:
                log(f'  aviso: {n} es otra {t}; se usa la última')
            tipos[t] = ruta
            log(f'  → {n}: {t}')
        else:
            descartados.append(n)
            log(f'  → {n}: sin contenido relevante, descartado')
    if descartados:
        log(f'descartados ({len(descartados)}): {", ".join(descartados)}')

    if not any(tipos.values()) and not correlaciones:
        raise RuntimeError('Ningún fichero aportado contiene datos TARIC reconocibles '
                           '(nomenclatura, medidas, casilla 44 o tabla de correlación).')

    # Procesar solo lo aportado
    nom_csv = med_csv = c44_csv = None
    n_nom = n_med = n_c44 = 0
    muertos = {}

    if tipos['nomenclatura']:
        estado(mensaje='Procesando nomenclatura')
        nom_csv, n_nom = procesar_nomenclatura(tipos['nomenclatura'])
        if n_nom < 10000:
            raise RuntimeError(f'Nomenclatura con muy pocas filas ({n_nom}); no se carga.')

    if tipos['medidas']:
        estado(mensaje='Procesando medidas (puede tardar varios minutos)')
        med_csv, n_med = procesar_medidas(tipos['medidas'])
        if n_med < 10000:
            raise RuntimeError(f'Medidas con muy pocas filas ({n_med}); no se carga.')

    if tipos['casilla44']:
        estado(mensaje='Procesando casilla 44')
        c44_csv, n_c44 = procesar_casilla44(tipos['casilla44'])

    if correlaciones:
        estado(mensaje='Aplicando tablas de correlación (códigos retirados)')
        muertos = retirados_de_correlaciones(correlaciones)

    estado(mensaje='Cargando en la base de datos')
    cargar(os.path.abspath(nom_csv) if nom_csv else None,
           os.path.abspath(med_csv) if med_csv else None,
           os.path.abspath(c44_csv) if c44_csv else None,
           muertos)

    partes = []
    if nom_csv: partes.append(f'nomenclatura {n_nom:,}')
    if med_csv: partes.append(f'medidas {n_med:,}')
    if c44_csv: partes.append(f'casilla44 {n_c44:,}')
    if muertos: partes.append(f'{len(muertos)} retirados cerrados')
    resumen = ' · '.join(partes) if partes else 'sin cambios'
    estado(estado='ok', filas_nom=n_nom, filas_med=n_med, filas_c44=n_c44,
           mensaje=f'Actualización {EXTR}: {resumen}',
           terminado_en=datetime.now(timezone.utc).isoformat())
    log(f'LISTO · {resumen}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'ERROR: {e}')
        estado(estado='error', mensaje=str(e)[:500],
               terminado_en=datetime.now(timezone.utc).isoformat())
        sys.exit(1)
