# Genera notas-nc.json desde el HTML oficial de EUR-Lex de las Notas explicativas de la NC.
# Uso: python construir_notas_nc.py c119.html "Nomenclature EN.csv" notas-nc.json  (requiere beautifulsoup4)
# HTML: https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=OJ:C:2019:119:FULL
# Trocea las Notas explicativas de la NC (DO C 119 de 29.3.2019, HTML de EUR-Lex) por capítulo y código
import sys, re, json, csv
from bs4 import BeautifulSoup, NavigableString, Tag
html_path, nom_csv, out = sys.argv[1], sys.argv[2], sys.argv[3]
soup = BeautifulSoup(open(html_path, encoding='utf-8').read(), 'html.parser')
def limpia(s):
    s = s.replace('\xa0', ' ')
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'\s+([,.;:)\]»])', r'\1', s); s = re.sub(r'([(\[«])\s+', r'\1', s)
    return s
def filas_tabla(tabla):
    out = []
    for tr in tabla.find_all('tr'):
        if tr.find_parent('table') is not tabla: continue
        celdas = [' '.join(lineas(td)) for td in tr.find_all('td', recursive=False)]
        t = limpia(' '.join(c for c in celdas if c))
        if t: out.append(t)
    return out
def lineas(el):
    out = []
    for ch in el.children:
        if isinstance(ch, NavigableString):
            t = limpia(str(ch))
            if t: out.append(t)
        elif ch.name == 'p':
            t = limpia(ch.get_text(' '))
            if t: out.append(t)
        elif ch.name == 'table':
            out.extend(filas_tabla(ch))
        elif isinstance(ch, Tag):
            out.extend(lineas(ch))
    return out
def codigos(cel):
    cel = cel.replace('\xa0', ' ').strip()
    if not re.match(r'^(ex )?\d{4}', cel): return None
    if re.search(r'\s(a|to)\s', cel):
        a, b = re.split(r'\s(?:a|to)\s', cel, maxsplit=1)
        return [['R', re.sub(r'\D', '', a), re.sub(r'\D', '', b)]]
    return [re.sub(r'\D', '', c) for c in re.split(r'\sy\s|,', cel) if re.search(r'\d', c)]
nom = set()
for r in csv.reader(open(nom_csv, encoding='utf-8')):
    m = re.fullmatch(r'(\d{10}) 80', (r[0] if r else '').strip())
    if m and not (len(r) > 2 and r[2].strip()): nom.add(m.group(1))
nom8 = {c[:8] for c in nom}; nom6 = {c[:6] for c in nom}; nom4 = {c[:4] for c in nom}
def existe(c):
    return (c in nom4) if len(c) == 4 else (c in nom6) if len(c) == 6 else (c in nom8) if len(c) == 8 else True
caps, secs, sec_de, ent = {}, {}, {}, []
estado = {'sec': None, 'cap': None, 'dest': None}
def añade_general(texto):
    if estado['cap']: caps.setdefault(estado['cap'], []).append(texto)
    elif estado['sec']: secs.setdefault(estado['sec'], []).append(texto)
cuerpo = soup.find('body')
def recorre(el):
    for ch in el.children:
        if not isinstance(ch, Tag): continue
        cls = ch.get('class') or []
        if ch.name == 'p' and 'ti-grseq-1' in cls:
            t = limpia(ch.get_text(' '))
            m = re.match(r'SECCIÓN ([IVXL]+)$', t); m2 = re.match(r'CAPÍTULO (\d+)$', t)
            if m: estado.update(sec=m.group(1), cap=None)
            elif m2:
                estado['cap'] = m2.group(1).zfill(2)
                if estado['sec']: sec_de[estado['cap']] = estado['sec']
            elif t == 'PREFACIO': estado.update(sec=None, cap=None)
            else: añade_general('## ' + t) if (estado['cap'] or estado['sec']) and not (estado['cap'] in caps or estado['sec'] in secs) else None
            continue
        if ch.name == 'tr' and 'table' in cls and ch.find_parent('td') is None:
            tds = ch.find_all('td', recursive=False)
            if len(tds) < 2: continue
            cel = limpia(tds[0].get_text(' '))
            cuerpo_t = lineas(tds[1])
            cs = codigos(cel)
            if cs:
                titulo = cuerpo_t[0] if cuerpo_t else ''
                ent.append({'cap': estado['cap'], 'c': cs, 'cel': cel, 'tit': titulo, 't': cuerpo_t[1:]})
            elif not cel and ent:
                ent[-1]['t'].extend(cuerpo_t)
            elif estado['cap']:
                añade_general(f'{cel}: ' + ' '.join(cuerpo_t))
            continue
        if ch.name in ('p', 'table') and (estado['cap'] or estado['sec']) and not ch.find('tr', class_='table'):
            for t in filas_tabla(ch) if ch.name == 'table' else [limpia(ch.get_text(' '))]:
                if t: añade_general(t)
            continue
        recorre(ch)
recorre(cuerpo)
def plano(c):
    return [x for x in c if isinstance(x, str)] + [y for x in c if isinstance(x, list) for y in x[1:]]
salida = {
  'fuente': 'Notas explicativas de la Nomenclatura Combinada de la Unión Europea, DO C 119 de 29.3.2019',
  'url': 'https://eur-lex.europa.eu/legal-content/ES/TXT/?uri=OJ:C:2019:119:FULL',
  'capitulos': {k: '\n'.join(v) for k, v in caps.items()},
  'secciones': {k: '\n'.join(v) for k, v in secs.items()},
  'seccionDe': sec_de,
  'notas': [{'cap': e['cap'], 'c': e['c'], 'cel': e['cel'], 'tit': e['tit'], 't': '\n'.join(e['t']),
             'obs': [x for x in e['c'] if isinstance(x, str) and not existe(x)]} for e in ent]
}
json.dump(salida, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
n = salida['notas']
print('capítulos', len(caps), 'secciones', len(secs), 'notas', len(n), 'con códigos ya inexistentes', sum(1 for x in n if x['obs']))
print('tamaño', len(open(out, encoding='utf-8').read()))
