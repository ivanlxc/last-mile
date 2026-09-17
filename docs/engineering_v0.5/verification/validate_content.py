"""Runnable authored-data validation/reference plan interpreter; NOT the game runtime."""
import json, itertools, math, copy
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]; C=ROOT/'content'; checks=[]
def check(name,truth):
 assert truth,name
 checks.append({'name':name,'result':'PASS'})
def read(n):return json.loads((C/n).read_text())
for basename in ['policy','scenario','public-map','public-actions']:
 instance={'policy':'reference-policy','scenario':'campaign-reference'}.get(basename,basename)
 schema=read(basename+'.schema.json');Draft202012Validator.check_schema(schema)
 Draft202012Validator(schema).validate(read(instance+'.json'));check('schema:'+basename,True)
 bad=read(instance+'.json');bad['unrecognizedSecret']=True
 check('closed-schema:'+basename,not Draft202012Validator(schema).is_valid(bad))
p=read('reference-policy.json');c=read('campaign-reference.json');m=read('public-map.json');a=read('public-actions.json')
nodes={n['nodeId']:n for n in m['nodes']};routes={r['routeId']:r for r in m['routes']}
check('profile-binding',c['policyProfileId']==p['profileId']=='SINGLE_PLAYER_REFERENCE')
check('confirmed-session-resources',p['channelLimits']==dict(satellite=2,drone=3,localAgency=3,witness=2) and p['channelScope']=='session')
check('immutable-new-quota',p['correctionConsumesNewQuota'] and p['uploadPolicy']=='cumulative_immutable')
check('review-not-approved',p['status']=='review' and not p['normalLaunchAllowed'])
check('global-map-identity',c['mapId']==m['mapId'])
for r in routes.values():
 check('route-endpoints:'+r['routeId'],r['fromNode'] in nodes and r['toNode'] in nodes)
 for key,n in [('fromNode',0),('toNode',-1)]:
  check('route-geometry:'+r['routeId']+key,math.dist(r['waypoints'][n],nodes[r[key]]['position'])<0.000001)
check('p0-disabled-routes',not routes['R11']['enabled'] and not routes['R12']['enabled'])
# Point is canonical (route,fraction) for partial geometry; endpoints canonicalize to node.
def point(route,f):return routes[route]['fromNode'] if f==0 else routes[route]['toNode'] if f==1 else (route,f)
def execute(plan,start,flags):
 pos=start;t=0;out=dict(flags)
 for step in plan['steps']:
  if step['kind']=='route':
   r=routes[step['routeId']];assert r['enabled'];assert pos==point(step['routeId'],step['fromFraction']),(plan['actionId'],pos,step)
   assert step['fromFraction']!=step['toFraction'];assert step['toFraction']>step['fromFraction'] or r['bidirectional']
   t+=round(r['durationMs']*abs(step['toFraction']-step['fromFraction']));pos=point(step['routeId'],step['toFraction'])
  else:
   assert pos==step['nodeId'];assert step['durationMs']>0
   if step['kind']=='hold' or out[step['flag']]:
    t+=step['durationMs']
    if step['kind']=='conditionalHold':out[step['flag']]=False
 assert pos==plan['endNodeId']
 for f in plan['effects']:out[f['flag']]=f['value']
 return pos,t,out
public_ids={x['actionId'] for x in a['actions']}
for case in c['cases']:
 cid=case['privateCaseId'];ev=case['evidenceDefinitions'];plans={x['actionId']:x for x in case['actionPlans']}
 check('private-plan-action-binding:'+cid,set(plans)==public_ids)
 check('unique-definitions:'+cid,len({e['definitionId'] for e in ev})==len(ev))
 for sid in ['E1','E2','E3']:
  check('nine-author-observations:'+cid+sid,len([e for e in ev if e['sceneId']==sid])==9)
 for e in ev:
  check('channel-role:'+cid+e['definitionId'],e['channel'] not in ['satellite','drone'] or e['sourceRole']=='analyst')
  if e['traceResult']:
   check('trace-channel:'+cid+e['definitionId'],e['sourceRole']=='liaison' and e['traceCostChannel'] in ['localAgency','witness'])
   check('trace-refs:'+cid+e['definitionId'],set(e['traceResult']['relatedDefinitionIds'])<={x['definitionId'] for x in ev if x['sceneId']==e['sceneId']})
  if e['channel']=='satellite':check('satellite-age-not-wait:'+cid+e['definitionId'],e['observationAgeMs']==600000 and p['investigationDurationMs']['satellite']==10000)
 for id,plan in plans.items():
  sc=next(x for x in c['scenes'] if id in x['actionIds']);pos,t,flags=execute(plan,sc['nodeId'],dict(c['initialFlags']))
  check('connected-plan:'+cid+id,t>0)
  if plan['nextSceneId'] and plan['nextSceneId']!=sc['sceneId']:check('next-scene-node:'+cid+id,pos==next(x['nodeId'] for x in c['scenes'] if x['sceneId']==plan['nextSceneId']))
 for x,y,z in itertools.product(['E1_MAIN','E1_BYPASS'],['E2_MAIN','E2_BYPASS'],['E3_BRIDGE','E3_FORD']):
  pos='N01';flags=dict(c['initialFlags']);total=30000
  for actionid in [x,y,z]:pos,dt,flags=execute(plans[actionid],pos,flags);total+=dt
  if pos=='N05':pos,dt,flags=execute(plans['E3_FORD'],pos,flags);total+=dt
  check('complete-route:'+cid+':'+x+y+z,pos=='N07')
  if z=='E3_FORD' or cid=='B':check('completed-yard-clears-flags:'+cid+x+y+z,not flags['manifestPending'] and not flags['inspectionPending'])
 # Reference path requires no omniscient timing measurement claim.
 path=['E1_MAIN','E2_BYPASS','E3_BRIDGE'] if cid=='A' else ['E1_BYPASS','E2_MAIN','E3_FORD']
 pos='N01';flags=dict(c['initialFlags']);total=30000
 for id in path:pos,dt,flags=execute(plans[id],pos,flags);total+=dt
 check('reference-duration:'+cid,total==({'A':345000,'B':455000}[cid]))
# Public option attributes never encode selected case.
fields=['definitionId','sceneId','sourceRole','channel','acquisition','topicId','priority','title','sourceLabel','traceCostChannel']
projection=lambda case:[{k:e[k] for k in fields} for e in case['evidenceDefinitions']]
check('same-public-targets-across-cases',projection(c['cases'][0])==projection(c['cases'][1]))
for filename in ['public-map.json','public-actions.json']:
 txt=(C/filename).read_text();check('no-private-keys:'+filename,not any('"'+k+'"' in txt for k in ['privateCaseId','truth','hiddenRootId','traceResult','actionPlans']))
# Mutation proves path checker catches an authored teleport.
bad=copy.deepcopy(c['cases'][0]['actionPlans'][0]);bad['steps'][-1]['routeId']='R06'
try:execute(bad,'N01',c['initialFlags']);raised=False
except AssertionError:raised=True
check('reject-teleport-mutant',raised)
bad=copy.deepcopy(p);bad['channelScope']='scene'
check('reject-resource-reset-mutant',not Draft202012Validator(read('policy.schema.json')).is_valid(bad))
out={'scope':'authored-content schema and reference-plan checks; not game implementation/playtest','passed':len(checks),'failed':0,'checks':checks}
(ROOT/'verification/content-results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(f'PASS: {len(checks)} authored-content checks')
