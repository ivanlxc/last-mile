#!/usr/bin/env python3
"""Offline deterministic contract checks. Requires jsonschema>=4.18; no model calls."""
import copy,json,sys,hashlib
from pathlib import Path
from jsonschema import Draft202012Validator,FormatChecker
from referencing import Registry,Resource
from contract_guards import guard_advice,guard_evaluation,guard_advisor_input,readonly_tool
from offline_fallback import advisor_fallback,evaluator_fallback
from fact_rules_reference import classify_context,aggregate
from orchestration_reference import Job,Budget
from context_reference import assemble_advisor_input,input_hash
P=Path(__file__).resolve().parent
read=lambda p:json.loads((P/p).read_text())
schemas={p.name:json.loads(p.read_text()) for p in [P/'contracts.schema.json',P/'tools.schema.json']}
registry=Registry().with_resources(((P/name).as_uri(),Resource.from_contents(s)) for name,s in schemas.items())
checks=[]
def check(name,fn):
    fn();checks.append({'name':name,'status':'PASS'})
def validate(value,definition,file='contracts.schema.json'):
    Draft202012Validator({'$ref':(P/file).as_uri()+'#/$defs/'+definition},registry=registry,format_checker=FormatChecker()).validate(value)
def expect_error(fn,code):
    try:fn()
    except ValueError as e:
        assert str(e)==code,(code,str(e));return
    raise AssertionError('expected '+code)
for name,s in schemas.items():check('metaschema_'+name,lambda s=s:Draft202012Validator.check_schema(s))
base={name:read('fixtures/'+name+'.json') for name in ['advisor-input','advisor-output','evaluator-input','evaluator-output']}
defs={'advisor-input':'AdvisorInput','advisor-output':'AdvisorOutput','evaluator-input':'EvaluatorInput','evaluator-output':'EvaluatorOutput'}
for name,value in base.items():check('valid_'+name,lambda value=value,name=name:validate(value,defs[name]))
check('advice_context_guards',lambda:guard_advice(base['advisor-input'],base['advisor-output']))
check('evaluation_context_guards',lambda:guard_evaluation(base['evaluator-input'],base['evaluator-output']))
for case in read('fixtures/negative-cases.json'):
    def run(case=case):
        data=copy.deepcopy(base);v=data[case['target']]
        for key in case['path'][:-1]:v=v[key]
        v[case['path'][-1]]=case['value']
        if case['expect']=='schema':
            errors=list(Draft202012Validator({'$ref':(P/'contracts.schema.json').as_uri()+'#/$defs/'+defs[case['target']]},registry=registry,format_checker=FormatChecker()).iter_errors(data[case['target']]))
            assert errors;return
        for key,value in data.items():validate(value,defs[key])
        guard=guard_advice if case['target'].startswith('advisor') else guard_evaluation
        prefix='advisor' if guard is guard_advice else 'evaluator'
        expect_error(lambda:guard(data[prefix+'-input'],data[prefix+'-output']),case['expect'])
    check('reject_'+case['name'],run)
for role,fn in [('advisor',advisor_fallback),('evaluator',evaluator_fallback)]:
    check(role+'_fallback_schema',lambda role=role,fn=fn:validate(fn(base[role+'-input']),defs[role+'-output']))
featurecases=read('fixtures/fact-rule-cases.json')
for case in featurecases['cases']:
    def run(case=case):
        f=copy.deepcopy(featurecases['baseFeature']);f.update(case['patch']);got=classify_context(f)
        assert got[case['expectDimension']]['support']==case['expectSupport'],got
    check('fact_'+case['name'],run)
def same_scene():
    a=copy.deepcopy(featurecases['baseFeature']);b=copy.deepcopy(a);b['contextId']=base['evaluator-input']['contexts'][0]['contextId']
    out=aggregate([a,b]);assert out['complacency']['supportLevel']=='observed_once'
check('same_scene_clicks_not_repetition',same_scene)
def assemble():
    a=base['advisor-input'];value=assemble_advisor_input(session_id=a['sessionId'],scene_id=a['sceneId'],context_version=a['contextVersion'],public_task=a['publicTask'],backgrounds=a['backgrounds'],evidence=a['evidence'],statements=a['statements'],question=a['question'])
    validate(value,'AdvisorInput');assert input_hash(value)==value['inputHash']
    value['evidence'][0]['text']='changed'
    assert value['inputHash']!=input_hash(value);assert a['evidence'][0]['text']!='changed'
