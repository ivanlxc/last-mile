#!/usr/bin/env python3
"""Check generated type drift and compile shared ports. This does not run a game."""
from pathlib import Path
import argparse
import json
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--node',default='node',help='Node executable when --tsc-js is supplied')
p.add_argument('--tsc-js',help='Path to TypeScript bin/tsc; otherwise use tsc from PATH')
args=p.parse_args()
subprocess.run([sys.executable,str(ROOT/'contracts/generate_types.py'),'--check'],check=True)
compiler=[args.node,args.tsc_js] if args.tsc_js else ['tsc']
version=subprocess.run(compiler+['--version'],check=True,text=True,capture_output=True).stdout.strip()
subprocess.run(compiler+['--project',str(ROOT/'contracts/tsconfig.json')],check=True)
listed=subprocess.run(compiler+['--project',str(ROOT/'contracts/tsconfig.json'),'--listFilesOnly'],check=True,text=True,capture_output=True).stdout.splitlines()
covered=[str(Path(item).resolve().relative_to(ROOT)) for item in listed if Path(item).resolve().is_relative_to(ROOT)]
assert 'agents/modelAdapter.ts' in covered, 'Canonical model adapter was not included in strict compilation'
report={'scope':'Derived TypeScript consistency and strict noEmit compile; no implementation/runtime test.',
        'compiler':version,'coveredSourceFiles':covered,'checks':[{'name':'schema_derived_types_current','passed':True},{'name':'shared_ports_strict_compile','passed':True},{'name':'canonical_model_adapter_strict_compile','passed':True}]}
(ROOT/'verification/type-contract-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
