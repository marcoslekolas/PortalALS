# Añade a notas-nc.json las modificaciones de las notas publicadas después del consolidado.
# Uso: python modificaciones_notas_nc.py base.json notas-nc.json CELEX:fecha:fichero.html ...
# Lista de modificaciones: SPARQL de publications.europa.eu, títulos "Notas explicativas de la nomenclatura combinada".
# Añade a notas-nc.json las modificaciones publicadas después de la versión consolidada
import sys, re, json, html as H
base, out = sys.argv[1], sys.argv[2]
mods = sys.argv[3:]   # ficheros html de EUR-Lex: CELEX:fecha:ruta
d = json.load(open(base, encoding='utf-8'))
COD = r'\d{4}(?: \d{2}){0,3}'
def texto(ruta):
    s = open(ruta, encoding='utf-8').read()
    figuras = len(re.findall(r'<img', s))
    s = re.sub(r'(?s)<script.*?</script>|<style.*?</style>', '', s)
    s = re.sub(r'</p>|<br\s*/?>|</tr>|</div>', '\n', s)
    t = H.unescape(re.sub(r'<[^>]+>', ' ', s)).replace('\xa0', ' ')
    t = '\n'.join(re.sub(r'\s+', ' ', l).strip() for l in t.split('\n'))
    t = re.sub(r'\n{2,}', '\n', t)
    t = re.sub(r'\s+([,.;:)\]»])', r'\1', t); t = re.sub(r'([(\[«])\s+', r'\1', t)
    i = t.find('se modifican como sigue:'); j = t.find('Reglamento (CEE) n.', i + 30)
    return t[i + len('se modifican como sigue:'):j if j > 0 else None].strip(), figuras
nuevas = []
for arg in mods:
    celex, fecha, ruta = arg.split(':', 2)
    cuerpo, figuras = texto(ruta)
    cuerpo = re.sub(r'\(\s*1\s*\)\s*$', '', cuerpo).strip()
    partes = [p.strip() for p in re.split(r'(?i)(?=\ben la página \d+)', cuerpo) if p.strip()]
    num = f'C/{celex[1:5]}/{int(celex[-5:])}'
    for p in partes:
        cab = p.split('«')[0]
        dentro = p[len(cab):]
        cods = []
        q = dentro.lstrip('«— ')
        m = re.match(COD, q)
        if m:
            # Nota nueva o sustituida: el código con que empieza el texto entrecomillado
            r = re.match(rf'({COD})\D{{0,200}}?\sa\s({COD})', q[:260].replace('\n', ' '))
            cods = [['R', r.group(1).replace(' ', ''), r.group(2).replace(' ', '')]] if r else [m.group(0).replace(' ', '')]
        else:
            # Añadido a una nota existente: el código de «en la nota explicativa de la (sub)partida X»
            for a, b in re.findall(rf'({COD})\s+a\s+({COD})', cab):
                cods.append(['R', a.replace(' ', ''), b.replace(' ', '')])
            if not cods:
                cods = [c.replace(' ', '') for c in re.findall(rf'(?:subpartidas?|partida)(?: NC)?\s+«?({COD})', cab)][:1]
        if not cods: continue
        caps = {(c[1] if isinstance(c, list) else c)[:2] for c in cods}
        for cap in caps:
            nuevas.append({'cap': cap, 'c': [c for c in cods if (c[1] if isinstance(c, list) else c)[:2] == cap],
                           'cel': ', '.join((f'{c[1]} a {c[2]}' if isinstance(c, list) else c) for c in cods),
                           'tit': f'Modificación {num} de {fecha}', 't': p + ('\n(Incluye figuras: véase el texto en el DO.)' if figuras else ''),
                           'obs': [], 'mod': {'num': num, 'fecha': fecha, 'url': f'https://eur-lex.europa.eu/legal-content/ES/TXT/?uri=CELEX:{celex}'}})
vistos = set(); unicas = []
for n in nuevas:
    k = (n['cel'], n['t'][:300])
    if k not in vistos: vistos.add(k); unicas.append(n)
nuevas = unicas
d['notas'].extend(nuevas)
d['modificaciones'] = [{'num': f'C/{a.split(":")[0][1:5]}/{int(a.split(":")[0][-5:])}', 'fecha': a.split(':')[1]} for a in mods]
json.dump(d, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
for n in nuevas: print(n['tit'], '·', n['cel'], '·', n['t'][:110].replace('\n', ' '))
print('tamaño', len(open(out, encoding='utf-8').read()))
