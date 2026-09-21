"""Generate editable diagrams.net XML and matching SVG previews; stdlib only."""
from pathlib import Path
from html import escape
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
COLORS = {
    'client': ('#e7f0fb', '#789bc6'), 'core': ('#e1f1e9', '#79a68e'),
    'private': ('#fff0db', '#c7974d'), 'agent': ('#eee8fa', '#a28abe'),
    'store': ('#e9edf2', '#93a0af'), 'future': ('#faf4df', '#baaa6f'),
}
pages = [
    dict(name='M1 - implemented', file='m1-architecture', title='M1 / MARKET FIELD PROTOTYPE',
         subtitle='Implemented on the feature branch | Existing authority and information boundaries are preserved',
         nodes=[
             ('viewport', 45, 155, 340, 130, 'client', 'First-person presentation', ['Three.js / camera / collisions', 'Public geometry + four StationIds', 'No session, evidence or hidden case']),
             ('field', 45, 360, 340, 135, 'client', 'MarketField controller', ['Station dialog / cost confirmation', 'Uses game.command + public state', 'Shortcuts use identical rules']),
             ('panels', 45, 585, 340, 135, 'client', 'Shared game interface', ['ReportCard / visibility receipt / upload', 'AdvisorPanel / DecisionModal', 'EN / ZH + 2D fallback']),
             ('http', 525, 155, 340, 130, 'core', 'Fastify HTTP + session access', ['Identity / owner / origin checks', 'Schema / epoch / state version', 'Existing command endpoints']),
             ('core', 525, 360, 340, 135, 'core', 'Authoritative GameService', ['Idempotent transactions / quotas', 'Tasks / actions / sealed decisions', 'Scene transitions + instant time']),
             ('public', 525, 585, 340, 135, 'core', 'Public projection + events', ['Only acquired reports and public state', 'HTTP response + SSE updates', 'Received is not uploaded']),
             ('world', 525, 790, 340, 120, 'private', 'Private scripted world', ['Case A/B / source roots / outcomes', 'Server only; never sent to renderer']),
             ('manifest', 1005, 155, 340, 130, 'agent', 'Frozen advisor input', ['Uploaded revisions + permitted context', 'Question + unverified player statements', 'Allowlist / schema / input hash']),
             ('advisor', 1005, 360, 340, 135, 'agent', 'AI advisor gateway', ['Existing OpenAI / Anthropic adapters', 'Structured output + citation validation', 'No direct world or action access']),
             ('evaluator', 1005, 585, 340, 135, 'agent', 'Independent final evaluator', ['Sealed behavior facts + coverage', 'Separate input from advisor', 'No personality claims from walking']),
             ('db', 1005, 790, 340, 120, 'store', 'Existing persistent storage', ['PostgreSQL cloud / SQLite local tests', 'Reports, quotas, manifests, jobs, events']),
         ],
         edges=[
             ('viewport', 'field', [(215,285),(215,360)], 'StationId'),
             ('field', 'http', [(385,405),(455,405),(455,220),(525,220)], 'command'),
             ('http', 'core', [(695,285),(695,360)], 'validated request'),
             ('core', 'public', [(695,495),(695,585)], 'committed state'),
             ('public', 'panels', [(525,650),(385,650)], 'projection'),
             ('field', 'panels', [(215,495),(215,585)], 'shared components'),
             ('core', 'manifest', [(865,405),(925,405),(925,220),(1005,220)], 'upload / ask'),
             ('manifest', 'advisor', [(1175,285),(1175,360)], 'frozen input'),
             ('advisor', 'public', [(1005,465),(965,465),(965,620),(865,620)], 'validated result'),
             ('world', 'core', [(525,845),(485,845),(485,465),(525,465)], 'private rules'),
             ('core', 'evaluator', [(865,480),(900,480),(900,680),(1005,680)], 'after seal'),
             ('evaluator', 'db', [(1175,720),(1175,790)], 'assessment'),
             ('core', 'db', [(865,445),(945,445),(945,850),(1005,850)], 'transactions'),
         ],
         note='M1 adds no database migration, no new model prompt and no third Agent. Camera movement is cosmetic, not gameplay authority.'),
    dict(name='Unity - target, not implemented', file='unity-target', title='UNITY / VERTICAL SLICE TARGET',
         subtitle='Planned architecture | New gameplay contracts and a real Editor build are required before implementation is accepted',
         nodes=[
             ('author', 45, 155, 340, 145, 'future', 'Authoring + content validation', ['Blender: human-scale level assets', 'Versioned story and evidence bundles', 'Localization / branch-reachability tests']),
             ('unity', 45, 405, 340, 150, 'future', 'Unity presentation client', ['Character controller / interactions', 'NPCs / cinematics / spatial audio', 'Native UI + input accessibility']),
             ('replay', 45, 675, 340, 150, 'future', 'Consequences + review', ['Play committed presentation events', 'Skip / replay must not repeat actions', 'Show what was known at decision time']),
             ('contract', 525, 405, 340, 150, 'core', 'Engine-independent contract', ['Public scene projection + command intent', 'Content version / session / epoch', 'Server checks observation eligibility']),
             ('kernel', 1005, 405, 340, 150, 'core', 'Versioned rules + narrative kernel', ['Private truth / discovery / budgets', 'Deterministic branching consequences', 'Reuse existing transactional behavior']),
             ('agents', 1005, 155, 340, 145, 'agent', 'Remote agent services', ['Advisor: uploaded evidence only', 'Evaluator: sealed behavior facts only', 'Provider adapters / budgets / fallbacks']),
             ('save', 1005, 675, 340, 150, 'future', 'Save and recovery service', ['Rule + content versions / checkpoint', 'Idempotent restore / pending job policy', 'No repeat charge after recovery']),
             ('offline', 525, 675, 340, 150, 'private', 'Product decision: offline main story', ['Pending user decision', 'If required: locally runnable rule kernel', 'Cloud AI becomes optional assistance']),
         ],
         edges=[
             ('author', 'unity', [(215,300),(215,405)], 'approved public assets'),
             ('author', 'kernel', [(385,230),(930,230),(930,475),(1005,475)], 'private bundles to rules only'),
             ('unity', 'contract', [(385,450),(525,450)], 'player intent'),
             ('contract', 'unity', [(525,515),(385,515)], 'public projection'),
             ('contract', 'kernel', [(865,450),(1005,450)], 'validated command'),
             ('kernel', 'agents', [(1175,405),(1175,300)], 'permitted frozen context'),
             ('kernel', 'save', [(1175,555),(1175,675)], 'checkpoint + journal'),
             ('contract', 'replay', [(525,540),(455,540),(455,750),(385,750)], 'committed event'),
             ('offline', 'contract', [(695,675),(695,555)], 'hosting choice'),
         ],
         note='Current Unity bridge supports map selection and camera input only. This page is a migration target, not a claim of completed Unity gameplay.'),
]