check('context_hash_and_immutable_copy',assemble)
def adversarial_data():
    i=read('fixtures/adversarial-input.json');validate(i,'AdvisorInput');guard_advisor_input(i)
    assert i['statements'][0]['verification']=='unverified'
    # Only data labeling is tested: there is no claim that a real LLM resisted it.
    validate(advisor_fallback(i),'AdvisorOutput')
check('malicious_statement_stays_unverified_data',adversarial_data)
def provenance():
    i=copy.deepcopy(base['advisor-input']);ref={'instanceId':i['evidence'][0]['instanceId'],'revision':1}
    i['evidence'][0]['knownSourceEdges']=[{'fromRef':ref,'toRef':ref,'relation':'same_source_confirmed','findingRef':None}]
    expect_error(lambda:guard_advisor_input(i),'PROVENANCE_WITHOUT_FINDING')
    i['evidence'][0]['knownSourceEdges'][0]['findingRef']=ref
    expect_error(lambda:guard_advisor_input(i),'REFERENCE_IS_NOT_PROVENANCE_FINDING')
check('provenance_requires_uploaded_finding_type',provenance)
def catalog_integrity():
    content=json.loads((P.parent/'content/campaign-reference.json').read_text())
    visible={(d['definitionId'],hashlib.sha256(d['body'].encode()).hexdigest()) for case in content['cases'] for d in case['evidenceDefinitions']}
    for record in read('public-fact-catalog.json')['records']:
        assert (record['definitionId'],record['bodySha256']) in visible
        assert not {'privateCaseId','hiddenRootId','truth'}&set(record)
check('fact_catalog_matches_visible_content',catalog_integrity)
def tool_tests():
    i=base['advisor-input'];args={'evidenceRef':{'instanceId':i['evidence'][0]['instanceId'],'revision':1}}
    for name,args in [('readUploadedEvidence',args),('readBackgroundRecord',{'backgroundId':'BG01','revision':1}),('listPublicActions',{}),('listChannelCapabilities',{})]:
        validate(args,name+'Input','tools.schema.json');validate(readonly_tool(name,args,i),name+'Output','tools.schema.json')
    bad={'evidenceRef':{'instanceId':'00000000-0000-0000-0000-000000000999','revision':1}}
    assert readonly_tool('readUploadedEvidence',bad,i)['code']=='REFERENCE_NOT_AUTHORIZED'
    assert readonly_tool('listPublicActions',{},i,stale=True)['code']=='STALE_JOB'
    assert readonly_tool('listPublicActions',{},i,remaining_steps=0)['code']=='TOOL_BUDGET_EXHAUSTED'
check('readonly_tools_permission_and_contract',tool_tests)
def budgets():
    budget=Budget();j=Job('evaluator');j.send(budget);j.complete(False);j.recover();j.send(budget);j.complete(False)
    expect_error(j.recover,'ATTEMPTS_EXHAUSTED');assert budget.advisor_sent==0
    j=Job('advisor');j.send(budget);j.complete(True);expect_error(j.recover,'SUCCESS_NOT_RESAMPLED')
    j=Job('advisor');j.send(budget);j.supersede();expect_error(j.recover,'SUCCESS_NOT_RESAMPLED')
    j=Job('advisor');budget.advisor_sent=30;expect_error(lambda:j.send(budget),'SESSION_CALL_LIMIT')
check('job_retry_success_stale_and_session_budgets',budgets)
def public_job():
    job={'jobId':'00000000-0000-0000-0000-000000000099','agentRole':'advisor','status':'succeeded','mode':'live_model','inputVersion':1,'createdAt':'2026-09-16T12:00:00Z','attemptCount':1,'result':base['advisor-output'],'error':None}
    validate(job,'AgentJobView');job['result']=None
    v=Draft202012Validator({'$ref':(P/'contracts.schema.json').as_uri()+'#/$defs/AgentJobView'},registry=registry,format_checker=FormatChecker())
    assert list(v.iter_errors(job))
check('success_requires_role_specific_result',public_job)
report={'suite':'agent-contract-and-rule-reference','checks':checks,'passed':len(checks),'failed':0,'liveModelCalls':0,'notTested':['Natural-language factual accuracy, prompt-injection robustness and psychological validity require separate empirical evaluation.','No running API/worker/game or provider integration is implemented by these reference checks.']}
(P/'validation-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':len(checks),'failed':0,'liveModelCalls':0}))
