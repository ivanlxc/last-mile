"""Fetch the small, pinned Poly Haven CC0 material set used by the market sample.
No credentials; not run by the game or normal CI/build. Existing files are checked.
"""
from pathlib import Path
import hashlib, json, urllib.request
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/authoring/market-sample-v1'
HEADERS = {'User-Agent': 'LASTMILE-AssetBuild/0.1 (Poly Haven textures for market sample)'}
SETS = [('beige_wall_001','2k','Diffuse'),('cobblestone_floor_08','2k','Diffuse'),
        ('wood_table_001','1k','Diffuse'),('fabric_pattern_07','1k','col_1')]
manifest_path = OUT / 'texture-sources.json'
prior = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
entries = []
for name, resolution, color in SETS:
    print('Poly Haven CC0:', name, flush=True)
    files = None
    for slot, source in [('baseColor', color), ('normal', 'nor_gl'), ('roughness', 'Rough')]:
        filename = f'{name}_{slot}.jpg'
        target = OUT / 'textures' / filename
        pinned = next((e for e in (prior or {}).get('files', []) if e['file'] == filename), None)
        if pinned:
            info = pinned
        else:
            if files is None:
                with urllib.request.urlopen(urllib.request.Request('https://api.polyhaven.com/files/'+name, headers=HEADERS), timeout=45) as r:
                    files = json.load(r)
            source_file = files[source][resolution]['jpg']
            info = {'file':filename, 'asset':name, 'slot':slot, 'resolution':resolution,
                    'source':'https://polyhaven.com/a/'+name, 'license':'CC0-1.0',
                    'url':source_file['url'], 'md5':source_file['md5']}
        if not target.exists() or hashlib.md5(target.read_bytes()).hexdigest() != info['md5']:
            with urllib.request.urlopen(urllib.request.Request(info['url'], headers=HEADERS), timeout=120) as r:
                data = r.read()
            if hashlib.md5(data).hexdigest() != info['md5']:
                raise ValueError('Source checksum mismatch: '+filename)
            target.write_bytes(data)
        entries.append({**info, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
manifest_path.write_text(json.dumps({'provider':'Poly Haven', 'licenseUrl':'https://polyhaven.com/license',
                                   'retrieved':'2026-09-22', 'files':entries}, indent=2)+'\n')
