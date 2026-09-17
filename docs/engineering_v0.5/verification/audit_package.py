from pathlib import Path
import re,json,xml.etree.ElementTree as E
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'verification/package-audit.json').write_text('{"status":"RUNNING"}\n')
errors=[];checked=0
for p in ROOT.rglob('*.md'):
 if p==ROOT/'sources/CORE_GAMEPLAY.md':continue # verbatim external source, not authored package navigation
 text=re.sub(r'```.*?```','',p.read_text(),flags=re.S)
 for dest in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',text):
  if dest.startswith(('https:','http:','mailto:','#')):continue
  dest=dest.split('#')[0].strip('<>');checked+=1
  if not (p.parent/dest).exists():errors.append(f'{p.relative_to(ROOT)} -> {dest}')
master=E.parse(ROOT/'diagrams/LAST_MILE_Architecture.drawio').getroot();pages=master.findall('diagram')
if len(pages)!=8:errors.append('Master diagram must contain eight pages')
for page in pages:
 ids={x.attrib['id'] for x in page.findall('.//mxCell')}
 for cell in page.findall('.//mxCell'):
  for key in ['parent','source','target']:
   if key in cell.attrib and cell.attrib[key] not in ids:errors.append(f'Diagram missing {key}: {cell.attrib}')
 name=page.attrib['name']
 for sub,ext in [('previews','png'),('svg','svg')]:
  if not (ROOT/'diagrams'/sub/(name+'.'+ext)).exists():errors.append(f'Missing exported {name}.{ext}')
for p in ROOT.rglob('*.json'):
 try:json.loads(p.read_text())
 except Exception as e:errors.append(f'Invalid JSON {p}: {e}')
report={'status':'PASS' if not errors else 'FAIL','localMarkdownLinksChecked':checked,'editableDrawioPages':len(pages),'exportedDiagramPairs':8,'errors':errors,'scope':'Package link/XML/JSON/export-presence validation; readability inspected separately'}
(ROOT/'verification/package-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False));raise SystemExit(bool(errors))