mxfile = ET.Element('mxfile', host='app.diagrams.net', type='device', version='26.0.0')
for page in pages:
    diagram = ET.SubElement(mxfile, 'diagram', name=page['name'], id=page['file'])
    model = ET.SubElement(diagram, 'mxGraphModel', dx='1400', dy='980', grid='1', gridSize='10', page='1', pageWidth='1400', pageHeight='980')
    root = ET.SubElement(model, 'root')
    ET.SubElement(root, 'mxCell', id='0'); ET.SubElement(root, 'mxCell', id='1', parent='0')
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="980" viewBox="0 0 1400 980">',
           '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#556b7d"/></marker></defs>',
           '<rect width="1400" height="980" fill="#f8fafc"/>']
    def text_cell(id, value, x, y, w, h, size=18, color='#172c40'):
        cell = ET.SubElement(root, 'mxCell', id=id, value=value, style=f'text;html=0;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize={size};fontColor={color};', vertex='1', parent='1')
        ET.SubElement(cell, 'mxGeometry', x=str(x), y=str(y), width=str(w), height=str(h), **{'as':'geometry'})
    text_cell('title', page['title'], 45, 30, 1280, 40, 28)
    text_cell('subtitle', page['subtitle'], 45, 77, 1300, 45, 16, '#596c7e')
    svg.append(f'<text x="45" y="62" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#172c40">{escape(page["title"])}</text>')
    svg.append(f'<text x="45" y="102" font-family="Arial,sans-serif" font-size="16" fill="#596c7e">{escape(page["subtitle"])}</text>')
    for id,x,y,w,h,kind,title,lines in page['nodes']:
        fill, stroke = COLORS[kind]
        cell = ET.SubElement(root, 'mxCell', id=id, value='\n'.join([title, '', *lines]), style=f'rounded=1;arcSize=10;html=0;whiteSpace=wrap;align=left;verticalAlign=middle;spacing=18;fontSize=16;fillColor={fill};strokeColor={stroke};fontColor=#172c40;', vertex='1', parent='1')
        ET.SubElement(cell, 'mxGeometry', x=str(x), y=str(y), width=str(w), height=str(h), **{'as':'geometry'})
        svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        svg.append(f'<text x="{x+18}" y="{y+30}" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="#172c40">{escape(title)}</text>')
        for i,line in enumerate(lines):
            svg.append(f'<text x="{x+18}" y="{y+60+i*24}" font-family="Arial,sans-serif" font-size="15" fill="#3e5366">{escape(line)}</text>')
    for i,(source,target,points,label) in enumerate(page['edges']):
        # Fixed waypoints reproduce the preview and keep editable endpoints.
        sn = next(node for node in page['nodes'] if node[0] == source)
        tn = next(node for node in page['nodes'] if node[0] == target)
        ports = f'exitX={(points[0][0]-sn[1])/sn[3]};exitY={(points[0][1]-sn[2])/sn[4]};entryX={(points[-1][0]-tn[1])/tn[3]};entryY={(points[-1][1]-tn[2])/tn[4]};'
        cell = ET.SubElement(root, 'mxCell', id=f'edge-{i}', value=label, source=source, target=target, style='edgeStyle=none;html=0;rounded=0;endArrow=block;endFill=1;strokeColor=#556b7d;fontColor=#43596d;fontSize=12;labelBackgroundColor=#f8fafc;'+ports, edge='1', parent='1')
        geom = ET.SubElement(cell, 'mxGeometry', relative='1', **{'as':'geometry'})
        ET.SubElement(geom, 'mxPoint', x=str(points[0][0]), y=str(points[0][1]), **{'as':'sourcePoint'})
        ET.SubElement(geom, 'mxPoint', x=str(points[-1][0]), y=str(points[-1][1]), **{'as':'targetPoint'})
        if len(points)>2:
            arr = ET.SubElement(geom,'Array',**{'as':'points'})
            for px,py in points[1:-1]: ET.SubElement(arr,'mxPoint',x=str(px),y=str(py))
        line = ' '.join(f'{x},{y}' for x,y in points)
        svg.append(f'<polyline points="{line}" fill="none" stroke="#556b7d" stroke-width="1.6" marker-end="url(#arrow)"/>')
        # Label placed on the first segment; vertical labels offset from the edge.
        (x1,y1),(x2,y2) = points[0:2]
        if x1 == x2: lx,ly,anchor = x1+9,(y1+y2)/2,'start'
        else: lx,ly,anchor=(x1+x2)/2,y1-8,'middle'
        svg.append(f'<text x="{lx}" y="{ly}" text-anchor="{anchor}" font-family="Arial,sans-serif" font-size="11" fill="#43596d" stroke="#f8fafc" stroke-width="4" paint-order="stroke">{escape(label)}</text>')
    text_cell('footer', page['note'], 45, 937, 1300, 32, 13, '#596c7e')
    svg.append(f'<text x="45" y="957" font-family="Arial,sans-serif" font-size="13" fill="#596c7e">{escape(page["note"])}</text></svg>')
    (ROOT / (page['file'] + '.svg')).write_text('\n'.join(svg))
ET.indent(mxfile)
ET.ElementTree(mxfile).write(ROOT / 'market-slice.drawio', encoding='utf-8', xml_declaration=True)
print('Generated two editable pages and matching SVG previews.')
