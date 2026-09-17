"""Design checks only; no live model calls and no writes to a player's database."""
from pathlib import Path
import os,sys,json,subprocess,shutil,datetime
ROOT=Path(__file__).resolve().parents[1]
os.environ['PYTHONDONTWRITEBYTECODE']='1'
checks=[]
def run(name,args):
 p=subprocess.run(args,cwd=ROOT,text=True,capture_output=True)
 checks.append({'check':name,'status':'PASS' if p.returncode==0 else 'FAIL','exitCode':p.returncode,'stdout':p.stdout[-6000:],'stderr':p.stderr[-3000:]})
 print(name,checks[-1]['status']);return p.returncode
for name,file in [('SQLite constraints and transactions','verification/test_database.py'),('Authored content and route plans','verification/validate_content.py'),('OpenAPI and JSON contracts','verification/validate_api_contracts.py'),('Agent guards and observation rules','agents/validate_agents.py'),('Generated TypeScript freshness','contracts/generate_types.py')]:
 args=[sys.executable,file]+(['--check'] if name.startswith('Generated') else [])
 run(name,args)
node=os.environ.get('LAST_MILE_NODE') or shutil.which('node');tsc=os.environ.get('LAST_MILE_TSC') or shutil.which('tsc')
if node:run('ModelAdapter offline mock',[node,'--experimental-transform-types','agents/test_model_adapter.mjs'])
else:checks.append({'check':'ModelAdapter offline mock','status':'NOT_RUN','reason':'Node executable not configured'})
if tsc:
 cmd=[node,tsc] if tsc.endswith('.js') and node else [tsc]
 run('Strict TypeScript including ModelAdapter',cmd+['--project','contracts/tsconfig.json'])
else:checks.append({'check':'Strict TypeScript including ModelAdapter','status':'NOT_RUN','reason':'tsc not configured'})
result={'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Design contract/reference validation; not implemented game acceptance','liveModelCalls':0,'checks':checks,'failed':sum(x['status']=='FAIL' for x in checks),'notRun':sum(x['status']=='NOT_RUN' for x in checks)}
(ROOT/'verification/aggregate-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
# Preserve accurate typecheck evidence after the offline test's historic NOT_RUN marker.
p=ROOT/'agents/adapter-validation-results.json'
if p.exists() and any(x['check'].startswith('Strict TypeScript') and x['status']=='PASS' for x in checks):
 d=json.loads(p.read_text());d['typescriptStaticTypecheck']='PASS';d['typescriptEvidence']='verification/aggregate-results.json';p.write_text(json.dumps(d,indent=2)+'\n')
sys.exit(1 if result['failed'] else 0)
